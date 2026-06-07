import assert from "node:assert/strict";
import { test } from "bun:test";
import {
    buildContextHistoryFromEntries,
    COMPACTION_SUMMARY_PREFIX,
    COMPACTION_SUMMARY_SUFFIX,
    prepareCompaction,
} from "../src/helpers/compaction";
import { SessionManager } from "../src/helpers/sessionManager";

test("session context history injects the latest compaction summary and keeps only retained messages", () => {
    const session = SessionManager.inMemory(process.cwd());

    session.appendMessage({ role: "user", content: "First request." });
    session.appendMessage({ role: "assistant", content: "First reply." });
    const keptId = session.appendMessage({ role: "user", content: "Second request." });
    session.appendMessage({ role: "assistant", content: "Second reply." });
    session.appendCompaction({
        summary: "## Goal\nKeep going\n\n## Progress\n### Done\n- [x] First request handled",
        firstKeptEntryId: keptId,
        tokensBefore: 1234,
    });
    session.appendMessage({ role: "user", content: "Third request." });
    session.appendMessage({ role: "assistant", content: "Third reply." });

    const visibleHistory = session.buildHistory();
    assert.equal(visibleHistory.length, 6);
    assert.equal(visibleHistory[0]?.content, "First request.");
    assert.equal(visibleHistory[5]?.content, "Third reply.");

    const contextHistory = session.buildContextHistory();
    assert.equal(contextHistory.length, 5);
    assert.equal(
        contextHistory[0]?.content,
        `${COMPACTION_SUMMARY_PREFIX}## Goal\nKeep going\n\n## Progress\n### Done\n- [x] First request handled${COMPACTION_SUMMARY_SUFFIX}`,
    );
    assert.equal(contextHistory[1]?.content, "Second request.");
    assert.equal(contextHistory[2]?.content, "Second reply.");
    assert.equal(contextHistory[3]?.content, "Third request.");
    assert.equal(contextHistory[4]?.content, "Third reply.");
});

test("prepareCompaction carries forward the previous summary and finds a kept boundary", () => {
    const session = SessionManager.inMemory(process.cwd());

    session.appendMessage({ role: "user", content: "A".repeat(200) });
    session.appendMessage({ role: "assistant", content: "B".repeat(200) });
    const keptId = session.appendMessage({ role: "user", content: "C".repeat(200) });
    session.appendMessage({ role: "assistant", content: "D".repeat(200) });
    session.appendCompaction({
        summary: "old summary",
        firstKeptEntryId: keptId,
        tokensBefore: 400,
    });
    session.appendMessage({ role: "user", content: "E".repeat(200) });
    session.appendMessage({ role: "assistant", content: "F".repeat(200) });

    const preparation = prepareCompaction(session.getEntries(), {
        reserveTokens: 1024,
        keepRecentTokens: 120,
    });

    assert.ok(preparation, "compaction should be possible");
    assert.equal(preparation?.previousSummary, "old summary");
    assert.ok(preparation?.firstKeptEntryId);
    assert.ok((preparation?.messagesToSummarize.length ?? 0) > 0 || (preparation?.turnPrefixMessages.length ?? 0) > 0);
});

test("buildContextHistoryFromEntries matches session manager context reconstruction", () => {
    const session = SessionManager.inMemory(process.cwd());
    const first = session.appendMessage({ role: "user", content: "First" });
    session.appendMessage({ role: "assistant", content: "Reply" });
    session.appendCompaction({
        summary: "summary",
        firstKeptEntryId: first,
        tokensBefore: 100,
    });

    const fromSession = session.buildContextHistory();
    const fromEntries = buildContextHistoryFromEntries(session.getEntries());
    assert.deepEqual(fromEntries, fromSession);
});
