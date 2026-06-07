import type { InteractiveUi } from "../ui/types";
import type { PersistedChatMessage, SessionEntry } from "./sessionManager";

export function renderSessionTranscript(ui: Pick<InteractiveUi, "write" | "writeUser" | "writeAssistant" | "restoreToolTrace">, sessionId: string, entriesOrHistory: PersistedChatMessage[] | SessionEntry[]): void {
    if (entriesOrHistory.length === 0) {
        ui.write(`Started session ${sessionId.slice(0, 8)}.`);
        return;
    }

    const first = entriesOrHistory[0];
    const entries = first && "type" in first
        ? entriesOrHistory as SessionEntry[]
        : (entriesOrHistory as PersistedChatMessage[]).map((message) => ({ type: "message" as const, message }));

    let renderedVisibleEntry = false;
    for (const entry of entries) {
        if (entry.type === "message") {
            const message = entry.message;
            if (!message.content) continue;
            if (message.role === "user") {
                ui.writeUser(message.content);
                renderedVisibleEntry = true;
            } else if (message.role === "assistant") {
                ui.writeAssistant(message.content);
                renderedVisibleEntry = true;
            }
            continue;
        }

        if (entry.type === "tool_trace") {
            ui.restoreToolTrace?.(entry.trace);
            renderedVisibleEntry = true;
        }
    }

    if (!renderedVisibleEntry) ui.write(`Started session ${sessionId.slice(0, 8)}.`);
}
