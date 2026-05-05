import { OpenAICodexTokens } from "../auth/types";
import { authPath } from "../constants";
import fs from "node:fs/promises";

export type AuthFile = {
    activeProvider?: "openai-api-key" | "openai-codex";

    openaiApiKey?: {
        apiKey: string;
    };

    openaiCodex?: OpenAICodexTokens;
};



export async function getAuthFile(): Promise<AuthFile | null> {
    try {
        const raw = await fs.readFile(authPath, "utf-8");
        return JSON.parse(raw) as AuthFile;
    } catch (err) {
        const error = err as NodeJS.ErrnoException;

        // Normal case - user has never logged in or has logged out.
        // Do not print this.
        if (error.code === "ENOENT") {
            return null;
        }

        // Optional - corrupted JSON should be user-friendly, not a stack trace.
        if (err instanceof SyntaxError) {
            console.log("Auth file is corrupted. Please run /login again.");
            return null;
        }

        // Unexpected errors can still be shown.
        console.log("Could not read auth file. Please run /login again.");
        return null;
    }
}