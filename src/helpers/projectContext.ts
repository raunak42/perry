import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { authDir } from "../constants";

export type ProjectContextFile = {
    path: string;
    content: string;
};

export const PROJECT_CONTEXT_FILE_CANDIDATES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"] as const;
export const SELF_MANIFEST_FILENAME = "SELF_MANIFEST.md";

export function getDefaultAgentDir(baseDir = authDir): string {
    return path.join(baseDir, "agent");
}

export function loadContextFileFromDir(dir: string): ProjectContextFile | null {
    const resolvedDir = path.resolve(dir);

    for (const filename of PROJECT_CONTEXT_FILE_CANDIDATES) {
        const filePath = path.join(resolvedDir, filename);
        if (!existsSync(filePath)) continue;

        try {
            return {
                path: filePath,
                content: readFileSync(filePath, "utf8"),
            };
        } catch {
            continue;
        }
    }

    return null;
}

export function loadSelfManifest(options: {
    cwd?: string;
} = {}): ProjectContextFile | null {
    const manifestPath = path.join(path.resolve(options.cwd ?? process.cwd()), SELF_MANIFEST_FILENAME);
    if (!existsSync(manifestPath)) return null;

    try {
        return {
            path: manifestPath,
            content: readFileSync(manifestPath, "utf8"),
        };
    } catch {
        return null;
    }
}

export function loadProjectContextFiles(options: {
    cwd?: string;
    agentDir?: string;
} = {}): ProjectContextFile[] {
    const resolvedCwd = path.resolve(options.cwd ?? process.cwd());
    const resolvedAgentDir = path.resolve(options.agentDir ?? getDefaultAgentDir());
    const contextFiles: ProjectContextFile[] = [];
    const seenPaths = new Set<string>();

    const globalContext = loadContextFileFromDir(resolvedAgentDir);
    if (globalContext) {
        contextFiles.push(globalContext);
        seenPaths.add(globalContext.path);
    }

    const ancestorContextFiles: ProjectContextFile[] = [];
    let currentDir = resolvedCwd;
    const root = path.parse(resolvedCwd).root;

    while (true) {
        const contextFile = loadContextFileFromDir(currentDir);
        if (contextFile && !seenPaths.has(contextFile.path)) {
            ancestorContextFiles.unshift(contextFile);
            seenPaths.add(contextFile.path);
        }

        if (currentDir === root) break;
        const parentDir = path.dirname(currentDir);
        if (parentDir === currentDir) break;
        currentDir = parentDir;
    }

    contextFiles.push(...ancestorContextFiles);
    return contextFiles;
}
