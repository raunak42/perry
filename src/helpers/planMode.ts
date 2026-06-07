import type OpenAI from "openai";
import { SPAWN_SUBAGENT_TOOL_NAME } from "./subagents";
import type { ChoiceOption } from "../ui/types";
import type { Tool, ToolExecutionResult } from "../tools/types";

export const PLAN_CHOICE_TOOL_NAME = "plan_choice";
export const PLAN_COMPLETE_TOOL_NAME = "plan_complete";

export type PlanCompletionAction = "start_work" | "revise_plan" | "cancel";

export interface PlanChoiceSelection {
    question: string;
    selected: {
        label: string;
        value: string;
        description?: string;
    };
}

export interface PlanCompleteSelection {
    action: PlanCompletionAction;
    actionLabel: string;
    plan: string;
    summary?: string;
}

export type PlanInteractionToolDetails =
    | ({ type: "plan_choice" } & PlanChoiceSelection)
    | ({ type: "plan_complete" } & PlanCompleteSelection);

export const PLAN_MODE_DEVELOPER_INSTRUCTIONS = `
<plan_mode>
Plan mode is active.

Rules:
- Planning only: do not modify files, create files, delete files, install packages, or perform side-effecting actions.
- Use only read-only inspection tools that are currently available, such as read, read-only run_command calls, web_search, and subagents that obey these same plan-mode restrictions.
- Think through the task and inspect relevant files before proposing implementation details when useful.
- Ask for the user's opinion with the ${PLAN_CHOICE_TOOL_NAME} tool whenever there are meaningful product, UX, architecture, safety, or trade-off decisions.
- Ask one focused ${PLAN_CHOICE_TOOL_NAME} question at a time. Give concrete options with clear labels and short descriptions. Do not ask unnecessary questions.
- Perry will also provide an "Other / write my own" path for ${PLAN_CHOICE_TOOL_NAME} questions, so the user can give custom input when none of the listed options fit.
- ${PLAN_CHOICE_TOOL_NAME} returns the user's selected option or custom answer to this same running tool loop; continue planning immediately using that answer.
- Do not ask plain-text approval questions when a TUI choice is appropriate.
- When enough user input has been collected, call ${PLAN_COMPLETE_TOOL_NAME} with the final plan. It will show the plan and ask the user to Start work, Revise plan, or Cancel.
- If the user chooses Start work, Perry will leave plan mode and execute the approved plan automatically. Do not claim that code changes were made during planning.
</plan_mode>
`.trim();

export const PLAN_MODE_EXECUTION_PROMPT = "Proceed with the approved plan.";

const PLAN_MODE_INTERACTION_TOOLS = new Set([PLAN_CHOICE_TOOL_NAME, PLAN_COMPLETE_TOOL_NAME]);
const PLAN_MODE_ALLOWED_LOCAL_TOOLS = new Set(["read", "run_command", SPAWN_SUBAGENT_TOOL_NAME, PLAN_CHOICE_TOOL_NAME, PLAN_COMPLETE_TOOL_NAME]);
const PLAN_MODE_ALLOWED_PROVIDER_TOOL_TYPES = new Set(["web_search"]);

export const PLAN_CHOICE_TOOL_DEFINITION: OpenAI.Responses.FunctionTool = {
    type: "function",
    name: PLAN_CHOICE_TOOL_NAME,
    description: "Ask the user a multiple-choice planning question in the TUI and return the selected option. Use only during plan mode.",
    parameters: {
        type: "object",
        properties: {
            question: {
                type: "string",
                description: "The focused planning question to ask the user.",
            },
            options: {
                type: "array",
                description: "Concrete choices for the user. Prefer 2-5 options.",
                minItems: 2,
                maxItems: 8,
                items: {
                    type: "object",
                    properties: {
                        label: {
                            type: "string",
                            description: "Short option label shown in the TUI.",
                        },
                        value: {
                            type: "string",
                            description: "Stable machine-readable value for this option.",
                        },
                        description: {
                            type: ["string", "null"],
                            description: "Short explanation of the trade-off, or null.",
                        },
                    },
                    required: ["label", "value", "description"],
                    additionalProperties: false,
                },
            },
            initialValue: {
                type: ["string", "null"],
                description: "The option value that should be selected initially, or null.",
            },
        },
        required: ["question", "options", "initialValue"],
        additionalProperties: false,
    },
    strict: true,
};

export const PLAN_COMPLETE_TOOL_DEFINITION: OpenAI.Responses.FunctionTool = {
    type: "function",
    name: PLAN_COMPLETE_TOOL_NAME,
    description: "Present the final plan in the TUI and ask whether to start work, revise the plan, or cancel. Use only during plan mode.",
    parameters: {
        type: "object",
        properties: {
            plan: {
                type: "string",
                description: "The complete proposed implementation plan, including key files/areas and ordered steps.",
            },
            summary: {
                type: ["string", "null"],
                description: "One-line summary of the plan, or null.",
            },
        },
        required: ["plan", "summary"],
        additionalProperties: false,
    },
    strict: true,
};

const PLAN_COMPLETE_OPTIONS: Array<ChoiceOption<PlanCompletionAction>> = [
    {
        label: "Start work",
        value: "start_work",
        description: "Approve this plan and let Perry implement it now",
    },
    {
        label: "Revise plan",
        value: "revise_plan",
        description: "Keep planning and adjust the proposal",
    },
    {
        label: "Cancel / stay in plan mode",
        value: "cancel",
        description: "Do not execute this plan",
    },
];

export function buildInstructionsForPlanMode(baseInstructions: string, planMode: boolean): string {
    return planMode
        ? `${baseInstructions}\n\n${PLAN_MODE_DEVELOPER_INSTRUCTIONS}`
        : baseInstructions;
}

export function buildPlanModeDeveloperMessages(planMode: boolean): Array<{ role: "developer"; content: string }> {
    return planMode
        ? [{ role: "developer", content: PLAN_MODE_DEVELOPER_INSTRUCTIONS }]
        : [];
}

export function buildPlanModeExecutionPrompt(plan?: string): string {
    const trimmedPlan = plan?.trim();
    if (!trimmedPlan) return PLAN_MODE_EXECUTION_PROMPT;
    return `${PLAN_MODE_EXECUTION_PROMPT}\n\nApproved plan:\n${trimmedPlan}`;
}

export function isLocalToolAllowedInPlanMode(toolName: string): boolean {
    return PLAN_MODE_ALLOWED_LOCAL_TOOLS.has(toolName);
}

export function isPlanInteractionToolName(toolName: string): boolean {
    return PLAN_MODE_INTERACTION_TOOLS.has(toolName);
}

export function filterLocalToolsForPlanMode<T extends { name: string }>(tools: T[], planMode: boolean): T[] {
    if (!planMode) return tools.filter((tool) => !isPlanInteractionToolName(tool.name));
    return tools.filter((tool) => isLocalToolAllowedInPlanMode(tool.name));
}

function getToolType(tool: unknown): string | null {
    if (!tool || typeof tool !== "object" || !("type" in tool)) return null;
    const type = (tool as { type?: unknown }).type;
    return typeof type === "string" ? type : null;
}

function getFunctionToolName(tool: unknown): string | null {
    if (!tool || typeof tool !== "object" || !("name" in tool)) return null;
    const name = (tool as { name?: unknown }).name;
    return typeof name === "string" ? name : null;
}

export function isProviderToolAllowedInPlanMode(tool: unknown): boolean {
    const type = getToolType(tool);
    if (!type) return false;

    if (type === "function") {
        const name = getFunctionToolName(tool);
        return !!name && isLocalToolAllowedInPlanMode(name);
    }

    return PLAN_MODE_ALLOWED_PROVIDER_TOOL_TYPES.has(type);
}

export function filterProviderToolsForPlanMode<T>(tools: T[], planMode: boolean): T[] {
    if (!planMode) {
        return tools.filter((tool) => {
            const type = getToolType(tool);
            if (type !== "function") return true;
            const name = getFunctionToolName(tool);
            return !name || !isPlanInteractionToolName(name);
        });
    }
    return tools.filter((tool) => isProviderToolAllowedInPlanMode(tool));
}

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

function normalizePlanChoiceArgs(args: unknown): {
    question: string;
    options: Array<ChoiceOption<string>>;
    initialValue?: string;
} {
    const record = requireRecord(args, PLAN_CHOICE_TOOL_NAME);
    const question = requireNonEmptyString(record.question, "question");
    if (!Array.isArray(record.options)) {
        throw new Error("options must be an array.");
    }
    if (record.options.length < 2) {
        throw new Error("plan_choice requires at least two options.");
    }
    if (record.options.length > 8) {
        throw new Error("plan_choice supports at most eight options.");
    }

    const seenValues = new Set<string>();
    const options = record.options.map((rawOption, index): ChoiceOption<string> => {
        const option = requireRecord(rawOption, `options[${index}]`);
        const label = requireNonEmptyString(option.label, `options[${index}].label`);
        const value = requireNonEmptyString(option.value, `options[${index}].value`);
        if (seenValues.has(value)) {
            throw new Error(`Duplicate option value '${value}'.`);
        }
        seenValues.add(value);
        const description = typeof option.description === "string" && option.description.trim().length > 0
            ? option.description.trim()
            : undefined;
        return { label, value, description };
    });

    const initialValue = typeof record.initialValue === "string" && seenValues.has(record.initialValue.trim())
        ? record.initialValue.trim()
        : undefined;

    return { question, options, initialValue };
}

function normalizePlanCompleteArgs(args: unknown): { plan: string; summary?: string } {
    const record = requireRecord(args, PLAN_COMPLETE_TOOL_NAME);
    const plan = requireNonEmptyString(record.plan, "plan");
    const summary = typeof record.summary === "string" && record.summary.trim().length > 0
        ? record.summary.trim()
        : undefined;
    return { plan, summary };
}

function buildJsonOutput(value: unknown): string {
    return JSON.stringify(value, null, 2);
}

export function isPlanCompleteSelection(value: unknown): value is PlanCompleteSelection {
    return !!value
        && typeof value === "object"
        && "action" in value
        && ["start_work", "revise_plan", "cancel"].includes(String((value as { action?: unknown }).action))
        && "plan" in value
        && typeof (value as { plan?: unknown }).plan === "string";
}

const PLAN_CUSTOM_CHOICE_VALUE = "__perry_custom_choice__";

export function createPlanModeInteractionTools(params: {
    choose: <T = string>(prompt: string, options: ChoiceOption<T>[], initialValue?: T) => Promise<T>;
    ask?: (prompt: string) => Promise<string>;
}): Array<Tool<unknown, PlanInteractionToolDetails>> {
    const planChoiceTool: Tool<unknown, PlanInteractionToolDetails> = {
        name: PLAN_CHOICE_TOOL_NAME,
        definition: PLAN_CHOICE_TOOL_DEFINITION,
        execute: async (args): Promise<ToolExecutionResult<PlanInteractionToolDetails>> => {
            const normalized = normalizePlanChoiceArgs(args);
            const optionsWithCustom: Array<ChoiceOption<string>> = params.ask
                ? [
                    ...normalized.options,
                    {
                        label: "Other / write my own",
                        value: PLAN_CUSTOM_CHOICE_VALUE,
                        description: "None of these fit; type a custom answer",
                    },
                ]
                : normalized.options;
            const selectedValue = await params.choose<string>(normalized.question, optionsWithCustom, normalized.initialValue);
            const selectedOption = optionsWithCustom.find((option) => option.value === selectedValue) ?? optionsWithCustom[0]!;
            const selection: PlanChoiceSelection = selectedValue === PLAN_CUSTOM_CHOICE_VALUE && params.ask
                ? {
                    question: normalized.question,
                    selected: {
                        label: "Other / custom answer",
                        value: await params.ask(`${normalized.question}\n\nWrite what you want instead.`),
                        description: "Custom user-provided answer",
                    },
                }
                : {
                    question: normalized.question,
                    selected: {
                        label: selectedOption.label,
                        value: selectedOption.value,
                        description: selectedOption.description,
                    },
                };

            return {
                output: buildJsonOutput(selection),
                modelOutput: buildJsonOutput(selection),
                details: {
                    type: "plan_choice",
                    ...selection,
                },
            };
        },
    };

    const planCompleteTool: Tool<unknown, PlanInteractionToolDetails> = {
        name: PLAN_COMPLETE_TOOL_NAME,
        definition: PLAN_COMPLETE_TOOL_DEFINITION,
        execute: async (args): Promise<ToolExecutionResult<PlanInteractionToolDetails>> => {
            const normalized = normalizePlanCompleteArgs(args);
            const prompt = [
                normalized.summary ? `Plan ready: ${normalized.summary}` : "Plan ready. Review it and choose what to do.",
                "",
                normalized.plan,
            ].join("\n");
            const action = await params.choose<PlanCompletionAction>(prompt, PLAN_COMPLETE_OPTIONS, "start_work");
            const selectedAction = PLAN_COMPLETE_OPTIONS.find((option) => option.value === action) ?? PLAN_COMPLETE_OPTIONS[0]!;
            const selection: PlanCompleteSelection = {
                action: selectedAction.value,
                actionLabel: selectedAction.label,
                plan: normalized.plan,
                summary: normalized.summary,
            };

            return {
                output: buildJsonOutput(selection),
                modelOutput: buildJsonOutput(selection),
                details: {
                    type: "plan_complete",
                    ...selection,
                },
            };
        },
    };

    return [planChoiceTool, planCompleteTool];
}

export function getPlanModeBlockedCommandReason(command: string): string | null {
    const normalized = command.trim().toLowerCase();
    if (!normalized) return "empty command";

    if (/(?:^|[\s;|&])(?:\d{0,2})?>\s*(?!&?\d\b|\/dev\/null\b|\/dev\/stdout\b|\/dev\/stderr\b)/.test(command)) {
        return "shell redirection may write files";
    }

    if (/\b(?:sed\s+[^\n]*-i|perl\s+[^\n]*-pi|ruby\s+[^\n]*-pi)\b/i.test(command)) {
        return "in-place editing is not allowed";
    }

    if (/\bfind\b[\s\S]*\s-delete\b/i.test(command)) {
        return "find -delete is not allowed";
    }

    if (/\bgit\s+(?:add|commit|checkout|switch|reset|revert|clean|merge|rebase|cherry-pick|apply|am|stash|tag|branch|restore|push|pull|fetch|clone|worktree|submodule|config)\b/i.test(command)) {
        return "mutating git commands are not allowed";
    }

    if (/\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add|remove|rm|uninstall|update|upgrade|link|publish|audit\s+fix)\b/i.test(command)) {
        return "package-manager mutation is not allowed";
    }

    if (/\b(?:pip|pip3|uv|poetry|cargo|go)\s+(?:install|uninstall|add|remove|update|sync|publish|get|mod\s+tidy)\b/i.test(command)) {
        return "dependency or environment mutation is not allowed";
    }

    if (/\b(?:rm|rmdir|mv|cp|mkdir|touch|chmod|chown|chgrp|ln|truncate|dd|rsync|install|tee|sponge)\b/i.test(command)) {
        return "file-changing shell commands are not allowed";
    }

    if (/\b(?:python(?:3)?|node|bun)\b[\s\S]*(?:write_text|write_bytes|\.write\(|writefilesync|writefile|appendfilesync|appendfile|createwritestream|truncate|truncatesync|open\([^\n]*,[^\n]*["'](?:w|a|x|wb|ab|xb)["'])/i.test(command)) {
        return "script appears to write files";
    }

    return null;
}

export function isPlanApprovalInput(input: string): boolean {
    const normalized = input
        .trim()
        .toLowerCase()
        .replace(/[.!?]+$/g, "")
        .replace(/\s+/g, " ");

    return [
        "proceed",
        "go ahead",
        "do it",
        "execute",
        "accept",
        "approved",
        "looks good",
        "ship it",
    ].includes(normalized);
}
