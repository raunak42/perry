import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { SessionManager, resolveSessionPath } from "../src/helpers/sessionManager";

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
