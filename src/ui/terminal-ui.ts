import { emitKeypressEvents } from "node:readline";
import { filterSlashCommands, type SlashCommandDefinition } from "../helpers/commands";
import type { KnownToolTraceDetails } from "../tools/traceDetails";
import {
    buildToolTraceMarkdown,
    type ToolTraceStatus,
    type ToolTraceViewModel,
} from "./traceFormatting";
import { BottomArea, type TransientFrame } from "./bottom-area";
import { TerminalFormatter, type AnsiStyle } from "./terminal-formatting";
import { CHOICE_HINT_TEXT, renderChoiceOptionsWindow } from "./choice-rendering";
import { readStartupAnsiPreview, renderStartupCardBlock } from "./startup-card-rendering";
import { getStreamingDelta, getStreamingDisplayText, mergeStreamingText } from "./streaming-rendering";
import { openImageExternally } from "../helpers/externalImageViewer";
import { renderTerminalImage } from "../helpers/inlineImage";
import { formatClipboardPathForPrompt, pasteClipboardImageAsTempFile } from "../helpers/clipboardImage";
import type { ChoiceOption, InteractiveUi, PersistableToolTrace, PromptOptions, SessionDetailLine, StartupCard } from "./types";

const RESIZE_SETTLE_DELAY_MS = 120;
const STREAM_INPUT_REDRAW_DEBOUNCE_MS = 80;
const TOOL_ELAPSED_REDRAW_INTERVAL_MS = 100;
const PROMPT_BORDER_CHARS = { horizontal: "─" };
const PROMPT_BORDER_COLOR = "#48d1cc";
const READ_TRACE_PREVIEW_LINES = 20;
const READ_TRACE_EXPANDED_LINES = 160;
const WRITE_TRACE_PREVIEW_LINES = 20;
const WRITE_TRACE_EXPANDED_LINES = 160;
const SHELL_TRACE_PREVIEW_LINES = 20;
const SHELL_TRACE_EXPANDED_LINES = 160;
const EDIT_TRACE_PREVIEW_LINES = 80;
const EDIT_TRACE_EXPANDED_LINES = 300;

type MessageVariant = "default" | "thinking";

type Keypress = {
    name?: string;
    sequence?: string;
    ctrl?: boolean;
    meta?: boolean;
    shift?: boolean;
};

type TerminalSize = {
    columns: number;
    rows: number;
};

interface ToolHistorySnapshot {
    id: string;
    displayId: number;
    toolName: string;
    args?: unknown;
    argsText?: string;
    output: string;
    status: ToolTraceStatus;
    details?: KnownToolTraceDetails;
    expanded: boolean;
    startedAt?: number;
    finishedAt?: number;
}

interface StreamingBlockState {
    id: string;
    variant: MessageVariant;
    rawText: string;
    emittedText: string;
    renderedText: string;
    started: boolean;
    styleOpen: boolean;
    endedWithNewline: boolean;
    printedRows: number;
    appendColumn: number;
    appendPendingSpace: boolean;
    rawAppendBuffer: string;
    cursorDetachedAfterRewrite: boolean;
    printedRawEndsWithNewline: boolean;
    appendOnly: boolean;
}

type RetainedHistoryBlock =
    | { kind: "markdown"; message: string }
    | { kind: "warning"; message: string }
    | { kind: "error"; message: string }
    | { kind: "user"; message: string }
    | { kind: "assistant"; message: string }
    | { kind: "thinking"; message: string }
    | { kind: "startup"; card: StartupCard }
    | { kind: "worked"; elapsedMs: number }
    | { kind: "tool"; key: string; trace: ToolHistorySnapshot };

/**
 * Scrollback-friendly terminal UI with retained committed blocks.
 *
 * The UI still writes to normal terminal scrollback during day-to-day use, but it
 * keeps source data for committed blocks so explicit refreshes can rebuild the
 * visible transcript when transient streaming output must be dropped.
 *
 * True terminal width changes replay retained history so committed transcript
 * blocks reflow at the new size. No-op and height-only resize/focus events are
 * ignored to avoid clearing/replaying scrollback when a terminal merely regains
 * focus.
 */
export class TerminalUi implements InteractiveUi {
    private readonly formatter = new TerminalFormatter(() => this.getTerminalWidth());
    private readonly bottomArea = new BottomArea({
        write: (text) => this.writeStdout(text),
        getWidth: () => this.getTerminalWidth(),
        getNeedsBlockSeparator: () => this.needsBlockSeparator,
        beginBlock: () => this.beginBlock(),
        canShowBusyLine: () => this.canSafelyShowBusyLine(),
        isInputActive: () => this.activeSessionCleanup !== null,
        requestInputRedraw: () => this.requestActiveSessionRedraw(),
        formatter: this.formatter,
    });
    private currentReasoningLevel = "high";
    private statusMessage = "";
    private sessionDetails: SessionDetailLine[] = [];
    private destroyed = false;
    private needsBlockSeparator = false;
    private readonly streamingBlocks = new Map<string, StreamingBlockState>();
    private nextStreamingBlockId = 1;
    private nextToolDisplayId = 1;
    private readonly toolTraces = new Map<string, ToolHistorySnapshot>();
    private readonly toolTraceDisplayIds = new Map<number, string>();
    private readonly toolPrinted = new Set<string>();
    private readonly toolLastOutput = new Map<string, string>();
    private liveTailTrace: { id: string; rows: number; rendered: string } | null = null;
    private queuedSteeringMessages: string[] = [];
    private queuedMessageEditHandler: (() => string) | null = null;
    private activeSessionReject: ((error: Error) => void) | null = null;
    private activeSessionCleanup: (() => void) | null = null;
    private activeSessionRedraw: (() => void) | null = null;
    private activeSessionRedrawTimer: ReturnType<typeof setTimeout> | null = null;
    private toolElapsedTimer: ReturnType<typeof setInterval> | null = null;
    private deferActiveSessionRedraws = false;
    private stdoutBatchDepth = 0;
    private stdoutBatchBuffer = "";
    private readonly retainedHistory: RetainedHistoryBlock[] = [];
    private readonly toolTraceFinishedListeners = new Set<(trace: PersistableToolTrace) => void>();
    private readonly escapeListeners = new Set<() => void>();
    private globalEscapeHandlerAttached = false;
    private globalEscapeWasPaused = true;
    private lastEscapeTriggeredAt = 0;
    private replayingRetainedHistory = false;
    private resizeRedrawTimer: ReturnType<typeof setTimeout> | null = null;
    private resizeHandlerAttached = false;
    private lastKnownTerminalSize: TerminalSize | null = this.readTerminalSize();

    static async create(): Promise<TerminalUi> {
        return new TerminalUi();
    }

    async ask(prompt: string, options?: PromptOptions): Promise<string> {
        this.ensureUsable();
        this.ensureNoActiveSession();
        this.bottomArea.clearBusyLineOnly();

        return new Promise((resolve, reject) => {
            const showPromptText = this.shouldShowPromptText(prompt);
            let value = "";
            let cursor = 0;
            let selectedSuggestionIndex = 0;
            let frame: TransientFrame | null = null;
            let historyIndex: number | null = null;
            let draftBeforeHistory: string | null = null;
            let clipboardImagePasteInFlight = false;
            let bracketedPasteActive = false;
            let bracketedPasteBuffer = "";

            const getSuggestions = (): SlashCommandDefinition[] => {
                if (options?.enableSlashCommands === false) return [];
                return filterSlashCommands(value);
            };

            const clampSuggestionIndex = () => {
                const suggestions = getSuggestions();
                selectedSuggestionIndex = suggestions.length === 0
                    ? 0
                    : Math.max(0, Math.min(selectedSuggestionIndex, suggestions.length - 1));
            };

            const getHistoryEntries = (): string[] => {
                const source = typeof options?.history === "function" ? options.history() : options?.history;
                return (source ?? [])
                    .map((entry) => this.normalizeNewlines(entry))
                    .filter((entry) => entry.trim().length > 0);
            };

            const resetHistoryNavigation = () => {
                historyIndex = null;
                draftBeforeHistory = null;
            };

            const moveCursorVertically = (direction: -1 | 1): boolean => {
                if (value.length === 0) return false;
                const width = this.getTransientFrameWidth();
                const layout = this.buildInputLayout(value, width, cursor);
                const targetRow = layout.cursorRow + direction;
                const maxRow = Math.max(0, this.buildInputLayout(value, width, value.length).lines.length - 1);
                if (targetRow < 0 || targetRow > maxRow) return false;
                cursor = this.findInputCursorAtVisualPosition(value, width, targetRow, layout.cursorCol);
                redraw();
                return true;
            };

            const navigateHistory = (direction: -1 | 1): boolean => {
                const entries = getHistoryEntries();
                if (entries.length === 0) return false;

                if (direction < 0) {
                    if (historyIndex === null) {
                        draftBeforeHistory = value;
                        historyIndex = entries.length - 1;
                    } else {
                        historyIndex = Math.max(0, historyIndex - 1);
                    }
                    value = entries[historyIndex] ?? "";
                    cursor = value.length;
                    selectedSuggestionIndex = 0;
                    redraw();
                    return true;
                }

                if (historyIndex === null) return false;
                if (historyIndex < entries.length - 1) {
                    historyIndex += 1;
                    value = entries[historyIndex] ?? "";
                } else {
                    value = draftBeforeHistory ?? "";
                    historyIndex = null;
                    draftBeforeHistory = null;
                }
                cursor = value.length;
                selectedSuggestionIndex = 0;
                redraw();
                return true;
            };

            const renderFrame = (): TransientFrame => {
                clampSuggestionIndex();
                return this.buildPromptFrame({
                    prompt,
                    showPromptText,
                    placeholder: options?.placeholder ?? prompt,
                    value,
                    cursor,
                    suggestions: getSuggestions(),
                    selectedSuggestionIndex,
                });
            };

            const redraw = () => {
                this.detachStreamingCursorForTransient();
                frame = this.bottomArea.renderTransient(frame, renderFrame());
            };

            const cleanup = (result?: string, error?: Error) => {
                if (!this.activeSessionCleanup) return;
                const teardown = this.activeSessionCleanup;
                this.activeSessionCleanup = null;
                this.activeSessionReject = null;
                this.activeSessionRedraw = null;
                this.clearActiveSessionRedrawTimer();
                this.deferActiveSessionRedraws = false;
                teardown();
                if (error) {
                    reject(error);
                    return;
                }
                resolve(result ?? "");
            };

            const submit = () => {
                const selected = getSuggestions()[selectedSuggestionIndex];
                cleanup(selected ? selected.name : value);
            };

            const insertText = (textToInsert: string, options?: { redraw?: boolean }) => {
                value = value.slice(0, cursor) + textToInsert + value.slice(cursor);
                cursor += textToInsert.length;
                selectedSuggestionIndex = 0;
                resetHistoryNavigation();
                if (options?.redraw !== false) redraw();
            };

            const insertPastedText = (textToInsert: string) => {
                const normalized = this.normalizeNewlines(textToInsert.replace(/\r(?!\n)/g, "\n"));
                if (normalized.length > 0) insertText(normalized);
            };

            const pasteClipboardImage = async () => {
                if (clipboardImagePasteInFlight) return;
                clipboardImagePasteInFlight = true;
                try {
                    const pasted = await pasteClipboardImageAsTempFile();
                    if (!pasted) return;
                    insertText(formatClipboardPathForPrompt(pasted.path));
                } finally {
                    clipboardImagePasteInFlight = false;
                }
            };

            const onKeypress = (text: string, key: Keypress) => {
                if (key.name === "escape") {
                    this.triggerEscape();
                    return;
                }
                if (key.name === "paste-start") {
                    bracketedPasteActive = true;
                    bracketedPasteBuffer = "";
                    return;
                }
                if (key.name === "paste-end") {
                    const pastedText = bracketedPasteBuffer;
                    bracketedPasteActive = false;
                    bracketedPasteBuffer = "";
                    insertPastedText(pastedText);
                    return;
                }
                if (bracketedPasteActive) {
                    bracketedPasteBuffer += typeof text === "string" ? text : key.sequence ?? "";
                    return;
                }
                if (key.ctrl && key.name === "c") {
                    const interruptError = new Error("Interrupted");
                    interruptError.name = "UserInterruptError";
                    cleanup(undefined, interruptError);
                    return;
                }
                if (key.ctrl && key.name === "v") {
                    void pasteClipboardImage();
                    return;
                }

                const suggestions = getSuggestions();
                const isShiftTab = (key.name === "tab" && key.shift) || key.sequence === "\u001b[Z";
                if (isShiftTab) {
                    options?.onCycleReasoningLevel?.();
                    redraw();
                    return;
                }
                if (key.meta && key.name === "up") {
                    const queuedText = this.queuedMessageEditHandler?.() ?? "";
                    if (queuedText.trim().length > 0) {
                        value = queuedText;
                        cursor = value.length;
                        selectedSuggestionIndex = 0;
                        resetHistoryNavigation();
                        redraw();
                    }
                    return;
                }
                if (key.name === "up") {
                    if (suggestions.length > 0) {
                        selectedSuggestionIndex = Math.max(0, selectedSuggestionIndex - 1);
                        redraw();
                        return;
                    }
                    if (moveCursorVertically(-1)) return;
                    navigateHistory(-1);
                    return;
                }
                if (key.name === "down") {
                    if (suggestions.length > 0) {
                        selectedSuggestionIndex = Math.min(suggestions.length - 1, selectedSuggestionIndex + 1);
                        redraw();
                        return;
                    }
                    if (moveCursorVertically(1)) return;
                    navigateHistory(1);
                    return;
                }
                if (key.name === "left") {
                    cursor = Math.max(0, cursor - 1);
                    redraw();
                    return;
                }
                if (key.name === "right") {
                    cursor = Math.min(value.length, cursor + 1);
                    redraw();
                    return;
                }
                if (key.name === "home") {
                    cursor = 0;
                    redraw();
                    return;
                }
                if (key.name === "end") {
                    cursor = value.length;
                    redraw();
                    return;
                }
                if (key.name === "backspace") {
                    if (cursor > 0) {
                        value = value.slice(0, cursor - 1) + value.slice(cursor);
                        cursor -= 1;
                        selectedSuggestionIndex = 0;
                        resetHistoryNavigation();
                        redraw();
                    }
                    return;
                }
                if (key.name === "delete") {
                    if (cursor < value.length) {
                        value = value.slice(0, cursor) + value.slice(cursor + 1);
                        selectedSuggestionIndex = 0;
                        resetHistoryNavigation();
                        redraw();
                    }
                    return;
                }
                if (key.name === "tab") {
                    const selected = suggestions[selectedSuggestionIndex];
                    if (selected) {
                        value = selected.name;
                        cursor = value.length;
                        selectedSuggestionIndex = 0;
                        resetHistoryNavigation();
                        redraw();
                    }
                    return;
                }
                if (key.name === "return" || key.name === "enter") {
                    submit();
                    return;
                }
                if (typeof text === "string" && text.length > 0 && !key.ctrl && !key.meta) {
                    insertText(text);
                }
            };

            this.activeSessionReject = (error) => cleanup(undefined, error);
            this.activeSessionRedraw = redraw;
            this.activeSessionCleanup = this.beginInputSession(onKeypress, () => {
                if (frame) {
                    this.bottomArea.clearTransient(frame);
                    frame = null;
                }
            });

            redraw();
        });
    }

    async choose<T = string>(prompt: string, options: ChoiceOption<T>[], initialValue?: T): Promise<T> {
        this.ensureUsable();
        this.clearBusy();
        this.ensureNoActiveSession();

        return new Promise((resolve, reject) => {
            let selectedIndex = Math.max(0, initialValue === undefined ? 0 : options.findIndex((option) => option.value === initialValue));
            if (selectedIndex < 0) selectedIndex = 0;
            let frame: TransientFrame | null = null;

            const renderFrame = (): TransientFrame => this.buildChoiceFrame(prompt, options, selectedIndex);
            const redraw = () => {
                this.detachStreamingCursorForTransient();
                frame = this.bottomArea.renderTransient(frame, renderFrame());
            };

            const cleanup = (result?: T, error?: Error) => {
                if (!this.activeSessionCleanup) return;
                const teardown = this.activeSessionCleanup;
                this.activeSessionCleanup = null;
                this.activeSessionReject = null;
                this.activeSessionRedraw = null;
                this.clearActiveSessionRedrawTimer();
                this.deferActiveSessionRedraws = false;
                teardown();
                if (error) {
                    reject(error);
                    return;
                }
                resolve(result as T);
            };

            const onKeypress = (_text: string, key: Keypress) => {
                if (key.name === "escape") {
                    this.triggerEscape();
                    return;
                }
                if (key.ctrl && key.name === "c") {
                    const interruptError = new Error("Interrupted");
                    interruptError.name = "UserInterruptError";
                    cleanup(undefined, interruptError);
                    return;
                }
                if (key.name === "up") {
                    selectedIndex = Math.max(0, selectedIndex - 1);
                    redraw();
                    return;
                }
                if (key.name === "down") {
                    selectedIndex = Math.min(options.length - 1, selectedIndex + 1);
                    redraw();
                    return;
                }
                if (key.name === "return" || key.name === "enter") {
                    cleanup(options[selectedIndex]?.value);
                }
            };

            this.activeSessionReject = (error) => cleanup(undefined, error);
            this.activeSessionRedraw = redraw;
            this.activeSessionCleanup = this.beginInputSession(onKeypress, () => {
                if (frame) {
                    this.bottomArea.clearTransient(frame);
                    frame = null;
                }
            });

            redraw();
        });
    }

    write(message: string): void {
        if (this.destroyed) return;
        const normalized = this.normalizeNewlines(message);
        if (normalized.trim().length === 0) return;
        this.retainHistoryBlock({ kind: "markdown", message: normalized });
        this.liveTailTrace = null;
        this.printDuringBusy(() => this.printBlock(this.renderMarkdownBlock(normalized), false));
    }

    writeWarning(message: string): void {
        if (this.destroyed) return;
        const normalized = this.normalizeNewlines(message);
        if (normalized.trim().length === 0) return;
        this.retainHistoryBlock({ kind: "warning", message: normalized });
        this.liveTailTrace = null;
        this.printDuringBusy(() => this.printBlock(this.renderWarningBlock(normalized), false));
    }

    writeError(message: string): void {
        if (this.destroyed) return;
        const normalized = this.normalizeNewlines(message);
        if (normalized.trim().length === 0) return;
        this.retainHistoryBlock({ kind: "error", message: normalized });
        this.liveTailTrace = null;
        this.printDuringBusy(() => this.printBlock(this.renderErrorBlock(normalized), false));
    }

    writeUser(message: string): void {
        if (this.destroyed) return;
        const normalized = this.normalizeNewlines(message);
        if (normalized.length === 0) return;
        this.retainHistoryBlock({ kind: "user", message: normalized });
        this.liveTailTrace = null;
        this.printDuringBusy(() => this.printBlock(this.renderUserBlock(normalized), false));
    }

    writeAssistant(message: string): void {
        if (this.destroyed) return;
        const normalized = this.normalizeNewlines(message);
        if (normalized.trim().length === 0) return;
        const blockId = this.startStreamingBlock("", "default");
        this.appendToStreamingBlock(blockId, normalized);
        this.finishStreamingBlock(blockId);
    }

    writeThinking(message: string): void {
        if (this.destroyed) return;
        const normalized = this.normalizeNewlines(message);
        if (normalized.trim().length === 0) return;
        this.retainHistoryBlock({ kind: "thinking", message: normalized });
        this.liveTailTrace = null;
        this.printDuringBusy(() => this.printBlock(this.renderThinkingBlock(normalized), false));
    }

    writeStartupCard(card: StartupCard): void {
        if (this.destroyed) return;
        this.retainHistoryBlock({ kind: "startup", card: this.cloneStartupCard(card) });
        this.liveTailTrace = null;
        const renderedImage = card.imagePath
            ? renderTerminalImage(card.imagePath, {
                widthCells: this.getStartupImageWidthCells(),
                heightCells: this.getStartupImageHeightCells(),
                widthPx: this.getStartupImageWidthPx(),
                heightPx: this.getStartupImageHeightPx(),
                name: card.imagePath.split(/[\\/]/).pop() ?? "perry-startup-image",
            })
            : null;
        if (!renderedImage && card.imagePath) openImageExternally(card.imagePath);
        const ansiPreview = !renderedImage ? readStartupAnsiPreview(card.ansiImagePath) : null;
        const renderedText = renderStartupCardBlock(card, ansiPreview, this.getOutputWidth(), this.formatter);

        this.printDuringBusy(() => {
            this.printBlock(renderedText, false);
            if (renderedImage) {
                this.beginBlock();
                this.writeStdout(`${renderedImage.data}\n`);
                this.finishBlock();
                return;
            }
        });
    }

    startStreamingBlock(label = "", variant: MessageVariant = "default"): string {
        const id = `stream-${this.nextStreamingBlockId++}`;
        const block: StreamingBlockState = {
            id,
            variant,
            rawText: "",
            emittedText: "",
            renderedText: "",
            started: false,
            styleOpen: false,
            endedWithNewline: false,
            printedRows: 0,
            appendColumn: 0,
            appendPendingSpace: false,
            rawAppendBuffer: "",
            cursorDetachedAfterRewrite: false,
            printedRawEndsWithNewline: true,
            appendOnly: false,
        };
        this.streamingBlocks.set(id, block);
        if (label) this.appendToStreamingBlock(id, label);
        return id;
    }

    appendToStreamingBlock(id: string, text: string): void {
        if (this.destroyed) return;
        const block = this.streamingBlocks.get(id);
        if (!block) return;

        const previousRawText = block.rawText;
        block.rawText = mergeStreamingText(previousRawText, this.normalizeNewlines(text));
        if (!block.started) {
            block.rawText = block.rawText.replace(/^\s+/, "");
            if (block.rawText.trim().length === 0) {
                block.emittedText = block.rawText;
                return;
            }
        }
        const displayRawText = getStreamingDisplayText(block.rawText, block.variant);
        const delta = getStreamingDelta(block.emittedText, displayRawText);
        if (!delta) return;
        if (!block.started && this.hasUnstableInlineMarkdown(displayRawText)) return;

        const rendered = this.renderStreamingBlock(block, displayRawText);
        const renderedRows = this.measureRenderedRows(rendered);
        const busyRows = this.bottomArea.busyGapRows;
        const transientRows = this.bottomArea.activeTransientRows;
        const canRewriteTail = block.started
            && !block.appendOnly
            && block.printedRows > 0
            // Rewriting a tail block that grows can push the previous rendered
            // prefix into terminal scrollback before we can erase it. That is the
            // source of the repeated progressively-longer assistant responses.
            // Only rewrite when the replacement fits in the rows already owned
            // by the live block; otherwise append raw deltas from here on.
            && renderedRows <= block.printedRows
            && block.printedRows + busyRows + transientRows < this.getTerminalHeight();

        const printInitial = () => {
            this.printBlock(rendered, false);
            block.started = true;
            block.endedWithNewline = true;
            block.printedRows = renderedRows;
            block.renderedText = rendered;
            block.emittedText = displayRawText;
            block.appendColumn = this.getRenderedTailColumn(rendered);
            block.appendPendingSpace = /[ \t]$/.test(displayRawText);
            block.rawAppendBuffer = "";
            block.cursorDetachedAfterRewrite = block.appendColumn > 0;
            block.printedRawEndsWithNewline = displayRawText.endsWith("\n");
            // Once any assistant/thinking content has been committed to normal
            // terminal scrollback, never rewrite it again. Appending deltas is
            // less fancy than live reflow, but it is the only robust way to
            // guarantee old prefixes cannot be stranded in scrollback.
            block.appendOnly = true;
        };
        const rewrite = () => {
            this.rewriteCurrentTailBlock(rendered, false, block.printedRows + busyRows);
            block.started = true;
            block.endedWithNewline = true;
            block.printedRows = renderedRows;
            block.renderedText = rendered;
            block.emittedText = displayRawText;
            block.appendColumn = this.getRenderedTailColumn(rendered);
            block.appendPendingSpace = /[ \t]$/.test(displayRawText);
            block.rawAppendBuffer = "";
            block.cursorDetachedAfterRewrite = block.appendColumn > 0;
            block.printedRawEndsWithNewline = displayRawText.endsWith("\n");
        };
        const append = (hiddenBusyGapRows: number): boolean => {
            const wroteToTerminal = this.writeStreamingRawDelta(block, delta, hiddenBusyGapRows);
            block.started = true;
            block.appendOnly = true;
            block.emittedText = displayRawText;
            block.printedRows = renderedRows;
            block.renderedText = rendered;
            return wroteToTerminal;
        };

        this.printDuringBusy((hiddenBusyGapRows) => {
            if (!block.started) {
                printInitial();
                return true;
            }
            if (canRewriteTail) {
                rewrite();
                return true;
            }
            return append(hiddenBusyGapRows);
        });
    }

    finishStreamingBlock(id: string, options?: { retain?: boolean }): void {
        const block = this.streamingBlocks.get(id);
        if (!block) return;
        const hadBusyLine = this.bottomArea.isBusyVisible && !this.activeSessionCleanup && this.bottomArea.isBusyLineVisible;
        this.batchStdout(() => {
            this.bottomArea.withHiddenTransient(() => {
                const hiddenBusyGapRows = hadBusyLine ? this.bottomArea.hideBusyLine() : 0;
                if (block.rawText.startsWith(block.emittedText) && block.emittedText.length < block.rawText.length) {
                    block.rawAppendBuffer += block.rawText.slice(block.emittedText.length);
                    block.emittedText = block.rawText;
                }
                if (block.rawAppendBuffer.length > 0) {
                    this.flushRawAppendBuffer(block, true, hiddenBusyGapRows);
                }
                if (block.styleOpen) {
                    this.writeStdout(this.resetAnsi());
                    block.styleOpen = false;
                }
                if (block.started && !block.endedWithNewline) {
                    this.writeStdout("\n");
                }
                if (block.started) this.finishBlock();
            }, { restore: false });
            if (options?.retain !== false) {
                this.retainFinishedStreamingBlock(block);
            }
            this.streamingBlocks.delete(id);
            if (this.activeSessionCleanup && this.streamingBlocks.size === 0) {
                this.requestActiveSessionRedraw({ immediate: true });
            }
        });
        if (this.bottomArea.isBusyVisible && !this.activeSessionCleanup) {
            if (hadBusyLine) this.needsBlockSeparator = false;
            this.bottomArea.restoreBusyLine();
        } else if (this.streamingBlocks.size === 0) this.writeStdout("\u001b[?25h");
    }

    showToolCall(id: string, toolName: string, args?: unknown, status: ToolTraceStatus = "pending", output = "", details?: unknown): void {
        const existing = this.toolTraces.get(id);
        const trace = this.createToolTraceSnapshot(id, toolName, {
            args: args ?? existing?.args,
            argsText: existing?.argsText,
            output: existing?.output || this.normalizeNewlines(output),
            status,
            details: this.getKnownToolTraceDetails(details) ?? existing?.details,
            expanded: existing?.expanded ?? false,
            displayId: existing?.displayId,
            startedAt: existing?.startedAt,
            finishedAt: existing?.finishedAt,
        });
        this.storeToolTrace(trace);

        if (this.shouldDisplayToolTrace(trace, existing)) {
            this.commitToolTrace(trace);
        }
        this.updateToolElapsedTimer();
    }

    showToolCallArguments(id: string, toolName: string, argsText: string, args?: unknown): void {
        const existing = this.toolTraces.get(id);
        const trace = this.createToolTraceSnapshot(id, existing?.toolName ?? toolName, {
            args: args ?? existing?.args,
            argsText: this.normalizeNewlines(argsText),
            output: existing?.output ?? "",
            status: existing?.status ?? "pending",
            details: existing?.details,
            expanded: existing?.expanded ?? false,
            displayId: existing?.displayId,
            startedAt: existing?.startedAt,
            finishedAt: existing?.finishedAt,
        });
        this.storeToolTrace(trace);
        if (this.toolPrinted.has(id)) this.commitToolTrace(trace, { appendIfStale: false });
        this.updateToolElapsedTimer();
    }

    updateToolCallArguments(id: string, argsText: string, args?: unknown): void {
        const existing = this.toolTraces.get(id);
        if (!existing) return;
        const trace = { ...existing, args: args ?? existing.args, argsText: this.normalizeNewlines(argsText) };
        this.storeToolTrace(trace);
        if (this.toolPrinted.has(id)) this.commitToolTrace(trace, { appendIfStale: false });
        this.updateToolElapsedTimer();
    }

    startToolExecution(id: string): void {
        const existing = this.toolTraces.get(id);
        if (!existing) return;
        const trace = { ...existing, status: "running" as ToolTraceStatus, startedAt: existing.startedAt ?? Date.now() };
        this.storeToolTrace(trace);
        if (this.shouldDisplayToolTrace(trace, existing)) this.commitToolTrace(trace);
        this.updateToolElapsedTimer();
    }

    updateToolExecution(id: string, output: string, isError = false, details?: unknown): void {
        const existing = this.toolTraces.get(id);
        if (!existing) return;
        const normalizedOutput = this.normalizeNewlines(output);
        const trace = {
            ...existing,
            output: normalizedOutput,
            status: isError ? "error" as ToolTraceStatus : "running" as ToolTraceStatus,
            details: this.getKnownToolTraceDetails(details) ?? existing.details,
            startedAt: existing.startedAt ?? Date.now(),
        };
        this.storeToolTrace(trace);

        this.toolLastOutput.set(id, normalizedOutput);
        this.commitToolTrace(trace, { appendIfStale: false });
        this.updateToolElapsedTimer();
    }

    finishToolExecution(id: string, output: string, isError = false, details?: unknown): void {
        const existing = this.toolTraces.get(id);
        if (!existing) return;
        const normalizedOutput = this.normalizeNewlines(output);
        const trace = {
            ...existing,
            output: normalizedOutput,
            status: isError ? "error" as ToolTraceStatus : "complete" as ToolTraceStatus,
            details: this.getKnownToolTraceDetails(details) ?? existing.details,
            startedAt: existing.startedAt,
            finishedAt: Date.now(),
        };
        this.storeToolTrace(trace);
        this.toolLastOutput.set(id, normalizedOutput);
        this.commitToolTrace(trace, { appendIfStale: false });
        this.notifyToolTraceFinished(trace);
        this.updateToolElapsedTimer();
    }

    restoreToolTrace(trace: PersistableToolTrace): void {
        if (this.destroyed) return;
        if (this.toolTraces.has(trace.id)) return;
        const restored = this.createToolTraceSnapshot(trace.id, trace.toolName, {
            displayId: trace.displayId,
            args: trace.args,
            argsText: trace.argsText,
            output: this.normalizeNewlines(trace.output ?? ""),
            status: trace.status,
            details: this.getKnownToolTraceDetails(trace.details),
            expanded: trace.expanded ?? false,
            startedAt: trace.startedAt,
            finishedAt: trace.finishedAt,
        });
        this.storeToolTrace(restored);
        this.commitToolTrace(restored, { appendIfStale: true });
        this.updateToolElapsedTimer();
    }

    onToolTraceFinished(listener: (trace: PersistableToolTrace) => void): () => void {
        this.toolTraceFinishedListeners.add(listener);
        return () => this.toolTraceFinishedListeners.delete(listener);
    }

    onEscape(listener: () => void): () => void {
        this.attachGlobalEscapeHandler();
        this.escapeListeners.add(listener);
        return () => this.escapeListeners.delete(listener);
    }

    expandTrace(reference: string): boolean {
        const trimmed = reference.trim();
        if (!trimmed) return false;
        const id = Number.isFinite(Number(trimmed)) ? this.toolTraceDisplayIds.get(Number(trimmed)) : trimmed;
        if (!id) return false;
        const trace = this.toolTraces.get(id);
        if (!trace) return false;
        const expanded = { ...trace, expanded: true };
        this.storeToolTrace(expanded);
        this.commitToolTrace(expanded, { forceNewBlock: true });
        this.updateToolElapsedTimer();
        return true;
    }

    refreshHistory(): void {
        this.redrawRetainedHistoryForResize();
    }

    setStatus(message: string): void {
        this.statusMessage = message;
    }

    setReasoningLevel(level: string): void {
        this.currentReasoningLevel = level;
        this.requestActiveSessionRedraw({ immediate: true });
    }

    setSessionDetails(lines: SessionDetailLine[]): void {
        this.sessionDetails = lines;
        this.requestActiveSessionRedraw({ immediate: true });
    }

    setBusy(message = "Working"): void {
        if (this.destroyed) return;
        this.bottomArea.setBusy(message);
    }

    setQueuedSteeringMessages(messages: string[]): void {
        this.queuedSteeringMessages = messages.map((message) => this.normalizeNewlines(message).trim()).filter(Boolean);
        this.requestActiveSessionRedraw({ immediate: true });
    }

    setQueuedMessageEditHandler(handler: (() => string) | null): void {
        this.queuedMessageEditHandler = handler;
    }

    clearBusy(options?: { showWorkedLine?: boolean }): void {
        this.clearBusyInternal({ showWorkedLine: options?.showWorkedLine !== false });
    }

    cancelActiveInput(): void {
        if (!this.activeSessionReject) return;
        const abortError = new Error("Input cancelled.");
        abortError.name = "AbortError";
        this.activeSessionReject(abortError);
    }

    triggerEscape(): void {
        if (this.destroyed) return;
        const now = Date.now();
        if (now - this.lastEscapeTriggeredAt < 50) return;
        this.lastEscapeTriggeredAt = now;
        for (const listener of [...this.escapeListeners]) {
            listener();
        }
        const abortError = new Error("Process terminated.");
        abortError.name = "AbortError";
        this.activeSessionReject?.(abortError);
    }

    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.clearBusyInternal({ showWorkedLine: false });
        if (this.activeSessionReject) {
            const reject = this.activeSessionReject;
            this.activeSessionReject = null;
            reject(new Error("UI closed."));
        }
        this.clearActiveSessionRedrawTimer();
        this.clearResizeRedrawTimer();
        this.detachResizeHandler();
        this.escapeListeners.clear();
        this.stopToolElapsedTimer();
        this.deferActiveSessionRedraws = false;
        if (this.activeSessionCleanup) {
            const cleanup = this.activeSessionCleanup;
            this.activeSessionCleanup = null;
            cleanup();
        }
        this.detachGlobalEscapeHandler();
        this.bottomArea.destroy();
    }

    private createToolTraceSnapshot(id: string, toolName: string, data: {
        displayId?: number;
        args?: unknown;
        argsText?: string;
        output: string;
        status: ToolTraceStatus;
        details?: KnownToolTraceDetails;
        expanded: boolean;
        startedAt?: number;
        finishedAt?: number;
    }): ToolHistorySnapshot {
        return {
            id,
            displayId: data.displayId ?? this.nextToolDisplayId++,
            toolName,
            args: data.args,
            argsText: data.argsText,
            output: data.output,
            status: data.status,
            details: data.details,
            expanded: data.expanded,
            startedAt: data.startedAt,
            finishedAt: data.finishedAt,
        };
    }

    private storeToolTrace(trace: ToolHistorySnapshot): void {
        this.toolTraces.set(trace.id, trace);
        this.toolTraceDisplayIds.set(trace.displayId, trace.id);
        this.nextToolDisplayId = Math.max(this.nextToolDisplayId, trace.displayId + 1);
    }

    private notifyToolTraceFinished(trace: ToolHistorySnapshot): void {
        if (this.toolTraceFinishedListeners.size === 0) return;
        const snapshot: PersistableToolTrace = {
            id: trace.id,
            displayId: trace.displayId,
            toolName: trace.toolName,
            args: trace.args,
            argsText: trace.argsText,
            output: trace.output,
            status: trace.status,
            details: trace.details,
            expanded: trace.expanded,
            startedAt: trace.startedAt,
            finishedAt: trace.finishedAt,
        };
        for (const listener of this.toolTraceFinishedListeners) listener(snapshot);
    }

    private shouldDisplayToolTrace(trace: ToolHistorySnapshot, existing?: ToolHistorySnapshot): boolean {
        if (this.toolPrinted.has(trace.id)) return true;
        const isQuietFileTrace = (this.isReadTrace(trace) || this.isWriteTrace(trace) || this.isEditTrace(trace))
            && !trace.details
            && trace.output.trim().length === 0;
        if (isQuietFileTrace) return false;
        if (!existing && trace.status !== "pending") return true;
        if (!existing && !!trace.details) return true;
        if (!existing && trace.output.trim().length > 0) return true;
        return false;
    }

    private commitToolTrace(trace: ToolHistorySnapshot, options?: { forceNewBlock?: boolean; appendIfStale?: boolean }): boolean {
        const rendered = this.renderToolTrace(trace);
        const renderedRows = this.measureRenderedRows(rendered);
        const alreadyPrinted = this.toolPrinted.has(trace.id);
        const forceNewBlock = options?.forceNewBlock === true;
        const appendIfStale = options?.appendIfStale === true;
        const busyGapRows = this.bottomArea.busyGapRows;
        const transientRows = this.bottomArea.activeTransientRows;
        const availableRows = this.getTerminalHeight() - busyGapRows - transientRows;
        const canRewriteTail = !forceNewBlock
            && alreadyPrinted
            && this.liveTailTrace?.id === trace.id
            && this.liveTailTrace.rows < availableRows
            && renderedRows < availableRows;

        if (canRewriteTail) {
            const rowsUp = (this.liveTailTrace?.rows ?? 0) + busyGapRows;
            this.retainToolHistoryBlock(trace, { append: false });
            this.printDuringBusy(() => {
                this.rewriteCurrentTailBlock(rendered, false, rowsUp);
                this.liveTailTrace = { id: trace.id, rows: renderedRows, rendered };
                this.toolPrinted.add(trace.id);
            });
            return true;
        }

        if (!alreadyPrinted || forceNewBlock || appendIfStale) {
            this.retainToolHistoryBlock(trace, { append: forceNewBlock || appendIfStale });
            this.printDuringBusy(() => {
                this.printBlock(rendered, false);
                this.liveTailTrace = { id: trace.id, rows: renderedRows, rendered };
                this.toolPrinted.add(trace.id);
            });
            return true;
        }

        return false;
    }

    private updateToolElapsedTimer(): void {
        if ([...this.toolTraces.values()].some((trace) => trace.status === "running" && this.toolPrinted.has(trace.id))) {
            this.startToolElapsedTimer();
            return;
        }
        this.stopToolElapsedTimer();
    }

    private startToolElapsedTimer(): void {
        if (this.toolElapsedTimer) return;
        this.toolElapsedTimer = setInterval(() => this.refreshRunningToolElapsed(), TOOL_ELAPSED_REDRAW_INTERVAL_MS);
        this.toolElapsedTimer.unref?.();
    }

    private stopToolElapsedTimer(): void {
        if (!this.toolElapsedTimer) return;
        clearInterval(this.toolElapsedTimer);
        this.toolElapsedTimer = null;
    }

    private refreshRunningToolElapsed(): void {
        if (this.destroyed) return;
        const tailId = this.liveTailTrace?.id;
        const trace = tailId ? this.toolTraces.get(tailId) : undefined;
        if (trace?.status === "running" && this.toolPrinted.has(trace.id)) {
            this.commitToolTrace(trace, { appendIfStale: false });
        }
        this.updateToolElapsedTimer();
    }

    private clearBusyInternal(options: { showWorkedLine: boolean }): void {
        const elapsedMs = this.bottomArea.clearBusy();
        if (options.showWorkedLine && elapsedMs !== null) this.printWorkedLine(elapsedMs);
        if (this.streamingBlocks.size === 0) this.writeStdout("\u001b[?25h");
    }

    private printWorkedLine(elapsedMs: number): void {
        this.retainHistoryBlock({ kind: "worked", elapsedMs });
        const rendered = this.renderWorkedLine(elapsedMs);
        this.printDuringBusy(() => this.printBlock(rendered, false));
    }

    private renderWorkedLine(elapsedMs: number): string {
        const width = this.getOutputWidth();
        const label = ` Worked for ${this.formatWorkedDuration(elapsedMs)} `;
        const prefix = `─${label}`;
        const remaining = Math.max(0, width - this.getVisibleTextWidth(prefix));
        const line = remaining > 0 ? `${prefix}${"─".repeat(remaining)}` : this.fitToWidth(prefix, width);
        return this.styleAnsi(line, { fg: "#a3a3a3", dim: true });
    }

    private formatWorkedDuration(elapsedMs: number): string {
        const totalSeconds = Math.max(0, Math.round(elapsedMs / 1000));
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
        if (minutes > 0) return `${minutes}m ${seconds}s`;
        return `${seconds}s`;
    }

    private printDuringBusy(operation: (hiddenBusyGapRows: number) => boolean | void): void {
        const hasActiveInput = this.activeSessionCleanup !== null;
        const previousDeferInputRedraw = this.deferActiveSessionRedraws;
        this.deferActiveSessionRedraws = hasActiveInput || previousDeferInputRedraw;
        try {
            this.batchStdout(() => {
                this.bottomArea.withHiddenTransient(() => {
                    if (this.bottomArea.isBusyVisible && !this.activeSessionCleanup) {
                        this.bottomArea.withHiddenBusyLine(operation);
                        return;
                    }
                    operation(0);
                }, { restore: false });
                if (hasActiveInput) this.requestActiveSessionRedraw({ immediate: true });
            });
        } finally {
            this.deferActiveSessionRedraws = previousDeferInputRedraw;
        }
    }

    private requestActiveSessionRedraw(options?: { immediate?: boolean; deferred?: boolean }): void {
        if (!this.activeSessionRedraw) return;
        const shouldDefer = options?.deferred === true || this.deferActiveSessionRedraws;
        if (options?.immediate || !shouldDefer) {
            this.clearActiveSessionRedrawTimer();
            this.redrawActiveSession();
            return;
        }
        if (this.activeSessionRedrawTimer) clearTimeout(this.activeSessionRedrawTimer);
        this.activeSessionRedrawTimer = setTimeout(() => {
            this.activeSessionRedrawTimer = null;
            this.redrawActiveSession();
        }, STREAM_INPUT_REDRAW_DEBOUNCE_MS);
    }

    private redrawActiveSession(): void {
        this.activeSessionRedraw?.();
    }

    private detachStreamingCursorForTransient(): void {
        const blocks = [...this.streamingBlocks.values()];
        for (let index = blocks.length - 1; index >= 0; index -= 1) {
            const block = blocks[index];
            if (!block || !block.started || block.endedWithNewline || block.appendColumn <= 0) continue;
            this.writeStdout("\n");
            block.cursorDetachedAfterRewrite = true;
            block.endedWithNewline = true;
            return;
        }
    }

    private clearActiveSessionRedrawTimer(): void {
        if (!this.activeSessionRedrawTimer) return;
        clearTimeout(this.activeSessionRedrawTimer);
        this.activeSessionRedrawTimer = null;
    }

    private scheduleResizeRedraw(): void {
        if (this.destroyed) return;
        const currentSize = this.readTerminalSize();
        if (!currentSize || this.isSameTerminalSize(currentSize, this.lastKnownTerminalSize)) return;
        if (this.resizeRedrawTimer) clearTimeout(this.resizeRedrawTimer);
        this.resizeRedrawTimer = setTimeout(() => {
            this.resizeRedrawTimer = null;
            const previousSize = this.lastKnownTerminalSize;
            const settledSize = this.readTerminalSize();
            if (!settledSize || this.isSameTerminalSize(settledSize, previousSize)) return;
            const widthChanged = !previousSize || settledSize.columns !== previousSize.columns;
            this.lastKnownTerminalSize = settledSize;
            if (widthChanged) {
                this.redrawRetainedHistoryForResize({ knownSize: settledSize });
                return;
            }
            this.refreshLiveTailAfterTerminalResize();
        }, RESIZE_SETTLE_DELAY_MS);
    }

    private refreshLiveTailAfterTerminalResize(): void {
        if (this.liveTailTrace) {
            this.liveTailTrace = {
                ...this.liveTailTrace,
                rows: this.measureRenderedRows(this.liveTailTrace.rendered),
            };
        }
        if (this.activeSessionCleanup) {
            this.requestActiveSessionRedraw({ immediate: true });
            return;
        }
        if (this.bottomArea.isBusyVisible) {
            this.bottomArea.restoreBusyLine();
            return;
        }
        this.writeStdout("\u001b[?25h");
    }

    private clearResizeRedrawTimer(): void {
        if (!this.resizeRedrawTimer) return;
        clearTimeout(this.resizeRedrawTimer);
        this.resizeRedrawTimer = null;
    }

    private printBlock(text: string, indent: boolean): void {
        this.liveTailTrace = null;
        this.beginBlock();
        this.writeStdout(`${this.layoutPrintedBlockLines(text, indent).join("\n")}\n`);
        this.finishBlock();
    }

    private beginBlock(): void {
        if (this.needsBlockSeparator) this.writeStdout("\n");
        this.needsBlockSeparator = false;
    }

    private finishBlock(): void {
        this.needsBlockSeparator = true;
    }

    private rewriteCurrentTailBlock(text: string, indent: boolean, rowsUp: number): void {
        this.liveTailTrace = null;
        this.moveCursorUp(rowsUp);
        this.writeStdout("\r\u001b[J");
        this.writeStdout(`${this.layoutPrintedBlockLines(text, indent).join("\n")}\n`);
        this.needsBlockSeparator = true;
    }

    private retainHistoryBlock(block: RetainedHistoryBlock): void {
        if (this.replayingRetainedHistory) return;
        this.retainedHistory.push(this.cloneRetainedHistoryBlock(block));
    }

    private retainFinishedStreamingBlock(block: StreamingBlockState): void {
        if (this.replayingRetainedHistory) return;
        const text = this.normalizeNewlines(block.rawText);
        if (text.trim().length === 0) return;
        this.retainHistoryBlock({
            kind: block.variant === "thinking" ? "thinking" : "assistant",
            message: text,
        });
    }

    private retainToolHistoryBlock(trace: ToolHistorySnapshot, options: { append: boolean }): void {
        if (this.replayingRetainedHistory) return;
        const key = `tool:${trace.id}`;
        const block: RetainedHistoryBlock = {
            kind: "tool",
            key,
            trace: this.cloneToolTrace(trace),
        };
        if (options.append) {
            this.retainedHistory.push(block);
            return;
        }
        for (let index = this.retainedHistory.length - 1; index >= 0; index -= 1) {
            const existing = this.retainedHistory[index];
            if (existing?.kind === "tool" && existing.key === key) {
                this.retainedHistory[index] = block;
                return;
            }
        }
        this.retainedHistory.push(block);
    }

    private redrawRetainedHistoryForResize(options?: { knownSize?: TerminalSize }): void {
        if (this.destroyed || this.replayingRetainedHistory) return;
        const currentSize = options?.knownSize ?? this.readTerminalSize();
        if (currentSize) this.lastKnownTerminalSize = currentSize;
        this.batchStdout(() => {
            this.replayingRetainedHistory = true;
            try {
                this.writeStdout("\u001b[?25l\u001b[H\u001b[2J\u001b[3J");
                this.needsBlockSeparator = false;
                this.liveTailTrace = null;
                this.bottomArea.forgetRenderedState();
                for (const block of this.retainedHistory) this.replayRetainedHistoryBlock(block);
                this.replayLiveStreamingBlocksAfterResize();
            } finally {
                this.replayingRetainedHistory = false;
            }
            if (this.activeSessionCleanup) this.requestActiveSessionRedraw({ immediate: true });
            else if (this.bottomArea.isBusyVisible) this.bottomArea.restoreBusyLine();
            else this.writeStdout("\u001b[?25h");
        });
    }

    private replayRetainedHistoryBlock(block: RetainedHistoryBlock): void {
        switch (block.kind) {
            case "markdown":
                this.printBlock(this.renderMarkdownBlock(block.message), false);
                return;
            case "warning":
                this.printBlock(this.renderWarningBlock(block.message), false);
                return;
            case "error":
                this.printBlock(this.renderErrorBlock(block.message), false);
                return;
            case "user":
                this.printBlock(this.renderUserBlock(block.message), false);
                return;
            case "assistant":
                this.printBlock(this.renderMarkdownBlock(block.message), false);
                return;
            case "thinking":
                this.printBlock(this.renderThinkingBlock(block.message), false);
                return;
            case "startup": {
                const renderedImage = block.card.imagePath
                    ? renderTerminalImage(block.card.imagePath, {
                        widthCells: this.getStartupImageWidthCells(),
                        heightCells: this.getStartupImageHeightCells(),
                        widthPx: this.getStartupImageWidthPx(),
                        heightPx: this.getStartupImageHeightPx(),
                        name: block.card.imagePath.split(/[\\/]/).pop() ?? "perry-startup-image",
                    })
                    : null;
                const ansiPreview = !renderedImage ? readStartupAnsiPreview(block.card.ansiImagePath) : null;
                this.printBlock(renderStartupCardBlock(block.card, ansiPreview, this.getOutputWidth(), this.formatter), false);
                if (renderedImage) {
                    this.beginBlock();
                    this.writeStdout(`${renderedImage.data}\n`);
                    this.finishBlock();
                }
                return;
            }
            case "worked":
                this.printBlock(this.renderWorkedLine(block.elapsedMs), false);
                return;
            case "tool": {
                const rendered = this.renderToolTrace(block.trace);
                this.printBlock(rendered, false);
                this.liveTailTrace = {
                    id: block.trace.id,
                    rows: this.measureRenderedRows(rendered),
                    rendered,
                };
                this.toolPrinted.add(block.trace.id);
                return;
            }
        }
    }

    private replayLiveStreamingBlocksAfterResize(): void {
        for (const block of this.streamingBlocks.values()) {
            const displayText = getStreamingDisplayText(block.rawText, block.variant);
            if (displayText.trim().length === 0) continue;
            const rendered = this.renderStreamingBlock(block, displayText);
            const rows = this.measureRenderedRows(rendered);
            this.printBlock(rendered, false);
            block.started = true;
            block.endedWithNewline = true;
            block.printedRows = rows;
            block.renderedText = rendered;
            block.emittedText = displayText;
            block.appendColumn = this.getRenderedTailColumn(rendered);
            block.appendPendingSpace = /[ \t]$/.test(displayText);
            block.rawAppendBuffer = "";
            block.cursorDetachedAfterRewrite = block.appendColumn > 0;
            block.printedRawEndsWithNewline = displayText.endsWith("\n");
            block.appendOnly = true;
        }
    }

    private cloneRetainedHistoryBlock(block: RetainedHistoryBlock): RetainedHistoryBlock {
        if (block.kind === "startup") return { kind: "startup", card: this.cloneStartupCard(block.card) };
        if (block.kind === "tool") return { kind: "tool", key: block.key, trace: this.cloneToolTrace(block.trace) };
        return { ...block };
    }

    private cloneStartupCard(card: StartupCard): StartupCard {
        return {
            ...card,
            lines: card.lines.map((line) => ({ ...line })),
        };
    }

    private cloneToolTrace(trace: ToolHistorySnapshot): ToolHistorySnapshot {
        return {
            ...trace,
            details: trace.details ? { ...trace.details } : undefined,
        };
    }

    private writeStreamingRawDelta(block: StreamingBlockState, delta: string, hiddenBusyGapRows = 0): boolean {
        this.liveTailTrace = null;
        if (!block.started) {
            this.beginBlock();
            this.writeStdout("\u001b[?25l");
            block.started = true;
        }

        let nextDelta = delta;
        if (block.cursorDetachedAfterRewrite && block.rawAppendBuffer.length === 0 && nextDelta.startsWith("\n")) {
            // printBlock()/rewriteCurrentTailBlock() already placed the cursor on
            // the next terminal row. If the next raw delta is a newline, consume
            // one newline so terminal position and raw stream position agree.
            nextDelta = nextDelta.slice(1);
            block.cursorDetachedAfterRewrite = false;
            block.appendColumn = 0;
            block.endedWithNewline = true;
            block.printedRawEndsWithNewline = true;
        }

        if (block.appendPendingSpace && nextDelta.length > 0) {
            if (!/^\s/.test(nextDelta)) nextDelta = ` ${nextDelta}`;
            block.appendPendingSpace = false;
        }

        block.rawAppendBuffer += nextDelta;
        return this.flushRawAppendBuffer(block, false, hiddenBusyGapRows);
    }

    private reattachStreamingCursorIfNeeded(block: StreamingBlockState): void {
        if (block.appendColumn <= 0) return;
        this.writeStdout("\u001b[1A\r");
        if (block.appendColumn > 0) this.writeStdout(`\u001b[${block.appendColumn}C`);
        block.cursorDetachedAfterRewrite = false;
        block.endedWithNewline = false;
    }

    private flushRawAppendBuffer(block: StreamingBlockState, force: boolean, hiddenBusyGapRows = 0): boolean {
        let wroteToTerminal = false;
        let pendingHiddenBusyGapRows = hiddenBusyGapRows;
        while (!force) {
            const boundary = this.findStableMarkdownBoundary(block.rawAppendBuffer);
            if (boundary < 0) break;
            const chunk = block.rawAppendBuffer.slice(0, boundary);
            if (this.hasUnstableInlineMarkdown(chunk)) break;
            block.rawAppendBuffer = block.rawAppendBuffer.slice(boundary);
            wroteToTerminal = this.writeRenderedMarkdownChunk(block, chunk, true, pendingHiddenBusyGapRows) || wroteToTerminal;
            pendingHiddenBusyGapRows = 0;
        }

        if (!force && block.rawAppendBuffer.length > 0) {
            const boundary = this.findImmediateStreamingBoundary(block.rawAppendBuffer);
            if (boundary > 0) {
                const chunk = block.rawAppendBuffer.slice(0, boundary);
                block.rawAppendBuffer = block.rawAppendBuffer.slice(boundary);
                wroteToTerminal = this.writeRenderedMarkdownChunk(block, chunk, false, pendingHiddenBusyGapRows) || wroteToTerminal;
                pendingHiddenBusyGapRows = 0;
            }
        }

        if (force && block.rawAppendBuffer.length > 0) {
            const chunk = block.rawAppendBuffer;
            block.rawAppendBuffer = "";
            wroteToTerminal = this.writeRenderedMarkdownChunk(block, chunk, false, pendingHiddenBusyGapRows) || wroteToTerminal;
        }
        return wroteToTerminal;
    }

    private findStableMarkdownBoundary(text: string): number {
        let inFence = false;
        let lineStart = 0;
        for (let index = 0; index < text.length; index += 1) {
            if (text[index] !== "\n") continue;
            const line = text.slice(lineStart, index);
            if (/^\s*```/.test(line)) inFence = !inFence;
            if (!inFence && text[index + 1] === "\n") return index + 2;
            lineStart = index + 1;
        }
        return -1;
    }

    private findImmediateStreamingBoundary(text: string): number {
        if (text.length === 0) return -1;
        if (text.startsWith("\n")) {
            const firstNonNewline = text.search(/[^\n]/);
            return firstNonNewline < 0 ? text.length : firstNonNewline;
        }
        const lineEnd = text.indexOf("\n");
        const candidate = lineEnd >= 0 ? text.slice(0, lineEnd) : text;
        const trailingWhitespaceLength = candidate.match(/[ \t]+$/)?.[0].length ?? 0;
        const boundary = candidate.length - trailingWhitespaceLength;
        if (boundary <= 0) return -1;
        return this.hasUnstableInlineMarkdown(text.slice(0, boundary)) ? -1 : boundary;
    }

    private hasUnstableInlineMarkdown(text: string): boolean {
        let inlineCodeFence: string | null = null;
        let strong = false;
        let emphasis = false;
        let strike = false;
        let highlight = false;
        let unmatchedLinkOpen = false;
        let pendingLinkDestination = false;

        for (let index = 0; index < text.length;) {
            const char = text[index] ?? "";
            if (char === "\\") {
                index += 2;
                continue;
            }

            if (char === "`") {
                const tickRun = text.slice(index).match(/^`+/)?.[0] ?? "`";
                if (inlineCodeFence === tickRun) inlineCodeFence = null;
                else if (!inlineCodeFence) inlineCodeFence = tickRun;
                index += tickRun.length;
                continue;
            }
            if (inlineCodeFence) {
                index += 1;
                continue;
            }

            if (char === "[") {
                unmatchedLinkOpen = true;
                index += 1;
                continue;
            }
            if (char === "]" && unmatchedLinkOpen) {
                unmatchedLinkOpen = false;
                if (text[index + 1] === "(") {
                    pendingLinkDestination = true;
                    index += 2;
                    continue;
                }
                index += 1;
                continue;
            }
            if (char === ")" && pendingLinkDestination) {
                pendingLinkDestination = false;
                index += 1;
                continue;
            }

            if (text.startsWith("~~", index)) {
                strike = !strike;
                index += 2;
                continue;
            }
            if (text.startsWith("==", index)) {
                highlight = !highlight;
                index += 2;
                continue;
            }
            if (text.startsWith("***", index)) {
                strong = !strong;
                emphasis = !emphasis;
                index += 3;
                continue;
            }
            if (text.startsWith("**", index)) {
                strong = !strong;
                index += 2;
                continue;
            }
            if (char === "*" && text[index - 1] !== "*" && text[index + 1] !== "*" && /\S/.test(text[index + 1] ?? "")) {
                emphasis = !emphasis;
                index += 1;
                continue;
            }
            if (char === "_" && text[index - 1] !== "_" && text[index + 1] !== "_" && /\S/.test(text[index + 1] ?? "") && !/[A-Za-z0-9_]/.test(text[index - 1] ?? "")) {
                emphasis = !emphasis;
                index += 1;
                continue;
            }

            index += 1;
        }

        return inlineCodeFence !== null || strong || emphasis || strike || highlight || unmatchedLinkOpen || pendingLinkDestination;
    }

    private writeRenderedMarkdownChunk(block: StreamingBlockState, rawChunk: string, preserveBoundarySpacing: boolean, hiddenBusyGapRows = 0): boolean {
        if (rawChunk.length === 0) return false;
        if (hiddenBusyGapRows > 0) this.moveCursorUp(hiddenBusyGapRows);
        let wroteToTerminal = hiddenBusyGapRows > 0;
        const startsNewMarkdownBlock = /^\s*(?:```|#{1,6}\s|[-*+]\s|\d+\.\s|>\s?|\|)/.test(rawChunk);
        const shouldReattach = !startsNewMarkdownBlock
            && !rawChunk.startsWith("\n")
            && block.appendColumn > 0
            && block.cursorDetachedAfterRewrite;
        const leadingContinuationSpace = !startsNewMarkdownBlock && block.appendColumn > 0 && /^[ \t]/.test(rawChunk);
        if (shouldReattach) this.reattachStreamingCursorIfNeeded(block);
        else if (block.appendColumn > 0 && startsNewMarkdownBlock) {
            this.writeStdout("\n");
            block.appendColumn = 0;
            block.cursorDetachedAfterRewrite = false;
            block.printedRawEndsWithNewline = true;
        } else if (block.cursorDetachedAfterRewrite) {
            block.cursorDetachedAfterRewrite = false;
            block.appendColumn = 0;
        }

        const rendered = block.variant === "thinking"
            ? this.renderThinkingBlock(rawChunk)
            : this.renderMarkdownBlock(rawChunk);
        if (rendered.length > 0) {
            this.writeWrappedRenderedText(block, leadingContinuationSpace ? ` ${rendered}` : rendered);
            wroteToTerminal = true;
            block.endedWithNewline = false;
        }
        block.printedRawEndsWithNewline = rawChunk.endsWith("\n");

        if (preserveBoundarySpacing) {
            this.writeStdout("\n\n");
            wroteToTerminal = true;
            block.appendColumn = 0;
            block.cursorDetachedAfterRewrite = false;
            block.endedWithNewline = true;
            block.printedRawEndsWithNewline = true;
        }
        return wroteToTerminal;
    }

    private writeWrappedRenderedText(block: StreamingBlockState, text: string): void {
        const width = this.getOutputWidth();
        const parts = text.split("\n");
        for (let index = 0; index < parts.length; index += 1) {
            let part = parts[index] ?? "";
            if (part.length > 0) {
                if (block.appendColumn >= width) {
                    this.writeStdout("\n");
                    block.appendColumn = 0;
                    block.cursorDetachedAfterRewrite = false;
                }

                if (block.appendColumn > 0 && /^[ \t]+\S/.test(part)) {
                    const remainingWidth = Math.max(1, width - block.appendColumn);
                    const leadingWhitespace = (part.match(/^[ \t]+/)?.[0] ?? "").replace(/\t/g, "    ");
                    const nextWord = this.stripAnsi(part.trimStart()).match(/^\S+/)?.[0] ?? "";
                    const continuationWidth = leadingWhitespace.length + nextWord.length;
                    if (continuationWidth > remainingWidth) {
                        this.writeStdout("\n");
                        block.appendColumn = 0;
                        block.cursorDetachedAfterRewrite = false;
                        part = part.trimStart();
                    }
                }

                const firstWidth = block.appendColumn > 0 ? Math.max(1, width - block.appendColumn) : width;
                const wrapped = this.wrapStyledLineWordsWithWidths(part, firstWidth, width);
                for (let wrappedIndex = 0; wrappedIndex < wrapped.length; wrappedIndex += 1) {
                    const segment = wrapped[wrappedIndex] ?? "";
                    if (wrappedIndex > 0) {
                        this.writeStdout("\n");
                        block.appendColumn = 0;
                        block.cursorDetachedAfterRewrite = false;
                    }
                    this.writeStdout(segment);
                    block.appendColumn += this.getVisibleTextWidth(segment);
                }
            }

            if (index < parts.length - 1) {
                this.writeStdout("\n");
                block.appendColumn = 0;
                block.cursorDetachedAfterRewrite = false;
            }
        }
    }

    private canSafelyShowBusyLine(): boolean {
        for (const block of this.streamingBlocks.values()) {
            if (block.started && !block.endedWithNewline) return false;
        }
        return true;
    }

    private beginInputSession(onKeypress: (text: string, key: Keypress) => void, onCleanup: () => void): () => void {
        emitKeypressEvents(process.stdin);
        const stdin = process.stdin;
        const wasRaw = stdin.isTTY ? !!stdin.isRaw : false;
        const wasPaused = typeof stdin.isPaused === "function" ? stdin.isPaused() : false;
        if (stdin.isTTY) stdin.setRawMode(true);
        stdin.resume();
        this.attachResizeHandler();
        const currentSize = this.readTerminalSize();
        if (currentSize) this.lastKnownTerminalSize = currentSize;
        const handler = (text: string, key: Keypress) => onKeypress(text, key);
        stdin.on("keypress", handler);
        this.writeStdout("\u001b[?2004h\u001b[?25h");
        return () => {
            stdin.off("keypress", handler);
            this.writeStdout("\u001b[?2004l");
            if (stdin.isTTY) stdin.setRawMode(wasRaw);
            if (wasPaused) stdin.pause();
            this.writeStdout("\u001b[?25h");
            onCleanup();
        };
    }

    private readonly globalEscapeKeypressHandler = (_text: string, key: Keypress): void => {
        if (key.name === "escape") this.triggerEscape();
    };

    private attachGlobalEscapeHandler(): void {
        if (this.globalEscapeHandlerAttached) return;
        emitKeypressEvents(process.stdin);
        const stdin = process.stdin;
        this.globalEscapeWasPaused = typeof stdin.isPaused === "function" ? stdin.isPaused() : false;
        if (stdin.isTTY) stdin.setRawMode(true);
        stdin.resume();
        stdin.on("keypress", this.globalEscapeKeypressHandler);
        this.globalEscapeHandlerAttached = true;
    }

    private detachGlobalEscapeHandler(): void {
        if (!this.globalEscapeHandlerAttached) return;
        const stdin = process.stdin;
        stdin.off("keypress", this.globalEscapeKeypressHandler);
        if (stdin.isTTY) stdin.setRawMode(false);
        if (this.globalEscapeWasPaused) stdin.pause();
        this.globalEscapeHandlerAttached = false;
    }

    private buildPromptFrame(params: {
        prompt: string;
        showPromptText: boolean;
        placeholder: string;
        value: string;
        cursor: number;
        suggestions: SlashCommandDefinition[];
        selectedSuggestionIndex: number;
    }): TransientFrame {
        const width = this.getTransientFrameWidth();
        const lines: string[] = [];
        const queuedLines = this.renderQueuedSteeringLines(width);
        if (queuedLines.length > 0) {
            lines.push(...queuedLines);
            lines.push("");
        }
        const busyStatus = this.bottomArea.getBusyStatusText();
        const busyStatusRow = busyStatus ? lines.length : undefined;
        if (busyStatus) {
            lines.push(this.styleAnsi(this.fitToWidth(busyStatus, width), { fg: "#a3a3a3", dim: true }));
            lines.push("");
        }
        const promptLines = params.showPromptText ? this.wrapPlainTextWords(params.prompt, width) : [];
        lines.push(...promptLines);
        lines.push(this.styleAnsi(PROMPT_BORDER_CHARS.horizontal.repeat(width), { fg: PROMPT_BORDER_COLOR }));
        const inputLayout = this.buildInputLayout(params.value, width, params.cursor);
        if (params.value.length === 0) {
            lines.push(this.styleAnsi(this.fitToWidth(params.placeholder, width), { fg: "#6b7280", dim: true }));
        } else {
            for (const line of inputLayout.lines) lines.push(line.padEnd(width, " "));
        }
        lines.push(this.styleAnsi(PROMPT_BORDER_CHARS.horizontal.repeat(width), { fg: PROMPT_BORDER_COLOR }));
        const sessionDetailLines = this.renderSessionDetailLines(width);
        if (sessionDetailLines.length > 0) {
            lines.push(...sessionDetailLines);
            if (params.suggestions.length > 0) {
                lines.push("");
            }
        }
        lines.push(...renderChoiceOptionsWindow(params.suggestions.map((suggestion) => ({
            label: suggestion.name,
            value: suggestion.name,
            description: suggestion.description,
        })), params.selectedSuggestionIndex, width, this.formatter));
        return {
            lines: this.needsBlockSeparator ? ["", ...lines] : lines,
            cursorRow: (this.needsBlockSeparator ? 1 : 0) + queuedLines.length + (queuedLines.length > 0 ? 1 : 0) + (busyStatus ? 2 : 0) + promptLines.length + 1 + inputLayout.cursorRow,
            cursorCol: inputLayout.cursorCol,
            cursorVisible: true,
            width,
            busyStatusRow: busyStatusRow === undefined ? undefined : busyStatusRow + (this.needsBlockSeparator ? 1 : 0),
        };
    }

    private renderQueuedSteeringLines(width: number): string[] {
        if (this.queuedSteeringMessages.length === 0) return [];
        const lines: string[] = [];
        for (const message of this.queuedSteeringMessages) {
            const preview = message.replace(/\s+/g, " ").trim();
            const label = `Steering: ${preview}`;
            for (const line of this.wrapPlainTextWords(label, width)) {
                lines.push(this.styleAnsi(line, { fg: "#8a8f98", dim: true }));
            }
        }
        lines.push(this.styleAnsi("↳ Alt+Up to edit all queued messages", { fg: "#7b8088", dim: true }));
        return lines;
    }

    private renderSessionDetailLines(width: number): string[] {
        if (this.sessionDetails.length === 0) return [];

        const rendered: string[] = [];
        const style: AnsiStyle = { fg: "#7b8088", dim: true };

        for (const detail of this.sessionDetails) {
            const left = detail.left.trim();
            const right = detail.right?.trim() ?? "";

            if (!left && !right) {
                continue;
            }

            if (!right) {
                for (const line of this.wrapPlainTextWords(left, width)) {
                    rendered.push(this.styleAnsi(line, style));
                }
                continue;
            }

            const leftWidth = this.getVisibleTextWidth(left);
            const rightWidth = this.getVisibleTextWidth(right);
            const gapWidth = width - leftWidth - rightWidth;

            if (leftWidth > 0 && rightWidth > 0 && gapWidth >= 3) {
                rendered.push(this.styleAnsi(`${left}${" ".repeat(gapWidth)}${right}`, style));
                continue;
            }

            for (const line of this.wrapPlainTextWords(left, width)) {
                rendered.push(this.styleAnsi(line, style));
            }

            if (rightWidth <= width) {
                rendered.push(this.styleAnsi(`${" ".repeat(Math.max(0, width - rightWidth))}${right}`, style));
            } else {
                for (const line of this.wrapPlainTextWords(right, width)) {
                    rendered.push(this.styleAnsi(line, style));
                }
            }
        }

        return rendered;
    }

    private buildChoiceFrame<T>(prompt: string, options: ChoiceOption<T>[], selectedIndex: number): TransientFrame {
        const width = this.getTransientFrameWidth();
        const lines: string[] = [];
        lines.push(...this.wrapPlainTextWords(prompt, width).map((line) => this.styleAnsi(line, { fg: "#d4d4d4" })));
        lines.push(this.styleAnsi(CHOICE_HINT_TEXT, { fg: "#7b8088", dim: true }));
        lines.push("");
        lines.push(...renderChoiceOptionsWindow(options, selectedIndex, width, this.formatter));
        return {
            lines: this.needsBlockSeparator ? ["", ...lines] : lines,
            cursorRow: (this.needsBlockSeparator ? 1 : 0) + Math.max(0, lines.length - 1),
            cursorCol: 0,
            cursorVisible: false,
            width,
        };
    }

    private buildInputLayout(value: string, width: number, cursor: number): { lines: string[]; cursorRow: number; cursorCol: number } {
        if (value.length === 0) return { lines: [""], cursorRow: 0, cursorCol: 0 };
        const lines = this.wrapPlainTextWords(value, width);
        const beforeCursor = this.wrapPlainTextWords(value.slice(0, cursor), width);
        const cursorRow = Math.max(0, beforeCursor.length - 1);
        const cursorCol = this.getVisibleTextWidth(beforeCursor[cursorRow] ?? "");
        return { lines, cursorRow, cursorCol };
    }

    private findInputCursorAtVisualPosition(value: string, width: number, targetRow: number, targetCol: number): number {
        let bestCursor = 0;
        let bestDistance = Number.POSITIVE_INFINITY;

        for (let candidate = 0; candidate <= value.length; candidate += 1) {
            const layout = this.buildInputLayout(value, width, candidate);
            if (layout.cursorRow !== targetRow) continue;
            const distance = Math.abs(layout.cursorCol - targetCol);
            if (distance < bestDistance || (distance === bestDistance && layout.cursorCol <= targetCol)) {
                bestDistance = distance;
                bestCursor = candidate;
            }
        }

        return bestCursor;
    }

    private renderStreamingBlock(block: StreamingBlockState, rawText = block.rawText): string {
        return block.variant === "thinking" ? this.renderThinkingBlock(rawText) : this.renderMarkdownBlock(rawText);
    }

    private renderToolTrace(trace: ToolHistorySnapshot): string {
        if (this.isReadTrace(trace)) return this.renderReadTrace(trace);
        if (this.isWriteTrace(trace)) return this.renderWriteTrace(trace);
        if (this.isEditTrace(trace)) return this.renderEditTrace(trace);
        if (this.isLocalShellTrace(trace)) return this.renderLocalShellTrace(trace);
        const title = this.getToolDisplayTitle(trace);
        const viewModel: ToolTraceViewModel = {
            displayId: trace.displayId,
            toolName: trace.toolName,
            status: trace.status,
            args: trace.args,
            argsText: trace.argsText,
            output: trace.output,
            details: trace.details,
            expanded: trace.expanded,
        };
        const theme = this.getTraceTheme(trace);
        return this.renderPanelBlock([
            { text: title, style: { ...theme.body, ...theme.title, fg: this.getTraceTitleColor(trace, theme.title.fg ?? "#d4d4d4") } },
            ...this.renderMarkdownLines(buildToolTraceMarkdown(viewModel)).map((line) => ({ text: line, style: theme.body })),
        ], this.getTracePanelWidth(), theme.body);
    }

    private renderReadTrace(trace: ToolHistorySnapshot): string {
        const detail = trace.details?.type === "read" ? trace.details : undefined;
        const theme = { fg: "#e6f2e8", bg: trace.status === "error" ? "#2a1717" : "#203126" };
        const path = detail?.path ?? this.getToolPath(trace);
        const content = detail?.content ?? trace.output;
        const capped = this.capTraceTextLines(content, trace.expanded ? READ_TRACE_EXPANDED_LINES : READ_TRACE_PREVIEW_LINES, this.getReadRemainingLines(trace));
        const displayedLineCount = capped.text.length > 0 ? capped.text.split("\n").length : 0;
        const isImage = detail?.isImage === true;
        const startLine = detail?.startLine ?? this.getReadStartLine(trace);
        const endLine = displayedLineCount > 0 ? startLine + displayedLineCount - 1 : startLine;
        const range = !isImage && displayedLineCount > 0 ? `:${startLine}-${endLine}` : "";
        const title = `${this.styleAnsi("read", { fg: "#ffffff", bold: true })}${path ? ` ${this.styleAnsi(path, { fg: "#8fcac3" })}` : ""}${range ? this.styleAnsi(range, { fg: "#f5f500" }) : ""}`;
        const lines: Array<{ text: string; style?: AnsiStyle }> = [
            { text: title, style: theme },
        ];

        if (trace.status === "error" && (detail?.notice || trace.output.trim())) {
            lines.push({ text: "", style: theme });
            const errorText = this.capTraceTextLines(detail?.notice ?? trace.output, trace.expanded ? READ_TRACE_EXPANDED_LINES : READ_TRACE_PREVIEW_LINES);
            for (const line of errorText.text.split("\n")) lines.push({ text: line, style: { ...theme, fg: "#fca5a5" } });
            if (errorText.omittedLines > 0) lines.push({ text: this.formatMoreLines(errorText.omittedLines, trace), style: { ...theme, fg: "#8f969d", dim: true } });
            return this.renderPanelBlock(lines, this.getTracePanelWidth(), theme);
        }

        if (capped.text.trimEnd().length > 0) {
            lines.push({ text: "", style: theme });
            if (isImage) {
                for (const line of capped.text.trimEnd().split("\n")) lines.push({ text: line, style: { ...theme, fg: "#a7adb4" } });
                if (detail?.attachedToModel) lines.push({ text: "Image attached to model input.", style: { ...theme, fg: "#8f969d", dim: true } });
            } else {
                const renderedContent = this.renderMarkdownBlock(`\u0060\u0060\u0060${detail?.language ?? ""}\n${capped.text.trimEnd()}\n\u0060\u0060\u0060`);
                for (const line of renderedContent.split("\n")) lines.push({ text: line, style: theme });
            }
        }

        if (capped.omittedLines > 0) {
            lines.push({ text: this.formatMoreLines(capped.omittedLines, trace), style: { ...theme, fg: "#8f969d", dim: true } });
        }

        return this.renderPanelBlock(lines, this.getTracePanelWidth(), theme);
    }

    private renderWriteTrace(trace: ToolHistorySnapshot): string {
        const detail = trace.details?.type === "write" ? trace.details : undefined;
        const theme = { fg: "#e6f2e8", bg: trace.status === "error" ? "#2a1717" : "#203126" };
        const path = detail?.path ?? this.getToolPath(trace);
        const title = `${this.styleAnsi("write", { fg: "#ffffff", bold: true })}${path ? ` ${this.styleAnsi(path, { fg: "#8fcac3" })}` : ""}`;
        const lines: Array<{ text: string; style?: AnsiStyle }> = [
            { text: title, style: theme },
        ];

        if (trace.status === "error" && trace.output.trim().length > 0) {
            lines.push({ text: "", style: theme });
            const errorText = this.capTraceTextLines(trace.output, trace.expanded ? WRITE_TRACE_EXPANDED_LINES : WRITE_TRACE_PREVIEW_LINES);
            for (const line of errorText.text.split("\n")) lines.push({ text: line, style: { ...theme, fg: "#fca5a5" } });
            if (errorText.omittedLines > 0) lines.push({ text: this.formatMoreLines(errorText.omittedLines, trace), style: { ...theme, fg: "#8f969d", dim: true } });
            return this.renderPanelBlock(lines, this.getTracePanelWidth(), theme);
        }

        if (detail?.content.trim()) {
            const capped = this.capTraceTextLines(detail.content, trace.expanded ? WRITE_TRACE_EXPANDED_LINES : WRITE_TRACE_PREVIEW_LINES);
            const renderedContent = capped.text.trimEnd().length > 0
                ? this.renderMarkdownBlock(`\u0060\u0060\u0060${detail.language ?? ""}\n${capped.text.trimEnd()}\n\u0060\u0060\u0060`)
                : "";
            if (renderedContent.length > 0) {
                lines.push({ text: "", style: theme });
                for (const line of renderedContent.split("\n")) lines.push({ text: line, style: theme });
            }
            if (capped.omittedLines > 0) lines.push({ text: this.formatMoreLines(capped.omittedLines, trace), style: { ...theme, fg: "#8f969d", dim: true } });
        } else if (trace.output.trim().length > 0 && trace.status === "complete") {
            lines.push({ text: "", style: theme });
            lines.push({ text: trace.output.trim(), style: { ...theme, fg: "#8f969d", dim: true } });
        }

        return this.renderPanelBlock(lines, this.getTracePanelWidth(), theme);
    }

    private getReadStartLine(trace: ToolHistorySnapshot): number {
        if (trace.args && typeof trace.args === "object") {
            const offset = (trace.args as { offset?: unknown }).offset;
            if (typeof offset === "number" && Number.isFinite(offset)) return Math.max(1, Math.floor(offset));
        }
        return 1;
    }

    private getReadRemainingLines(trace: ToolHistorySnapshot): number {
        const detail = trace.details?.type === "read" ? trace.details : undefined;
        if (typeof detail?.remainingLines === "number") return detail.remainingLines;
        const notice = detail?.notice ?? trace.output;
        const direct = notice.match(/\[(\d+) more lines? in file\./i);
        if (direct) return Number(direct[1]);
        const ranged = notice.match(/Showing lines \d+-(\d+) of (\d+)\./i);
        if (ranged) return Math.max(0, Number(ranged[2]) - Number(ranged[1]));
        return 0;
    }

    private capTraceTextLines(text: string, maxLines: number, additionalOmittedLines = 0): { text: string; omittedLines: number } {
        const normalized = this.normalizeNewlines(text).trimEnd();
        if (normalized.length === 0) return { text: "", omittedLines: additionalOmittedLines };
        const lines = normalized.split("\n");
        const visible = lines.slice(0, Math.max(0, maxLines));
        return {
            text: visible.join("\n"),
            omittedLines: Math.max(0, lines.length - visible.length) + additionalOmittedLines,
        };
    }

    private formatMoreLines(count: number, trace: ToolHistorySnapshot, label?: string): string {
        const noun = count === 1 ? "line" : "lines";
        const subject = label ? ` ${label}` : "";
        return `+${count} more${subject} ${noun}`;
    }

    private renderEditTrace(trace: ToolHistorySnapshot): string {
        const detail = trace.details?.type === "edit" ? trace.details : undefined;
        const theme = { fg: "#e6f2e8", bg: trace.status === "error" ? "#2a1717" : "#203126" };
        const path = detail?.path ?? this.getToolPath(trace);
        const title = `${this.styleAnsi("edit", { fg: "#ffffff", bold: true })}${path ? ` ${this.styleAnsi(path, { fg: "#8fcac3" })}` : ""}`;
        const lines: Array<{ text: string; style?: AnsiStyle }> = [
            { text: title, style: theme },
        ];

        if (trace.status === "error" && trace.output.trim().length > 0) {
            lines.push({ text: "", style: theme });
            const errorText = this.capTraceTextLines(trace.output, trace.expanded ? EDIT_TRACE_EXPANDED_LINES : EDIT_TRACE_PREVIEW_LINES);
            for (const line of errorText.text.split("\n")) lines.push({ text: line, style: { ...theme, fg: "#fca5a5" } });
            if (errorText.omittedLines > 0) lines.push({ text: this.formatMoreLines(errorText.omittedLines, trace), style: { ...theme, fg: "#8f969d", dim: true } });
            return this.renderPanelBlock(lines, this.getTracePanelWidth(), theme);
        }

        if (detail?.diff.trim()) {
            lines.push({ text: "", style: theme });
            const contextLines = trace.expanded ? 20 : 5;
            const cappedContextDiff = this.capEditDiffContextLines(detail.diff, contextLines);
            lines.push(...this.renderEditDiffLines(cappedContextDiff, this.getTracePanelWidth()));
        }

        return this.renderPanelBlock(lines, this.getTracePanelWidth(), theme);
    }

    private capEditDiffContextLines(diffText: string, maxContextLines: number): string {
        const lines = this.normalizeNewlines(diffText).trimEnd().split("\n");
        if (lines.length === 0) return "";
        const hasChangedLine = (line: string) => {
            const parsed = this.parseDiffLine(line);
            return parsed?.prefix === "+" || parsed?.prefix === "-";
        };
        const hasAnyChanges = lines.some(hasChangedLine);
        if (!hasAnyChanges) return lines.slice(0, maxContextLines).join("\n");

        const output: string[] = [];
        let sawChangedBefore = false;
        let index = 0;

        const pushEllipsis = () => {
            if (output[output.length - 1] !== "...") output.push("...");
        };
        const pushContextRun = (run: string[], hasChangedAfter: boolean) => {
            if (run.length === 0) return;
            if (run.length <= maxContextLines * 2) {
                output.push(...run);
                return;
            }

            if (!sawChangedBefore && hasChangedAfter) {
                pushEllipsis();
                output.push(...run.slice(-maxContextLines));
                return;
            }

            if (sawChangedBefore && !hasChangedAfter) {
                output.push(...run.slice(0, maxContextLines));
                pushEllipsis();
                return;
            }

            output.push(...run.slice(0, maxContextLines));
            pushEllipsis();
            output.push(...run.slice(-maxContextLines));
        };

        while (index < lines.length) {
            const line = lines[index] ?? "";
            const parsed = this.parseDiffLine(line);
            if (parsed?.prefix === " ") {
                const run: string[] = [];
                while (index < lines.length) {
                    const nextLine = lines[index] ?? "";
                    const nextParsed = this.parseDiffLine(nextLine);
                    if (nextParsed?.prefix !== " ") break;
                    run.push(nextLine);
                    index += 1;
                }
                const hasChangedAfter = lines.slice(index).some(hasChangedLine);
                pushContextRun(run, hasChangedAfter);
                continue;
            }

            if (line.trim() === "...") {
                pushEllipsis();
                index += 1;
                continue;
            }

            output.push(line);
            if (parsed?.prefix === "+" || parsed?.prefix === "-") sawChangedBefore = true;
            index += 1;
        }

        return output.join("\n");
    }

    private renderEditDiffLines(diffText: string, width: number): Array<{ text: string; style?: AnsiStyle }> {
        const out: Array<{ text: string; style?: AnsiStyle }> = [];
        const lines = this.normalizeNewlines(diffText).split("\n");
        const lineNumberWidth = Math.max(1, ...lines.map((line) => this.parseDiffLine(line)?.lineNum.length ?? 0));
        const ellipsisIndent = " ".repeat(lineNumberWidth + 2);
        let index = 0;
        while (index < lines.length) {
            if ((lines[index] ?? "").trim() === "...") {
                this.pushWrappedDiffLine(out, "", `${ellipsisIndent}...`, { fg: "#8f969d", bg: "#203126", dim: true }, width);
                index += 1;
                continue;
            }

            const parsed = this.parseDiffLine(lines[index] ?? "");
            if (!parsed) {
                this.pushWrappedDiffLine(out, "", lines[index] ?? "", { fg: "#8f969d", bg: "#203126", dim: true }, width);
                index += 1;
                continue;
            }

            if (parsed.prefix === "-") {
                const removed: Array<{ lineNum: string; content: string }> = [];
                while (index < lines.length) {
                    const next = this.parseDiffLine(lines[index] ?? "");
                    if (!next || next.prefix !== "-") break;
                    removed.push({ lineNum: next.lineNum, content: this.replaceTabs(next.content) });
                    index += 1;
                }

                const added: Array<{ lineNum: string; content: string }> = [];
                while (index < lines.length) {
                    const next = this.parseDiffLine(lines[index] ?? "");
                    if (!next || next.prefix !== "+") break;
                    added.push({ lineNum: next.lineNum, content: this.replaceTabs(next.content) });
                    index += 1;
                }

                if (removed.length === 1 && added.length === 1) {
                    const pair = this.renderIntraLineDiff(removed[0]!.content, added[0]!.content);
                    this.pushWrappedDiffLine(out, `-${removed[0]!.lineNum} `, pair.removedLine, { fg: "#f87171", bg: "#203126" }, width);
                    this.pushWrappedDiffLine(out, `+${added[0]!.lineNum} `, pair.addedLine, { fg: "#c3d977", bg: "#203126" }, width);
                } else {
                    for (const line of removed) this.pushWrappedDiffLine(out, `-${line.lineNum} `, line.content, { fg: "#f87171", bg: "#203126" }, width);
                    for (const line of added) this.pushWrappedDiffLine(out, `+${line.lineNum} `, line.content, { fg: "#c3d977", bg: "#203126" }, width);
                }
                continue;
            }

            if (parsed.prefix === "+") {
                this.pushWrappedDiffLine(out, `+${parsed.lineNum} `, this.replaceTabs(parsed.content), { fg: "#c3d977", bg: "#203126" }, width);
            } else {
                this.pushWrappedDiffLine(out, ` ${parsed.lineNum} `, this.replaceTabs(parsed.content), { fg: "#8f969d", bg: "#203126", dim: true }, width);
            }
            index += 1;
        }
        return out;
    }

    private parseDiffLine(line: string): { prefix: string; lineNum: string; content: string } | null {
        const match = line.match(/^([+\-\s])(\s*\d*)\s(.*)$/);
        if (!match) return null;
        return { prefix: match[1] ?? " ", lineNum: match[2] ?? "", content: match[3] ?? "" };
    }

    private pushWrappedDiffLine(out: Array<{ text: string; style?: AnsiStyle }>, prefix: string, content: string, style: AnsiStyle, width: number): void {
        const available = Math.max(1, width - this.getVisibleTextWidth(prefix));
        const wrapped = this.wrapStyledLineWords(content, available);
        const continuation = " ".repeat(this.getVisibleTextWidth(prefix));
        out.push({ text: `${prefix}${wrapped[0] ?? ""}`, style });
        for (const segment of wrapped.slice(1)) out.push({ text: `${continuation}${segment}`, style });
    }

    private renderIntraLineDiff(oldContent: string, newContent: string): { removedLine: string; addedLine: string } {
        let start = 0;
        while (start < oldContent.length && start < newContent.length && oldContent[start] === newContent[start]) start += 1;
        let oldEnd = oldContent.length;
        let newEnd = newContent.length;
        while (oldEnd > start && newEnd > start && oldContent[oldEnd - 1] === newContent[newEnd - 1]) {
            oldEnd -= 1;
            newEnd -= 1;
        }
        const removedLine = `${oldContent.slice(0, start)}${this.styleAnsi(oldContent.slice(start, oldEnd), { inverse: true })}${oldContent.slice(oldEnd)}`;
        const addedLine = `${newContent.slice(0, start)}${this.styleAnsi(newContent.slice(start, newEnd), { inverse: true })}${newContent.slice(newEnd)}`;
        return { removedLine, addedLine };
    }

    private replaceTabs(text: string): string {
        return text.replace(/\t/g, "   ");
    }

    private isReadTrace(trace: ToolHistorySnapshot): boolean {
        return trace.toolName === "read" || trace.details?.type === "read";
    }

    private isWriteTrace(trace: ToolHistorySnapshot): boolean {
        return trace.toolName === "write" || trace.details?.type === "write";
    }

    private isEditTrace(trace: ToolHistorySnapshot): boolean {
        return trace.toolName === "edit" || trace.details?.type === "edit";
    }

    private isLocalShellTrace(trace: ToolHistorySnapshot): boolean {
        return trace.toolName === "run_command" || trace.toolName === "local_shell" || trace.details?.type === "local_shell";
    }

    private renderLocalShellTrace(trace: ToolHistorySnapshot): string {
        const command = this.getShellCommand(trace);
        const parsed = this.parseShellOutput(this.getShellOutput(trace));
        const theme = { fg: "#e6f2e8", bg: trace.status === "error" ? "#2a1717" : "#203126" };
        const lines: Array<{ text: string; style?: AnsiStyle }> = [
            { text: `$ ${command || trace.toolName}`, style: { ...theme, fg: "#ffffff", bold: true } },
        ];

        const maxOutputLines = trace.expanded ? SHELL_TRACE_EXPANDED_LINES : SHELL_TRACE_PREVIEW_LINES;
        if (parsed.stdout.length > 0) {
            lines.push({ text: "", style: theme });
            const cappedStdout = this.capTraceTextLines(parsed.stdout, maxOutputLines);
            for (const line of cappedStdout.text.split("\n")) lines.push({ text: line, style: { ...theme, fg: "#a7adb4" } });
            if (cappedStdout.omittedLines > 0) lines.push({ text: this.formatMoreLines(cappedStdout.omittedLines, trace, "stdout"), style: { ...theme, fg: "#8f969d", dim: true } });
        }
        if (parsed.stderr.length > 0) {
            lines.push({ text: "", style: theme });
            const cappedStderr = this.capTraceTextLines(parsed.stderr, maxOutputLines);
            for (const line of cappedStderr.text.split("\n")) lines.push({ text: line, style: { ...theme, fg: "#fca5a5" } });
            if (cappedStderr.omittedLines > 0) lines.push({ text: this.formatMoreLines(cappedStderr.omittedLines, trace, "stderr"), style: { ...theme, fg: "#8f969d", dim: true } });
        }

        const elapsed = this.formatToolElapsed(trace);
        const statusLine = trace.status === "running"
            ? `Running${elapsed ? ` · ${elapsed}` : ""}`
            : trace.status === "complete"
                ? `Took ${elapsed ?? "0.0s"}`
                : trace.status === "error"
                    ? `Failed${parsed.exitCode !== null ? ` · exit ${parsed.exitCode}` : ""}${elapsed ? ` · ${elapsed}` : ""}`
                    : trace.status;
        lines.push({ text: "", style: theme });
        lines.push({ text: statusLine, style: { ...theme, fg: "#8f969d" } });

        return this.renderPanelBlock(lines, this.getTracePanelWidth(), theme);
    }

    private getShellCommand(trace: ToolHistorySnapshot): string {
        if (trace.details?.type === "local_shell" && trace.details.command) return trace.details.command;
        if (trace.args && typeof trace.args === "object") {
            const command = (trace.args as { command?: unknown }).command;
            if (typeof command === "string") return command;
        }
        return "";
    }

    private getShellOutput(trace: ToolHistorySnapshot): string {
        if (trace.details?.type === "local_shell" && trace.details.output) return trace.details.output;
        return trace.output;
    }

    private parseShellOutput(output: string): { stdout: string; stderr: string; exitCode: number | null } {
        const normalized = this.normalizeNewlines(output).trimEnd();
        const exitMatch = normalized.match(/(?:^|\n)EXIT CODE:\s*(-?\d+)\s*$/);
        const exitCode = exitMatch ? Number(exitMatch[1]) : null;
        const withoutExit = exitMatch ? normalized.slice(0, exitMatch.index).trimEnd() : normalized;
        const stdoutMatch = withoutExit.match(/(?:^|\n)STDOUT:\n([\s\S]*?)(?=\nSTDERR:\n|$)/);
        const stderrMatch = withoutExit.match(/(?:^|\n)STDERR:\n([\s\S]*?)$/);
        if (stdoutMatch || stderrMatch) {
            return {
                stdout: (stdoutMatch?.[1] ?? "").trimEnd(),
                stderr: (stderrMatch?.[1] ?? "").trimEnd(),
                exitCode,
            };
        }
        return { stdout: withoutExit, stderr: "", exitCode };
    }

    private formatToolElapsed(trace: ToolHistorySnapshot): string | null {
        const start = trace.startedAt;
        if (!start) return null;
        const end = trace.finishedAt ?? Date.now();
        return `${Math.max(0, (end - start) / 1000).toFixed(1)}s`;
    }

    private getToolDisplayTitle(trace: ToolHistorySnapshot): string {
        const path = this.getToolPath(trace);
        return path ? `${trace.toolName} ${path}` : trace.toolName;
    }

    private getToolPath(trace: ToolHistorySnapshot): string {
        const detailPath = trace.details && "path" in trace.details ? (trace.details.path as string | undefined) : undefined;
        if (detailPath) return detailPath;
        if (trace.args && typeof trace.args === "object") {
            const pathValue = (trace.args as { path?: unknown }).path;
            if (typeof pathValue === "string") return pathValue;
        }
        return "";
    }

    private getKnownToolTraceDetails(details: unknown): KnownToolTraceDetails | undefined {
        if (!details || typeof details !== "object" || !("type" in details)) return undefined;
        return details as KnownToolTraceDetails;
    }

    private renderMarkdownBlock(text: string): string {
        return this.formatter.renderMarkdownBlock(text);
    }

    private renderMarkdownLines(text: string): string[] {
        return this.formatter.renderMarkdownLines(text);
    }
    private renderThinkingBlock(text: string): string {
        return this.formatter.renderThinkingBlock(text);
    }

    private renderUserBlock(text: string): string {
        const theme = this.getUserMessageTheme();
        return this.renderPanelBlock(text.trimEnd().split("\n").map((line) => ({ text: line, style: theme })), this.getOutputWidth(), theme);
    }

    private renderWarningBlock(text: string): string {
        const theme: AnsiStyle = { fg: "#fbbf24", bg: "#241d0b" };
        const titleTheme: AnsiStyle = { ...theme, fg: "#fcd34d", bold: true };
        const renderedLines = this.renderMarkdownLines(text.trimEnd());
        const lines = renderedLines.map((line, index) => ({
            text: line,
            style: index === 0 ? titleTheme : theme,
        }));
        return this.renderPanelBlock(lines, this.getOutputWidth(), theme);
    }

    private renderErrorBlock(text: string): string {
        const theme: AnsiStyle = { fg: "#fecaca", bg: "#2a1717" };
        const titleTheme: AnsiStyle = { ...theme, fg: "#f87171", bold: true };
        const renderedLines = this.renderMarkdownLines(text.trimEnd());
        const lines = renderedLines.map((line, index) => ({
            text: line,
            style: index === 0 ? titleTheme : theme,
        }));
        return this.renderPanelBlock(lines, this.getOutputWidth(), theme);
    }

    private renderPanelBlock(lines: Array<{ text: string; style?: AnsiStyle }>, width: number, fillStyle: AnsiStyle): string {
        return this.formatter.renderPanelBlock(lines, width, fillStyle);
    }

    private getStartupImageWidthCells(): number {
        return Math.max(12, Math.min(32, Math.floor(this.getOutputWidth() / 3)));
    }

    private getStartupImageHeightCells(): number {
        return Math.max(6, Math.min(18, Math.floor(this.getTerminalHeight() / 4)));
    }

    private getStartupImageWidthPx(): number {
        return Math.max(160, Math.min(420, this.getStartupImageWidthCells() * 14));
    }

    private getStartupImageHeightPx(): number {
        return Math.max(120, Math.min(360, this.getStartupImageHeightCells() * 24));
    }

    private layoutPrintedBlockLines(text: string, indent: boolean): string[] {
        const prefix = indent ? "" : "";
        const width = Math.max(1, this.getOutputWidth() - this.getVisibleTextWidth(prefix));
        return text.split("\n").flatMap((line) => this.wrapStyledLineWords(line, width).map((wrapped) => `${prefix}${wrapped}`));
    }

    private getRenderedTailColumn(text: string): number {
        const lines = this.layoutPrintedBlockLines(text, false);
        const lastLine = lines.length > 0 ? lines[lines.length - 1] ?? "" : "";
        return this.getVisibleTextWidth(lastLine);
    }

    private wrapPlainTextWords(text: string, width: number): string[] {
        return this.formatter.wrapPlainTextWords(text, width);
    }

    private wrapStyledLineWords(line: string, width: number): string[] {
        return this.formatter.wrapStyledLineWords(line, width);
    }

    private wrapStyledLineWordsWithWidths(line: string, firstWidth: number, continuationWidth: number): string[] {
        return this.formatter.wrapStyledLineWordsWithWidths(line, firstWidth, continuationWidth);
    }

    private getThinkingTraceTheme(): AnsiStyle { return this.formatter.getThinkingTraceTheme(); }
    private getThinkingTraceTitleTheme(): AnsiStyle { return this.formatter.getThinkingTraceTitleTheme(); }
    private getThinkingTraceCodeTheme(): AnsiStyle { return this.formatter.getThinkingTraceCodeTheme(); }
    private getUserMessageTheme(): AnsiStyle { return { fg: "#e5e7eb", bg: "#1a1c20" }; }

    private getTraceTheme(trace: ToolHistorySnapshot): { title: AnsiStyle; body: AnsiStyle } {
        const traceType = trace.details?.type ?? this.getTraceTypeFromToolName(trace.toolName);
        switch (traceType) {
            case "read": return { title: { fg: "#9fc5f8", bold: true }, body: { fg: "#dbe7f3", bg: "#101720" } };
            case "write": return { title: { fg: "#9ad7a7", bold: true }, body: { fg: "#ddeee0", bg: "#111814" } };
            case "edit": return { title: { fg: "#e8c58a", bold: true }, body: { fg: "#efe5d8", bg: "#1a1510" } };
            case "web_search": return { title: { fg: "#c5b4ff", bold: true }, body: { fg: "#e4ddff", bg: "#171427" } };
            case "file_search": return { title: { fg: "#9ec5ff", bold: true }, body: { fg: "#dce9ff", bg: "#101826" } };
            case "code_interpreter": return { title: { fg: "#f4b8ce", bold: true }, body: { fg: "#f6e0e8", bg: "#21141b" } };
            case "mcp": return { title: { fg: "#f1b2a4", bold: true }, body: { fg: "#f2dfdb", bg: "#201514" } };
            case "local_shell": return { title: { fg: "#c4c7cf", bold: true }, body: { fg: "#e2e4e8", bg: "#17181b" } };
            case "tool_search": return { title: { fg: "#9fd7e8", bold: true }, body: { fg: "#dcf0f5", bg: "#102026" } };
            case "plan_choice": return { title: { fg: "#fde68a", bold: true }, body: { fg: "#fff7d6", bg: "#1f1a10" } };
            case "plan_complete": return { title: { fg: "#c4b5fd", bold: true }, body: { fg: "#eee9ff", bg: "#171326" } };
            case "subagent": return { title: { fg: "#48d1cc", bold: true }, body: { fg: "#d9fbf8", bg: "#10201f" } };
            default: return { title: { fg: this.getTraceColor(trace.status), bold: true }, body: { fg: "#e5e7eb", bg: "#17181b" } };
        }
    }

    private getTraceTypeFromToolName(toolName: string): KnownToolTraceDetails["type"] | null {
        switch (toolName) {
            case "read": case "write": case "edit": case "web_search": case "file_search": case "code_interpreter": case "mcp": case "local_shell": case "tool_search": case "plan_choice": case "plan_complete": case "subagent": return toolName;
            case "run_command": return "local_shell";
            case "spawn_subagent": return "subagent";
            default: return null;
        }
    }

    private getTraceTitleColor(trace: ToolHistorySnapshot, fallback: string): string {
        if (trace.status === "error") return "#fda4af";
        if (trace.status === "aborted") return "#fdba74";
        return fallback;
    }

    private getTraceColor(status: ToolTraceStatus): string {
        switch (status) {
            case "pending": return "#fbbf24";
            case "running": return "#93c5fd";
            case "complete": return "#86efac";
            case "error": return "#fda4af";
            case "aborted": return "#fdba74";
            default: return "#d4d4d4";
        }
    }

    private attachResizeHandler(): void {
        if (this.resizeHandlerAttached) return;
        if (!process.stdout.isTTY) return;
        process.stdout.on("resize", this.handleStdoutResize);
        this.resizeHandlerAttached = true;
    }

    private detachResizeHandler(): void {
        if (!this.resizeHandlerAttached) return;
        process.stdout.off("resize", this.handleStdoutResize);
        this.resizeHandlerAttached = false;
    }

    private readonly handleStdoutResize = (): void => this.scheduleResizeRedraw();

    private getTracePanelWidth(): number { return this.getOutputWidth(); }
    private getTerminalWidth(): number {
        const columns = process.stdout.columns;
        return Number.isFinite(columns) && columns > 0 ? Math.floor(columns) : this.lastKnownTerminalSize?.columns ?? 80;
    }
    private getOutputWidth(): number { return Math.max(1, this.getTerminalWidth() - 1); }
    private getTransientFrameWidth(): number { return this.getOutputWidth(); }
    private getTerminalHeight(): number {
        const rows = process.stdout.rows;
        return Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : this.lastKnownTerminalSize?.rows ?? 24;
    }
    private readTerminalSize(): TerminalSize | null {
        const columns = process.stdout.columns;
        const rows = process.stdout.rows;
        if (!Number.isFinite(columns) || !Number.isFinite(rows) || columns <= 0 || rows <= 0) return null;
        return { columns: Math.floor(columns), rows: Math.floor(rows) };
    }
    private isSameTerminalSize(left: TerminalSize | null, right: TerminalSize | null): boolean {
        return !!left && !!right && left.columns === right.columns && left.rows === right.rows;
    }
    private measureRenderedRows(text: string): number { return text.split("\n").reduce((sum, line) => sum + this.measureWrappedLineRows(line, this.getOutputWidth()), 0); }
    private measureWrappedLineRows(line: string, width: number): number { return this.formatter.measureWrappedLineRows(line, width); }
    private normalizeNewlines(text: string): string { return this.formatter.normalizeNewlines(text); }
    private stripAnsi(text: string): string { return this.formatter.stripAnsi(text); }
    private getVisibleTextWidth(text: string): number { return this.formatter.getVisibleTextWidth(text); }
    private fitToWidth(text: string, width: number): string { return this.formatter.fitToWidth(text, width); }
    private shouldShowPromptText(prompt: string): boolean { return prompt.trim().length > 0 && prompt.trim() !== ">"; }
    private moveCursorUp(rows: number): void { this.writeStdout("\r"); if (rows > 0) this.writeStdout(`\u001b[${rows}A`); }
    private ensureUsable(): void { if (this.destroyed) throw new Error("UI is destroyed."); }
    private ensureNoActiveSession(): void { if (this.activeSessionCleanup) throw new Error("Another prompt is already active."); }

    private openAnsi(style: AnsiStyle): string {
        return this.formatter.openAnsi(style);
    }
    private resetAnsi(): string { return this.formatter.resetAnsi(); }
    private styleAnsi(text: string, style: AnsiStyle): string { return this.formatter.styleAnsi(text, style); }
    private applyBaseStyle(text: string, style: AnsiStyle): string { return this.formatter.applyBaseStyle(text, style); }

    private batchStdout<T>(operation: () => T): T {
        this.stdoutBatchDepth += 1;
        try {
            return operation();
        } finally {
            this.stdoutBatchDepth -= 1;
            if (this.stdoutBatchDepth === 0 && this.stdoutBatchBuffer.length > 0) {
                const buffered = this.stdoutBatchBuffer;
                this.stdoutBatchBuffer = "";
                process.stdout.write(buffered);
            }
        }
    }

    private writeStdout(text: string): void {
        if (this.stdoutBatchDepth > 0) {
            this.stdoutBatchBuffer += text;
            return;
        }
        process.stdout.write(text);
    }
}

