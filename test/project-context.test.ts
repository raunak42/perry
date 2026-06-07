import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { buildSystemPrompt, formatProjectContextSection, formatSelfManifestSection } from "../src/constants";
import { getDefaultAgentDir, loadProjectContextFiles, loadSelfManifest } from "../src/helpers/projectContext";

test("project context files load global then parent-to-child instructions", () => {
    const root = mkdtempSync(path.join(tmpdir(), "perry-context-"));
    const agentDir = path.join(root, "home", ".perry", "agent");
    const repo = path.join(root, "repo");
    const packageDir = path.join(repo, "packages", "app");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(path.join(agentDir, "AGENTS.md"), "global instructions");
    writeFileSync(path.join(repo, "AGENTS.md"), "repo instructions");
    writeFileSync(path.join(packageDir, "CLAUDE.md"), "package instructions");

    const files = loadProjectContextFiles({ cwd: packageDir, agentDir });

    assert.deepEqual(files.map((file) => path.relative(root, file.path)), [
        path.join("home", ".perry", "agent", "AGENTS.md"),
        path.join("repo", "AGENTS.md"),
        path.join("repo", "packages", "app", "CLAUDE.md"),
    ]);
    assert.deepEqual(files.map((file) => file.content), [
        "global instructions",
        "repo instructions",
        "package instructions",
    ]);
});

test("AGENTS.md wins over CLAUDE.md in the same directory", () => {
    const root = mkdtempSync(path.join(tmpdir(), "perry-context-"));
    writeFileSync(path.join(root, "CLAUDE.md"), "claude instructions");
    writeFileSync(path.join(root, "AGENTS.md"), "agents instructions");

    const files = loadProjectContextFiles({ cwd: root, agentDir: path.join(root, "missing-agent") });

    assert.equal(files.length, 1);
    assert.equal(path.basename(files[0]!.path), "AGENTS.md");
    assert.equal(files[0]!.content, "agents instructions");
});

test("default agent dir matches Perry auth layout", () => {
    assert.equal(path.basename(getDefaultAgentDir()), "agent");
    assert.equal(path.basename(path.dirname(getDefaultAgentDir())), ".perry");
});

test("system prompt appends self manifest, skills, and project context before runtime metadata", () => {
    const contextPath = "/repo/AGENTS.md";
    const manifestPath = "/repo/SELF_MANIFEST.md";
    const prompt = buildSystemPrompt({
        cwd: "/repo",
        date: new Date("2026-06-05T00:00:00Z"),
        selfManifest: { path: manifestPath, content: "Perry can answer self questions." },
        skills: [{
            name: "review",
            displayName: "Review",
            description: "Review code",
            path: "/repo/.perry/skills/review/SKILL.md",
            content: "# Review\nFull skill body should not be in the manifest.",
            source: "project",
        }],
        contextFiles: [{ path: contextPath, content: "Use bun test." }],
    });

    assert.match(prompt, /<perry_self_manifest>/);
    assert.match(prompt, /Perry can answer self questions\./);
    assert.match(prompt, /<available_skills>/);
    assert.match(prompt, /<skill name="review"/);
    assert.doesNotMatch(prompt, /Full skill body should not be in the manifest/);
    assert.match(prompt, /<project_context>/);
    assert.match(prompt, new RegExp(`<project_instructions path="${contextPath}">\\nUse bun test\\.\\n</project_instructions>`));
    assert.ok(prompt.indexOf("</perry_self_manifest>") < prompt.indexOf("<available_skills>"));
    assert.ok(prompt.indexOf("</available_skills>") < prompt.indexOf("<project_context>"));
    assert.ok(prompt.indexOf("</project_context>") < prompt.indexOf("Current working directory: /repo"));
    assert.match(prompt, /Current date: Fri Jun 05 2026/);
});

test("project context paths are escaped in prompt tags", () => {
    const section = formatProjectContextSection([
        { path: "/repo/A&B\"<.md", content: "content" },
    ]);

    assert.match(section, /path="\/repo\/A&amp;B&quot;&lt;\.md"/);
});

test("self manifest loads from the Perry repo root", () => {
    const root = mkdtempSync(path.join(tmpdir(), "perry-self-manifest-"));
    writeFileSync(path.join(root, "SELF_MANIFEST.md"), "Perry self context");

    const manifest = loadSelfManifest({ cwd: root });

    assert.equal(manifest?.path, path.join(root, "SELF_MANIFEST.md"));
    assert.equal(manifest?.content, "Perry self context");
});

test("self manifest section is separate from project instructions", () => {
    const section = formatSelfManifestSection({ path: "/repo/SELF&MANIFEST.md", content: "Perry capabilities" });

    assert.match(section, /<perry_self_manifest>/);
    assert.match(section, /Source: \/repo\/SELF&amp;MANIFEST\.md/);
    assert.match(section, /Perry capabilities/);
    assert.match(section, /<\/perry_self_manifest>/);
});
