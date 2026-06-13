import OpenAI from "openai";
import type { Response } from "openai/resources/responses/responses";
import {
    getContextConfig,
    getReasoningConfig,
    type ContextLevel,
    type ReasoningLevel,
} from "./models";
import { createFunctionCallTraceManager } from "./functionCallTraceManager";
import { createProviderNativeTraceManager } from "./providerNativeTraceManager";
import { createAssistantTextStreamer, createThinkingTraceStreamer } from "./streamingText";
import { extractRateLimitSnapshot, type RateLimitSnapshot } from "./runtimeFormatting";
import { shouldRetainAssistantOutput } from "./assistantOutput";
import type { InteractiveUi } from "../ui/types";

function yieldToEventLoop(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

export async function getApiKeyResponse(
    client: OpenAI,
    agentInput: any[],
    tools: any[],
    model: string,
    reasoningLevel: ReasoningLevel,
    contextLevel: ContextLevel,
    ui: InteractiveUi,
    options: { streamOutput?: boolean; signal?: AbortSignal } = {},
): Promise<{ response: Response; streamedThinking: boolean; streamedOutputText: boolean; rateLimit: RateLimitSnapshot | null }> {
    const thinking = options.streamOutput === false ? null : createThinkingTraceStreamer(ui);
    const outputText = options.streamOutput === false ? null : createAssistantTextStreamer(ui);
    const functionCallTraces = createFunctionCallTraceManager(ui);
    const providerTraces = createProviderNativeTraceManager(ui);
    const contextConfig = getContextConfig(model, contextLevel, "openai-api-key");
    const { data: stream, response: rawResponse } = await client.responses.create({
        model,
        input: agentInput,
        tools,
        reasoning: getReasoningConfig(reasoningLevel),
        truncation: contextConfig.truncation,
        context_management: contextConfig.context_management,
        include: [
            "web_search_call.action.sources",
            "file_search_call.results",
            "code_interpreter_call.outputs",
        ],
        store: false,
        stream: true,
    }, { signal: options.signal }).withResponse();

    let finalResponse: Response | null = null;
    let retainAssistantStream = true;
    const rateLimit = extractRateLimitSnapshot(rawResponse.headers);

    try {
        for await (const event of stream) {
            providerTraces.onResponseEvent(event);

            if (event.type === "response.output_item.added") {
                functionCallTraces.onOutputItemAdded(event.item);
                providerTraces.onOutputItemAdded(event.item);
            }

            if (event.type === "response.output_item.done") {
                providerTraces.onOutputItemDone(event.item);
            }

            functionCallTraces.onResponseEvent(event);

            if (event.type === "response.output_item.added" && event.item.type === "reasoning") {
                thinking?.onStart(event.item.id);
            }

            if (
                (event.type === "response.reasoning_summary_text.delta" || event.type === "response.reasoning_text.delta") &&
                "delta" in event &&
                typeof event.delta === "string"
            ) {
                thinking?.onDelta(event.item_id, event.delta);
                if (thinking) await yieldToEventLoop();
            }

            if (event.type === "response.reasoning_summary_text.done" || event.type === "response.reasoning_text.done") {
                thinking?.onDone(event.item_id);
            }

            if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
                outputText?.onDelta(event.item_id, event.delta);
                if (outputText) await yieldToEventLoop();
            }

            if (event.type === "response.output_text.done") {
                outputText?.onDone(event.item_id);
            }

            if (event.type === "response.completed") {
                finalResponse = event.response as Response;
            }
        }

        if (!finalResponse) {
            throw new Error("No final response received from OpenAI stream.");
        }

        retainAssistantStream = shouldRetainAssistantOutput(finalResponse.output);

        return {
            response: finalResponse,
            streamedThinking: thinking?.hasStreamedThinking ?? false,
            streamedOutputText: outputText?.hasStreamedText ?? false,
            rateLimit,
        };
    } finally {
        thinking?.finishAll();
        outputText?.finishAll(retainAssistantStream);
    }
}
