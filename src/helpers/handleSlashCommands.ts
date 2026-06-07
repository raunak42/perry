import OpenAI from "openai";
import { logout } from "../auth/logout";
import { loginWithApiKey } from "../auth/api-key-auth/loginWithApiKey";
import { loginWithSubscription } from "../auth/subscription-auth/loginWithSubscription";
import { getAuthFile } from "./getAuthFile";
import {
    getPreferredDefaultModel,
    getPreferredDefaultReasoningLevel,
    savePreferredDefaultModelAndReasoning,
} from "./modelDefaults";
import { getSlashCommandName, SLASH_COMMANDS } from "./commands";
import {
    describePermissionMode,
    getPermissionModeDescription,
    normalizePermissionMode,
    type PermissionMode,
} from "./permissions";
import { withBusyIndicator } from "./busyIndicator";
import {
    getAvailableModels,
    getContextLevelDescription,
    getContextLevelsForModel,
    getDefaultContextLevel,
    getDefaultModel,
    getDefaultReasoningLevel,
    getReasoningLevelsForModel,
    type ContextLevel,
    type ReasoningLevel,
} from "./models";
import { DEFAULT_SUBAGENT_REASONING_LEVEL } from "./subagents";
import type { State } from "..";
import type { ChoiceOption, InteractiveUi } from "../ui/types";

interface HandleSlashProps {
    command: string,
    state: State,
    ui: InteractiveUi,
    saveDefaultModel?: typeof savePreferredDefaultModelAndReasoning,
}

function formatThinkingLevels(levels: ReasoningLevel[]): string {
    return levels.join(", ");
}

function normalizeThinkingLevel(value: string): ReasoningLevel | null {
    const normalized = value.trim().toLowerCase();
    if (["off", "minimal", "low", "medium", "high", "xhigh"].includes(normalized)) {
        return normalized as ReasoningLevel;
    }
    return null;
}

async function chooseThinkingLevel(state: State, ui: InteractiveUi, requestedLevel?: string): Promise<void> {
    if (!state.activeProvider) {
        ui.write("Not logged in. Type /login to continue.");
        return;
    }

    const reasoningLevels = getReasoningLevelsForModel(state.activeProvider, state.currentModel);
    const initialLevel = reasoningLevels.includes(state.reasoningLevel)
        ? state.reasoningLevel
        : reasoningLevels[0] ?? state.reasoningLevel;

    let selectedReasoning: ReasoningLevel;

    if (requestedLevel) {
        const normalized = normalizeThinkingLevel(requestedLevel);
        if (!normalized || !reasoningLevels.includes(normalized)) {
            ui.write(`Unsupported thinking level '${requestedLevel}' for ${state.currentModel}.`);
            ui.write(`Supported thinking levels: ${formatThinkingLevels(reasoningLevels)}.`);
            return;
        }
        selectedReasoning = normalized;
    } else {
        const reasoningOptions: ChoiceOption<ReasoningLevel>[] = reasoningLevels.map((level) => ({
            label: level,
            value: level,
            description: level === state.reasoningLevel ? "Current thinking level" : undefined,
        }));

        selectedReasoning = await ui.choose<ReasoningLevel>("Select thinking level", reasoningOptions, initialLevel);
    }

    state.reasoningLevel = selectedReasoning;
    ui.setReasoningLevel(selectedReasoning);
    ui.write(`Thinking level set to ${selectedReasoning}.`);
}

async function chooseModelAndReasoning(
    state: State,
    ui: InteractiveUi,
    saveDefaultModel: typeof savePreferredDefaultModelAndReasoning = savePreferredDefaultModelAndReasoning,
): Promise<void> {
    if (!state.activeProvider) {
        ui.write("Not logged in. Type /login to continue.");
        return;
    }

    const models = await withBusyIndicator(ui, "Loading models", () => getAvailableModels(state.activeProvider, state.client));
    if (models.length === 0) {
        ui.write("No models available for the current provider.");
        return;
    }

    const modelOptions: ChoiceOption<string>[] = models.map((model) => ({
        label: model,
        value: model,
        description: model === state.currentModel ? "Current model" : undefined,
    }));

    const selectedModel = await ui.choose("Select model", modelOptions, state.currentModel);

    const reasoningLevels = getReasoningLevelsForModel(state.activeProvider, selectedModel);
    const initialReasoning = reasoningLevels.includes(state.reasoningLevel)
        ? state.reasoningLevel
        : reasoningLevels[0] ?? state.reasoningLevel;
    const reasoningOptions: ChoiceOption<ReasoningLevel>[] = reasoningLevels.map((level) => ({
        label: level,
        value: level,
        description: level === state.reasoningLevel ? "Current reasoning level" : undefined,
    }));

    const selectedReasoning = await ui.choose<ReasoningLevel>("Select reasoning level", reasoningOptions, initialReasoning);

    state.currentModel = selectedModel;
    state.reasoningLevel = selectedReasoning;
    await saveDefaultModel(state.activeProvider, selectedModel, selectedReasoning);
    ui.write(`Model set to ${selectedModel}.`);
    ui.write(`Reasoning level set to ${selectedReasoning}.`);
    ui.write(`Default model and thinking for new ${state.activeProvider} sessions set to ${selectedModel} · ${selectedReasoning}.`);
}

async function choosePermissions(state: State, ui: InteractiveUi, requestedMode?: string): Promise<void> {
    if (requestedMode) {
        const normalized = normalizePermissionMode(requestedMode);
        if (!normalized) {
            ui.write("Usage: /permissions [ask|read-only|workspace-write|full-access|yolo|status] — yolo is an alias for full-access");
            return;
        }
        state.permissionMode = normalized;
        ui.write(`Permissions set to ${normalized}.`);
        return;
    }

    const permissionModes: PermissionMode[] = ["ask", "read-only", "workspace-write", "full-access"];
    const selectedMode = await ui.choose<PermissionMode>("Select permission mode", permissionModes.map((mode) => ({
        label: describePermissionMode(mode),
        value: mode,
        description: `${getPermissionModeDescription(mode)}${mode === state.permissionMode ? " · Current permission mode" : ""}`,
    })), state.permissionMode);

    state.permissionMode = selectedMode;
    ui.write(`Permissions set to ${selectedMode}.`);
}

function handlePermissionsCommand(state: State, ui: InteractiveUi, value?: string): Promise<void> | void {
    const normalized = value?.trim().toLowerCase();
    if (normalized === "status" || normalized === "show") {
        ui.write(`Permissions: ${state.permissionMode} — ${getPermissionModeDescription(state.permissionMode)}`);
        return;
    }
    return choosePermissions(state, ui, value);
}

async function chooseContextHandling(state: State, ui: InteractiveUi): Promise<void> {
    if (!state.activeProvider) {
        ui.write("Not logged in. Type /login to continue.");
        return;
    }

    const contextLevels = getContextLevelsForModel(state.activeProvider, state.currentModel);
    const contextOptions: ChoiceOption<ContextLevel>[] = contextLevels.map((level) => ({
        label: level,
        value: level,
        description: `${getContextLevelDescription(level)}${level === state.contextLevel ? " · Current context mode" : ""}`,
    }));

    const selectedContext = await ui.choose<ContextLevel>("Select context handling", contextOptions, state.contextLevel);

    state.contextLevel = selectedContext;
    ui.write(`Context handling set to ${selectedContext}.`);
}

async function chooseSubagentThinkingLevel(state: State, ui: InteractiveUi): Promise<void> {
    if (!state.activeProvider) {
        ui.write("Not logged in. Type /login to continue.");
        return;
    }

    const reasoningLevels = getReasoningLevelsForModel(state.activeProvider, state.currentModel);
    const initialLevel = reasoningLevels.includes(state.subagentReasoningLevel)
        ? state.subagentReasoningLevel
        : reasoningLevels.includes(DEFAULT_SUBAGENT_REASONING_LEVEL)
            ? DEFAULT_SUBAGENT_REASONING_LEVEL
            : reasoningLevels[0] ?? state.subagentReasoningLevel;
    const reasoningOptions: ChoiceOption<ReasoningLevel>[] = reasoningLevels.map((level) => ({
        label: level,
        value: level,
        description: level === state.subagentReasoningLevel ? "Current subagent thinking level" : undefined,
    }));

    const selectedReasoning = await ui.choose<ReasoningLevel>("Select subagent thinking level", reasoningOptions, initialLevel);

    state.subagentReasoningLevel = selectedReasoning;
    ui.write(`Subagent thinking level set to ${selectedReasoning}.`);
}

async function openSettings(state: State, ui: InteractiveUi): Promise<void> {
    const choice = await ui.choose("Settings", [
        {
            label: "Permissions",
            value: "permissions" as const,
            description: `${state.permissionMode} · ${getPermissionModeDescription(state.permissionMode)}`,
        },
        {
            label: "Context handling",
            value: "context" as const,
            description: state.activeProvider
                ? `${state.contextLevel} · ${getContextLevelDescription(state.contextLevel)}`
                : "Log in to configure context handling",
        },
        {
            label: "Plan mode",
            value: "plan" as const,
            description: state.planMode ? "enabled · interactive planning" : "disabled",
        },
        {
            label: "Subagents mode",
            value: "subagents" as const,
            description: state.subagentsMode ? "enabled · Perry may spawn subagents" : "disabled · spawn_subagent is hidden",
        },
        {
            label: "Subagent thinking",
            value: "subagent-thinking" as const,
            description: `${state.subagentReasoningLevel} · thinking level used by spawned subagents`,
        },
        {
            label: "Skills",
            value: "skills" as const,
            description: state.activeSkill ? `active: ${state.activeSkill.name}` : "list, reload, or apply reusable workflows with /skills and /skill",
        },
    ], "permissions");

    if (choice === "permissions") {
        await choosePermissions(state, ui);
        return;
    }

    if (choice === "context") {
        await chooseContextHandling(state, ui);
        return;
    }

    if (choice === "plan") {
        state.planMode = !state.planMode;
        if (!state.planMode) state.pendingPlanExecution = false;
        ui.write(state.planMode
            ? "Plan mode enabled. I can inspect, ask TUI planning questions, and then start work after you approve the final plan."
            : "Plan mode disabled.");
        return;
    }

    if (choice === "subagents") {
        state.subagentsMode = !state.subagentsMode;
        ui.write(state.subagentsMode
            ? "Subagents mode enabled. Perry may spawn subagents when useful."
            : "Subagents mode disabled. Perry will not spawn subagents.");
        return;
    }

    if (choice === "subagent-thinking") {
        await chooseSubagentThinkingLevel(state, ui);
        return;
    }

    if (choice === "skills") {
        ui.write("Use /skills to list or reload reusable workflows, and /skill <name> to apply one to your next request.");
    }
}

function handleToggleModeCommand(
    state: State,
    ui: InteractiveUi,
    value: string | undefined,
    options: {
        modeName: string;
        get: () => boolean;
        set: (enabled: boolean) => void;
        enabledMessage: string;
        disabledMessage: string;
    },
): void {
    const normalized = value?.trim().toLowerCase();

    if (!normalized || normalized === "toggle") {
        options.set(!options.get());
    } else if (["on", "enable", "enabled", "true"].includes(normalized)) {
        options.set(true);
    } else if (["off", "disable", "disabled", "false"].includes(normalized)) {
        options.set(false);
    } else if (["status", "show"].includes(normalized)) {
        ui.write(`${options.modeName} is ${options.get() ? "enabled" : "disabled"}.`);
        return;
    } else {
        ui.write(`Usage: /${options.modeName.toLowerCase().replace(/\s+/g, "")} [on|off|status]`);
        return;
    }

    ui.write(options.get() ? options.enabledMessage : options.disabledMessage);
}

function handleSubagentsCommand(state: State, ui: InteractiveUi, value?: string): void {
    handleToggleModeCommand(state, ui, value, {
        modeName: "Subagents mode",
        get: () => state.subagentsMode,
        set: (enabled) => { state.subagentsMode = enabled; },
        enabledMessage: "Subagents mode enabled. Perry may spawn subagents when useful.",
        disabledMessage: "Subagents mode disabled. Perry will not spawn subagents.",
    });
}

function handlePlanCommand(state: State, ui: InteractiveUi, value?: string): void {
    const normalized = value?.trim().toLowerCase();

    if (!normalized || normalized === "toggle") {
        state.planMode = !state.planMode;
    } else if (["on", "enable", "enabled", "true"].includes(normalized)) {
        state.planMode = true;
    } else if (["off", "disable", "disabled", "false"].includes(normalized)) {
        state.planMode = false;
    } else if (["status", "show"].includes(normalized)) {
        ui.write(state.planMode ? "Plan mode is enabled." : "Plan mode is disabled.");
        return;
    } else {
        ui.write("Usage: /plan [on|off|status]");
        return;
    }

    if (!state.planMode) state.pendingPlanExecution = false;

    ui.write(state.planMode
        ? "Plan mode enabled. I can inspect, ask TUI planning questions, and then start work after you approve the final plan."
        : "Plan mode disabled.");
}

export const handleSlashCommands = async ({
    command,
    state,
    ui,
    saveDefaultModel = savePreferredDefaultModelAndReasoning,
}: HandleSlashProps): Promise<boolean> => {
    const trimmed = command.trim();
    const parsedCommandName = getSlashCommandName(trimmed);
    if (!parsedCommandName) {
        return false;
    }
    const [, ...commandArgs] = trimmed.split(/\s+/);

    switch (parsedCommandName) {
        case "/help":
            ui.write([
                "Available commands:",
                ...SLASH_COMMANDS.map((slashCommand) => `${slashCommand.name} — ${slashCommand.description}`),
            ].join("\n"));
            return true;

        case "/quit":
            return false;

        case "/logout":
            await withBusyIndicator(ui, "Logging out", () => logout());
            state.client = null;
            state.activeProvider = null;
            state.currentModel = getDefaultModel(null);
            state.reasoningLevel = getDefaultReasoningLevel();
            state.subagentReasoningLevel = DEFAULT_SUBAGENT_REASONING_LEVEL;
            state.contextLevel = getDefaultContextLevel();
            state.permissionMode = "ask";
            state.planMode = false;
            state.pendingPlanExecution = false;
            state.subagentsMode = false;
            state.activeSkill = null;
            ui.write("Logged out.");
            return true;

        case "/login": {
            const choice = await ui.choose("Choose login method", [
                {
                    label: "OpenAI API key",
                    value: "api-key" as const,
                },
                {
                    label: "ChatGPT/Codex subscription",
                    value: "codex" as const,
                },
            ]);

            if (choice === "api-key") {
                await loginWithApiKey(ui);
                const updatedAuth = await withBusyIndicator(ui, "Checking saved login", () => getAuthFile());

                if (
                    updatedAuth?.activeProvider === "openai-api-key" &&
                    updatedAuth.openaiApiKey
                ) {
                    state.client = new OpenAI({
                        apiKey: updatedAuth.openaiApiKey.apiKey,
                    });

                    state.activeProvider = "openai-api-key";
                    state.currentModel = await getPreferredDefaultModel("openai-api-key");
                    state.reasoningLevel = await getPreferredDefaultReasoningLevel("openai-api-key", state.currentModel);
                    state.subagentReasoningLevel = DEFAULT_SUBAGENT_REASONING_LEVEL;
                    state.contextLevel = getDefaultContextLevel();
                    state.permissionMode = "ask";
                    state.planMode = false;
                    state.pendingPlanExecution = false;
                    state.subagentsMode = false;
                    state.activeSkill = null;
                    ui.write("Logged in with OpenAI API key.");
                } else {
                    ui.write("API key login did not save correctly.");
                }

                return true;
            }

            await withBusyIndicator(ui, "Waiting for browser login", () => loginWithSubscription());
            state.client = null;
            state.activeProvider = "openai-codex";
            state.currentModel = await getPreferredDefaultModel("openai-codex");
            state.reasoningLevel = await getPreferredDefaultReasoningLevel("openai-codex", state.currentModel);
            state.subagentReasoningLevel = DEFAULT_SUBAGENT_REASONING_LEVEL;
            state.contextLevel = getDefaultContextLevel();
            state.permissionMode = "ask";
            state.planMode = false;
            state.pendingPlanExecution = false;
            state.subagentsMode = false;
            state.activeSkill = null;
            ui.write("Logged in with ChatGPT/Codex subscription.");

            return true;
        }

        case "/thinking":
            await chooseThinkingLevel(state, ui, commandArgs[0]);
            return true;

        case "/model":
            await chooseModelAndReasoning(state, ui, saveDefaultModel);
            return true;

        case "/settings":
            await openSettings(state, ui);
            return true;

        case "/permissions":
            await handlePermissionsCommand(state, ui, commandArgs[0]);
            return true;

        case "/plan":
            handlePlanCommand(state, ui, commandArgs[0]);
            return true;

        case "/subagents":
            handleSubagentsCommand(state, ui, commandArgs[0]);
            return true;

        case "/accept":
            ui.write(state.planMode
                ? "No plan is waiting for approval. Ask for a plan first, then use /accept."
                : "Plan mode is not enabled.");
            return true;
    }

    return false;
};
