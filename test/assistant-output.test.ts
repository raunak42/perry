import assert from "node:assert/strict";
import { test } from "bun:test";
import type { ResponseOutputItem } from "openai/resources/responses/responses";
import { hasFunctionCallItems, shouldPersistAssistantResponseText, shouldRetainAssistantOutput } from "../src/helpers/assistantOutput";

function functionCall(name = "read"): ResponseOutputItem {
    return {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name,
        arguments: "{}",
    } as unknown as ResponseOutputItem;
}

function reasoning(): ResponseOutputItem {
    return {
        type: "reasoning",
        id: "rs_1",
        summary: [],
    } as unknown as ResponseOutputItem;
}

test("assistant output with tool calls is treated as transient", () => {
    const items = [reasoning(), functionCall()];
    assert.equal(hasFunctionCallItems(items), true);
    assert.equal(shouldRetainAssistantOutput(items), false);
    assert.equal(shouldPersistAssistantResponseText("I will inspect the file first.", items), false);
});

test("assistant output without tool calls is retained and persisted", () => {
    const items = [reasoning()];
    assert.equal(hasFunctionCallItems(items), false);
    assert.equal(shouldRetainAssistantOutput(items), true);
    assert.equal(shouldPersistAssistantResponseText("Here is the final answer.", items), true);
    assert.equal(shouldPersistAssistantResponseText("   ", items), false);
});
