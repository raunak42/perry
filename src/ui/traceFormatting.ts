import type {
    CodeInterpreterTraceDetails,
    FileSearchTraceDetails,
    KnownToolTraceDetails,
    LocalShellTraceDetails,
    McpTraceDetails,
    SubagentTraceDetails,
    ToolSearchTraceDetails,
    WebSearchTraceDetails,
} from "../tools/traceDetails";

export type ToolTraceStatus = "pending" | "running" | "complete" | "error" | "aborted";

export interface ToolTraceViewModel {
    displayId: number;
    toolName: string;
    status: ToolTraceStatus;
    args?: unknown;
    argsText?: string;
    output: string;
    details?: KnownToolTraceDetails;
    expanded: boolean;
}

const COLLAPSED_MAX_LINES = 14;
const EXPANDED_MAX_LINES = 60;
const COLLAPSED_MAX_CHARS = 1_200;
const EXPANDED_MAX_CHARS = 14_000;

export function formatTraceStatusLabel(status: ToolTraceStatus): string {
    switch (status) {
        case "pending":
            return "queued";
        case "running":
            return "running";
        case "complete":
            return "done";
        case "error":
            return "error";
        case "aborted":
            return "aborted";
        default:
            return status;
    }
}

export function buildToolTraceMarkdown(trace: ToolTraceViewModel): string {
    const sections = trace.details
        ? buildKnownDetailSections(trace)
        : buildGenericSections(trace);

    if (sections.length === 0) {
        if (trace.status === "pending") {
            return "_Waiting for tool arguments..._";
        }

        if (trace.status === "running") {
            return "_Tool execution started..._";
        }

        return "_No additional trace output._";
    }

    return sections.join("\n\n");
}

export function summarizeToolTrace(trace: ToolTraceViewModel): string {
    const summary = trace.details
        ? summarizeKnownDetails(trace.details)
        : summarizeFallback(trace);

    return clampInline(summary || trace.toolName, 48);
}

function buildKnownDetailSections(trace: ToolTraceViewModel): string[] {
    const details = trace.details;
    if (!details) {
        return [];
    }

    switch (details.type) {
        case "read": {
            const sections: string[] = [];
            if (details.notice) {
                sections.push(`_${escapeMarkdownInline(details.notice)}_`);
            }
            if (details.content.trim().length > 0) {
                sections.push(codeFence(details.language ?? "text", clipContent(details.content, trace.expanded)));
            }
            return sections;
        }

        case "write": {
            const sections: string[] = [];
            const preview = clipContent(details.content, trace.expanded);
            if (preview.trim().length > 0) {
                sections.push(codeFence(details.language ?? "text", preview));
            }
            return sections;
        }

        case "edit": {
            const sections: string[] = [];
            if (typeof details.firstChangedLine === "number" && typeof details.lastChangedLine === "number") {
                sections.push(`Lines ${details.firstChangedLine}-${details.lastChangedLine}`);
            }
            if (details.diff.trim().length > 0) {
                sections.push(codeFence("diff", clipContent(details.diff, trace.expanded)));
            }
            return sections;
        }

        case "web_search":
            return buildWebSearchSections(details, trace.expanded);

        case "file_search":
            return buildFileSearchSections(details, trace.expanded);

        case "code_interpreter":
            return buildCodeInterpreterSections(details, trace.expanded);

        case "mcp":
            return buildMcpSections(details, trace.expanded);

        case "local_shell":
            return buildLocalShellSections(details, trace.output, trace.expanded);

        case "tool_search":
            return buildToolSearchSections(details, trace.expanded);

        case "plan_choice":
            return buildPlanChoiceSections(details);

        case "plan_complete":
            return buildPlanCompleteSections(details, trace.expanded);

        case "subagent":
            return buildSubagentSections(details, trace.expanded);

        default:
            return buildGenericSections(trace);
    }
}

function buildGenericSections(trace: ToolTraceViewModel): string[] {
    const sections: string[] = [];

    if (trace.argsText && trace.argsText.trim().length > 0) {
        sections.push("**Arguments**\n" + codeFence("json", clipContent(trace.argsText, trace.expanded)));
    } else if (trace.args !== undefined) {
        sections.push("**Arguments**\n" + codeFence("json", clipContent(stringifyValue(trace.args), trace.expanded)));
    }

    if (trace.output.trim().length > 0) {
        sections.push("**Output**\n" + codeFence("text", clipContent(trace.output, trace.expanded, { tail: !trace.expanded })));
    }

    return sections;
}

function buildWebSearchSections(details: WebSearchTraceDetails, expanded: boolean): string[] {
    const sections: string[] = [];

    if (details.note) {
        sections.push(`_${escapeMarkdownInline(details.note)}_`);
    }

    if (details.actionType) {
        sections.push(`**Action** ${escapeMarkdownInline(details.actionType.replace(/_/g, " "))}`);
    }

    if (details.queries?.length) {
        sections.push(`**Queries**\n${details.queries.map((query) => `- ${query}`).join("\n")}`);
    }

    if (details.url) {
        sections.push(`**URL** ${details.url}`);
    }

    if (details.pattern) {
        sections.push(`**Pattern** \`${details.pattern}\``);
    }

    if (details.sources?.length) {
        const sources = details.sources.slice(0, expanded ? 12 : 5);
        sections.push(`**Sources**\n${sources.map((source) => `- ${source}`).join("\n")}`);
    }

    return sections;
}

function buildFileSearchSections(details: FileSearchTraceDetails, expanded: boolean): string[] {
    const sections: string[] = [];

    if (details.note) {
        sections.push(`_${escapeMarkdownInline(details.note)}_`);
    }

    if (details.queries.length) {
        sections.push(`**Queries**\n${details.queries.map((query) => `- ${query}`).join("\n")}`);
    }

    if (details.results?.length) {
        const results = details.results.slice(0, expanded ? 8 : 4).map((result) => {
            const label = [result.filename ? `\`${result.filename}\`` : undefined, typeof result.score === "number" ? `(score ${result.score.toFixed(2)})` : undefined]
                .filter(Boolean)
                .join(" ");
            const snippet = result.text ? `\n${codeFence("text", clipContent(result.text, false))}` : "";
            return `- ${label || "match"}${snippet}`;
        });
        sections.push(`**Matches**\n${results.join("\n")}`);
    }

    return sections;
}

function buildCodeInterpreterSections(details: CodeInterpreterTraceDetails, expanded: boolean): string[] {
    const sections: string[] = [];

    if (details.note) {
        sections.push(`_${escapeMarkdownInline(details.note)}_`);
    }

    if (details.code?.trim()) {
        sections.push("**Code**\n" + codeFence("python", clipContent(details.code, expanded)));
    }

    if (details.outputs?.length) {
        const outputSections = details.outputs.slice(0, expanded ? 8 : 4).map((output) => {
            if (output.type === "logs") {
                return `- Logs\n${codeFence("text", clipContent(output.content, expanded, { tail: !expanded }))}`;
            }

            return `- Image: ${output.content}`;
        });

        sections.push(`**Outputs**\n${outputSections.join("\n")}`);
    }

    return sections;
}

function buildMcpSections(details: McpTraceDetails, expanded: boolean): string[] {
    const sections: string[] = [];

    if (details.note) {
        sections.push(`_${escapeMarkdownInline(details.note)}_`);
    }

    const labels = [details.serverLabel, details.toolName].filter(Boolean);
    if (labels.length > 0) {
        sections.push(`**Target** ${labels.join(" · ")}`);
    }

    if (details.argumentsText?.trim()) {
        sections.push("**Arguments**\n" + codeFence("json", clipContent(details.argumentsText, expanded)));
    }

    if (details.output?.trim()) {
        sections.push("**Output**\n" + codeFence("text", clipContent(details.output, expanded, { tail: !expanded })));
    }

    if (details.tools?.length) {
        const tools = details.tools.slice(0, expanded ? 10 : 5).map((tool) => `- ${tool.name}${tool.description ? ` — ${tool.description}` : ""}`);
        sections.push(`**Tools**\n${tools.join("\n")}`);
    }

    return sections;
}

function buildLocalShellSections(details: LocalShellTraceDetails, output: string, expanded: boolean): string[] {
    const sections: string[] = [];

    if (details.note) {
        sections.push(`_${escapeMarkdownInline(details.note)}_`);
    }

    if (details.command) {
        sections.push("**Command**\n" + codeFence("sh", clipContent(details.command, expanded)));
    }

    if (details.workingDirectory) {
        sections.push(`**cwd** \`${details.workingDirectory}\``);
    }

    const resolvedOutput = details.output ?? output;
    if (resolvedOutput.trim().length > 0) {
        sections.push("**Output**\n" + codeFence("text", clipContent(resolvedOutput, expanded, { tail: !expanded })));
    }

    return sections;
}

function buildToolSearchSections(details: ToolSearchTraceDetails, expanded: boolean): string[] {
    const sections: string[] = [];

    if (details.note) {
        sections.push(`_${escapeMarkdownInline(details.note)}_`);
    }

    if (details.argumentsText?.trim()) {
        sections.push("**Arguments**\n" + codeFence("json", clipContent(details.argumentsText, expanded)));
    }

    if (details.tools?.length) {
        const tools = details.tools.slice(0, expanded ? 12 : 6).map((tool) => {
            const parts = [tool.name, tool.type ? `(${tool.type})` : undefined, tool.description ?? undefined].filter(Boolean);
            return `- ${parts.join(" ")}`;
        });
        sections.push(`**Tools**\n${tools.join("\n")}`);
    }

    return sections;
}

function buildPlanChoiceSections(details: Extract<KnownToolTraceDetails, { type: "plan_choice" }>): string[] {
    const sections = [
        `**Question** ${escapeMarkdownInline(details.question)}`,
        `**Selected** ${escapeMarkdownInline(details.selected.label)}${details.selected.description ? ` — ${escapeMarkdownInline(details.selected.description)}` : ""}`,
    ];
    return sections;
}

function buildPlanCompleteSections(details: Extract<KnownToolTraceDetails, { type: "plan_complete" }>, expanded: boolean): string[] {
    const sections = [
        `**Decision** ${escapeMarkdownInline(details.actionLabel)}`,
    ];
    if (details.summary) {
        sections.push(`**Summary** ${escapeMarkdownInline(details.summary)}`);
    }
    sections.push("**Plan**\n" + codeFence("md", clipContent(details.plan, expanded)));
    return sections;
}

function buildSubagentSections(details: SubagentTraceDetails, expanded: boolean): string[] {
    const sections: string[] = [];
    if (details.note) {
        sections.push(`_${escapeMarkdownInline(details.note)}_`);
    }
    sections.push(`**Task** ${escapeMarkdownInline(details.task)}`);
    const modeParts = [
        `depth ${details.depth}`,
        `${details.reasoningLevel} thinking`,
        details.permissionMode,
        details.planMode ? "plan mode" : undefined,
        `${details.turnsUsed ?? 0}/${details.maxTurns} turns`,
    ].filter(Boolean);
    sections.push(`**Mode** ${modeParts.join(" · ")}`);
    if (details.context?.trim()) {
        sections.push("**Context**\n" + codeFence("md", clipContent(details.context, expanded)));
    }
    if (details.output?.trim()) {
        sections.push("**Result**\n" + codeFence("md", clipContent(details.output, expanded, { tail: !expanded })));
    }
    return sections;
}

function summarizeKnownDetails(details: KnownToolTraceDetails): string {
    switch (details.type) {
        case "read":
        case "write":
        case "edit":
            return details.path;
        case "web_search":
            return details.queries?.[0] ?? details.url ?? details.note ?? "web search";
        case "file_search":
            return details.queries[0] ?? details.note ?? "file search";
        case "code_interpreter":
            return details.note ?? "code interpreter";
        case "mcp":
            return [details.serverLabel, details.toolName].filter(Boolean).join(" · ") || details.note || "mcp";
        case "local_shell":
            return details.command ?? details.workingDirectory ?? details.note ?? "shell";
        case "tool_search":
            return details.tools?.[0]?.name ?? details.note ?? "tool search";
        case "plan_choice":
            return details.question;
        case "plan_complete":
            return details.summary ?? details.actionLabel;
        case "subagent":
            return details.task;
        default:
            return "trace";
    }
}

function summarizeFallback(trace: ToolTraceViewModel): string {
    if (trace.args && typeof trace.args === "object" && trace.args !== null) {
        const candidate = pickSummaryField(trace.args);
        if (candidate) {
            return candidate;
        }
    }

    return trace.output.split("\n").find((line) => line.trim().length > 0)?.trim() ?? trace.toolName;
}

function pickSummaryField(value: unknown): string | null {
    if (!value || typeof value !== "object") {
        return null;
    }

    for (const key of ["path", "command", "url", "query", "name"]) {
        const candidate = (value as Record<string, unknown>)[key];
        if (typeof candidate === "string" && candidate.trim().length > 0) {
            return candidate.trim();
        }
    }

    return null;
}

function codeFence(language: string, content: string): string {
    const normalized = stripAnsi(normalizeNewlines(content)).trimEnd();
    return `\`\`\`${language}\n${normalized}\n\`\`\``;
}

function clipContent(text: string, expanded: boolean, _options?: { tail?: boolean }): string {
    const normalized = stripAnsi(normalizeNewlines(text)).trimEnd();
    if (!normalized) {
        return "";
    }

    const maxLines = expanded ? EXPANDED_MAX_LINES : COLLAPSED_MAX_LINES;
    const maxChars = expanded ? EXPANDED_MAX_CHARS : COLLAPSED_MAX_CHARS;
    const clipped = clipHead(normalized, maxLines, maxChars);

    if (!clipped.truncated) {
        return clipped.text;
    }

    return `${clipped.text}\n+${clipped.omittedLines} more ${clipped.omittedLines === 1 ? "line" : "lines"}`;
}

function clipHead(text: string, maxLines: number, maxChars: number): { text: string; truncated: boolean; omittedLines: number } {
    const lines = text.split("\n");
    const clippedLines = lines.slice(0, maxLines);
    let clipped = clippedLines.join("\n");

    if (clipped.length > maxChars) {
        clipped = clipped.slice(0, maxChars).replace(/\n?[^\n]*$/, "").trimEnd();
    }

    const visibleLines = clipped.length === 0 ? 0 : clipped.split("\n").length;
    const truncated = clipped.length < text.length || visibleLines < lines.length;

    return {
        text: clipped,
        truncated,
        omittedLines: truncated ? Math.max(1, lines.length - visibleLines) : 0,
    };
}

function stringifyValue(value: unknown): string {
    try {
        return JSON.stringify(value, null, 2) ?? String(value);
    } catch {
        return String(value);
    }
}

function clampInline(value: string, maxLength: number): string {
    const normalized = stripAnsi(normalizeNewlines(value)).replace(/\s+/g, " ").trim();
    if (normalized.length <= maxLength) {
        return normalized;
    }

    return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function normalizeNewlines(text: string): string {
    return text.replace(/\r\n?/g, "\n");
}

function stripAnsi(text: string): string {
    return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function escapeMarkdownInline(text: string): string {
    return text.replace(/([*_`])/g, "\\$1");
}
