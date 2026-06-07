import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { createMcpFunctionName, loadMcpConfig, sanitizeMcpToolNamePart } from "../src/helpers/mcp";

test("loads MCP config from global and workspace files with workspace override", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "perry-mcp-test-"));
    const home = path.join(root, "home");
    const cwd = path.join(root, "repo");
    fs.mkdirSync(path.join(home, ".perry"), { recursive: true });
    fs.mkdirSync(path.join(cwd, ".perry"), { recursive: true });

    fs.writeFileSync(path.join(home, ".perry", "mcp.json"), JSON.stringify({
        mcpServers: {
            docs: { command: "node", args: ["global.js"] },
            disabled: { command: "node", disabled: true },
        },
    }));
    fs.writeFileSync(path.join(cwd, ".perry", "mcp.json"), JSON.stringify({
        mcpServers: {
            docs: { command: "bun", args: ["workspace.ts"], env: { TOKEN: "x", BAD: 3 } },
        },
    }));

    const loaded = loadMcpConfig(cwd, home);

    assert.equal(loaded.files.length, 2);
    assert.equal(loaded.servers.docs.command, "bun");
    assert.deepEqual(loaded.servers.docs.args, ["workspace.ts"]);
    assert.deepEqual(loaded.servers.docs.env, { TOKEN: "x" });
    assert.equal(loaded.servers.disabled.disabled, true);
});

test("sanitizes MCP function names and keeps them unique", () => {
    assert.equal(sanitizeMcpToolNamePart("github server!"), "github_server");
    const used = new Set<string>();
    const first = createMcpFunctionName("github server", "search/issues", used);
    const second = createMcpFunctionName("github server", "search/issues", used);

    assert.equal(first, "mcp__github_server__search_issues");
    assert.equal(second, "mcp__github_server__search_issues_2");
});
