import OpenAI from "openai";
import { logout } from "../auth/logout";
import { loginWithApiKey } from "../auth/api-key-auth/loginWithApiKey";
import { loginWithSubscription } from "../auth/subscription-auth/loginWithSubscription";
import { getAuthFile } from "./getAuthFile";
import { SLASH_COMMANDS } from "./commands";
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
import type { State } from "..";
import type { ChoiceOption, InteractiveUi } from "../ui/types";

interface HandleSlashProps {
    command: string,
    state: State,
    ui: InteractiveUi,
}

async function chooseModelAndReasoning(state: State, ui: InteractiveUi): Promise<void> {
    if (!state.activeProvider) {
        ui.write("Not logged in. Type /login to continue.");
        return;
    }

    const models = await getAvailableModels(state.activeProvider, state.client);
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
    const reasoningOptions: ChoiceOption<ReasoningLevel>[] = reasoningLevels.map((level) => ({
        label: level,
        value: level,
        description: level === state.reasoningLevel ? "Current reasoning level" : undefined,
    }));

    const selectedReasoning = await ui.choose<ReasoningLevel>("Select reasoning level", reasoningOptions, state.reasoningLevel);

    const contextLevels = getContextLevelsForModel(state.activeProvider, selectedModel);
    const contextOptions: ChoiceOption<ContextLevel>[] = contextLevels.map((level) => ({
        label: level,
        value: level,
        description: `${getContextLevelDescription(level)}${level === state.contextLevel ? " · Current context mode" : ""}`,
    }));

    const selectedContext = await ui.choose<ContextLevel>("Select context handling", contextOptions, state.contextLevel);

    state.currentModel = selectedModel;
    state.reasoningLevel = selectedReasoning;
    state.contextLevel = selectedContext;
    ui.write(`Model set to ${selectedModel}.`);
    ui.write(`Reasoning level set to ${selectedReasoning}.`);
    ui.write(`Context handling set to ${selectedContext}.`);
}

export const handleSlashCommands = async ({
    command,
    state,
    ui,
}: HandleSlashProps): Promise<boolean> => {
    const trimmed = command.trim();
    const [commandName, ...commandArgs] = trimmed.split(/\s+/);

    switch (commandName) {
        case "/help":
            ui.write([
                "Available commands:",
                ...SLASH_COMMANDS.map((slashCommand) => `${slashCommand.name} — ${slashCommand.description}`),
            ].join("\n"));
            return true;

        case "/quit":
            return false;

        case "/trace": {
            const traceReference = commandArgs[0];
            if (!traceReference) {
                ui.write("Usage: /trace <number>");
                return true;
            }

            if (!ui.expandTrace(traceReference)) {
                ui.write(`Could not find trace ${traceReference}.`);
            }
            return true;
        }

        case "/logout":
            await logout();
            state.client = null;
            state.activeProvider = null;
            state.currentModel = getDefaultModel(null);
            state.reasoningLevel = getDefaultReasoningLevel();
            state.contextLevel = getDefaultContextLevel();
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
                const updatedAuth = await getAuthFile();

                if (
                    updatedAuth?.activeProvider === "openai-api-key" &&
                    updatedAuth.openaiApiKey
                ) {
                    state.client = new OpenAI({
                        apiKey: updatedAuth.openaiApiKey.apiKey,
                    });

                    state.activeProvider = "openai-api-key";
                    state.currentModel = getDefaultModel("openai-api-key");
                    state.reasoningLevel = getDefaultReasoningLevel();
                    state.contextLevel = getDefaultContextLevel();
                    ui.write("Logged in with OpenAI API key.");
                } else {
                    ui.write("API key login did not save correctly.");
                }

                return true;
            }

            await loginWithSubscription();
            state.client = null;
            state.activeProvider = "openai-codex";
            state.currentModel = getDefaultModel("openai-codex");
            state.reasoningLevel = getDefaultReasoningLevel();
            state.contextLevel = getDefaultContextLevel();
            ui.write("Logged in with ChatGPT/Codex subscription.");

            return true;
        }

        case "/model":
            await chooseModelAndReasoning(state, ui);
            return true;

        default: {
            ui.write(`Unknown command: ${command}`);
            ui.write("Type /help to see available commands.");
            return true;
        }
    }
};
