import OpenAI from "openai";
import { getAuthFile } from "./getAuthFile";
import { State } from "..";

export const getCurrentSessionStatus = async (state: State) => {
    console.log("checking session status...");
    const auth = await getAuthFile();

    if (auth?.activeProvider === "openai-api-key" && auth.openaiApiKey) {
        state.client = new OpenAI({
            apiKey: auth.openaiApiKey.apiKey,
        });
        state.activeProvider = "openai-api-key";

        console.log("Using saved OpenAI API key.");
    } else if (auth?.activeProvider === "openai-codex" && auth.openaiCodex) {
        state.activeProvider = "openai-codex";
        console.log("Using saved ChatGPT/Codex subscription login.");

    } else {
        console.log("Not logged in. Type /login to continue.");
    }
}
