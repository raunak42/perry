import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import {
    DEFAULT_DEV_PERRY_HOME_DIRNAME,
    DEFAULT_INSTALLED_PERRY_HOME_DIRNAME,
    findPackageRoot,
    getDefaultPerryHomeDir,
    getPerryHomeDir,
    isRunningFromSourcePackage,
    readPackageMetadata,
} from "../src/helpers/packageInfo";

test("finds package root by walking up from a compiled helper directory", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "perry-package-root-"));
    const nested = path.join(root, "dist", "helpers");
    mkdirSync(nested, { recursive: true });
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@perry-ai/cli", version: "0.1.0" }));

    assert.equal(findPackageRoot(nested), root);
    assert.deepEqual(readPackageMetadata(nested), {
        name: "@perry-ai/cli",
        version: "0.1.0",
        root,
    });
});

test("default Perry home separates installed and source packages", () => {
    const installedRoot = mkdtempSync(path.join(os.tmpdir(), "perry-installed-root-"));
    const installedNested = path.join(installedRoot, "dist", "helpers");
    mkdirSync(installedNested, { recursive: true });
    writeFileSync(path.join(installedRoot, "package.json"), JSON.stringify({ name: "@perry-ai/cli", version: "0.1.0" }));

    const sourceRoot = mkdtempSync(path.join(os.tmpdir(), "perry-source-root-"));
    const sourceNested = path.join(sourceRoot, "src", "helpers");
    mkdirSync(sourceNested, { recursive: true });
    writeFileSync(path.join(sourceRoot, "package.json"), JSON.stringify({ name: "@perry-ai/cli", version: "0.1.0" }));
    writeFileSync(path.join(sourceRoot, "src", "index.ts"), "// source marker");

    assert.equal(isRunningFromSourcePackage(installedNested), false);
    assert.equal(isRunningFromSourcePackage(sourceNested), true);
    assert.equal(getDefaultPerryHomeDir(installedNested), path.join(os.homedir(), DEFAULT_INSTALLED_PERRY_HOME_DIRNAME));
    assert.equal(getDefaultPerryHomeDir(sourceNested), path.join(os.homedir(), DEFAULT_DEV_PERRY_HOME_DIRNAME));
    assert.equal(getPerryHomeDir({}, installedNested), path.join(os.homedir(), DEFAULT_INSTALLED_PERRY_HOME_DIRNAME));
    assert.equal(getPerryHomeDir({}, sourceNested), path.join(os.homedir(), DEFAULT_DEV_PERRY_HOME_DIRNAME));
});

test("PERRY_HOME overrides the default user data directory", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "perry-home-"));
    assert.equal(getPerryHomeDir({ PERRY_HOME: root }), path.resolve(root));
});

test("PERRY_HOME expands a home prefix", () => {
    assert.equal(getPerryHomeDir({ PERRY_HOME: "~/perry-test" }), path.join(os.homedir(), "perry-test"));
});
