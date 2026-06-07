export type ContextUsageSnapshot = {
    usedTokens: number | null;
    approximate: boolean;
};

export function formatCompactTokenCount(value: number): string {
    if (value >= 1_000_000) {
        const millions = value / 1_000_000;
        return `${millions >= 10 ? millions.toFixed(0) : millions.toFixed(1)}M`;
    }

    if (value >= 1_000) {
        const thousands = value / 1_000;
        return `${thousands >= 10 ? thousands.toFixed(0) : thousands.toFixed(1)}k`;
    }

    return String(value);
}

function formatContextPercent(percent: number): string {
    if (percent >= 10) return `${Math.round(percent)}%`;
    if (percent >= 1) return `${percent.toFixed(1)}%`;
    return `${percent.toFixed(2)}%`;
}

export function formatContextUsageLine(
    usage: ContextUsageSnapshot,
    contextWindow?: number,
): string {
    if (usage.usedTokens === null) {
        return "context [—]";
    }

    const approximatePrefix = usage.approximate ? "~" : "";
    const usedLabel = `${approximatePrefix}${formatCompactTokenCount(usage.usedTokens)}`;

    if (!contextWindow) {
        return `context [${usedLabel}]`;
    }

    const percent = Math.max(0, Math.min(999, (usage.usedTokens / contextWindow) * 100));
    return `context [${usedLabel}/${formatCompactTokenCount(contextWindow)} · ${formatContextPercent(percent)}]`;
}
