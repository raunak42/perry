import type { ResponseOutputItem, ResponseStreamEvent } from "openai/resources/responses/responses";
import type { InteractiveUi } from "../ui/types";

function isFunctionCallItem(item: ResponseOutputItem): item is Extract<ResponseOutputItem, { type: "function_call" }> {
    return item.type === "function_call";
}

export function createFunctionCallTraceManager(ui: InteractiveUi) {
    const itemIdsToCallIds = new Map<string, string>();
    const itemIdsToNames = new Map<string, string>();
    const argumentBuffers = new Map<string, string>();
    const shownCallIds = new Set<string>();

    const tryParseJson = (text: string): unknown | undefined => {
        try {
            return JSON.parse(text);
        } catch {
            return undefined;
        }
    };

    const isShown = (callId: string): boolean => shownCallIds.has(callId);

    return {
        onOutputItemAdded(item: ResponseOutputItem): void {
            if (!isFunctionCallItem(item)) {
                return;
            }

            if (item.id) {
                itemIdsToCallIds.set(item.id, item.call_id);
                itemIdsToNames.set(item.id, item.name);
            }

            if (item.arguments && item.arguments.length > 0) {
                argumentBuffers.set(item.call_id, item.arguments);
            }
        },
        onResponseEvent(event: ResponseStreamEvent | { type: string; [key: string]: unknown }): void {
            const responseEvent = event as any;

            if (responseEvent.type === "response.function_call_arguments.delta") {
                const callId = itemIdsToCallIds.get(responseEvent.item_id);
                if (!callId) {
                    return;
                }

                const nextArguments = `${argumentBuffers.get(callId) ?? ""}${typeof responseEvent.delta === "string" ? responseEvent.delta : ""}`;
                argumentBuffers.set(callId, nextArguments);
                if (isShown(callId)) {
                    ui.updateToolCallArguments(callId, nextArguments, tryParseJson(nextArguments));
                }
                return;
            }

            if (responseEvent.type === "response.function_call_arguments.done") {
                const callId = itemIdsToCallIds.get(responseEvent.item_id) ?? responseEvent.item_id;
                const finalArguments = typeof responseEvent.arguments === "string" ? responseEvent.arguments : "";
                argumentBuffers.set(callId, finalArguments);
                if (isShown(callId)) {
                    ui.updateToolCallArguments(callId, finalArguments, tryParseJson(finalArguments));
                }
            }
        },
    };
}
