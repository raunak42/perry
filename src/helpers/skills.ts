import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { getPerryHomePath } from "./packageInfo";

export type SkillSource = "global" | "project";

export interface SkillDefinition {
    name: string;
    displayName: string;
    description?: string;
    path: string;
    content: string;
    source: SkillSource;
}

export const SKILL_FILE_CANDIDATES = ["SKILL.md", "SKILL.MD"] as const;

interface SkillMetadata {
    name?: string;
    description?: string;
}

export function getDefaultSkillsDir(baseDir = getPerryHomePath()): string {
    return path.join(baseDir, "skills");
}

export function normalizeSkillName(value: string): string {
    const normalized = value
        .trim()
        .toLowerCase()
        .replace(/['"`]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return normalized || "skill";
}

function readSkillFilePath(skillDir: string): string | null {
    for (const filename of SKILL_FILE_CANDIDATES) {
        const filePath = path.join(skillDir, filename);
        if (existsSync(filePath)) return filePath;
    }
    return null;
}

function safeIsDirectory(filePath: string): boolean {
    try {
        return statSync(filePath).isDirectory();
    } catch {
        return false;
    }
}

function parseFrontmatter(content: string): { metadata: SkillMetadata; body: string } {
    if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
        return { metadata: {}, body: content };
    }

    const normalized = content.replace(/\r\n/g, "\n");
    const endIndex = normalized.indexOf("\n---\n", 4);
    if (endIndex === -1) return { metadata: {}, body: content };

    const rawFrontmatter = normalized.slice(4, endIndex);
    const metadata: SkillMetadata = {};
    for (const line of rawFrontmatter.split("\n")) {
        const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/);
        if (!match) continue;
        const key = match[1]!.toLowerCase();
        const value = match[2]!.replace(/^['"]|['"]$/g, "").trim();
        if (!value) continue;
        if (key === "name") metadata.name = value;
        if (key === "description") metadata.description = value;
    }

    return { metadata, body: normalized.slice(endIndex + "\n---\n".length) };
}

function firstHeading(body: string): string | undefined {
    for (const line of body.split(/\r?\n/)) {
        const match = line.match(/^#\s+(.+?)\s*$/);
        if (match?.[1]?.trim()) return match[1].trim();
    }
    return undefined;
}

function firstDescriptionLine(body: string): string | undefined {
    for (const line of body.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("---")) continue;
        return trimmed.length > 180 ? `${trimmed.slice(0, 179).trimEnd()}…` : trimmed;
    }
    return undefined;
}

export function parseSkillFile(params: {
    directoryName: string;
    filePath: string;
    content: string;
    source: SkillSource;
}): SkillDefinition {
    const { metadata, body } = parseFrontmatter(params.content);
    const heading = firstHeading(body);
    const displayName = metadata.name ?? heading ?? params.directoryName;
    const description = metadata.description ?? firstDescriptionLine(body);

    return {
        name: normalizeSkillName(metadata.name ?? params.directoryName),
        displayName,
        description,
        path: path.resolve(params.filePath),
        content: params.content,
        source: params.source,
    };
}

function loadSkillsFromDirectory(skillsDir: string, source: SkillSource): SkillDefinition[] {
    if (!existsSync(skillsDir) || !safeIsDirectory(skillsDir)) return [];

    const skills: SkillDefinition[] = [];
    let entries: string[];
    try {
        entries = readdirSync(skillsDir).sort((left, right) => left.localeCompare(right));
    } catch {
        return [];
    }

    for (const entry of entries) {
        const skillDir = path.join(skillsDir, entry);
        if (!safeIsDirectory(skillDir)) continue;
        const skillFilePath = readSkillFilePath(skillDir);
        if (!skillFilePath) continue;
        try {
            skills.push(parseSkillFile({
                directoryName: entry,
                filePath: skillFilePath,
                content: readFileSync(skillFilePath, "utf8"),
                source,
            }));
        } catch {
            continue;
        }
    }

    return skills;
}

function ancestorDirsRootToLeaf(cwd: string): string[] {
    const resolvedCwd = path.resolve(cwd);
    const root = path.parse(resolvedCwd).root;
    const dirs: string[] = [];
    let current = resolvedCwd;

    while (true) {
        dirs.unshift(current);
        if (current === root) break;
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }

    return dirs;
}

export function loadSkillDefinitions(options: {
    cwd?: string;
    skillsDir?: string;
} = {}): SkillDefinition[] {
    const cwd = path.resolve(options.cwd ?? process.cwd());
    const discovered: SkillDefinition[] = [];

    discovered.push(...loadSkillsFromDirectory(path.resolve(options.skillsDir ?? getDefaultSkillsDir()), "global"));

    for (const dir of ancestorDirsRootToLeaf(cwd)) {
        discovered.push(...loadSkillsFromDirectory(path.join(dir, ".perry", "skills"), "project"));
    }

    const order: string[] = [];
    const byName = new Map<string, SkillDefinition>();
    for (const skill of discovered) {
        if (!byName.has(skill.name)) order.push(skill.name);
        byName.set(skill.name, skill);
    }

    return order.map((name) => byName.get(name)!).filter(Boolean);
}

export function findSkill(skills: SkillDefinition[], query: string): SkillDefinition | null {
    const normalized = normalizeSkillName(query);
    const exact = skills.find((skill) => skill.name === normalized || normalizeSkillName(skill.displayName) === normalized);
    if (exact) return exact;

    const prefixMatches = skills.filter((skill) => skill.name.startsWith(normalized));
    return prefixMatches.length === 1 ? prefixMatches[0]! : null;
}

function escapeAttribute(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;");
}

function formatSkillLabel(skill: SkillDefinition): string {
    return skill.displayName === skill.name ? skill.name : `${skill.displayName} (${skill.name})`;
}

export function formatSkillsList(skills: SkillDefinition[]): string {
    if (skills.length === 0) {
        return [
            "No skills found.",
            "Add reusable workflows as SKILL.md files under $PERRY_HOME/skills/<name>/, the default Perry home skills directory, or .perry/skills/<name>/.",
        ].join("\n");
    }

    return [
        "Available skills:",
        ...skills.map((skill) => {
            const description = skill.description ? ` — ${skill.description}` : "";
            return `- ${skill.name}${description} (${skill.source})`;
        }),
        "",
        "Use /skill <name> to apply a skill to your next message, or /skills reload after editing SKILL.md files.",
    ].join("\n");
}

export function formatSkillsManifestSection(skills: SkillDefinition[]): string {
    if (skills.length === 0) return "";

    const sections = skills.map((skill) => [
        `<skill name="${escapeAttribute(skill.name)}" source="${skill.source}" path="${escapeAttribute(skill.path)}">`,
        `Display name: ${skill.displayName}`,
        skill.description ? `Description: ${skill.description}` : "Description: (none provided)",
        "</skill>",
    ].join("\n"));

    return [
        "<available_skills>",
        "Reusable workflow skills are available. Their full SKILL.md instructions are loaded only when the user invokes a skill with /skill.",
        "",
        ...sections.flatMap((section) => [section, ""]),
        "</available_skills>",
    ].join("\n").trimEnd();
}

export function formatActiveSkillSection(skill: SkillDefinition): string {
    return [
        `<active_skill name="${escapeAttribute(skill.name)}" source="${skill.source}" path="${escapeAttribute(skill.path)}">`,
        skill.content.trim(),
        "</active_skill>",
        "Follow the active skill instructions for this turn. If the skill conflicts with higher-priority system/developer instructions, follow the higher-priority instructions.",
    ].join("\n").trimEnd();
}

export function buildInstructionsWithActiveSkill(baseInstructions: string, skill: SkillDefinition | null | undefined): string {
    return skill
        ? `${baseInstructions}\n\n${formatActiveSkillSection(skill)}`
        : baseInstructions;
}

export function describeSkillForUi(skill: SkillDefinition): string {
    const description = skill.description ? ` — ${skill.description}` : "";
    return `${formatSkillLabel(skill)}${description}`;
}
