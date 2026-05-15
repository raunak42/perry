export interface ReadTraceDetails {
    type: "read";
    path: string;
    language: string | null;
    content: string;
    notice?: string;
    truncated?: boolean;
    startLine?: number;
    endLine?: number;
    totalLines?: number;
    remainingLines?: number;
    isImage?: boolean;
    mimeType?: string;
    width?: number;
    height?: number;
    imageBytes?: number;
    attachedToModel?: boolean;
}

export interface WriteTraceDetails {
    type: "write";
    path: string;
    language: string | null;
    content: string;
}

export interface EditTraceDetails {
    type: "edit";
    path: string;
    diff: string;
    firstChangedLine?: number;
    lastChangedLine?: number;
}

export interface WebSearchTraceDetails {
    type: "web_search";
    actionType?: "search" | "open_page" | "find_in_page";
    queries?: string[];
    url?: string;
    pattern?: string;
    sources?: string[];
    note?: string;
}

export interface FileSearchTraceDetails {
    type: "file_search";
    queries: string[];
    results?: Array<{
        filename?: string;
        score?: number;
        text?: string;
    }>;
    note?: string;
}

export interface CodeInterpreterTraceDetails {
    type: "code_interpreter";
    code?: string;
    outputs?: Array<
        | {
            type: "logs";
            content: string;
        }
        | {
            type: "image";
            content: string;
        }
    >;
    note?: string;
}

export interface McpTraceDetails {
    type: "mcp";
    serverLabel?: string;
    toolName?: string;
    argumentsText?: string;
    output?: string;
    tools?: Array<{
        name: string;
        description?: string | null;
    }>;
    note?: string;
}

export interface LocalShellTraceDetails {
    type: "local_shell";
    command?: string;
    workingDirectory?: string;
    output?: string;
    note?: string;
}

export interface ToolSearchTraceDetails {
    type: "tool_search";
    argumentsText?: string;
    tools?: Array<{
        name: string;
        description?: string | null;
        type?: string | null;
    }>;
    note?: string;
}

export type KnownToolTraceDetails =
    | ReadTraceDetails
    | WriteTraceDetails
    | EditTraceDetails
    | WebSearchTraceDetails
    | FileSearchTraceDetails
    | CodeInterpreterTraceDetails
    | McpTraceDetails
    | LocalShellTraceDetails
    | ToolSearchTraceDetails;
