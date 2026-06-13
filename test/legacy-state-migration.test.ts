import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import {
    formatLegacySessionMigrationMessage,
    migrateLegacyDevSessions,
} from "../src/helpers/legacyStateMigration";

function makeSourcePackageRoot(): string {
    const root = mkdtempSync(path.join(os.tmpdir(), "perry-legacy-source-root-"));
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@perry-ai/cli", version: "0.1.0" }));
    writeFileSync(path.join(root, "src", "index.ts"), "// source marker");
    return root;
}

test("legacy session migration copies old source sessions into dev home only", () => {
    const sourceRoot = makeSourcePackageRoot();
    const legacyHome = mkdtempSync(path.join(os.tmpdir(), "perry-legacy-home-"));
    const targetRoot = mkdtempSync(path.join(os.tmpdir(), "perry-legacy-target-root-"));
    const targetHome = path.join(targetRoot, ".perry-dev");
    const legacySessions = path.join(legacyHome, "sessions", "--repo--");
    mkdirSync(legacySessions, { recursive: true });
    writeFileSync(path.join(legacySessions, "session.jsonl"), "legacy session");

    try {
        const result = migrateLegacyDevSessions({
            startDir: path.join(sourceRoot, "src", "helpers"),
            legacyHomeDir: legacyHome,
            targetHomeDir: targetHome,
            env: {},
        });

        const copiedPath = path.join(targetHome, "sessions", "--repo--", "session.jsonl");
        assert.equal(result.copiedFiles, 1);
        assert.equal(result.skippedFiles, 0);
        assert.equal(readFileSync(copiedPath, "utf8"), "legacy session");
        assert.match(formatLegacySessionMigrationMessage(result) ?? "", /Auth and preferences were not migrated/);
    } finally {
        rmSync(sourceRoot, { recursive: true, force: true });
        rmSync(legacyHome, { recursive: true, force: true });
        rmSync(targetRoot, { recursive: true, force: true });
    }
});

test("legacy session migration skips installed packages and explicit PERRY_HOME", () => {
    const installedRoot = mkdtempSync(path.join(os.tmpdir(), "perry-legacy-installed-root-"));
    const legacyHome = mkdtempSync(path.join(os.tmpdir(), "perry-legacy-home-"));
    const targetRoot = mkdtempSync(path.join(os.tmpdir(), "perry-legacy-target-root-"));
    const targetHome = path.join(targetRoot, ".perry-dev");
    mkdirSync(path.join(installedRoot, "dist", "helpers"), { recursive: true });
    writeFileSync(path.join(installedRoot, "package.json"), JSON.stringify({ name: "@perry-ai/cli", version: "0.1.0" }));
    mkdirSync(path.join(legacyHome, "sessions", "--repo--"), { recursive: true });
    writeFileSync(path.join(legacyHome, "sessions", "--repo--", "session.jsonl"), "legacy session");

    try {
        const installedResult = migrateLegacyDevSessions({
            startDir: path.join(installedRoot, "dist", "helpers"),
            legacyHomeDir: legacyHome,
            targetHomeDir: targetHome,
            env: {},
        });
        assert.equal(installedResult.copiedFiles, 0);
        assert.equal(installedResult.reason, "not_source_package");

        const explicitHomeResult = migrateLegacyDevSessions({
            startDir: path.join(installedRoot, "dist", "helpers"),
            legacyHomeDir: legacyHome,
            targetHomeDir: targetHome,
            env: { PERRY_HOME: targetHome },
        });
        assert.equal(explicitHomeResult.copiedFiles, 0);
        assert.equal(explicitHomeResult.reason, "explicit_perry_home");
        assert.equal(existsSync(path.join(targetHome, "sessions", "--repo--", "session.jsonl")), false);
    } finally {
        rmSync(installedRoot, { recursive: true, force: true });
        rmSync(legacyHome, { recursive: true, force: true });
        rmSync(targetRoot, { recursive: true, force: true });
    }
});
