export type StreamingMessageVariant = "default" | "thinking";

export function getStreamingDelta(previousDisplay: string, nextDisplay: string): string {
    if (nextDisplay.startsWith(previousDisplay)) return nextDisplay.slice(previousDisplay.length);
    const commonPrefix = getCommonPrefixLength(previousDisplay, nextDisplay);
    if (commonPrefix >= 32) return nextDisplay.slice(commonPrefix);
    return nextDisplay;
}

export function getStreamingDisplayText(rawText: string, variant: StreamingMessageVariant): string {
    if (variant !== "default") return rawText;
    if (rawText.endsWith("\n")) return rawText;
    const lastNewline = rawText.lastIndexOf("\n");
    if (lastNewline < 0) return rawText;
    const trailingLine = rawText.slice(lastNewline + 1);
    if (!isUnstableTrailingMarkdownLine(trailingLine)) return rawText;
    return rawText.slice(0, lastNewline + 1);
}

export function mergeStreamingText(previous: string, incoming: string): string {
    if (!incoming) return previous;
    if (!previous) return incoming;

    // Providers normally send deltas, but some events can resend a full
    // snapshot. Be deliberately conservative: short/common chunks such as
    // spaces, punctuation, "is", or "the" may already appear somewhere in
    // previous output and must still be appended. Dropping them produces the
    // mashed-word output seen in long streams.
    if (incoming === previous) return previous;
    if (incoming.startsWith(previous)) return incoming;
    if (incoming.length > previous.length && incoming.includes(previous)) return incoming;

    // Some providers/proxies occasionally send cumulative snapshots through
    // a field named "delta". If appended literally, the terminal shows the
    // exact repeated growing-prefix pattern reported in real use. Treat a
    // large incoming chunk that restarts with the same opening text as a
    // replacement snapshot, even if the previous buffer was already poisoned
    // by an earlier snapshot append and is no longer a strict prefix.
    if (previous.length >= 80 && incoming.length >= 80) {
        const commonPrefix = getCommonPrefixLength(previous, incoming);
        const snapshotThreshold = Math.min(160, Math.floor(incoming.length * 0.6));
        if (commonPrefix >= Math.max(48, snapshotThreshold) || (incoming.length >= 160 && commonPrefix >= 32)) return incoming;
    }

    // Only de-duplicate substantial suffix/prefix overlaps. Tiny overlaps
    // are usually legitimate repeated characters/tokens in streamed deltas.
    const maxOverlap = Math.min(previous.length, incoming.length);
    for (let overlap = maxOverlap; overlap >= 12; overlap -= 1) {
        if (previous.slice(-overlap) === incoming.slice(0, overlap)) return `${previous}${incoming.slice(overlap)}`;
    }

    return `${previous}${incoming}`;
}

function isUnstableTrailingMarkdownLine(line: string): boolean {
    return /^\s*\d{1,4}\.?\s*$/.test(line)
        || /^\s*\d{1,4}\.\s+/.test(line)
        || /^\s*[-*+]\s*$/.test(line)
        || /^\s*[-*+]\s+/.test(line)
        || /^\s*#{1,6}\s*$/.test(line)
        || /^\s*#{1,6}\s+/.test(line)
        || /^\s*>\s*$/.test(line)
        || /^\s*>\s+/.test(line)
        || /^\s*`{1,3}[A-Za-z0-9_+#.-]*\s*$/.test(line);
}

function getCommonPrefixLength(left: string, right: string): number {
    const max = Math.min(left.length, right.length);
    let index = 0;
    while (index < max && left.charCodeAt(index) === right.charCodeAt(index)) index += 1;
    return index;
}
