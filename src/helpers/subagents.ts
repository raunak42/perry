import type OpenAI from "openai";
import type { ReasoningLevel } from "./models";
import type { PermissionMode } from "./permissions";
import type { Tool, ToolExecutionOptions, ToolExecutionResult } from "../tools/types";
import type { SubagentTraceDetails } from "../tools/traceDetails";

export const SPAWN_SUBAGENT_TOOL_NAME = "spawn_subagent";
export const DEFAULT_SUBAGENT_REASONING_LEVEL: ReasoningLevel = "medium";
export const DEFAULT_SUBAGENT_MAX_TURNS = 8;
export const MAX_SUBAGENT_MAX_TURNS = 12;
export const MAX_SUBAGENT_DEPTH = 2;

export interface SpawnSubagentArgs {
    task: string;
    context?: string;
    maxTurns: number;
}

export interface RunSubagentParams extends SpawnSubagentArgs {
    depth: number;
}

export const SPAWN_SUBAGENT_TOOL_DEFINITION: OpenAI.Responses.FunctionTool = {
    type: "function",
    name: SPAWN_SUBAGENT_TOOL_NAME,
    description: "Spawn a generic Perry subagent to handle an assigned task in an isolated context. For independent subtasks, emit multiple spawn_subagent calls in the same response so Perry can run them in parallel. The subagent inherits Perry's current permissions and can use the same tools subject to those permissions.",
    parameters: {
        type: "object",
        properties: {
            task: {
                type: "string",
                description: "The concrete task the subagent should complete. Include the expected final deliverable.",
            },
            context: {
                type: ["string", "null"],
                description: "Optional relevant context, constraints, files, prior findings, or user preferences for the subagent.",
            },
            maxTurns: {
                type: ["number", "null"],
                description: `Optional maximum model/tool-loop turns for the subagent. Defaults to ${DEFAULT_SUBAGENT_MAX_TURNS}; capped at ${MAX_SUBAGENT_MAX_TURNS}.`,
            },
        },
        required: ["task", "context", "maxTurns"],
        additionalProperties: false,
    },
    strict: true,
};

function requireRecord(value: unknown, toolName: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${toolName} arguments must be an object.`);
    }
    return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, label: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`${label} must be a non-empty string.`);
    }
    return value.trim();
}

function normalizeMaxTurns(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return DEFAULT_SUBAGENT_MAX_TURNS;
    }
    return Math.max(1, Math.min(MAX_SUBAGENT_MAX_TURNS, Math.floor(value)));
}

export function normalizeSpawnSubagentArgs(args: unknown): SpawnSubagentArgs {
    const record = requireRecord(args, SPAWN_SUBAGENT_TOOL_NAME);
    const task = requireNonEmptyString(record.task, "task");
    const context = typeof record.context === "string" && record.context.trim().length > 0
        ? record.context.trim()
        : undefined;
    const maxTurns = normalizeMaxTurns(record.maxTurns);
    return { task, context, maxTurns };
}

export function resolveSubagentReasoningLevel(availableLevels: ReasoningLevel[], desired: ReasoningLevel): ReasoningLevel {
    if (availableLevels.includes(desired)) return desired;
    if (availableLevels.includes(DEFAULT_SUBAGENT_REASONING_LEVEL)) return DEFAULT_SUBAGENT_REASONING_LEVEL;
    if (availableLevels.includes("high")) return "high";
    return availableLevels[0] ?? DEFAULT_SUBAGENT_REASONING_LEVEL;
}

export function buildSubagentInstructions(baseInstructions: string, options: {
    depth: number;
    maxDepth?: number;
    permissionMode: PermissionMode;
    planMode: boolean;
    subagentsMode: boolean;
    reasoningLevel: ReasoningLevel;
}): string {
    const maxDepth = options.maxDepth ?? MAX_SUBAGENT_DEPTH;
    return [
        baseInstructions,
        "<subagent_mode>",
        "You are a Perry subagent running inside an isolated model/tool loop for the main Perry agent.",
        "You are generic: complete the task assigned by the main agent, not a predefined role.",
        "If you need several independent investigations, request multiple spawn_subagent calls in the same assistant turn instead of doing them one at a time; Perry can run those sibling subagents in parallel.",
        "You may use the same tools as Perry, subject to the inherited permission mode and any active plan-mode restrictions.",
        `Inherited permission mode: ${options.permissionMode}.`,
        `Subagents mode: ${options.subagentsMode ? "enabled" : "disabled"}.`,
        `Subagent thinking level for this run: ${options.reasoningLevel}.`,
        options.planMode
            ? "Plan mode is active: do not modify files, create files, delete files, install packages, or perform side-effecting actions."
            : "Plan mode is not active: file changes and commands are governed by the inherited permission mode.",
        `Subagent nesting depth: ${options.depth}/${maxDepth}. Do not spawn another subagent unless it is clearly useful and within the available tool constraints.`,
        "Return a concise final report to the main agent with findings, actions taken, files touched if any, and recommended next steps.",
        "Do not ask the user plain-text questions unless absolutely necessary; prefer completing the assigned task with the available context.",
        "</subagent_mode>",
    ].join("\n");
}

export function buildSubagentUserPrompt(args: SpawnSubagentArgs): string {
    return [
        "Subagent task:",
        args.task,
        args.context ? "\nContext from main Perry:\n" + args.context : "",
        "\nReturn your final result as a concise report for the main Perry agent.",
    ].filter((part) => part.length > 0).join("\n");
}

function getProviderFunctionToolName(tool: unknown): string | null {
    if (!tool || typeof tool !== "object" || !("type" in tool) || !("name" in tool)) return null;
    const type = (tool as { type?: unknown }).type;
    const name = (tool as { name?: unknown }).name;
    return type === "function" && typeof name === "string" ? name : null;
}

export function isSpawnSubagentToolName(toolName: string): boolean {
    return toolName === SPAWN_SUBAGENT_TOOL_NAME;
}

export function filterLocalToolsForSubagentsMode<T extends { name: string }>(tools: T[], subagentsMode: boolean): T[] {
    return subagentsMode ? tools : tools.filter((tool) => !isSpawnSubagentToolName(tool.name));
}

export function filterProviderToolsForSubagentsMode<T>(tools: T[], subagentsMode: boolean): T[] {
    if (subagentsMode) return tools;
    return tools.filter((tool) => getProviderFunctionToolName(tool) !== SPAWN_SUBAGENT_TOOL_NAME);
}

export function createSpawnSubagentTool(params: {
    run: (args: RunSubagentParams, options?: ToolExecutionOptions<SubagentTraceDetails>) => Promise<ToolExecutionResult<SubagentTraceDetails>>;
    depth?: number;
}): Tool<unknown, SubagentTraceDetails> {
    const depth = params.depth ?? 0;
    return {
        name: SPAWN_SUBAGENT_TOOL_NAME,
        definition: SPAWN_SUBAGENT_TOOL_DEFINITION,
        execute: async (args, options): Promise<ToolExecutionResult<SubagentTraceDetails>> => {
            const normalized = normalizeSpawnSubagentArgs(args);
            const nextDepth = depth + 1;
            return params.run({ ...normalized, depth: nextDepth }, options);
        },
    };
}
