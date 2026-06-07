import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import {
    buildInstructionsWithActiveSkill,
    findSkill,
    formatActiveSkillSection,
    formatSkillsList,
    formatSkillsManifestSection,
    loadSkillDefinitions,
    normalizeSkillName,
    parseSkillFile,
} from "../src/helpers/skills";

function writeSkill(root: string, relativeDir: string, content: string): string {
    const dir = path.join(root, relativeDir);
    mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, "SKILL.md");
    writeFileSync(filePath, content);
    return filePath;
}

test("normalizes skill names", () => {
    assert.equal(normalizeSkillName("Code Review"), "code-review");
    assert.equal(normalizeSkillName(" release_notes!! "), "release-notes");
    assert.equal(normalizeSkillName(""), "skill");
});

test("parses SKILL.md metadata and fallbacks", () => {
    const skill = parseSkillFile({
        directoryName: "review",
        filePath: "/repo/.perry/skills/review/SKILL.md",
        source: "project",
        content: [
            "---",
            "name: Code Review",
            "description: Review changes for correctness.",
            "---",
            "# Ignored Heading",
            "Use rg and tests.",
        ].join("\n"),
    });

    assert.equal(skill.name, "code-review");
    assert.equal(skill.displayName, "Code Review");
    assert.equal(skill.description, "Review changes for correctness.");
    assert.equal(skill.source, "project");
});

test("loads global and project skills with project overriding duplicate names", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "perry-skills-"));
    const globalDir = path.join(root, "home", ".perry", "skills");
    const repo = path.join(root, "repo");
    const app = path.join(repo, "packages", "app");
    mkdirSync(app, { recursive: true });

    writeSkill(globalDir, "review", "---\nname: review\ndescription: global review\n---\nGlobal review skill");
    writeSkill(path.join(repo, ".perry", "skills"), "review", "---\nname: review\ndescription: project review\n---\nProject review skill");
    writeSkill(path.join(app, ".perry", "skills"), "release-notes", "# Release Notes\nWrite release notes.");

    const skills = loadSkillDefinitions({ cwd: app, skillsDir: globalDir });

    assert.deepEqual(skills.map((skill) => skill.name), ["review", "release-notes"]);
    assert.equal(skills[0]!.description, "project review");
    assert.equal(skills[0]!.source, "project");
    assert.equal(skills[1]!.displayName, "Release Notes");
});

test("findSkill supports exact and unique prefix matches", () => {
    const skills = [
        parseSkillFile({ directoryName: "code-review", filePath: "/skills/code-review/SKILL.md", content: "# Code Review", source: "global" }),
        parseSkillFile({ directoryName: "release-notes", filePath: "/skills/release-notes/SKILL.md", content: "# Release Notes", source: "global" }),
    ];

    assert.equal(findSkill(skills, "code")?.name, "code-review");
    assert.equal(findSkill(skills, "Release Notes")?.name, "release-notes");
    assert.equal(findSkill(skills, "missing"), null);
});

test("formats skill manifest and active skill sections", () => {
    const skill = parseSkillFile({
        directoryName: "debug",
        filePath: "/repo/.perry/skills/debug/SKILL.md",
        source: "project",
        content: "# Debug\nInspect failing tests first.",
    });

    const manifest = formatSkillsManifestSection([skill]);
    assert.match(manifest, /<available_skills>/);
    assert.match(manifest, /<skill name="debug" source="project" path="\/repo\/.perry\/skills\/debug\/SKILL\.md">/);
    assert.match(manifest, /Reusable workflow skills are available/);
    assert.match(manifest, /Description: Inspect failing tests first\./);
    assert.doesNotMatch(manifest, /# Debug/);

    const active = formatActiveSkillSection(skill);
    assert.match(active, /<active_skill name="debug"/);
    assert.match(active, /Inspect failing tests first/);

    const instructions = buildInstructionsWithActiveSkill("base", skill);
    assert.match(instructions, /^base\n\n<active_skill/);
});

test("formats empty and populated skill lists", () => {
    assert.match(formatSkillsList([]), /No skills found/);

    const skill = parseSkillFile({ directoryName: "review", filePath: "/skills/review/SKILL.md", content: "---\ndescription: Review code\n---\nDo review.", source: "global" });
    assert.match(formatSkillsList([skill]), /Available skills:/);
    assert.match(formatSkillsList([skill]), /- review — Review code \(global\)/);
});
