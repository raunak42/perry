import assert from "node:assert/strict";
import { test } from "bun:test";
import {
    buildInstructionsForPlanMode,
    buildPlanModeExecutionPrompt,
    createPlanModeInteractionTools,
    filterLocalToolsForPlanMode,
    filterProviderToolsForPlanMode,
    getPlanModeBlockedCommandReason,
    isLocalToolAllowedInPlanMode,
    isPlanApprovalInput,
    isPlanCompleteSelection,
    PLAN_CHOICE_TOOL_NAME,
    PLAN_COMPLETE_TOOL_NAME,
    PLAN_MODE_DEVELOPER_INSTRUCTIONS,
} from "../src/helpers/planMode";
import { SPAWN_SUBAGENT_TOOL_NAME } from "../src/helpers/subagents";

test("plan mode appends planning-only instructions", () => {
    const instructions = buildInstructionsForPlanMode("base", true);

    assert.match(instructions, /^base\n\n/);
    assert.match(instructions, /Plan mode is active/);
    assert.match(instructions, /do not modify files/);
    assert.match(instructions, /plan_choice/);
    assert.match(instructions, /plan_complete/);
    assert.equal(buildInstructionsForPlanMode("base", false), "base");
    assert.equal(instructions.includes(PLAN_MODE_DEVELOPER_INSTRUCTIONS), true);
});

test("plan mode exposes read-only local tools plus interaction tools", () => {
    const localTools = [
        { name: "read" },
        { name: "write" },
        { name: "edit" },
        { name: "run_command" },
        { name: SPAWN_SUBAGENT_TOOL_NAME },
        { name: PLAN_CHOICE_TOOL_NAME },
        { name: PLAN_COMPLETE_TOOL_NAME },
    ];

    assert.equal(isLocalToolAllowedInPlanMode("read"), true);
    assert.equal(isLocalToolAllowedInPlanMode("run_command"), true);
    assert.equal(isLocalToolAllowedInPlanMode(SPAWN_SUBAGENT_TOOL_NAME), true);
    assert.equal(isLocalToolAllowedInPlanMode(PLAN_CHOICE_TOOL_NAME), true);
    assert.equal(isLocalToolAllowedInPlanMode(PLAN_COMPLETE_TOOL_NAME), true);
    assert.equal(isLocalToolAllowedInPlanMode("write"), false);
    assert.deepEqual(filterLocalToolsForPlanMode(localTools, true).map((tool) => tool.name), ["read", "run_command", SPAWN_SUBAGENT_TOOL_NAME, PLAN_CHOICE_TOOL_NAME, PLAN_COMPLETE_TOOL_NAME]);
    assert.deepEqual(filterLocalToolsForPlanMode(localTools, false).map((tool) => tool.name), ["read", "write", "edit", "run_command", SPAWN_SUBAGENT_TOOL_NAME]);
});

test("plan mode filters provider tools to read, web search, and interaction tools", () => {
    const tools = [
        { type: "function", name: "read" },
        { type: "function", name: "write" },
        { type: "function", name: "edit" },
        { type: "function", name: "run_command" },
        { type: "function", name: SPAWN_SUBAGENT_TOOL_NAME },
        { type: "function", name: PLAN_CHOICE_TOOL_NAME },
        { type: "function", name: PLAN_COMPLETE_TOOL_NAME },
        { type: "web_search" },
        { type: "code_interpreter" },
    ];

    assert.deepEqual(filterProviderToolsForPlanMode(tools, true), [
        { type: "function", name: "read" },
        { type: "function", name: "run_command" },
        { type: "function", name: SPAWN_SUBAGENT_TOOL_NAME },
        { type: "function", name: PLAN_CHOICE_TOOL_NAME },
        { type: "function", name: PLAN_COMPLETE_TOOL_NAME },
        { type: "web_search" },
    ]);
    assert.deepEqual(filterProviderToolsForPlanMode(tools, false), [
        { type: "function", name: "read" },
        { type: "function", name: "write" },
        { type: "function", name: "edit" },
        { type: "function", name: "run_command" },
        { type: "function", name: SPAWN_SUBAGENT_TOOL_NAME },
        { type: "web_search" },
        { type: "code_interpreter" },
    ]);
});

test("plan mode blocks likely mutating shell commands", () => {
    assert.equal(getPlanModeBlockedCommandReason("ls src && rg planMode src"), null);
    assert.match(getPlanModeBlockedCommandReason("touch foo") ?? "", /file-changing/);
    assert.match(getPlanModeBlockedCommandReason("git checkout -b plan-mode") ?? "", /mutating git/);
    assert.match(getPlanModeBlockedCommandReason("echo hi > file.txt") ?? "", /redirection/);
    assert.match(getPlanModeBlockedCommandReason("npm install") ?? "", /package-manager/);
});

test("plan_choice asks through chooser and returns selected option", async () => {
    const prompts: string[] = [];
    const tools = createPlanModeInteractionTools({
        choose: async <T = string>(prompt: string, options: Array<{ value: T }>): Promise<T> => {
            prompts.push(prompt);
            assert.deepEqual(options.map((option) => option.value), ["permissions", "mcp"]);
            return "mcp" as T;
        },
    });
    const tool = tools.find((candidate) => candidate.name === PLAN_CHOICE_TOOL_NAME);
    assert.ok(tool);

    const result = await tool.execute({
        question: "What should come next?",
        options: [
            { label: "Permissions", value: "permissions", description: "Build the safety layer" },
            { label: "MCP", value: "mcp", description: "Add external tools" },
        ],
        initialValue: null,
    });

    assert.deepEqual(prompts, ["What should come next?"]);
    assert.equal(result.isError, undefined);
    assert.match(result.output, /"value": "mcp"/);
    assert.deepEqual(result.details, {
        type: "plan_choice",
        question: "What should come next?",
        selected: {
            label: "MCP",
            value: "mcp",
            description: "Add external tools",
        },
    });
});

test("plan_choice supports custom user answers", async () => {
    const tools = createPlanModeInteractionTools({
        choose: async <T = string>(_prompt: string, options: Array<{ value: T }>): Promise<T> => {
            assert.deepEqual(options.map((option) => option.value), ["permissions", "mcp", "__perry_custom_choice__"]);
            return "__perry_custom_choice__" as T;
        },
        ask: async (prompt: string): Promise<string> => {
            assert.match(prompt, /What should come next/);
            return "Build checkpoint rewind first";
        },
    });
    const tool = tools.find((candidate) => candidate.name === PLAN_CHOICE_TOOL_NAME);
    assert.ok(tool);

    const result = await tool.execute({
        question: "What should come next?",
        options: [
            { label: "Permissions", value: "permissions", description: "Build the safety layer" },
            { label: "MCP", value: "mcp", description: "Add external tools" },
        ],
        initialValue: null,
    });

    assert.deepEqual(result.details, {
        type: "plan_choice",
        question: "What should come next?",
        selected: {
            label: "Other / custom answer",
            value: "Build checkpoint rewind first",
            description: "Custom user-provided answer",
        },
    });
});

test("plan_complete returns start-work approval details", async () => {
    const tools = createPlanModeInteractionTools({
        choose: async <T = string>(prompt: string, options: Array<{ value: T }>, initialValue?: T): Promise<T> => {
            assert.match(prompt, /Plan ready/);
            assert.match(prompt, /Implement permissions/);
            assert.deepEqual(options.map((option) => option.value), ["start_work", "revise_plan", "cancel"]);
            assert.equal(initialValue, "start_work");
            return "start_work" as T;
        },
    });
    const tool = tools.find((candidate) => candidate.name === PLAN_COMPLETE_TOOL_NAME);
    assert.ok(tool);

    const result = await tool.execute({
        plan: "1. Implement permissions\n2. Add tests",
        summary: "Implement permissions",
    });

    assert.equal(isPlanCompleteSelection(result.details), true);
    assert.deepEqual(result.details, {
        type: "plan_complete",
        action: "start_work",
        actionLabel: "Start work",
        plan: "1. Implement permissions\n2. Add tests",
        summary: "Implement permissions",
    });
});

test("plan mode execution prompt can include approved plan", () => {
    assert.equal(buildPlanModeExecutionPrompt(), "Proceed with the approved plan.");
    assert.match(buildPlanModeExecutionPrompt("1. Edit src/index.ts"), /Approved plan:\n1\. Edit src\/index\.ts/);
});

test("common approval replies are accepted", () => {
    assert.equal(isPlanApprovalInput("proceed"), true);
    assert.equal(isPlanApprovalInput("Go ahead!"), true);
    assert.equal(isPlanApprovalInput("looks good"), true);
    assert.equal(isPlanApprovalInput("please proceed after updating tests"), false);
});
