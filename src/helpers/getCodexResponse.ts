import { getAuthFile } from "../helpers/getAuthFile";
import type {
    ResponseOutputItem,
    ResponseStreamEvent,
} from "openai/resources/responses/responses";

type GetCodexResponseParams = {
    instructions: string;
    input: unknown[];
    tools?: unknown[];
};

export type ParsedCodexResponse = {
    output_text: string;
    output: ResponseOutputItem[];
};

type UnknownCodexStreamEvent = {
    type: string;
    [key: string]: unknown;
};

type CodexStreamEvent = ResponseStreamEvent | UnknownCodexStreamEvent;

export async function getCodexResponse(
    params: GetCodexResponseParams
): Promise<ParsedCodexResponse> {
    const authFile = await getAuthFile();
    const accessToken = authFile?.openaiCodex?.access_token;

    if (!accessToken) {
        throw new Error("No ChatGPT/Codex access token found. Run /login again.");
    }

    const res = await fetch("https://chatgpt.com/backend-api/codex/responses", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            Accept: "text/event-stream",
        },
        body: JSON.stringify({
            model: "gpt-5.4-mini",
            instructions: params.instructions,
            input: params.input,
            tools: params.tools,
            store: false,
            stream: true,
        }),
    });

    const text = await res.text();

    if (!res.ok) {
        throw new Error(`Codex response failed: ${res.status}\n${text}`);
    }

    return parseCodexSSE(text);
}

function parseCodexSSE(text: string): ParsedCodexResponse {
    let outputText = "";
    const output: ResponseOutputItem[] = [];

    const events = text.split("\n\n");

    for (const eventBlock of events) {
        const lines = eventBlock.split("\n");

        const eventLine = lines.find((line) => line.startsWith("event: "));
        const dataLine = lines.find((line) => line.startsWith("data: "));

        if (!eventLine || !dataLine) {
            continue;
        }

        const eventName = eventLine.slice("event: ".length);
        const jsonText = dataLine.slice("data: ".length);

        let event: CodexStreamEvent;

        try {
            event = JSON.parse(jsonText) as CodexStreamEvent;
        } catch {
            continue;
        }

        if (eventName === "response.output_text.delta") {
            if ("delta" in event && typeof event.delta === "string") {
                outputText += event.delta;
            }
        }

        if (eventName === "response.output_item.done") {
            if ("item" in event && event.item) {
                output.push(event.item as ResponseOutputItem);
            }
        }
    }

    return {
        output_text: outputText,
        output,
    };
}