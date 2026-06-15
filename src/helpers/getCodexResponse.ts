import { getAuthFile } from "../helpers/getAuthFile";
import type {
    Response,
    ResponseOutputItem,
    ResponseStreamEvent,
} from "openai/resources/responses/responses";
import { getContextConfig, type ContextLevel, type ReasoningLevel } from "./models";

type GetCodexResponseParams = {
    instructions: string;
    input: unknown[];
    model: string;
    reasoningLevel: ReasoningLevel;
    contextLevel: ContextLevel;
    tools?: unknown[];
    signal?: AbortSignal;
};

export type CodexResponseStreamHooks = {
    onReasoningStart?: (itemId: string) => void;
    onReasoningDelta?: (itemId: string, delta: string) => void;
    onReasoningDone?: (itemId: string) => void;
    onOutputTextDelta?: (itemId: string, delta: string) => void;
    onOutputTextDone?: (itemId: string) => void;
    onOutputItemAdded?: (item: ResponseOutputItem) => void;
    onOutputItemDone?: (item: ResponseOutputItem) => void;
    onResponseEvent?: (eventName: string, event: CodexStreamEvent) => void;
};

export type ParsedCodexResponse = {
    output_text: string;
    output: ResponseOutputItem[];
    usage?: Response["usage"];
};

export type ProviderLimitDetails = {
    status: number;
    type?: string;
    message: string;
    planType?: string;
    resetsAt?: number;
    resetsInSeconds?: number;
    raw?: string;
};

export class ProviderLimitError extends Error {
    readonly details: ProviderLimitDetails;

    constructor(details: ProviderLimitDetails) {
        super(details.message);
        this.name = "ProviderLimitError";
        this.details = details;
    }
}

export class ProviderRequestError extends Error {
    readonly status: number;
    readonly body: string;

    constructor(status: number, body: string) {
        super(`Provider request failed with status ${status}.`);
        this.name = "ProviderRequestError";
        this.status = status;
        this.body = body;
    }
}

type UnknownCodexStreamEvent = {
    type: string;
    [key: string]: unknown;
};

type CodexStreamEvent = ResponseStreamEvent | UnknownCodexStreamEvent;

function yieldToEventLoop(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

function createProviderError(status: number, body: string): Error {
    const parsed = parseProviderLimitError(status, body);
    if (parsed) return new ProviderLimitError(parsed);
    return new ProviderRequestError(status, body);
}

function parseProviderLimitError(status: number, body: string): ProviderLimitDetails | null {
    let payload: unknown = null;
    try {
        payload = JSON.parse(body);
    } catch {
        payload = null;
    }

    const error = payload && typeof payload === "object" && "error" in payload
        ? (payload as { error?: unknown }).error
        : payload;
    const record = error && typeof error === "object" ? error as Record<string, unknown> : null;
    const type = typeof record?.type === "string" ? record.type : undefined;
    const message = typeof record?.message === "string" ? record.message : body.trim();
    const isLimit = status === 429 || /(?:usage|rate|quota|limit).*reached|too many requests|rate limit/i.test(`${type ?? ""} ${message}`);
    if (!isLimit) return null;

    return {
        status,
        type,
        message: message || "Provider usage or rate limit reached.",
        planType: typeof record?.plan_type === "string" ? record.plan_type : undefined,
        resetsAt: typeof record?.resets_at === "number" ? record.resets_at : undefined,
        resetsInSeconds: typeof record?.resets_in_seconds === "number" ? record.resets_in_seconds : undefined,
        raw: body,
    };
}

function getCodexAccountIdFromToken(token: string): string | null {
    const parts = token.split(".");
    if (parts.length < 2 || !parts[1]) {
        return null;
    }

    try {
        const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
            [key: string]: unknown;
            "https://api.openai.com/auth"?: {
                chatgpt_account_id?: unknown;
            };
        };
        const accountId = payload["https://api.openai.com/auth"]?.chatgpt_account_id;
        return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
    } catch {
        return null;
    }
}

export async function getCodexResponse(
    params: GetCodexResponseParams,
    hooks: CodexResponseStreamHooks = {}
): Promise<ParsedCodexResponse> {
    const authFile = await getAuthFile();
    const accessToken = authFile?.openaiCodex?.access_token;

    if (!accessToken) {
        throw new Error("No ChatGPT/Codex access token found. Run /login again.");
    }

    const contextConfig = getContextConfig(params.model, params.contextLevel, "openai-codex");
    const accountId = getCodexAccountIdFromToken(accessToken);
    const baseBody = {
        model: params.model,
        instructions: params.instructions,
        input: params.input,
        tools: params.tools,
        parallel_tool_calls: true,
        text: { verbosity: "medium" as const },
        reasoning: params.reasoningLevel === "off"
            ? undefined
            : {
                effort: params.reasoningLevel,
                summary: "detailed",
            },
        include: [
            "web_search_call.action.sources",
            "file_search_call.results",
            "code_interpreter_call.outputs",
        ],
        store: false,
        stream: true,
    };

    const requestWithContext = {
        ...baseBody,
        truncation: contextConfig.truncation,
        context_management: contextConfig.context_management,
    };

    const requestWithoutContext = baseBody;

    const sendRequest = (body: typeof baseBody | typeof requestWithContext) => {
        const headers: Record<string, string> = {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            "OpenAI-Beta": "responses=experimental",
            originator: "pi",
        };

        if (accountId) {
            headers["chatgpt-account-id"] = accountId;
        }

        return fetch("https://chatgpt.com/backend-api/codex/responses", {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: params.signal,
        });
    };

    let res = await sendRequest(requestWithContext);

    if (!res.ok) {
        const text = await res.text();
        const unsupportedContextControls = res.status === 400
            && /Unsupported parameter:\s*(truncation|context_management)/i.test(text);

        if (!unsupportedContextControls) {
            throw createProviderError(res.status, text);
        }

        res = await sendRequest(requestWithoutContext);
        if (!res.ok) {
            const fallbackText = await res.text();
            throw createProviderError(res.status, fallbackText);
        }
    }

    if (!res.body) {
        const text = await res.text();
        return parseCodexSSE(text, hooks);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const parsed: ParsedCodexResponse = {
        output_text: "",
        output: [],
    };

    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }

        buffer += decoder.decode(value, { stream: true });
        const eventBlocks = buffer.split("\n\n");
        buffer = eventBlocks.pop() ?? "";

        for (const eventBlock of eventBlocks) {
            if (processCodexEventBlock(eventBlock, parsed, hooks)) {
                await yieldToEventLoop();
            }
        }
    }

    if (buffer.trim().length > 0) {
        processCodexEventBlock(buffer, parsed, hooks);
    }

    return parsed;
}

function parseCodexSSE(text: string, hooks: CodexResponseStreamHooks): ParsedCodexResponse {
    const parsed: ParsedCodexResponse = {
        output_text: "",
        output: [],
    };

    const events = text.split("\n\n");
    for (const eventBlock of events) {
        processCodexEventBlock(eventBlock, parsed, hooks);
    }

    return parsed;
}

function processCodexEventBlock(
    eventBlock: string,
    parsed: ParsedCodexResponse,
    hooks: CodexResponseStreamHooks
): boolean {
    const lines = eventBlock.split("\n");
    const eventLine = lines.find((line) => line.startsWith("event: "));
    const dataLines = lines.filter((line) => line.startsWith("data: "));

    if (!eventLine || dataLines.length === 0) {
        return false;
    }

    const eventName = eventLine.slice("event: ".length);
    const jsonText = dataLines.map((line) => line.slice("data: ".length)).join("\n");

    let event: CodexStreamEvent;

    try {
        event = JSON.parse(jsonText) as CodexStreamEvent;
    } catch {
        return false;
    }

    hooks.onResponseEvent?.(eventName, event);

    if (eventName === "response.output_text.delta") {
        if ("delta" in event && typeof event.delta === "string") {
            parsed.output_text += event.delta;
            const itemId = "item_id" in event && typeof event.item_id === "string"
                ? event.item_id
                : "assistant-output";
            hooks.onOutputTextDelta?.(itemId, event.delta);
            return true;
        }
        return false;
    }

    if (eventName === "response.output_text.done") {
        const itemId = "item_id" in event && typeof event.item_id === "string"
            ? event.item_id
            : "assistant-output";
        hooks.onOutputTextDone?.(itemId);
        return true;
    }

    if (eventName === "response.output_item.added") {
        if ("item" in event && event.item) {
            hooks.onOutputItemAdded?.(event.item as ResponseOutputItem);
        }

        if (
            "item" in event &&
            event.item &&
            typeof event.item === "object" &&
            "type" in event.item &&
            event.item.type === "reasoning"
        ) {
            const itemId = "id" in event.item && typeof event.item.id === "string"
                ? event.item.id
                : "reasoning";
            hooks.onReasoningStart?.(itemId);
        }
        return false;
    }

    if (eventName === "response.output_item.done") {
        if ("item" in event && event.item) {
            parsed.output.push(event.item as ResponseOutputItem);
            hooks.onOutputItemDone?.(event.item as ResponseOutputItem);
        }
        return false;
    }

    if (eventName === "response.completed") {
        if ("response" in event && event.response && typeof event.response === "object") {
            const response = event.response as Response;
            parsed.usage = response.usage;
        }
        return false;
    }

    if (
        (eventName === "response.reasoning_summary_text.delta" || eventName === "response.reasoning_text.delta") &&
        "delta" in event &&
        typeof event.delta === "string"
    ) {
        const itemId = "item_id" in event && typeof event.item_id === "string"
            ? event.item_id
            : "reasoning";
        hooks.onReasoningDelta?.(itemId, event.delta);
        return true;
    }

    if (eventName === "response.reasoning_summary_part.added") {
        const itemId = "item_id" in event && typeof event.item_id === "string"
            ? event.item_id
            : "reasoning";
        hooks.onReasoningStart?.(itemId);
        return false;
    }

    if (eventName === "response.reasoning_summary_part.done") {
        const itemId = "item_id" in event && typeof event.item_id === "string"
            ? event.item_id
            : "reasoning";
        hooks.onReasoningDelta?.(itemId, "\n\n");
        return true;
    }

    if (eventName === "response.reasoning_summary_text.done" || eventName === "response.reasoning_text.done") {
        const itemId = "item_id" in event && typeof event.item_id === "string"
            ? event.item_id
            : "reasoning";
        hooks.onReasoningDone?.(itemId);
        return true;
    }

    return false;
}
