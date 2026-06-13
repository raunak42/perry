import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { SessionManager, getDefaultSessionDir, resolveSessionPath } from "../src/helpers/sessionManager";

test("sessions flush only after an assistant response and can be resumed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perry-session-test-"));

    try {
        const cwd = process.cwd();
        const session = SessionManager.create(cwd, dir);

        session.appendState({
            provider: "openai-api-key",
            model: "gpt-5.1-codex-mini",
            reasoningLevel: "medium",
            contextLevel: "auto",
        });
        session.appendMessage({ role: "user", content: "Remember Alice." });

        assert.equal(existsSync(session.getSessionFile()!), false, "session should not flush before the first assistant response");

        session.appendMessage({ role: "assistant", content: "I will remember Alice." });

        assert.equal(existsSync(session.getSessionFile()!), true, "session should flush after the first assistant response");

        const listed = await SessionManager.list(cwd, dir);
        assert.equal(listed.length, 1);
        assert.equal(listed[0]?.messageCount, 2);
        assert.match(listed[0]?.firstMessage ?? "", /Alice/);

        const continued = SessionManager.continueRecent(cwd, dir);
        const history = continued.buildHistory();
        assert.equal(history.length, 2);
        assert.equal(history[0]?.content, "Remember Alice.");

        const resolved = await resolveSessionPath(session.getSessionId().slice(0, 8), cwd, dir);
        assert.notEqual(resolved.type, "not_found");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("session lookup stays inside the selected Perry home", async () => {
    const installedHome = mkdtempSync(join(tmpdir(), "perry-installed-sessions-"));
    const devHome = mkdtempSync(join(tmpdir(), "perry-dev-sessions-"));

    try {
        const cwd = process.cwd();
        const installedSession = SessionManager.create(cwd, getDefaultSessionDir(cwd, installedHome));
        installedSession.appendMessage({ role: "user", content: "Installed session." });
        installedSession.appendMessage({ role: "assistant", content: "Installed reply." });

        const devSession = SessionManager.create(cwd, getDefaultSessionDir(cwd, devHome));
        devSession.appendMessage({ role: "user", content: "Dev session." });
        devSession.appendMessage({ role: "assistant", content: "Dev reply." });

        const installedSessions = await SessionManager.list(cwd, getDefaultSessionDir(cwd, installedHome));
        const devSessions = await SessionManager.list(cwd, getDefaultSessionDir(cwd, devHome));
        const allInstalledSessions = await SessionManager.listAll(undefined, installedHome);
        const allDevSessions = await SessionManager.listAll(undefined, devHome);

        assert.deepEqual(installedSessions.map((session) => session.firstMessage), ["Installed session."]);
        assert.deepEqual(devSessions.map((session) => session.firstMessage), ["Dev session."]);
        assert.deepEqual(allInstalledSessions.map((session) => session.firstMessage), ["Installed session."]);
        assert.deepEqual(allDevSessions.map((session) => session.firstMessage), ["Dev session."]);
    } finally {
        rmSync(installedHome, { recursive: true, force: true });
        rmSync(devHome, { recursive: true, force: true });
    }
});

test("sessions persist completed tool traces and replace updates by trace id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perry-session-trace-test-"));

    try {
        const cwd = process.cwd();
        const session = SessionManager.create(cwd, dir);
        session.appendMessage({ role: "user", content: "Read a file." });

        session.appendToolTrace({
            id: "trace-read-1",
            displayId: 1,
            toolName: "read",
            args: { path: "src/index.ts" },
            output: "old output",
            status: "complete",
            details: {
                type: "read",
                path: "src/index.ts",
                language: "typescript",
                content: "old output",
            },
        });

        assert.equal(existsSync(session.getSessionFile()!), false, "session should still wait to flush until the assistant response");

        session.appendMessage({ role: "assistant", content: "I'll inspect it." });
        session.appendToolTrace({
            id: "trace-read-1",
            displayId: 1,
            toolName: "read",
            args: { path: "src/index.ts" },
            output: "new output",
            status: "complete",
            details: {
                type: "read",
                path: "src/index.ts",
                language: "typescript",
                content: "new output",
            },
        });

        const content = readFileSync(session.getSessionFile()!, "utf8");
        assert.equal((content.match(/"type":"tool_trace"/g) ?? []).length, 1);
        assert.ok(content.includes("new output"));

        const resumed = SessionManager.open(session.getSessionFile()!, dir, cwd);
        const traceEntries = resumed.getEntries().filter((entry) => entry.type === "tool_trace");
        assert.equal(traceEntries.length, 1);
        assert.equal(traceEntries[0]?.type, "tool_trace");
        if (traceEntries[0]?.type === "tool_trace") {
            assert.equal(traceEntries[0].trace.output, "new output");
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
