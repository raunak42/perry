#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import OpenAI from "openai";
import { systemPrompt } from "./constants";
import { getCurrentSessionStatus } from "./helpers/getCurrentSessionStatus";
import {
    getContextConfig,
    getDefaultContextLevel,
    getDefaultModel,
    getDefaultReasoningLevel,
    getModelDisplayMetadata,
    getReasoningConfig,
    type ContextLevel,
    type ReasoningLevel,
} from "./helpers/models";
import { handleSlashCommands } from "./helpers/handleSlashCommands";
import { getCodexResponse, ProviderLimitError, ProviderRequestError, type ParsedCodexResponse } from "./helpers/getCodexResponse";
import {
    formatSessionAge,
    formatSessionPath,
    resolveSessionPath,
    SessionManager,
    type SessionInfo,
    type SessionStateSnapshot,
} from "./helpers/sessionManager";
import { extractThinkingTraces, formatThinkingTrace } from "./helpers/reasoning";
import { setOutputWriter } from "./ui/output";
import { TerminalUi } from "./ui/terminal-ui";
import { runCommandTool } from "./tools/runCommand";
import { readTool } from "./tools/readFile";
import { writeTool } from "./tools/writeFile";
import { editTool } from "./tools/editFile";
import type { Response, ResponseInputItem, ResponseOutputItem, ResponseStreamEvent, ResponseUsage } from "openai/resources/responses/responses";
import type { Tool } from "./tools/types";
import type {
    CodeInterpreterTraceDetails,
    FileSearchTraceDetails,
    KnownToolTraceDetails,
    LocalShellTraceDetails,
    McpTraceDetails,
    ToolSearchTraceDetails,
    WebSearchTraceDetails,
} from "./tools/traceDetails";
import type { InteractiveUi, SessionDetailLine } from "./ui/types";


type ChatMessage = {
    role: "user" | "assistant" | "developer";
    content: string;
};

type CliOptions = {
    continue?: boolean;
    resume?: boolean;
    session?: string | false;
    sessionDir?: string;
};

const program = new Command();

program
    .name("perry")
    .description("A CLI coding agent")
    .version("1.0.0")
    .option("-c, --continue", "Continue the most recent session for this directory")
    .option("-r, --resume", "Choose a previous session to resume")
    .option("--session <session>", "Resume a specific session file or session id prefix")
    .option("--session-dir <dir>", "Directory for session storage and lookup")
    .option("--no-session", "Do not save this conversation")
    .action(async (options: CliOptions) => {
        await main(options);
    });

program.parse();

export interface State {
    activeProvider: "openai-api-key" | "openai-codex" | null,
    client: OpenAI | null,
    currentModel: string,
    reasoningLevel: ReasoningLevel,
    contextLevel: ContextLevel,
}

type TurnUsageSnapshot = {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    totalTokens: number;
};

type RateLimitSnapshot = {
    limitRequests?: number | null;
    remainingRequests?: number | null;
    resetRequests?: string | null;
    limitTokens?: number | null;
    remainingTokens?: number | null;
    resetTokens?: string | null;
};

function createEmptyTurnUsageSnapshot(): TurnUsageSnapshot {
    return {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
    };
}

function addResponseUsage(target: TurnUsageSnapshot, usage?: ResponseUsage | null): void {
    if (!usage) {
        return;
    }

    target.inputTokens += usage.input_tokens;
    target.cachedInputTokens += usage.input_tokens_details?.cached_tokens ?? 0;
    target.outputTokens += usage.output_tokens;
    target.reasoningTokens += usage.output_tokens_details?.reasoning_tokens ?? 0;
    target.totalTokens += usage.total_tokens;
}

function snapshotTurnUsage(usage: TurnUsageSnapshot): TurnUsageSnapshot | null {
    return usage.totalTokens > 0 ? { ...usage } : null;
}

function parseRateLimitNumber(raw: string | null): number | null {
    if (!raw) {
        return null;
    }

    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
}

function extractRateLimitSnapshot(headers: Headers): RateLimitSnapshot | null {
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

function shouldRenderProviderWarning(error: unknown): boolean {
    if (error instanceof ProviderLimitError) return true;
    const message = error instanceof Error ? error.message : String(error);
    return /(?:\b429\b|too many requests|rate.?limit|usage.?limit|quota|limit.*reached)/i.test(message);
}

function formatProviderErrorMessage(error: unknown): string {
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

function formatLimitReset(resetsAt?: number, resetsInSeconds?: number): string | null {
    if (typeof resetsInSeconds === "number" && Number.isFinite(resetsInSeconds)) {
        return formatDurationSeconds(Math.max(0, resetsInSeconds));
    }
    if (typeof resetsAt === "number" && Number.isFinite(resetsAt)) {
        const milliseconds = resetsAt > 10_000_000_000 ? resetsAt - Date.now() : (resetsAt * 1000) - Date.now();
        return formatDurationSeconds(Math.max(0, Math.ceil(milliseconds / 1000)));
    }
    return null;
}

function formatDurationSeconds(totalSeconds: number): string {
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m`;
    return `${totalSeconds}s`;
}

function formatCompactCount(value: number): string {
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

function formatPercent(value: number): string {
    return `${(value * 100).toFixed(value >= 0.1 ? 1 : 2)}%`;
}

function formatDuration(ms: number | null): string {
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

function formatRepoPath(cwd: string): string {
    const homeDir = os.homedir();
    return cwd.startsWith(homeDir)
        ? `~${cwd.slice(homeDir.length)}`
        : cwd;
}

function getGitBranch(cwd: string): string | null {
    try {
        const branch = execFileSync("git", ["branch", "--show-current"], {
            cwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        return branch.length > 0 ? branch : null;
    } catch {
        return null;
    }
}

function estimateTokenCount(payload: unknown): number {
    return Math.max(0, Math.ceil(Buffer.byteLength(JSON.stringify(payload), "utf8") / 4));
}

async function getContextUsageSnapshot(
    state: State,
    history: ChatMessage[],
    systemContext: ChatMessage,
    openaiTools: any[],
): Promise<{ usedTokens: number | null; approximate: boolean }> {
    const contextConfig = getContextConfig(state.currentModel, state.contextLevel);

    if (state.activeProvider === "openai-api-key" && state.client) {
        try {
            const count = await state.client.responses.inputTokens.count({
                model: state.currentModel,
                input: [systemContext, ...history],
                tools: openaiTools,
            });

            return {
                usedTokens: count.input_tokens,
                approximate: false,
            };
        } catch {
            return {
                usedTokens: estimateTokenCount({
                    model: state.currentModel,
                    input: [systemContext, ...history],
                    tools: openaiTools,
                    truncation: contextConfig.truncation,
                    context_management: contextConfig.context_management,
                }),
                approximate: true,
            };
        }
    }

    if (state.activeProvider === "openai-codex") {
        return {
            usedTokens: estimateTokenCount({
                model: state.currentModel,
                instructions: systemPrompt,
                input: history,
                tools: openaiTools,
                truncation: contextConfig.truncation,
                context_management: contextConfig.context_management,
            }),
            approximate: true,
        };
    }

    return {
        usedTokens: null,
        approximate: false,
    };
}

async function buildPromptSessionDetails(
    state: State,
    history: ChatMessage[],
    systemContext: ChatMessage,
    openaiTools: any[],
    lastTurnUsage: TurnUsageSnapshot | null,
    lastTurnElapsedMs: number | null,
    lastRateLimit: RateLimitSnapshot | null,
    sessionManager: SessionManager,
): Promise<SessionDetailLine[]> {
    const cwd = process.cwd();
    const repoPath = formatRepoPath(cwd);
    const branch = getGitBranch(cwd);
    const providerLabel = state.activeProvider === "openai-api-key"
        ? "api key"
        : state.activeProvider === "openai-codex"
            ? "codex"
            : "logged out";

    const modelMeta = getModelDisplayMetadata(state.currentModel);
    const contextUsage = await getContextUsageSnapshot(state, history, systemContext, openaiTools);

    const contextLabel = contextUsage.usedTokens !== null && modelMeta.contextWindow
        ? `context ${contextUsage.approximate ? "~" : ""}${formatCompactCount(contextUsage.usedTokens)}/${formatCompactCount(modelMeta.contextWindow)} (${formatPercent(contextUsage.usedTokens / modelMeta.contextWindow)})`
        : contextUsage.usedTokens !== null
            ? `context ${contextUsage.approximate ? "~" : ""}${formatCompactCount(contextUsage.usedTokens)}`
            : "context unavailable";

    const outputLabel = modelMeta.maxOutputTokens
        ? `max output ${formatCompactCount(modelMeta.maxOutputTokens)}`
        : "max output unknown";

    const usageLabel = lastTurnUsage
        ? `usage: input ${formatCompactCount(lastTurnUsage.inputTokens)} · cached ${formatCompactCount(lastTurnUsage.cachedInputTokens)} · output ${formatCompactCount(lastTurnUsage.outputTokens)} · reasoning ${formatCompactCount(lastTurnUsage.reasoningTokens)} · total ${formatCompactCount(lastTurnUsage.totalTokens)}`
        : "usage: —";

    const elapsedLabel = `last turn: ${formatDuration(lastTurnElapsedMs)}`;

    let limitsLabel = "limits unavailable";
    if (lastRateLimit?.limitRequests || lastRateLimit?.limitTokens) {
        const requestLimit = lastRateLimit.limitRequests && lastRateLimit.remainingRequests !== null && lastRateLimit.remainingRequests !== undefined
            ? `req ${lastRateLimit.remainingRequests}/${lastRateLimit.limitRequests}`
            : undefined;
        const tokenLimit = lastRateLimit.limitTokens && lastRateLimit.remainingTokens !== null && lastRateLimit.remainingTokens !== undefined
            ? `tok ${formatCompactCount(lastRateLimit.remainingTokens)}/${formatCompactCount(lastRateLimit.limitTokens)}`
            : undefined;
        const resets = [lastRateLimit.resetRequests, lastRateLimit.resetTokens].filter(Boolean).join(" / ");
        limitsLabel = [requestLimit, tokenLimit, resets ? `reset ${resets}` : undefined].filter(Boolean).join(" • ");
    } else if (state.activeProvider === "openai-api-key") {
        limitsLabel = "limits: see OpenAI dashboard";
    } else if (state.activeProvider === "openai-codex") {
        limitsLabel = "limits: Codex subscription limits unavailable";
    }

    const sessionLabel = sessionManager.isPersisted()
        ? `session: ${sessionManager.getSessionId().slice(0, 8)}`
        : "session: not saved";

    return [
        {
            left: branch ? `${repoPath} (${branch})` : repoPath,
            right: providerLabel,
        },
        {
            left: sessionLabel,
            right: `${history.filter((message) => message.role !== "developer").length} messages`,
        },
        {
            left: `model: ${state.currentModel}`,
            right: `reasoning: ${state.reasoningLevel} · context mode: ${state.contextLevel}`,
        },
        {
            left: contextLabel,
            right: outputLabel,
        },
        {
            left: usageLabel,
        },
        {
            left: elapsedLabel,
            right: limitsLabel,
        },
    ];
}

function getStateSnapshot(state: State): SessionStateSnapshot {
    return {
        provider: state.activeProvider,
        model: state.currentModel,
        reasoningLevel: state.reasoningLevel,
        contextLevel: state.contextLevel,
    };
}

function applySessionState(sessionManager: SessionManager, state: State, ui: InteractiveUi): void {
    const snapshot = sessionManager.getLatestState();
    if (!snapshot) return;

    if (snapshot.provider === state.activeProvider) {
        state.currentModel = snapshot.model;
        state.reasoningLevel = snapshot.reasoningLevel;
        state.contextLevel = snapshot.contextLevel;
        ui.setReasoningLevel(state.reasoningLevel);
        return;
    }

    if (snapshot.provider && state.activeProvider && snapshot.provider !== state.activeProvider) {
        ui.write(`Session used ${snapshot.provider}; current login is ${state.activeProvider}. Keeping current provider/model settings.`);
    }
}

function replaceHistory(history: ChatMessage[], nextHistory: ChatMessage[]): void {
    history.splice(0, history.length, ...nextHistory);
}

function truncateSessionText(text: string, maxLength: number): string {
    const normalized = text.trim();
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function renderSessionHistoryPreview(ui: InteractiveUi, sessionManager: SessionManager, history: ChatMessage[]): void {
    if (history.length === 0) {
        ui.write(`Started session ${sessionManager.getSessionId().slice(0, 8)}.`);
        return;
    }

    const maxMessages = 12;
    const visible = history.filter((message) => message.role === "user" || message.role === "assistant");
    const omitted = Math.max(0, visible.length - maxMessages);
    ui.write(`Resumed session ${sessionManager.getSessionId().slice(0, 8)} with ${visible.length} messages.${omitted > 0 ? ` Showing last ${maxMessages}; ${omitted} earlier messages are still in context.` : ""}`);

    for (const message of visible.slice(-maxMessages)) {
        const content = truncateSessionText(message.content, 4_000);
        if (!content) continue;
        if (message.role === "user") ui.writeUser(content);
        else ui.write(content);
    }
}

function formatSessionChoiceLabel(session: SessionInfo): string {
    return truncateSessionText(session.firstMessage.replace(/\s+/g, " "), 72) || "(no messages)";
}

function formatSessionChoiceDescription(session: SessionInfo, scope: "current" | "all"): string {
    const parts = [
        session.id.slice(0, 8),
        `${session.messageCount} ${session.messageCount === 1 ? "message" : "messages"}`,
        formatSessionAge(session.modified),
    ];
    if (scope === "all") parts.push(formatSessionPath(session.cwd));
    return parts.join(" · ");
}

async function chooseSessionPath(ui: InteractiveUi, cwd: string, sessionDir?: string): Promise<string | null> {
    const currentSessions = await SessionManager.list(cwd, sessionDir);
    const allSessions = await SessionManager.listAll();
    const seen = new Set(currentSessions.map((session) => session.path));
    const globalSessions = allSessions.filter((session) => !seen.has(session.path));
    const options = [
        ...currentSessions.slice(0, 30).map((session) => ({
            label: formatSessionChoiceLabel(session),
            value: session.path,
            description: `current · ${formatSessionChoiceDescription(session, "current")}`,
        })),
        ...globalSessions.slice(0, 20).map((session) => ({
            label: formatSessionChoiceLabel(session),
            value: session.path,
            description: `all · ${formatSessionChoiceDescription(session, "all")}`,
        })),
    ];

    if (options.length === 0) return null;
    return ui.choose("Resume session", options);
}

async function createSessionManagerFromOptions(options: CliOptions, cwd: string, ui: InteractiveUi): Promise<SessionManager> {
    const sessionDir = options.sessionDir ? path.resolve(options.sessionDir) : undefined;

    if (options.session === false) {
        return SessionManager.inMemory(cwd);
    }

    if (typeof options.session === "string") {
        const resolved = await resolveSessionPath(options.session, cwd, sessionDir);
        if (resolved.type === "not_found") {
            ui.write(`No session found matching '${resolved.arg}'. Starting a new session.`);
            return SessionManager.create(cwd, sessionDir);
        }
        if (resolved.type === "global" && resolved.cwd && resolved.cwd !== cwd) {
            ui.write(`Session is from ${formatSessionPath(resolved.cwd)}. Resuming its messages in the current directory.`);
        }
        return SessionManager.open(resolved.path, sessionDir, cwd);
    }

    if (options.resume) {
        const selectedPath = await chooseSessionPath(ui, cwd, sessionDir);
        if (!selectedPath) {
            ui.write("No saved sessions found. Starting a new session.");
            return SessionManager.create(cwd, sessionDir);
        }
        return SessionManager.open(selectedPath, sessionDir, cwd);
    }

    if (options.continue) {
        return SessionManager.continueRecent(cwd, sessionDir);
    }

    return SessionManager.create(cwd, sessionDir);
}

function describeSession(sessionManager: SessionManager, history: ChatMessage[]): string {
    const file = sessionManager.getSessionFile();
    return [
        `Session ${sessionManager.getSessionId()}`,
        `Messages: ${history.filter((message) => message.role === "user" || message.role === "assistant").length}`,
        `Storage: ${sessionManager.isPersisted() ? file ?? "pending first assistant response" : "disabled"}`,
        `Directory: ${sessionManager.isPersisted() ? sessionManager.getSessionDir() : "—"}`,
    ].join("\n");
}

function createStreamingTextBlockManager(ui: InteractiveUi, variant: "default" | "thinking") {
    const blockIds = new Map<string, string>();
    let streamed = false;

    return {
        get hasStreamedText(): boolean {
            return streamed;
        },
        onStart(itemId: string): void {
            if (blockIds.has(itemId)) {
                return;
            }

            const blockId = ui.startStreamingBlock("", variant);
            blockIds.set(itemId, blockId);
        },
        onDelta(itemId: string, delta: string): void {
            let blockId = blockIds.get(itemId);
            if (!blockId) {
                this.onStart(itemId);
                blockId = blockIds.get(itemId);
            }

            if (!blockId || delta.length === 0) {
                return;
            }

            streamed = true;
            ui.appendToStreamingBlock(blockId, delta);
        },
        onDone(itemId: string): void {
            const blockId = blockIds.get(itemId);
            if (!blockId) {
                return;
            }

            ui.finishStreamingBlock(blockId);
            blockIds.delete(itemId);
        },
        finishAll(): void {
            for (const [itemId, blockId] of blockIds.entries()) {
                ui.finishStreamingBlock(blockId);
                blockIds.delete(itemId);
            }
        },
    };
}

function createPersistentPromptController(ui: TerminalUi, onUserInterrupt: () => void) {
    const pending: string[] = [];
    const waiters: Array<{ resolve: (value: string) => void; reject: (error: Error) => void }> = [];
    let stopped = false;
    let paused = false;
    let pauseResolver: (() => void) | null = null;
    let pauseReadyResolver: (() => void) | null = null;
    let pauseReadyPromise: Promise<void> | null = null;
    let running = false;
    let asking = false;

    const markPauseReady = () => {
        const resolve = pauseReadyResolver;
        pauseReadyResolver = null;
        resolve?.();
    };

    const updateQueuedDisplay = () => {
        ui.setQueuedSteeringMessages(pending.filter((message) => !message.trim().startsWith("/")));
    };

    ui.setQueuedMessageEditHandler(() => {
        const editable = pending.filter((message) => !message.trim().startsWith("/"));
        if (editable.length === 0) return "";
        const deferredCommands = pending.filter((message) => message.trim().startsWith("/"));
        pending.splice(0, pending.length, ...deferredCommands);
        updateQueuedDisplay();
        return editable.join("\n\n");
    });

    const failWaiters = (error: Error) => {
        for (const waiter of waiters.splice(0)) waiter.reject(error);
    };

    const enqueue = (value: string) => {
        const waiter = waiters.shift();
        if (waiter) waiter.resolve(value);
        else {
            pending.push(value);
            updateQueuedDisplay();
        }
    };

    const waitWhilePaused = async () => {
        while (paused && !stopped) {
            markPauseReady();
            await new Promise<void>((resolve) => {
                pauseResolver = resolve;
            });
        }
    };

    const run = async () => {
        if (running) return;
        running = true;
        try {
            while (!stopped) {
                await waitWhilePaused();
                if (stopped) break;
                if (paused) continue;
                try {
                    asking = true;
                    const answer = await ui.ask(">", {
                        placeholder: "Type a message or a slash command",
                        enableSlashCommands: true,
                    });
                    asking = false;
                    if (!stopped && answer.trim().length > 0) enqueue(answer);
                } catch (error) {
                    asking = false;
                    if ((error as Error).name === "AbortError" && paused) {
                        markPauseReady();
                        await waitWhilePaused();
                        continue;
                    }
                    if (stopped) break;
                    if ((error as Error).name === "UserInterruptError") {
                        stopped = true;
                        failWaiters(error as Error);
                        onUserInterrupt();
                        break;
                    }
                    if ((error as Error).name !== "AbortError") throw error;
                }
            }
        } finally {
            running = false;
        }
    };

    return {
        start(): void {
            void run();
        },
        async pause(): Promise<void> {
            if (paused && pauseReadyPromise) {
                await pauseReadyPromise;
                return;
            }
            paused = true;
            pauseReadyPromise = new Promise<void>((resolve) => {
                pauseReadyResolver = resolve;
            });
            ui.cancelActiveInput();
            if (!asking) markPauseReady();
            await pauseReadyPromise;
        },
        resume(): void {
            if (!paused) return;
            paused = false;
            pauseReadyPromise = null;
            pauseReadyResolver = null;
            const resolve = pauseResolver;
            pauseResolver = null;
            resolve?.();
            void run();
        },
        stop(): void {
            stopped = true;
            paused = false;
            pauseReadyResolver?.();
            pauseReadyResolver = null;
            pauseReadyPromise = null;
            const resolve = pauseResolver;
            pauseResolver = null;
            resolve?.();
            ui.cancelActiveInput();
            ui.setQueuedMessageEditHandler(null);
            ui.setQueuedSteeringMessages([]);
        },
        take(): Promise<string> {
            const value = pending.shift();
            updateQueuedDisplay();
            if (value !== undefined) return Promise.resolve(value);
            return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
        },
        drain(): string[] {
            const drained = pending.splice(0);
            updateQueuedDisplay();
            return drained;
        },
        pushFront(values: string[]): void {
            pending.unshift(...values);
            updateQueuedDisplay();
        },
    };
}

function createThinkingTraceStreamer(ui: InteractiveUi) {
    const manager = createStreamingTextBlockManager(ui, "thinking");
    return {
        get hasStreamedThinking(): boolean {
            return manager.hasStreamedText;
        },
        onStart(itemId: string): void {
            manager.onStart(itemId);
        },
        onDelta(itemId: string, delta: string): void {
            manager.onDelta(itemId, delta);
        },
        onDone(itemId: string): void {
            manager.onDone(itemId);
        },
        finishAll(): void {
            manager.finishAll();
        },
    };
}

function createAssistantTextStreamer(ui: InteractiveUi) {
    let blockId: string | null = null;
    let streamed = false;

    return {
        get hasStreamedText(): boolean {
            return streamed;
        },
        onDelta(_itemId: string, delta: string): void {
            if (delta.length === 0) return;
            if (!blockId) blockId = ui.startStreamingBlock("", "default");
            streamed = true;
            ui.appendToStreamingBlock(blockId, delta);
        },
        onDone(_itemId: string): void {
            // Keep one assistant block alive for the whole response. Some
            // providers/proxies can emit multiple text item ids or premature
            // done events; finishing per item creates repeated prefix blocks.
        },
        finishAll(): void {
            if (!blockId) return;
            ui.finishStreamingBlock(blockId);
            blockId = null;
        },
    };
}

function yieldToEventLoop(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

function isFunctionCallItem(item: ResponseOutputItem): item is Extract<ResponseOutputItem, { type: "function_call" }> {
    return item.type === "function_call";
}

function isReasoningItem(item: ResponseOutputItem): item is Extract<ResponseOutputItem, { type: "reasoning" }> {
    return item.type === "reasoning";
}

function isWebSearchItem(item: ResponseOutputItem): item is Extract<ResponseOutputItem, { type: "web_search_call" }> {
    return item.type === "web_search_call";
}

function isFileSearchItem(item: ResponseOutputItem): item is Extract<ResponseOutputItem, { type: "file_search_call" }> {
    return item.type === "file_search_call";
}

function isCodeInterpreterItem(item: ResponseOutputItem): item is Extract<ResponseOutputItem, { type: "code_interpreter_call" }> {
    return item.type === "code_interpreter_call";
}

function isMcpCallItem(item: ResponseOutputItem): item is Extract<ResponseOutputItem, { type: "mcp_call" }> {
    return item.type === "mcp_call";
}

function isMcpListToolsItem(item: ResponseOutputItem): item is Extract<ResponseOutputItem, { type: "mcp_list_tools" }> {
    return item.type === "mcp_list_tools";
}

function isMcpApprovalRequestItem(item: ResponseOutputItem): item is Extract<ResponseOutputItem, { type: "mcp_approval_request" }> {
    return item.type === "mcp_approval_request";
}

function isLocalShellCallItem(item: ResponseOutputItem): item is Extract<ResponseOutputItem, { type: "local_shell_call" }> {
    return item.type === "local_shell_call";
}

function isLocalShellOutputItem(item: ResponseOutputItem): item is Extract<ResponseOutputItem, { type: "local_shell_call_output" }> {
    return item.type === "local_shell_call_output";
}

function isToolSearchCallItem(item: ResponseOutputItem): item is Extract<ResponseOutputItem, { type: "tool_search_call" }> {
    return item.type === "tool_search_call";
}

function isToolSearchOutputItem(item: ResponseOutputItem): item is Extract<ResponseOutputItem, { type: "tool_search_output" }> {
    return item.type === "tool_search_output";
}

function formatToolExecutionError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function createFunctionCallTraceManager(ui: InteractiveUi) {
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

                const toolName = itemIdsToNames.get(responseEvent.item_id) ?? "function_call";
                const nextArguments = `${argumentBuffers.get(callId) ?? ""}${typeof responseEvent.delta === "string" ? responseEvent.delta : ""}`;
                argumentBuffers.set(callId, nextArguments);
                if (isShown(callId)) {
                    ui.updateToolCallArguments(callId, nextArguments, tryParseJson(nextArguments));
                }
                return;
            }

            if (responseEvent.type === "response.function_call_arguments.done") {
                const callId = itemIdsToCallIds.get(responseEvent.item_id) ?? responseEvent.item_id;
                const toolName = itemIdsToNames.get(responseEvent.item_id) ?? (typeof responseEvent.name === "string" ? responseEvent.name : "function_call");
                const finalArguments = typeof responseEvent.arguments === "string" ? responseEvent.arguments : "";
                argumentBuffers.set(callId, finalArguments);
                if (isShown(callId)) {
                    ui.updateToolCallArguments(callId, finalArguments, tryParseJson(finalArguments));
                }
            }
        },
    };
}

function createProviderNativeTraceManager(ui: InteractiveUi) {
    type ProviderTraceEntry = {
        toolName: string;
        args?: unknown;
        output: string;
        details?: KnownToolTraceDetails;
    };

    const traces = new Map<string, ProviderTraceEntry>();
    const codeInterpreterCode = new Map<string, string>();
    const mcpArguments = new Map<string, string>();

    const ensureTrace = (
        id: string,
        toolName: string,
        args: unknown,
        status: "pending" | "running" | "complete" | "error" | "aborted",
        output: string,
        details?: KnownToolTraceDetails,
    ): boolean => {
        const existing = traces.get(id);
        if (!existing) {
            ui.showToolCall(id, toolName, args, status, output, details);
            traces.set(id, {
                toolName,
                args,
                output,
                details,
            });
            return true;
        }

        if (args !== undefined) {
            traces.set(id, {
                ...existing,
                args,
            });
        }

        return false;
    };

    const setRunning = (id: string, toolName: string, args?: unknown, details?: KnownToolTraceDetails, output?: string) => {
        const current = traces.get(id);
        const nextEntry: ProviderTraceEntry = {
            toolName,
            args: args ?? current?.args,
            output: output ?? current?.output ?? "",
            details: details ?? current?.details,
        };
        const created = ensureTrace(id, toolName, nextEntry.args, "running", nextEntry.output, nextEntry.details);
        traces.set(id, nextEntry);
        if (!created) {
            ui.updateToolExecution(id, nextEntry.output, false, nextEntry.details);
        }
    };

    const setFinished = (
        id: string,
        toolName: string,
        args?: unknown,
        details?: KnownToolTraceDetails,
        output?: string,
        isError = false,
    ) => {
        const current = traces.get(id);
        const nextEntry: ProviderTraceEntry = {
            toolName,
            args: args ?? current?.args,
            output: output ?? current?.output ?? "",
            details: details ?? current?.details,
        };
        const created = ensureTrace(id, toolName, nextEntry.args, isError ? "error" : "complete", nextEntry.output, nextEntry.details);
        traces.set(id, nextEntry);
        if (!created) {
            ui.finishToolExecution(id, nextEntry.output, isError, nextEntry.details);
        }
    };

    const withNote = (details: KnownToolTraceDetails | undefined, note: string): KnownToolTraceDetails | undefined => {
        if (!details || !("note" in details)) {
            return details;
        }

        return {
            ...details,
            note,
        } as KnownToolTraceDetails;
    };

    const getTrace = (id: string): ProviderTraceEntry | undefined => traces.get(id);

    const getWebSearchArgs = (item: Extract<ResponseOutputItem, { type: "web_search_call" }>): { action: string } | undefined => {
        const action = (item as { action?: { type?: unknown } }).action;
        return action && typeof action.type === "string"
            ? { action: action.type }
            : undefined;
    };

    const buildWebSearchDetails = (
        item: Extract<ResponseOutputItem, { type: "web_search_call" }>,
        note?: string,
    ): WebSearchTraceDetails => {
        const action = (item as { action?: any }).action;
        if (!action || typeof action.type !== "string") {
            return {
                type: "web_search",
                note,
            };
        }

        if (action.type === "search") {
            return {
                type: "web_search",
                actionType: "search",
                queries: Array.isArray(action.queries)
                    ? action.queries.filter((query: unknown): query is string => typeof query === "string")
                    : typeof action.query === "string"
                        ? [action.query]
                        : [],
                sources: Array.isArray(action.sources)
                    ? action.sources
                        .map((source: { url?: unknown }) => typeof source?.url === "string" ? source.url : null)
                        .filter((url: string | null): url is string => url !== null)
                    : [],
                note,
            };
        }

        if (action.type === "open_page") {
            return {
                type: "web_search",
                actionType: "open_page",
                url: typeof action.url === "string" ? action.url : undefined,
                note,
            };
        }

        return {
            type: "web_search",
            actionType: "find_in_page",
            url: typeof action.url === "string" ? action.url : undefined,
            pattern: typeof action.pattern === "string" ? action.pattern : undefined,
            note,
        };
    };

    const buildFileSearchDetails = (
        item: Extract<ResponseOutputItem, { type: "file_search_call" }>,
        note?: string,
    ): FileSearchTraceDetails => ({
        type: "file_search",
        queries: item.queries,
        results: item.results?.map((result) => ({
            filename: result.filename,
            score: result.score,
            text: result.text,
        })) ?? [],
        note,
    });

    const buildCodeInterpreterDetails = (
        item: Extract<ResponseOutputItem, { type: "code_interpreter_call" }>,
        note?: string,
    ): CodeInterpreterTraceDetails => ({
        type: "code_interpreter",
        code: codeInterpreterCode.get(item.id) ?? "",
        outputs: item.outputs?.map((output) => output.type === "logs"
            ? { type: "logs" as const, content: output.logs }
            : { type: "image" as const, content: output.url }) ?? [],
        note,
    });

    const buildMcpCallDetails = (
        item: Extract<ResponseOutputItem, { type: "mcp_call" }>,
        note?: string,
    ): McpTraceDetails => ({
        type: "mcp",
        serverLabel: item.server_label,
        toolName: item.name,
        argumentsText: mcpArguments.get(item.id) ?? item.arguments,
        output: item.output ?? undefined,
        note,
    });

    const buildMcpListToolsDetails = (
        item: Extract<ResponseOutputItem, { type: "mcp_list_tools" }>,
        note?: string,
    ): McpTraceDetails => ({
        type: "mcp",
        serverLabel: item.server_label,
        tools: item.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
        })),
        note,
    });

    const buildMcpApprovalRequestDetails = (
        item: Extract<ResponseOutputItem, { type: "mcp_approval_request" }>,
        note?: string,
    ): McpTraceDetails => ({
        type: "mcp",
        serverLabel: item.server_label,
        toolName: item.name,
        argumentsText: item.arguments,
        note,
    });

    const buildLocalShellCallDetails = (
        item: Extract<ResponseOutputItem, { type: "local_shell_call" }>,
        note?: string,
    ): LocalShellTraceDetails => ({
        type: "local_shell",
        command: item.action.command.join(" "),
        workingDirectory: item.action.working_directory ?? undefined,
        note,
    });

    const buildToolSearchCallDetails = (
        item: Extract<ResponseOutputItem, { type: "tool_search_call" }>,
        note?: string,
    ): ToolSearchTraceDetails => ({
        type: "tool_search",
        argumentsText: (() => {
            try {
                return JSON.stringify(item.arguments, null, 2);
            } catch {
                return String(item.arguments);
            }
        })(),
        note,
    });

    const buildToolSearchOutputDetails = (
        item: Extract<ResponseOutputItem, { type: "tool_search_output" }>,
        note?: string,
    ): ToolSearchTraceDetails => ({
        type: "tool_search",
        tools: item.tools.map((tool) => ({
            name: "name" in tool && typeof tool.name === "string" ? tool.name : item.type,
            description: "description" in tool && typeof tool.description === "string" ? tool.description : null,
            type: "type" in tool && typeof tool.type === "string" ? tool.type : null,
        })),
        note,
    });

    return {
        onOutputItemAdded(item: ResponseOutputItem): void {
            if (isWebSearchItem(item)) {
                setRunning(item.id, "web_search", getWebSearchArgs(item), buildWebSearchDetails(item, "Searching the web..."));
                return;
            }

            if (isFileSearchItem(item)) {
                setRunning(item.id, "file_search", { queries: item.queries }, buildFileSearchDetails(item, "Searching files..."));
                return;
            }

            if (isCodeInterpreterItem(item)) {
                setRunning(item.id, "code_interpreter", undefined, buildCodeInterpreterDetails(item, "Preparing code interpreter..."));
                return;
            }

            if (isMcpCallItem(item)) {
                setRunning(item.id, "mcp", undefined, buildMcpCallDetails(item, "Calling MCP tool..."));
                return;
            }

            if (isMcpListToolsItem(item)) {
                setRunning(item.id, "mcp", undefined, buildMcpListToolsDetails(item, "Listing MCP tools..."));
                return;
            }

            if (isMcpApprovalRequestItem(item)) {
                setFinished(item.id, "mcp", undefined, buildMcpApprovalRequestDetails(item, "Approval required."));
                return;
            }

            if (isLocalShellCallItem(item)) {
                setRunning(item.id, "local_shell", undefined, buildLocalShellCallDetails(item, "Running shell command..."));
                return;
            }

            if (isToolSearchCallItem(item)) {
                setRunning(item.id, "tool_search", undefined, buildToolSearchCallDetails(item, "Searching for tools..."));
            }
        },
        onOutputItemDone(item: ResponseOutputItem): void {
            if (isWebSearchItem(item)) {
                setFinished(item.id, "web_search", getWebSearchArgs(item), buildWebSearchDetails(item, "Web search completed."), undefined, item.status === "failed");
                return;
            }

            if (isFileSearchItem(item)) {
                setFinished(item.id, "file_search", { queries: item.queries }, buildFileSearchDetails(item, item.status === "failed" ? "File search failed." : "File search completed."), undefined, item.status === "failed" || item.status === "incomplete");
                return;
            }

            if (isCodeInterpreterItem(item)) {
                setFinished(item.id, "code_interpreter", undefined, buildCodeInterpreterDetails(item, item.status === "failed" ? "Code interpreter failed." : "Code interpreter completed."), undefined, item.status === "failed" || item.status === "incomplete");
                return;
            }

            if (isMcpCallItem(item)) {
                setFinished(item.id, "mcp", undefined, buildMcpCallDetails(item, item.status === "failed" ? "MCP call failed." : "MCP call completed."), item.output ?? undefined, item.status === "failed" || item.status === "incomplete");
                return;
            }

            if (isMcpListToolsItem(item)) {
                setFinished(item.id, "mcp", undefined, buildMcpListToolsDetails(item, item.error ? "Failed to list MCP tools." : "Listed MCP tools."), item.error ?? undefined, !!item.error);
                return;
            }

            if (isMcpApprovalRequestItem(item)) {
                setFinished(item.id, "mcp", undefined, buildMcpApprovalRequestDetails(item, "Approval required."));
                return;
            }

            if (isLocalShellCallItem(item)) {
                setFinished(item.id, "local_shell", undefined, buildLocalShellCallDetails(item, "Shell call completed."));
                return;
            }

            if (isLocalShellOutputItem(item)) {
                const existing = getTrace(item.id);
                const details: LocalShellTraceDetails = existing?.details?.type === "local_shell"
                    ? {
                        ...existing.details,
                        output: item.output,
                        note: "Shell call completed.",
                    }
                    : {
                        type: "local_shell",
                        output: item.output,
                        note: "Shell call completed.",
                    };
                setFinished(item.id, "local_shell", undefined, details, item.output);
                return;
            }

            if (isToolSearchCallItem(item)) {
                setFinished(item.id, "tool_search", undefined, buildToolSearchCallDetails(item, "Tool search completed."));
                return;
            }

            if (isToolSearchOutputItem(item)) {
                const traceId = item.call_id ?? item.id;
                setFinished(traceId, "tool_search", undefined, buildToolSearchOutputDetails(item, "Tool search completed."));
            }
        },
        onResponseEvent(event: ResponseStreamEvent | { type: string; [key: string]: unknown }): void {
            const responseEvent = event as any;

            switch (responseEvent.type) {
                case "response.web_search_call.in_progress":
                    setRunning(responseEvent.item_id, "web_search", undefined, withNote(getTrace(responseEvent.item_id)?.details, "Starting web search..."));
                    return;
                case "response.web_search_call.searching":
                    setRunning(responseEvent.item_id, "web_search", undefined, withNote(getTrace(responseEvent.item_id)?.details, "Searching the web..."));
                    return;
                case "response.web_search_call.completed":
                    setFinished(responseEvent.item_id, "web_search", undefined, withNote(getTrace(responseEvent.item_id)?.details, "Web search completed."));
                    return;
                case "response.file_search_call.in_progress":
                    setRunning(responseEvent.item_id, "file_search", undefined, withNote(getTrace(responseEvent.item_id)?.details, "Starting file search..."));
                    return;
                case "response.file_search_call.searching":
                    setRunning(responseEvent.item_id, "file_search", undefined, withNote(getTrace(responseEvent.item_id)?.details, "Searching files..."));
                    return;
                case "response.file_search_call.completed":
                    setFinished(responseEvent.item_id, "file_search", undefined, withNote(getTrace(responseEvent.item_id)?.details, "File search completed."));
                    return;
                case "response.code_interpreter_call.in_progress":
                    setRunning(responseEvent.item_id, "code_interpreter", undefined, withNote(getTrace(responseEvent.item_id)?.details, "Preparing code interpreter..."));
                    return;
                case "response.code_interpreter_call.interpreting":
                    setRunning(responseEvent.item_id, "code_interpreter", undefined, withNote(getTrace(responseEvent.item_id)?.details, "Executing code..."));
                    return;
                case "response.code_interpreter_call.completed":
                    setFinished(responseEvent.item_id, "code_interpreter", undefined, withNote(getTrace(responseEvent.item_id)?.details, "Code interpreter completed."));
                    return;
                case "response.code_interpreter_call_code.delta": {
                    const nextCode = `${codeInterpreterCode.get(responseEvent.item_id) ?? ""}${typeof responseEvent.delta === "string" ? responseEvent.delta : ""}`;
                    codeInterpreterCode.set(responseEvent.item_id, nextCode);
                    const existing = getTrace(responseEvent.item_id)?.details;
                    const details: CodeInterpreterTraceDetails = existing?.type === "code_interpreter"
                        ? {
                            ...existing,
                            code: nextCode,
                            note: "Generating code...",
                        }
                        : {
                            type: "code_interpreter",
                            code: nextCode,
                            note: "Generating code...",
                        };
                    setRunning(responseEvent.item_id, "code_interpreter", undefined, details);
                    return;
                }
                case "response.code_interpreter_call_code.done": {
                    const finalCode = typeof responseEvent.code === "string" ? responseEvent.code : "";
                    codeInterpreterCode.set(responseEvent.item_id, finalCode);
                    const existing = getTrace(responseEvent.item_id)?.details;
                    const details: CodeInterpreterTraceDetails = existing?.type === "code_interpreter"
                        ? {
                            ...existing,
                            code: finalCode,
                            note: "Executing code...",
                        }
                        : {
                            type: "code_interpreter",
                            code: finalCode,
                            note: "Executing code...",
                        };
                    setRunning(responseEvent.item_id, "code_interpreter", undefined, details);
                    return;
                }
                case "response.mcp_call.in_progress":
                    setRunning(responseEvent.item_id, "mcp", undefined, withNote(getTrace(responseEvent.item_id)?.details, "Calling MCP tool..."));
                    return;
                case "response.mcp_call.completed":
                    setFinished(responseEvent.item_id, "mcp", undefined, withNote(getTrace(responseEvent.item_id)?.details, "MCP call completed."));
                    return;
                case "response.mcp_call.failed":
                    setFinished(responseEvent.item_id, "mcp", undefined, withNote(getTrace(responseEvent.item_id)?.details, "MCP call failed."), undefined, true);
                    return;
                case "response.mcp_call_arguments.delta": {
                    const nextArguments = `${mcpArguments.get(responseEvent.item_id) ?? ""}${typeof responseEvent.delta === "string" ? responseEvent.delta : ""}`;
                    mcpArguments.set(responseEvent.item_id, nextArguments);
                    const existing = getTrace(responseEvent.item_id)?.details;
                    const details: McpTraceDetails = existing?.type === "mcp"
                        ? {
                            ...existing,
                            argumentsText: nextArguments,
                            note: "Streaming MCP arguments...",
                        }
                        : {
                            type: "mcp",
                            argumentsText: nextArguments,
                            note: "Streaming MCP arguments...",
                        };
                    setRunning(responseEvent.item_id, "mcp", undefined, details);
                    return;
                }
                case "response.mcp_call_arguments.done": {
                    const finalArguments = typeof responseEvent.arguments === "string" ? responseEvent.arguments : "";
                    mcpArguments.set(responseEvent.item_id, finalArguments);
                    const existing = getTrace(responseEvent.item_id)?.details;
                    const details: McpTraceDetails = existing?.type === "mcp"
                        ? {
                            ...existing,
                            argumentsText: finalArguments,
                            note: "Calling MCP tool...",
                        }
                        : {
                            type: "mcp",
                            argumentsText: finalArguments,
                            note: "Calling MCP tool...",
                        };
                    setRunning(responseEvent.item_id, "mcp", undefined, details);
                    return;
                }
                case "response.mcp_list_tools.in_progress":
                    setRunning(responseEvent.item_id, "mcp", undefined, withNote(getTrace(responseEvent.item_id)?.details, "Listing MCP tools..."));
                    return;
                case "response.mcp_list_tools.completed":
                    setFinished(responseEvent.item_id, "mcp", undefined, withNote(getTrace(responseEvent.item_id)?.details, "Listed MCP tools."));
                    return;
                case "response.mcp_list_tools.failed":
                    setFinished(responseEvent.item_id, "mcp", undefined, withNote(getTrace(responseEvent.item_id)?.details, "Failed to list MCP tools."), undefined, true);
                    return;
                default:
                    return;
            }
        },
    };
}

async function executeLocalToolCall(
    toolCall: Extract<ResponseOutputItem, { type: "function_call" }>,
    localTools: Array<Tool<any, any>>,
    ui: InteractiveUi
): Promise<{ output: string; modelOutput?: ResponseInputItem.FunctionCallOutput["output"]; isError: boolean; details?: unknown }> {
    let args: unknown;

    try {
        args = JSON.parse(toolCall.arguments);
    } catch (error) {
        const message = `Invalid tool arguments for ${toolCall.name}: ${formatToolExecutionError(error)}`;
        ui.showToolCall(toolCall.call_id, toolCall.name, undefined, "error", message);
        ui.finishToolExecution(toolCall.call_id, message, true);
        return {
            output: message,
            isError: true,
        };
    }

    ui.showToolCall(toolCall.call_id, toolCall.name, args, "pending");
    ui.startToolExecution(toolCall.call_id);

    const tool = localTools.find((candidate) => candidate.name === toolCall.name);
    if (!tool) {
        const message = `Unknown local tool: ${toolCall.name}`;
        ui.finishToolExecution(toolCall.call_id, message, true);
        return {
            output: message,
            isError: true,
        };
    }

    try {
        const result = await tool.execute(args as never, {
            onUpdate: (update) => {
                ui.updateToolExecution(toolCall.call_id, update.output, !!update.isError, update.details);
            },
        });
        ui.finishToolExecution(toolCall.call_id, result.output, !!result.isError, result.details);
        return {
            output: result.output,
            modelOutput: result.modelOutput as ResponseInputItem.FunctionCallOutput["output"] | undefined,
            isError: !!result.isError,
            details: result.details,
        };
    } catch (error) {
        const message = formatToolExecutionError(error);
        ui.finishToolExecution(toolCall.call_id, message, true);
        return {
            output: message,
            isError: true,
        };
    }
}

async function getApiKeyResponse(
    client: OpenAI,
    agentInput: any[],
    tools: any[],
    model: string,
    reasoningLevel: ReasoningLevel,
    contextLevel: ContextLevel,
    ui: InteractiveUi
): Promise<{ response: Response; streamedThinking: boolean; streamedOutputText: boolean; rateLimit: RateLimitSnapshot | null }> {
    const thinking = createThinkingTraceStreamer(ui);
    const outputText = createAssistantTextStreamer(ui);
    const functionCallTraces = createFunctionCallTraceManager(ui);
    const providerTraces = createProviderNativeTraceManager(ui);
    const contextConfig = getContextConfig(model, contextLevel);
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
    }).withResponse();

    let finalResponse: Response | null = null;
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
                thinking.onStart(event.item.id);
            }

            if (
                (event.type === "response.reasoning_summary_text.delta" || event.type === "response.reasoning_text.delta") &&
                "delta" in event &&
                typeof event.delta === "string"
            ) {
                thinking.onDelta(event.item_id, event.delta);
                await yieldToEventLoop();
            }

            if (event.type === "response.reasoning_summary_text.done" || event.type === "response.reasoning_text.done") {
                thinking.onDone(event.item_id);
            }

            if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
                outputText.onDelta(event.item_id, event.delta);
                await yieldToEventLoop();
            }

            if (event.type === "response.output_text.done") {
                outputText.onDone(event.item_id);
            }

            if (event.type === "response.completed") {
                finalResponse = event.response as Response;
            }
        }

        if (!finalResponse) {
            throw new Error("No final response received from OpenAI stream.");
        }

        return {
            response: finalResponse,
            streamedThinking: thinking.hasStreamedThinking,
            streamedOutputText: outputText.hasStreamedText,
            rateLimit,
        };
    } finally {
        thinking.finishAll();
        outputText.finishAll();
    }
}

async function main(options: CliOptions = {}) {
    const ui = await TerminalUi.create();
    const promptController = createPersistentPromptController(ui, () => {
        setOutputWriter(null);
        ui.destroy();
        process.exit(130);
    });
    setOutputWriter((message) => {
        ui.write(message);
    });

    const history: ChatMessage[] = [];
    const systemContext: ChatMessage = {
        role: "developer",
        content: systemPrompt,
    };
    const localTools = [readTool, writeTool, editTool, runCommandTool];
    const openaiTools: any[] = [
        ...localTools.map((tool) => tool.definition),
        { type: "web_search" },
    ];

    let state: State = {
        activeProvider: null,
        client: null,
        currentModel: getDefaultModel(null),
        reasoningLevel: getDefaultReasoningLevel(),
        contextLevel: getDefaultContextLevel(),
    };
    let lastTurnElapsedMs: number | null = null;
    let lastTurnUsage: TurnUsageSnapshot | null = null;
    let lastRateLimit: RateLimitSnapshot | null = null;

    ui.write("Perry started. Type /quit to exit.");
    await getCurrentSessionStatus(state);

    let sessionManager = await createSessionManagerFromOptions(options, process.cwd(), ui);
    replaceHistory(history, sessionManager.buildHistory());
    applySessionState(sessionManager, state, ui);
    sessionManager.appendState(getStateSnapshot(state));
    if (history.length > 0 || options.resume || options.continue || typeof options.session === "string") {
        renderSessionHistoryPreview(ui, sessionManager, history);
    }

    ui.setReasoningLevel(state.reasoningLevel);

    promptController.start();

    try {
        while (true) {
            ui.setReasoningLevel(state.reasoningLevel);
            ui.setStatus(
                state.activeProvider
                    ? `Provider: ${state.activeProvider} | Model: ${state.currentModel} | Reasoning: ${state.reasoningLevel} | Context: ${state.contextLevel}`
                    : "Not logged in"
            );
            ui.setSessionDetails(await buildPromptSessionDetails(
                state,
                history,
                systemContext,
                openaiTools,
                lastTurnUsage,
                lastTurnElapsedMs,
                lastRateLimit,
                sessionManager,
            ));
            ui.clearBusy();
            const answer = await promptController.take();
            const trimmed = answer.trim();

            if (!trimmed) {
                continue;
            }

            ui.writeUser(answer);

            if (trimmed.startsWith("/")) {
                await promptController.pause();
                try {
                    const [commandName, ...commandArgs] = trimmed.split(/\s+/);

                    if (commandName === "/session") {
                        ui.write(describeSession(sessionManager, history));
                        continue;
                    }

                    if (commandName === "/new") {
                        sessionManager = sessionManager.isPersisted()
                            ? SessionManager.create(process.cwd(), sessionManager.getSessionDir())
                            : SessionManager.inMemory(process.cwd());
                        replaceHistory(history, []);
                        sessionManager.appendState(getStateSnapshot(state));
                        ui.write(`Started new session ${sessionManager.getSessionId().slice(0, 8)}.`);
                        continue;
                    }

                    if (commandName === "/continue") {
                        sessionManager = sessionManager.isPersisted()
                            ? SessionManager.continueRecent(process.cwd(), sessionManager.getSessionDir())
                            : SessionManager.continueRecent(process.cwd());
                        replaceHistory(history, sessionManager.buildHistory());
                        applySessionState(sessionManager, state, ui);
                        sessionManager.appendState(getStateSnapshot(state));
                        renderSessionHistoryPreview(ui, sessionManager, history);
                        continue;
                    }

                    if (commandName === "/resume") {
                        let selectedPath: string | null = null;
                        const reference = commandArgs[0];
                        const sessionDir = sessionManager.isPersisted() ? sessionManager.getSessionDir() : undefined;
                        if (reference) {
                            const resolved = await resolveSessionPath(reference, process.cwd(), sessionDir);
                            if (resolved.type === "not_found") {
                                ui.write(`No session found matching '${resolved.arg}'.`);
                                continue;
                            }
                            if (resolved.type === "global" && resolved.cwd !== process.cwd()) {
                                ui.write(`Session is from ${formatSessionPath(resolved.cwd)}. Resuming its messages in the current directory.`);
                            }
                            selectedPath = resolved.path;
                        } else {
                            selectedPath = await chooseSessionPath(ui, process.cwd(), sessionDir);
                        }

                        if (!selectedPath) {
                            ui.write("No saved sessions found.");
                            continue;
                        }

                        sessionManager = SessionManager.open(selectedPath, sessionDir, process.cwd());
                        replaceHistory(history, sessionManager.buildHistory());
                        applySessionState(sessionManager, state, ui);
                        sessionManager.appendState(getStateSnapshot(state));
                        renderSessionHistoryPreview(ui, sessionManager, history);
                        continue;
                    }

                    const beforeState = JSON.stringify(getStateSnapshot(state));
                    const shouldContinue = await handleSlashCommands({ command: trimmed, state, ui });
                    if (JSON.stringify(getStateSnapshot(state)) !== beforeState) {
                        sessionManager.appendState(getStateSnapshot(state));
                    }
                    if (shouldContinue === false) {
                        break;
                    }
                } finally {
                    promptController.resume();
                }

                continue;
            }

            if (!state.activeProvider) {
                ui.write("Not logged in. Type /login to continue.");
                continue;
            }

            if (state.activeProvider === "openai-api-key" && !state.client) {
                ui.write("OpenAI API key client is not available. Run /login again.");
                continue;
            }

            const userMessage: ChatMessage = {
                role: "user",
                content: answer,
            };
            history.push(userMessage);
            sessionManager.appendMessage(userMessage);

            let agentInput: any[] = [
                systemContext,
                ...history,
            ];
            let codexInput: any[] = [
                ...history,
            ];
            const turnStartedAt = Date.now();
            const turnUsage = createEmptyTurnUsageSnapshot();
            const drainQueuedUserMessages = (): ChatMessage[] => {
                const queuedInputs = promptController.drain();
                if (queuedInputs.length === 0) return [];
                const slashCommands = queuedInputs.filter((input) => input.trim().startsWith("/"));
                const userMessages = queuedInputs.filter((input) => !input.trim().startsWith("/"));
                if (slashCommands.length > 0) promptController.pushFront(slashCommands);
                return userMessages.map((input) => ({ role: "user" as const, content: input }));
            };

            ui.setBusy("Working");
            ui.setStatus("Waiting for model response...");

            try {
                while (true) {
                    let aiResponse: Response | ParsedCodexResponse;
                    let streamedThinking = false;
                    let streamedOutputText = false;

                    if (state.activeProvider === "openai-api-key") {
                        if (!state.client) {
                            throw new Error("OpenAI API key client missing.");
                        }

                        const streamedResponse = await getApiKeyResponse(
                            state.client as OpenAI,
                            agentInput,
                            openaiTools,
                            state.currentModel,
                            state.reasoningLevel,
                            state.contextLevel,
                            ui
                        );
                        aiResponse = streamedResponse.response;
                        streamedThinking = streamedResponse.streamedThinking;
                        streamedOutputText = streamedResponse.streamedOutputText;
                        lastRateLimit = streamedResponse.rateLimit ?? lastRateLimit;
                    } else if (state.activeProvider === "openai-codex") {
                        const thinking = createThinkingTraceStreamer(ui);
                        const outputText = createAssistantTextStreamer(ui);
                        const functionCallTraces = createFunctionCallTraceManager(ui);
                        const providerTraces = createProviderNativeTraceManager(ui);
                        try {
                            aiResponse = await getCodexResponse({
                                input: codexInput,
                                model: state.currentModel,
                                reasoningLevel: state.reasoningLevel,
                                contextLevel: state.contextLevel,
                                tools: openaiTools,
                                instructions: systemPrompt,
                            }, {
                                onReasoningStart: (itemId) => thinking.onStart(itemId),
                                onReasoningDelta: (itemId, delta) => thinking.onDelta(itemId, delta),
                                onReasoningDone: (itemId) => thinking.onDone(itemId),
                                onOutputTextDelta: (itemId, delta) => outputText.onDelta(itemId, delta),
                                onOutputTextDone: (itemId) => outputText.onDone(itemId),
                                onOutputItemAdded: (item) => {
                                    functionCallTraces.onOutputItemAdded(item);
                                    providerTraces.onOutputItemAdded(item);
                                },
                                onOutputItemDone: (item) => providerTraces.onOutputItemDone(item),
                                onResponseEvent: (_eventName, event) => {
                                    functionCallTraces.onResponseEvent(event);
                                    providerTraces.onResponseEvent(event);
                                },
                            });
                            streamedThinking = thinking.hasStreamedThinking;
                            streamedOutputText = outputText.hasStreamedText;
                        } finally {
                            thinking.finishAll();
                            outputText.finishAll();
                        }
                    } else {
                        throw new Error("No active provider.");
                    }

                    addResponseUsage(turnUsage, aiResponse.usage);

                    const responseText = aiResponse.output_text;
                    const thinkingTraces = extractThinkingTraces(aiResponse.output);
                    const toolCalls = aiResponse.output.filter(isFunctionCallItem);
                    const assistantContextItems = aiResponse.output.filter((item) => !isReasoningItem(item));
                    let wroteFallbackThinking = false;
                    const wroteFallbackResponseText = Boolean(responseText) && !streamedOutputText;

                    if (!streamedThinking) {
                        for (const trace of thinkingTraces) {
                            ui.writeThinking(formatThinkingTrace(trace));
                            wroteFallbackThinking = true;
                        }
                    }

                    const shouldRefreshHistory = streamedOutputText || streamedThinking || wroteFallbackThinking || wroteFallbackResponseText;

                    if (responseText && !streamedOutputText) {
                        ui.write(responseText);
                    }

                    if (toolCalls.length > 0) {
                        if (shouldRefreshHistory) {
                            ui.refreshHistory();
                        }

                        if (responseText) {
                            const assistantMessage: ChatMessage = {
                                role: "assistant",
                                content: responseText,
                            };
                            history.push(assistantMessage);
                            sessionManager.appendMessage(assistantMessage);
                        }

                        const toolOutputs: Array<{ type: "function_call_output"; call_id: string; output: ResponseInputItem.FunctionCallOutput["output"] }> = [];

                        for (const toolCall of toolCalls) {
                            ui.setStatus(`Running tool: ${toolCall.name}`);
                            const toolResult = await executeLocalToolCall(toolCall, localTools, ui);
                            toolOutputs.push({
                                type: "function_call_output",
                                call_id: toolCall.call_id,
                                output: toolResult.modelOutput ?? toolResult.output,
                            });
                        }

                        const queuedUserMessages = drainQueuedUserMessages();
                        for (const message of queuedUserMessages) {
                            ui.writeUser(message.content);
                            history.push(message);
                            sessionManager.appendMessage(message);
                        }

                        agentInput = [
                            ...agentInput,
                            ...assistantContextItems,
                            ...toolOutputs,
                            ...queuedUserMessages,
                        ];

                        codexInput = [
                            ...codexInput,
                            ...assistantContextItems,
                            ...toolOutputs,
                            ...queuedUserMessages,
                        ];

                        ui.setStatus("Waiting for model response...");
                        continue;
                    }

                    if (responseText) {
                        const assistantMessage: ChatMessage = {
                            role: "assistant",
                            content: responseText,
                        };
                        history.push(assistantMessage);
                        sessionManager.appendMessage(assistantMessage);
                    }

                    const queuedUserMessages = drainQueuedUserMessages();
                    if (queuedUserMessages.length > 0) {
                        for (const message of queuedUserMessages) {
                            ui.writeUser(message.content);
                            history.push(message);
                            sessionManager.appendMessage(message);
                        }
                        agentInput = [
                            ...agentInput,
                            ...assistantContextItems,
                            ...queuedUserMessages,
                        ];
                        codexInput = [
                            ...codexInput,
                            ...assistantContextItems,
                            ...queuedUserMessages,
                        ];
                        ui.setStatus("Waiting for model response...");
                        continue;
                    }

                    ui.clearBusy();
                    if (shouldRefreshHistory) {
                        ui.refreshHistory();
                    }

                    lastTurnElapsedMs = Date.now() - turnStartedAt;
                    lastTurnUsage = snapshotTurnUsage(turnUsage);

                    break;
                }
            } catch (error) {
                const message = formatProviderErrorMessage(error);
                if (shouldRenderProviderWarning(error)) ui.writeWarning(message);
                else ui.write(message);
                ui.clearBusy();
                lastTurnElapsedMs = Date.now() - turnStartedAt;
                lastTurnUsage = snapshotTurnUsage(turnUsage);
                continue;
            } finally {
                ui.clearBusy();
            }
        }
    } catch (err) {
        if ((err as Error).name !== "AbortError" && (err as Error).name !== "UserInterruptError") {
            throw err;
        }
    } finally {
        promptController.stop();
        setOutputWriter(null);
        ui.destroy();
    }
}