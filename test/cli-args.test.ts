import assert from "node:assert/strict";
import { test } from "bun:test";
import { normalizeCliArgv } from "../src/helpers/cliArgs";

test("normalizes pi-style -nc shorthand before commander parses options", () => {
    assert.deepEqual(normalizeCliArgv(["node", "perry", "-nc"]), ["node", "perry", "--no-context-files"]);
});

test("does not normalize arguments after option separator", () => {
    assert.deepEqual(normalizeCliArgv(["node", "perry", "--", "-nc"]), ["node", "perry", "--", "-nc"]);
});
