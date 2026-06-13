import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { chooseSessionPath } from "../src/helpers/sessionRuntime";
import { getDefaultSessionDir, SessionManager } from "../src/helpers/sessionManager";
import type { ChoiceOption, InteractiveUi, SessionDetailLine, StartupCard } from "../src/ui/types";

class FakeUi implements InteractiveUi {
    writes: string[] = [];
    choiceResults: unknown[] = [];
    choicePrompts: string[] = [];
    choiceOptions: ChoiceOption<unknown>[][] = [];

    ask(): Promise<string> {
        throw new Error("ask not implemented in FakeUi");
    }

    choose<T = string>(prompt: string, options: ChoiceOption<T>[]): Promise<T> {
        this.choicePrompts.push(prompt);
        this.choiceOptions.push(options as ChoiceOption<unknown>[]);
        return Promise.resolve(this.choiceResults.shift() as T);
    }

    write(message: string): void { this.writes.push(message); }
    writeWarning(message: string): void { this.writes.push(message); }
    writeError(message: string): void { this.writes.push(message); }
    writeUser(message: string): void { this.writes.push(message); }
    writeAssistant(message: string): void { this.writes.push(message); }
    writeThinking(message: string): void { this.writes.push(message); }
    writeStartupCard(card: StartupCard): void { this.writes.push(card.title); }
    startStreamingBlock(): string { return "block"; }
    appendToStreamingBlock(): void {}
    finishStreamingBlock(): void {}
    showToolCall(): void {}
    showToolCallArguments(): void {}
    updateToolCallArguments(): void {}
    startToolExecution(): void {}
    updateToolExecution(): void {}
    finishToolExecution(): void {}
    expandTrace(): boolean { return false; }
    refreshHistory(): void {}
    setStatus(): void {}
    setReasoningLevel(): void {}
    setSessionDetails(_lines: SessionDetailLine[]): void {}
    setBusy(): void {}
    clearBusy(): void {}
    cancelActiveInput(): void {}
    triggerEscape(): void {}
    destroy(): void {}
}

function createPersistedSession(cwd: string, sessionDir: string, firstMessage: string): string {
    mkdirSync(sessionDir, { recursive: true });
    const session = SessionManager.create(cwd, sessionDir);
    session.appendMessage({ role: "user", content: firstMessage });
    session.appendMessage({ role: "assistant", content: `${firstMessage} reply` });
    return session.getSessionFile()!;
}

test("resume chooser shows current repository sessions first with explicit all-sessions option", async () => {
    const root = mkdtempSync(join(tmpdir(), "perry-resume-current-"));

    try {
        const cwd = join(root, "repo");
        const otherCwd = join(root, "other");
        mkdirSync(cwd, { recursive: true });
        mkdirSync(otherCwd, { recursive: true });

        const currentPath = createPersistedSession(cwd, getDefaultSessionDir(cwd, root), "Current repo session");
        createPersistedSession(otherCwd, getDefaultSessionDir(otherCwd, root), "Other repo session");

        const ui = new FakeUi();
        ui.choiceResults = [currentPath];

        const selected = await chooseSessionPath(ui, cwd, getDefaultSessionDir(cwd, root));

        assert.equal(selected, currentPath);
        assert.deepEqual(ui.choicePrompts, ["Resume session"]);
        assert.equal(ui.choiceOptions[0].some((option) => option.label === "Current repo session"), true);
        assert.equal(ui.choiceOptions[0].some((option) => option.label === "Other repo session"), false);
        assert.equal(ui.choiceOptions[0][ui.choiceOptions[0].length - 1]?.label, "Show all sessions");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("resume chooser shows all sessions only after the user asks for them", async () => {
    const root = mkdtempSync(join(tmpdir(), "perry-resume-all-"));

    try {
        const cwd = join(root, "repo");
        const otherCwd = join(root, "other");
        mkdirSync(cwd, { recursive: true });
        mkdirSync(otherCwd, { recursive: true });

        const currentPath = createPersistedSession(cwd, getDefaultSessionDir(cwd, root), "Current repo session");
        const otherPath = createPersistedSession(otherCwd, getDefaultSessionDir(otherCwd, root), "Other repo session");

        const ui = new FakeUi();
        ui.choiceResults = ["__show_all_sessions__", otherPath];

        const selected = await chooseSessionPath(ui, cwd, getDefaultSessionDir(cwd, root));

        assert.equal(selected, otherPath);
        assert.deepEqual(ui.choicePrompts, ["Resume session", "Resume session from all repositories"]);
        assert.equal(ui.choiceOptions[0].some((option) => option.label === "Other repo session"), false);
        assert.equal(ui.choiceOptions[1].some((option) => option.label === "Current repo session" && String(option.description).startsWith("current ·")), true);
        assert.equal(ui.choiceOptions[1].some((option) => option.label === "Other repo session" && String(option.description).startsWith("all ·")), true);
        assert.equal(ui.choiceOptions[1].find((option) => option.value === currentPath)?.label, "Current repo session");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("resume chooser can reveal all sessions when current repository has none", async () => {
    const root = mkdtempSync(join(tmpdir(), "perry-resume-empty-current-"));

    try {
        const cwd = join(root, "repo");
        const otherCwd = join(root, "other");
        mkdirSync(cwd, { recursive: true });
        mkdirSync(otherCwd, { recursive: true });

        const otherPath = createPersistedSession(otherCwd, getDefaultSessionDir(otherCwd, root), "Other repo session");

        const ui = new FakeUi();
        ui.choiceResults = ["__show_all_sessions__", otherPath];

        const selected = await chooseSessionPath(ui, cwd, getDefaultSessionDir(cwd, root));

        assert.equal(selected, otherPath);
        assert.deepEqual(ui.choicePrompts, ["Resume session", "Resume session from all repositories"]);
        assert.equal(ui.choiceOptions[0][0]?.label, "No sessions for this repository");
        assert.equal(ui.choiceOptions[0][1]?.label, "Show all sessions");
        assert.equal(ui.choiceOptions[1].some((option) => option.label === "Other repo session"), true);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
