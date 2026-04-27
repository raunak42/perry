#!/usr/bin/env node

import { Command } from "commander";
import dotenv from "dotenv";
import { stdin as input, stdout as output } from "node:process";
import readline from "node:readline/promises";
import OpenAI from "openai";
import { runCommandTool } from "./tools/runCommand";

dotenv.config();

type ChatMessage = {
    role: "user" | "assistant" | "developer";
    content: string;
};

const systemPrompt = `You are Perry, a CLI-based coding agent.

You can interact with the user's machine by running shell commands using the run_command tool.

Prefer using the shell over guessing.

You are not limited to the current project — you can explore the full filesystem if needed.

Use standard Unix tools to inspect, search, and operate on files.

Think step-by-step and use multiple commands when needed.
Be concise.

When using web search:

- Only state facts that are clearly supported by the results
- Do not invent or assume details
- If details are unclear or conflicting, say so explicitly
- Prefer quoting or closely paraphrasing reliable sources
- Always mention the source (e.g., Reuters, AP, BBC)
- If you are unsure, say "I’m not fully certain based on available information"

Do not present speculation as fact.

Before answering questions involving external information:

- First identify what facts are known from sources
- Then form the answer strictly from those facts
It is better to be slightly uncertain than confidently wrong.
If web_search is used → require citations`.trim();

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

async function main() {
    const history: ChatMessage[] = [];
    const systemContext: ChatMessage = { role: "developer", content: systemPrompt }

    const rl = readline.createInterface({ input, output });
    const client = new OpenAI();

    const tools = [runCommandTool, { name: "web_search", definition: { type: "web_search" } }];

    try {
        while (true) {
            const answer = await rl.question("> ");
            if (answer.trim() === "/quit") {
                rl.close();
                break;
            }
            history.push({ role: "user", content: answer });

            let agentInput: any[] = [
                systemContext,
                ...history,
            ];

            while (true) {

                const aiResponse = await client.responses.create({
                    model: "gpt-5.4-mini",
                    input: agentInput,
                    tools: tools.map((t) => t.definition),
                });
                console.log(aiResponse.output_text)


                const responseText = aiResponse.output_text;
                const toolCall = aiResponse.output.find(o => o.type === "function_call");

                if (toolCall && toolCall.type === "function_call") {
                    const args = JSON.parse(toolCall.arguments);
                    console.log(args)

                    let toolResult = "";
                    const tool = tools.find(t => t.name === toolCall.name)

                    if (!tool) {
                        throw new Error(`Unknown tool: ${toolCall.name}`);
                    }

                    toolResult = await tool.execute(args)

                    agentInput = [
                        ...agentInput,
                        toolCall,
                        {
                            type: "function_call_output",
                            call_id: toolCall.call_id,
                            output: toolResult,
                        },
                    ]
                    continue;
                } else {
                    history.push({
                        role: "assistant",
                        content: responseText,
                    });
                    // console.log("history: ", history)
                    break
                }
            }

        }
    } catch (err) {
        if ((err as Error).name === "AbortError") {
            console.log("\nGoodbye.");
        } else {
            throw err;
        }
    } finally {
        rl.close()
    }
}