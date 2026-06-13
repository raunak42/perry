import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { createMcpFunctionName, loadMcpConfig, McpManager, sanitizeMcpToolNamePart } from "../src/helpers/mcp";

test("loads MCP config from global and workspace files with workspace override", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "perry-mcp-test-"));
    const perryHome = path.join(root, "home", ".perry");
    const cwd = path.join(root, "repo");
    fs.mkdirSync(perryHome, { recursive: true });
    fs.mkdirSync(path.join(cwd, ".perry"), { recursive: true });

    fs.writeFileSync(path.join(perryHome, "mcp.json"), JSON.stringify({
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

    const loaded = loadMcpConfig(cwd, perryHome);

    assert.equal(loaded.files.length, 2);
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.servers.docs.command, "bun");
    assert.deepEqual(loaded.servers.docs.args, ["workspace.ts"]);
    assert.deepEqual(loaded.servers.docs.env, { TOKEN: "x" });
    assert.equal(loaded.servers.disabled.disabled, true);
});

test("reports invalid MCP config files without throwing", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "perry-mcp-invalid-"));
    const perryHome = path.join(root, "home", ".perry");
    const cwd = path.join(root, "repo");
    fs.mkdirSync(perryHome, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(path.join(perryHome, "mcp.json"), "{ nope");

    const loaded = loadMcpConfig(cwd, perryHome);

    assert.equal(loaded.files.length, 0);
    assert.equal(loaded.errors.length, 1);
    assert.match(loaded.errors[0]?.message ?? "", /JSON|Expected|property|parse/i);
});

test("sanitizes MCP function names and keeps them unique", () => {
    assert.equal(sanitizeMcpToolNamePart("github server!"), "github_server");
    const used = new Set<string>();
    const first = createMcpFunctionName("github server", "search/issues", used);
    const second = createMcpFunctionName("github server", "search/issues", used);

    assert.equal(first, "mcp__github_server__search_issues");
    assert.equal(second, "mcp__github_server__search_issues_2");
});

test("MCP manager keeps healthy servers when another server fails", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "perry-mcp-partial-"));
    const perryHome = path.join(root, "home", ".perry");
    const cwd = path.join(root, "repo");
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(path.join(cwd, ".mcp.json"), JSON.stringify({
        mcpServers: {
            ok: {
                command: process.execPath,
                args: ["-e", `
let buffer = "";
function send(id, result) { console.log(JSON.stringify({ jsonrpc: "2.0", id, result })); }
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  while (buffer.includes("\\n")) {
    const index = buffer.indexOf("\\n");
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") send(message.id, { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "ok" } });
    else if (message.method === "tools/list") send(message.id, { tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: {} } }] });
  }
});
`],
            },
            bad: { command: process.execPath, args: ["-e", "process.exit(1)"] },
            disabled: { command: process.execPath, disabled: true },
        },
    }));

    const manager = new McpManager(cwd, perryHome);
    try {
        await manager.load();
        assert.equal(manager.tools.length, 1);
        assert.equal(manager.tools[0]?.functionName, "mcp__ok__echo");
        const statuses = Object.fromEntries(manager.statuses.map((status) => [status.name, status]));
        assert.equal(statuses.ok?.state, "running");
        assert.equal(statuses.bad?.state, "error");
        assert.equal(statuses.disabled?.state, "disabled");
        assert.match(manager.describe(), /bad: error/);
        assert.match(manager.describe({ verbose: true }), /mcp__ok__echo/);
        assert.match(manager.describe({ doctor: true }), /Config locations checked:/);
    } finally {
        await manager.close();
    }
});
