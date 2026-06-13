import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { TerminalUi } from "../src/ui/terminal-ui";
import { mergeStreamingText } from "../src/ui/streaming-rendering";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const RESIZE_SETTLE_DELAY_FOR_TEST_MS = 180;
const stripAnsi = (text: string) => text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");

function emitPromptKey(text: string | undefined, key: Record<string, unknown>): void {
    process.stdin.emit("keypress", text, key);
}

async function stream(ui: TerminalUi, variant: "default" | "thinking", chunks: string[], delayMs = 20): Promise<void> {
    const blockId = ui.startStreamingBlock("", variant);
    for (const chunk of chunks) {
        ui.appendToStreamingBlock(blockId, chunk);
        await wait(delayMs);
    }
    ui.finishStreamingBlock(blockId);
}

function assertStreamingMergeDoesNotDropCommonChunks(): void {
    let text = "Streaming fixture: the parser sees common tokens";
    for (const chunk of [" ", "the", " same", " token", " is", " preserved", "."]) {
        text = mergeStreamingText(text, chunk);
    }

    const expected = "Streaming fixture: the parser sees common tokens the same token is preserved.";
    assert.equal(text, expected);
}

function emulateTerminalFinalState(raw: string, columns: number): { screen: string; cursorRow: number; cursorCol: number } {
    const rows: string[][] = [Array(columns).fill(" ")];
    let row = 0;
    let col = 0;
    const ensureRow = (target: number) => {
        while (rows.length <= target) rows.push(Array(columns).fill(" "));
    };
    const clearLine = () => {
        rows[row] = Array(columns).fill(" ");
    };
    const clearScreenTail = () => {
        for (let c = col; c < columns; c += 1) rows[row]![c] = " ";
        rows.splice(row + 1);
    };

    for (let index = 0; index < raw.length;) {
        const char = raw[index]!;
        if (char === "\u001b" && raw[index + 1] === "[") {
            const match = /^\u001b\[([0-9;?]*)([A-Za-z])/.exec(raw.slice(index));
            if (!match) {
                index += 1;
                continue;
            }
            const params = match[1] ?? "";
            const command = match[2];
            index += match[0].length;
            if (command === "A") row = Math.max(0, row - Number(params || "1"));
            else if (command === "C") col = Math.min(columns - 1, col + Number(params || "1"));
            else if (command === "J") clearScreenTail();
            else if (command === "K") clearLine();
            continue;
        }
        if (char === "\r") {
            col = 0;
            index += 1;
            continue;
        }
        if (char === "\n") {
            row += 1;
            col = 0;
            ensureRow(row);
            index += 1;
            continue;
        }
        if (col >= columns) {
            row += 1;
            col = 0;
            ensureRow(row);
        }
        rows[row]![col] = char;
        col += 1;
        index += 1;
    }

    const rendered = rows.map((line) => line.join("").trimEnd());
    while (rendered.length > 0 && rendered[rendered.length - 1] === "") rendered.pop();
    return { screen: rendered.join("\n"), cursorRow: row, cursorCol: col };
}

function emulateTerminalFinalScreen(raw: string, columns: number): string {
    return emulateTerminalFinalState(raw, columns).screen;
}

function emulateTerminalScrollback(raw: string, columns: number, viewportRows: number): string {
    const viewport: string[][] = Array.from({ length: viewportRows }, () => Array(columns).fill(" "));
    const scrollback: string[][] = [];
    let row = 0;
    let col = 0;

    const blank = () => Array(columns).fill(" ");
    const scrollOne = () => {
        scrollback.push(viewport.shift() ?? blank());
        viewport.push(blank());
        row = viewportRows - 1;
    };
    const ensureVisibleRow = () => {
        while (row >= viewportRows) scrollOne();
    };
    const clearLine = () => {
        viewport[row] = blank();
    };
    const clearScreenTail = () => {
        for (let c = col; c < columns; c += 1) viewport[row]![c] = " ";
        for (let r = row + 1; r < viewportRows; r += 1) viewport[r] = blank();
    };

    for (let index = 0; index < raw.length;) {
        const char = raw[index]!;
        if (char === "\u001b" && raw[index + 1] === "[") {
            const match = /^\u001b\[([0-9;?]*)([A-Za-z])/.exec(raw.slice(index));
            if (!match) {
                index += 1;
                continue;
            }
            const params = match[1] ?? "";
            const command = match[2];
            index += match[0].length;
            if (command === "A") row = Math.max(0, row - Number(params || "1"));
            else if (command === "C") col = Math.min(columns - 1, col + Number(params || "1"));
            else if (command === "J") clearScreenTail();
            else if (command === "K") clearLine();
            continue;
        }
        if (char === "\r") {
            col = 0;
            index += 1;
            continue;
        }
        if (char === "\n") {
            row += 1;
            col = 0;
            ensureVisibleRow();
            index += 1;
            continue;
        }
        if (col >= columns) {
            row += 1;
            col = 0;
            ensureVisibleRow();
        }
        viewport[row]![col] = char;
        col += 1;
        index += 1;
    }

    const rendered = [...scrollback, ...viewport].map((line) => line.join("").trimEnd());
    while (rendered.length > 0 && rendered[rendered.length - 1] === "") rendered.pop();
    return rendered.join("\n");
}

async function captureTerminalOutput(columns: number, rows: number, run: (ui: TerminalUi) => Promise<void>): Promise<string> {
    const originalWrite = process.stdout.write.bind(process.stdout);
    const columnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    const rowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
    let raw = "";
    (process.stdout as unknown as { write: typeof process.stdout.write }).write = ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
        raw += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        if (typeof encoding === "function") encoding();
        if (typeof callback === "function") callback();
        return true;
    }) as typeof process.stdout.write;
    Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true });
    Object.defineProperty(process.stdout, "rows", { value: rows, configurable: true });
    const ui = await TerminalUi.create();
    try {
        await run(ui);
    } finally {
        ui.destroy();
        (process.stdout as unknown as { write: typeof process.stdout.write }).write = originalWrite as typeof process.stdout.write;
        if (columnsDescriptor) Object.defineProperty(process.stdout, "columns", columnsDescriptor);
        else delete (process.stdout as unknown as { columns?: number }).columns;
        if (rowsDescriptor) Object.defineProperty(process.stdout, "rows", rowsDescriptor);
        else delete (process.stdout as unknown as { rows?: number }).rows;
    }
    return raw;
}

async function assertResizeReplaysRetainedHistoryAtNewWidth(): Promise<void> {
    const message = "This retained history message should wrap at the narrow width and then redraw as one line after resize.";
    const raw = await captureTerminalOutput(32, 30, async (ui) => {
        ui.write(message);
        Object.defineProperty(process.stdout, "columns", { value: 120, configurable: true });
        (ui as unknown as { redrawRetainedHistoryForResize(): void }).redrawRetainedHistoryForResize();
    });
    const replayStart = raw.lastIndexOf("\u001b[?25l\u001b[H\u001b[2J\u001b[3J");
    assert.notEqual(replayStart, -1);
    const replay = stripAnsi(raw.slice(replayStart));
    assert.match(replay, new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}

async function assertResizeEventWithoutSizeChangeDoesNotReplayHistory(): Promise<void> {
    const raw = await captureResizeEventOutput({ initialColumns: 80, initialRows: 24 });
    assert.equal(raw.includes("\u001b[H\u001b[2J\u001b[3J"), false, "resize event without a real size change should not clear/replay the terminal");
}

async function assertResizeEventWithHeightOnlyChangeDoesNotReplayHistory(): Promise<void> {
    const raw = await captureResizeEventOutput({ initialColumns: 80, initialRows: 24, nextColumns: 80, nextRows: 30 });
    assert.equal(raw.includes("\u001b[H\u001b[2J\u001b[3J"), false, "height-only resize/focus events should not clear/replay scrollback");
}

async function assertResizeEventWithWidthChangeReplaysRetainedHistory(): Promise<void> {
    const message = "Width resize event should reflow this retained history message at the wider terminal width.";
    const raw = await captureResizeEventOutput({
        initialColumns: 32,
        initialRows: 24,
        nextColumns: 120,
        nextRows: 24,
        setup: async (ui) => {
            ui.write(message);
        },
    });
    const replayStart = raw.lastIndexOf("\u001b[?25l\u001b[H\u001b[2J\u001b[3J");
    assert.notEqual(replayStart, -1, "true width changes should replay retained history so old blocks reflow");
    const replay = stripAnsi(raw.slice(replayStart));
    assert.match(replay, new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}

async function captureResizeEventOutput(options: { initialColumns: number; initialRows: number; nextColumns?: number; nextRows?: number; setup?: (ui: TerminalUi) => Promise<void> | void }): Promise<string> {
    let raw = "";
    const originalWrite = process.stdout.write.bind(process.stdout);
    const isTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    const columnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    const rowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
    try {
        (process.stdout as unknown as { write: typeof process.stdout.write }).write = ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
            raw += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
            if (typeof encoding === "function") encoding();
            if (typeof callback === "function") callback();
            return true;
        }) as typeof process.stdout.write;
        Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
        Object.defineProperty(process.stdout, "columns", { value: options.initialColumns, configurable: true });
        Object.defineProperty(process.stdout, "rows", { value: options.initialRows, configurable: true });

        const ui = await TerminalUi.create();
        const prompt = ui.ask(">", { placeholder: "Type a message" }).catch(() => undefined);
        try {
            await wait(1);
            if (options.setup) await options.setup(ui);
            if (options.nextColumns !== undefined) Object.defineProperty(process.stdout, "columns", { value: options.nextColumns, configurable: true });
            if (options.nextRows !== undefined) Object.defineProperty(process.stdout, "rows", { value: options.nextRows, configurable: true });
            process.stdout.emit("resize");
            await wait(RESIZE_SETTLE_DELAY_FOR_TEST_MS);
            ui.cancelActiveInput();
            await prompt;
        } finally {
            ui.destroy();
        }
    } finally {
        if (isTTYDescriptor) Object.defineProperty(process.stdout, "isTTY", isTTYDescriptor);
        else delete (process.stdout as unknown as { isTTY?: boolean }).isTTY;
        (process.stdout as unknown as { write: typeof process.stdout.write }).write = originalWrite as typeof process.stdout.write;
        if (columnsDescriptor) Object.defineProperty(process.stdout, "columns", columnsDescriptor);
        else delete (process.stdout as unknown as { columns?: number }).columns;
        if (rowsDescriptor) Object.defineProperty(process.stdout, "rows", rowsDescriptor);
        else delete (process.stdout as unknown as { rows?: number }).rows;
    }
    return raw;
}

async function assertRefreshHistoryDropsUnretainedStreamingBlocks(): Promise<void> {
    const retained = "Retained transcript content should survive redraw.";
    const transient = "Temporary tool-planning chatter should disappear after redraw.";
    const raw = await captureTerminalOutput(80, 20, async (ui) => {
        ui.write(retained);
        const blockId = ui.startStreamingBlock();
        ui.appendToStreamingBlock(blockId, transient);
        ui.finishStreamingBlock(blockId, { retain: false });
        ui.refreshHistory();
    });
    const replayStart = raw.lastIndexOf("\u001b[?25l\u001b[H\u001b[2J\u001b[3J");
    assert.notEqual(replayStart, -1);
    const replay = stripAnsi(raw.slice(replayStart));
    assert.match(replay, new RegExp(retained.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(replay.includes(transient), false);
}

async function assertStartupAnsiPreviewIsCenteredAtNativeSize(): Promise<void> {
    const tempDir = mkdtempSync(join(tmpdir(), "perry-ansi-"));
    try {
        const ansiPath = join(tempDir, "preview.ansi");
        const source = Array.from({ length: 10 }, (_, index) => `ROW${index}ABCDEFGHIJ`).join("\n");
        writeFileSync(ansiPath, source);
        const raw = await captureTerminalOutput(80, 30, async (ui) => {
            ui.writeStartupCard({
                title: "Perry",
                ansiImagePath: ansiPath,
                lines: [],
            });
        });
        assert.doesNotMatch(raw, /ANSI image preview/);
        assert.doesNotMatch(raw, /Startup image/);
        assert.match(raw, /ROW0ABCDEFGHIJ/);
        const plain = stripAnsi(raw);
        assert.match(plain, /│ {30}ROW0ABCDEFGHIJ {31}│/);
        assert.match(plain, /│ {30}ROW1ABCDEFGHIJ {31}│/);
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
}

async function assertPromptShiftTabCyclesReasoningLevel(): Promise<void> {
    let cycles = 0;
    await captureTerminalOutput(80, 20, async (ui) => {
        const prompt = ui.ask(">", {
            placeholder: "Type a message",
            onCycleReasoningLevel: () => {
                cycles += 1;
                ui.setReasoningLevel(cycles % 2 === 0 ? "high" : "low");
                return "low";
            },
        });
        await wait(1);
        emitPromptKey("", { name: "tab", shift: true, sequence: "\u001b[Z" });
        await wait(1);
        emitPromptKey("", { name: "return" });
        const answer = await prompt;
        assert.equal(answer, "");
    });

    assert.equal(cycles, 1);
}

async function assertPromptBorderStaysTurquoiseForAllReasoningLevels(): Promise<void> {
    const raw = await captureTerminalOutput(80, 20, async (ui) => {
        const prompt = ui.ask(">", { placeholder: "Type a message" }).catch(() => undefined);
        await wait(1);
        for (const level of ["off", "minimal", "low", "medium", "high", "xhigh"]) {
            ui.setReasoningLevel(level);
            await wait(1);
        }
        ui.cancelActiveInput();
        await prompt;
    });

    assert.ok(raw.includes("\u001b[38;2;72;209;204m"), "prompt border should use turquoise");
    for (const ansi of [
        "\u001b[38;2;82;82;82m",
        "\u001b[38;2;107;114;128m",
        "\u001b[38;2;34;197;94m",
        "\u001b[38;2;234;179;8m",
        "\u001b[38;2;249;115;22m",
        "\u001b[38;2;217;70;239m",
    ]) {
        assert.equal(raw.includes(ansi), false, `prompt border should not use reasoning-level color ${ansi}`);
    }
}

async function assertStartupCardUsesTurquoiseBorder(): Promise<void> {
    const raw = await captureTerminalOutput(80, 20, async (ui) => {
        ui.writeStartupCard({
            title: "Perry",
            subtitle: "test",
            lines: [{ left: "session", right: "test-session" }],
        });
    });

    assert.ok(raw.includes("\u001b[1;38;2;72;209;204m┌ Perry "), "startup card border should use bold turquoise");
    assert.ok(raw.includes("\u001b[1;38;2;72;209;204m│"), "startup card side borders should use bold turquoise");
    assert.equal(raw.includes("\u001b[1;38;2;96;165;250m┌ Perry "), false, "startup card should not use the old blue border");
}

async function assertPromptUpDownNavigatesHistory(): Promise<void> {
    await captureTerminalOutput(80, 20, async (ui) => {
        const prompt = ui.ask(">", {
            placeholder: "Type a message",
            history: ["first previous", "second previous"],
        });
        await wait(1);
        emitPromptKey("", { name: "up" });
        await wait(1);
        emitPromptKey("", { name: "return" });
        assert.equal(await prompt, "second previous");
    });

    await captureTerminalOutput(80, 20, async (ui) => {
        const prompt = ui.ask(">", {
            placeholder: "Type a message",
            history: ["first previous", "second previous"],
        });
        await wait(1);
        emitPromptKey("draft", {});
        emitPromptKey("", { name: "up" });
        emitPromptKey("", { name: "down" });
        emitPromptKey("", { name: "return" });
        assert.equal(await prompt, "draft");
    });
}

async function assertPromptUpMovesWithinWrappedDraftBeforeHistory(): Promise<void> {
    const draft = "alpha beta gamma delta epsilon zeta eta theta";
    await captureTerminalOutput(24, 20, async (ui) => {
        const prompt = ui.ask(">", {
            placeholder: "Type a message",
            history: ["previous message"],
        });
        await wait(1);
        emitPromptKey(draft, {});
        await wait(1);
        emitPromptKey("", { name: "up" });
        await wait(1);
        emitPromptKey("", { name: "return" });
        assert.equal(await prompt, draft);
    });
}

async function assertPromptBracketedPastePreservesMultilineTextWithoutSubmitting(): Promise<void> {
    await captureTerminalOutput(80, 20, async (ui) => {
        const prompt = ui.ask(">", { placeholder: "Type a message" });
        let resolved = false;
        prompt.then(() => { resolved = true; }).catch(() => undefined);

        await wait(1);
        emitPromptKey(undefined, { name: "paste-start", sequence: "\u001b[200~" });
        emitPromptKey("first line", {});
        emitPromptKey("\r", { name: "return", sequence: "\r" });
        emitPromptKey("\n", { name: "enter", sequence: "\n" });
        emitPromptKey("second line", {});
        emitPromptKey("\r", { name: "return", sequence: "\r" });
        emitPromptKey("third line", {});
        emitPromptKey(undefined, { name: "paste-end", sequence: "\u001b[201~" });

        await wait(5);
        assert.equal(resolved, false, "pasted newlines should not submit the prompt");
        emitPromptKey("", { name: "return" });
        assert.equal(await prompt, "first line\nsecond line\nthird line");
    });
}

async function assertEscapeTriggersGlobalStopListener(): Promise<void> {
    await captureTerminalOutput(80, 20, async (ui) => {
        let triggered = 0;
        const unsubscribe = ui.onEscape(() => { triggered += 1; });
        emitPromptKey("", { name: "escape" });
        await wait(5);
        unsubscribe();
        assert.equal(triggered, 1);
    });
}

async function assertPromptEscapeRejectsPrompt(): Promise<void> {
    await captureTerminalOutput(80, 20, async (ui) => {
        const prompt = ui.ask(">", { placeholder: "Type a message" });
        await wait(1);
        emitPromptKey("", { name: "escape" });
        await assert.rejects(prompt, (error: unknown) => error instanceof Error && error.name === "AbortError");
    });
}

async function assertWriteErrorRendersRedProcessTerminated(): Promise<void> {
    const raw = await captureTerminalOutput(80, 20, async (ui) => {
        ui.writeError("Process terminated.");
    });

    assert.match(stripAnsi(raw), /Process terminated\./);
    assert.match(raw, /\u001b\[[0-9;]*38;2;248;113;113[0-9;]*m/, "error title should use red foreground styling");
}

async function assertPromptCursorDoesNotWrapBeforeInputFrameExpands(): Promise<void> {
    const originalWrite = process.stdout.write.bind(process.stdout);
    const columnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    const rowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
    let raw = "";
    let rawBeforeCleanup = "";
    (process.stdout as unknown as { write: typeof process.stdout.write }).write = ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
        raw += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        if (typeof encoding === "function") encoding();
        if (typeof callback === "function") callback();
        return true;
    }) as typeof process.stdout.write;
    Object.defineProperty(process.stdout, "columns", { value: 20, configurable: true });
    Object.defineProperty(process.stdout, "rows", { value: 10, configurable: true });

    const ui = await TerminalUi.create();
    const prompt = ui.ask(">", { placeholder: "Type a message" }).catch(() => undefined);
    try {
        await wait(1);
        emitPromptKey("x".repeat(19), {});
        await wait(1);
        rawBeforeCleanup = raw;
        ui.cancelActiveInput();
        await prompt;
    } finally {
        ui.destroy();
        (process.stdout as unknown as { write: typeof process.stdout.write }).write = originalWrite as typeof process.stdout.write;
        if (columnsDescriptor) Object.defineProperty(process.stdout, "columns", columnsDescriptor);
        else delete (process.stdout as unknown as { columns?: number }).columns;
        if (rowsDescriptor) Object.defineProperty(process.stdout, "rows", rowsDescriptor);
        else delete (process.stdout as unknown as { rows?: number }).rows;
    }

    const state = emulateTerminalFinalState(rawBeforeCleanup, 20);
    const lines = state.screen.split("\n");
    const inputLineIndex = lines.findIndex((line) => line === "x".repeat(19));
    assert.notEqual(inputLineIndex, -1, `input line missing.\n${state.screen}`);
    assert.equal(state.cursorRow, inputLineIndex, `cursor moved below single-line input before frame expanded.\n${state.screen}`);
    assert.equal(state.cursorCol, 19);
}

async function assertReadTraceUsesPiMonoStyleCard(): Promise<void> {
    const raw = await captureTerminalOutput(100, 12, async (ui) => {
        ui.showToolCall("read-trace", "read", { path: "src/tools/readFile.ts", offset: 1, limit: 3 }, "complete", "ok", {
            type: "read",
            path: "src/tools/readFile.ts",
            language: "generic",
            content: "import fs from \"node:fs/promises\";\nconst x = 1;\nfunction y() {}",
            startLine: 1,
            endLine: 3,
            totalLines: 180,
            remainingLines: 177,
        });
    });
    const screen = emulateTerminalFinalScreen(raw, 100);
    assert.match(screen, /read src\/tools\/readFile\.ts:1-3/);
    assert.equal(screen.includes("```") || screen.includes("generic") || screen.includes("File src/tools/readFile.ts"), false);
    assert.match(screen, /\+177 more lines/);
}

async function assertEditTraceUsesDiffCardWithoutFenceMarkers(): Promise<void> {
    const raw = await captureTerminalOutput(100, 12, async (ui) => {
        ui.showToolCall("edit-trace", "edit", { path: "starry-patterns.js" }, "complete", "ok", {
            type: "edit",
            path: "starry-patterns.js",
            diff: [
                " 160 }",
                "-162 function cone(size) {",
                "-163   return range(size).map((row) => centerLine(size * 2 - 1, stars(row + 1)));",
                "+162 function constellation(width, height) {",
                "+163   return range(height).map((row) => {",
                "+164     return range(width).map((column) => ((row * 7 + column * 11) % 17 === 0 ? '*' : ' ')).join('');",
                "+165   });",
                " 164 }",
            ].join("\n"),
        });
    });
    const screen = emulateTerminalFinalScreen(raw, 100);
    assert.match(screen, /edit starry-patterns\.js/);
    assert.equal(screen.includes("```") || screen.includes("Arguments") || screen.includes("Output"), false);
    assert.match(screen, /-162 function cone/);
    assert.match(screen, /\+162 function constellation/);
}

async function assertEditTraceDoesNotRenderHugeArgumentsBeforeDiff(): Promise<void> {
    const raw = await captureTerminalOutput(100, 12, async (ui) => {
        ui.showToolCall("edit-live", "edit", {
            path: "/tmp/example.js",
            edits: [{ oldText: "function oldName() {\n  return 1;\n}\n", newText: "function newName() {\n  return 2;\n}\n" }],
        }, "pending");
        ui.showToolCallArguments("edit-live", "edit", JSON.stringify({
            path: "/tmp/example.js",
            edits: [{ oldText: "function oldName() {\n  return 1;\n}\n", newText: "function newName() {\n  return 2;\n}\n" }],
        }, null, 2));
        ui.startToolExecution("edit-live");
        ui.finishToolExecution("edit-live", "ok", false, {
            type: "edit",
            path: "/tmp/example.js",
            diff: [
                "  1 function wrapper() {",
                "- 2   return oldName();",
                "+ 2   return newName();",
                "  3 }",
            ].join("\n"),
        });
    });
    const screen = emulateTerminalFinalScreen(raw, 100);
    assert.match(screen, /edit \/tmp\/example\.js/);
    assert.equal(screen.includes("Arguments") || screen.includes("oldText") || screen.includes("newText"), false);
    assert.match(screen, /- 2   return oldName\(\);/);
    assert.match(screen, /\+ 2   return newName\(\);/);
}

async function assertEditTracePreservesAllChangedLinesAndCapsContext(): Promise<void> {
    const leadingContext = Array.from({ length: 40 }, (_, index) => ` ${String(index + 1).padStart(3)} untouched before ${index + 1}`);
    const changedLines = Array.from({ length: 90 }, (_, index) => {
        const lineNumber = 100 + index;
        return [`-${lineNumber} old edit ${index}`, `+${lineNumber} new edit ${index}`];
    }).flat();
    const trailingContext = Array.from({ length: 40 }, (_, index) => ` ${String(300 + index).padStart(3)} untouched after ${index + 1}`);
    const raw = await captureTerminalOutput(140, 12, async (ui) => {
        ui.showToolCall("edit-many", "edit", { path: "large.ts" }, "complete", "ok", {
            type: "edit",
            path: "large.ts",
            diff: [...leadingContext, ...changedLines, ...trailingContext].join("\n"),
        });
    });
    const screen = emulateTerminalFinalScreen(raw, 140);
    assert.match(screen, /-100 old edit 0/);
    assert.match(screen, /\+189 new edit 89/);
    assert.equal(screen.includes("untouched before 1") || screen.includes("untouched after 40"), false);
    assert.equal(screen.includes("+110 more lines"), false);
}

async function assertStaleToolOutputDoesNotAppendDuplicateCards(): Promise<void> {
    const raw = await captureTerminalOutput(100, 8, async (ui) => {
        ui.setBusy("Working");
        ui.showToolCall("stale-shell", "run_command", { command: "bun x tsc --noEmit" }, "pending", "", {
            type: "local_shell",
            command: "bun x tsc --noEmit",
        });
        ui.startToolExecution("stale-shell");
        ui.write("Unrelated assistant text that makes the previous live trace no longer be the tail.");
        for (const output of ["one\n", "one\ntwo\n", "one\ntwo\nthree\n"]) {
            ui.updateToolExecution("stale-shell", output, false, {
                type: "local_shell",
                command: "bun x tsc --noEmit",
            });
            await wait(1);
        }
        ui.clearBusy();
    });
    assert.equal(raw.includes("trace 1 output"), false, "stale tool output appended duplicate cards");
}

async function assertRunningToolElapsedUpdatesLive(): Promise<void> {
    const originalDateNow = Date.now;
    let now = originalDateNow();
    Date.now = () => now;
    try {
        const raw = await captureTerminalOutput(100, 12, async (ui) => {
            ui.showToolCall("live-shell-time", "run_command", { command: "sleep 10" }, "pending", "", {
                type: "local_shell",
                command: "sleep 10",
            });
            ui.startToolExecution("live-shell-time");
            await wait(120);
            now += 3_400;
            await wait(120);
        });
        assert.match(stripAnsi(raw), /Running · 0\.0s/);
        assert.match(stripAnsi(raw), /Running · 3\.4s/);
    } finally {
        Date.now = originalDateNow;
    }
}

async function assertNumberedListMarkerDoesNotSplitAcrossStreamingBoundary(): Promise<void> {
    const raw = await captureTerminalOutput(120, 13, async (ui) => {
        ui.setBusy("Working");
        const blockId = ui.startStreamingBlock();
        const chunks = [
            `A neutral streaming fixture can describe several generic sections:\n\n1. Input handling\nText collected from the prompt.\n\n2. Output wrapping\nLines should wrap cleanly.\n\n3. Tool traces\nCompact cards should remain readable.\n\n`,
            "4",
            ". Final status\nA short completion message arrives after the marker boundary.\n",
        ];
        for (const chunk of chunks) {
            ui.appendToStreamingBlock(blockId, chunk);
            await wait(1);
        }
        ui.finishStreamingBlock(blockId);
        ui.clearBusy();
    });
    const screen = emulateTerminalFinalScreen(raw, 120);
    assert.match(screen, /4\. Final status/);
    assert.equal(/\n4\s*\n\. Final status/.test(screen), false, "numbered list marker was rendered before it was stable");
}

async function assertInlineMarkdownDelimitersDoNotLeakAcrossStreamingBoundary(): Promise<void> {
    const raw = await captureTerminalOutput(140, 10, async (ui) => {
        const blockId = ui.startStreamingBlock();
        ui.appendToStreamingBlock(blockId, "Yes — **");
        await wait(1);
        ui.appendToStreamingBlock(blockId, "in the important user-facing way, it’s meant to be like Pi Mono**:");
        await wait(1);
        ui.finishStreamingBlock(blockId);
    });

    const screen = stripAnsi(emulateTerminalFinalScreen(raw, 140));
    assert.match(screen, /Yes — in the important user-facing way, it’s meant to be like Pi Mono:/);
    assert.equal(screen.includes("**"), false, "bold marker leaked across streaming boundary");
}

async function assertInlineCodeDelimitersDoNotLeakAcrossStreamingBoundary(): Promise<void> {
    const raw = await captureTerminalOutput(100, 10, async (ui) => {
        const blockId = ui.startStreamingBlock();
        ui.appendToStreamingBlock(blockId, "Use `");
        await wait(1);
        ui.appendToStreamingBlock(blockId, "bun test` now.");
        await wait(1);
        ui.finishStreamingBlock(blockId);
    });

    const screen = stripAnsi(emulateTerminalFinalScreen(raw, 100));
    assert.match(screen, /Use bun test now\./);
    assert.equal(screen.includes("`"), false, "inline code marker leaked across streaming boundary");
}

async function assertPlainChunksStreamImmediately(): Promise<void> {
    const originalWrite = process.stdout.write.bind(process.stdout);
    const columnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    const rowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
    let raw = "";
    (process.stdout as unknown as { write: typeof process.stdout.write }).write = ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
        raw += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        if (typeof encoding === "function") encoding();
        if (typeof callback === "function") callback();
        return true;
    }) as typeof process.stdout.write;
    Object.defineProperty(process.stdout, "columns", { value: 88, configurable: true });
    Object.defineProperty(process.stdout, "rows", { value: 18, configurable: true });

    const ui = await TerminalUi.create();
    try {
        const blockId = ui.startStreamingBlock();
        for (const chunk of ["Hello ", "world ", "this ", "streams."]) {
            const before = raw.length;
            ui.appendToStreamingBlock(blockId, chunk);
            assert.ok(raw.length > before, `chunk ${JSON.stringify(chunk)} did not write immediately`);
        }
        ui.finishStreamingBlock(blockId);
        ui.destroy();
    } finally {
        ui.cancelActiveInput();
        (process.stdout as unknown as { write: typeof process.stdout.write }).write = originalWrite as typeof process.stdout.write;
        if (columnsDescriptor) Object.defineProperty(process.stdout, "columns", columnsDescriptor);
        else delete (process.stdout as unknown as { columns?: number }).columns;
        if (rowsDescriptor) Object.defineProperty(process.stdout, "rows", rowsDescriptor);
        else delete (process.stdout as unknown as { rows?: number }).rows;
    }

    const screen = emulateTerminalFinalScreen(raw, 88);
    assert.match(screen, /Hello world this streams\./);
}

async function assertActivePromptBusyStreamFlushesSafely(): Promise<void> {
    const originalWrite = process.stdout.write.bind(process.stdout);
    const columnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    const rowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
    let raw = "";
    (process.stdout as unknown as { write: typeof process.stdout.write }).write = ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
        raw += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        if (typeof encoding === "function") encoding();
        if (typeof callback === "function") callback();
        return true;
    }) as typeof process.stdout.write;
    Object.defineProperty(process.stdout, "columns", { value: 88, configurable: true });
    Object.defineProperty(process.stdout, "rows", { value: 18, configurable: true });

    const ui = await TerminalUi.create();
    const prompt = ui.ask(">", { placeholder: "Type..." }).catch(() => undefined);
    try {
        await wait(1);
        ui.setBusy("Working");
        const blockId = ui.startStreamingBlock();
        for (const chunk of ["Hello this is ", "a long streaming ", "paragraph with ", "no markdown boundary ", "until the final end."]) {
            ui.appendToStreamingBlock(blockId, chunk);
            await wait(1);
        }
        ui.finishStreamingBlock(blockId);
        ui.clearBusy();
        ui.cancelActiveInput();
        await prompt;
        ui.destroy();
    } finally {
        ui.cancelActiveInput();
        (process.stdout as unknown as { write: typeof process.stdout.write }).write = originalWrite as typeof process.stdout.write;
        if (columnsDescriptor) Object.defineProperty(process.stdout, "columns", columnsDescriptor);
        else delete (process.stdout as unknown as { columns?: number }).columns;
        if (rowsDescriptor) Object.defineProperty(process.stdout, "rows", rowsDescriptor);
        else delete (process.stdout as unknown as { rows?: number }).rows;
    }

    const screen = emulateTerminalFinalScreen(raw, 88);
    assert.match(screen, /Hello this is/);
    assert.match(screen, /a long streaming paragraph with no markdown boundary until the final end\./);
}

async function assertActivePromptStreamingRestoresInputFrame(): Promise<void> {
    const originalWrite = process.stdout.write.bind(process.stdout);
    const columnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    const rowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
    let raw = "";
    const writes: string[] = [];
    (process.stdout as unknown as { write: typeof process.stdout.write }).write = ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
        const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        raw += text;
        writes.push(text);
        if (typeof encoding === "function") encoding();
        if (typeof callback === "function") callback();
        return true;
    }) as typeof process.stdout.write;
    Object.defineProperty(process.stdout, "columns", { value: 88, configurable: true });
    Object.defineProperty(process.stdout, "rows", { value: 18, configurable: true });

    const ui = await TerminalUi.create();
    const prompt = ui.ask(">", { placeholder: "Type a message" }).catch(() => undefined);
    let screenBeforeCleanup = "";
    try {
        await wait(1);
        ui.setBusy("Thinking");
        await wait(1);
        const blockId = ui.startStreamingBlock();
        for (const chunk of [
            "This ", "is ", "a ", "streaming ", "fixture ", "with ", "many ", "small ", "chunks ", "while ", "the ", "prompt ", "is ", "active.",
        ]) {
            ui.appendToStreamingBlock(blockId, chunk);
            await wait(1);
        }
        ui.finishStreamingBlock(blockId);
        screenBeforeCleanup = emulateTerminalFinalScreen(raw, 88);
        ui.clearBusy();
        ui.cancelActiveInput();
        await prompt;
        ui.destroy();
    } finally {
        ui.cancelActiveInput();
        (process.stdout as unknown as { write: typeof process.stdout.write }).write = originalWrite as typeof process.stdout.write;
        if (columnsDescriptor) Object.defineProperty(process.stdout, "columns", columnsDescriptor);
        else delete (process.stdout as unknown as { columns?: number }).columns;
        if (rowsDescriptor) Object.defineProperty(process.stdout, "rows", rowsDescriptor);
        else delete (process.stdout as unknown as { rows?: number }).rows;
    }

    const promptFrameWrites = writes.filter((write) => write.includes("─".repeat(8)) && write.includes("Type a message")).length;
    assert.ok(promptFrameWrites > 0, "streaming did not restore the active prompt frame");
    assert.match(screenBeforeCleanup, /This is a streaming fixture with many small chunks while the prompt is active\./);
    assert.match(screenBeforeCleanup, /Type a message/);
}

async function assertActivePromptBusySpinnerDoesNotRedrawPromptEveryTick(): Promise<void> {
    const originalWrite = process.stdout.write.bind(process.stdout);
    const columnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    const rowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
    let raw = "";
    const writes: string[] = [];
    (process.stdout as unknown as { write: typeof process.stdout.write }).write = ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
        const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        raw += text;
        writes.push(text);
        if (typeof encoding === "function") encoding();
        if (typeof callback === "function") callback();
        return true;
    }) as typeof process.stdout.write;
    Object.defineProperty(process.stdout, "columns", { value: 88, configurable: true });
    Object.defineProperty(process.stdout, "rows", { value: 18, configurable: true });

    const ui = await TerminalUi.create();
    const prompt = ui.ask(">", { placeholder: "Type a message" }).catch(() => undefined);
    try {
        await wait(1);
        ui.setSessionDetails([
            { left: "~/repos/new-projects/perry-new (main)" },
            { left: "context [184k/400k · 46%]", right: "gpt-5.4 · high" },
        ]);
        ui.setBusy("Thinking");
        await wait(350);
        ui.clearBusy();
        ui.cancelActiveInput();
        await prompt;
        ui.destroy();
    } finally {
        ui.cancelActiveInput();
        (process.stdout as unknown as { write: typeof process.stdout.write }).write = originalWrite as typeof process.stdout.write;
        if (columnsDescriptor) Object.defineProperty(process.stdout, "columns", columnsDescriptor);
        else delete (process.stdout as unknown as { columns?: number }).columns;
        if (rowsDescriptor) Object.defineProperty(process.stdout, "rows", rowsDescriptor);
        else delete (process.stdout as unknown as { rows?: number }).rows;
    }

    const promptFrameWrites = writes.filter((write) => write.includes("─".repeat(8)) && write.includes("Type a message")).length;
    const sessionLineWrites = writes.filter((write) => write.includes("context [184k/400k · 46%]")).length;
    const clearTailCount = (raw.match(/\u001b\[J/g) ?? []).length;
    assert.ok(promptFrameWrites <= 5, `busy spinner redrew prompt frame too often: ${promptFrameWrites}`);
    assert.ok(sessionLineWrites <= 4, `busy spinner redrew session metadata too often: ${sessionLineWrites}`);
    assert.ok(clearTailCount <= 5, `busy spinner cleared terminal tail too often: ${clearTailCount}`);
}

async function assertActivePromptBusyTimerAdvancesWhileInputActive(): Promise<void> {
    const originalWrite = process.stdout.write.bind(process.stdout);
    const originalDateNow = Date.now;
    const columnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    const rowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
    let raw = "";
    let now = originalDateNow();
    Date.now = () => now;
    (process.stdout as unknown as { write: typeof process.stdout.write }).write = ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
        const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        raw += text;
        if (typeof encoding === "function") encoding();
        if (typeof callback === "function") callback();
        return true;
    }) as typeof process.stdout.write;
    Object.defineProperty(process.stdout, "columns", { value: 88, configurable: true });
    Object.defineProperty(process.stdout, "rows", { value: 18, configurable: true });

    const ui = await TerminalUi.create();
    const prompt = ui.ask(">", { placeholder: "Type a message" }).catch(() => undefined);
    try {
        await wait(1);
        ui.setBusy("Thinking");
        await wait(120);
        now += 1_000;
        await wait(120);
        now += 64_000;
        ui.setSessionDetails([{ left: "timer refresh" }]);
        await wait(1);
        ui.clearBusy();
        ui.cancelActiveInput();
        await prompt;
        ui.destroy();
    } finally {
        ui.cancelActiveInput();
        Date.now = originalDateNow;
        (process.stdout as unknown as { write: typeof process.stdout.write }).write = originalWrite as typeof process.stdout.write;
        if (columnsDescriptor) Object.defineProperty(process.stdout, "columns", columnsDescriptor);
        else delete (process.stdout as unknown as { columns?: number }).columns;
        if (rowsDescriptor) Object.defineProperty(process.stdout, "rows", rowsDescriptor);
        else delete (process.stdout as unknown as { rows?: number }).rows;
    }

    assert.match(raw, /Thinking · 0s/);
    assert.match(raw, /Thinking · 1s/);
    assert.match(raw, /Thinking · 1m 5s/);
}

async function assertActivePromptSlowStreamingKeepsSessionDetailsVisible(): Promise<void> {
    const originalWrite = process.stdout.write.bind(process.stdout);
    const columnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    const rowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
    let raw = "";
    const writes: string[] = [];
    (process.stdout as unknown as { write: typeof process.stdout.write }).write = ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
        const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        raw += text;
        writes.push(text);
        if (typeof encoding === "function") encoding();
        if (typeof callback === "function") callback();
        return true;
    }) as typeof process.stdout.write;
    Object.defineProperty(process.stdout, "columns", { value: 88, configurable: true });
    Object.defineProperty(process.stdout, "rows", { value: 18, configurable: true });

    const ui = await TerminalUi.create();
    const prompt = ui.ask(">", { placeholder: "Type a message" }).catch(() => undefined);
    let screenBeforeCleanup = "";
    try {
        await wait(1);
        ui.setSessionDetails([
            { left: "~/repos/new-projects/perry-new (main)" },
            { left: "context [184k/400k · 46%]", right: "gpt-5.4 · high" },
        ]);
        ui.setBusy("Thinking");
        const blockId = ui.startStreamingBlock();
        for (const chunk of ["Slow ", "streaming ", "chunks ", "should ", "not ", "flash."]) {
            ui.appendToStreamingBlock(blockId, chunk);
            await wait(95);
        }
        ui.finishStreamingBlock(blockId);
        screenBeforeCleanup = emulateTerminalFinalScreen(raw, 88);
        ui.clearBusy();
        ui.cancelActiveInput();
        await prompt;
        ui.destroy();
    } finally {
        ui.cancelActiveInput();
        (process.stdout as unknown as { write: typeof process.stdout.write }).write = originalWrite as typeof process.stdout.write;
        if (columnsDescriptor) Object.defineProperty(process.stdout, "columns", columnsDescriptor);
        else delete (process.stdout as unknown as { columns?: number }).columns;
        if (rowsDescriptor) Object.defineProperty(process.stdout, "rows", rowsDescriptor);
        else delete (process.stdout as unknown as { rows?: number }).rows;
    }

    const sessionLineWrites = writes.filter((write) => write.includes("context [184k/400k · 46%]")).length;
    assert.ok(sessionLineWrites > 0, "slow streaming did not restore session metadata");
    for (const word of ["Slow", "streaming", "chunks", "should", "not", "flash."]) {
        assert.match(raw, new RegExp(word.replace(".", "\\.")));
    }
    assert.match(screenBeforeCleanup, /context \[184k\/400k · 46%\]/);
}

async function assertCumulativeSnapshotDeltasDoNotPrintRepeatedPrefixes(): Promise<void> {
    const snapshots = [
        "Yes — I double-checked, and it does not look half-done.\n\nWhat I verified:\n\n- Read the terminal UI test fixture while checking the streaming fix.\n- Searched the repo for terms like:\n  - Hindu\n",
        "Yes — I double-checked, and it does not look half-done.\n\nWhat I verified:\n\n- Read the terminal UI test fixture while checking the streaming fix.\n- Searched the repo for terms like:\n  - Hindu\n  - Brahman\n  - monotheistic\n",
        "Yes — I double-checked, and it does not look half-done.\n\nWhat I verified:\n\n- Read the terminal UI test fixture while checking the streaming fix.\n- Searched the repo, excluding node_modules, .git, build output, and env files, for terms like:\n  - Hindu\n  - Brahman\n  - monotheistic\n  - religion/religious\n",
    ];
    const raw = await captureTerminalOutput(100, 10, async (ui) => {
        const blockId = ui.startStreamingBlock();
        for (const snapshot of snapshots) {
            ui.appendToStreamingBlock(blockId, snapshot);
            await wait(1);
        }
        ui.finishStreamingBlock(blockId);
    });
    const transcript = emulateTerminalScrollback(raw, 100, 10);
    const openingCount = transcript.split("Yes — I double-checked").length - 1;
    assert.equal(openingCount, 1, `cumulative snapshot deltas printed repeated prefixes ${openingCount} times`);
    assert.match(transcript, /religion\/religious/);
}

async function assertStreamingGrowthDoesNotReplayPrefixesIntoScrollback(): Promise<void> {
    const chunks = [
        "Done. I went through the first-party repo structure and especially the test files:\n\n",
        "• README.md\n",
        "• PERRY_REFINEMENT_HANDOFF.md\n",
        "• plus package.json, tsconfig.json, source layout, core UI/session/tool files, and regression tests\n\n",
        "Key takeaways:\n\n",
        "• Perry is a Bun-based CLI coding agent with a terminal-native, scrollback-first UI.\n",
        "• The current UX direction is pi-mono-like:\n",
        "  • no alternate screen\n",
        "  • immutable scrollback\n",
        "  • persistent prompt while working\n",
        "  • queued steering messages\n",
        "  • streamed assistant + thinking output\n",
        "  • clean local tool traces\n",
        "  • local JSONL session persistence/resume\n",
        "• The main active files are:\n",
        "  • src/index.ts\n",
        "  • src/ui/terminal-ui.ts\n",
        "  • src/ui/bottom-area.ts\n",
        "  • src/ui/terminal-formatting.ts\n",
        "  • src/helpers/sessionManager.ts\n",
        "  • src/tools/*\n",
    ];
    const raw = await captureTerminalOutput(76, 10, async (ui) => {
        ui.setBusy("Working");
        await stream(ui, "default", chunks, 1);
        ui.clearBusy();
    });
    const transcript = emulateTerminalScrollback(raw, 76, 10);
    const openingCount = transcript.split("Done. I went through").length - 1;
    assert.equal(openingCount, 1, `streaming row growth replayed prior prefixes into scrollback ${openingCount} times`);
}

async function assertChoiceFrameSeparatesOptionsClearly(): Promise<void> {
    const raw = await captureTerminalOutput(72, 12, async (ui) => {
        const choice = ui.choose("Resume session", [
            {
                label: "feat-session-compaction-2026-05-12T13-30-00",
                value: "session-1",
                description: "current · 124 messages · 5m ago",
            },
            {
                label: "fix-terminal-picker-layout-2026-05-11T18-10-00",
                value: "session-2",
                description: "current · 41 messages · 1h ago",
            },
        ]);
        await wait(5);
        ui.cancelActiveInput();
        await choice.catch(() => undefined);
    });
    const transcript = raw.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "\n");
    assert.match(transcript, /↑\/↓ move · Enter select · Ctrl\+C cancel/);
    assert.match(transcript, /› feat-session-compaction-2026-05-12T13-30-00/);
    assert.equal(transcript.includes("• fix-terminal-picker-layout-2026-05-11T18-10-00"), false);
    assert.match(transcript, /  fix-terminal-picker-layout-2026-05-11T18-10-00/);
    assert.match(transcript, /current · 124 messages · 5m ago/);
    assert.match(transcript, /current · 41 messages · 1h ago/);
    assert.equal(
        transcript.includes("feat-session-compaction-2026-05-12T13-30-00 — current") || transcript.includes("fix-terminal-picker-layout-2026-05-11T18-10-00 — current"),
        false,
    );
}

async function assertChoiceFrameAlignsSessionMetadataOnTheRightWhenWidthAllows(): Promise<void> {
    const raw = await captureTerminalOutput(96, 12, async (ui) => {
        const choice = ui.choose("Resume session", [
            {
                label: "feat-session-compaction",
                value: "session-1",
                description: "current · 124 messages · 5m ago",
            },
            {
                label: "fix-terminal-picker-layout",
                value: "session-2",
                description: "all · d34db33f · 41 messages · ~/repo · 1h ago",
            },
        ]);
        await wait(5);
        ui.cancelActiveInput();
        await choice.catch(() => undefined);
    });
    const transcript = raw.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "\n");
    const normalizedLines = transcript.split("\n").map((line) => line.trimEnd());
    const selectedInlineLine = normalizedLines.find((line) => line.includes("feat-session-compaction"));
    const unselectedInlineLine = normalizedLines.find((line) => line.includes("fix-terminal-picker-layout"));
    assert.ok(selectedInlineLine && /^\s+› feat-session-compaction\s{3,}current · 124 messages · 5m ago$/.test(selectedInlineLine));
    assert.ok(unselectedInlineLine && /^\s{3}fix-terminal-picker-layout\s{3,}all · d34db33f · 41 messages · ~\/repo · 1h ago$/.test(unselectedInlineLine));
    assert.equal(
        transcript.includes("\n    current · 124 messages · 5m ago") || transcript.includes("\n    all · d34db33f · 41 messages · ~/repo · 1h ago"),
        false,
    );
}

async function assertChoiceFrameStylesSelectedOptionTurquoiseBold(): Promise<void> {
    const selectedAnsi = "\u001b[1;38;2;72;209;204m";
    const raw = await captureTerminalOutput(80, 12, async (ui) => {
        const choice = ui.choose("Choose approach", [
            {
                label: "Recommended",
                value: "recommended",
                description: "fast path",
            },
            {
                label: "Conservative",
                value: "conservative",
                description: "slower but safer",
            },
        ]);
        await wait(5);
        ui.cancelActiveInput();
        await choice.catch(() => undefined);
    });

    assert.ok(raw.includes(`${selectedAnsi}› Recommended`), "selected label should be bold turquoise");
    assert.ok(raw.includes("fast path"), "selected inline description should render");
    assert.equal(raw.includes(`${selectedAnsi}  Conservative`), false, "unselected label should not use selected turquoise style");
}

async function assertChoiceFrameStylesSelectedWrappedDescriptionTurquoiseBold(): Promise<void> {
    const selectedAnsi = "\u001b[1;38;2;72;209;204m";
    const raw = await captureTerminalOutput(40, 12, async (ui) => {
        const choice = ui.choose("Choose approach", [
            {
                label: "Recommended path",
                value: "recommended",
                description: "Ask focused questions first",
            },
            {
                label: "Conservative path",
                value: "conservative",
                description: "Inspect more before changing anything",
            },
        ]);
        await wait(5);
        ui.cancelActiveInput();
        await choice.catch(() => undefined);
    });

    assert.ok(raw.includes(`${selectedAnsi}› Recommended path`), "selected label should be bold turquoise");
    assert.ok(raw.includes(`${selectedAnsi}    Ask focused questions first`), "selected wrapped description should be bold turquoise");
    assert.equal(raw.includes(`${selectedAnsi}  Conservative path`), false, "unselected label should not use selected turquoise style");
}

async function assertChoiceFrameUsesCompactOnePixelApproximation(): Promise<void> {
    const rowBackgroundAnsi = "\u001b[48;2;31;31;31m";
    const raw = await captureTerminalOutput(80, 14, async (ui) => {
        const choice = ui.choose("Permission required", [
            { label: "Allow once", value: "allow_once", description: "Run only this action" },
            { label: "Deny", value: "deny", description: "Do not run this action" },
            { label: "Full access / YOLO mode", value: "full-access", description: "Auto-approve future prompts" }
        ]);
        await wait(5);
        ui.cancelActiveInput();
        await choice.catch(() => undefined);
    });
    const transcript = stripAnsi(raw).replace(/\r/g, "\n");
    assert.match(transcript, /› Allow once[^\n]*Run only this action[ \t]*\n[ \t]*Deny[^\n]*Do not run this action[ \t]*\n[ \t]*Full access \/ YOLO mode/, "options should use the most compact terminal-row approximation of 1px vertical padding");
    assert.equal(/› Allow once[^\n]*Run only this action[ \t]*\n[ \t]*\n[ \t]*Deny/.test(transcript), false, "options should not add full blank terminal-row padding");
    assert.ok(raw.includes(rowBackgroundAnsi), "selected option row should still use the selected row background");
}

async function assertChoiceFrameWindowsLongOptionListsWithIndicator(): Promise<void> {
    const raw = await captureTerminalOutput(80, 24, async (ui) => {
        const choice = ui.choose("Select model", Array.from({ length: 60 }, (_, index) => ({
            label: `model-${index + 1}`,
            value: index + 1,
            description: "provider",
        })), 6);
        await wait(5);
        ui.cancelActiveInput();
        await choice.catch(() => undefined);
    });
    const transcript = stripAnsi(raw);
    assert.ok(transcript.includes("model-1"));
    assert.ok(transcript.includes("model-10"));
    assert.equal(transcript.includes("model-11"), false, "long choice frame should not show all options at once");
    assert.ok(transcript.includes("(6/60)"), "long choice frame should show selected position indicator");
}

async function assertBareSlashShowsWindowedCommandSuggestionsWithIndicator(): Promise<void> {
    const raw = await captureTerminalOutput(90, 40, async (ui) => {
        const prompt = ui.ask(">", { placeholder: "Type a message" }).catch(() => undefined);
        await wait(1);
        emitPromptKey("/", {});
        await wait(5);
        ui.cancelActiveInput();
        await prompt;
    });
    const transcript = stripAnsi(raw);
    for (const command of ["/help", "/login", "/logout", "/model", "/thinking", "/settings", "/permissions", "/mcp", "/skills", "/skill"]) {
        assert.ok(transcript.includes(command), `missing visible slash command suggestion ${command}`);
    }
    assert.equal(transcript.includes("/plan"), false, "bare slash should not show every command at once");
    assert.ok(transcript.includes("(1/19)"), "bare slash suggestions should show the selected position indicator");
}

async function assertSlashCommandSuggestionWindowScrollsWithSelection(): Promise<void> {
    const raw = await captureTerminalOutput(90, 40, async (ui) => {
        const prompt = ui.ask(">", { placeholder: "Type a message" }).catch(() => undefined);
        await wait(1);
        emitPromptKey("/", {});
        for (let index = 0; index < 10; index += 1) {
            emitPromptKey("", { name: "down" });
        }
        await wait(5);
        ui.cancelActiveInput();
        await prompt;
    });
    const transcript = stripAnsi(raw);
    assert.ok(transcript.includes("/plan"), "window should scroll to later commands as selection moves");
    assert.ok(transcript.includes("(11/19)"), "indicator should update with the selected slash command index");
}

async function assertPromptRendersRepoAndContextMetadataBelowInput(): Promise<void> {
    const originalWrite = process.stdout.write.bind(process.stdout);
    const columnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    const rowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
    let raw = "";
    (process.stdout as unknown as { write: typeof process.stdout.write }).write = ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
        raw += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        if (typeof encoding === "function") encoding();
        if (typeof callback === "function") callback();
        return true;
    }) as typeof process.stdout.write;
    Object.defineProperty(process.stdout, "columns", { value: 84, configurable: true });
    Object.defineProperty(process.stdout, "rows", { value: 18, configurable: true });

    const ui = await TerminalUi.create();
    const prompt = ui.ask(">", { placeholder: "Type a message" }).catch(() => undefined);
    try {
        ui.setSessionDetails([
            { left: "~/repos/new-projects/perry-new (main)" },
            { left: "context [184k/400k · 46%]", right: "gpt-5.4 · high" },
        ]);
        await wait(5);
        ui.cancelActiveInput();
        await prompt;
    } finally {
        ui.cancelActiveInput();
        ui.destroy();
        (process.stdout as unknown as { write: typeof process.stdout.write }).write = originalWrite as typeof process.stdout.write;
        if (columnsDescriptor) Object.defineProperty(process.stdout, "columns", columnsDescriptor);
        else delete (process.stdout as unknown as { columns?: number }).columns;
        if (rowsDescriptor) Object.defineProperty(process.stdout, "rows", rowsDescriptor);
        else delete (process.stdout as unknown as { rows?: number }).rows;
    }

    const transcript = raw.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "\n");
    assert.match(transcript, /~\/repos\/new-projects\/perry-new \(main\)/);
    const metadataLine = transcript.split("\n").find((line) => line.includes("context [184k/400k · 46%]"));
    assert.ok(metadataLine, `prompt metadata line missing.\n${transcript}`);
    assert.match(metadataLine!, /^context \[184k\/400k · 46%\]\s{3,}gpt-5\.4 · high$/);
}

async function assertThinkingStreamUsesRemainingLineWidthBeforeWrapping(): Promise<void> {
    const raw = await captureTerminalOutput(40, 12, async (ui) => {
        ui.setBusy("Working");
        const blockId = ui.startStreamingBlock("", "thinking");
        for (const chunk of [
            "I need to stream enough thinking text ",
            "to cross the viewport while the loader ",
            "remains stable. ",
            "This block deliberately contains long ",
            "sentences that should wrap at word ",
            "boundaries rather than chopping words ",
            "in half.",
        ]) {
            ui.appendToStreamingBlock(blockId, chunk);
            await wait(1);
        }
        ui.finishStreamingBlock(blockId);
        ui.clearBusy();
    });
    const screen = emulateTerminalFinalScreen(raw, 40);
    assert.match(screen, /thinking text\nto cross the viewport while the loader/);
    assert.equal(screen.includes(" t\no cross the viewport") || screen.includes("\n to cross the viewport"), false);
}

async function assertClearBusyPrintsWorkedLine(): Promise<void> {
    const raw = await captureTerminalOutput(80, 8, async (ui) => {
        ui.setBusy("Working");
        await wait(5);
        ui.clearBusy();
    });
    const transcript = raw.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "\n");
    assert.match(transcript, /─ Worked for \d+s ─+/);
}

async function assertBusyOverflowStreamDoesNotRepeatOrSplit(): Promise<void> {
    const originalWrite = process.stdout.write.bind(process.stdout);
    const columnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    const rowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
    let raw = "";
    (process.stdout as unknown as { write: typeof process.stdout.write }).write = ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
        raw += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        if (typeof encoding === "function") encoding();
        if (typeof callback === "function") callback();
        return true;
    }) as typeof process.stdout.write;
    Object.defineProperty(process.stdout, "columns", { value: 88, configurable: true });
    Object.defineProperty(process.stdout, "rows", { value: 9, configurable: true });

    try {
        const ui = await TerminalUi.create();
        const text = `Streaming overflow fixture begins here:\n\nA long response can reach the edge of the viewport while new chunks continue arriving. The renderer should update only the unstable tail and leave committed scrollback alone.\n\nIt should preserve paragraph boundaries, wrap words predictably, and keep the busy indicator from overwriting visible content while the response grows.\n\nSome paragraphs contain wrapped status lines:\n- collect the latest chunk,\n- merge it with the current buffer,\n- redraw only the unstable tail,\n- leave committed history alone.\n\nOther paragraphs describe neutral content:\n- stable layout measurements,\n- predictable word wrapping,\n- compact progress indicators,\n- final cursor placement.\n\nThe fixture stays domain-neutral while still exercising overflow, bullets, wrapping, and streaming updates.\n`;
        ui.setBusy("Working");
        const blockId = ui.startStreamingBlock();
        for (let index = 0; index < text.length; index += 24) {
            ui.appendToStreamingBlock(blockId, text.slice(index, index + 24));
            await wait(1);
        }
        ui.finishStreamingBlock(blockId);
        ui.clearBusy();
        ui.destroy();
    } finally {
        (process.stdout as unknown as { write: typeof process.stdout.write }).write = originalWrite as typeof process.stdout.write;
        if (columnsDescriptor) Object.defineProperty(process.stdout, "columns", columnsDescriptor);
        else delete (process.stdout as unknown as { columns?: number }).columns;
        if (rowsDescriptor) Object.defineProperty(process.stdout, "rows", rowsDescriptor);
        else delete (process.stdout as unknown as { rows?: number }).rows;
    }

    const screen = emulateTerminalFinalScreen(raw, 88);
    const titleCount = screen.split("Streaming overflow fixture begins here:").length - 1;
    assert.equal(titleCount, 1, `busy overflow stream repeated the opening line ${titleCount} times`);
    assert.match(screen, /Some paragraphs contain wrapped status lines:/);
    assert.equal(screen.includes("Some paragraphs cont\n"), false);
}

async function assertFullSmokeFlowCompletes(): Promise<void> {
    const raw = await captureTerminalOutput(80, 16, async (ui) => {
        ui.write("Terminal UI regression smoke run: scrollback-first append-only rendering.");
        ui.writeUser("Please exercise long thinking, live tool traces, and long assistant streaming without replaying old output.");
        ui.setBusy("Working");

        await stream(ui, "thinking", [
            "### Planning the response\n\n",
            "I need to stream enough thinking text to cross the viewport while the loader remains stable. ",
            "This block deliberately contains long sentences that should wrap at word boundaries rather than chopping words in half. ",
            "The renderer must never repaint committed history or replay old terminal content.\n\n",
            "- Verify loader cleanup\n",
            "- Verify panel formatting\n",
            "- Verify tail-only streaming updates\n",
        ]);
        await stream(ui, "thinking", ["\n\n   \n"], 1);

        ui.showToolCall("trace-read", "read", { path: "src/ui/terminal-ui.ts", offset: 1, limit: 40 }, "pending", "", {
            type: "read",
            path: "src/ui/terminal-ui.ts",
            language: "ts",
            content: "export class TerminalUi implements InteractiveUi {\n  // regression fixture\n}\n",
        });
        ui.startToolExecution("trace-read");
        await wait(30);
        ui.updateToolExecution("trace-read", "Reading src/ui/terminal-ui.ts\nLoaded 40 lines\n", false, {
            type: "read",
            path: "src/ui/terminal-ui.ts",
            language: "ts",
            content: "export class TerminalUi implements InteractiveUi {\n  // regression fixture\n}\n",
        });
        await wait(30);
        ui.finishToolExecution("trace-read", "Reading src/ui/terminal-ui.ts\nLoaded 40 lines\n", false, {
            type: "read",
            path: "src/ui/terminal-ui.ts",
            language: "ts",
            content: "export class TerminalUi implements InteractiveUi {\n  // regression fixture\n}\n",
        });

        ui.showToolCall("trace-shell", "run_command", { command: "bun x tsc --noEmit" }, "pending", "", {
            type: "local_shell",
            command: "bun x tsc --noEmit",
        });
        ui.startToolExecution("trace-shell");
        for (const output of [
            "$ bun x tsc --noEmit\n",
            "$ bun x tsc --noEmit\nChecking types...\n",
            "$ bun x tsc --noEmit\nChecking types...\nTypecheck passed.\n",
        ]) {
            ui.updateToolExecution("trace-shell", output, false, {
                type: "local_shell",
                command: "bun x tsc --noEmit",
            });
            await wait(20);
        }
        ui.finishToolExecution("trace-shell", "$ bun x tsc --noEmit\nChecking types...\nTypecheck passed.\n", false, {
            type: "local_shell",
            command: "bun x tsc --noEmit",
        });

        await stream(ui, "default", [
            "## Final answer\n\n",
            "This is a deliberately long streamed assistant response. It should preserve normal terminal scrollback, keep text selectable, and avoid repainting history once content has scrolled. ",
            "Words should wrap as whole words everywhere; only an extremely long single_token_without_any_spaces_should_be_allowed_to_split_when_it_exceeds_the_terminal_width.\n\n",
            "1. The prompt is only displayed while waiting for input.\n",
            "2. The loader represents the full model/tool/model lifecycle.\n",
            "3. Tool traces are summarized inline without a separate expansion command.\n\n",
            "> Formatting should work consistently in assistant output, thinking panels, and trace panels.\n\n",
            "| Area | Expected |\n| --- | --- |\n| titles | styled |\n| bullets | wrapped |\n| code | highlighted |\n\n",
            "- [x] inline `code`\n- [x] links like https://example.com\n\n",
            "```ts\n",
            "const renderer = 'append-only terminal ui';\n",
            "console.log(renderer);\n",
            "```\n\n",
            "The run is complete if no old chunks repeat, no fragments are stuck at the left edge, and the final cursor lands cleanly after the loader clears.\n",
        ]);

        ui.clearBusy();
    });

    const transcript = raw.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "\n");
    assert.match(transcript, /Terminal UI regression smoke run/);
    assert.match(transcript, /Final answer/);
    assert.match(transcript, /read src\/ui\/terminal-ui\.ts/);
    assert.match(transcript, /\$ bun x tsc --noEmit/);
    assert.match(transcript, /Worked for/);
}

test("resize replays retained history at new width", assertResizeReplaysRetainedHistoryAtNewWidth);
test("resize event without size change does not replay history", assertResizeEventWithoutSizeChangeDoesNotReplayHistory);
test("resize event with width change replays retained history", assertResizeEventWithWidthChangeReplaysRetainedHistory);
test("refreshHistory redraw drops unretained streaming blocks", assertRefreshHistoryDropsUnretainedStreamingBlocks);
test("startup ANSI preview is centered at native size", assertStartupAnsiPreviewIsCenteredAtNativeSize);

test("streaming merge keeps common chunks", async () => {
    const ui = await TerminalUi.create();
    try {
        assertStreamingMergeDoesNotDropCommonChunks();
    } finally {
        ui.destroy();
    }
});

test("prompt Shift+Tab cycles reasoning level", assertPromptShiftTabCyclesReasoningLevel);
test("prompt border stays turquoise for all reasoning levels", assertPromptBorderStaysTurquoiseForAllReasoningLevels);
test("startup card uses turquoise border", assertStartupCardUsesTurquoiseBorder);
test("writeError renders process terminated in red", assertWriteErrorRendersRedProcessTerminated);
test("prompt up/down navigates message history", assertPromptUpDownNavigatesHistory);
test("prompt up moves within wrapped draft before history", assertPromptUpMovesWithinWrappedDraftBeforeHistory);
test("prompt bracketed paste preserves multiline text without submitting", assertPromptBracketedPastePreservesMultilineTextWithoutSubmitting);
test("prompt cursor does not wrap before input frame expands", assertPromptCursorDoesNotWrapBeforeInputFrameExpands);
test("read trace uses pi-mono style card", assertReadTraceUsesPiMonoStyleCard);
test("edit trace uses diff card without fence markers", assertEditTraceUsesDiffCardWithoutFenceMarkers);
test("live edit trace hides huge arguments until diff is ready", assertEditTraceDoesNotRenderHugeArgumentsBeforeDiff);
test("edit trace preserves all changed lines and caps only context", assertEditTracePreservesAllChangedLinesAndCapsContext);
test("stale tool output does not append duplicate cards", assertStaleToolOutputDoesNotAppendDuplicateCards);
test("running tool elapsed time updates live", assertRunningToolElapsedUpdatesLive);
test("numbered list markers stay intact across streaming boundaries", assertNumberedListMarkerDoesNotSplitAcrossStreamingBoundary);
test("inline markdown delimiters do not leak across streaming boundaries", assertInlineMarkdownDelimitersDoNotLeakAcrossStreamingBoundary);
test("inline code delimiters do not leak across streaming boundaries", assertInlineCodeDelimitersDoNotLeakAcrossStreamingBoundary);
test("plain chunks stream immediately", assertPlainChunksStreamImmediately);
test("active prompt busy streams flush safely", assertActivePromptBusyStreamFlushesSafely);
test("active prompt streaming restores input frame", assertActivePromptStreamingRestoresInputFrame);
test("active prompt busy spinner does not redraw prompt every tick", assertActivePromptBusySpinnerDoesNotRedrawPromptEveryTick);
test("active prompt busy timer advances while input active", assertActivePromptBusyTimerAdvancesWhileInputActive);
test("active prompt slow streaming keeps session details visible", assertActivePromptSlowStreamingKeepsSessionDetailsVisible);
test("cumulative snapshot deltas do not repeat prefixes", assertCumulativeSnapshotDeltasDoNotPrintRepeatedPrefixes);
test("streaming growth does not replay prefixes into scrollback", assertStreamingGrowthDoesNotReplayPrefixesIntoScrollback);
test("choice frames separate options clearly", assertChoiceFrameSeparatesOptionsClearly);
test("choice frames keep metadata inline when width allows", assertChoiceFrameAlignsSessionMetadataOnTheRightWhenWidthAllows);
test("choice frames style selected option turquoise and bold", assertChoiceFrameStylesSelectedOptionTurquoiseBold);
test("choice frames style selected wrapped description turquoise and bold", assertChoiceFrameStylesSelectedWrappedDescriptionTurquoiseBold);
test("choice frames use compact one-pixel padding approximation", assertChoiceFrameUsesCompactOnePixelApproximation);
test("choice frames window long option lists with indicator", assertChoiceFrameWindowsLongOptionListsWithIndicator);
test("bare slash shows windowed command suggestions with indicator", assertBareSlashShowsWindowedCommandSuggestionsWithIndicator);
test("slash command suggestion window scrolls with selection", assertSlashCommandSuggestionWindowScrollsWithSelection);
test("prompt renders repo and context metadata below the input box", assertPromptRendersRepoAndContextMetadataBelowInput);
test("thinking streams keep using remaining line width before wrapping", assertThinkingStreamUsesRemainingLineWidthBeforeWrapping);
test("clearing busy prints a worked duration line", assertClearBusyPrintsWorkedLine);
test("busy overflow streams do not repeat or split content", assertBusyOverflowStreamDoesNotRepeatOrSplit);
test("terminal ui smoke flow completes", assertFullSmokeFlowCompletes);
