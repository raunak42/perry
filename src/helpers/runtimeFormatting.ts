import { ProviderLimitError, ProviderRequestError } from "./getCodexResponse";
import { formatCompactTokenCount } from "./contextUsage";

export type RateLimitSnapshot = {
    limitRequests?: number | null;
    remainingRequests?: number | null;
    resetRequests?: string | null;
    limitTokens?: number | null;
    remainingTokens?: number | null;
    resetTokens?: string | null;
};

export function parseRateLimitNumber(raw: string | null): number | null {
    if (!raw) {
        return null;
    }

    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
}

export function extractRateLimitSnapshot(headers: Headers): RateLimitSnapshot | null {
    const snapshot: RateLimitSnapshot = {
        limitRequests: parseRateLimitNumber(headers.get("x-ratelimit-limit-requests")),
        remainingRequests: parseRateLimitNumber(headers.get("x-ratelimit-remaining-requests")),
        resetRequests: headers.get("x-ratelimit-reset-requests"),
        limitTokens: parseRateLimitNumber(headers.get("x-ratelimit-limit-tokens")),
        remainingTokens: parseRateLimitNumber(headers.get("x-ratelimit-remaining-tokens")),
        resetTokens: headers.get("x-ratelimit-reset-tokens"),
    };

    return Object.values(snapshot).some((value) => value !== null && value !== undefined)
        ? snapshot
        : null;
}

export function shouldRenderProviderWarning(error: unknown): boolean {
    if (error instanceof ProviderLimitError) return true;
    const message = error instanceof Error ? error.message : String(error);
    return /(?:\b429\b|too many requests|rate.?limit|usage.?limit|quota|limit.*reached)/i.test(message);
}

export function isAbortError(error: unknown): boolean {
    return error instanceof Error && (error.name === "AbortError" || /aborted|cancelled by escape|stopped by escape|process terminated/i.test(error.message));
}

export function createAbortError(message = "Process terminated."): Error {
    const error = new Error(message);
    error.name = "AbortError";
    return error;
}

export function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw createAbortError();
}

export function formatProviderErrorMessage(error: unknown): string {
    if (isAbortError(error)) return "Process terminated.";

    if (error instanceof ProviderLimitError) {
        const details = error.details;
        const resetText = formatLimitReset(details.resetsAt, details.resetsInSeconds);
        return [
            "Provider usage limit reached.",
            details.message,
            details.planType ? `Plan: ${details.planType}` : "",
            resetText ? `Resets: ${resetText}` : "",
            "You can wait for the reset, switch model/provider with /model or /login, or continue editing queued messages while Perry is idle.",
        ].filter(Boolean).join("\n");
    }

    if (error instanceof ProviderRequestError) {
        const body = error.body.trim();
        const shortBody = body.length > 600 ? `${body.slice(0, 600).trimEnd()}…` : body;
        return [`Provider request failed (${error.status}).`, shortBody].filter(Boolean).join("\n");
    }

    const message = error instanceof Error ? error.message : String(error);
    if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|network|fetch failed|503|502|504/i.test(message)) {
        return `Provider/network error.\n${message}\nTry again in a moment, or switch providers/models if it persists.`;
    }

    return message;
}

export function formatLimitReset(resetsAt?: number, resetsInSeconds?: number): string | null {
    if (typeof resetsInSeconds === "number" && Number.isFinite(resetsInSeconds)) {
        return formatDurationSeconds(Math.max(0, resetsInSeconds));
    }
    if (typeof resetsAt === "number" && Number.isFinite(resetsAt)) {
        const milliseconds = resetsAt > 10_000_000_000 ? resetsAt - Date.now() : (resetsAt * 1000) - Date.now();
        return formatDurationSeconds(Math.max(0, Math.ceil(milliseconds / 1000)));
    }
    return null;
}

export function formatDurationSeconds(totalSeconds: number): string {
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m`;
    return `${totalSeconds}s`;
}

export function formatCompactCount(value: number): string {
    return formatCompactTokenCount(value);
}

export function formatPercent(value: number): string {
    return `${(value * 100).toFixed(value >= 0.1 ? 1 : 2)}%`;
}

export function formatDuration(ms: number | null): string {
    if (ms === null) {
        return "—";
    }

    if (ms < 1_000) {
        return `${ms}ms`;
    }

    const seconds = ms / 1_000;
    if (seconds < 60) {
        return `${seconds.toFixed(seconds >= 10 ? 1 : 2)}s`;
    }

    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds.toFixed(remainingSeconds >= 10 ? 0 : 1)}s`;
}
