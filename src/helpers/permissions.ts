import path from "node:path";
import { PLAN_CHOICE_TOOL_NAME, PLAN_COMPLETE_TOOL_NAME, getPlanModeBlockedCommandReason } from "./planMode";
import { SPAWN_SUBAGENT_TOOL_NAME } from "./subagents";
import { detectBlockedFileMutationReason } from "../tools/runCommand";

export type PermissionMode = "ask" | "read-only" | "workspace-write" | "full-access";

export type PermissionAction = "allow" | "ask" | "deny";

export type ShellCommandRisk = "read-only" | "risky" | "mutating";

export interface PermissionEvaluation {
    action: PermissionAction;
    reason: string;
    summary: string;
    mode: PermissionMode;
}

export interface ToolPermissionRequest {
    mode: PermissionMode;
    toolName: string;
    args: unknown;
    cwd?: string;
    planMode?: boolean;
}

const VALID_PERMISSION_MODES = new Set<PermissionMode>(["ask", "read-only", "workspace-write", "full-access"]);

const PLAN_INTERACTION_TOOLS = new Set([PLAN_CHOICE_TOOL_NAME, PLAN_COMPLETE_TOOL_NAME]);

export function isPermissionMode(value: unknown): value is PermissionMode {
    return typeof value === "string" && VALID_PERMISSION_MODES.has(value as PermissionMode);
}

export function normalizePermissionMode(value: string): PermissionMode | null {
    const normalized = value.trim().toLowerCase().replace(/_/g, "-");
    if (normalized === "ask" || normalized === "prompt" || normalized === "default") return "ask";
    if (normalized === "read-only" || normalized === "readonly" || normalized === "read" || normalized === "ro") return "read-only";
    if (normalized === "workspace-write" || normalized === "workspace" || normalized === "workspace-writeable" || normalized === "workspace-writable" || normalized === "ww") return "workspace-write";
    if (
        normalized === "full-access" ||
        normalized === "full" ||
        normalized === "unrestricted" ||
        normalized === "dangerously-full-access" ||
        normalized === "yolo" ||
        normalized === "yolo-mode" ||
        normalized === "auto-approve" ||
        normalized === "autoapprove"
    ) return "full-access";
    return null;
}

export function describePermissionMode(mode: PermissionMode): string {
    switch (mode) {
        case "ask": return "Ask before risky actions";
        case "read-only": return "Read-only";
        case "workspace-write": return "Workspace write";
        case "full-access": return "Full access / YOLO mode";
    }
}

export function getPermissionModeDescription(mode: PermissionMode): string {
    switch (mode) {
        case "ask": return "Allow safe reads/inspection; ask before edits, sensitive reads, and risky shell commands";
        case "read-only": return "Allow reads/inspection only; ask before sensitive reads; block writes and mutating shell commands";
        case "workspace-write": return "Allow workspace file edits; ask before outside-workspace writes, sensitive files, and risky shell commands";
        case "full-access": return "Auto-approve future permission prompts while keeping Perry's hard safety checks";
    }
}

function recordFromArgs(args: unknown): Record<string, unknown> | null {
    return args && typeof args === "object" && !Array.isArray(args)
        ? args as Record<string, unknown>
        : null;
}

function stringArg(args: unknown, key: string): string | null {
    const record = recordFromArgs(args);
    const value = record?.[key];
    return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function resolveWorkspacePath(inputPath: string, cwd = process.cwd()): string {
    return path.isAbsolute(inputPath)
        ? path.resolve(inputPath)
        : path.resolve(cwd, inputPath);
}

export function isPathInsideWorkspace(inputPath: string, cwd = process.cwd()): boolean {
    const workspace = path.resolve(cwd);
    const target = resolveWorkspacePath(inputPath, workspace);
    const relative = path.relative(workspace, target);
    return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function splitNormalizedPath(inputPath: string): string[] {
    return inputPath
        .replace(/\\/g, "/")
        .split("/")
        .filter(Boolean)
        .map((part) => part.toLowerCase());
}

export function isSensitivePath(inputPath: string): boolean {
    const normalizedPath = inputPath.replace(/\\/g, "/").toLowerCase();
    const parts = splitNormalizedPath(inputPath);
    const basename = parts[parts.length - 1] ?? "";

    if (!basename) return false;

    if (/^\.env(?:\.|$|-|_)?/.test(basename) || basename === ".envrc") return true;
    if ([".npmrc", ".netrc", ".pypirc", ".dockercfg"].includes(basename)) return true;
    if (["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"].includes(basename)) return true;
    if (!basename.endsWith(".pub") && /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\.|$)/.test(basename)) return true;
    if (basename.endsWith(".pem") || basename.endsWith(".p12") || basename.endsWith(".pfx")) return true;
    if (basename.endsWith(".key") && !basename.endsWith(".pub")) return true;
    if (/private[-_]?key|secret|secrets|credential|credentials|token|tokens|api[-_]?key|apikey|access[-_]?key|auth\.json/.test(basename)) return true;

    if (normalizedPath.includes("/.ssh/") && !basename.endsWith(".pub")) return true;
    if (normalizedPath.endsWith("/.aws/credentials") || normalizedPath.includes("/.aws/credentials/")) return true;
    if (normalizedPath.endsWith("/.config/gh/hosts.yml")) return true;
    if (normalizedPath.endsWith("/.docker/config.json")) return true;
    if (normalizedPath.endsWith("/.kube/config")) return true;
    if (normalizedPath.includes("/keychains/") || normalizedPath.includes("/gnupg/")) return true;

    return false;
}

function hasShellRedirectionToFile(command: string): boolean {
    return /(?:^|[\s;|&])(?:\d{0,2})?>\s*(?!&?\d\b|\/dev\/null\b|\/dev\/stdout\b|\/dev\/stderr\b)/.test(command);
}

function hasReadOnlyRootCommand(command: string): boolean {
    const normalized = command.trim().toLowerCase();
    if (!normalized) return false;

    const segments = normalized
        .split(/&&|\|\||;|\|/g)
        .map((segment) => segment.trim())
        .filter(Boolean);

    if (segments.length === 0) return false;

    return segments.every((segment) => {
        const withoutEnv = segment.replace(/^(?:env\s+)?(?:[a-z_][a-z0-9_]*=[^\s]+\s+)*/i, "").trim();
        const commandName = withoutEnv.split(/\s+/, 1)[0] ?? "";
        if (!commandName) return false;

        if ([
            "ls", "pwd", "rg", "grep", "egrep", "fgrep", "find", "git", "bun", "npm", "pnpm", "yarn",
            "node", "python", "python3", "tsc", "cat", "head", "tail", "wc", "du", "df", "stat", "file",
            "which", "where", "command", "type", "date", "printenv", "echo", "test", "true", "false",
        ].includes(commandName)) {
            return true;
        }

        return false;
    });
}

export function classifyShellCommand(command: string): { risk: ShellCommandRisk; reason: string } {
    const trimmed = command.trim();
    if (!trimmed) {
        return { risk: "risky", reason: "empty shell command" };
    }

    const hardBlockedFileMutationReason = detectBlockedFileMutationReason(trimmed);
    if (hardBlockedFileMutationReason) {
        return { risk: "mutating", reason: hardBlockedFileMutationReason };
    }

    const planBlockedReason = getPlanModeBlockedCommandReason(trimmed);
    if (planBlockedReason) {
        return { risk: "mutating", reason: planBlockedReason };
    }

    if (hasShellRedirectionToFile(trimmed)) {
        return { risk: "mutating", reason: "shell redirection may write files" };
    }

    if (/\b(?:sudo|su|doas)\b/i.test(trimmed)) {
        return { risk: "risky", reason: "elevated privilege command" };
    }

    if (/\b(?:curl|wget|ssh|scp|sftp|ftp|nc|netcat|telnet|openssl\s+s_client)\b/i.test(trimmed)) {
        return { risk: "risky", reason: "network command" };
    }

    if (/\b(?:docker|podman|kubectl|helm|terraform|ansible|gh|aws|gcloud|az)\b/i.test(trimmed)) {
        return { risk: "risky", reason: "external service or environment command" };
    }

    if (/\b(?:kill|pkill|killall|systemctl|service|launchctl)\b/i.test(trimmed)) {
        return { risk: "risky", reason: "process or service control command" };
    }

    if (!hasReadOnlyRootCommand(trimmed)) {
        return { risk: "risky", reason: "command is not a clearly read-only inspection command" };
    }

    return { risk: "read-only", reason: "read-only inspection command" };
}

function allow(mode: PermissionMode, summary: string, reason: string): PermissionEvaluation {
    return { action: "allow", mode, summary, reason };
}

function ask(mode: PermissionMode, summary: string, reason: string): PermissionEvaluation {
    return { action: "ask", mode, summary, reason };
}

function deny(mode: PermissionMode, summary: string, reason: string): PermissionEvaluation {
    return { action: "deny", mode, summary, reason };
}

function summarizePathTool(toolName: string, args: unknown): string {
    const targetPath = stringArg(args, "path");
    return targetPath ? `${toolName} ${targetPath}` : toolName;
}

function evaluateReadPermission(mode: PermissionMode, args: unknown, cwd: string): PermissionEvaluation {
    const targetPath = stringArg(args, "path");
    const summary = summarizePathTool("read", args);
    if (!targetPath) return ask(mode, summary, "read path is missing or invalid");
    if (isSensitivePath(targetPath) || isSensitivePath(resolveWorkspacePath(targetPath, cwd))) {
        return mode === "full-access"
            ? allow(mode, summary, "full-access mode allows sensitive reads")
            : ask(mode, summary, "target path looks like it may contain secrets or credentials");
    }
    return allow(mode, summary, "normal file read");
}

function evaluateWriteLikePermission(mode: PermissionMode, toolName: "write" | "edit", args: unknown, cwd: string): PermissionEvaluation {
    const targetPath = stringArg(args, "path");
    const summary = summarizePathTool(toolName, args);
    if (!targetPath) return ask(mode, summary, `${toolName} path is missing or invalid`);

    const insideWorkspace = isPathInsideWorkspace(targetPath, cwd);
    const sensitive = isSensitivePath(targetPath) || isSensitivePath(resolveWorkspacePath(targetPath, cwd));

    if (mode === "read-only") {
        return deny(mode, summary, `${toolName} is not allowed in read-only mode`);
    }

    if (mode === "ask") {
        return ask(mode, summary, `${toolName} modifies files`);
    }

    if (mode === "workspace-write") {
        if (sensitive) return ask(mode, summary, "target path looks sensitive");
        if (!insideWorkspace) return ask(mode, summary, "target path is outside the current workspace");
        return allow(mode, summary, `${toolName} target is inside the current workspace`);
    }

    return allow(mode, summary, `${mode} mode allows file changes`);
}

function evaluateRunCommandPermission(mode: PermissionMode, args: unknown): PermissionEvaluation {
    const command = stringArg(args, "command");
    const summary = command ? `run_command ${command}` : "run_command";
    if (!command) return ask(mode, summary, "shell command is missing or invalid");

    const classification = classifyShellCommand(command);

    if (classification.risk === "read-only") {
        return allow(mode, summary, classification.reason);
    }

    if (mode === "read-only" && classification.risk === "mutating") {
        return deny(mode, summary, `mutating shell command: ${classification.reason}`);
    }

    if (mode === "read-only") {
        return ask(mode, summary, `risky shell command in read-only mode: ${classification.reason}`);
    }

    if (mode === "full-access") {
        return allow(mode, summary, `${mode} mode allows this shell command; ${classification.reason}`);
    }

    return ask(mode, summary, `${classification.risk} shell command: ${classification.reason}`);
}

export function evaluateToolPermission(request: ToolPermissionRequest): PermissionEvaluation {
    const mode = isPermissionMode(request.mode) ? request.mode : "ask";
    const cwd = path.resolve(request.cwd ?? process.cwd());
    const toolName = request.toolName;

    if (PLAN_INTERACTION_TOOLS.has(toolName)) {
        return allow(mode, toolName, "plan interaction tools are always allowed");
    }

    if (request.planMode) {
        if (toolName === "run_command") {
            const command = stringArg(request.args, "command");
            const blockedReason = command ? getPlanModeBlockedCommandReason(command) : "missing shell command";
            if (blockedReason) {
                return deny(mode, toolName, `plan mode blocks this command: ${blockedReason}`);
            }
        }

        if (!["read", "run_command", "web_search", SPAWN_SUBAGENT_TOOL_NAME].includes(toolName)) {
            return deny(mode, toolName, `plan mode blocks ${toolName}`);
        }
    }

    if (toolName === "web_search") {
        return allow(mode, "web_search", "web search is allowed");
    }

    if (toolName === "read") return evaluateReadPermission(mode, request.args, cwd);
    if (toolName === "write" || toolName === "edit") return evaluateWriteLikePermission(mode, toolName, request.args, cwd);
    if (toolName === "run_command") return evaluateRunCommandPermission(mode, request.args);

    if (toolName.startsWith("mcp__")) {
        return mode === "full-access"
            ? allow(mode, toolName, "full-access mode auto-approves MCP tools")
            : ask(mode, toolName, "MCP tools require approval by default");
    }

    if (toolName === SPAWN_SUBAGENT_TOOL_NAME) {
        const task = stringArg(request.args, "task");
        const summary = task ? `spawn subagent: ${task.slice(0, 80)}${task.length > 80 ? "..." : ""}` : "spawn subagent";
        if (mode === "full-access") {
            return allow(mode, toolName, "full-access mode auto-approves subagents");
        }
        if (mode === "ask") {
            return ask(mode, summary, "subagent spawning requires approval in ask mode");
        }
        return allow(mode, toolName, "subagents inherit the current permission mode");
    }

    if (mode === "full-access") {
        return allow(mode, toolName, "full-access mode auto-approves unknown tools");
    }

    return mode === "read-only"
        ? deny(mode, toolName, `unknown tool ${toolName} is not allowed in read-only mode`)
        : ask(mode, toolName, `unknown tool ${toolName} requires approval`);
}
