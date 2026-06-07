import assert from "node:assert/strict";
import { test } from "bun:test";
import {
    classifyShellCommand,
    evaluateToolPermission,
    isPathInsideWorkspace,
    isSensitivePath,
    normalizePermissionMode,
} from "../src/helpers/permissions";

const cwd = "/tmp/perry-workspace";

test("normalizes permission mode aliases", () => {
    assert.equal(normalizePermissionMode("ask"), "ask");
    assert.equal(normalizePermissionMode("readonly"), "read-only");
    assert.equal(normalizePermissionMode("workspace"), "workspace-write");
    assert.equal(normalizePermissionMode("full"), "full-access");
    assert.equal(normalizePermissionMode("yolo-mode"), "full-access");
    assert.equal(normalizePermissionMode("wat"), null);
});

test("detects sensitive paths", () => {
    assert.equal(isSensitivePath(".env"), true);
    assert.equal(isSensitivePath(".env.local"), true);
    assert.equal(isSensitivePath("/home/me/.ssh/id_ed25519"), true);
    assert.equal(isSensitivePath("/home/me/.ssh/id_ed25519.pub"), false);
    assert.equal(isSensitivePath("config/credentials.json"), true);
    assert.equal(isSensitivePath("src/index.ts"), false);
});

test("checks workspace paths", () => {
    assert.equal(isPathInsideWorkspace("src/index.ts", cwd), true);
    assert.equal(isPathInsideWorkspace("/tmp/perry-workspace/src/index.ts", cwd), true);
    assert.equal(isPathInsideWorkspace("../outside.txt", cwd), false);
    assert.equal(isPathInsideWorkspace("/tmp/elsewhere/file.txt", cwd), false);
});

test("classifies shell commands", () => {
    assert.equal(classifyShellCommand("ls src && rg permissions src").risk, "read-only");
    assert.equal(classifyShellCommand("touch foo").risk, "mutating");
    assert.equal(classifyShellCommand("echo hi > file.txt").risk, "mutating");
    assert.equal(classifyShellCommand("curl https://example.com").risk, "risky");
});

test("ask mode allows normal reads and asks for risky actions", () => {
    assert.equal(evaluateToolPermission({ mode: "ask", toolName: "read", args: { path: "src/index.ts" }, cwd }).action, "allow");
    assert.equal(evaluateToolPermission({ mode: "ask", toolName: "read", args: { path: ".env" }, cwd }).action, "ask");
    assert.equal(evaluateToolPermission({ mode: "ask", toolName: "write", args: { path: "src/index.ts" }, cwd }).action, "ask");
    assert.equal(evaluateToolPermission({ mode: "ask", toolName: "edit", args: { path: "src/index.ts" }, cwd }).action, "ask");
    assert.equal(evaluateToolPermission({ mode: "ask", toolName: "run_command", args: { command: "ls src" }, cwd }).action, "allow");
    assert.equal(evaluateToolPermission({ mode: "ask", toolName: "run_command", args: { command: "npm install" }, cwd }).action, "ask");
});

test("read-only mode blocks writes and mutating shell but asks for sensitive reads", () => {
    assert.equal(evaluateToolPermission({ mode: "read-only", toolName: "read", args: { path: "src/index.ts" }, cwd }).action, "allow");
    assert.equal(evaluateToolPermission({ mode: "read-only", toolName: "read", args: { path: ".env" }, cwd }).action, "ask");
    assert.equal(evaluateToolPermission({ mode: "read-only", toolName: "write", args: { path: "src/index.ts" }, cwd }).action, "deny");
    assert.equal(evaluateToolPermission({ mode: "read-only", toolName: "edit", args: { path: "src/index.ts" }, cwd }).action, "deny");
    assert.equal(evaluateToolPermission({ mode: "read-only", toolName: "run_command", args: { command: "ls src" }, cwd }).action, "allow");
    assert.equal(evaluateToolPermission({ mode: "read-only", toolName: "run_command", args: { command: "touch foo" }, cwd }).action, "deny");
});

test("workspace-write mode allows workspace edits and asks for outside or sensitive targets", () => {
    assert.equal(evaluateToolPermission({ mode: "workspace-write", toolName: "write", args: { path: "src/index.ts" }, cwd }).action, "allow");
    assert.equal(evaluateToolPermission({ mode: "workspace-write", toolName: "edit", args: { path: "/tmp/perry-workspace/src/index.ts" }, cwd }).action, "allow");
    assert.equal(evaluateToolPermission({ mode: "workspace-write", toolName: "write", args: { path: "../outside.txt" }, cwd }).action, "ask");
    assert.equal(evaluateToolPermission({ mode: "workspace-write", toolName: "write", args: { path: ".env" }, cwd }).action, "ask");
    assert.equal(evaluateToolPermission({ mode: "workspace-write", toolName: "run_command", args: { command: "touch foo" }, cwd }).action, "ask");
});

test("full-access / yolo mode allows tool calls while hard run_command safety rules still execute inside the tool", () => {
    assert.equal(evaluateToolPermission({ mode: "full-access", toolName: "write", args: { path: "/tmp/outside.txt" }, cwd }).action, "allow");
    assert.equal(evaluateToolPermission({ mode: "full-access", toolName: "edit", args: { path: "/tmp/outside.txt" }, cwd }).action, "allow");
    assert.equal(evaluateToolPermission({ mode: "full-access", toolName: "run_command", args: { command: "ls src" }, cwd }).action, "allow");
    assert.equal(evaluateToolPermission({ mode: "full-access", toolName: "run_command", args: { command: "echo hi > file.txt" }, cwd }).action, "allow");
    assert.equal(evaluateToolPermission({ mode: "full-access", toolName: "read", args: { path: ".env" }, cwd }).action, "allow");
    assert.equal(evaluateToolPermission({ mode: "full-access", toolName: "mcp__server__tool", args: {}, cwd }).action, "allow");
    assert.equal(evaluateToolPermission({ mode: "full-access", toolName: "spawn_subagent", args: { task: "test" }, cwd }).action, "allow");
});

test("subagents inherit permission modes", () => {
    assert.equal(evaluateToolPermission({ mode: "ask", toolName: "spawn_subagent", args: { task: "test" }, cwd }).action, "ask");
    assert.equal(evaluateToolPermission({ mode: "workspace-write", toolName: "spawn_subagent", args: { task: "test" }, cwd }).action, "ask");
    assert.equal(evaluateToolPermission({ mode: "read-only", toolName: "spawn_subagent", args: { task: "test" }, cwd }).action, "allow");
    assert.equal(evaluateToolPermission({ mode: "full-access", toolName: "spawn_subagent", args: { task: "test" }, cwd }).action, "allow");
});

test("plan mode remains stricter than full-access", () => {
    assert.equal(evaluateToolPermission({ mode: "full-access", toolName: "write", args: { path: "src/index.ts" }, cwd, planMode: true }).action, "deny");
    assert.equal(evaluateToolPermission({ mode: "full-access", toolName: "run_command", args: { command: "touch foo" }, cwd, planMode: true }).action, "deny");
    assert.equal(evaluateToolPermission({ mode: "full-access", toolName: "run_command", args: { command: "ls src" }, cwd, planMode: true }).action, "allow");
    assert.equal(evaluateToolPermission({ mode: "full-access", toolName: "spawn_subagent", args: { task: "plan" }, cwd, planMode: true }).action, "allow");
});

test("plan interaction tools are always allowed", () => {
    assert.equal(evaluateToolPermission({ mode: "read-only", toolName: "plan_choice", args: {}, cwd, planMode: true }).action, "allow");
    assert.equal(evaluateToolPermission({ mode: "read-only", toolName: "plan_complete", args: {}, cwd, planMode: true }).action, "allow");
});
