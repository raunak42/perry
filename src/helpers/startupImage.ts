import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { getPackageRoot } from "./packageInfo";
import type { ProjectContextFile } from "./projectContext";
import type { PermissionMode } from "./permissions";
import type { SessionDetailLine, StartupCard } from "../ui/types";

export const DEFAULT_STARTUP_IMAGE_PATH = path.join(getPackageRoot(), "assets", "startup.png");
export const DEFAULT_STARTUP_ANSI_IMAGE_PATH = path.join(getPackageRoot(), "assets", "startup.ans");

export function getStartupImagePath(env: NodeJS.ProcessEnv = process.env): string | null {
    const configured = env.PERRY_STARTUP_IMAGE ?? env.PERRY_STARTUP_IMAGE_PATH;
    if (configured !== undefined) {
        const value = configured.trim();
        if (isDisabledValue(value)) return null;
        return resolveStartupImagePath(value, env);
    }
    return existsSync(DEFAULT_STARTUP_IMAGE_PATH) ? DEFAULT_STARTUP_IMAGE_PATH : null;
}

export function getStartupAnsiImagePath(env: NodeJS.ProcessEnv = process.env): string | null {
    const configured = env.PERRY_STARTUP_IMAGE_ANSI ?? env.PERRY_ANSI_STARTUP_IMAGE;
    if (configured !== undefined) {
        const value = configured.trim();
        if (isDisabledValue(value)) return null;
        return resolveStartupImagePath(value, env);
    }
    return existsSync(DEFAULT_STARTUP_ANSI_IMAGE_PATH) ? DEFAULT_STARTUP_ANSI_IMAGE_PATH : null;
}

export function getStartupAnsiImageSize(env: NodeJS.ProcessEnv = process.env): { width?: number; height?: number } {
    return {
        width: parsePositiveInteger(env.PERRY_STARTUP_IMAGE_ANSI_WIDTH ?? env.PERRY_ANSI_STARTUP_IMAGE_WIDTH),
        height: parsePositiveInteger(env.PERRY_STARTUP_IMAGE_ANSI_HEIGHT ?? env.PERRY_ANSI_STARTUP_IMAGE_HEIGHT),
    };
}

export function resolveStartupImagePath(value: string, env: NodeJS.ProcessEnv = process.env): string {
    const trimmed = value.trim();
    if (trimmed.startsWith("file://")) {
        try {
            return fileURLToPath(trimmed);
        } catch {
            return trimmed;
        }
    }
    if (trimmed.startsWith("recent:///")) return resolveRecentUri(trimmed, env) ?? trimmed;
    return trimmed;
}

export function buildStartupCard(params: {
    sessionId: string;
    persisted: boolean;
    sessionDir?: string;
    cwd: string;
    messageCount: number;
    provider: string | null;
    model: string;
    reasoningLevel: string;
    subagentReasoningLevel?: string;
    subagentsMode?: boolean;
    contextLevel: string;
    imagePath?: string | null;
    ansiImagePath?: string | null;
    ansiImageMaxWidth?: number;
    ansiImageMaxHeight?: number;
    contextFiles?: ProjectContextFile[];
    permissionMode?: PermissionMode;
    planMode?: boolean;
    skillCount?: number;
    activeSkillName?: string | null;
}): StartupCard {
    const lines: SessionDetailLine[] = [
        { left: "Provider", right: params.provider ?? "not logged in" },
        { left: "Model", right: `${params.model} · ${params.reasoningLevel}` },
        { left: "Plan mode", right: params.planMode ? "enabled" : "disabled" },
        { left: "Directory", right: params.cwd },
    ];

    return {
        title: "Perry",
        subtitle: "Type /quit to exit",
        imagePath: params.imagePath ?? null,
        ansiImagePath: params.ansiImagePath ?? null,
        ansiImageMaxWidth: params.ansiImageMaxWidth,
        ansiImageMaxHeight: params.ansiImageMaxHeight,
        lines,
    };
}

function isDisabledValue(value: string): boolean {
    return ["", "off", "0", "false", "none", "disabled"].includes(value.toLowerCase());
}

function parsePositiveInteger(value: string | undefined): number | undefined {
    if (!value) return undefined;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function resolveRecentUri(uri: string, env: NodeJS.ProcessEnv): string | null {
    const result = spawnSync("gio", ["info", "-a", "standard::target-uri", uri], {
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status !== 0 || !result.stdout) return null;
    const match = result.stdout.match(/standard::target-uri:\s*(\S+)/);
    if (!match?.[1]) return null;
    try {
        return fileURLToPath(match[1]);
    } catch {
        return match[1];
    }
}

