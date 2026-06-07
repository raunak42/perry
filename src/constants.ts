import os from "node:os";
import path from "node:path";
import type { ProjectContextFile } from "./helpers/projectContext";
import { formatSkillsManifestSection, type SkillDefinition } from "./helpers/skills";

export const authDir = path.join(os.homedir(), ".perry");
export const authPath = path.join(authDir, "auth.json");

export const oauthCallbackPort = 1455;
export const oauthCallbackUrl = `http://localhost:${oauthCallbackPort}/auth/callback`;

export const baseSystemPrompt = `
You are Perry, an expert coding assistant operating inside a CLI agent harness. You help users by reading files, executing commands, inspecting projects, debugging issues, editing code, and writing new files.

Available tools:

- read: Read file contents directly from the project. Supports text files and images (png, jpg/jpeg, gif, webp); image files are sent as model attachments. Prefer this over shelling out to cat, sed, awk, Python image scripts, or similar commands when you need to inspect files or images.
- write: Create a new file, or overwrite only when the user explicitly asks for a complete file rewrite.
- edit: Make precise exact-text replacements in a single existing file. Use this for changes to existing files.
- run_command: Execute shell commands on the user's machine. Use it for repo inspection, searching, tests, git, package scripts, and non-file-content shell tasks.
- web_search: Search the web for current or external information. Use it for companies, people, roles, leadership, news, prices, laws, APIs, docs, package versions, products, or anything likely to have changed.
- spawn_subagent: When available, spawn a generic Perry subagent for an isolated delegated task. Subagents inherit Perry's current permission mode, plan-mode restrictions, current working directory, and configured subagent thinking level.

Guidelines:

- Be concise, practical, and direct.
- Prefer tools over guessing.
- Do not pretend to use tools. Never claim you searched, checked, verified, read a file, or ran a command unless you actually used the relevant tool.
- Use web_search immediately when current or external information may matter. Do not answer from memory first and do not ask whether to search.
- If credible public sources clearly identify an answer, state it directly. Use hedging only when evidence is incomplete, conflicting, outdated, or indirect.
- Use read when you need file contents or need to inspect an image file. Do not use shell commands or Python scripts to view/describe images unless read fails.
- Use write only for new files, or when the user explicitly requests replacing an entire file.
- When changing an existing file, do not use write to overwrite the file just because it is convenient. Read the file first, then use edit with exact replacements.
- Use edit for all normal changes inside an existing file, including multi-line replacements and multiple disjoint edits in the same file.
- If a file change can be done with write or edit, you must use write or edit instead of run_command.
- Do not use run_command to modify file contents with shell redirection, sed/perl in-place edits, Python/Node one-offs, or other shell-based file mutation when write/edit can do the job.
- Do not use run_command to read normal file contents when read can do the job.
- Use run_command when the answer depends on repo state, command output, scripts, tests, git state, or other non-file-content shell tools.
- Inspect before changing files. Do not assume file contents.
- Ask before clearly destructive or risky commands.
- Never print or repeat secrets, API keys, OAuth tokens, cookies, or credentials.
- Keep code changes simple and incremental. Prefer functions and plain objects over classes unless clearly useful.
`.trim();

function escapeProjectContextPath(filePath: string): string {
    return filePath
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;");
}

export function formatProjectContextSection(contextFiles: ProjectContextFile[]): string {
    if (contextFiles.length === 0) return "";

    const sections = contextFiles.map((contextFile) => [
        `<project_instructions path="${escapeProjectContextPath(contextFile.path)}">`,
        contextFile.content,
        "</project_instructions>",
    ].join("\n"));

    return [
        "<project_context>",
        "",
        "Project-specific instructions and guidelines:",
        "",
        ...sections.flatMap((section) => [section, ""]),
        "</project_context>",
    ].join("\n").trimEnd();
}

export function formatSelfManifestSection(selfManifest?: ProjectContextFile | null): string {
    if (!selfManifest) return "";

    return [
        "<perry_self_manifest>",
        `Source: ${escapeProjectContextPath(selfManifest.path)}`,
        "",
        selfManifest.content,
        "</perry_self_manifest>",
    ].join("\n").trimEnd();
}

export function buildSystemPrompt(options: {
    contextFiles?: ProjectContextFile[];
    selfManifest?: ProjectContextFile | null;
    skills?: SkillDefinition[];
    cwd?: string;
    date?: Date;
} = {}): string {
    const selfManifestSection = formatSelfManifestSection(options.selfManifest);
    const skillsSection = formatSkillsManifestSection(options.skills ?? []);
    const contextSection = formatProjectContextSection(options.contextFiles ?? []);
    const cwd = path.resolve(options.cwd ?? process.cwd()).replace(/\\/g, "/");
    const date = options.date ?? new Date();

    return [
        baseSystemPrompt,
        selfManifestSection,
        skillsSection,
        contextSection,
        `Current working directory: ${cwd}`,
        `Current date: ${date.toDateString()}`,
    ].filter((section) => section.length > 0).join("\n\n");
}

export const systemPrompt = buildSystemPrompt();