import { test } from "bun:test";
import assert from "node:assert/strict";
import { renderSessionTranscript } from "../src/helpers/renderSessionTranscript";

test("session transcript replay renders every user and assistant message without truncation", () => {
    const writes: string[] = [];
    const userWrites: string[] = [];
    const assistantWrites: string[] = [];
    const longAssistantMessage = `${"Assistant detail. ".repeat(350)}END_OF_FULL_MESSAGE`;

    renderSessionTranscript(
        {
            write: (message) => writes.push(message),
            writeUser: (message) => userWrites.push(message),
            writeAssistant: (message) => assistantWrites.push(message),
            restoreToolTrace: () => undefined,
        },
        "12345678-session",
        [
            { role: "developer", content: "system context should not render" },
            ...Array.from({ length: 15 }, (_, index) => ({
                role: index % 2 === 0 ? "user" as const : "assistant" as const,
                content: `message ${index + 1}`,
            })),
            { role: "assistant", content: longAssistantMessage },
        ],
    );

    assert.deepEqual(writes, []);
    assert.deepEqual(userWrites, [
        "message 1",
        "message 3",
        "message 5",
        "message 7",
        "message 9",
        "message 11",
        "message 13",
        "message 15",
    ]);
    assert.ok(assistantWrites.includes("message 2"));
    assert.ok(assistantWrites.includes("message 14"));
    const lastWrite = assistantWrites[assistantWrites.length - 1];
    assert.equal(lastWrite, longAssistantMessage);
    assert.ok(lastWrite?.endsWith("END_OF_FULL_MESSAGE"));
});

test("session transcript replay restores tool traces in entry order", () => {
    const events: string[] = [];

    renderSessionTranscript(
        {
            write: (message) => events.push(`write:${message}`),
            writeUser: (message) => events.push(`user:${message}`),
            writeAssistant: (message) => events.push(`assistant:${message}`),
            restoreToolTrace: (trace) => events.push(`tool:${trace.toolName}:${trace.output}`),
        },
        "12345678-session",
        [
            {
                type: "message",
                id: "u1",
                parentId: null,
                timestamp: "2026-01-01T00:00:00.000Z",
                message: { role: "user", content: "Please inspect." },
            },
            {
                type: "tool_trace",
                id: "t1",
                parentId: "u1",
                timestamp: "2026-01-01T00:00:01.000Z",
                trace: {
                    id: "trace-1",
                    toolName: "read",
                    output: "file contents",
                    status: "complete",
                    details: {
                        type: "read",
                        path: "src/index.ts",
                        language: "typescript",
                        content: "file contents",
                    },
                },
            },
            {
                type: "message",
                id: "a1",
                parentId: "u1",
                timestamp: "2026-01-01T00:00:02.000Z",
                message: { role: "assistant", content: "Done." },
            },
        ],
    );

    assert.deepEqual(events, [
        "user:Please inspect.",
        "tool:read:file contents",
        "assistant:Done.",
    ]);
});
