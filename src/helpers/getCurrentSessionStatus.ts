import OpenAI from "openai";
import { getAuthFile } from "./getAuthFile";
import { resolveDefaultModel, resolveDefaultReasoningLevel } from "./modelDefaults";
import { getDefaultContextLevel } from "./models";
import { DEFAULT_SUBAGENT_REASONING_LEVEL } from "./subagents";
import { writeOutput } from "../ui/output";
import type { State } from "..";

export const getCurrentSessionStatus = async (state: State) => {
    writeOutput("Checking session status...");
    const auth = await getAuthFile();

    if (auth?.activeProvider === "openai-api-key" && auth.openaiApiKey) {
        state.client = new OpenAI({
            apiKey: auth.openaiApiKey.apiKey,
        });
        state.activeProvider = "openai-api-key";
        state.currentModel = resolveDefaultModel("openai-api-key", auth);
        state.reasoningLevel = resolveDefaultReasoningLevel("openai-api-key", state.currentModel, auth);
        state.subagentReasoningLevel = DEFAULT_SUBAGENT_REASONING_LEVEL;
        state.contextLevel = getDefaultContextLevel();
        state.permissionMode = "ask";
        state.planMode = false;
        state.pendingPlanExecution = false;
        state.activeSkill = null;

        writeOutput("Using saved OpenAI API key.");
    } else if (auth?.activeProvider === "openai-codex" && auth.openaiCodex) {
        state.activeProvider = "openai-codex";
        state.currentModel = resolveDefaultModel("openai-codex", auth);
        state.reasoningLevel = resolveDefaultReasoningLevel("openai-codex", state.currentModel, auth);
        state.subagentReasoningLevel = DEFAULT_SUBAGENT_REASONING_LEVEL;
        state.contextLevel = getDefaultContextLevel();
        state.permissionMode = "ask";
        state.planMode = false;
        state.pendingPlanExecution = false;
        state.activeSkill = null;
        writeOutput("Using saved ChatGPT/Codex subscription login.");

    } else {
        writeOutput("Not logged in. Type /login to continue.");
    }
}
