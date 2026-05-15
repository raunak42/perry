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
import type { ChoiceOption, InteractiveUi, PromptOptions, SessionDetailLine } from "./types";

const PROMPT_SUGGESTION_LIMIT = 5;
const RESIZE_SETTLE_DELAY_MS = 120;
const PROMPT_BORDER_CHARS = { horizontal: "─" };
const CHOICE_HINT_TEXT = "↑/↓ move · Enter select · Ctrl+C cancel";
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

/**
 * Scrollback-first terminal UI.
 *
 * Design rules:
 * - committed history is append-only;
 * - no viewport/history replay;
 * - only the current tail prompt, loader, streaming block, or trace may be rewritten;
 * - once a live tail is too tall to be safely rewritten, updates become append-only.
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
        requestInputRedraw: () => this.activeSessionRedraw?.(),
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

            const getSuggestions = (): SlashCommandDefinition[] => {
                if (options?.enableSlashCommands === false) return [];
                return filterSlashCommands(value).slice(0, PROMPT_SUGGESTION_LIMIT);
            };

            const clampSuggestionIndex = () => {
                const suggestions = getSuggestions();
                selectedSuggestionIndex = suggestions.length === 0
                    ? 0
                    : Math.max(0, Math.min(selectedSuggestionIndex, suggestions.length - 1));
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
                frame = this.bottomArea.renderTransient(frame, renderFrame());
            };

            const cleanup = (result?: string, error?: Error) => {
                if (!this.activeSessionCleanup) return;
                const teardown = this.activeSessionCleanup;
                this.activeSessionCleanup = null;
                this.activeSessionReject = null;
                this.activeSessionRedraw = null;
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

            const onKeypress = (text: string, key: Keypress) => {
                if (key.ctrl && key.name === "c") {
                    const interruptError = new Error("Interrupted");
                    interruptError.name = "UserInterruptError";
                    cleanup(undefined, interruptError);
                    return;
                }

                const suggestions = getSuggestions();
                if (key.meta && key.name === "up") {
                    const queuedText = this.queuedMessageEditHandler?.() ?? "";
                    if (queuedText.trim().length > 0) {
                        value = queuedText;
                        cursor = value.length;
                        selectedSuggestionIndex = 0;
                        redraw();
                    }
                    return;
                }
                if (key.name === "up" && suggestions.length > 0) {
                    selectedSuggestionIndex = Math.max(0, selectedSuggestionIndex - 1);
                    redraw();
                    return;
                }
                if (key.name === "down" && suggestions.length > 0) {
                    selectedSuggestionIndex = Math.min(suggestions.length - 1, selectedSuggestionIndex + 1);
                    redraw();
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
                        redraw();
                    }
                    return;
                }
                if (key.name === "delete") {
                    if (cursor < value.length) {
                        value = value.slice(0, cursor) + value.slice(cursor + 1);
                        selectedSuggestionIndex = 0;
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
                        redraw();
                    }
                    return;
                }
                if (key.name === "return" || key.name === "enter") {
                    submit();
                    return;
                }
                if (typeof text === "string" && text.length > 0 && !key.ctrl && !key.meta) {
                    const sanitized = text.replace(/[\r\n]/g, "");
                    if (sanitized.length > 0) {
                        value = value.slice(0, cursor) + sanitized + value.slice(cursor);
                        cursor += sanitized.length;
                        selectedSuggestionIndex = 0;
                        redraw();
                    }
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
                frame = this.bottomArea.renderTransient(frame, renderFrame());
            };

            const cleanup = (result?: T, error?: Error) => {
                if (!this.activeSessionCleanup) return;
                const teardown = this.activeSessionCleanup;
                this.activeSessionCleanup = null;
                this.activeSessionReject = null;
                this.activeSessionRedraw = null;
                teardown();
                if (error) {
                    reject(error);
                    return;
                }
                resolve(result as T);
            };

            const onKeypress = (_text: string, key: Keypress) => {
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
        this.liveTailTrace = null;
        this.printDuringBusy(() => this.printBlock(this.renderMarkdownBlock(normalized), false));
    }

    writeWarning(message: string): void {
        if (this.destroyed) return;
        const normalized = this.normalizeNewlines(message);
        if (normalized.trim().length === 0) return;
        this.liveTailTrace = null;
        this.printDuringBusy(() => this.printBlock(this.renderWarningBlock(normalized), false));
    }

    writeUser(message: string): void {
        if (this.destroyed) return;
        const normalized = this.normalizeNewlines(message);
        if (normalized.length === 0) return;
        this.liveTailTrace = null;
        this.printDuringBusy(() => this.printBlock(this.renderUserBlock(normalized), false));
    }

    writeThinking(message: string): void {
        if (this.destroyed) return;
        const normalized = this.normalizeNewlines(message);
        if (normalized.trim().length === 0) return;
        this.liveTailTrace = null;
        this.printDuringBusy(() => this.printBlock(this.renderThinkingBlock(normalized), false));
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
        block.rawText = this.mergeStreamingText(previousRawText, this.normalizeNewlines(text));
        if (!block.started) {
            block.rawText = block.rawText.replace(/^\s+/, "");
            if (block.rawText.trim().length === 0) {
                block.emittedText = block.rawText;
                return;
            }
        }
        const displayRawText = this.getStreamingDisplayText(block);
        const delta = this.getStreamingDelta(block.emittedText, displayRawText);
        if (!delta) return;

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

    finishStreamingBlock(id: string): void {
        const block = this.streamingBlocks.get(id);
        if (!block) return;
        const hadBusyLine = this.bottomArea.isBusyVisible && !this.activeSessionCleanup && this.bottomArea.isBusyLineVisible;
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
        });
        this.streamingBlocks.delete(id);
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
    }

    updateToolCallArguments(id: string, argsText: string, args?: unknown): void {
        const existing = this.toolTraces.get(id);
        if (!existing) return;
        const trace = { ...existing, args: args ?? existing.args, argsText: this.normalizeNewlines(argsText) };
        this.storeToolTrace(trace);
        if (this.toolPrinted.has(id)) this.commitToolTrace(trace, { appendIfStale: false });
    }

    startToolExecution(id: string): void {
        const existing = this.toolTraces.get(id);
        if (!existing) return;
        const trace = { ...existing, status: "running" as ToolTraceStatus, startedAt: existing.startedAt ?? Date.now() };
        this.storeToolTrace(trace);
        if (this.shouldDisplayToolTrace(trace, existing)) this.commitToolTrace(trace);
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
        return true;
    }

    refreshHistory(): void {
        // Intentional no-op. This UI is scrollback-first and append-only.
    }

    setStatus(message: string): void {
        this.statusMessage = message;
    }

    setReasoningLevel(level: string): void {
        this.currentReasoningLevel = level;
    }

    setSessionDetails(lines: SessionDetailLine[]): void {
        this.sessionDetails = lines;
    }

    setBusy(message = "Working"): void {
        if (this.destroyed) return;
        this.bottomArea.setBusy(message);
    }

    setQueuedSteeringMessages(messages: string[]): void {
        this.queuedSteeringMessages = messages.map((message) => this.normalizeNewlines(message).trim()).filter(Boolean);
        this.activeSessionRedraw?.();
    }

    setQueuedMessageEditHandler(handler: (() => string) | null): void {
        this.queuedMessageEditHandler = handler;
    }

    clearBusy(): void {
        this.clearBusyInternal({ showWorkedLine: true });
    }

    cancelActiveInput(): void {
        if (!this.activeSessionReject) return;
        const abortError = new Error("Input cancelled.");
        abortError.name = "AbortError";
        this.activeSessionReject(abortError);
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
        if (this.activeSessionCleanup) {
            const cleanup = this.activeSessionCleanup;
            this.activeSessionCleanup = null;
            cleanup();
        }
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
        const canRewriteTail = !forceNewBlock
            && alreadyPrinted
            && this.liveTailTrace?.id === trace.id
            && renderedRows <= this.liveTailTrace.rows
            && this.liveTailTrace.rows + busyGapRows + transientRows < this.getTerminalHeight();

        if (canRewriteTail) {
            const rowsUp = (this.liveTailTrace?.rows ?? 0) + busyGapRows;
            this.printDuringBusy(() => {
                this.rewriteCurrentTailBlock(rendered, false, rowsUp);
                this.liveTailTrace = { id: trace.id, rows: renderedRows, rendered };
                this.toolPrinted.add(trace.id);
            });
            return true;
        }

        if (!alreadyPrinted || forceNewBlock || appendIfStale) {
            this.printDuringBusy(() => {
                this.printBlock(rendered, false);
                this.liveTailTrace = { id: trace.id, rows: renderedRows, rendered };
                this.toolPrinted.add(trace.id);
            });
            return true;
        }

        return false;
    }

    private clearBusyInternal(options: { showWorkedLine: boolean }): void {
        const elapsedMs = this.bottomArea.clearBusy();
        if (options.showWorkedLine && elapsedMs !== null) this.printWorkedLine(elapsedMs);
        if (this.streamingBlocks.size === 0) this.writeStdout("\u001b[?25h");
    }

    private printWorkedLine(elapsedMs: number): void {
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
        this.bottomArea.withHiddenTransient(() => {
            if (this.bottomArea.isBusyVisible && !this.activeSessionCleanup) {
                this.bottomArea.withHiddenBusyLine(operation);
                return;
            }
            operation(0);
        });
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
            block.rawAppendBuffer = block.rawAppendBuffer.slice(boundary);
            wroteToTerminal = this.writeRenderedMarkdownChunk(block, chunk, true, pendingHiddenBusyGapRows) || wroteToTerminal;
            pendingHiddenBusyGapRows = 0;
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

    private writeRenderedMarkdownChunk(block: StreamingBlockState, rawChunk: string, preserveBoundarySpacing: boolean, hiddenBusyGapRows = 0): boolean {
        if (rawChunk.length === 0) return false;
        if (hiddenBusyGapRows > 0) this.moveCursorUp(hiddenBusyGapRows);
        let wroteToTerminal = hiddenBusyGapRows > 0;
        const startsNewMarkdownBlock = /^\s*(?:```|#{1,6}\s|[-*+]\s|\d+\.\s|>\s?|\|)/.test(rawChunk);
        const shouldReattach = !startsNewMarkdownBlock
            && !rawChunk.startsWith("\n")
            && block.appendColumn > 0
            && (block.cursorDetachedAfterRewrite || !block.printedRawEndsWithNewline);
        const leadingContinuationSpace = shouldReattach && /^[ \t]/.test(rawChunk);
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
        const stdout = process.stdout;
        const wasRaw = stdin.isTTY ? !!stdin.isRaw : false;
        const wasPaused = typeof stdin.isPaused === "function" ? stdin.isPaused() : false;
        if (stdin.isTTY) stdin.setRawMode(true);
        stdin.resume();
        const handler = (text: string, key: Keypress) => onKeypress(text, key);
        let resizeTimer: ReturnType<typeof setTimeout> | null = null;
        const resizeHandler = () => {
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                resizeTimer = null;
                this.activeSessionRedraw?.();
            }, RESIZE_SETTLE_DELAY_MS);
        };
        stdin.on("keypress", handler);
        if (stdout.isTTY) stdout.on("resize", resizeHandler);
        this.writeStdout("\u001b[?25h");
        return () => {
            stdin.off("keypress", handler);
            if (stdout.isTTY) stdout.off("resize", resizeHandler);
            if (resizeTimer) clearTimeout(resizeTimer);
            if (stdin.isTTY) stdin.setRawMode(wasRaw);
            if (wasPaused) stdin.pause();
            this.writeStdout("\u001b[?25h");
            onCleanup();
        };
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
        if (busyStatus) {
            lines.push(this.styleAnsi(this.fitToWidth(busyStatus, width), { fg: "#a3a3a3", dim: true }));
            lines.push("");
        }
        const promptLines = params.showPromptText ? this.wrapPlainTextWords(params.prompt, width) : [];
        lines.push(...promptLines);
        const borderColor = this.getReasoningBorderColor(this.currentReasoningLevel);
        lines.push(this.styleAnsi(PROMPT_BORDER_CHARS.horizontal.repeat(width), { fg: borderColor }));
        const inputLayout = this.buildInputLayout(params.value, width, params.cursor);
        if (params.value.length === 0) {
            lines.push(this.styleAnsi(this.fitToWidth(params.placeholder, width), { fg: "#6b7280", dim: true }));
        } else {
            for (const line of inputLayout.lines) lines.push(line.padEnd(width, " "));
        }
        lines.push(this.styleAnsi(PROMPT_BORDER_CHARS.horizontal.repeat(width), { fg: borderColor }));
        for (let index = 0; index < params.suggestions.length; index += 1) {
            const suggestion = params.suggestions[index]!;
            const raw = `${suggestion.name} — ${suggestion.description}`;
            for (const suggestionLine of this.wrapPlainTextWords(raw, width)) {
                lines.push(index === params.selectedSuggestionIndex
                    ? this.styleAnsi(this.fitToWidth(suggestionLine, width), { fg: "#ffffff", bg: "#1f1f1f" })
                    : this.styleAnsi(suggestionLine, { fg: "#d4d4d4" }));
            }
        }
        return {
            lines: this.needsBlockSeparator ? ["", ...lines] : lines,
            cursorRow: (this.needsBlockSeparator ? 1 : 0) + queuedLines.length + (queuedLines.length > 0 ? 1 : 0) + (busyStatus ? 2 : 0) + promptLines.length + 1 + inputLayout.cursorRow,
            cursorCol: inputLayout.cursorCol,
            cursorVisible: true,
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

    private buildChoiceFrame<T>(prompt: string, options: ChoiceOption<T>[], selectedIndex: number): TransientFrame {
        const width = this.getTransientFrameWidth();
        const lines: string[] = [];
        lines.push(...this.wrapPlainTextWords(prompt, width).map((line) => this.styleAnsi(line, { fg: "#d4d4d4" })));
        lines.push(this.styleAnsi(CHOICE_HINT_TEXT, { fg: "#7b8088", dim: true }));
        lines.push("");
        for (let index = 0; index < options.length; index += 1) {
            const option = options[index]!;
            lines.push(...this.renderChoiceOptionLines(option, index === selectedIndex, width));
        }
        return {
            lines: this.needsBlockSeparator ? ["", ...lines] : lines,
            cursorRow: (this.needsBlockSeparator ? 1 : 0) + Math.max(0, lines.length - 1),
            cursorCol: 0,
            cursorVisible: false,
        };
    }

    private renderChoiceOptionLines<T>(option: ChoiceOption<T>, selected: boolean, width: number): string[] {
        const marker = selected ? "›" : " ";
        const firstPrefix = `${marker} `;
        const continuationPrefix = "  ";
        const descriptionPrefix = "    ";
        const firstWidth = Math.max(1, width - this.getVisibleTextWidth(firstPrefix));
        const continuationWidth = Math.max(1, width - this.getVisibleTextWidth(continuationPrefix));
        const descriptionWidth = Math.max(1, width - this.getVisibleTextWidth(descriptionPrefix));
        const lines: string[] = [];
        const description = option.description?.trim();

        const canRenderInlineDescription = (() => {
            if (!description) return false;
            const inlineGap = 3;
            const descriptionVisibleWidth = this.getVisibleTextWidth(description);
            const labelVisibleWidth = this.getVisibleTextWidth(option.label);
            return descriptionVisibleWidth > 0
                && labelVisibleWidth > 0
                && labelVisibleWidth + inlineGap + descriptionVisibleWidth <= firstWidth;
        })();

        if (description && canRenderInlineDescription) {
            const inlineGap = 3;
            const descriptionVisibleWidth = this.getVisibleTextWidth(description);
            const labelWidth = Math.max(1, firstWidth - descriptionVisibleWidth - inlineGap);
            const labelLines = this.wrapPlainTextWords(option.label, labelWidth);
            const firstLabelLine = labelLines[0] ?? "";
            const paddedLabel = this.getVisibleTextWidth(firstLabelLine) >= labelWidth ? firstLabelLine : `${firstLabelLine}${" ".repeat(labelWidth - this.getVisibleTextWidth(firstLabelLine))}`;
            const firstLine = `${firstPrefix}${paddedLabel}${" ".repeat(inlineGap)}${description}`;
            lines.push(selected
                ? this.styleAnsi(this.fitToWidth(firstLine, width), { fg: "#ffffff", bg: "#1f1f1f" })
                : `${this.styleAnsi(`${firstPrefix}${paddedLabel}${" ".repeat(inlineGap)}`, { fg: "#d4d4d4" })}${this.styleAnsi(description, { fg: "#8f969d", dim: true })}`);

            for (const labelLine of labelLines.slice(1)) {
                const text = `${continuationPrefix}${labelLine}`;
                lines.push(selected
                    ? this.styleAnsi(this.fitToWidth(text, width), { fg: "#ffffff", bg: "#1f1f1f" })
                    : this.styleAnsi(text, { fg: "#d4d4d4" }));
            }

            return lines;
        }

        const labelLines = this.wrapPlainTextWords(option.label, firstWidth);
        for (let index = 0; index < labelLines.length; index += 1) {
            const prefix = index === 0 ? firstPrefix : continuationPrefix;
            const content = index === 0 ? labelLines[0] ?? "" : labelLines[index] ?? "";
            const text = `${prefix}${content}`;
            lines.push(selected
                ? this.styleAnsi(this.fitToWidth(text, width), { fg: "#ffffff", bg: "#1f1f1f" })
                : this.styleAnsi(text, { fg: "#d4d4d4" }));
        }

        if (description) {
            const descriptionLines = this.wrapPlainTextWords(description, descriptionWidth);
            for (const descriptionLine of descriptionLines) {
                const text = `${descriptionPrefix}${descriptionLine}`;
                lines.push(selected
                    ? this.styleAnsi(this.fitToWidth(text, width), { fg: "#b9c0c8", bg: "#1f1f1f", dim: true })
                    : this.styleAnsi(text, { fg: "#8f969d", dim: true }));
            }
        }

        return lines;
    }

    private buildInputLayout(value: string, width: number, cursor: number): { lines: string[]; cursorRow: number; cursorCol: number } {
        if (value.length === 0) return { lines: [""], cursorRow: 0, cursorCol: 0 };
        const lines = this.wrapPlainTextWords(value, width);
        const beforeCursor = this.wrapPlainTextWords(value.slice(0, cursor), width);
        const cursorRow = Math.max(0, beforeCursor.length - 1);
        const cursorCol = this.getVisibleTextWidth(beforeCursor[cursorRow] ?? "");
        return { lines, cursorRow, cursorCol };
    }

    private renderStreamingBlock(block: StreamingBlockState, rawText = block.rawText): string {
        return block.variant === "thinking" ? this.renderThinkingBlock(rawText) : this.renderMarkdownBlock(rawText);
    }

    private getStreamingDelta(previousDisplay: string, nextDisplay: string): string {
        if (nextDisplay.startsWith(previousDisplay)) return nextDisplay.slice(previousDisplay.length);
        const commonPrefix = this.getCommonPrefixLength(previousDisplay, nextDisplay);
        if (commonPrefix >= 32) return nextDisplay.slice(commonPrefix);
        return nextDisplay;
    }

    private getStreamingDisplayText(block: StreamingBlockState): string {
        if (block.variant !== "default") return block.rawText;
        const raw = block.rawText;
        if (raw.endsWith("\n")) return raw;
        const lastNewline = raw.lastIndexOf("\n");
        if (lastNewline < 0) return raw;
        const trailingLine = raw.slice(lastNewline + 1);
        if (!this.isUnstableTrailingMarkdownLine(trailingLine)) return raw;
        return raw.slice(0, lastNewline + 1);
    }

    private isUnstableTrailingMarkdownLine(line: string): boolean {
        return /^\s*\d{1,4}\.?\s*$/.test(line)
            || /^\s*\d{1,4}\.\s+/.test(line)
            || /^\s*[-*+]\s*$/.test(line)
            || /^\s*[-*+]\s+/.test(line)
            || /^\s*#{1,6}\s*$/.test(line)
            || /^\s*#{1,6}\s+/.test(line)
            || /^\s*>\s*$/.test(line)
            || /^\s*>\s+/.test(line)
            || /^\s*`{1,3}[A-Za-z0-9_+#.-]*\s*$/.test(line);
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
        const expand = trace.expanded ? "" : ` (/trace ${trace.displayId} to expand)`;
        return `+${count} more${subject} ${noun}${expand}`;
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

    private renderPanelBlock(lines: Array<{ text: string; style?: AnsiStyle }>, width: number, fillStyle: AnsiStyle): string {
        return this.formatter.renderPanelBlock(lines, width, fillStyle);
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

    private mergeStreamingText(previous: string, incoming: string): string {
        if (!incoming) return previous;
        if (!previous) return incoming;

        // Providers normally send deltas, but some events can resend a full
        // snapshot. Be deliberately conservative: short/common chunks such as
        // spaces, punctuation, "is", or "the" may already appear somewhere in
        // previous output and must still be appended. Dropping them produces the
        // mashed-word output seen in long streams.
        if (incoming === previous) return previous;
        if (incoming.startsWith(previous)) return incoming;
        if (incoming.length > previous.length && incoming.includes(previous)) return incoming;

        // Some providers/proxies occasionally send cumulative snapshots through
        // a field named "delta". If appended literally, the terminal shows the
        // exact repeated growing-prefix pattern reported in real use. Treat a
        // large incoming chunk that restarts with the same opening text as a
        // replacement snapshot, even if the previous buffer was already poisoned
        // by an earlier snapshot append and is no longer a strict prefix.
        if (previous.length >= 80 && incoming.length >= 80) {
            const commonPrefix = this.getCommonPrefixLength(previous, incoming);
            const snapshotThreshold = Math.min(160, Math.floor(incoming.length * 0.6));
            if (commonPrefix >= Math.max(48, snapshotThreshold) || (incoming.length >= 160 && commonPrefix >= 32)) return incoming;
        }

        // Only de-duplicate substantial suffix/prefix overlaps. Tiny overlaps
        // are usually legitimate repeated characters/tokens in streamed deltas.
        const maxOverlap = Math.min(previous.length, incoming.length);
        for (let overlap = maxOverlap; overlap >= 12; overlap -= 1) {
            if (previous.slice(-overlap) === incoming.slice(0, overlap)) return `${previous}${incoming.slice(overlap)}`;
        }

        return `${previous}${incoming}`;
    }

    private getCommonPrefixLength(left: string, right: string): number {
        const max = Math.min(left.length, right.length);
        let index = 0;
        while (index < max && left.charCodeAt(index) === right.charCodeAt(index)) index += 1;
        return index;
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
            default: return { title: { fg: this.getTraceColor(trace.status), bold: true }, body: { fg: "#e5e7eb", bg: "#17181b" } };
        }
    }

    private getTraceTypeFromToolName(toolName: string): KnownToolTraceDetails["type"] | null {
        switch (toolName) {
            case "read": case "write": case "edit": case "web_search": case "file_search": case "code_interpreter": case "mcp": case "local_shell": case "tool_search": return toolName;
            case "run_command": return "local_shell";
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

    private getReasoningBorderColor(level: string): string {
        switch (level) {
            case "off": return "#525252";
            case "minimal": return "#6b7280";
            case "low": return "#22c55e";
            case "medium": return "#eab308";
            case "high": return "#f97316";
            case "xhigh": return "#d946ef";
            default: return "#a3a3a3";
        }
    }

    private getTracePanelWidth(): number { return this.getOutputWidth(); }
    private getTerminalWidth(): number { return process.stdout.columns ?? 80; }
    private getOutputWidth(): number { return Math.max(1, this.getTerminalWidth() - 1); }
    private getTransientFrameWidth(): number { return this.getOutputWidth(); }
    private getTerminalHeight(): number { return process.stdout.rows ?? 24; }
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

    private writeStdout(text: string): void { process.stdout.write(text); }
}
