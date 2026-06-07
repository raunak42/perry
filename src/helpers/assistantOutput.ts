import type { ResponseOutputItem } from "openai/resources/responses/responses";

export function hasFunctionCallItems(items: ResponseOutputItem[]): boolean {
    return items.some((item) => item.type === "function_call");
}

export function shouldRetainAssistantOutput(items: ResponseOutputItem[]): boolean {
    return !hasFunctionCallItems(items);
}

export function shouldPersistAssistantResponseText(responseText: string, items: ResponseOutputItem[]): boolean {
    return responseText.trim().length > 0 && shouldRetainAssistantOutput(items);
}
