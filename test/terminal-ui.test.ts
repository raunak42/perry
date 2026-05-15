import assert from "node:assert/strict";
import { test } from "bun:test";
import { TerminalUi } from "../src/ui/terminal-ui";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function stream(ui: TerminalUi, variant: "default" | "thinking", chunks: string[], delayMs = 20): Promise<void> {
    const blockId = ui.startStreamingBlock("", variant);
    for (const chunk of chunks) {
        ui.appendToStreamingBlock(blockId, chunk);
        await wait(delayMs);
    }
    ui.finishStreamingBlock(blockId);
}

function assertStreamingMergeDoesNotDropCommonChunks(ui: TerminalUi): void {
    const merge = (ui as unknown as { mergeStreamingText(previous: string, incoming: string): string }).mergeStreamingText.bind(ui);
    let text = "Streaming fixture: the parser sees common tokens";
    for (const chunk of [" ", "the", " same", " token", " is", " preserved", "."]) {
        text = merge(text, chunk);
    }

    const expected = "Streaming fixture: the parser sees common tokens the same token is preserved.";
    assert.equal(text, expected);
}

function emulateTerminalFinalScreen(raw: string, columns: number): string {
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
    return rendered.join("\n");
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
    assert.ok(selectedInlineLine && /› feat-session-compaction\s{3,}current · 124 messages · 5m ago$/.test(selectedInlineLine));
    assert.ok(unselectedInlineLine && /^\s{2}fix-terminal-picker-layout\s{3,}all · d34db33f · 41 messages · ~\/repo · 1h ago$/.test(unselectedInlineLine));
    assert.equal(
        transcript.includes("\n    current · 124 messages · 5m ago") || transcript.includes("\n    all · d34db33f · 41 messages · ~/repo · 1h ago"),
        false,
    );
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
            "3. Tool traces are numbered and can be expanded later with `/trace <number>`.\n\n",
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

test("streaming merge keeps common chunks", async () => {
    const ui = await TerminalUi.create();
    try {
        assertStreamingMergeDoesNotDropCommonChunks(ui);
    } finally {
        ui.destroy();
    }
});

test("read trace uses pi-mono style card", assertReadTraceUsesPiMonoStyleCard);
test("edit trace uses diff card without fence markers", assertEditTraceUsesDiffCardWithoutFenceMarkers);
test("live edit trace hides huge arguments until diff is ready", assertEditTraceDoesNotRenderHugeArgumentsBeforeDiff);
test("edit trace preserves all changed lines and caps only context", assertEditTracePreservesAllChangedLinesAndCapsContext);
test("stale tool output does not append duplicate cards", assertStaleToolOutputDoesNotAppendDuplicateCards);
test("numbered list markers stay intact across streaming boundaries", assertNumberedListMarkerDoesNotSplitAcrossStreamingBoundary);
test("active prompt busy streams flush safely", assertActivePromptBusyStreamFlushesSafely);
test("cumulative snapshot deltas do not repeat prefixes", assertCumulativeSnapshotDeltasDoNotPrintRepeatedPrefixes);
test("streaming growth does not replay prefixes into scrollback", assertStreamingGrowthDoesNotReplayPrefixesIntoScrollback);
test("choice frames separate options clearly", assertChoiceFrameSeparatesOptionsClearly);
test("choice frames keep metadata inline when width allows", assertChoiceFrameAlignsSessionMetadataOnTheRightWhenWidthAllows);
test("thinking streams keep using remaining line width before wrapping", assertThinkingStreamUsesRemainingLineWidthBeforeWrapping);
test("clearing busy prints a worked duration line", assertClearBusyPrintsWorkedLine);
test("busy overflow streams do not repeat or split content", assertBusyOverflowStreamDoesNotRepeatOrSplit);
test("terminal ui smoke flow completes", assertFullSmokeFlowCompletes);
