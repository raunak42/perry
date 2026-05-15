import type { ResponseOutputItem, ResponseReasoningItem } from "openai/resources/responses/responses";

function collectReasoningText(item: ResponseReasoningItem): string {
    const summary = item.summary
        .filter((part) => part.type === "summary_text" && part.text.trim().length > 0)
        .map((part) => part.text.trim())
        .join("\n\n");

    if (summary) {
        return summary;
    }

    const content = (item.content ?? [])
        .filter((part) => part.type === "reasoning_text" && part.text.trim().length > 0)
        .map((part) => part.text.trim())
        .join("\n\n");

    if (content) {
        return content;
    }

    // `encrypted_content` is opaque state for provider-side reasoning continuity,
    // not user-visible thinking text. Rendering it as a "thinking trace" creates a
    // misleading placeholder when the provider chose not to expose a summary.
    return "";
}

export function extractThinkingTraces(items: ResponseOutputItem[]): string[] {
    return items
        .filter((item): item is ResponseReasoningItem => item.type === "reasoning")
        .map(collectReasoningText)
        .filter((trace) => trace.length > 0);
}

export function formatThinkingTrace(trace: string): string {
    return trace.trim();
}
