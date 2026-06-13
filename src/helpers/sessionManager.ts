import { randomUUID } from "node:crypto";
import {
    appendFileSync,
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
    readSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { authDir } from "../constants";
import {
    buildContextHistoryFromEntries,
    type CompactionResult,
} from "./compaction";
import type { ContextLevel, ReasoningLevel } from "./models";
import type { PermissionMode } from "./permissions";
import type { KnownToolTraceDetails } from "../tools/traceDetails";
import type { ToolTraceStatus } from "../ui/traceFormatting";

export const CURRENT_SESSION_VERSION = 3;

export type PersistedChatMessage = {
    role: "user" | "assistant" | "developer";
    content: string;
};

export type PersistedProvider = "openai-api-key" | "openai-codex" | null;

export interface SessionHeader {
    type: "session";
    version: number;
    id: string;
    timestamp: string;
    cwd: string;
    parentSession?: string;
}

export interface SessionEntryBase {
    type: string;
    id: string;
    parentId: string | null;
    timestamp: string;
}

export interface SessionMessageEntry extends SessionEntryBase {
    type: "message";
    message: PersistedChatMessage;
}

export interface SessionStateSnapshot {
    provider: PersistedProvider;
    model: string;
    reasoningLevel: ReasoningLevel;
    subagentReasoningLevel?: ReasoningLevel;
    contextLevel: ContextLevel;
    permissionMode?: PermissionMode;
    subagentsMode?: boolean;
}

export interface SessionStateEntry extends SessionEntryBase, SessionStateSnapshot {
    type: "state";
}

export interface SessionCompactionEntry extends SessionEntryBase {
    type: "compaction";
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
}

export interface PersistedToolTrace {
    id: string;
    displayId?: number;
    toolName: string;
    args?: unknown;
    argsText?: string;
    output: string;
    status: ToolTraceStatus;
    details?: KnownToolTraceDetails;
    expanded?: boolean;
    startedAt?: number;
    finishedAt?: number;
}

export interface SessionToolTraceEntry extends SessionEntryBase {
    type: "tool_trace";
    trace: PersistedToolTrace;
}

export type SessionEntry = SessionMessageEntry | SessionStateEntry | SessionCompactionEntry | SessionToolTraceEntry;
export type SessionFileEntry = SessionHeader | SessionEntry;

export interface SessionInfo {
    path: string;
    id: string;
    cwd: string;
    created: Date;
    modified: Date;
    messageCount: number;
    firstMessage: string;
    allMessagesText: string;
}

export type SessionListProgress = (loaded: number, total: number) => void;

function generateEntryId(existing: { has(id: string): boolean }): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const id = randomUUID().slice(0, 8);
        if (!existing.has(id)) return id;
    }
    return randomUUID();
}

function getPerrySessionsRoot(baseDir = authDir): string {
    return path.join(baseDir, "sessions");
}

export function getDefaultSessionDir(cwd: string, baseDir = authDir): string {
    const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
    const dir = path.join(baseDir, "sessions", safePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
}

export function getSessionHomeDirFromSessionDir(sessionDir?: string): string | undefined {
    if (!sessionDir) return undefined;
    const parent = path.dirname(path.resolve(sessionDir));
    if (path.basename(parent) !== "sessions") return undefined;
    return path.dirname(parent);
}

export function parseSessionEntries(content: string): SessionFileEntry[] {
    const entries: SessionFileEntry[] = [];
    for (const line of content.trim().split("\n")) {
        if (!line.trim()) continue;
        try {
            entries.push(JSON.parse(line) as SessionFileEntry);
        } catch {
            // Ignore malformed trailing/partial lines.
        }
    }
    return entries;
}

export function loadEntriesFromFile(filePath: string): SessionFileEntry[] {
    if (!existsSync(filePath)) return [];
    const entries = parseSessionEntries(readFileSync(filePath, "utf8"));
    if (entries.length === 0) return [];
    const header = entries[0];
    if (header.type !== "session" || typeof (header as SessionHeader).id !== "string") return [];
    return entries;
}

function isValidSessionFile(filePath: string): boolean {
    try {
        const fd = openSync(filePath, "r");
        const buffer = Buffer.alloc(512);
        const bytesRead = readSync(fd, buffer, 0, 512, 0);
        closeSync(fd);
        const firstLine = buffer.toString("utf8", 0, bytesRead).split("\n")[0];
        if (!firstLine) return false;
        const header = JSON.parse(firstLine) as SessionHeader;
        return header.type === "session" && typeof header.id === "string";
    } catch {
        return false;
    }
}

export function findMostRecentSession(sessionDir: string): string | null {
    try {
        const files = readdirSync(sessionDir)
            .filter((file) => file.endsWith(".jsonl"))
            .map((file) => path.join(sessionDir, file))
            .filter(isValidSessionFile)
            .map((filePath) => ({ filePath, mtime: statSync(filePath).mtime.getTime() }))
            .sort((left, right) => right.mtime - left.mtime);
        return files[0]?.filePath ?? null;
    } catch {
        return null;
    }
}

function getMessageTimestamp(entry: SessionMessageEntry): number | null {
    const timestamp = new Date(entry.timestamp).getTime();
    return Number.isNaN(timestamp) ? null : timestamp;
}

function getSessionModifiedDate(entries: SessionFileEntry[], fallback: Date): Date {
    let latest = 0;
    for (const entry of entries) {
        if (entry.type !== "message") continue;
        const timestamp = getMessageTimestamp(entry as SessionMessageEntry);
        if (timestamp !== null) latest = Math.max(latest, timestamp);
    }
    return latest > 0 ? new Date(latest) : fallback;
}

function shortenWhitespace(text: string): string {
    return text.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
}

async function buildSessionInfo(filePath: string): Promise<SessionInfo | null> {
    try {
        const content = await readFile(filePath, "utf8");
        const entries = parseSessionEntries(content);
        if (entries.length === 0) return null;
        const header = entries[0] as SessionHeader;
        if (header.type !== "session") return null;

        const stats = await stat(filePath);
        const allMessages: string[] = [];
        let firstMessage = "";
        let messageCount = 0;

        for (const entry of entries) {
            if (entry.type !== "message") continue;
            const message = (entry as SessionMessageEntry).message;
            if (message.role !== "user" && message.role !== "assistant") continue;
            messageCount += 1;
            const text = shortenWhitespace(message.content);
            if (!text) continue;
            allMessages.push(text);
            if (!firstMessage && message.role === "user") firstMessage = text;
        }

        return {
            path: filePath,
            id: header.id,
            cwd: typeof header.cwd === "string" ? header.cwd : "",
            created: new Date(header.timestamp),
            modified: getSessionModifiedDate(entries, stats.mtime),
            messageCount,
            firstMessage: firstMessage || "(no messages)",
            allMessagesText: allMessages.join(" "),
        };
    } catch {
        return null;
    }
}

async function listSessionsFromDir(
    dir: string,
    onProgress?: SessionListProgress,
    progressOffset = 0,
    progressTotal?: number,
): Promise<SessionInfo[]> {
    if (!existsSync(dir)) return [];
    try {
        const files = (await readdir(dir)).filter((file) => file.endsWith(".jsonl")).map((file) => path.join(dir, file));
        const total = progressTotal ?? files.length;
        let loaded = 0;
        const infos = await Promise.all(files.map(async (filePath) => {
            const info = await buildSessionInfo(filePath);
            loaded += 1;
            onProgress?.(progressOffset + loaded, total);
            return info;
        }));
        return infos.filter((info): info is SessionInfo => info !== null);
    } catch {
        return [];
    }
}

export type ResolvedSession =
    | { type: "path"; path: string }
    | { type: "local"; path: string }
    | { type: "global"; path: string; cwd: string }
    | { type: "not_found"; arg: string };

export async function resolveSessionPath(sessionArg: string, cwd: string, sessionDir?: string): Promise<ResolvedSession> {
    if (sessionArg.includes("/") || sessionArg.includes("\\") || sessionArg.endsWith(".jsonl")) {
        return { type: "path", path: sessionArg };
    }

    const localSessions = await SessionManager.list(cwd, sessionDir);
    const localMatch = localSessions.find((session) => session.id.startsWith(sessionArg));
    if (localMatch) return { type: "local", path: localMatch.path };

    const allSessions = await SessionManager.listAll(undefined, getSessionHomeDirFromSessionDir(sessionDir));
    const globalMatch = allSessions.find((session) => session.id.startsWith(sessionArg));
    if (globalMatch) return { type: "global", path: globalMatch.path, cwd: globalMatch.cwd };

    return { type: "not_found", arg: sessionArg };
}

export function formatSessionAge(date: Date): string {
    const diffMs = Date.now() - date.getTime();
    const minutes = Math.floor(diffMs / 60_000);
    const hours = Math.floor(diffMs / 3_600_000);
    const days = Math.floor(diffMs / 86_400_000);
    if (minutes < 1) return "now";
    if (minutes < 60) return `${minutes}m`;
    if (hours < 24) return `${hours}h`;
    if (days < 7) return `${days}d`;
    if (days < 30) return `${Math.floor(days / 7)}w`;
    if (days < 365) return `${Math.floor(days / 30)}mo`;
    return `${Math.floor(days / 365)}y`;
}

export function formatSessionPath(cwd: string): string {
    const home = os.homedir();
    return cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}

export class SessionManager {
    private sessionId = "";
    private sessionFile: string | undefined;
    private sessionDir: string;
    private cwd: string;
    private persist: boolean;
    private flushed = false;
    private fileEntries: SessionFileEntry[] = [];
    private byId: Map<string, SessionEntry> = new Map();
    private leafId: string | null = null;

    private constructor(cwd: string, sessionDir: string, sessionFile: string | undefined, persist: boolean) {
        this.cwd = cwd;
        this.sessionDir = sessionDir;
        this.persist = persist;
        if (persist && sessionDir && !existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });
        if (sessionFile) this.setSessionFile(sessionFile);
        else this.newSession();
    }

    setSessionFile(sessionFile: string): void {
        this.sessionFile = path.resolve(sessionFile);
        if (existsSync(this.sessionFile)) {
            this.fileEntries = loadEntriesFromFile(this.sessionFile);
            if (this.fileEntries.length === 0) {
                const explicitPath = this.sessionFile;
                this.newSession();
                this.sessionFile = explicitPath;
                this.rewriteFile();
                this.flushed = true;
                return;
            }
            const header = this.fileEntries[0] as SessionHeader;
            this.sessionId = header.id ?? randomUUID();
            this.cwd = header.cwd || this.cwd;
            if (header.version !== CURRENT_SESSION_VERSION) {
                header.version = CURRENT_SESSION_VERSION;
                this.rewriteFile();
            }
            this.buildIndex();
            this.flushed = true;
            return;
        }

        const explicitPath = this.sessionFile;
        this.newSession();
        this.sessionFile = explicitPath;
    }

    newSession(options?: { id?: string; parentSession?: string }): string | undefined {
        this.sessionId = options?.id ?? randomUUID();
        const timestamp = new Date().toISOString();
        const header: SessionHeader = {
            type: "session",
            version: CURRENT_SESSION_VERSION,
            id: this.sessionId,
            timestamp,
            cwd: this.cwd,
            parentSession: options?.parentSession,
        };
        this.fileEntries = [header];
        this.byId.clear();
        this.leafId = null;
        this.flushed = false;
        if (this.persist) {
            const fileTimestamp = timestamp.replace(/[:.]/g, "-");
            this.sessionFile = path.join(this.sessionDir, `${fileTimestamp}_${this.sessionId}.jsonl`);
        }
        return this.sessionFile;
    }

    private buildIndex(): void {
        this.byId.clear();
        this.leafId = null;
        for (const entry of this.fileEntries) {
            if (entry.type === "session") continue;
            this.byId.set(entry.id, entry);
            if (entry.type !== "tool_trace") this.leafId = entry.id;
        }
    }

    private rewriteFile(): void {
        if (!this.persist || !this.sessionFile) return;
        writeFileSync(this.sessionFile, `${this.fileEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    }

    private persistEntry(entry: SessionEntry): void {
        if (!this.persist || !this.sessionFile) return;
        const hasAssistant = this.fileEntries.some((item) => item.type === "message" && item.message.role === "assistant");
        if (!hasAssistant) {
            this.flushed = false;
            return;
        }
        if (!this.flushed) {
            for (const item of this.fileEntries) appendFileSync(this.sessionFile, `${JSON.stringify(item)}\n`);
            this.flushed = true;
            return;
        }
        appendFileSync(this.sessionFile, `${JSON.stringify(entry)}\n`);
    }

    private appendEntry(entry: SessionEntry): string {
        this.fileEntries.push(entry);
        this.byId.set(entry.id, entry);
        if (entry.type !== "tool_trace") this.leafId = entry.id;
        this.persistEntry(entry);
        return entry.id;
    }

    appendMessage(message: PersistedChatMessage): string {
        const entry: SessionMessageEntry = {
            type: "message",
            id: generateEntryId(this.byId),
            parentId: this.leafId,
            timestamp: new Date().toISOString(),
            message,
        };
        return this.appendEntry(entry);
    }

    appendState(snapshot: SessionStateSnapshot): string {
        const latest = this.getLatestState();
        if (latest && JSON.stringify(latest) === JSON.stringify(snapshot)) {
            return this.leafId ?? "";
        }
        const entry: SessionStateEntry = {
            type: "state",
            id: generateEntryId(this.byId),
            parentId: this.leafId,
            timestamp: new Date().toISOString(),
            provider: snapshot.provider,
            model: snapshot.model,
            reasoningLevel: snapshot.reasoningLevel,
            subagentReasoningLevel: snapshot.subagentReasoningLevel,
            contextLevel: snapshot.contextLevel,
            permissionMode: snapshot.permissionMode,
            subagentsMode: snapshot.subagentsMode,
        };
        return this.appendEntry(entry);
    }

    appendCompaction(result: CompactionResult): string {
        const entry: SessionCompactionEntry = {
            type: "compaction",
            id: generateEntryId(this.byId),
            parentId: this.leafId,
            timestamp: new Date().toISOString(),
            summary: result.summary,
            firstKeptEntryId: result.firstKeptEntryId,
            tokensBefore: result.tokensBefore,
        };
        return this.appendEntry(entry);
    }

    appendToolTrace(trace: PersistedToolTrace): string {
        const existingIndex = this.fileEntries.findIndex((entry) => entry.type === "tool_trace" && entry.trace.id === trace.id);
        if (existingIndex >= 0) {
            const existing = this.fileEntries[existingIndex] as SessionToolTraceEntry;
            const next: SessionToolTraceEntry = {
                ...existing,
                timestamp: new Date().toISOString(),
                trace,
            };
            this.fileEntries[existingIndex] = next;
            this.byId.set(next.id, next);
            if (this.persist && this.flushed) this.rewriteFile();
            return next.id;
        }

        const entry: SessionToolTraceEntry = {
            type: "tool_trace",
            id: generateEntryId(this.byId),
            parentId: this.leafId,
            timestamp: new Date().toISOString(),
            trace,
        };
        return this.appendEntry(entry);
    }

    buildHistory(): PersistedChatMessage[] {
        return this.fileEntries
            .filter((entry): entry is SessionMessageEntry => entry.type === "message")
            .map((entry) => entry.message)
            .filter((message) => message.role === "user" || message.role === "assistant");
    }

    buildContextHistory(): PersistedChatMessage[] {
        return buildContextHistoryFromEntries(this.getEntries());
    }

    getLatestState(): SessionStateSnapshot | null {
        for (let index = this.fileEntries.length - 1; index >= 0; index -= 1) {
            const entry = this.fileEntries[index];
            if (entry?.type === "state") {
                return {
                    provider: entry.provider,
                    model: entry.model,
                    reasoningLevel: entry.reasoningLevel,
                    subagentReasoningLevel: entry.subagentReasoningLevel,
                    contextLevel: entry.contextLevel,
                    permissionMode: entry.permissionMode,
                    subagentsMode: entry.subagentsMode,
                };
            }
        }
        return null;
    }

    getHeader(): SessionHeader | null {
        const header = this.fileEntries[0];
        return header?.type === "session" ? header : null;
    }

    getEntries(): SessionEntry[] {
        return this.fileEntries.filter((entry): entry is SessionEntry => entry.type !== "session");
    }

    getLatestCompaction(): SessionCompactionEntry | null {
        for (let index = this.fileEntries.length - 1; index >= 0; index -= 1) {
            const entry = this.fileEntries[index];
            if (entry?.type === "compaction") {
                return entry;
            }
        }
        return null;
    }

    getCompactionCount(): number {
        return this.fileEntries.reduce((count, entry) => count + (entry.type === "compaction" ? 1 : 0), 0);
    }

    getCwd(): string {
        return this.cwd;
    }

    getSessionDir(): string {
        return this.sessionDir;
    }

    getSessionId(): string {
        return this.sessionId;
    }

    getSessionFile(): string | undefined {
        return this.sessionFile;
    }

    isPersisted(): boolean {
        return this.persist;
    }

    static create(cwd: string, sessionDir?: string): SessionManager {
        const dir = sessionDir ?? getDefaultSessionDir(cwd);
        return new SessionManager(cwd, dir, undefined, true);
    }

    static open(filePath: string, sessionDir?: string, cwdOverride?: string): SessionManager {
        const entries = loadEntriesFromFile(filePath);
        const header = entries.find((entry) => entry.type === "session") as SessionHeader | undefined;
        const cwd = cwdOverride ?? header?.cwd ?? process.cwd();
        const dir = sessionDir ?? path.resolve(filePath, "..");
        return new SessionManager(cwd, dir, filePath, true);
    }

    static continueRecent(cwd: string, sessionDir?: string): SessionManager {
        const dir = sessionDir ?? getDefaultSessionDir(cwd);
        const mostRecent = findMostRecentSession(dir);
        if (mostRecent) return new SessionManager(cwd, dir, mostRecent, true);
        return new SessionManager(cwd, dir, undefined, true);
    }

    static inMemory(cwd = process.cwd()): SessionManager {
        return new SessionManager(cwd, "", undefined, false);
    }

    static async list(cwd: string, sessionDir?: string, onProgress?: SessionListProgress): Promise<SessionInfo[]> {
        const dir = sessionDir ?? getDefaultSessionDir(cwd);
        const sessions = await listSessionsFromDir(dir, onProgress);
        sessions.sort((left, right) => right.modified.getTime() - left.modified.getTime());
        return sessions;
    }

    static async listAll(onProgress?: SessionListProgress, baseDir = authDir): Promise<SessionInfo[]> {
        const root = getPerrySessionsRoot(baseDir);
        if (!existsSync(root)) return [];
        try {
            const dirs = (await readdir(root, { withFileTypes: true }))
                .filter((entry) => entry.isDirectory())
                .map((entry) => path.join(root, entry.name));

            let totalFiles = 0;
            const filesByDir: string[][] = [];
            for (const dir of dirs) {
                try {
                    const files = (await readdir(dir)).filter((file) => file.endsWith(".jsonl")).map((file) => path.join(dir, file));
                    filesByDir.push(files);
                    totalFiles += files.length;
                } catch {
                    filesByDir.push([]);
                }
            }

            let loaded = 0;
            const infos = await Promise.all(filesByDir.flat().map(async (filePath) => {
                const info = await buildSessionInfo(filePath);
                loaded += 1;
                onProgress?.(loaded, totalFiles);
                return info;
            }));
            const sessions = infos.filter((info): info is SessionInfo => info !== null);
            sessions.sort((left, right) => right.modified.getTime() - left.modified.getTime());
            return sessions;
        } catch {
            return [];
        }
    }
}
