import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

const installer = require("../scripts/install-dev-command.cjs") as {
    createDevCommandScript(options: { sourceRoot: string; bunCommand?: string }): string;
    installDevCommand(options?: { sourceRoot?: string; env?: NodeJS.ProcessEnv }): { binDir: string; commandPath: string };
    isDirOnPath(binDir: string, env?: NodeJS.ProcessEnv): boolean;
    resolveInstallPath(env?: NodeJS.ProcessEnv): { binDir: string; commandPath: string };
};

test("dev command script launches the source checkout entry without changing target cwd", () => {
    const sourceRoot = path.join(os.tmpdir(), "perry source with spaces");
    const script = installer.createDevCommandScript({ sourceRoot });

    assert.ok(script.startsWith("#!/usr/bin/env bash"));
    assert.match(script, /SOURCE_ROOT='/);
    assert.ok(script.includes("ENTRY=\"$SOURCE_ROOT/src/index.ts\""));
    assert.ok(script.includes("exec 'bun' run \"$ENTRY\" \"$@\""));
    assert.equal(script.includes("cd \"$SOURCE_ROOT\""), false, "perry-dev should preserve the caller's repo as cwd");
});

test("dev command installer writes perry-dev into the configured bin dir", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "perry-dev-source-"));
    const binDir = mkdtempSync(path.join(os.tmpdir(), "perry-dev-bin-"));
    const result = installer.installDevCommand({
        sourceRoot: root,
        env: { ...process.env, PERRY_DEV_BIN_DIR: binDir, PATH: binDir },
    });

    assert.equal(result.binDir, binDir);
    assert.equal(result.commandPath, path.join(binDir, "perry-dev"));
    assert.equal(existsSync(result.commandPath), true);
    assert.ok(readFileSync(result.commandPath, "utf8").includes(path.resolve(root)));
    assert.ok((statSync(result.commandPath).mode & 0o111) !== 0, "perry-dev should be executable");
});

test("dev command installer checks whether the bin dir is on PATH", () => {
    const binDir = path.join(os.tmpdir(), "perry-dev-bin-path");
    assert.equal(installer.isDirOnPath(binDir, { PATH: `${path.dirname(binDir)}${path.delimiter}${binDir}` } as NodeJS.ProcessEnv), true);
    assert.equal(installer.isDirOnPath(binDir, { PATH: path.dirname(binDir) } as NodeJS.ProcessEnv), false);
});
