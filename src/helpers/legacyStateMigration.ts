import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    DEFAULT_DEV_PERRY_HOME_DIRNAME,
    getPerryHomeDir,
    isRunningFromSourcePackage,
} from "./packageInfo";

export const LEGACY_PERRY_HOME_DIRNAME = ".perry";

export interface LegacySessionMigrationResult {
    sourceDir: string;
    targetDir: string;
    copiedFiles: number;
    skippedFiles: number;
    reason?: string;
}

function hasExplicitPerryHome(env: NodeJS.ProcessEnv): boolean {
    return typeof env.PERRY_HOME === "string" && env.PERRY_HOME.trim().length > 0;
}

function safeIsDirectory(filePath: string): boolean {
    try {
        return statSync(filePath).isDirectory();
    } catch {
        return false;
    }
}

function collectSessionFiles(rootDir: string, currentDir = rootDir): string[] {
    let entries: string[];
    try {
        entries = readdirSync(currentDir);
    } catch {
        return [];
    }

    const files: string[] = [];
    for (const entry of entries) {
        const filePath = path.join(currentDir, entry);
        let stats;
        try {
            stats = statSync(filePath);
        } catch {
            continue;
        }

        if (stats.isDirectory()) {
            files.push(...collectSessionFiles(rootDir, filePath));
            continue;
        }

        if (stats.isFile() && entry.endsWith(".jsonl")) {
            files.push(filePath);
        }
    }

    return files;
}

function makeResult(sourceDir: string, targetDir: string, reason: string): LegacySessionMigrationResult {
    return { sourceDir, targetDir, copiedFiles: 0, skippedFiles: 0, reason };
}

export function migrateLegacyDevSessions(options: {
    env?: NodeJS.ProcessEnv;
    startDir?: string;
    legacyHomeDir?: string;
    targetHomeDir?: string;
    disabled?: boolean;
} = {}): LegacySessionMigrationResult {
    const env = options.env ?? process.env;
    const legacyHomeDir = path.resolve(options.legacyHomeDir ?? path.join(os.homedir(), LEGACY_PERRY_HOME_DIRNAME));
    const targetHomeDir = path.resolve(options.targetHomeDir ?? getPerryHomeDir(env, options.startDir));
    const sourceDir = path.join(legacyHomeDir, "sessions");
    const targetDir = path.join(targetHomeDir, "sessions");

    if (options.disabled) return makeResult(sourceDir, targetDir, "disabled");
    if (hasExplicitPerryHome(env)) return makeResult(sourceDir, targetDir, "explicit_perry_home");
    if (!isRunningFromSourcePackage(options.startDir)) return makeResult(sourceDir, targetDir, "not_source_package");
    if (path.basename(targetHomeDir) !== DEFAULT_DEV_PERRY_HOME_DIRNAME) return makeResult(sourceDir, targetDir, "target_is_not_dev_home");
    if (path.resolve(sourceDir) === path.resolve(targetDir)) return makeResult(sourceDir, targetDir, "same_directory");
    if (!existsSync(sourceDir) || !safeIsDirectory(sourceDir)) return makeResult(sourceDir, targetDir, "no_legacy_sessions");

    const files = collectSessionFiles(sourceDir);
    if (files.length === 0) return makeResult(sourceDir, targetDir, "no_legacy_session_files");

    let copiedFiles = 0;
    let skippedFiles = 0;

    for (const filePath of files) {
        const relativePath = path.relative(sourceDir, filePath);
        if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
            skippedFiles += 1;
            continue;
        }

        const targetPath = path.join(targetDir, relativePath);
        if (existsSync(targetPath)) {
            skippedFiles += 1;
            continue;
        }

        mkdirSync(path.dirname(targetPath), { recursive: true });
        copyFileSync(filePath, targetPath);
        copiedFiles += 1;
    }

    return {
        sourceDir,
        targetDir,
        copiedFiles,
        skippedFiles,
        reason: copiedFiles > 0 ? undefined : "all_legacy_sessions_already_present",
    };
}

export function formatLegacySessionMigrationMessage(result: LegacySessionMigrationResult): string | null {
    if (result.copiedFiles <= 0) return null;
    const sessionLabel = result.copiedFiles === 1 ? "session file" : "session files";
    const skipped = result.skippedFiles > 0 ? ` (${result.skippedFiles} already present or skipped)` : "";
    return `Copied ${result.copiedFiles} legacy ${sessionLabel} from ${result.sourceDir} to ${result.targetDir}${skipped}. Auth and preferences were not migrated.`;
}
