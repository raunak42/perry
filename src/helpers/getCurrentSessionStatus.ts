import OpenAI from "openai";
import { getAuthFile } from "./getAuthFile";
import { getDefaultContextLevel, getDefaultModel, getDefaultReasoningLevel } from "./models";
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
        state.currentModel = getDefaultModel("openai-api-key");
        state.reasoningLevel = getDefaultReasoningLevel();
        state.contextLevel = getDefaultContextLevel();

        writeOutput("Using saved OpenAI API key.");
    } else if (auth?.activeProvider === "openai-codex" && auth.openaiCodex) {
        state.activeProvider = "openai-codex";
        state.currentModel = getDefaultModel("openai-codex");
        state.reasoningLevel = getDefaultReasoningLevel();
        state.contextLevel = getDefaultContextLevel();
        writeOutput("Using saved ChatGPT/Codex subscription login.");

    } else {
        writeOutput("Not logged in. Type /login to continue.");
    }
}
