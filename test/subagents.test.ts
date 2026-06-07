import assert from "node:assert/strict";
import { test } from "bun:test";
import {
    buildSubagentInstructions,
    buildSubagentUserPrompt,
    createSpawnSubagentTool,
    DEFAULT_SUBAGENT_REASONING_LEVEL,
    normalizeSpawnSubagentArgs,
    resolveSubagentReasoningLevel,
} from "../src/helpers/subagents";

test("normalizes spawn_subagent arguments", () => {
    assert.deepEqual(normalizeSpawnSubagentArgs({
        task: " Investigate failing tests ",
        context: " src/index.ts ",
        maxTurns: 99,
    }), {
        task: "Investigate failing tests",
        context: "src/index.ts",
        maxTurns: 12,
    });

    assert.deepEqual(normalizeSpawnSubagentArgs({ task: "Check docs", context: null, maxTurns: null }), {
        task: "Check docs",
        context: undefined,
        maxTurns: 8,
    });

    assert.throws(() => normalizeSpawnSubagentArgs({ task: "", context: null, maxTurns: 1 }), /task/);
});

test("resolves subagent thinking level with medium default", () => {
    assert.equal(DEFAULT_SUBAGENT_REASONING_LEVEL, "medium");
    assert.equal(resolveSubagentReasoningLevel(["off", "low", "medium", "high"], "medium"), "medium");
    assert.equal(resolveSubagentReasoningLevel(["off", "low", "high"], "medium"), "high");
    assert.equal(resolveSubagentReasoningLevel(["off"], "medium"), "off");
});

test("subagent instructions include inherited mode and plan restrictions", () => {
    const instructions = buildSubagentInstructions("base", {
        depth: 1,
        permissionMode: "full-access",
        planMode: true,
        subagentsMode: true,
        reasoningLevel: "medium",
    });

    assert.match(instructions, /^base\n<subagent_mode>/);
    assert.match(instructions, /Inherited permission mode: full-access/);
    assert.match(instructions, /Subagent thinking level for this run: medium/);
    assert.match(instructions, /Plan mode is active/);
});

test("subagent user prompt includes task and optional context", () => {
    const prompt = buildSubagentUserPrompt({ task: "Review API", context: "Focus on auth", maxTurns: 3 });
    assert.match(prompt, /Subagent task:\nReview API/);
    assert.match(prompt, /Context from main Perry:\nFocus on auth/);
});

test("spawn_subagent tool delegates with incremented depth", async () => {
    const tool = createSpawnSubagentTool({
        depth: 1,
        run: async (args) => ({
            output: `${args.depth}:${args.task}:${args.maxTurns}`,
            details: {
                type: "subagent",
                task: args.task,
                maxTurns: args.maxTurns,
                turnsUsed: 1,
                depth: args.depth,
                permissionMode: "ask",
                planMode: false,
                reasoningLevel: "medium",
                output: "ok",
            },
        }),
    });

    const result = await tool.execute({ task: "Do work", context: null, maxTurns: 2 });

    assert.equal(tool.name, "spawn_subagent");
    assert.equal(result.output, "2:Do work:2");
    assert.equal(result.details?.depth, 2);
});
