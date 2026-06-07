import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type OpenAI from "openai";
import type { McpTraceDetails } from "../tools/traceDetails";
import type { Tool, ToolExecutionResult } from "../tools/types";

export const MCP_PROTOCOL_VERSION = "2025-11-25";
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_MCP_OUTPUT_CHARS = 20_000;

export interface McpServerConfig {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    disabled?: boolean;
}

export interface McpConfig {
    mcpServers?: Record<string, McpServerConfig>;
}

export interface McpLoadedConfig {
    path: string;
    servers: Record<string, McpServerConfig>;
}

export interface McpToolInfo {
    name: string;
    description?: string | null;
    inputSchema?: Record<string, unknown>;
}

interface PendingRequest {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

type JsonRpcMessage = {
    jsonrpc: "2.0";
    id?: string | number | null;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: { code?: number; message?: string; data?: unknown };
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const result = value.filter((item): item is string => typeof item === "string");
    return result.length === value.length ? result : undefined;
}

function normalizeServerConfig(value: unknown): McpServerConfig | null {
    if (!isRecord(value) || typeof value.command !== "string" || value.command.trim().length === 0) return null;
    const env = isRecord(value.env)
        ? Object.fromEntries(Object.entries(value.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
        : undefined;
    return {
        command: value.command,
        args: asStringArray(value.args),
        env,
        cwd: typeof value.cwd === "string" ? value.cwd : undefined,
        disabled: value.disabled === true,
    };
}

function readMcpConfigFile(filePath: string): McpLoadedConfig | null {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as McpConfig;
    const rawServers = isRecord(parsed.mcpServers) ? parsed.mcpServers : {};
    const servers: Record<string, McpServerConfig> = {};
    for (const [name, value] of Object.entries(rawServers)) {
        const normalized = normalizeServerConfig(value);
        if (normalized) servers[name] = normalized;
    }
    return { path: filePath, servers };
}

export function getMcpConfigPaths(cwd = process.cwd(), homeDir = os.homedir()): string[] {
    return [
        path.join(homeDir, ".perry", "mcp.json"),
        path.join(cwd, ".perry", "mcp.json"),
        path.join(cwd, ".mcp.json"),
    ];
}

export function loadMcpConfig(cwd = process.cwd(), homeDir = os.homedir()): { files: McpLoadedConfig[]; servers: Record<string, McpServerConfig> } {
    const files: McpLoadedConfig[] = [];
    const servers: Record<string, McpServerConfig> = {};

    for (const configPath of getMcpConfigPaths(cwd, homeDir)) {
        const loaded = readMcpConfigFile(configPath);
        if (!loaded) continue;
        files.push(loaded);
        Object.assign(servers, loaded.servers);
    }

    return { files, servers };
}

export function sanitizeMcpToolNamePart(value: string): string {
    const sanitized = value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
    return sanitized || "unnamed";
}

export function createMcpFunctionName(serverName: string, toolName: string, usedNames = new Set<string>()): string {
    const base = `mcp__${sanitizeMcpToolNamePart(serverName)}__${sanitizeMcpToolNamePart(toolName)}`.slice(0, 64);
    let candidate = base;
    let suffix = 2;
    while (usedNames.has(candidate)) {
        const extra = `_${suffix++}`;
        candidate = `${base.slice(0, Math.max(1, 64 - extra.length))}${extra}`;
    }
    usedNames.add(candidate);
    return candidate;
}

function normalizeToolSchema(schema: unknown): Record<string, unknown> {
    if (!isRecord(schema)) {
        return { type: "object", properties: {}, additionalProperties: true };
    }
    return schema;
}

function formatMcpContent(value: unknown): string {
    if (Array.isArray(value)) {
        return value.map((item) => {
            if (!isRecord(item)) return JSON.stringify(item);
            if (item.type === "text" && typeof item.text === "string") return item.text;
            if (item.type === "image") return `[image${typeof item.mimeType === "string" ? ` ${item.mimeType}` : ""}]`;
            if (item.type === "resource") return `[resource] ${JSON.stringify(item.resource ?? item)}`;
            return JSON.stringify(item);
        }).join("\n");
    }
    if (typeof value === "string") return value;
    return JSON.stringify(value, null, 2);
}

function clipMcpOutput(value: string): string {
    if (value.length <= MAX_MCP_OUTPUT_CHARS) return value;
    return `${value.slice(0, MAX_MCP_OUTPUT_CHARS).trimEnd()}\n… truncated MCP output (${value.length - MAX_MCP_OUTPUT_CHARS} more chars)`;
}

function parseToolList(result: unknown): { tools: McpToolInfo[]; nextCursor?: string } {
    if (!isRecord(result)) return { tools: [] };
    const tools = Array.isArray(result.tools) ? result.tools : [];
    return {
        tools: tools.flatMap((tool): McpToolInfo[] => {
            if (!isRecord(tool) || typeof tool.name !== "string") return [];
            return [{
                name: tool.name,
                description: typeof tool.description === "string" ? tool.description : null,
                inputSchema: normalizeToolSchema(tool.inputSchema),
            }];
        }),
        nextCursor: typeof result.nextCursor === "string" ? result.nextCursor : undefined,
    };
}

export class StdioMcpClient {
    private proc: ChildProcessWithoutNullStreams | null = null;
    private nextId = 1;
    private readonly pending = new Map<string | number, PendingRequest>();
    private stdoutBuffer = "";
    private stderrTail = "";
    private initialized = false;

    constructor(
        readonly serverName: string,
        private readonly config: McpServerConfig,
        private readonly cwd = process.cwd(),
        private readonly requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    ) {}

    get stderr(): string {
        return this.stderrTail.trim();
    }

    async connect(): Promise<void> {
        if (this.initialized) return;
        const commandCwd = this.config.cwd ? path.resolve(this.cwd, this.config.cwd) : this.cwd;
        this.proc = spawn(this.config.command, this.config.args ?? [], {
            cwd: commandCwd,
            env: { ...process.env, ...(this.config.env ?? {}) },
            stdio: ["pipe", "pipe", "pipe"],
        });

        this.proc.stdout.setEncoding("utf8");
        this.proc.stdout.on("data", (chunk: string) => this.onStdout(chunk));
        this.proc.stderr.setEncoding("utf8");
        this.proc.stderr.on("data", (chunk: string) => {
            this.stderrTail = `${this.stderrTail}${chunk}`.slice(-8_000);
        });
        this.proc.on("error", (error) => this.rejectAll(error));
        this.proc.on("exit", (code, signal) => {
            if (this.pending.size > 0) {
                this.rejectAll(new Error(`MCP server '${this.serverName}' exited (${signal ?? code ?? "unknown"}).`));
            }
            this.initialized = false;
        });

        await this.request("initialize", {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "perry", version: "1.0.0" },
        });
        this.notify("notifications/initialized", {});
        this.initialized = true;
    }

    async listTools(): Promise<McpToolInfo[]> {
        await this.connect();
        const allTools: McpToolInfo[] = [];
        let cursor: string | undefined;
        do {
            const result = await this.request("tools/list", cursor ? { cursor } : {});
            const page = parseToolList(result);
            allTools.push(...page.tools);
            cursor = page.nextCursor;
        } while (cursor);
        return allTools;
    }

    async callTool(name: string, args: Record<string, unknown>): Promise<{ output: string; isError: boolean; raw: unknown }> {
        await this.connect();
        const result = await this.request("tools/call", { name, arguments: args });
        const record = isRecord(result) ? result : {};
        const content = "content" in record ? record.content : result;
        const output = clipMcpOutput(formatMcpContent(content));
        return { output, isError: record.isError === true, raw: result };
    }

    async close(): Promise<void> {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error(`MCP server '${this.serverName}' closed.`));
        }
        this.pending.clear();
        if (!this.proc) return;
        this.proc.kill("SIGTERM");
        this.proc = null;
        this.initialized = false;
    }

    private request(method: string, params?: unknown): Promise<unknown> {
        if (!this.proc?.stdin.writable) {
            return Promise.reject(new Error(`MCP server '${this.serverName}' is not running.`));
        }
        const id = this.nextId++;
        const message: JsonRpcMessage = { jsonrpc: "2.0", id, method, params };
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`MCP request '${method}' to '${this.serverName}' timed out.`));
            }, this.requestTimeoutMs);
            timer.unref?.();
            this.pending.set(id, { resolve, reject, timer });
            this.proc?.stdin.write(`${JSON.stringify(message)}\n`);
        });
    }

    private notify(method: string, params?: unknown): void {
        if (!this.proc?.stdin.writable) return;
        this.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    }

    private onStdout(chunk: string): void {
        this.stdoutBuffer += chunk;
        while (true) {
            const newlineIndex = this.stdoutBuffer.indexOf("\n");
            if (newlineIndex < 0) break;
            const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
            this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
            if (!line) continue;
            let message: JsonRpcMessage;
            try {
                message = JSON.parse(line) as JsonRpcMessage;
            } catch {
                continue;
            }
            if (message.id === undefined || message.id === null) continue;
            const pending = this.pending.get(message.id);
            if (!pending) continue;
            this.pending.delete(message.id);
            clearTimeout(pending.timer);
            if (message.error) {
                pending.reject(new Error(message.error.message ?? `MCP JSON-RPC error ${message.error.code ?? "unknown"}`));
            } else {
                pending.resolve(message.result);
            }
        }
    }

    private rejectAll(error: Error): void {
        for (const [id, pending] of this.pending.entries()) {
            this.pending.delete(id);
            clearTimeout(pending.timer);
            pending.reject(error);
        }
    }
}

export interface McpRegisteredTool {
    functionName: string;
    serverName: string;
    tool: McpToolInfo;
}

export class McpManager {
    private clients = new Map<string, StdioMcpClient>();
    private registeredTools: McpRegisteredTool[] = [];
    private configFiles: string[] = [];

    constructor(private readonly cwd = process.cwd(), private readonly homeDir = os.homedir()) {}

    get files(): string[] {
        return [...this.configFiles];
    }

    get tools(): McpRegisteredTool[] {
        return [...this.registeredTools];
    }

    get serverNames(): string[] {
        return [...this.clients.keys()];
    }

    async load(): Promise<void> {
        await this.close();
        const loaded = loadMcpConfig(this.cwd, this.homeDir);
        this.configFiles = loaded.files.map((file) => file.path);
        for (const [name, config] of Object.entries(loaded.servers)) {
            if (config.disabled) continue;
            this.clients.set(name, new StdioMcpClient(name, config, this.cwd));
        }
        await this.refreshTools();
    }

    async refreshTools(): Promise<void> {
        const usedNames = new Set<string>();
        const tools: McpRegisteredTool[] = [];
        for (const [serverName, client] of this.clients.entries()) {
            const listed = await client.listTools();
            for (const tool of listed) {
                tools.push({
                    functionName: createMcpFunctionName(serverName, tool.name, usedNames),
                    serverName,
                    tool,
                });
            }
        }
        this.registeredTools = tools;
    }

    async call(functionName: string, args: unknown): Promise<ToolExecutionResult<McpTraceDetails>> {
        const registered = this.registeredTools.find((tool) => tool.functionName === functionName);
        if (!registered) {
            return {
                output: `Unknown MCP tool: ${functionName}`,
                isError: true,
                details: { type: "mcp", toolName: functionName, note: "Unknown MCP tool" },
            };
        }
        const client = this.clients.get(registered.serverName);
        if (!client) {
            return {
                output: `MCP server is not running: ${registered.serverName}`,
                isError: true,
                details: { type: "mcp", serverLabel: registered.serverName, toolName: registered.tool.name, note: "Server not running" },
            };
        }
        const toolArgs = isRecord(args) ? args : {};
        try {
            const result = await client.callTool(registered.tool.name, toolArgs);
            return {
                output: result.output || "MCP tool returned no output.",
                modelOutput: result.output || "MCP tool returned no output.",
                isError: result.isError,
                details: {
                    type: "mcp",
                    serverLabel: registered.serverName,
                    toolName: registered.tool.name,
                    argumentsText: JSON.stringify(toolArgs, null, 2),
                    output: result.output,
                    note: result.isError ? "MCP tool returned an error." : "MCP tool completed.",
                },
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
                output: message,
                isError: true,
                details: {
                    type: "mcp",
                    serverLabel: registered.serverName,
                    toolName: registered.tool.name,
                    argumentsText: JSON.stringify(toolArgs, null, 2),
                    note: "MCP tool failed.",
                },
            };
        }
    }

    async close(): Promise<void> {
        await Promise.all([...this.clients.values()].map((client) => client.close().catch(() => undefined)));
        this.clients.clear();
        this.registeredTools = [];
    }

    describe(): string {
        if (this.configFiles.length === 0) {
            return "MCP: no config files found. Add ~/.perry/mcp.json, .perry/mcp.json, or .mcp.json.";
        }
        const lines = [
            `MCP config: ${this.configFiles.join(", ")}`,
            `Servers: ${this.serverNames.length ? this.serverNames.join(", ") : "none enabled"}`,
            `Tools: ${this.registeredTools.length}`,
        ];
        for (const tool of this.registeredTools) {
            lines.push(`- ${tool.functionName} (${tool.serverName} · ${tool.tool.name})${tool.tool.description ? ` — ${tool.tool.description}` : ""}`);
        }
        return lines.join("\n");
    }
}

export function createMcpTools(manager: McpManager): Array<Tool<Record<string, unknown>, McpTraceDetails>> {
    return manager.tools.map((registered): Tool<Record<string, unknown>, McpTraceDetails> => ({
        name: registered.functionName,
        definition: {
            type: "function",
            name: registered.functionName,
            description: registered.tool.description || `Call MCP tool ${registered.tool.name} on server ${registered.serverName}.`,
            parameters: normalizeToolSchema(registered.tool.inputSchema),
            strict: false,
        } as OpenAI.Responses.FunctionTool,
        execute: async (args) => manager.call(registered.functionName, args),
    }));
}
