#!/usr/bin/env node
import { Command } from "commander";
import { stdin as input, stdout as output } from "node:process";
import readline from "node:readline/promises";
import OpenAI from "openai";
import { systemPrompt } from "./constants";
import { getCurrentSessionStatus } from "./helpers/getCurrentSessionStatus";
import { handleSlashCommands } from "./helpers/handleSlashCommands";
import { runCommandTool } from "./tools/runCommand";
import { getCodexResponse, ParsedCodexResponse } from "./helpers/getCodexResponse";
import type { Response } from "openai/resources/responses/responses";


type ChatMessage = {
    role: "user" | "assistant" | "developer";
    content: string;
};

const program = new Command();

program
    .name("perry")
    .description("A CLI coding agent")
    .version("1.0.0")
    .action(async () => {
        console.log("Perry started. Type /quit to exit.");
        await main();
    });

program.parse();

export interface State {
    activeProvider: "openai-api-key" | "openai-codex" | null,
    client: OpenAI | null,
}

async function main() {
    const history: ChatMessage[] = [];
    const systemContext: ChatMessage = {
        role: "developer",
        content: systemPrompt,
    };
    const rl = readline.createInterface({ input, output });
    const localTools = [runCommandTool];
    const openaiTools: any[] = [
        ...localTools.map((tool) => tool.definition),
        { type: "web_search" },
    ];


    let state: State = {
        activeProvider: null,
        client: null
    }
    await getCurrentSessionStatus(state)

    try {
        while (true) {
            const answer = await rl.question("> ");
            const trimmed = answer.trim();

            if (trimmed.startsWith("/")) {
                const shouldContinue = await handleSlashCommands({ command: trimmed, state, rl });
                if (shouldContinue === false) {
                    break;
                }

                continue;
            }

            if (!state.activeProvider) {
                console.log("not logged in. Type /login to continue.");
                continue;
            }

            if (state.activeProvider === "openai-api-key" && !state.client) {
                console.log("OpenAI API key client is not available. Run /login again.");
                continue;
            }

            history.push({
                role: "user",
                content: answer,
            });

            let agentInput: any[] = [
                systemContext,
                ...history,
            ];

            while (true) {
                let aiResponse: Response | ParsedCodexResponse;
                if (state.activeProvider === "openai-api-key") {
                    if (!state.client) {
                        throw new Error("OpenAI API key client missing.");
                    }

                    aiResponse = await (state.client as OpenAI).responses.create({
                        model: "gpt-5.4-mini",
                        input: agentInput,
                        tools: openaiTools,
                    });
                } else if (state.activeProvider === "openai-codex") {
                    aiResponse = await getCodexResponse({
                        input: history,
                        tools: openaiTools,
                        instructions: systemPrompt
                    });
                } else {
                    throw new Error("No active provider.");
                }

                const responseText = aiResponse.output_text;

                const toolCall = aiResponse.output.find(
                    (item) => item.type === "function_call"
                );

                if (toolCall && toolCall.type === "function_call") {
                    const args = JSON.parse(toolCall.arguments);

                    const tool = localTools.find((tool) => tool.name === toolCall.name);

                    if (!tool) {
                        throw new Error(`Unknown local tool: ${toolCall.name}`);
                    }

                    const toolResult = await tool.execute(args);

                    agentInput = [
                        ...agentInput,
                        toolCall,
                        {
                            type: "function_call_output",
                            call_id: toolCall.call_id,
                            output: toolResult,
                        },
                    ];

                    continue;
                }

                console.log(responseText);

                history.push({
                    role: "assistant",
                    content: responseText,
                });

                break;
            }
        }
    } catch (err) {
        if ((err as Error).name === "AbortError") {
            console.log("\nGoodbye.");
        } else {
            throw err;
        }
    } finally {
        rl.close();
    }
}