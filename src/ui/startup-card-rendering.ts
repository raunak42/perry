import { readFileSync } from "node:fs";
import type { SessionDetailLine, StartupCard } from "./types";
import { type AnsiStyle, TerminalFormatter } from "./terminal-formatting";

export const STARTUP_CARD_BORDER_COLOR = "#48d1cc";

export function readStartupAnsiPreview(path?: string | null): string | null {
    if (!path) return null;
    try {
        const content = readFileSync(path, "utf8");
        return content.length > 0 ? content : null;
    } catch {
        return null;
    }
}

export function renderStartupCardBlock(
    card: StartupCard,
    ansiPreview: string | null,
    width: number,
    formatter: TerminalFormatter,
): string {
    const borderStyle: AnsiStyle = { fg: STARTUP_CARD_BORDER_COLOR, bold: true };
    const titleStyle: AnsiStyle = { fg: "#ffffff", bold: true };
    const metaStyle: AnsiStyle = { fg: "#d9fbf8" };
    const innerWidth = Math.max(20, width - 4);
    const title = card.subtitle ? `${card.title} — ${card.subtitle}` : card.title;
    const rows: Array<{ text: string; style?: AnsiStyle }> = [{ text: title, style: titleStyle }];

    const topLabel = ` ${card.title} `;
    const horizontal = "─".repeat(Math.max(0, innerWidth - formatter.getVisibleTextWidth(topLabel)));
    const lines = [formatter.styleAnsi(`┌${topLabel}${horizontal}┐`, borderStyle)];
    lines.push(...rows.flatMap((row) => renderBorderedStartupRows(row.text, innerWidth, row.style ?? metaStyle, borderStyle, formatter)));

    if ((card.imagePath || card.ansiImagePath) && ansiPreview) {
        const renderedPreview = renderStartupAnsiPreview(ansiPreview, card, formatter);
        lines.push(...renderBorderedAnsiImageRows(renderedPreview, innerWidth, borderStyle, formatter));
    }

    for (const line of card.lines) {
        lines.push(...renderStartupDetailRows(line, innerWidth, metaStyle, formatter)
            .flatMap((row) => renderBorderedStartupRows(row.text, innerWidth, row.style ?? metaStyle, borderStyle, formatter)));
    }
    lines.push(formatter.styleAnsi(`└${"─".repeat(innerWidth)}┘`, borderStyle));
    return lines.join("\n");
}

function renderStartupAnsiPreview(ansiPreview: string, card: StartupCard, formatter: TerminalFormatter): string {
    const dimensions = getAnsiPreviewDimensions(ansiPreview, formatter);
    if (card.ansiImageMaxWidth === undefined && card.ansiImageMaxHeight === undefined) return ansiPreview;

    const targetWidth = card.ansiImageMaxWidth ?? dimensions.width;
    const targetHeight = card.ansiImageMaxHeight ?? dimensions.height;
    if (targetWidth === dimensions.width && targetHeight === dimensions.height) return ansiPreview;
    return resizeAnsiPreview(ansiPreview, targetWidth, targetHeight, formatter);
}

function resizeAnsiPreview(ansiPreview: string, targetWidth: number, targetHeight: number, formatter: TerminalFormatter): string {
    const sourceLines = ansiPreview.split("\n").filter((line) => line.length > 0);
    if (sourceLines.length === 0) return "";
    const boundedHeight = Math.max(1, Math.min(targetHeight, sourceLines.length));
    const rowScale = sourceLines.length / boundedHeight;
    const sampledRows: string[] = [];
    for (let row = 0; row < boundedHeight; row += 1) {
        const sourceRow = Math.min(sourceLines.length - 1, Math.floor((row + 0.5) * rowScale));
        sampledRows.push(resizeAnsiLine(sourceLines[sourceRow], targetWidth, formatter));
    }
    return sampledRows.join("\n");
}

function resizeAnsiLine(line: string, targetWidth: number, formatter: TerminalFormatter): string {
    const cells = parseAnsiLineCells(line, formatter);
    if (cells.length === 0 || targetWidth <= 0) return "";
    const boundedWidth = Math.max(1, Math.min(targetWidth, cells.length));
    if (boundedWidth === cells.length) return line;
    const scale = cells.length / boundedWidth;
    const sampled: string[] = [];
    for (let column = 0; column < boundedWidth; column += 1) {
        const sourceColumn = Math.min(cells.length - 1, Math.floor((column + 0.5) * scale));
        sampled.push(cells[sourceColumn]);
    }
    return `${sampled.join("")}\u001b[0m`;
}

function parseAnsiLineCells(line: string, formatter: TerminalFormatter): string[] {
    const cells: string[] = [];
    let activeAnsi = "";
    for (let index = 0; index < line.length;) {
        const escapeMatch = line.slice(index).match(/^\u001b\[[0-?]*[ -/]*[@-~]/);
        if (escapeMatch) {
            const sequence = escapeMatch[0];
            activeAnsi = sequence === "\u001b[0m" ? "" : sequence;
            index += sequence.length;
            continue;
        }
        const codePoint = line.codePointAt(index);
        if (codePoint === undefined) break;
        const char = String.fromCodePoint(codePoint);
        const charWidth = formatter.getVisibleTextWidth(char);
        if (charWidth > 0) cells.push(`${activeAnsi}${char}`);
        index += char.length;
    }
    return cells;
}

function getAnsiPreviewDimensions(ansiPreview: string, formatter: TerminalFormatter): { width: number; height: number } {
    const lines = ansiPreview.split("\n").filter((line) => line.length > 0);
    const width = lines.reduce((max, line) => Math.max(max, formatter.getVisibleTextWidth(line)), 0);
    return { width, height: lines.length };
}

function renderBorderedStartupRows(
    text: string,
    innerWidth: number,
    textStyle: AnsiStyle,
    borderStyle: AnsiStyle,
    formatter: TerminalFormatter,
): string[] {
    return formatter.wrapStyledLineWords(text, innerWidth).map((line) => {
        const visible = formatter.getVisibleTextWidth(line);
        const padded = visible >= innerWidth ? line : `${line}${" ".repeat(innerWidth - visible)}`;
        return `${formatter.styleAnsi("│", borderStyle)}${formatter.styleAnsi(padded, textStyle)}${formatter.styleAnsi("│", borderStyle)}`;
    });
}

function renderBorderedAnsiImageRows(
    ansiPreview: string,
    innerWidth: number,
    borderStyle: AnsiStyle,
    formatter: TerminalFormatter,
): string[] {
    const reset = "\u001b[0m";
    return ansiPreview.split("\n").map((rawLine) => {
        const line = fitAnsiLineToWidth(rawLine, innerWidth, formatter);
        const visible = formatter.getVisibleTextWidth(line);
        const totalPadding = Math.max(0, innerWidth - visible);
        const leftPadding = " ".repeat(Math.floor(totalPadding / 2));
        const rightPadding = " ".repeat(totalPadding - leftPadding.length);
        return `${formatter.styleAnsi("│", borderStyle)}${leftPadding}${line}${reset}${rightPadding}${formatter.styleAnsi("│", borderStyle)}`;
    });
}

function fitAnsiLineToWidth(line: string, width: number, formatter: TerminalFormatter): string {
    const visible = formatter.getVisibleTextWidth(line);
    if (visible <= width) return line;
    let result = "";
    let columns = 0;
    for (let index = 0; index < line.length;) {
        const escapeMatch = line.slice(index).match(/^\u001b\[[0-?]*[ -/]*[@-~]/);
        if (escapeMatch) {
            result += escapeMatch[0];
            index += escapeMatch[0].length;
            continue;
        }
        const codePoint = line.codePointAt(index);
        if (codePoint === undefined) break;
        const char = String.fromCodePoint(codePoint);
        const charWidth = formatter.getVisibleTextWidth(char);
        if (columns + charWidth > width) break;
        result += char;
        columns += charWidth;
        index += char.length;
    }
    return result;
}

function renderStartupDetailRows(
    detail: SessionDetailLine,
    width: number,
    style: AnsiStyle,
    formatter: TerminalFormatter,
): Array<{ text: string; style?: AnsiStyle }> {
    const left = detail.left.trim();
    const right = detail.right?.trim() ?? "";
    if (!left && !right) return [];
    if (!right) return [{ text: left, style }];
    const label = `${left}:`;
    const labelWidth = formatter.getVisibleTextWidth(label);
    const rightWidth = formatter.getVisibleTextWidth(right);
    const gap = width - labelWidth - rightWidth;
    if (gap >= 2) return [{ text: `${label}${" ".repeat(gap)}${right}`, style }];
    return [{ text: label, style }, { text: right, style }];
}
