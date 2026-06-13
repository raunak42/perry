import type { ResponseOutputItem, ResponseStreamEvent } from "openai/resources/responses/responses";
import type {
    CodeInterpreterTraceDetails,
    FileSearchTraceDetails,
    KnownToolTraceDetails,
    LocalShellTraceDetails,
    McpTraceDetails,
    ToolSearchTraceDetails,
    WebSearchTraceDetails,
} from "../tools/traceDetails";
import type { InteractiveUi } from "../ui/types";

export function isFunctionCallItem(item: ResponseOutputItem): item is Extract<ResponseOutputItem, { type: "function_call" }> {
    return item.type === "function_call";
}

export function isReasoningItem(item: ResponseOutputItem): item is Extract<ResponseOutputItem, { type: "reasoning" }> {
    return item.type === "reasoning";
}

function isWebSearchItem(item: ResponseOutputItem): item is Extract<ResponseOutputItem, { type: "web_search_call" }> {
    return item.type === "web_search_call";
}

function isFileSearchItem(item: ResponseOutputItem): item is Extract<ResponseOutputItem, { type: "file_search_call" }> {
    return item.type === "file_search_call";
}

function isCodeInterpreterItem(item: ResponseOutputItem): item is Extract<ResponseOutputItem, { type: "code_interpreter_call" }> {
    return item.type === "code_interpreter_call";
}

function isMcpCallItem(item: ResponseOutputItem): item is Extract<ResponseOutputItem, { type: "mcp_call" }> {
    return item.type === "mcp_call";
}

function isMcpListToolsItem(item: ResponseOutputItem): item is Extract<ResponseOutputItem, { type: "mcp_list_tools" }> {
    return item.type === "mcp_list_tools";
}

function isMcpApprovalRequestItem(item: ResponseOutputItem): item is Extract<ResponseOutputItem, { type: "mcp_approval_request" }> {
    return item.type === "mcp_approval_request";
}

function isLocalShellCallItem(item: ResponseOutputItem): item is Extract<ResponseOutputItem, { type: "local_shell_call" }> {
    return item.type === "local_shell_call";
}

function isLocalShellOutputItem(item: ResponseOutputItem): item is Extract<ResponseOutputItem, { type: "local_shell_call_output" }> {
    return item.type === "local_shell_call_output";
}

function isToolSearchCallItem(item: ResponseOutputItem): item is Extract<ResponseOutputItem, { type: "tool_search_call" }> {
    return item.type === "tool_search_call";
}

function isToolSearchOutputItem(item: ResponseOutputItem): item is Extract<ResponseOutputItem, { type: "tool_search_output" }> {
    return item.type === "tool_search_output";
}

export function createProviderNativeTraceManager(ui: InteractiveUi) {
    type ProviderTraceEntry = {
        toolName: string;
        args?: unknown;
        output: string;
        details?: KnownToolTraceDetails;
    };

    const traces = new Map<string, ProviderTraceEntry>();
    const codeInterpreterCode = new Map<string, string>();
    const mcpArguments = new Map<string, string>();

    const ensureTrace = (
        id: string,
        toolName: string,
        args: unknown,
        status: "pending" | "running" | "complete" | "error" | "aborted",
        output: string,
        details?: KnownToolTraceDetails,
    ): boolean => {
        const existing = traces.get(id);
        if (!existing) {
            ui.showToolCall(id, toolName, args, status, output, details);
            traces.set(id, {
                toolName,
                args,
                output,
                details,
            });
            return true;
        }

        if (args !== undefined) {
            traces.set(id, {
                ...existing,
                args,
            });
        }

        return false;
    };

    const setRunning = (id: string, toolName: string, args?: unknown, details?: KnownToolTraceDetails, output?: string) => {
        const current = traces.get(id);
        const nextEntry: ProviderTraceEntry = {
            toolName,
            args: args ?? current?.args,
            output: output ?? current?.output ?? "",
            details: details ?? current?.details,
        };
        const created = ensureTrace(id, toolName, nextEntry.args, "running", nextEntry.output, nextEntry.details);
        traces.set(id, nextEntry);
        if (!created) {
            ui.updateToolExecution(id, nextEntry.output, false, nextEntry.details);
        }
    };

    const setFinished = (
        id: string,
        toolName: string,
        args?: unknown,
        details?: KnownToolTraceDetails,
        output?: string,
        isError = false,
    ) => {
        const current = traces.get(id);
        const nextEntry: ProviderTraceEntry = {
            toolName,
            args: args ?? current?.args,
            output: output ?? current?.output ?? "",
            details: details ?? current?.details,
        };
        const created = ensureTrace(id, toolName, nextEntry.args, isError ? "error" : "complete", nextEntry.output, nextEntry.details);
        traces.set(id, nextEntry);
        if (!created) {
            ui.finishToolExecution(id, nextEntry.output, isError, nextEntry.details);
        }
    };

    const withNote = (details: KnownToolTraceDetails | undefined, note: string): KnownToolTraceDetails | undefined => {
        if (!details || !("note" in details)) {
            return details;
        }

        return {
            ...details,
            note,
        } as KnownToolTraceDetails;
    };

    const getTrace = (id: string): ProviderTraceEntry | undefined => traces.get(id);

    const getWebSearchArgs = (item: Extract<ResponseOutputItem, { type: "web_search_call" }>): { action: string } | undefined => {
        const action = (item as { action?: { type?: unknown } }).action;
        return action && typeof action.type === "string"
            ? { action: action.type }
            : undefined;
    };

    const buildWebSearchDetails = (
        item: Extract<ResponseOutputItem, { type: "web_search_call" }>,
        note?: string,
    ): WebSearchTraceDetails => {
        const action = (item as { action?: any }).action;
        if (!action || typeof action.type !== "string") {
            return {
                type: "web_search",
                note,
            };
        }

        if (action.type === "search") {
            return {
                type: "web_search",
                actionType: "search",
                queries: Array.isArray(action.queries)
                    ? action.queries.filter((query: unknown): query is string => typeof query === "string")
                    : typeof action.query === "string"
                        ? [action.query]
                        : [],
                sources: Array.isArray(action.sources)
                    ? action.sources
                        .map((source: { url?: unknown }) => typeof source?.url === "string" ? source.url : null)
                        .filter((url: string | null): url is string => url !== null)
                    : [],
                note,
            };
        }

        if (action.type === "open_page") {
            return {
                type: "web_search",
                actionType: "open_page",
                url: typeof action.url === "string" ? action.url : undefined,
                note,
            };
        }

        return {
            type: "web_search",
            actionType: "find_in_page",
            url: typeof action.url === "string" ? action.url : undefined,
            pattern: typeof action.pattern === "string" ? action.pattern : undefined,
            note,
        };
    };

    const buildFileSearchDetails = (
        item: Extract<ResponseOutputItem, { type: "file_search_call" }>,
        note?: string,
    ): FileSearchTraceDetails => ({
        type: "file_search",
        queries: item.queries,
        results: item.results?.map((result) => ({
            filename: result.filename,
            score: result.score,
            text: result.text,
        })) ?? [],
        note,
    });

    const buildCodeInterpreterDetails = (
        item: Extract<ResponseOutputItem, { type: "code_interpreter_call" }>,
        note?: string,
    ): CodeInterpreterTraceDetails => ({
        type: "code_interpreter",
        code: codeInterpreterCode.get(item.id) ?? "",
        outputs: item.outputs?.map((output) => output.type === "logs"
            ? { type: "logs" as const, content: output.logs }
            : { type: "image" as const, content: output.url }) ?? [],
        note,
    });

    const buildMcpCallDetails = (
        item: Extract<ResponseOutputItem, { type: "mcp_call" }>,
        note?: string,
    ): McpTraceDetails => ({
        type: "mcp",
        serverLabel: item.server_label,
        toolName: item.name,
        argumentsText: mcpArguments.get(item.id) ?? item.arguments,
        output: item.output ?? undefined,
        note,
    });

    const buildMcpListToolsDetails = (
        item: Extract<ResponseOutputItem, { type: "mcp_list_tools" }>,
        note?: string,
    ): McpTraceDetails => ({
        type: "mcp",
        serverLabel: item.server_label,
        tools: item.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
        })),
        note,
    });

    const buildMcpApprovalRequestDetails = (
        item: Extract<ResponseOutputItem, { type: "mcp_approval_request" }>,
        note?: string,
    ): McpTraceDetails => ({
        type: "mcp",
        serverLabel: item.server_label,
        toolName: item.name,
        argumentsText: item.arguments,
        note,
    });

    const buildLocalShellCallDetails = (
        item: Extract<ResponseOutputItem, { type: "local_shell_call" }>,
        note?: string,
    ): LocalShellTraceDetails => ({
        type: "local_shell",
        command: item.action.command.join(" "),
        workingDirectory: item.action.working_directory ?? undefined,
        note,
    });

    const buildToolSearchCallDetails = (
        item: Extract<ResponseOutputItem, { type: "tool_search_call" }>,
        note?: string,
    ): ToolSearchTraceDetails => ({
        type: "tool_search",
        argumentsText: (() => {
            try {
                return JSON.stringify(item.arguments, null, 2);
            } catch {
                return String(item.arguments);
            }
        })(),
        note,
    });

    const buildToolSearchOutputDetails = (
        item: Extract<ResponseOutputItem, { type: "tool_search_output" }>,
        note?: string,
    ): ToolSearchTraceDetails => ({
        type: "tool_search",
        tools: item.tools.map((tool) => ({
            name: "name" in tool && typeof tool.name === "string" ? tool.name : item.type,
            description: "description" in tool && typeof tool.description === "string" ? tool.description : null,
            type: "type" in tool && typeof tool.type === "string" ? tool.type : null,
        })),
        note,
    });

    return {
        onOutputItemAdded(item: ResponseOutputItem): void {
            if (isWebSearchItem(item)) {
                setRunning(item.id, "web_search", getWebSearchArgs(item), buildWebSearchDetails(item, "Searching the web..."));
                return;
            }

            if (isFileSearchItem(item)) {
                setRunning(item.id, "file_search", { queries: item.queries }, buildFileSearchDetails(item, "Searching files..."));
                return;
            }

            if (isCodeInterpreterItem(item)) {
                setRunning(item.id, "code_interpreter", undefined, buildCodeInterpreterDetails(item, "Preparing code interpreter..."));
                return;
            }

            if (isMcpCallItem(item)) {
                setRunning(item.id, "mcp", undefined, buildMcpCallDetails(item, "Calling MCP tool..."));
                return;
            }

            if (isMcpListToolsItem(item)) {
                setRunning(item.id, "mcp", undefined, buildMcpListToolsDetails(item, "Listing MCP tools..."));
                return;
            }

            if (isMcpApprovalRequestItem(item)) {
                setFinished(item.id, "mcp", undefined, buildMcpApprovalRequestDetails(item, "Approval required."));
                return;
            }

            if (isLocalShellCallItem(item)) {
                setRunning(item.id, "local_shell", undefined, buildLocalShellCallDetails(item, "Running shell command..."));
                return;
            }

            if (isToolSearchCallItem(item)) {
                setRunning(item.id, "tool_search", undefined, buildToolSearchCallDetails(item, "Searching for tools..."));
            }
        },
        onOutputItemDone(item: ResponseOutputItem): void {
            if (isWebSearchItem(item)) {
                setFinished(item.id, "web_search", getWebSearchArgs(item), buildWebSearchDetails(item, "Web search completed."), undefined, item.status === "failed");
                return;
            }

            if (isFileSearchItem(item)) {
                setFinished(item.id, "file_search", { queries: item.queries }, buildFileSearchDetails(item, item.status === "failed" ? "File search failed." : "File search completed."), undefined, item.status === "failed" || item.status === "incomplete");
                return;
            }

            if (isCodeInterpreterItem(item)) {
                setFinished(item.id, "code_interpreter", undefined, buildCodeInterpreterDetails(item, item.status === "failed" ? "Code interpreter failed." : "Code interpreter completed."), undefined, item.status === "failed" || item.status === "incomplete");
                return;
            }

            if (isMcpCallItem(item)) {
                setFinished(item.id, "mcp", undefined, buildMcpCallDetails(item, item.status === "failed" ? "MCP call failed." : "MCP call completed."), item.output ?? undefined, item.status === "failed" || item.status === "incomplete");
                return;
            }

            if (isMcpListToolsItem(item)) {
                setFinished(item.id, "mcp", undefined, buildMcpListToolsDetails(item, item.error ? "Failed to list MCP tools." : "Listed MCP tools."), item.error ?? undefined, !!item.error);
                return;
            }

            if (isMcpApprovalRequestItem(item)) {
                setFinished(item.id, "mcp", undefined, buildMcpApprovalRequestDetails(item, "Approval required."));
                return;
            }

            if (isLocalShellCallItem(item)) {
                setFinished(item.id, "local_shell", undefined, buildLocalShellCallDetails(item, "Shell call completed."));
                return;
            }

            if (isLocalShellOutputItem(item)) {
                const existing = getTrace(item.id);
                const details: LocalShellTraceDetails = existing?.details?.type === "local_shell"
                    ? {
                        ...existing.details,
                        output: item.output,
                        note: "Shell call completed.",
                    }
                    : {
                        type: "local_shell",
                        output: item.output,
                        note: "Shell call completed.",
                    };
                setFinished(item.id, "local_shell", undefined, details, item.output);
                return;
            }

            if (isToolSearchCallItem(item)) {
                setFinished(item.id, "tool_search", undefined, buildToolSearchCallDetails(item, "Tool search completed."));
                return;
            }

            if (isToolSearchOutputItem(item)) {
                const traceId = item.call_id ?? item.id;
                setFinished(traceId, "tool_search", undefined, buildToolSearchOutputDetails(item, "Tool search completed."));
            }
        },
        onResponseEvent(event: ResponseStreamEvent | { type: string; [key: string]: unknown }): void {
            const responseEvent = event as any;

            switch (responseEvent.type) {
                case "response.web_search_call.in_progress":
                    setRunning(responseEvent.item_id, "web_search", undefined, withNote(getTrace(responseEvent.item_id)?.details, "Starting web search..."));
                    return;
                case "response.web_search_call.searching":
                    setRunning(responseEvent.item_id, "web_search", undefined, withNote(getTrace(responseEvent.item_id)?.details, "Searching the web..."));
                    return;
                case "response.web_search_call.completed":
                    setFinished(responseEvent.item_id, "web_search", undefined, withNote(getTrace(responseEvent.item_id)?.details, "Web search completed."));
                    return;
                case "response.file_search_call.in_progress":
                    setRunning(responseEvent.item_id, "file_search", undefined, withNote(getTrace(responseEvent.item_id)?.details, "Starting file search..."));
                    return;
                case "response.file_search_call.searching":
                    setRunning(responseEvent.item_id, "file_search", undefined, withNote(getTrace(responseEvent.item_id)?.details, "Searching files..."));
                    return;
                case "response.file_search_call.completed":
                    setFinished(responseEvent.item_id, "file_search", undefined, withNote(getTrace(responseEvent.item_id)?.details, "File search completed."));
                    return;
                case "response.code_interpreter_call.in_progress":
                    setRunning(responseEvent.item_id, "code_interpreter", undefined, withNote(getTrace(responseEvent.item_id)?.details, "Preparing code interpreter..."));
                    return;
                case "response.code_interpreter_call.interpreting":
                    setRunning(responseEvent.item_id, "code_interpreter", undefined, withNote(getTrace(responseEvent.item_id)?.details, "Executing code..."));
                    return;
                case "response.code_interpreter_call.completed":
                    setFinished(responseEvent.item_id, "code_interpreter", undefined, withNote(getTrace(responseEvent.item_id)?.details, "Code interpreter completed."));
                    return;
                case "response.code_interpreter_call_code.delta": {
                    const nextCode = `${codeInterpreterCode.get(responseEvent.item_id) ?? ""}${typeof responseEvent.delta === "string" ? responseEvent.delta : ""}`;
                    codeInterpreterCode.set(responseEvent.item_id, nextCode);
                    const existing = getTrace(responseEvent.item_id)?.details;
                    const details: CodeInterpreterTraceDetails = existing?.type === "code_interpreter"
                        ? {
                            ...existing,
                            code: nextCode,
                            note: "Generating code...",
                        }
                        : {
                            type: "code_interpreter",
                            code: nextCode,
                            note: "Generating code...",
                        };
                    setRunning(responseEvent.item_id, "code_interpreter", undefined, details);
                    return;
                }
                case "response.code_interpreter_call_code.done": {
                    const finalCode = typeof responseEvent.code === "string" ? responseEvent.code : "";
                    codeInterpreterCode.set(responseEvent.item_id, finalCode);
                    const existing = getTrace(responseEvent.item_id)?.details;
                    const details: CodeInterpreterTraceDetails = existing?.type === "code_interpreter"
                        ? {
                            ...existing,
                            code: finalCode,
                            note: "Executing code...",
                        }
                        : {
                            type: "code_interpreter",
                            code: finalCode,
                            note: "Executing code...",
                        };
                    setRunning(responseEvent.item_id, "code_interpreter", undefined, details);
                    return;
                }
                case "response.mcp_call.in_progress":
                    setRunning(responseEvent.item_id, "mcp", undefined, withNote(getTrace(responseEvent.item_id)?.details, "Calling MCP tool..."));
                    return;
                case "response.mcp_call.completed":
                    setFinished(responseEvent.item_id, "mcp", undefined, withNote(getTrace(responseEvent.item_id)?.details, "MCP call completed."));
                    return;
                case "response.mcp_call.failed":
                    setFinished(responseEvent.item_id, "mcp", undefined, withNote(getTrace(responseEvent.item_id)?.details, "MCP call failed."), undefined, true);
                    return;
                case "response.mcp_call_arguments.delta": {
                    const nextArguments = `${mcpArguments.get(responseEvent.item_id) ?? ""}${typeof responseEvent.delta === "string" ? responseEvent.delta : ""}`;
                    mcpArguments.set(responseEvent.item_id, nextArguments);
                    const existing = getTrace(responseEvent.item_id)?.details;
                    const details: McpTraceDetails = existing?.type === "mcp"
                        ? {
                            ...existing,
                            argumentsText: nextArguments,
                            note: "Streaming MCP arguments...",
                        }
                        : {
                            type: "mcp",
                            argumentsText: nextArguments,
                            note: "Streaming MCP arguments...",
                        };
                    setRunning(responseEvent.item_id, "mcp", undefined, details);
                    return;
                }
                case "response.mcp_call_arguments.done": {
                    const finalArguments = typeof responseEvent.arguments === "string" ? responseEvent.arguments : "";
                    mcpArguments.set(responseEvent.item_id, finalArguments);
                    const existing = getTrace(responseEvent.item_id)?.details;
                    const details: McpTraceDetails = existing?.type === "mcp"
                        ? {
                            ...existing,
                            argumentsText: finalArguments,
                            note: "Calling MCP tool...",
                        }
                        : {
                            type: "mcp",
                            argumentsText: finalArguments,
                            note: "Calling MCP tool...",
                        };
                    setRunning(responseEvent.item_id, "mcp", undefined, details);
                    return;
                }
                case "response.mcp_list_tools.in_progress":
                    setRunning(responseEvent.item_id, "mcp", undefined, withNote(getTrace(responseEvent.item_id)?.details, "Listing MCP tools..."));
                    return;
                case "response.mcp_list_tools.completed":
                    setFinished(responseEvent.item_id, "mcp", undefined, withNote(getTrace(responseEvent.item_id)?.details, "Listed MCP tools."));
                    return;
                case "response.mcp_list_tools.failed":
                    setFinished(responseEvent.item_id, "mcp", undefined, withNote(getTrace(responseEvent.item_id)?.details, "Failed to list MCP tools."), undefined, true);
                    return;
                default:
                    return;
            }
        },
    };
}
