import OpenAI from "openai";
import { getAuthFile } from "./getAuthFile";

export type ReasoningLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type ContextLevel = "disabled" | "auto" | "balanced" | "aggressive";

export interface ContextConfig {
    truncation?: "auto" | "disabled";
    context_management?: Array<{
        type: "compaction";
        compact_threshold: number;
    }>;
}

const DEFAULT_API_MODELS = ["gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"];
const DEFAULT_CODEX_MODELS = ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"];

export interface ModelDisplayMetadata {
    contextWindow?: number;
    maxOutputTokens?: number;
}

export function getDefaultModel(provider: "openai-api-key" | "openai-codex" | null): string {
    if (provider === "openai-codex") {
        return "gpt-5.4";
    }

    return "gpt-5.4-mini";
}

export function getDefaultReasoningLevel(): ReasoningLevel {
    return "high";
}

export function getDefaultContextLevel(): ContextLevel {
    return "auto";
}

function scoreModel(id: string): number {
    if (id === "gpt-5.5") return 0;
    if (id === "gpt-5.4") return 1;
    if (id === "gpt-5.4-mini") return 2;
    if (id === "gpt-5.4-nano") return 3;
    if (id === "gpt-5-codex") return 4;
    if (id === "codex-mini-latest") return 5;
    if (id.startsWith("gpt-5")) return 10;
    if (id.startsWith("o")) return 20;
    if (id.startsWith("gpt")) return 30;
    return 100;
}

function sortModels(models: string[]): string[] {
    return [...new Set(models)].sort((a, b) => {
        const scoreDelta = scoreModel(a) - scoreModel(b);
        if (scoreDelta !== 0) {
            return scoreDelta;
        }

        return a.localeCompare(b);
    });
}

export async function getAvailableModels(
    provider: "openai-api-key" | "openai-codex" | null,
    client: OpenAI | null
): Promise<string[]> {
    if (provider === "openai-api-key") {
        return sortModels(await getApiKeyModels(client));
    }

    if (provider === "openai-codex") {
        return sortModels(await getCodexModels());
    }

    return [];
}

async function getApiKeyModels(client: OpenAI | null): Promise<string[]> {
    if (!client) {
        return DEFAULT_API_MODELS;
    }

    try {
        const page = await client.models.list();
        const ids = page.data
            .map((model) => model.id)
            .filter((id) => /^(gpt-5|o\d|codex)/i.test(id));

        return ids.length > 0 ? ids : DEFAULT_API_MODELS;
    } catch {
        return DEFAULT_API_MODELS;
    }
}

async function getCodexModels(): Promise<string[]> {
    const auth = await getAuthFile();
    const accessToken = auth?.openaiCodex?.access_token;

    if (!accessToken) {
        return DEFAULT_CODEX_MODELS;
    }

    try {
        const res = await fetch("https://chatgpt.com/backend-api/codex/models?client_version=1.0.0", {
            headers: {
                Authorization: `Bearer ${accessToken}`,
            },
        });

        if (!res.ok) {
            return DEFAULT_CODEX_MODELS;
        }

        const data = await res.json() as {
            models?: Array<{
                slug?: string;
                supported_in_api?: boolean;
                visibility?: string;
            }>;
        };

        const ids = (data.models ?? [])
            .filter((model) => model.slug)
            .filter((model) => model.supported_in_api !== false)
            .filter((model) => !model.visibility || model.visibility === "list")
            .map((model) => model.slug as string);

        return ids.length > 0 ? ids : DEFAULT_CODEX_MODELS;
    } catch {
        return DEFAULT_CODEX_MODELS;
    }
}

export function getReasoningLevelsForModel(
    provider: "openai-api-key" | "openai-codex" | null,
    model: string
): ReasoningLevel[] {
    if (!provider) {
        return ["off"];
    }

    if (model === "gpt-5-pro") {
        return ["high"];
    }

    if (/^gpt-5\.0($|[-.])/.test(model) || model === "gpt-5") {
        return ["minimal", "low", "medium", "high"];
    }

    if (/^gpt-5\.1($|[-.])/.test(model)) {
        return ["off", "low", "medium", "high"];
    }

    if (provider === "openai-codex") {
        return ["off", "low", "medium", "high", "xhigh"];
    }

    if (/^(gpt-5|o\d|codex)/i.test(model)) {
        return ["off", "minimal", "low", "medium", "high", "xhigh"];
    }

    return ["off"];
}

export function getContextLevelsForModel(
    provider: "openai-api-key" | "openai-codex" | null,
    _model: string
): ContextLevel[] {
    if (!provider) {
        return ["disabled"];
    }

    return ["disabled", "auto", "balanced", "aggressive"];
}

export function getModelDisplayMetadata(model: string): ModelDisplayMetadata {
    if (model === "gpt-5.4" || /^gpt-5\.4-\d{4}-\d{2}-\d{2}$/.test(model)) {
        return {
            contextWindow: 1_050_000,
            maxOutputTokens: 128_000,
        };
    }

    if (
        model === "gpt-5.4-mini"
        || /^gpt-5\.4-mini-\d{4}-\d{2}-\d{2}$/.test(model)
        || model === "gpt-5.4-nano"
        || /^gpt-5\.4-nano-\d{4}-\d{2}-\d{2}$/.test(model)
        || model === "gpt-5.5"
        || /^gpt-5\.5-\d{4}-\d{2}-\d{2}$/.test(model)
    ) {
        return {
            contextWindow: 400_000,
            maxOutputTokens: 128_000,
        };
    }

    return {};
}

export function getContextLevelDescription(level: ContextLevel): string {
    switch (level) {
        case "disabled":
            return "Fail if the request exceeds the model context window";
        case "auto":
            return "Allow automatic truncation if the request exceeds the context window";
        case "balanced":
            return "Auto-truncate and trigger compaction around 80% of the context window";
        case "aggressive":
            return "Auto-truncate and compact earlier around 60% of the context window";
        default:
            return level;
    }
}

export function getContextConfig(model: string, level: ContextLevel): ContextConfig {
    const metadata = getModelDisplayMetadata(model);

    if (level === "disabled") {
        return { truncation: "disabled" };
    }

    if (level === "auto") {
        return { truncation: "auto" };
    }

    const contextWindow = metadata.contextWindow;
    if (!contextWindow) {
        return { truncation: "auto" };
    }

    const compactThreshold = level === "aggressive"
        ? Math.floor(contextWindow * 0.6)
        : Math.floor(contextWindow * 0.8);

    return {
        truncation: "auto",
        context_management: [{
            type: "compaction",
            compact_threshold: compactThreshold,
        }],
    };
}

export function getReasoningConfig(level: ReasoningLevel): {
    effort: Exclude<ReasoningLevel, "off">;
    summary: "detailed";
} | undefined {
    if (level === "off") {
        return undefined;
    }

    return {
        effort: level,
        summary: "detailed",
    };
}
