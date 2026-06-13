import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type OpenAI from "openai";
import { estimateContextTokens } from "./compaction";
import { formatContextUsageLine, type ContextUsageSnapshot } from "./contextUsage";
import {
    getContextConfig,
    getModelDisplayMetadata,
    getReasoningConfig,
    type ContextLevel,
    type ReasoningLevel,
} from "./models";
import { filterProviderToolsForPlanMode } from "./planMode";
import { DEFAULT_SUBAGENT_REASONING_LEVEL, filterProviderToolsForSubagentsMode } from "./subagents";
import { withBusyIndicator } from "./busyIndicator";
import { renderSessionTranscript } from "./renderSessionTranscript";
import {
    formatSessionAge,
    formatSessionPath,
    getSessionHomeDirFromSessionDir,
    resolveSessionPath,
    SessionManager,
    type PersistedProvider,
    type PersistedChatMessage,
    type SessionInfo,
    type SessionStateSnapshot,
} from "./sessionManager";
import type { PermissionMode } from "./permissions";
import type { InteractiveUi, SessionDetailLine } from "../ui/types";

export type RuntimeChatMessage = PersistedChatMessage;

export type SessionCliOptions = {
    continue?: boolean;
    resume?: boolean;
    session?: string | false;
    sessionDir?: string;
};

export type SessionRuntimeState = {
    activeProvider: PersistedProvider;
    client: OpenAI | null;
    currentModel: string;
    reasoningLevel: ReasoningLevel;
    subagentReasoningLevel: ReasoningLevel;
    contextLevel: ContextLevel;
    permissionMode: PermissionMode;
    planMode: boolean;
    subagentsMode: boolean;
    activeSkill: { name: string } | null;
};

export function formatRepoPath(cwd: string): string {
    const homeDir = os.homedir();
    return cwd.startsWith(homeDir)
        ? `~${cwd.slice(homeDir.length)}`
        : cwd;
}

export function getGitBranch(cwd: string): string | null {
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

export async function getContextUsageSnapshot(
    state: SessionRuntimeState,
    history: RuntimeChatMessage[],
    systemContext: RuntimeChatMessage,
    openaiTools: any[],
    signal?: AbortSignal,
): Promise<ContextUsageSnapshot> {
    const contextConfig = getContextConfig(state.currentModel, state.contextLevel, state.activeProvider);
    const input = [systemContext, ...history];

    if (state.activeProvider === "openai-api-key" && state.client) {
        try {
            const count = await state.client.responses.inputTokens.count({
                model: state.currentModel,
                input,
                tools: openaiTools,
                reasoning: getReasoningConfig(state.reasoningLevel),
                truncation: contextConfig.truncation,
            }, { signal });

            return {
                usedTokens: count.input_tokens,
                approximate: false,
            };
        } catch {
            return {
                usedTokens: estimateContextTokens(input),
                approximate: true,
            };
        }
    }

    if (state.activeProvider === "openai-codex") {
        return {
            usedTokens: estimateContextTokens(input),
            approximate: true,
        };
    }

    return {
        usedTokens: null,
        approximate: false,
    };
}

export async function buildPromptSessionDetails(
    state: SessionRuntimeState,
    _history: RuntimeChatMessage[],
    systemContext: RuntimeChatMessage,
    openaiTools: any[],
    _lastTurnUsage: unknown | null,
    _lastTurnElapsedMs: number | null,
    _lastRateLimit: unknown | null,
    sessionManager: SessionManager,
): Promise<SessionDetailLine[]> {
    const cwd = process.cwd();
    const repoPath = formatRepoPath(cwd);
    const branch = getGitBranch(cwd);
    const modelMeta = getModelDisplayMetadata(state.currentModel, state.activeProvider);
    const contextHistory = sessionManager.buildContextHistory();
    const contextUsage = await getContextUsageSnapshot(
        state,
        contextHistory,
        systemContext,
        filterProviderToolsForSubagentsMode(filterProviderToolsForPlanMode(openaiTools, state.planMode), state.subagentsMode),
    );

    const repoLine = branch ? `${repoPath} (${branch})` : repoPath;
    const contextLine = formatContextUsageLine(contextUsage, modelMeta.contextWindow);

    return [
        {
            left: repoLine,
        },
        {
            left: contextLine,
            right: `${state.currentModel} · ${state.reasoningLevel} · sub:${state.subagentReasoningLevel}${state.subagentsMode ? ":on" : ":off"} · ${state.permissionMode}${state.planMode ? " · plan" : ""}${state.activeSkill ? ` · skill:${state.activeSkill.name}` : ""}`,
        },
    ];
}

export function getStateSnapshot(state: SessionRuntimeState): SessionStateSnapshot {
    return {
        provider: state.activeProvider,
        model: state.currentModel,
        reasoningLevel: state.reasoningLevel,
        subagentReasoningLevel: state.subagentReasoningLevel,
        contextLevel: state.contextLevel,
        permissionMode: state.permissionMode,
        subagentsMode: state.subagentsMode,
    };
}

export function applySessionState(sessionManager: SessionManager, state: SessionRuntimeState, ui: InteractiveUi): void {
    const snapshot = sessionManager.getLatestState();
    if (!snapshot) return;

    if (snapshot.provider === state.activeProvider) {
        state.currentModel = snapshot.model;
        state.reasoningLevel = snapshot.reasoningLevel;
        state.subagentReasoningLevel = snapshot.subagentReasoningLevel ?? DEFAULT_SUBAGENT_REASONING_LEVEL;
        state.contextLevel = snapshot.contextLevel;
        state.permissionMode = snapshot.permissionMode ?? "ask";
        state.subagentsMode = snapshot.subagentsMode ?? false;
        ui.setReasoningLevel(state.reasoningLevel);
        return;
    }

    if (snapshot.provider && state.activeProvider && snapshot.provider !== state.activeProvider) {
        ui.write(`Session used ${snapshot.provider}; current login is ${state.activeProvider}. Keeping current provider/model settings.`);
    }
}

export function replaceHistory(history: RuntimeChatMessage[], nextHistory: RuntimeChatMessage[]): void {
    history.splice(0, history.length, ...nextHistory);
}

function truncateSessionText(text: string, maxLength: number): string {
    const normalized = text.trim();
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function replaySessionTranscript(ui: InteractiveUi, sessionManager: SessionManager): void {
    renderSessionTranscript(ui, sessionManager.getSessionId(), sessionManager.getEntries());
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

export type ResumeScopeSelection = "current" | "all";

function buildSessionOptions(sessions: SessionInfo[], scope: ResumeScopeSelection): Array<{ label: string; value: string; description: string }> {
    return sessions.map((session) => ({
        label: formatSessionChoiceLabel(session),
        value: session.path,
        description: `${scope} · ${formatSessionChoiceDescription(session, scope)}`,
    }));
}

export async function chooseSessionPath(ui: InteractiveUi, cwd: string, sessionDir?: string): Promise<string | null> {
    const currentSessions = await withBusyIndicator(ui, "Loading sessions", () => SessionManager.list(cwd, sessionDir));
    const currentOptions = buildSessionOptions(currentSessions, "current");

    const showAllValue = "__show_all_sessions__";
    const showAllOption = {
        label: "Show all sessions",
        value: showAllValue,
        description: "Browse sessions from other repositories in this Perry state directory",
    };

    if (currentOptions.length > 0) {
        const selected = await ui.choose("Resume session", [
            ...currentOptions,
            showAllOption,
        ]);
        if (selected !== showAllValue) return selected;
    } else {
        const selected = await ui.choose("Resume session", [
            {
                label: "No sessions for this repository",
                value: "__none__",
                description: "Choose Show all sessions to browse sessions from other repositories",
            },
            showAllOption,
        ], showAllValue);
        if (selected !== showAllValue) return null;
    }

    const sessionHomeDir = getSessionHomeDirFromSessionDir(sessionDir);
    const [allSessions, localSessions] = await withBusyIndicator(ui, "Loading all sessions", () => Promise.all([
        SessionManager.listAll(undefined, sessionHomeDir),
        currentSessions.length > 0 ? Promise.resolve(currentSessions) : SessionManager.list(cwd, sessionDir),
    ]));
    const seen = new Set(localSessions.map((session) => session.path));
    const globalSessions = allSessions.filter((session) => !seen.has(session.path));
    const allOptions = [
        ...buildSessionOptions(localSessions, "current"),
        ...buildSessionOptions(globalSessions, "all"),
    ];

    if (allOptions.length === 0) return null;
    return ui.choose("Resume session from all repositories", allOptions);
}

export async function createSessionManagerFromOptions(options: SessionCliOptions, cwd: string, ui: InteractiveUi): Promise<SessionManager> {
    const sessionDir = options.sessionDir ? path.resolve(options.sessionDir) : undefined;

    if (options.session === false) {
        return SessionManager.inMemory(cwd);
    }

    if (typeof options.session === "string") {
        const resolved = await withBusyIndicator(ui, "Resolving session", () => resolveSessionPath(options.session as string, cwd, sessionDir));
        if (resolved.type === "not_found") {
            ui.write(`No session found matching '${resolved.arg}'. Starting a new session.`);
            return SessionManager.create(cwd, sessionDir);
        }
        if (resolved.type === "global" && resolved.cwd && resolved.cwd !== cwd) {
            ui.write(`Session is from ${formatSessionPath(resolved.cwd)}. Resuming its messages in the current directory.`);
        }
        return SessionManager.open(resolved.path, undefined, cwd);
    }

    if (options.resume) {
        const selectedPath = await chooseSessionPath(ui, cwd, sessionDir);
        if (!selectedPath) {
            ui.write("No saved sessions found. Starting a new session.");
            return SessionManager.create(cwd, sessionDir);
        }
        return SessionManager.open(selectedPath, undefined, cwd);
    }

    if (options.continue) {
        return SessionManager.continueRecent(cwd, sessionDir);
    }

    return SessionManager.create(cwd, sessionDir);
}

export function describeSession(sessionManager: SessionManager, history: RuntimeChatMessage[]): string {
    const file = sessionManager.getSessionFile();
    const compactionCount = sessionManager.getCompactionCount();
    return [
        `Session ${sessionManager.getSessionId()}`,
        `Messages: ${history.filter((message) => message.role === "user" || message.role === "assistant").length}`,
        `Compactions: ${compactionCount}`,
        `Storage: ${sessionManager.isPersisted() ? file ?? "pending first assistant response" : "disabled"}`,
        `Directory: ${sessionManager.isPersisted() ? sessionManager.getSessionDir() : "—"}`,
    ].join("\n");
}
