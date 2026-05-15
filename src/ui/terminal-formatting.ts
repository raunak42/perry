const PANEL_VERTICAL_PADDING_LINES = 1;

export interface AnsiStyle {
    fg?: string;
    bg?: string;
    bold?: boolean;
    italic?: boolean;
    dim?: boolean;
    underline?: boolean;
    inverse?: boolean;
    strikethrough?: boolean;
}

/**
 * Centralized terminal formatting utility.
 *
 * All terminal-visible rich text should flow through this module so assistant
 * responses, thinking traces, tool traces, prompts, panels, wrapping, ANSI
 * styling, and code snippets stay visually consistent.
 */
export class TerminalFormatter {
    constructor(private readonly getWidth: () => number) {}

    renderMarkdownBlock(text: string): string {
        return this.renderMarkdownLines(text).join("\n");
    }

    renderMarkdownLines(text: string): string[] {
        const normalized = this.normalizeNewlines(text).trimEnd();
        if (normalized.length === 0) return [];
        const lines = normalized.split("\n");
        const rendered: string[] = [];
        for (let index = 0; index < lines.length;) {
            const line = lines[index] ?? "";
            const fenceMatch = line.match(/^\s*```([A-Za-z0-9_+#.-]*)\s*$/);
            if (fenceMatch) {
                const language = fenceMatch[1] ?? "";
                const codeLines: string[] = [];
                index += 1;
                while (index < lines.length && !/^\s*```\s*$/.test(lines[index] ?? "")) codeLines.push(lines[index++] ?? "");
                const closed = index < lines.length;
                if (closed) index += 1;
                rendered.push(...this.renderMarkdownCodeFence(language, codeLines, closed));
                continue;
            }
            if (this.isMarkdownTableStart(lines, index)) {
                const table = this.renderMarkdownTable(lines, index);
                rendered.push(...table.lines);
                index = table.nextIndex;
                continue;
            }
            if (this.isMarkdownHorizontalRule(line)) {
                rendered.push(this.styleAnsi("─".repeat(this.getTerminalWidth()), { fg: "#525252", dim: true }));
                index += 1;
                continue;
            }
            const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
            if (headingMatch) {
                rendered.push(this.renderMarkdownHeading(headingMatch[1]!.length, headingMatch[2] ?? ""));
                index += 1;
                continue;
            }
            const taskMatch = line.match(/^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/);
            if (taskMatch) {
                rendered.push(this.renderMarkdownListItem(taskMatch[1] ?? "", taskMatch[2]?.toLowerCase() === "x" ? "☒" : "☐", taskMatch[3] ?? ""));
                index += 1;
                continue;
            }
            const bulletMatch = line.match(/^(\s*)[-*+]\s+(.*)$/);
            if (bulletMatch) {
                rendered.push(this.renderMarkdownListItem(bulletMatch[1] ?? "", "•", bulletMatch[2] ?? ""));
                index += 1;
                continue;
            }
            const numberedMatch = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
            if (numberedMatch) {
                rendered.push(this.renderMarkdownListItem(numberedMatch[1] ?? "", `${numberedMatch[2]}.`, numberedMatch[3] ?? ""));
                index += 1;
                continue;
            }
            const quoteMatch = line.match(/^\s*>\s?(.*)$/);
            if (quoteMatch) {
                rendered.push(this.renderMarkdownBlockquote(quoteMatch[1] ?? ""));
                index += 1;
                continue;
            }
            if (line.trim().length === 0) {
                rendered.push("");
                index += 1;
                continue;
            }
            const paragraphLines = [line.trim()];
            index += 1;
            while (index < lines.length) {
                const nextLine = lines[index] ?? "";
                if (nextLine.trim().length === 0 || this.isMarkdownSpecialLine(lines, index)) break;
                paragraphLines.push(nextLine.trim());
                index += 1;
            }
            rendered.push(this.renderMarkdownInline(paragraphLines.join(" ")));
        }
        return rendered;
    }

    renderThinkingBlock(text: string): string {
        const theme = this.getThinkingTraceTheme();
        const rendered: string[] = [];
        for (const line of this.renderThinkingMarkdownLines(text)) {
            for (const physicalLine of this.normalizeNewlines(line.text).split("\n")) {
                for (const wrapped of this.wrapStyledLineWords(physicalLine, this.getTerminalWidth())) {
                    rendered.push(this.applyBaseStyle(wrapped, line.style ?? theme));
                }
            }
        }
        return rendered.join("\n");
    }

    renderThinkingMarkdownLines(text: string): Array<{ text: string; style?: AnsiStyle }> {
        const theme = this.getThinkingTraceTheme();
        const titleTheme = this.getThinkingTraceTitleTheme();
        const codeTheme = this.getThinkingTraceCodeTheme();
        const normalized = this.normalizeNewlines(text).trimEnd();
        if (normalized.length === 0) return [];

        const sourceLines = normalized.split("\n");
        const rendered: Array<{ text: string; style?: AnsiStyle }> = [];
        for (let index = 0; index < sourceLines.length;) {
            const line = sourceLines[index] ?? "";
            const fenceMatch = line.match(/^\s*```([A-Za-z0-9_+#.-]*)\s*$/);
            if (fenceMatch) {
                const language = fenceMatch[1] ?? "";
                rendered.push({ text: `\u0060\u0060\u0060${language.trim()}`, style: codeTheme });
                index += 1;
                while (index < sourceLines.length && !/^\s*```\s*$/.test(sourceLines[index] ?? "")) {
                    rendered.push({ text: sourceLines[index++] ?? "", style: codeTheme });
                }
                const closed = index < sourceLines.length;
                if (closed) index += 1;
                if (closed) rendered.push({ text: "\u0060\u0060\u0060", style: codeTheme });
                continue;
            }

            if (this.isMarkdownTableStart(sourceLines, index)) {
                const table = this.renderMarkdownTable(sourceLines, index);
                rendered.push(...table.lines.map((tableLine) => ({ text: this.stripAnsi(tableLine), style: theme })));
                index = table.nextIndex;
                continue;
            }

            if (this.isMarkdownHorizontalRule(line)) {
                rendered.push({ text: "─".repeat(this.getTerminalWidth()), style: { ...theme, fg: "#5f6672" } });
                index += 1;
                continue;
            }

            const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
            if (headingMatch) {
                rendered.push({ text: this.renderThinkingInline(headingMatch[2] ?? ""), style: titleTheme });
                index += 1;
                continue;
            }

            const taskMatch = line.match(/^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/);
            if (taskMatch) {
                const marker = taskMatch[2]?.toLowerCase() === "x" ? "☒" : "☐";
                rendered.push({ text: this.renderThinkingListItem(taskMatch[1] ?? "", marker, taskMatch[3] ?? ""), style: theme });
                index += 1;
                continue;
            }

            const bulletMatch = line.match(/^(\s*)[-*+]\s+(.*)$/);
            if (bulletMatch) {
                rendered.push({ text: this.renderThinkingListItem(bulletMatch[1] ?? "", "•", bulletMatch[2] ?? ""), style: theme });
                index += 1;
                continue;
            }

            const numberedMatch = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
            if (numberedMatch) {
                rendered.push({ text: this.renderThinkingListItem(numberedMatch[1] ?? "", `${numberedMatch[2]}.`, numberedMatch[3] ?? ""), style: theme });
                index += 1;
                continue;
            }

            const quoteMatch = line.match(/^\s*>\s?(.*)$/);
            if (quoteMatch) {
                rendered.push({ text: `${this.styleAnsi("│ ", { fg: "#6f7785", dim: true })}${this.renderThinkingInline(quoteMatch[1] ?? "")}`, style: theme });
                index += 1;
                continue;
            }

            if (line.trim().length === 0) {
                rendered.push({ text: "", style: theme });
                index += 1;
                continue;
            }

            const paragraphLines = [line.trim()];
            index += 1;
            while (index < sourceLines.length) {
                const nextLine = sourceLines[index] ?? "";
                if (nextLine.trim().length === 0 || this.isMarkdownSpecialLine(sourceLines, index)) break;
                paragraphLines.push(nextLine.trim());
                index += 1;
            }
            rendered.push({ text: this.renderThinkingInline(paragraphLines.join(" ")), style: theme });
        }

        return rendered;
    }

    renderPanelBlock(lines: Array<{ text: string; style?: AnsiStyle }>, width: number, fillStyle: AnsiStyle): string {
        const rendered: string[] = [];
        for (let i = 0; i < PANEL_VERTICAL_PADDING_LINES; i += 1) rendered.push(this.stylePanelLine("", width, fillStyle));
        for (const line of lines) {
            for (const physicalLine of this.normalizeNewlines(line.text).split("\n")) {
                for (const wrapped of this.wrapStyledLineWords(physicalLine, width)) rendered.push(this.stylePanelLine(wrapped, width, line.style ?? fillStyle));
            }
        }
        for (let i = 0; i < PANEL_VERTICAL_PADDING_LINES; i += 1) rendered.push(this.stylePanelLine("", width, fillStyle));
        return rendered.join("\n");
    }

    stylePanelLine(text: string, width: number, style: AnsiStyle): string {
        const visible = this.getVisibleTextWidth(text);
        const padded = visible >= width ? text : `${text}${" ".repeat(width - visible)}`;
        return this.applyBaseStyle(padded, style);
    }

    wrapPlainTextWords(text: string, width: number): string[] {
        const out: string[] = [];
        for (const line of this.normalizeNewlines(text).split("\n")) out.push(...this.wrapStyledLineWords(line, width));
        return out.length > 0 ? out : [""];
    }

    wrapStyledLineWords(line: string, width: number): string[] {
        return this.wrapStyledLineWordsWithWidths(line, width, width);
    }

    wrapStyledLineWordsWithWidths(line: string, firstWidth: number, continuationWidth: number): string[] {
        if (firstWidth <= 0 && continuationWidth <= 0) return [line];
        if (line.length === 0) return [""];
        const chars = this.extractStyledCharacters(line);
        if (chars.length === 0) return [""];
        const initialWidth = Math.max(1, firstWidth);
        const continuedWidth = Math.max(1, continuationWidth);
        const wrapped: string[] = [];
        let current: Array<{ char: string; style: string }> = [];
        let lastSpace = -1;
        let currentWidthLimit = initialWidth;
        const recompute = () => {
            lastSpace = -1;
            for (let i = current.length - 1; i >= 0; i -= 1) if (current[i]?.char === " ") { lastSpace = i; break; }
        };
        const advanceToContinuationWidth = () => {
            currentWidthLimit = continuedWidth;
        };

        for (const ch of chars) {
            current.push(ch);
            if (ch.char === " ") lastSpace = current.length - 1;
            if (current.length > currentWidthLimit) {
                if (lastSpace > 0) {
                    wrapped.push(this.renderStyledCharacters(current.slice(0, lastSpace)));
                    current = current.slice(lastSpace + 1);
                    while (current[0]?.char === " ") current.shift();
                    recompute();
                    advanceToContinuationWidth();
                } else {
                    const overflow = current.pop();
                    wrapped.push(this.renderStyledCharacters(current));
                    current = overflow && overflow.char !== " " ? [overflow] : [];
                    lastSpace = -1;
                    advanceToContinuationWidth();
                }
            }
        }
        if (current.length > 0) wrapped.push(this.renderStyledCharacters(current));
        return wrapped.length > 0 ? wrapped : [""];
    }

    measureWrappedLineRows(line: string, width: number): number {
        return Math.max(1, this.wrapStyledLineWords(line, width).length);
    }

    normalizeNewlines(text: string): string {
        return text.replace(/\r\n/g, "\n");
    }

    stripAnsi(text: string): string {
        return text.replace(/\u001b\[[0-9;]*m/g, "");
    }

    getVisibleTextWidth(text: string): number {
        return this.stripAnsi(text).length;
    }

    fitToWidth(text: string, width: number): string {
        const visible = this.getVisibleTextWidth(text);
        return visible > width ? text.slice(0, width) : `${text}${" ".repeat(width - visible)}`;
    }

    openAnsi(style: AnsiStyle): string {
        const parts: string[] = [];
        if (style.bold) parts.push("1");
        if (style.dim) parts.push("2");
        if (style.italic) parts.push("3");
        if (style.underline) parts.push("4");
        if (style.inverse) parts.push("7");
        if (style.strikethrough) parts.push("9");
        if (style.fg) { const rgb = this.hexToRgb(style.fg); if (rgb) parts.push(`38;2;${rgb.r};${rgb.g};${rgb.b}`); }
        if (style.bg) { const rgb = this.hexToRgb(style.bg); if (rgb) parts.push(`48;2;${rgb.r};${rgb.g};${rgb.b}`); }
        return parts.length > 0 ? `\u001b[${parts.join(";")}m` : "";
    }

    resetAnsi(): string {
        return "\u001b[0m";
    }

    styleAnsi(text: string, style: AnsiStyle): string {
        const open = this.openAnsi(style);
        return open ? `${open}${text}${this.resetAnsi()}` : text;
    }

    applyBaseStyle(text: string, style: AnsiStyle): string {
        const open = this.openAnsi(style);
        if (!open) return text;
        const reset = this.resetAnsi();
        return `${open}${text.split(reset).join(`${reset}${open}`)}${reset}`;
    }

    getThinkingTraceTheme(): AnsiStyle { return { fg: "#a4adb8", dim: true, italic: true }; }
    getThinkingTraceTitleTheme(): AnsiStyle { return { fg: "#a4adb8", bold: true, italic: true }; }
    getThinkingTraceCodeTheme(): AnsiStyle { return { fg: "#9da8b8", dim: true }; }

    private getTerminalWidth(): number {
        // Never synthesize lines that occupy the terminal's final physical
        // column. Many terminals set the autowrap pending flag at the last
        // column; if we then write an explicit newline, the cursor can advance
        // twice and leave stair-stepped gaps in full-background panels.
        return Math.max(1, this.getWidth() - 1);
    }

    private isMarkdownSpecialLine(lines: string[], index: number): boolean {
        const line = lines[index] ?? "";
        return /^\s*```/.test(line)
            || this.isMarkdownTableStart(lines, index)
            || this.isMarkdownHorizontalRule(line)
            || /^(#{1,6})\s+/.test(line)
            || /^\s*>\s?/.test(line)
            || /^(\s*)[-*+]\s+\[([ xX])\]\s+/.test(line)
            || /^(\s*)[-*+]\s+/.test(line)
            || /^(\s*)(\d+)\.\s+/.test(line);
    }

    private isMarkdownHorizontalRule(line: string): boolean {
        return /^\s{0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})\s*$/.test(line);
    }

    private renderThinkingListItem(indent: string, marker: string, content: string): string {
        return this.renderHangingLine({
            prefix: `${indent}${this.styleAnsi(marker, { fg: "#8992a2", dim: true })} `,
            continuationPrefix: `${indent}${" ".repeat(this.stripAnsi(marker).length + 1)}`,
            content: this.renderThinkingInline(content.trim()),
        });
    }

    private renderMarkdownHeading(level: number, content: string): string {
        const colors = ["#f5f5f5", "#d8b4fe", "#93c5fd", "#86efac", "#fcd34d", "#cbd5e1"];
        return this.applyBaseStyle(this.renderMarkdownInline(content.trim()), { fg: colors[Math.max(0, Math.min(colors.length - 1, level - 1))] ?? "#f5f5f5", bold: true });
    }

    private renderMarkdownListItem(indent: string, marker: string, content: string): string {
        return this.renderHangingLine({
            prefix: `${indent}${this.styleAnsi(marker, { fg: "#94a3b8", bold: true })} `,
            continuationPrefix: `${indent}${" ".repeat(this.stripAnsi(marker).length + 1)}`,
            content: this.renderMarkdownInline(content.trim()),
        });
    }

    private renderMarkdownBlockquote(content: string): string {
        return this.renderHangingLine({
            prefix: this.styleAnsi("│ ", { fg: "#6b7280", dim: true }),
            continuationPrefix: this.styleAnsi("│ ", { fg: "#6b7280", dim: true }),
            content: this.applyBaseStyle(this.renderMarkdownInline(content.trim()), { fg: "#9ca3af", dim: true, italic: true }),
        });
    }

    private renderHangingLine(options: { prefix: string; continuationPrefix: string; content: string }): string {
        const width = this.getTerminalWidth();
        const firstWidth = Math.max(1, width - this.getVisibleTextWidth(options.prefix));
        const continuationWidth = Math.max(1, width - this.getVisibleTextWidth(options.continuationPrefix));
        const wrapped = this.wrapStyledLineWords(options.content, firstWidth);
        if (wrapped.length <= 1) return `${options.prefix}${wrapped[0] ?? ""}`;

        const out = [`${options.prefix}${wrapped[0] ?? ""}`];
        for (const segment of wrapped.slice(1).flatMap((line) => this.wrapStyledLineWords(line, continuationWidth))) {
            out.push(`${options.continuationPrefix}${segment}`);
        }
        return out.join("\n");
    }

    private isMarkdownTableStart(lines: string[], index: number): boolean {
        const header = lines[index]?.trim() ?? "";
        const separator = lines[index + 1]?.trim() ?? "";
        return header.includes("|") && /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(separator);
    }

    private renderMarkdownTable(lines: string[], index: number): { lines: string[]; nextIndex: number } {
        const headerCells = this.splitMarkdownTableRow(lines[index] ?? "");
        const rows: string[][] = [];
        let nextIndex = index + 2;
        while (nextIndex < lines.length && (lines[nextIndex] ?? "").includes("|") && (lines[nextIndex] ?? "").trim().length > 0) {
            rows.push(this.splitMarkdownTableRow(lines[nextIndex] ?? ""));
            nextIndex += 1;
        }
        const columnCount = Math.max(headerCells.length, ...rows.map((cells) => cells.length));
        const widths = Array.from({ length: columnCount }, (_, col) => Math.max(3, ...[headerCells[col] ?? "", ...rows.map((cells) => cells[col] ?? "")].map((cell) => cell.length)));
        const edge = this.styleAnsi("|", { fg: "#475569", dim: true });
        const joiner = this.styleAnsi(" | ", { fg: "#475569", dim: true });
        const divider = this.styleAnsi(`|-${widths.map((width) => "-".repeat(width)).join("-|-")}-|`, { fg: "#475569", dim: true });
        const renderRow = (cells: string[], header = false) => `${edge} ${widths.map((width, col) => {
            const inline = this.renderMarkdownInline((cells[col] ?? "").padEnd(width, " "));
            return header ? this.applyBaseStyle(inline, { fg: "#e5e7eb", bold: true }) : inline;
        }).join(joiner)} ${edge}`;
        return { lines: [renderRow(headerCells, true), divider, ...rows.map((cells) => renderRow(cells))], nextIndex };
    }

    private splitMarkdownTableRow(line: string): string[] {
        let trimmed = line.trim();
        if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
        if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
        return trimmed.split("|").map((cell) => cell.trim());
    }

    private renderMarkdownCodeFence(language: string, codeLines: string[], _closed = true): string[] {
        const lang = language.trim();
        return codeLines.map((line) => this.highlightCodeLine(line, lang));
    }

    private renderMarkdownInline(text: string): string {
        const placeholders: string[] = [];
        let rendered = this.stripDecorativeGlyphs(text);
        rendered = rendered.replace(/`([^`\n]+)`/g, (_m, content) => this.stashStyledPlaceholder(placeholders, this.styleAnsi(content, { fg: "#93c5fd" })));
        rendered = rendered.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label, url) => this.stashStyledPlaceholder(placeholders, `${this.styleAnsi(label, { fg: "#93c5fd", underline: true })}${this.styleAnsi(` (${url})`, { fg: "#64748b", dim: true })}`));
        rendered = rendered.replace(/\bhttps?:\/\/[^\s<>()]+/g, (url) => this.stashStyledPlaceholder(placeholders, this.styleAnsi(url, { fg: "#93c5fd", underline: true })));
        rendered = rendered.replace(/==([^=\n]+)==/g, (_m, content) => this.stashStyledPlaceholder(placeholders, this.styleAnsi(content, { fg: "#fde68a", bg: "#3b2f11", bold: true })));
        rendered = rendered.replace(/\*\*\*([^*\n][\s\S]*?)\*\*\*/g, (_m, content) => this.stashStyledPlaceholder(placeholders, this.styleAnsi(content, { fg: "#f5f5f5", bold: true, italic: true })));
        rendered = rendered.replace(/\*\*([^*\n][\s\S]*?)\*\*/g, (_m, content) => this.stashStyledPlaceholder(placeholders, this.styleAnsi(content, { fg: "#f5f5f5", bold: true })));
        rendered = rendered.replace(/~~([^~\n][\s\S]*?)~~/g, (_m, content) => this.stashStyledPlaceholder(placeholders, this.styleAnsi(content, { fg: "#9ca3af", dim: true, strikethrough: true })));
        rendered = rendered.replace(/(^|[^*])\*([^*\n][\s\S]*?)\*(?!\*)/g, (_m, prefix, content) => `${prefix}${this.stashStyledPlaceholder(placeholders, this.styleAnsi(content, { fg: "#e5e7eb", italic: true }))}`);
        rendered = rendered.replace(/(^|[^A-Za-z0-9_])_([^_\n][\s\S]*?)_(?![A-Za-z0-9_])/g, (_m, prefix, content) => `${prefix}${this.stashStyledPlaceholder(placeholders, this.styleAnsi(content, { fg: "#e5e7eb", italic: true }))}`);
        return this.restoreStyledPlaceholders(rendered, placeholders);
    }

    private renderThinkingInline(text: string): string {
        const placeholders: string[] = [];
        let rendered = this.stripDecorativeGlyphs(text).trim();
        rendered = rendered.replace(/`([^`\n]+)`/g, (_m, content) => this.stashStyledPlaceholder(placeholders, this.styleAnsi(content, { fg: "#9fb8dc", dim: true })));
        rendered = rendered.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label, url) => this.stashStyledPlaceholder(placeholders, `${this.styleAnsi(label, { fg: "#9fb8dc", dim: true, underline: true })}${this.styleAnsi(` (${url})`, { fg: "#7a8495", dim: true })}`));
        rendered = rendered.replace(/\bhttps?:\/\/[^\s<>()]+/g, (url) => this.stashStyledPlaceholder(placeholders, this.styleAnsi(url, { fg: "#9fb8dc", dim: true, underline: true })));
        rendered = rendered.replace(/==([^=\n]+)==/g, (_m, content) => this.stashStyledPlaceholder(placeholders, this.styleAnsi(content, { fg: "#c6b7d8", bg: "#211a2c", dim: true })));
        rendered = rendered.replace(/\*\*\*([^*\n][\s\S]*?)\*\*\*/g, (_m, content) => this.stashStyledPlaceholder(placeholders, this.styleAnsi(content, { fg: "#a4adb8", bold: true, italic: true })));
        rendered = rendered.replace(/\*\*([^*\n][\s\S]*?)\*\*/g, (_m, content) => this.stashStyledPlaceholder(placeholders, this.styleAnsi(content, { fg: "#a4adb8", bold: true, italic: true })));
        rendered = rendered.replace(/~~([^~\n][\s\S]*?)~~/g, (_m, content) => this.stashStyledPlaceholder(placeholders, this.styleAnsi(content, { fg: "#7f8794", dim: true, strikethrough: true })));
        rendered = rendered.replace(/(^|[^*])\*([^*\n][\s\S]*?)\*(?!\*)/g, (_m, prefix, content) => `${prefix}${this.stashStyledPlaceholder(placeholders, this.styleAnsi(content, { fg: "#aab3c2", dim: true, italic: true }))}`);
        rendered = rendered.replace(/(^|[^A-Za-z0-9_])_([^_\n][\s\S]*?)_(?![A-Za-z0-9_])/g, (_m, prefix, content) => `${prefix}${this.stashStyledPlaceholder(placeholders, this.styleAnsi(content, { fg: "#aab3c2", dim: true, italic: true }))}`);
        return this.restoreStyledPlaceholders(rendered, placeholders);
    }

    private highlightCodeLine(line: string, language: string): string {
        const lang = language.toLowerCase();
        if (["json", "jsonc"].includes(lang)) return this.highlightJsonLine(line);
        if (["bash", "sh", "shell", "zsh"].includes(lang)) return this.highlightShellLine(line);
        if (["diff", "patch"].includes(lang)) return this.highlightDiffLine(line);
        return this.highlightGenericCodeLine(line);
    }

    private highlightJsonLine(line: string): string {
        const placeholders: string[] = [];
        let rendered = line;
        rendered = rendered.replace(/"(?:\\.|[^"\\])*"(?=\s*:)/g, (m) => this.stashStyledPlaceholder(placeholders, this.styleAnsi(m, { fg: "#93c5fd" })));
        rendered = rendered.replace(/"(?:\\.|[^"\\])*"/g, (m) => this.stashStyledPlaceholder(placeholders, this.styleAnsi(m, { fg: "#86efac" })));
        rendered = rendered.replace(/\b-?\d+(?:\.\d+)?\b/g, (m) => this.stashStyledPlaceholder(placeholders, this.styleAnsi(m, { fg: "#fbbf24" })));
        rendered = rendered.replace(/\b(true|false|null)\b/g, (m) => this.stashStyledPlaceholder(placeholders, this.styleAnsi(m, { fg: "#c4b5fd", bold: true })));
        return this.restoreStyledPlaceholders(rendered, placeholders);
    }

    private highlightShellLine(line: string): string {
        const placeholders: string[] = [];
        let rendered = line;
        rendered = rendered.replace(/#.*$/g, (m) => this.stashStyledPlaceholder(placeholders, this.styleAnsi(m, { fg: "#6b7280", dim: true, italic: true })));
        rendered = rendered.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, (m) => this.stashStyledPlaceholder(placeholders, this.styleAnsi(m, { fg: "#86efac" })));
        rendered = rendered.replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, (m) => this.stashStyledPlaceholder(placeholders, this.styleAnsi(m, { fg: "#f9a8d4" })));
        rendered = rendered.replace(/(^|\s)(-{1,2}[A-Za-z0-9_-]+)/g, (_m, prefix, flag) => `${prefix}${this.stashStyledPlaceholder(placeholders, this.styleAnsi(flag, { fg: "#fbbf24" }))}`);
        rendered = rendered.replace(/(^\s*)([A-Za-z0-9_./-]+)/, (_m, prefix, command) => `${prefix}${this.stashStyledPlaceholder(placeholders, this.styleAnsi(command, { fg: "#93c5fd", bold: true }))}`);
        return this.restoreStyledPlaceholders(rendered, placeholders);
    }

    private highlightDiffLine(line: string): string {
        if (line.startsWith("+++ ") || line.startsWith("--- ")) return this.styleAnsi(line, { fg: "#c4b5fd", bold: true });
        if (line.startsWith("+")) return this.styleAnsi(line, { fg: "#86efac" });
        if (line.startsWith("-")) return this.styleAnsi(line, { fg: "#fda4af" });
        if (line.startsWith("@@")) return this.styleAnsi(line, { fg: "#93c5fd", bold: true });
        return this.styleAnsi(line, { fg: "#d1d5db" });
    }

    private highlightGenericCodeLine(line: string): string {
        const placeholders: string[] = [];
        let rendered = line;
        rendered = rendered.replace(/\/\/.*$/g, (m) => this.stashStyledPlaceholder(placeholders, this.styleAnsi(m, { fg: "#6b7280", dim: true, italic: true })));
        rendered = rendered.replace(/#.*$/g, (m) => this.stashStyledPlaceholder(placeholders, this.styleAnsi(m, { fg: "#6b7280", dim: true, italic: true })));
        rendered = rendered.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, (m) => this.stashStyledPlaceholder(placeholders, this.styleAnsi(m, { fg: "#86efac" })));
        rendered = rendered.replace(/\b-?\d+(?:\.\d+)?\b/g, (m) => this.stashStyledPlaceholder(placeholders, this.styleAnsi(m, { fg: "#fbbf24" })));
        rendered = rendered.replace(/\b(const|let|var|function|return|if|else|for|while|switch|case|break|continue|class|interface|type|import|from|export|default|async|await|try|catch|finally|throw|new|extends|implements|public|private|protected|static|yield|def|pass|lambda|None|True|False|and|or|not|in|is)\b/g, (m) => this.stashStyledPlaceholder(placeholders, this.styleAnsi(m, { fg: "#c4b5fd", bold: true })));
        rendered = rendered.replace(/\b([A-Za-z_$][A-Za-z0-9_$]*)(?=\s*\()/g, (m) => this.stashStyledPlaceholder(placeholders, this.styleAnsi(m, { fg: "#67e8f9" })));
        return this.restoreStyledPlaceholders(rendered, placeholders);
    }

    private extractStyledCharacters(line: string): Array<{ char: string; style: string }> {
        const chars: Array<{ char: string; style: string }> = [];
        const ansiRegex = /\u001b\[[0-9;]*m/g;
        let activeStyle = "";
        let lastIndex = 0;
        for (const match of line.matchAll(ansiRegex)) {
            const matchIndex = match.index ?? 0;
            for (const char of line.slice(lastIndex, matchIndex)) chars.push({ char, style: activeStyle });
            const ansi = match[0] ?? "";
            activeStyle = ansi === this.resetAnsi() ? "" : `${activeStyle}${ansi}`;
            lastIndex = matchIndex + ansi.length;
        }
        for (const char of line.slice(lastIndex)) chars.push({ char, style: activeStyle });
        return chars;
    }

    private renderStyledCharacters(chars: Array<{ char: string; style: string }>): string {
        let out = "";
        let active = "";
        for (const ch of chars) {
            if (ch.style !== active) {
                if (active) out += this.resetAnsi();
                if (ch.style) out += ch.style;
                active = ch.style;
            }
            out += ch.char;
        }
        if (active) out += this.resetAnsi();
        return out;
    }

    private stashStyledPlaceholder(placeholders: string[], value: string): string {
        return String.fromCharCode(0xe000 + placeholders.push(value) - 1);
    }

    private restoreStyledPlaceholders(text: string, placeholders: string[]): string {
        return text
            .replace(/[\ue000-\uf8ff]/g, (token) => placeholders[token.charCodeAt(0) - 0xe000] ?? token)
            .replace(/[\ue000-\uf8ff]/g, "");
    }

    private stripDecorativeGlyphs(text: string): string {
        return text
            .replace(/[\ue000-\uf8ff]/g, "")
            .replace(/[\u{1f300}-\u{1faff}]\ufe0f?/gu, "")
            .replace(/[\u2600-\u27bf]\ufe0f?/g, "")
            .replace(/\ufe0f/g, "")
            .replace(/[ \t]{2,}/g, " ");
    }

    private hexToRgb(color: string): { r: number; g: number; b: number } | null {
        const value = color.replace(/^#/, "");
        if (!/^[0-9a-fA-F]{6}$/.test(value)) return null;
        return { r: Number.parseInt(value.slice(0, 2), 16), g: Number.parseInt(value.slice(2, 4), 16), b: Number.parseInt(value.slice(4, 6), 16) };
    }
}
