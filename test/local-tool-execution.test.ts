import assert from "node:assert/strict";
import { test } from "bun:test";
import { executeLocalToolCalls } from "../src/helpers/localToolExecution";
import type { Tool } from "../src/tools/types";
import type { InteractiveUi, ChoiceOption, PersistableToolTrace, PromptOptions, SessionDetailLine, StartupCard } from "../src/ui/types";

function makeFunctionCall(name: string, callId: string, args: unknown = {}): any {
    return {
        type: "function_call",
        id: callId,
        call_id: callId,
        name,
        arguments: JSON.stringify(args),
    };
}

function createNoopUi(statuses: string[] = []): InteractiveUi {
    return {
        ask: async () => "",
        choose: async <T>(_prompt: string, options: ChoiceOption<T>[], initialValue?: T) => initialValue ?? options[0]!.value,
        write: () => undefined,
        writeWarning: () => undefined,
        writeError: () => undefined,
        writeUser: () => undefined,
        writeAssistant: () => undefined,
        writeThinking: () => undefined,
        writeStartupCard: (_card: StartupCard) => undefined,
        startStreamingBlock: () => "stream",
        appendToStreamingBlock: () => undefined,
        finishStreamingBlock: () => undefined,
        showToolCall: () => undefined,
        showToolCallArguments: () => undefined,
        updateToolCallArguments: () => undefined,
        startToolExecution: () => undefined,
        updateToolExecution: () => undefined,
        finishToolExecution: () => undefined,
        restoreToolTrace: (_trace: PersistableToolTrace) => undefined,
        expandTrace: () => false,
        refreshHistory: () => undefined,
        setStatus: (message: string) => statuses.push(message),
        setReasoningLevel: () => undefined,
        setSessionDetails: (_lines: SessionDetailLine[]) => undefined,
        setBusy: () => undefined,
        clearBusy: () => undefined,
        cancelActiveInput: () => undefined,
        triggerEscape: () => undefined,
        destroy: () => undefined,
    };
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

test("spawn_subagent calls in the same tool batch run in parallel", async () => {
    const starts: number[] = [];
    const tools: Array<Tool<any, any>> = [
        {
            name: "spawn_subagent",
            definition: { type: "function", name: "spawn_subagent", parameters: {} } as any,
            execute: async (args) => {
                starts.push(Date.now());
                await delay(80);
                return { output: `done ${args.task}` };
            },
        },
    ];

    const startedAt = Date.now();
    const results = await executeLocalToolCalls([
        makeFunctionCall("spawn_subagent", "call-a", { task: "A" }),
        makeFunctionCall("spawn_subagent", "call-b", { task: "B" }),
    ], tools, createNoopUi(), { permissionMode: "full-access" });
    const elapsed = Date.now() - startedAt;

    assert.equal(results.length, 2);
    assert.deepEqual(results.map((result) => result.toolCall.call_id), ["call-a", "call-b"]);
    assert.deepEqual(results.map((result) => result.result.output), ["done A", "done B"]);
    assert.equal(starts.length, 2);
    assert.ok(Math.abs(starts[0]! - starts[1]!) < 50, `subagents did not start together: ${starts.join(", ")}`);
    assert.ok(elapsed < 140, `expected parallel execution to finish quickly, took ${elapsed}ms`);
});

test("ask mode subagent batches request permission once and still run in parallel", async () => {
    let permissionPrompts = 0;
    const starts: number[] = [];
    const tools: Array<Tool<any, any>> = [
        {
            name: "spawn_subagent",
            definition: { type: "function", name: "spawn_subagent", parameters: {} } as any,
            execute: async (args) => {
                starts.push(Date.now());
                await delay(80);
                return { output: `done ${args.task}` };
            },
        },
    ];

    const startedAt = Date.now();
    const results = await executeLocalToolCalls([
        makeFunctionCall("spawn_subagent", "call-a", { task: "A" }),
        makeFunctionCall("spawn_subagent", "call-b", { task: "B" }),
    ], tools, createNoopUi(), {
        permissionMode: "ask",
        promptForPermission: async (evaluation) => {
            permissionPrompts += 1;
            assert.equal(evaluation.summary, "spawn 2 subagents in parallel");
            await delay(20);
            return true;
        },
    });
    const elapsed = Date.now() - startedAt;

    assert.deepEqual(results.map((result) => result.toolCall.call_id), ["call-a", "call-b"]);
    assert.deepEqual(results.map((result) => result.result.output), ["done A", "done B"]);
    assert.equal(permissionPrompts, 1, "parallel subagent batch should ask once");
    assert.equal(starts.length, 2);
    assert.ok(Math.abs(starts[0]! - starts[1]!) < 50, `subagents did not start together: ${starts.join(", ")}`);
    assert.ok(elapsed < 160, `expected ask-mode parallel execution after approval, took ${elapsed}ms`);
});

test("non-subagent calls stay ordered around parallel subagent batches", async () => {
    const events: string[] = [];
    const tools: Array<Tool<any, any>> = [
        {
            name: "first_tool",
            definition: { type: "function", name: "first_tool", parameters: {} } as any,
            execute: async () => {
                events.push("first");
                return { output: "first" };
            },
        },
        {
            name: "spawn_subagent",
            definition: { type: "function", name: "spawn_subagent", parameters: {} } as any,
            execute: async (args) => {
                events.push(`sub-start-${args.task}`);
                await delay(20);
                events.push(`sub-end-${args.task}`);
                return { output: `sub ${args.task}` };
            },
        },
        {
            name: "last_tool",
            definition: { type: "function", name: "last_tool", parameters: {} } as any,
            execute: async () => {
                events.push("last");
                return { output: "last" };
            },
        },
    ];

    const results = await executeLocalToolCalls([
        makeFunctionCall("first_tool", "call-first"),
        makeFunctionCall("spawn_subagent", "call-a", { task: "A" }),
        makeFunctionCall("spawn_subagent", "call-b", { task: "B" }),
        makeFunctionCall("last_tool", "call-last"),
    ], tools, createNoopUi(), { permissionMode: "full-access" });

    assert.deepEqual(results.map((result) => result.toolCall.call_id), ["call-first", "call-a", "call-b", "call-last"]);
    assert.deepEqual(results.map((result) => result.result.output), ["first", "sub A", "sub B", "last"]);
    assert.equal(events[0], "first");
    assert.ok(events.indexOf("sub-start-A") > events.indexOf("first"));
    assert.ok(events.indexOf("sub-start-B") > events.indexOf("first"));
    assert.equal(events[events.length - 1], "last");
});
