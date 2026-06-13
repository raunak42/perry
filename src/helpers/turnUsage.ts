import type { ResponseUsage } from "openai/resources/responses/responses";

export type TurnUsageSnapshot = {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    totalTokens: number;
};

export function createEmptyTurnUsageSnapshot(): TurnUsageSnapshot {
    return {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
    };
}

export function addResponseUsage(target: TurnUsageSnapshot, usage?: ResponseUsage | null): void {
    if (!usage) {
        return;
    }

    target.inputTokens += usage.input_tokens;
    target.cachedInputTokens += usage.input_tokens_details?.cached_tokens ?? 0;
    target.outputTokens += usage.output_tokens;
    target.reasoningTokens += usage.output_tokens_details?.reasoning_tokens ?? 0;
    target.totalTokens += usage.total_tokens;
}

export function snapshotTurnUsage(usage: TurnUsageSnapshot): TurnUsageSnapshot | null {
    return usage.totalTokens > 0 ? { ...usage } : null;
}
