import fs from "node:fs/promises";
import { authDir, authPath } from "../constants";
import { getAuthFile, type AuthFile } from "./getAuthFile";
import { getDefaultModel, getDefaultReasoningLevel, getReasoningLevelsForModel, type ReasoningLevel } from "./models";

export type ModelDefaultProvider = "openai-api-key" | "openai-codex";

export function resolveDefaultModel(
    provider: ModelDefaultProvider | null,
    auth: AuthFile | null,
): string {
    if (!provider) {
        return getDefaultModel(null);
    }

    const saved = auth?.modelDefaults?.[provider];
    return typeof saved === "string" && saved.trim().length > 0
        ? saved.trim()
        : getDefaultModel(provider);
}

function normalizeSavedReasoningLevel(value: unknown): ReasoningLevel | null {
    if (typeof value !== "string") return null;
    const normalized = value.trim().toLowerCase();
    if (["off", "minimal", "low", "medium", "high", "xhigh"].includes(normalized)) {
        return normalized as ReasoningLevel;
    }
    return null;
}

export function resolveDefaultReasoningLevel(
    provider: ModelDefaultProvider | null,
    model: string,
    auth: AuthFile | null,
): ReasoningLevel {
    const fallback = getDefaultReasoningLevel();
    if (!provider) return fallback;

    const saved = normalizeSavedReasoningLevel(auth?.reasoningDefaults?.[provider]);
    const supportedLevels = getReasoningLevelsForModel(provider, model);
    if (saved && supportedLevels.includes(saved)) {
        return saved;
    }

    return supportedLevels.includes(fallback)
        ? fallback
        : supportedLevels[0] ?? fallback;
}

export async function getPreferredDefaultModel(provider: ModelDefaultProvider | null): Promise<string> {
    const auth = await getAuthFile();
    return resolveDefaultModel(provider, auth);
}

export async function getPreferredDefaultReasoningLevel(provider: ModelDefaultProvider | null, model: string): Promise<ReasoningLevel> {
    const auth = await getAuthFile();
    return resolveDefaultReasoningLevel(provider, model, auth);
}

export function withSavedDefaultModelAndReasoning(
    auth: AuthFile,
    provider: ModelDefaultProvider,
    model: string,
    reasoningLevel: ReasoningLevel,
): AuthFile {
    return {
        ...auth,
        modelDefaults: {
            ...(auth.modelDefaults ?? {}),
            [provider]: model,
        },
        reasoningDefaults: {
            ...(auth.reasoningDefaults ?? {}),
            [provider]: reasoningLevel,
        },
    };
}

export async function savePreferredDefaultModelAndReasoning(
    provider: ModelDefaultProvider,
    model: string,
    reasoningLevel: ReasoningLevel,
): Promise<void> {
    await fs.mkdir(authDir, { recursive: true });

    let existing: AuthFile = {};
    try {
        existing = JSON.parse(await fs.readFile(authPath, "utf-8")) as AuthFile;
    } catch {
        existing = {};
    }

    await fs.writeFile(authPath, JSON.stringify(withSavedDefaultModelAndReasoning(existing, provider, model, reasoningLevel), null, 2), {
        mode: 0o600,
    });
}
