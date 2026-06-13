#!/usr/bin/env node
import { Command } from "commander";
import OpenAI from "openai";
import { buildSystemPrompt } from "./constants";
import { getCurrentSessionStatus } from "./helpers/getCurrentSessionStatus";
import {
    getDefaultContextLevel,
    getDefaultModel,
    getDefaultReasoningLevel,
    getReasoningConfig,
    getReasoningLevelsForModel,
    type ContextLevel,
    type ReasoningLevel,
} from "./helpers/models";
import {
    buildSubagentInstructions,
    buildSubagentUserPrompt,
    createSpawnSubagentTool,
    DEFAULT_SUBAGENT_REASONING_LEVEL,
    MAX_SUBAGENT_DEPTH,
    resolveSubagentReasoningLevel,
    SPAWN_SUBAGENT_TOOL_NAME,
    filterLocalToolsForSubagentsMode,
    filterProviderToolsForSubagentsMode,
    type RunSubagentParams,
} from "./helpers/subagents";
import { getPreferredDefaultModel, getPreferredDefaultReasoningLevel } from "./helpers/modelDefaults";
import { handleSlashCommands } from "./helpers/handleSlashCommands";
import { loadProjectContextFiles, loadSelfManifest } from "./helpers/projectContext";
import {
    buildInstructionsWithActiveSkill,
    describeSkillForUi,
    findSkill,
    formatSkillsList,
    loadSkillDefinitions,
    type SkillDefinition,
} from "./helpers/skills";
import { normalizeCliArgv } from "./helpers/cliArgs";
import { getPackageVersion } from "./helpers/packageInfo";
import { formatLegacySessionMigrationMessage, migrateLegacyDevSessions } from "./helpers/legacyStateMigration";
import { withBusyIndicator } from "./helpers/busyIndicator";
import { getSlashCommandName, isSlashCommandInput } from "./helpers/commands";
import { getApiKeyResponse } from "./helpers/apiKeyResponse";
import { createFunctionCallTraceManager } from "./helpers/functionCallTraceManager";
import {
    createProviderNativeTraceManager as createExtractedProviderNativeTraceManager,
    isFunctionCallItem as isExtractedFunctionCallItem,
    isReasoningItem as isExtractedReasoningItem,
} from "./helpers/providerNativeTraceManager";
import { executeLocalToolCall } from "./helpers/localToolExecution";
import { createPersistentPromptController } from "./helpers/persistentPromptController";
import { createAssistantTextStreamer, createThinkingTraceStreamer } from "./helpers/streamingText";
import { createMcpTools, McpManager } from "./helpers/mcp";
import { getCodexResponse, type ParsedCodexResponse } from "./helpers/getCodexResponse";
import { formatSessionPath, resolveSessionPath, SessionManager } from "./helpers/sessionManager";
import {
    applySessionState,
    buildPromptSessionDetails,
    chooseSessionPath,
    createSessionManagerFromOptions,
    describeSession,
    getContextUsageSnapshot,
    getStateSnapshot,
    replaySessionTranscript,
    replaceHistory,
} from "./helpers/sessionRuntime";
import { hasFunctionCallItems, shouldPersistAssistantResponseText, shouldRetainAssistantOutput } from "./helpers/assistantOutput";
import { playResponseDoneSound } from "./helpers/responseDoneSound";
import { buildStartupCard, getStartupAnsiImagePath, getStartupAnsiImageSize, getStartupImagePath } from "./helpers/startupImage";
import {
    buildCompactionSummary,
    buildHistorySummaryPrompt,
    buildTurnPrefixSummaryPrompt,
    getCompactionThreshold,
    prepareCompaction,
    SUMMARIZATION_SYSTEM_PROMPT,
    type CompactionResult,
} from "./helpers/compaction";
import { extractThinkingTraces, formatThinkingTrace } from "./helpers/reasoning";
import {
    formatCompactCount,
    formatProviderErrorMessage,
    isAbortError,
    shouldRenderProviderWarning,
    throwIfAborted,
    type RateLimitSnapshot,
} from "./helpers/runtimeFormatting";
import {
    addResponseUsage,
    createEmptyTurnUsageSnapshot,
    snapshotTurnUsage,
    type TurnUsageSnapshot,
} from "./helpers/turnUsage";
import { setOutputWriter } from "./ui/output";
import { TerminalUi } from "./ui/terminal-ui";
import { runCommandTool } from "./tools/runCommand";
import { readTool } from "./tools/readFile";
import { writeTool } from "./tools/writeFile";
import { editTool } from "./tools/editFile";
import {
    buildInstructionsForPlanMode,
    buildPlanModeExecutionPrompt,
    createPlanModeInteractionTools,
    filterLocalToolsForPlanMode,
    filterProviderToolsForPlanMode,
    isPlanApprovalInput,
    isPlanCompleteSelection,
    PLAN_COMPLETE_TOOL_NAME,
} from "./helpers/planMode";
import {
    type PermissionEvaluation,
    type PermissionMode,
} from "./helpers/permissions";
import type { Response, ResponseCreateParamsNonStreaming, ResponseInputItem } from "openai/resources/responses/responses";
import type { SubagentTraceDetails } from "./tools/traceDetails";
import type { Tool } from "./tools/types";
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
    contextFiles?: boolean;
};

const program = new Command();

program
    .name("perry")
    .description("A CLI coding agent")
    .version(getPackageVersion())
    .option("-c, --continue", "Continue the most recent session for this directory")
    .option("-r, --resume", "Choose a previous session to resume")
    .option("--session <session>", "Resume a specific session file or session id prefix")
    .option("--session-dir <dir>", "Directory for session storage and lookup")
    .option("--no-context-files", "Disable AGENTS.md and CLAUDE.md discovery; -nc is accepted as shorthand")
    .option("--no-session", "Do not save this conversation")
    .action(async (options: CliOptions) => {
        await main(options);
    });

program.parse(normalizeCliArgv(process.argv));

export interface State {
    activeProvider: "openai-api-key" | "openai-codex" | null,
    client: OpenAI | null,
    currentModel: string,
    reasoningLevel: ReasoningLevel,
    subagentReasoningLevel: ReasoningLevel,
    contextLevel: ContextLevel,
    permissionMode: PermissionMode,
    planMode: boolean,
    pendingPlanExecution: boolean,
    subagentsMode: boolean,
    activeSkill: SkillDefinition | null,
}

async function runCompactionSummaryRequest(state: State, promptText: string, signal?: AbortSignal): Promise<string> {
    if (state.activeProvider === "openai-api-key") {
        if (!state.client) {
            throw new Error("OpenAI API key client is not available. Run /login again.");
        }

        const response = await state.client.responses.create({
            model: state.currentModel,
            instructions: SUMMARIZATION_SYSTEM_PROMPT,
            input: [{
                role: "user",
                content: [{
                    type: "input_text",
                    text: promptText,
                }],
            }],
            reasoning: getReasoningConfig(state.reasoningLevel),
            text: { verbosity: "medium" },
            store: false,
        }, { signal });

        const summary = response.output_text.trim();
        if (!summary) {
            throw new Error("Compaction summarization returned no text.");
        }
        return summary;
    }

    if (state.activeProvider === "openai-codex") {
        const response = await getCodexResponse({
            instructions: SUMMARIZATION_SYSTEM_PROMPT,
            input: [{ role: "user", content: promptText }],
            model: state.currentModel,
            reasoningLevel: state.reasoningLevel,
            contextLevel: "disabled",
            tools: [],
            signal,
        });

        const summary = response.output_text.trim();
        if (!summary) {
            throw new Error("Compaction summarization returned no text.");
        }
        return summary;
    }

    throw new Error("Not logged in. Type /login to continue.");
}

async function compactSessionContext(
    state: State,
    sessionManager: SessionManager,
    customInstructions?: string,
    signal?: AbortSignal,
): Promise<CompactionResult> {
    const entries = sessionManager.getEntries();
    const preparation = prepareCompaction(entries);

    if (!preparation) {
        if (entries[entries.length - 1]?.type === "compaction") {
            throw new Error("Already compacted.");
        }
        throw new Error("Nothing to compact (session too small).");
    }

    const historySummaryPromise = preparation.messagesToSummarize.length > 0
        ? runCompactionSummaryRequest(
            state,
            buildHistorySummaryPrompt(
                preparation.messagesToSummarize,
                preparation.previousSummary,
                customInstructions,
            ),
            signal,
        )
        : Promise.resolve(preparation.previousSummary ?? "No prior history.");

    const turnPrefixSummaryPromise = preparation.isSplitTurn && preparation.turnPrefixMessages.length > 0
        ? runCompactionSummaryRequest(state, buildTurnPrefixSummaryPrompt(preparation.turnPrefixMessages), signal)
        : Promise.resolve<string | undefined>(undefined);

    const [historySummary, turnPrefixSummary] = await Promise.all([
        historySummaryPromise,
        turnPrefixSummaryPromise,
    ]);

    const result = buildCompactionSummary(preparation, historySummary, turnPrefixSummary);
    sessionManager.appendCompaction(result);
    return result;
}

async function maybeAutoCompactSessionContext(
    state: State,
    sessionManager: SessionManager,
    systemContext: ChatMessage,
    openaiTools: any[],
    pendingUserText: string,
    ui: InteractiveUi,
    signal?: AbortSignal,
): Promise<boolean> {
    const threshold = getCompactionThreshold(state.currentModel, state.contextLevel, state.activeProvider);
    if (threshold === null) {
        return false;
    }

    const entries = sessionManager.getEntries();
    if (entries[entries.length - 1]?.type === "compaction") {
        return false;
    }

    const candidateContext = [...sessionManager.buildContextHistory(), { role: "user" as const, content: pendingUserText }];
    return withBusyIndicator(ui, "Checking context", async (indicator) => {
        const usage = await getContextUsageSnapshot(state, candidateContext, systemContext, filterProviderToolsForSubagentsMode(filterProviderToolsForPlanMode(openaiTools, state.planMode), state.subagentsMode), signal);
        if (usage.usedTokens === null || usage.usedTokens < threshold) {
            return false;
        }

        ui.write(`Context is getting large (${formatCompactCount(usage.usedTokens)} tokens). Compacting earlier conversation before continuing.`);
        indicator.setMessage("Compacting context");
        await compactSessionContext(state, sessionManager, undefined, signal);
        ui.write("Session context compacted.");
        return true;
    });
}

async function runSubagentLoop(params: {
    state: State;
    baseInstructions: string;
    task: RunSubagentParams;
    tools: Array<Tool<any, any>>;
    providerTools: any[];
    ui: InteractiveUi;
    promptForPermission: (evaluation: PermissionEvaluation) => Promise<boolean>;
    signal?: AbortSignal;
}): Promise<{ output: string; turnsUsed: number; details: SubagentTraceDetails }> {
    const { state, task, ui } = params;
    if (task.depth > MAX_SUBAGENT_DEPTH) {
        throw new Error(`Subagent nesting limit reached (${MAX_SUBAGENT_DEPTH}).`);
    }
    if (!state.activeProvider) {
        throw new Error("Cannot spawn a subagent while logged out.");
    }
    if (state.activeProvider === "openai-api-key" && !state.client) {
        throw new Error("OpenAI API key client is not available for subagents.");
    }

    const reasoningLevel = resolveSubagentReasoningLevel(
        getReasoningLevelsForModel(state.activeProvider, state.currentModel),
        state.subagentReasoningLevel,
    );
    const subagentInstructions = buildSubagentInstructions(params.baseInstructions, {
        depth: task.depth,
        permissionMode: state.permissionMode,
        planMode: state.planMode,
        subagentsMode: state.subagentsMode,
        reasoningLevel,
    });
    const systemMessage: ChatMessage = {
        role: "developer",
        content: buildInstructionsForPlanMode(subagentInstructions, state.planMode),
    };
    const initialUserMessage: ChatMessage = {
        role: "user",
        content: buildSubagentUserPrompt(task),
    };
    const providerTools = filterProviderToolsForSubagentsMode(filterProviderToolsForPlanMode(params.providerTools, state.planMode), state.subagentsMode).filter((tool) => {
        if (task.depth < MAX_SUBAGENT_DEPTH) return true;
        return !(tool && typeof tool === "object" && "type" in tool && (tool as { type?: unknown }).type === "function" && "name" in tool && (tool as { name?: unknown }).name === SPAWN_SUBAGENT_TOOL_NAME);
    });
    const baseLocalTools = params.tools.filter((tool) => tool.name !== SPAWN_SUBAGENT_TOOL_NAME);
    const nestedSubagentTool = task.depth < MAX_SUBAGENT_DEPTH
        ? createSpawnSubagentTool({
            depth: task.depth,
            run: async (childTask, options) => {
                const initialDetails = {
                    type: "subagent" as const,
                    task: childTask.task,
                    context: childTask.context,
                    maxTurns: childTask.maxTurns,
                    turnsUsed: 0,
                    depth: childTask.depth,
                    permissionMode: state.permissionMode,
                    planMode: state.planMode,
                    reasoningLevel: state.subagentReasoningLevel,
                    note: "Starting nested subagent...",
                };
                options?.onUpdate?.({ output: "Starting nested subagent...", details: initialDetails });
                const childResult = await runSubagentLoop({
                    ...params,
                    task: childTask,
                    tools: params.tools,
                    signal: options?.signal,
                });
                options?.onUpdate?.({ output: childResult.output, details: childResult.details });
                return { output: childResult.output, modelOutput: childResult.output, details: childResult.details };
            },
        })
        : null;
    const localTools = filterLocalToolsForSubagentsMode(filterLocalToolsForPlanMode(
        [...baseLocalTools, ...(nestedSubagentTool ? [nestedSubagentTool] : [])],
        state.planMode,
    ), state.subagentsMode);
    const conversation: any[] = [systemMessage, initialUserMessage];
    const codexConversation: any[] = [initialUserMessage];
    let finalOutput = "";
    let turnsUsed = 0;

    while (turnsUsed < task.maxTurns) {
        throwIfAborted(params.signal);
        turnsUsed += 1;
        ui.setStatus(`Running subagent (${turnsUsed}/${task.maxTurns})`);

        let aiResponse: Response | ParsedCodexResponse;
        if (state.activeProvider === "openai-api-key") {
            const streamed = await getApiKeyResponse(
                state.client as OpenAI,
                conversation,
                providerTools,
                state.currentModel,
                reasoningLevel,
                state.contextLevel,
                ui,
                { streamOutput: false, signal: params.signal },
            );
            aiResponse = streamed.response;
        } else {
            aiResponse = await getCodexResponse({
                input: codexConversation,
                model: state.currentModel,
                reasoningLevel,
                contextLevel: state.contextLevel,
                tools: providerTools,
                instructions: systemMessage.content,
                signal: params.signal,
            });
        }

        const responseText = aiResponse.output_text.trim();
        if (responseText) finalOutput = responseText;
        const toolCalls = aiResponse.output.filter(isExtractedFunctionCallItem);
        const assistantContextItems = aiResponse.output.filter((item) => !isExtractedReasoningItem(item));

        if (toolCalls.length === 0) {
            const output = finalOutput || "Subagent completed without a text report.";
            return {
                output,
                turnsUsed,
                details: {
                    type: "subagent",
                    task: task.task,
                    context: task.context,
                    maxTurns: task.maxTurns,
                    turnsUsed,
                    depth: task.depth,
                    permissionMode: state.permissionMode,
                    planMode: state.planMode,
                    reasoningLevel,
                    output,
                    note: "Subagent completed.",
                },
            };
        }

        const toolOutputs: Array<{ type: "function_call_output"; call_id: string; output: ResponseInputItem.FunctionCallOutput["output"] }> = [];
        for (const toolCall of toolCalls) {
            const toolResult = await executeLocalToolCall(toolCall, localTools, ui, {
                planMode: state.planMode,
                permissionMode: state.permissionMode,
                promptForPermission: params.promptForPermission,
                signal: params.signal,
            });
            toolOutputs.push({
                type: "function_call_output",
                call_id: toolCall.call_id,
                output: toolResult.modelOutput ?? toolResult.output,
            });
        }

        conversation.push(...assistantContextItems, ...toolOutputs);
        codexConversation.push(...assistantContextItems, ...toolOutputs);
    }

    const output = finalOutput || `Subagent stopped after reaching the ${task.maxTurns}-turn limit without a final text report.`;
    return {
        output,
        turnsUsed,
        details: {
            type: "subagent",
            task: task.task,
            context: task.context,
            maxTurns: task.maxTurns,
            turnsUsed,
            depth: task.depth,
            permissionMode: state.permissionMode,
            planMode: state.planMode,
            reasoningLevel,
            output,
            note: "Subagent turn limit reached.",
        },
    };
}

async function main(options: CliOptions = {}) {
    const ui = await TerminalUi.create();
    const handleUserInterrupt = () => {
        setOutputWriter(null);
        ui.destroy();
        process.exit(130);
    };
    setOutputWriter((message) => {
        if (message === "Checking session status...") return;
        ui.write(message);
    });

    const history: ChatMessage[] = [];
    const legacySessionMigration = migrateLegacyDevSessions();
    const selfManifest = loadSelfManifest();
    const projectContextFiles = options.contextFiles === false ? [] : loadProjectContextFiles({ cwd: process.cwd() });
    let skills = loadSkillDefinitions({ cwd: process.cwd() });
    const buildBaseSystemContext = (): ChatMessage => ({
        role: "developer",
        content: buildSystemPrompt({
            selfManifest,
            contextFiles: projectContextFiles,
            skills,
            cwd: process.cwd(),
        }),
    });
    let systemContext: ChatMessage = buildBaseSystemContext();
    let promptController: ReturnType<typeof createPersistentPromptController>;
    let activeTurnAbortController: AbortController | null = null;
    const requestStopActiveTurn = (): void => {
        if (activeTurnAbortController && !activeTurnAbortController.signal.aborted) {
            activeTurnAbortController.abort();
            ui.setStatus("Stopping...");
        }
        ui.cancelActiveInput();
    };
    const unsubscribeEscape = ui.onEscape?.(requestStopActiveTurn);
    const planModeInteractionTools = createPlanModeInteractionTools({
        choose: async (prompt, options, initialValue) => {
            await promptController.pause();
            try {
                playResponseDoneSound();
                return await ui.choose(prompt, options, initialValue);
            } finally {
                promptController.resume();
            }
        },
        ask: async (prompt) => {
            await promptController.pause();
            try {
                playResponseDoneSound();
                return await ui.ask(prompt, { placeholder: "Write what you want" });
            } finally {
                promptController.resume();
            }
        },
    });
    const mcpManager = new McpManager(process.cwd());
    await withBusyIndicator(ui, "Loading MCP servers", () => mcpManager.load().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        ui.writeWarning(`MCP startup failed: ${message}`);
    }));
    let mcpTools = createMcpTools(mcpManager);
    let spawnSubagentTool: Tool<any, any> | null = null;
    let localTools: Array<Tool<any, any>> = [];
    let openaiTools: any[] = [];
    const rebuildToolLists = (): void => {
        localTools = [
            readTool,
            writeTool,
            editTool,
            runCommandTool,
            ...planModeInteractionTools,
            ...(spawnSubagentTool ? [spawnSubagentTool] : []),
            ...mcpTools,
        ];
        openaiTools = [
            ...localTools.map((tool) => tool.definition),
            { type: "web_search" },
        ];
    };
    rebuildToolLists();
    const refreshMcpTools = async (): Promise<void> => {
        await withBusyIndicator(ui, "Reloading MCP servers", () => mcpManager.load());
        mcpTools = createMcpTools(mcpManager);
        rebuildToolLists();
        if (mcpManager.errors.length > 0) {
            ui.writeWarning(`MCP config warning: ${mcpManager.errors.length} config file${mcpManager.errors.length === 1 ? "" : "s"} could not be loaded. Run /mcp doctor for details.`);
        }
    };
    const refreshSkills = async (): Promise<void> => {
        skills = await withBusyIndicator(ui, "Reloading skills", async () => loadSkillDefinitions({ cwd: process.cwd() }));
        systemContext = buildBaseSystemContext();
    };

    let state: State = {
        activeProvider: null,
        client: null,
        currentModel: getDefaultModel(null),
        reasoningLevel: getDefaultReasoningLevel(),
        subagentReasoningLevel: DEFAULT_SUBAGENT_REASONING_LEVEL,
        contextLevel: getDefaultContextLevel(),
        permissionMode: "ask",
        planMode: false,
        pendingPlanExecution: false,
        subagentsMode: false,
        activeSkill: null,
    };
    let lastTurnElapsedMs: number | null = null;
    let lastTurnUsage: TurnUsageSnapshot | null = null;
    let lastRateLimit: RateLimitSnapshot | null = null;

    await withBusyIndicator(ui, "Checking session status", () => getCurrentSessionStatus(state));

    let sessionManager = await createSessionManagerFromOptions(options, process.cwd(), ui);
    const legacySessionMigrationMessage = formatLegacySessionMigrationMessage(legacySessionMigration);
    if (legacySessionMigrationMessage) ui.writeWarning(legacySessionMigrationMessage);
    const unsubscribeToolTracePersistence = ui.onToolTraceFinished?.((trace) => {
        if (sessionManager.isPersisted()) sessionManager.appendToolTrace({
            ...trace,
            details: trace.details as any,
        });
    });
    replaceHistory(history, sessionManager.buildHistory());
    applySessionState(sessionManager, state, ui);
    sessionManager.appendState(getStateSnapshot(state));
    const startupAnsiImageSize = getStartupAnsiImageSize();
    ui.writeStartupCard(buildStartupCard({
        sessionId: sessionManager.getSessionId(),
        persisted: sessionManager.isPersisted(),
        sessionDir: sessionManager.isPersisted() ? sessionManager.getSessionDir() : undefined,
        cwd: process.cwd(),
        messageCount: history.length,
        provider: state.activeProvider,
        model: state.currentModel,
        reasoningLevel: state.reasoningLevel,
        subagentReasoningLevel: state.subagentReasoningLevel,
        contextLevel: state.contextLevel,
        permissionMode: state.permissionMode,
        planMode: state.planMode,
        skillCount: skills.length,
        activeSkillName: state.activeSkill?.name,
        subagentsMode: state.subagentsMode,
        imagePath: getStartupImagePath(),
        ansiImagePath: getStartupAnsiImagePath(),
        ansiImageMaxWidth: startupAnsiImageSize.width,
        ansiImageMaxHeight: startupAnsiImageSize.height,
        contextFiles: projectContextFiles,
    }));
    if (history.length > 0 || options.resume || options.continue || typeof options.session === "string") {
        replaySessionTranscript(ui, sessionManager);
    }

    ui.setReasoningLevel(state.reasoningLevel);

    let lastPromptSessionDetails: SessionDetailLine[] = [];
    const refreshPromptSessionDetails = async () => {
        lastPromptSessionDetails = await withBusyIndicator(ui, "Updating session details", () => buildPromptSessionDetails(
            state,
            history,
            systemContext,
            openaiTools,
            lastTurnUsage,
            lastTurnElapsedMs,
            lastRateLimit,
            sessionManager,
        ));
        ui.setSessionDetails(lastPromptSessionDetails);
    };
    const updateReasoningInPromptDetails = () => {
        if (lastPromptSessionDetails.length === 0) return;
        const lastIndex = lastPromptSessionDetails.length - 1;
        lastPromptSessionDetails = lastPromptSessionDetails.map((line, index) => index === lastIndex
            ? { ...line, right: `${state.currentModel} · ${state.reasoningLevel} · sub:${state.subagentReasoningLevel}${state.subagentsMode ? ":on" : ":off"} · ${state.permissionMode}${state.planMode ? " · plan" : ""}${state.activeSkill ? ` · skill:${state.activeSkill.name}` : ""}` }
            : line);
        ui.setSessionDetails(lastPromptSessionDetails);
    };
    const cycleReasoningLevel = (): string => {
        const levels = getReasoningLevelsForModel(state.activeProvider, state.currentModel);
        const currentIndex = levels.indexOf(state.reasoningLevel);
        const nextLevel = levels[(currentIndex + 1) % levels.length] ?? state.reasoningLevel;
        if (nextLevel !== state.reasoningLevel) {
            state.reasoningLevel = nextLevel;
            sessionManager.appendState(getStateSnapshot(state));
        }
        ui.setReasoningLevel(state.reasoningLevel);
        updateReasoningInPromptDetails();
        void refreshPromptSessionDetails().catch(() => undefined);
        return state.reasoningLevel;
    };
    promptController = createPersistentPromptController(ui, handleUserInterrupt, {
        getHistory: () => history.filter((message) => message.role === "user").map((message) => message.content),
        onCycleReasoningLevel: cycleReasoningLevel,
    });

    const promptForPermissionApproval = async (evaluation: PermissionEvaluation): Promise<boolean> => {
        await promptController.pause();
        try {
            playResponseDoneSound();
            const choice = await ui.choose("Permission required", [
                {
                    label: "Allow once",
                    value: "allow_once" as const,
                    description: `${evaluation.summary} · ${evaluation.reason}`,
                },
                {
                    label: "Deny",
                    value: "deny" as const,
                    description: `Do not run this ${evaluation.mode} mode action`,
                },
                {
                    label: "Full access / YOLO mode",
                    value: "full-access" as const,
                    description: "Allow this action and auto-approve future permission prompts for this session",
                }
            ], "deny");
            if (choice === "allow_once") {
                ui.write(`Allowed once: ${evaluation.summary}`);
                return true;
            }
            if (choice === "full-access") {
                state.permissionMode = "full-access";
                sessionManager.appendState(getStateSnapshot(state));
                ui.write(`Full access enabled. Allowed: ${evaluation.summary}`);
                updateReasoningInPromptDetails();
                void refreshPromptSessionDetails().catch(() => undefined);
                return true;
            }
            ui.write(`Denied: ${evaluation.summary}`);
            return false;
        } finally {
            promptController.resume();
        }
    };

    spawnSubagentTool = createSpawnSubagentTool({
        run: async (task, options) => {
            throwIfAborted(options?.signal);
            const initialDetails = {
                type: "subagent" as const,
                task: task.task,
                context: task.context,
                maxTurns: task.maxTurns,
                turnsUsed: 0,
                depth: task.depth,
                permissionMode: state.permissionMode,
                planMode: state.planMode,
                reasoningLevel: state.subagentReasoningLevel,
                note: "Starting subagent...",
            };
            options?.onUpdate?.({ output: "Starting subagent...", details: initialDetails });
            const result = await runSubagentLoop({
                state,
                baseInstructions: buildInstructionsWithActiveSkill(systemContext.content, state.activeSkill),
                task,
                tools: localTools,
                providerTools: openaiTools,
                ui,
                promptForPermission: promptForPermissionApproval,
                signal: options?.signal,
            });
            options?.onUpdate?.({ output: result.output, details: result.details });
            return {
                output: result.output,
                modelOutput: result.output,
                details: result.details,
            };
        },
    });
    rebuildToolLists();

    promptController.start();

    try {
        while (true) {
            ui.setReasoningLevel(state.reasoningLevel);
            ui.setStatus(
                state.activeProvider
                    ? `Provider: ${state.activeProvider} | Model: ${state.currentModel} | Reasoning: ${state.reasoningLevel} | Subagents: ${state.subagentsMode ? "on" : "off"} · ${state.subagentReasoningLevel} | Context: ${state.contextLevel} | Permissions: ${state.permissionMode}${state.planMode ? " | Plan mode" : ""}${state.activeSkill ? ` | Skill: ${state.activeSkill.name}` : ""}`
                    : "Not logged in"
            );
            await refreshPromptSessionDetails();
            ui.clearBusy();
            let answer = await promptController.take();
            let trimmed = answer.trim();

            if (!trimmed) {
                continue;
            }

            ui.writeUser(answer);

            const slashCommandName = getSlashCommandName(answer);
            if (slashCommandName === "/accept") {
                if (!state.pendingPlanExecution) {
                    ui.write(state.planMode
                        ? "No plan is waiting for approval. Ask for a plan first, then use /accept."
                        : "Plan mode is not enabled.");
                    continue;
                }
                state.pendingPlanExecution = false;
                state.planMode = false;
                ui.write("Plan approved. Executing now.");
                answer = buildPlanModeExecutionPrompt();
                trimmed = answer;
                void refreshPromptSessionDetails().catch(() => undefined);
            } else if (state.planMode && isPlanApprovalInput(answer)) {
                if (!state.pendingPlanExecution) {
                    ui.write("No plan is waiting for approval. Ask for a plan first, then use /accept.");
                    continue;
                }
                state.pendingPlanExecution = false;
                state.planMode = false;
                ui.write("Plan approved. Executing now.");
                answer = buildPlanModeExecutionPrompt();
                trimmed = answer;
                void refreshPromptSessionDetails().catch(() => undefined);
            }

            if (isSlashCommandInput(answer)) {
                await promptController.pause();
                try {
                    const [commandName, ...commandArgs] = trimmed.split(/\s+/);

                    if (commandName === "/session") {
                        ui.write(describeSession(sessionManager, history));
                        continue;
                    }

                    if (commandName === "/new") {
                        if (state.activeProvider) {
                            state.currentModel = await getPreferredDefaultModel(state.activeProvider);
                            state.reasoningLevel = await getPreferredDefaultReasoningLevel(state.activeProvider, state.currentModel);
                        }
                        state.permissionMode = "ask";
                        state.subagentReasoningLevel = DEFAULT_SUBAGENT_REASONING_LEVEL;
                        state.planMode = false;
                        state.pendingPlanExecution = false;
                        state.activeSkill = null;
                        sessionManager = sessionManager.isPersisted()
                            ? SessionManager.create(process.cwd(), sessionManager.getSessionDir())
                            : SessionManager.inMemory(process.cwd());
                        replaceHistory(history, []);
                        sessionManager.appendState(getStateSnapshot(state));
                        ui.write(`Started new session ${sessionManager.getSessionId().slice(0, 8)}.`);
                        continue;
                    }

                    if (commandName === "/compact") {
                        try {
                            const commandAbortController = new AbortController();
                            activeTurnAbortController = commandAbortController;
                            const result = await withBusyIndicator(ui, "Compacting context", () => compactSessionContext(state, sessionManager, commandArgs.join(" ").trim() || undefined, commandAbortController.signal));
                            ui.write(`Session compacted. Earlier conversation was replaced with a checkpoint summary (~${formatCompactCount(result.tokensBefore)} tokens before compaction).`);
                        } catch (error) {
                            const message = formatProviderErrorMessage(error);
                            if (isAbortError(error)) ui.writeError(message);
                            else if (shouldRenderProviderWarning(error)) ui.writeWarning(message);
                            else ui.write(message);
                        } finally {
                            activeTurnAbortController = null;
                        }
                        continue;
                    }

                    if (commandName === "/mcp") {
                        const action = commandArgs[0]?.toLowerCase();
                        if (!action || action === "status") {
                            ui.write(mcpManager.describe());
                            continue;
                        }
                        if (action === "list" || action === "tools") {
                            ui.write(mcpManager.describe({ verbose: true }));
                            continue;
                        }
                        if (action === "doctor" || action === "diagnose" || action === "diagnostics") {
                            ui.write(mcpManager.describe({ doctor: true, verbose: true }));
                            continue;
                        }
                        if (["reload", "restart", "refresh"].includes(action)) {
                            try {
                                await refreshMcpTools();
                                ui.write(mcpManager.describe());
                                void refreshPromptSessionDetails().catch(() => undefined);
                            } catch (error) {
                                const message = error instanceof Error ? error.message : String(error);
                                ui.writeWarning(`MCP reload failed: ${message}`);
                            }
                            continue;
                        }
                        ui.write("Usage: /mcp [status|tools|doctor|reload]");
                        continue;
                    }

                    if (commandName === "/skills") {
                        const action = commandArgs[0]?.toLowerCase();
                        if (["reload", "refresh"].includes(action ?? "")) {
                            await refreshSkills();
                            ui.write(formatSkillsList(skills));
                            void refreshPromptSessionDetails().catch(() => undefined);
                            continue;
                        }
                        if (!action || action === "status" || action === "list") {
                            ui.write(formatSkillsList(skills));
                            continue;
                        }
                        ui.write("Usage: /skills [list|reload]");
                        continue;
                    }

                    if (commandName === "/skill") {
                        const skillArg = commandArgs.join(" ").trim();
                        if (!skillArg || ["list", "status"].includes(skillArg.toLowerCase())) {
                            ui.write(formatSkillsList(skills));
                            continue;
                        }
                        if (["clear", "off", "none", "reset"].includes(skillArg.toLowerCase())) {
                            const previous = state.activeSkill?.name;
                            state.activeSkill = null;
                            ui.write(previous ? `Cleared active skill ${previous}.` : "No active skill was set.");
                            void refreshPromptSessionDetails().catch(() => undefined);
                            continue;
                        }
                        if (["reload", "refresh"].includes(skillArg.toLowerCase())) {
                            await refreshSkills();
                            ui.write(formatSkillsList(skills));
                            void refreshPromptSessionDetails().catch(() => undefined);
                            continue;
                        }
                        const skill = findSkill(skills, skillArg);
                        if (!skill) {
                            ui.write(`Skill not found: ${skillArg}\n\n${formatSkillsList(skills)}`);
                            continue;
                        }
                        state.activeSkill = skill;
                        ui.write(`Skill active for next request: ${describeSkillForUi(skill)}.`);
                        void refreshPromptSessionDetails().catch(() => undefined);
                        continue;
                    }

                    if (commandName === "/continue") {
                        sessionManager = sessionManager.isPersisted()
                            ? SessionManager.continueRecent(process.cwd(), sessionManager.getSessionDir())
                            : SessionManager.continueRecent(process.cwd());
                        replaceHistory(history, sessionManager.buildHistory());
                        applySessionState(sessionManager, state, ui);
                        sessionManager.appendState(getStateSnapshot(state));
                        replaySessionTranscript(ui, sessionManager);
                        continue;
                    }

                    if (commandName === "/resume") {
                        let selectedPath: string | null = null;
                        const reference = commandArgs[0];
                        const sessionDir = sessionManager.isPersisted() ? sessionManager.getSessionDir() : undefined;
                        if (reference) {
                            const resolved = await withBusyIndicator(ui, "Resolving session", () => resolveSessionPath(reference, process.cwd(), sessionDir));
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
                        replaySessionTranscript(ui, sessionManager);
                        continue;
                    }

                    const beforeState = JSON.stringify(getStateSnapshot(state));
                    const shouldContinue = await handleSlashCommands({ command: trimmed, state, ui });
                    if (JSON.stringify(getStateSnapshot(state)) !== beforeState) {
                        sessionManager.appendState(getStateSnapshot(state));
                    }
                    void refreshPromptSessionDetails().catch(() => undefined);
                    if (shouldContinue === false) {
                        break;
                    }
                } catch (error) {
                    if (isAbortError(error)) {
                        ui.write("Cancelled.");
                        continue;
                    }
                    throw error;
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

            let activeTools = filterProviderToolsForSubagentsMode(filterProviderToolsForPlanMode(openaiTools, state.planMode), state.subagentsMode);
            let activeLocalTools = filterLocalToolsForSubagentsMode(filterLocalToolsForPlanMode(localTools, state.planMode), state.subagentsMode);
            let planModeForTurn = state.planMode;
            const activeSkillForTurn = state.activeSkill;
            const buildSystemContextForTurn = (planMode: boolean): ChatMessage => {
                const withSkill = buildInstructionsWithActiveSkill(systemContext.content, activeSkillForTurn);
                return {
                    ...systemContext,
                    content: buildInstructionsForPlanMode(withSkill, planMode),
                };
            };
            let systemContextForTurn: ChatMessage = buildSystemContextForTurn(planModeForTurn);
            const clearActiveSkillForTurn = () => {
                if (activeSkillForTurn && state.activeSkill?.name === activeSkillForTurn.name) {
                    state.activeSkill = null;
                    void refreshPromptSessionDetails().catch(() => undefined);
                }
            };
            const turnAbortController = new AbortController();
            activeTurnAbortController = turnAbortController;
            const turnSignal = turnAbortController.signal;

            try {
                if (!planModeForTurn) {
                    await maybeAutoCompactSessionContext(state, sessionManager, systemContextForTurn, openaiTools, answer, ui, turnSignal);
                }
            } catch (error) {
                if (isAbortError(error)) {
                    ui.writeError("Process terminated.");
                    activeTurnAbortController = null;
                    activeSkillForTurn && clearActiveSkillForTurn();
                    continue;
                }
                const message = error instanceof Error ? `Auto-compaction failed. ${error.message}` : `Auto-compaction failed. ${String(error)}`;
                ui.write(message);
            }

            const userMessage: ChatMessage = {
                role: "user",
                content: answer,
            };
            history.push(userMessage);
            sessionManager.appendMessage(userMessage);

            const contextHistory = sessionManager.buildContextHistory();
            let agentInput: any[] = [
                systemContextForTurn,
                ...contextHistory,
            ];
            let codexInput: any[] = [
                ...contextHistory,
            ];
            const turnStartedAt = Date.now();
            const turnUsage = createEmptyTurnUsageSnapshot();
            const drainQueuedUserMessages = (): ChatMessage[] => {
                const queuedInputs = promptController.drain();
                if (queuedInputs.length === 0) return [];
                const slashCommands = queuedInputs.filter((input) => isSlashCommandInput(input));
                const userMessages = queuedInputs.filter((input) => !isSlashCommandInput(input));
                if (slashCommands.length > 0) promptController.pushFront(slashCommands);
                return userMessages.map((input) => ({ role: "user" as const, content: input }));
            };

            ui.setBusy(planModeForTurn ? "Planning" : "Working");
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
                            activeTools,
                            state.currentModel,
                            state.reasoningLevel,
                            state.contextLevel,
                            ui,
                            { signal: turnSignal }
                        );
                        aiResponse = streamedResponse.response;
                        streamedThinking = streamedResponse.streamedThinking;
                        streamedOutputText = streamedResponse.streamedOutputText;
                        lastRateLimit = streamedResponse.rateLimit ?? lastRateLimit;
                    } else if (state.activeProvider === "openai-codex") {
                        const thinking = createThinkingTraceStreamer(ui);
                        const outputText = createAssistantTextStreamer(ui);
                        const functionCallTraces = createFunctionCallTraceManager(ui);
                        const providerTraces = createExtractedProviderNativeTraceManager(ui);
                        let retainAssistantStream = true;
                        try {
                            aiResponse = await getCodexResponse({
                                input: codexInput,
                                model: state.currentModel,
                                reasoningLevel: state.reasoningLevel,
                                contextLevel: state.contextLevel,
                                tools: activeTools,
                                instructions: systemContextForTurn.content,
                                signal: turnSignal,
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
                            retainAssistantStream = shouldRetainAssistantOutput(aiResponse.output);
                            streamedThinking = thinking.hasStreamedThinking;
                            streamedOutputText = outputText.hasStreamedText;
                        } finally {
                            thinking.finishAll();
                            outputText.finishAll(retainAssistantStream);
                        }
                    } else {
                        throw new Error("No active provider.");
                    }

                    addResponseUsage(turnUsage, aiResponse.usage);

                    const responseText = aiResponse.output_text;
                    const thinkingTraces = extractThinkingTraces(aiResponse.output);
                    const toolCalls = aiResponse.output.filter(isExtractedFunctionCallItem);
                    const hasToolCalls = hasFunctionCallItems(aiResponse.output);
                    const assistantContextItems = aiResponse.output.filter((item) => !isExtractedReasoningItem(item));
                    let wroteFallbackThinking = false;
                    const wroteFallbackResponseText = Boolean(responseText) && !streamedOutputText && !hasToolCalls;

                    if (!streamedThinking) {
                        for (const trace of thinkingTraces) {
                            ui.writeThinking(formatThinkingTrace(trace));
                            wroteFallbackThinking = true;
                        }
                    }

                    const shouldRefreshHistory = streamedOutputText || streamedThinking || wroteFallbackThinking || wroteFallbackResponseText;

                    if (responseText && !streamedOutputText && !hasToolCalls) {
                        ui.writeAssistant(responseText);
                    }

                    if (toolCalls.length > 0) {
                        if (shouldRefreshHistory) {
                            ui.refreshHistory();
                        }

                        if (shouldPersistAssistantResponseText(responseText, aiResponse.output)) {
                            const assistantMessage: ChatMessage = {
                                role: "assistant",
                                content: responseText,
                            };
                            history.push(assistantMessage);
                            sessionManager.appendMessage(assistantMessage);
                        }

                        const toolOutputs: Array<{ type: "function_call_output"; call_id: string; output: ResponseInputItem.FunctionCallOutput["output"] }> = [];
                        let planCompletion: unknown = null;

                        for (const toolCall of toolCalls) {
                            ui.setStatus(`Running tool: ${toolCall.name}`);
                            throwIfAborted(turnSignal);
                            const toolResult = await executeLocalToolCall(toolCall, activeLocalTools, ui, {
                                planMode: planModeForTurn,
                                permissionMode: state.permissionMode,
                                promptForPermission: promptForPermissionApproval,
                                signal: turnSignal,
                            });
                            throwIfAborted(turnSignal);
                            toolOutputs.push({
                                type: "function_call_output",
                                call_id: toolCall.call_id,
                                output: toolResult.modelOutput ?? toolResult.output,
                            });
                            if (toolCall.name === PLAN_COMPLETE_TOOL_NAME && isPlanCompleteSelection(toolResult.details)) {
                                planCompletion = toolResult.details;
                            }
                        }

                        if (planModeForTurn && isPlanCompleteSelection(planCompletion)) {
                            state.pendingPlanExecution = false;

                            if (planCompletion.action === "start_work") {
                                state.planMode = false;
                                sessionManager.appendState(getStateSnapshot(state));
                                ui.write("Plan approved. Starting work now.");
                                void refreshPromptSessionDetails().catch(() => undefined);

                                const executionMessage: ChatMessage = {
                                    role: "user",
                                    content: buildPlanModeExecutionPrompt(planCompletion.plan),
                                };
                                history.push(executionMessage);
                                sessionManager.appendMessage(executionMessage);

                                const executionContextHistory = sessionManager.buildContextHistory();
                                activeTools = filterProviderToolsForSubagentsMode(filterProviderToolsForPlanMode(openaiTools, false), state.subagentsMode);
                                activeLocalTools = filterLocalToolsForSubagentsMode(filterLocalToolsForPlanMode(localTools, false), state.subagentsMode);
                                systemContextForTurn = buildSystemContextForTurn(false);
                                agentInput = [systemContextForTurn, ...executionContextHistory];
                                codexInput = [...executionContextHistory];
                                planModeForTurn = false;
                                ui.setBusy("Working");
                                ui.setStatus("Waiting for model response...");
                                continue;
                            }

                            if (planCompletion.action === "cancel") {
                                ui.write("Plan cancelled. Plan mode remains enabled.");
                                ui.clearBusy();
                                lastTurnElapsedMs = Date.now() - turnStartedAt;
                                lastTurnUsage = snapshotTurnUsage(turnUsage);
                                playResponseDoneSound();
                                clearActiveSkillForTurn();
                                break;
                            }
                        }

                        const queuedUserMessages = drainQueuedUserMessages();
                        if (queuedUserMessages.length > 0 && planModeForTurn) {
                            state.pendingPlanExecution = false;
                        }
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

                        ui.setBusy(planModeForTurn ? "Planning" : "Working");
                        ui.setStatus("Waiting for model response...");
                        continue;
                    }

                    if (shouldPersistAssistantResponseText(responseText, aiResponse.output)) {
                        const assistantMessage: ChatMessage = {
                            role: "assistant",
                            content: responseText,
                        };
                        history.push(assistantMessage);
                        sessionManager.appendMessage(assistantMessage);
                    }

                    const queuedUserMessages = drainQueuedUserMessages();
                    if (queuedUserMessages.length > 0) {
                        if (planModeForTurn) {
                            state.pendingPlanExecution = false;
                        }
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
                        ui.setBusy(planModeForTurn ? "Planning" : "Working");
                        ui.setStatus("Waiting for model response...");
                        continue;
                    }

                    ui.clearBusy();

                    lastTurnElapsedMs = Date.now() - turnStartedAt;
                    lastTurnUsage = snapshotTurnUsage(turnUsage);
                    if (planModeForTurn) {
                        state.pendingPlanExecution = true;
                    }
                    playResponseDoneSound();
                    clearActiveSkillForTurn();

                    break;
                }
            } catch (error) {
                const message = formatProviderErrorMessage(error);
                if (isAbortError(error)) ui.writeError(message);
                else if (shouldRenderProviderWarning(error)) ui.writeWarning(message);
                else ui.write(message);
                ui.clearBusy();
                lastTurnElapsedMs = Date.now() - turnStartedAt;
                lastTurnUsage = snapshotTurnUsage(turnUsage);
                clearActiveSkillForTurn();
                continue;
            } finally {
                ui.clearBusy();
                if (activeTurnAbortController === turnAbortController) {
                    activeTurnAbortController = null;
                }
            }
        }
    } catch (err) {
        if ((err as Error).name !== "AbortError" && (err as Error).name !== "UserInterruptError") {
            throw err;
        }
    } finally {
        unsubscribeToolTracePersistence?.();
        unsubscribeEscape?.();
        promptController.stop();
        await mcpManager.close();
        setOutputWriter(null);
        ui.destroy();
    }
}