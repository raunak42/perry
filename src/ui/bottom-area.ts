import type { TerminalFormatter } from "./terminal-formatting";

export interface TransientFrame {
    lines: string[];
    cursorRow: number;
    cursorCol: number;
    cursorVisible: boolean;
    width?: number;
    busyStatusRow?: number;
}

export interface BottomAreaOptions {
    write: (text: string) => void;
    getWidth: () => number;
    getNeedsBlockSeparator: () => boolean;
    beginBlock: () => void;
    canShowBusyLine: () => boolean;
    isInputActive: () => boolean;
    requestInputRedraw: () => void;
    formatter: TerminalFormatter;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Tail-local bottom area for transient terminal UI.
 *
 * This component owns the loader line and prompt/choice frames. It deliberately
 * does not pin itself to the viewport bottom; it only manages the current
 * terminal tail so committed scrollback remains append-only and copyable.
 */
export class BottomArea {
    private busyMessage: string | null = null;
    private busySpinnerVisible = false;
    private busySpinnerFrameIndex = 0;
    private busySpinnerTimer: ReturnType<typeof setInterval> | null = null;
    private busyStartedAt: number | null = null;
    private busyLineVisible = false;
    private busyLineGapRows = 0;
    private activeTransient: TransientFrame | null = null;
    private transientVisible = false;

    constructor(private readonly options: BottomAreaOptions) {}

    get isBusyVisible(): boolean {
        return this.busySpinnerVisible;
    }

    get isBusyLineVisible(): boolean {
        return this.busyLineVisible;
    }

    get busyGapRows(): number {
        return this.busyLineVisible ? this.busyLineGapRows : 0;
    }

    get hasActiveTransient(): boolean {
        return this.activeTransient !== null;
    }

    get activeTransientRows(): number {
        return this.activeTransient && this.transientVisible
            ? this.measureTransientFrame(this.activeTransient).totalScreenRows
            : 0;
    }

    getBusyStatusText(): string | null {
        if (!this.busyMessage || !this.busySpinnerVisible) return null;
        const spinner = SPINNER_FRAMES[this.busySpinnerFrameIndex] ?? SPINNER_FRAMES[0];
        return this.formatBusyLine(spinner);
    }

    setBusy(message = "Working"): void {
        this.busyMessage = message;
        if (!this.busySpinnerVisible || this.busyStartedAt === null) {
            this.busyStartedAt = Date.now();
            this.busySpinnerFrameIndex = 0;
        }
        this.busySpinnerVisible = true;
        this.startBusySpinner();
        if (this.options.isInputActive()) this.options.requestInputRedraw();
        else this.writeBusyLine();
    }

    clearBusy(): number | null {
        const elapsedMs = this.busySpinnerVisible && this.busyStartedAt !== null
            ? Math.max(0, Date.now() - this.busyStartedAt)
            : null;
        this.busyMessage = null;
        this.stopBusySpinner();
        this.busyStartedAt = null;
        if (!this.busySpinnerVisible) return elapsedMs;
        this.busySpinnerVisible = false;
        if (this.options.isInputActive()) this.options.requestInputRedraw();
        else this.clearBusyLineOnly();
        return elapsedMs;
    }

    clearBusyLineOnly(): void {
        this.hideBusyLine();
    }

    hideBusyLine(): number {
        if (!this.busyLineVisible) return 0;
        const hiddenGapRows = this.busyLineGapRows;
        this.options.write("\r\u001b[2K");
        this.busyLineVisible = false;
        this.busyLineGapRows = 0;
        return hiddenGapRows;
    }

    restoreBusyLine(options?: { preserveGapRows?: number }): void {
        this.writeBusyLine(options?.preserveGapRows);
    }

    withHiddenBusyLine<T>(operation: (hiddenBusyGapRows: number) => T): T {
        const shouldRestore = this.busySpinnerVisible && !this.options.isInputActive();
        if (shouldRestore) {
            const hiddenBusyGapRows = this.hideBusyLine();
            let result: T | undefined;
            let completed = false;
            try {
                result = operation(hiddenBusyGapRows);
                completed = true;
                return result;
            } finally {
                // If the operation explicitly returns false, it did not emit any
                // terminal content. Restore the loader in the exact row it was
                // cleared from and keep the old gap accounting. Recomputing from
                // needsBlockSeparator here loses the stream/loader vertical
                // relationship and makes the next append land one row too low.
                this.writeBusyLine(completed && result === false ? hiddenBusyGapRows : undefined);
            }
        }
        return operation(0);
    }

    renderTransient(_previous: TransientFrame | null, next: TransientFrame): TransientFrame {
        if (this.transientVisible && this.activeTransient) this.clearTransientFrame(this.activeTransient);
        this.writeTransientFrame(next);
        this.activeTransient = next;
        this.transientVisible = true;
        return next;
    }

    clearTransient(frame: TransientFrame): void {
        if (this.transientVisible) this.clearTransientFrame(frame);
        if (this.activeTransient === frame) {
            this.activeTransient = null;
            this.transientVisible = false;
        }
    }

    forgetRenderedState(): void {
        this.busyLineVisible = false;
        this.busyLineGapRows = 0;
        this.activeTransient = null;
        this.transientVisible = false;
    }

    withHiddenTransient<T>(operation: () => T, options?: { restore?: boolean }): T {
        const hiddenFrame = this.hideTransient();
        try {
            return operation();
        } finally {
            if (options?.restore !== false && hiddenFrame && this.activeTransient === hiddenFrame && !this.transientVisible) {
                // The operation may have changed block spacing or busy state.
                // Rebuild the prompt/choice frame instead of restoring a stale
                // snapshot, otherwise the next stream append can use the wrong
                // tail relationship and erase/repeat nearby text.
                this.options.requestInputRedraw();
            }
        }
    }

    private hideTransient(): TransientFrame | null {
        if (!this.activeTransient || !this.transientVisible) return null;
        const frame = this.activeTransient;
        this.clearTransientFrame(frame);
        this.transientVisible = false;
        return frame;
    }

    private writeTransientFrame(frame: TransientFrame): void {
        this.options.write(frame.cursorVisible ? "\u001b[?25h" : "\u001b[?25l");
        this.options.write(frame.lines.join("\n"));
        this.positionTransientCursor(frame);
    }

    private clearTransientFrame(frame: TransientFrame): void {
        const metrics = this.measureTransientFrame(frame);
        this.options.write("\r");
        if (metrics.cursorScreenRowOffset > 0) this.options.write(`\u001b[${metrics.cursorScreenRowOffset}A`);
        this.options.write("\r\u001b[J");
    }

    destroy(): void {
        this.clearBusy();
        this.options.write("\u001b[?25h");
    }

    private startBusySpinner(): void {
        if (this.busySpinnerTimer) return;
        this.busySpinnerTimer = setInterval(() => {
            if (!this.busyMessage || !this.busySpinnerVisible) return;
            this.busySpinnerFrameIndex = (this.busySpinnerFrameIndex + 1) % SPINNER_FRAMES.length;
            if (this.options.isInputActive()) {
                if (!this.updateTransientBusyStatusLine()) this.options.requestInputRedraw();
                return;
            }
            this.writeBusyLine();
        }, 100);
    }

    private stopBusySpinner(): void {
        if (!this.busySpinnerTimer) return;
        clearInterval(this.busySpinnerTimer);
        this.busySpinnerTimer = null;
    }

    private writeBusyLine(preserveGapRows?: number): void {
        if (!this.busyMessage || !this.busySpinnerVisible || this.options.isInputActive()) return;
        if (!this.options.canShowBusyLine()) return;
        if (!this.busyLineVisible) {
            if (preserveGapRows !== undefined) {
                this.busyLineGapRows = preserveGapRows;
            } else {
                this.busyLineGapRows = this.options.getNeedsBlockSeparator() ? 1 : 0;
                this.options.beginBlock();
            }
        }
        const spinner = SPINNER_FRAMES[this.busySpinnerFrameIndex] ?? SPINNER_FRAMES[0];
        const line = this.options.formatter.styleAnsi(
            this.options.formatter.fitToWidth(this.formatBusyLine(spinner), this.options.getWidth()),
            { fg: "#a3a3a3", dim: true },
        );
        this.options.write("\u001b[?25l");
        this.options.write(`\r\u001b[2K${line}`);
        this.busyLineVisible = true;
    }

    private formatBusyLine(spinner: string): string {
        const elapsed = this.busyStartedAt === null ? "" : ` · ${this.formatBusyElapsedDuration()}`;
        return `${spinner} ${this.busyMessage ?? "Working"}${elapsed}`;
    }

    private formatBusyElapsedDuration(): string {
        const totalSeconds = this.getBusyElapsedSeconds();
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
        if (minutes > 0) return `${minutes}m ${seconds}s`;
        return `${seconds}s`;
    }

    private getBusyElapsedSeconds(): number {
        return this.busyStartedAt === null ? 0 : Math.max(0, Math.floor((Date.now() - this.busyStartedAt) / 1000));
    }

    private updateTransientBusyStatusLine(): boolean {
        if (!this.activeTransient || !this.transientVisible || this.activeTransient.busyStatusRow === undefined) return false;
        if (!this.busyMessage || !this.busySpinnerVisible) return false;
        const lineIndex = this.activeTransient.busyStatusRow;
        if (lineIndex < 0 || lineIndex >= this.activeTransient.lines.length) return false;
        const spinner = SPINNER_FRAMES[this.busySpinnerFrameIndex] ?? SPINNER_FRAMES[0];
        const width = this.getFrameWidth(this.activeTransient);
        const line = this.options.formatter.styleAnsi(
            this.options.formatter.fitToWidth(this.formatBusyLine(spinner), width),
            { fg: "#a3a3a3", dim: true },
        );
        this.activeTransient.lines[lineIndex] = line;
        this.rewriteTransientLine(this.activeTransient, lineIndex, line);
        return true;
    }

    private rewriteTransientLine(frame: TransientFrame, lineIndex: number, line: string): void {
        const targetScreenRowOffset = this.measureTransientRowsBeforeLine(frame, lineIndex);
        const { cursorScreenRowOffset } = this.measureTransientFrame(frame);
        const relativeRows = cursorScreenRowOffset - targetScreenRowOffset;
        const cursorCol = this.getCursorPhysicalColumn(frame);

        this.options.write("\u001b[?25l");
        this.options.write("\r");
        if (relativeRows > 0) this.options.write(`\u001b[${relativeRows}A`);
        else if (relativeRows < 0) this.options.write(`\u001b[${Math.abs(relativeRows)}B`);
        this.options.write(`\r\u001b[2K${line}`);
        this.options.write("\r");
        if (relativeRows > 0) this.options.write(`\u001b[${relativeRows}B`);
        else if (relativeRows < 0) this.options.write(`\u001b[${Math.abs(relativeRows)}A`);
        if (cursorCol > 0) this.options.write(`\u001b[${cursorCol}C`);
        if (frame.cursorVisible) this.options.write("\u001b[?25h");
    }

    private measureTransientRowsBeforeLine(frame: TransientFrame, lineIndex: number): number {
        const width = this.getFrameWidth(frame);
        let rows = 0;
        for (let index = 0; index < lineIndex; index += 1) {
            rows += this.options.formatter.measureWrappedLineRows(frame.lines[index] ?? "", width);
        }
        return rows;
    }

    private positionTransientCursor(frame: TransientFrame): void {
        const { totalScreenRows, cursorScreenRowOffset } = this.measureTransientFrame(frame);
        const rowsUpFromBottom = Math.max(0, totalScreenRows - 1 - cursorScreenRowOffset);
        const safeWidth = this.getFrameWidth(frame);
        this.options.write("\r");
        if (rowsUpFromBottom > 0) this.options.write(`\u001b[${rowsUpFromBottom}A`);
        const col = this.getCursorPhysicalColumn(frame);
        if (col > 0) this.options.write(`\u001b[${col}C`);
    }

    private getFrameWidth(frame: TransientFrame): number {
        return Math.max(1, frame.width ?? this.options.getWidth());
    }

    private measureTransientFrame(frame: TransientFrame): { totalScreenRows: number; cursorScreenRowOffset: number } {
        const width = this.getFrameWidth(frame);
        let totalScreenRows = 0;
        let cursorScreenRowOffset = 0;
        for (let index = 0; index < frame.lines.length; index += 1) {
            const rows = this.options.formatter.measureWrappedLineRows(frame.lines[index] ?? "", width);
            if (index < frame.cursorRow) cursorScreenRowOffset += rows;
            totalScreenRows += rows;
        }
        cursorScreenRowOffset += this.getCursorExtraRows(frame);
        return { totalScreenRows, cursorScreenRowOffset };
    }

    private getCursorPhysicalWidth(frame: TransientFrame): number {
        // Transient frames render one column narrower than the real terminal so
        // full-width background/border rows do not trip the terminal autowrap
        // flag. The editable cursor, however, may legitimately sit one cell
        // after a full safe-width input line. Measure cursor placement against
        // the physical width so that end-of-line cursor does not appear on a
        // phantom next row before the prompt frame has grown.
        return Math.max(1, this.getFrameWidth(frame) + 1);
    }

    private getCursorPhysicalColumn(frame: TransientFrame): number {
        return Math.max(0, frame.cursorCol % this.getCursorPhysicalWidth(frame));
    }

    private getCursorExtraRows(frame: TransientFrame): number {
        return Math.floor(Math.max(0, frame.cursorCol) / this.getCursorPhysicalWidth(frame));
    }
}
