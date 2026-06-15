import type { ResponseInputItem, ResponseOutputItem } from "openai/resources/responses/responses";
import {
    getPlanModeBlockedCommandReason,
    isLocalToolAllowedInPlanMode,
} from "./planMode";
import {
    evaluateToolPermission,
    type PermissionEvaluation,
    type PermissionMode,
} from "./permissions";
import { isAbortError, throwIfAborted } from "./runtimeFormatting";
import { SPAWN_SUBAGENT_TOOL_NAME } from "./subagents";
import type { Tool } from "../tools/types";
import type { InteractiveUi } from "../ui/types";

function formatToolExecutionError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

type LocalFunctionCall = Extract<ResponseOutputItem, { type: "function_call" }>;

export type LocalToolExecutionOptions = {
    planMode?: boolean;
    permissionMode?: PermissionMode;
    getPermissionMode?: () => PermissionMode;
    promptForPermission?: (evaluation: PermissionEvaluation) => Promise<boolean>;
    skipPermission?: boolean;
    autoApprovePermissionPrompts?: boolean;
    signal?: AbortSignal;
    onParallelSubagentsStart?: (count: number) => void;
    onParallelSubagentsEnd?: () => void;
};

export type LocalToolExecutionResult = {
    output: string;
    modelOutput?: ResponseInputItem.FunctionCallOutput["output"];
    isError: boolean;
    details?: unknown;
};

function isSpawnSubagentCall(toolCall: LocalFunctionCall | undefined): boolean {
    return toolCall?.name === SPAWN_SUBAGENT_TOOL_NAME;
}

export type ExecutedLocalToolCall = {
    toolCall: LocalFunctionCall;
    result: LocalToolExecutionResult;
};

export async function executeLocalToolCall(
    toolCall: LocalFunctionCall,
    localTools: Array<Tool<any, any>>,
    ui: InteractiveUi,
    options: LocalToolExecutionOptions = {},
): Promise<LocalToolExecutionResult> {
    let args: unknown;

    try {
        throwIfAborted(options.signal);
        args = JSON.parse(toolCall.arguments);
    } catch (error) {
        const message = `Invalid tool arguments for ${toolCall.name}: ${formatToolExecutionError(error)}`;
        ui.showToolCall(toolCall.call_id, toolCall.name, undefined, "error", message);
        ui.finishToolExecution(toolCall.call_id, message, true);
        return {
            output: message,
            isError: true,
        };
    }

    ui.showToolCall(toolCall.call_id, toolCall.name, args, "pending");
    ui.startToolExecution(toolCall.call_id);

    const tool = localTools.find((candidate) => candidate.name === toolCall.name);
    if (!tool) {
        const message = `Unknown local tool: ${toolCall.name}`;
        ui.finishToolExecution(toolCall.call_id, message, true);
        return {
            output: message,
            isError: true,
        };
    }

    if (options.planMode && !isLocalToolAllowedInPlanMode(tool.name)) {
        const message = `Blocked in plan mode: ${tool.name} is not allowed. Plan mode only permits read-only inspection tools.`;
        ui.finishToolExecution(toolCall.call_id, message, true);
        return {
            output: message,
            isError: true,
        };
    }

    if (options.planMode && tool.name === "run_command") {
        const command = args && typeof args === "object" && "command" in args
            ? (args as { command?: unknown }).command
            : undefined;
        const blockedReason = typeof command === "string" ? getPlanModeBlockedCommandReason(command) : "missing shell command";
        if (blockedReason) {
            const message = `Blocked in plan mode: ${blockedReason}. Plan mode only permits read-only inspection commands.`;
            ui.finishToolExecution(toolCall.call_id, message, true);
            return {
                output: message,
                isError: true,
            };
        }
    }

    if (!options.skipPermission) {
        const permission = evaluateToolPermission({
            mode: options.getPermissionMode?.() ?? options.permissionMode ?? "ask",
            toolName: tool.name,
            args,
            cwd: process.cwd(),
            planMode: !!options.planMode,
        });

        if (permission.action === "deny") {
            const message = `Blocked by permissions: ${permission.reason}.`;
            ui.finishToolExecution(toolCall.call_id, message, true);
            return {
                output: message,
                isError: true,
            };
        }

        if (permission.action === "ask" && !options.autoApprovePermissionPrompts) {
            const approved = await options.promptForPermission?.(permission);
            if (!approved) {
                const message = `Denied by user: ${permission.summary}.`;
                ui.finishToolExecution(toolCall.call_id, message, true);
                return {
                    output: message,
                    isError: true,
                };
            }
        }
    }

    try {
        throwIfAborted(options.signal);
        const result = await tool.execute(args as never, {
            signal: options.signal,
            onUpdate: (update) => {
                ui.updateToolExecution(toolCall.call_id, update.output, !!update.isError, update.details);
            },
        });
        ui.finishToolExecution(toolCall.call_id, result.output, !!result.isError, result.details);
        return {
            output: result.output,
            modelOutput: result.modelOutput as ResponseInputItem.FunctionCallOutput["output"] | undefined,
            isError: !!result.isError,
            details: result.details,
        };
    } catch (error) {
        const message = isAbortError(error) ? "Process terminated." : formatToolExecutionError(error);
        ui.finishToolExecution(toolCall.call_id, message, true);
        return {
            output: message,
            isError: true,
        };
    }
}

export async function executeLocalToolCalls(
    toolCalls: LocalFunctionCall[],
    localTools: Array<Tool<any, any>>,
    ui: InteractiveUi,
    options: LocalToolExecutionOptions = {},
): Promise<ExecutedLocalToolCall[]> {
    const executed: ExecutedLocalToolCall[] = new Array(toolCalls.length);
    let index = 0;

    while (index < toolCalls.length) {
        throwIfAborted(options.signal);
        const current = toolCalls[index];
        if (!current) break;

        if (!isSpawnSubagentCall(current)) {
            ui.setStatus(`Running tool: ${current.name}`);
            const result = await executeLocalToolCall(current, localTools, ui, options);
            throwIfAborted(options.signal);
            executed[index] = { toolCall: current, result };
            index += 1;
            continue;
        }

        const startIndex = index;
        while (index < toolCalls.length && isSpawnSubagentCall(toolCalls[index])) {
            index += 1;
        }

        const group = toolCalls.slice(startIndex, index);
        const permissionResults: Array<{ toolCall: LocalFunctionCall; allowed: boolean; message?: string }> = [];
        for (const toolCall of group) {
            let args: unknown;
            try {
                throwIfAborted(options.signal);
                args = JSON.parse(toolCall.arguments);
            } catch (error) {
                permissionResults.push({
                    toolCall,
                    allowed: false,
                    message: `Invalid tool arguments for ${toolCall.name}: ${formatToolExecutionError(error)}`,
                });
                continue;
            }

            const permission = evaluateToolPermission({
                mode: options.getPermissionMode?.() ?? options.permissionMode ?? "ask",
                toolName: SPAWN_SUBAGENT_TOOL_NAME,
                args,
                cwd: process.cwd(),
                planMode: !!options.planMode,
            });

            if (permission.action === "deny") {
                permissionResults.push({ toolCall, allowed: false, message: `Blocked by permissions: ${permission.reason}.` });
                continue;
            }

            if (permission.action === "ask" && !options.autoApprovePermissionPrompts) {
                const approved = await options.promptForPermission?.(permission);
                if (!approved) {
                    permissionResults.push({ toolCall, allowed: false, message: `Denied by user: ${permission.summary}.` });
                    continue;
                }
            }

            permissionResults.push({ toolCall, allowed: true });
        }

        const allowedGroup = permissionResults.filter((result) => result.allowed).map((result) => result.toolCall);
        for (let groupOffset = 0; groupOffset < group.length; groupOffset += 1) {
            const toolCall = group[groupOffset]!;
            const denied = permissionResults.find((result) => result.toolCall === toolCall && !result.allowed);
            if (!denied) continue;
            const message = denied.message ?? `Denied by user: ${toolCall.name}.`;
            ui.showToolCall(toolCall.call_id, toolCall.name, undefined, "error", message);
            ui.finishToolExecution(toolCall.call_id, message, true);
            executed[startIndex + groupOffset] = { toolCall, result: { output: message, isError: true } };
        }

        if (allowedGroup.length === 0) continue;

        const count = allowedGroup.length;
        ui.setStatus(count === 1 ? "Waiting for subagent" : `Waiting for ${count} subagents`);
        options.onParallelSubagentsStart?.(count);
        try {
            const groupResults = await Promise.all(allowedGroup.map(async (toolCall) => {
                throwIfAborted(options.signal);
                const result = await executeLocalToolCall(toolCall, localTools, ui, { ...options, skipPermission: true });
                throwIfAborted(options.signal);
                return { index: toolCalls.indexOf(toolCall), toolCall, result };
            }));

            for (const groupResult of groupResults) {
                executed[groupResult.index] = {
                    toolCall: groupResult.toolCall,
                    result: groupResult.result,
                };
            }
        } finally {
            options.onParallelSubagentsEnd?.();
        }
    }

    return executed;
}
