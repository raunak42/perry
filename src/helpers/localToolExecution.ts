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
import type { Tool } from "../tools/types";
import type { InteractiveUi } from "../ui/types";

function formatToolExecutionError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export async function executeLocalToolCall(
    toolCall: Extract<ResponseOutputItem, { type: "function_call" }>,
    localTools: Array<Tool<any, any>>,
    ui: InteractiveUi,
    options: { planMode?: boolean; permissionMode?: PermissionMode; promptForPermission?: (evaluation: PermissionEvaluation) => Promise<boolean>; signal?: AbortSignal } = {},
): Promise<{ output: string; modelOutput?: ResponseInputItem.FunctionCallOutput["output"]; isError: boolean; details?: unknown }> {
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

    const permission = evaluateToolPermission({
        mode: options.permissionMode ?? "ask",
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

    if (permission.action === "ask") {
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
