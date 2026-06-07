import assert from "node:assert/strict";
import { test } from "bun:test";
import { handleSlashCommands } from "../src/helpers/handleSlashCommands";
import type { State } from "../src";
import type { ChoiceOption, InteractiveUi, SessionDetailLine, StartupCard } from "../src/ui/types";

class FakeUi implements InteractiveUi {
    writes: string[] = [];
    reasoningLevels: string[] = [];
    choiceResult: unknown;
    choiceResults: unknown[] = [];
    choicePrompts: string[] = [];
    choiceOptions: ChoiceOption<unknown>[][] = [];
    choiceInitialValues: unknown[] = [];

    ask(): Promise<string> {
        throw new Error("ask not implemented in FakeUi");
    }

    choose<T = string>(prompt: string, options: ChoiceOption<T>[], initialValue?: T): Promise<T> {
        this.choicePrompts.push(prompt);
        this.choiceOptions.push(options as ChoiceOption<unknown>[]);
        this.choiceInitialValues.push(initialValue);
        const result = this.choiceResults.length > 0 ? this.choiceResults.shift() : this.choiceResult;
        return Promise.resolve(result as T);
    }

    write(message: string): void {
        this.writes.push(message);
    }

    writeWarning(message: string): void {
        this.writes.push(message);
    }

    writeUser(message: string): void {
        this.writes.push(message);
    }

    writeAssistant(message: string): void {
        this.writes.push(message);
    }

    writeThinking(message: string): void {
        this.writes.push(message);
    }

    writeStartupCard(card: StartupCard): void {
        this.writes.push(card.title);
    }

    startStreamingBlock(): string {
        return "block";
    }

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

    setReasoningLevel(level: string): void {
        this.reasoningLevels.push(level);
    }

    setSessionDetails(_lines: SessionDetailLine[]): void {}
    setBusy(): void {}
    clearBusy(): void {}
    cancelActiveInput(): void {}
    destroy(): void {}
}

function createState(overrides: Partial<State> = {}): State {
    return {
        activeProvider: "openai-api-key",
        client: null,
        currentModel: "gpt-5.4",
        reasoningLevel: "high",
        subagentReasoningLevel: "medium",
        contextLevel: "auto",
        permissionMode: "ask",
        planMode: false,
        pendingPlanExecution: false,
        subagentsMode: false,
        activeSkill: null,
        ...overrides,
    };
}

test("/thinking sets thinking level directly", async () => {
    const state = createState();
    const ui = new FakeUi();

    const shouldContinue = await handleSlashCommands({ command: "/thinking low", state, ui });

    assert.equal(shouldContinue, true);
    assert.equal(state.reasoningLevel, "low");
    assert.deepEqual(ui.reasoningLevels, ["low"]);
    assert.deepEqual(ui.writes, ["Thinking level set to low."]);
});

test("/thinking rejects unsupported level for current model", async () => {
    const state = createState({ currentModel: "gpt-5-pro", reasoningLevel: "high" });
    const ui = new FakeUi();

    await handleSlashCommands({ command: "/thinking low", state, ui });

    assert.equal(state.reasoningLevel, "high");
    assert.deepEqual(ui.reasoningLevels, []);
    assert.equal(ui.writes[0], "Unsupported thinking level 'low' for gpt-5-pro.");
    assert.equal(ui.writes[1], "Supported thinking levels: high.");
});

test("/thinking opens a chooser when no level is provided", async () => {
    const state = createState({ reasoningLevel: "low" });
    const ui = new FakeUi();
    ui.choiceResult = "medium";

    await handleSlashCommands({ command: "/thinking", state, ui });

    assert.equal(state.reasoningLevel, "medium");
    assert.deepEqual(ui.choicePrompts, ["Select thinking level"]);
    assert(ui.choiceOptions[0].some((option) => option.value === "low" && option.description === "Current thinking level"));
    assert.deepEqual(ui.reasoningLevels, ["medium"]);
    assert.deepEqual(ui.writes, ["Thinking level set to medium."]);
});

test("/thinking tells logged-out users to log in", async () => {
    const state = createState({ activeProvider: null });
    const ui = new FakeUi();

    await handleSlashCommands({ command: "/thinking high", state, ui });

    assert.equal(state.reasoningLevel, "high");
    assert.deepEqual(ui.writes, ["Not logged in. Type /login to continue."]);
});

test("/model chooses model and reasoning without prompting for context handling", async () => {
    const state = createState({ currentModel: "gpt-5.4", reasoningLevel: "high", contextLevel: "auto" });
    const ui = new FakeUi();
    const savedDefaults: Array<{ provider: string; model: string; reasoningLevel: string }> = [];
    ui.choiceResults = ["gpt-5.4-mini", "low"];

    await handleSlashCommands({
        command: "/model",
        state,
        ui,
        saveDefaultModel: async (provider, model, reasoningLevel) => {
            savedDefaults.push({ provider, model, reasoningLevel });
        },
    });

    assert.equal(state.currentModel, "gpt-5.4-mini");
    assert.equal(state.reasoningLevel, "low");
    assert.equal(state.contextLevel, "auto");
    assert.deepEqual(ui.choicePrompts, ["Select model", "Select reasoning level"]);
    assert.equal(ui.choicePrompts.includes("Select context handling"), false);
    assert.deepEqual(savedDefaults, [{ provider: "openai-api-key", model: "gpt-5.4-mini", reasoningLevel: "low" }]);
    assert.deepEqual(ui.writes, [
        "Model set to gpt-5.4-mini.",
        "Reasoning level set to low.",
        "Default model and thinking for new openai-api-key sessions set to gpt-5.4-mini · low.",
    ]);
});

test("/settings exposes context handling choice", async () => {
    const state = createState({ contextLevel: "auto" });
    const ui = new FakeUi();
    ui.choiceResults = ["context", "balanced"];

    await handleSlashCommands({ command: "/settings", state, ui });

    assert.equal(state.contextLevel, "balanced");
    assert.deepEqual(ui.choicePrompts, ["Settings", "Select context handling"]);
    assert(ui.choiceOptions[0].some((option) => option.value === "permissions" && String(option.description).includes("ask")));
    assert(ui.choiceOptions[0].some((option) => option.value === "context" && String(option.description).includes("auto")));
    assert(ui.choiceOptions[0].some((option) => option.value === "plan" && String(option.description).includes("disabled")));
    assert(ui.choiceOptions[0].some((option) => option.value === "subagent-thinking" && String(option.description).includes("medium")));
    assert(ui.choiceOptions[0].some((option) => option.value === "skills" && String(option.description).includes("reusable workflows")));
    assert(ui.choiceOptions[1].some((option) => option.value === "auto" && String(option.description).includes("Current context mode")));
    assert.deepEqual(ui.writes, ["Context handling set to balanced."]);
});

test("/settings context choice tells logged-out users to log in", async () => {
    const state = createState({ activeProvider: null });
    const ui = new FakeUi();
    ui.choiceResult = "context";

    await handleSlashCommands({ command: "/settings", state, ui });

    assert.deepEqual(ui.choicePrompts, ["Settings"]);
    assert.deepEqual(ui.writes, ["Not logged in. Type /login to continue."]);
});

test("/plan toggles planning mode", async () => {
    const state = createState();
    const ui = new FakeUi();

    await handleSlashCommands({ command: "/plan", state, ui });

    assert.equal(state.planMode, true);
    assert.equal(state.pendingPlanExecution, false);
    assert.match(ui.writes[0] ?? "", /Plan mode enabled/);

    await handleSlashCommands({ command: "/plan off", state, ui });

    assert.equal(state.planMode, false);
    assert.equal(state.pendingPlanExecution, false);
    assert.equal(ui.writes[ui.writes.length - 1], "Plan mode disabled.");
});

test("/plan status reports without toggling", async () => {
    const state = createState({ planMode: true });
    const ui = new FakeUi();

    await handleSlashCommands({ command: "/plan status", state, ui });

    assert.equal(state.planMode, true);
    assert.deepEqual(ui.writes, ["Plan mode is enabled."]);
});

test("/settings can toggle interactive plan mode", async () => {
    const state = createState({ planMode: false });
    const ui = new FakeUi();
    ui.choiceResult = "plan";

    await handleSlashCommands({ command: "/settings", state, ui });

    assert.equal(state.planMode, true);
    assert.deepEqual(ui.choicePrompts, ["Settings"]);
    assert.match(ui.writes[0] ?? "", /ask TUI planning questions/);
});

test("/permissions opens chooser", async () => {
    const state = createState({ permissionMode: "ask" });
    const ui = new FakeUi();
    ui.choiceResult = "workspace-write";

    await handleSlashCommands({ command: "/permissions", state, ui });

    assert.equal(state.permissionMode, "workspace-write");
    assert.deepEqual(ui.choicePrompts, ["Select permission mode"]);
    assert(ui.choiceOptions[0].some((option) => option.value === "ask" && String(option.description).includes("Current permission mode")));
    assert.deepEqual(ui.writes, ["Permissions set to workspace-write."]);
});

test("/permissions can set mode directly and show status", async () => {
    const state = createState({ permissionMode: "ask" });
    const ui = new FakeUi();

    await handleSlashCommands({ command: "/permissions read-only", state, ui });
    assert.equal(state.permissionMode, "read-only");
    assert.equal(ui.writes[0], "Permissions set to read-only.");

    await handleSlashCommands({ command: "/permissions yolo", state, ui });
    assert.equal(state.permissionMode, "full-access");
    assert.equal(ui.writes[1], "Permissions set to full-access.");

    await handleSlashCommands({ command: "/permissions status", state, ui });
    assert.match(ui.writes[2] ?? "", /Permissions: full-access/);
});

test("/settings exposes permissions choice", async () => {
    const state = createState({ permissionMode: "ask" });
    const ui = new FakeUi();
    ui.choiceResults = ["permissions", "full-access"];

    await handleSlashCommands({ command: "/settings", state, ui });

    assert.equal(state.permissionMode, "full-access");
    assert.deepEqual(ui.choicePrompts, ["Settings", "Select permission mode"]);
    assert.deepEqual(ui.writes, ["Permissions set to full-access."]);
});

test("/settings exposes subagent thinking level", async () => {
    const state = createState({ subagentReasoningLevel: "medium" });
    const ui = new FakeUi();
    ui.choiceResults = ["subagent-thinking", "low"];

    await handleSlashCommands({ command: "/settings", state, ui });

    assert.equal(state.subagentReasoningLevel, "low");
    assert.deepEqual(ui.choicePrompts, ["Settings", "Select subagent thinking level"]);
    assert(ui.choiceOptions[1].some((option) => option.value === "medium" && String(option.description).includes("Current subagent thinking level")));
    assert.deepEqual(ui.writes, ["Subagent thinking level set to low."]);
});

test("/settings exposes skills entry", async () => {
    const state = createState();
    const ui = new FakeUi();
    ui.choiceResult = "skills";

    await handleSlashCommands({ command: "/settings", state, ui });

    assert.deepEqual(ui.choicePrompts, ["Settings"]);
    assert.match(ui.writes[0] ?? "", /\/skills/);
    assert.match(ui.writes[0] ?? "", /\/skill <name>/);
});

test("/accept outside the main loop does not execute", async () => {
    const state = createState({ planMode: true, pendingPlanExecution: true });
    const ui = new FakeUi();

    await handleSlashCommands({ command: "/accept", state, ui });

    assert.deepEqual(ui.writes, ["No plan is waiting for approval. Ask for a plan first, then use /accept."]);
});
