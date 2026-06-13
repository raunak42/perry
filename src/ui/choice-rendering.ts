import type { ChoiceOption } from "./types";
import type { AnsiStyle, TerminalFormatter } from "./terminal-formatting";

export const CHOICE_HINT_TEXT = "↑/↓ move · Enter select · Ctrl+C cancel";

const CHOICE_SELECTED_TEXT_STYLE: AnsiStyle = { fg: "#48d1cc", bold: true };
const CHOICE_SELECTED_ROW_STYLE: AnsiStyle = { bg: "#1f1f1f" };
const CHOICE_OPTION_HORIZONTAL_PADDING = 1;
const CHOICE_OPTION_VERTICAL_PADDING_ROWS = 0;
const CHOICE_MAX_VISIBLE_OPTIONS = 10;

export function renderChoiceOptionsWindow<T>(
    options: readonly ChoiceOption<T>[],
    selectedIndex: number,
    width: number,
    formatter: TerminalFormatter,
): string[] {
    const lines: string[] = [];
    const visibleOptions = getVisibleChoiceWindow(options, selectedIndex);
    for (let visibleIndex = visibleOptions.start; visibleIndex < visibleOptions.end; visibleIndex += 1) {
        const option = options[visibleIndex]!;
        lines.push(...renderChoiceOptionLines(option, visibleIndex === selectedIndex, width, formatter));
    }
    if (options.length > CHOICE_MAX_VISIBLE_OPTIONS) {
        lines.push(renderChoicePositionIndicator(selectedIndex, options.length, width, formatter));
    }
    return lines;
}

function getVisibleChoiceWindow<T>(options: readonly T[], selectedIndex: number): { start: number; end: number } {
    if (options.length <= CHOICE_MAX_VISIBLE_OPTIONS) return { start: 0, end: options.length };
    const maxStart = Math.max(0, options.length - CHOICE_MAX_VISIBLE_OPTIONS);
    const halfWindow = Math.floor(CHOICE_MAX_VISIBLE_OPTIONS / 2);
    const start = Math.min(maxStart, Math.max(0, selectedIndex - halfWindow));
    return { start, end: Math.min(options.length, start + CHOICE_MAX_VISIBLE_OPTIONS) };
}

function renderChoicePositionIndicator(selectedIndex: number, total: number, width: number, formatter: TerminalFormatter): string {
    const label = `(${Math.min(total, Math.max(0, selectedIndex) + 1)}/${total})`;
    return formatter.styleAnsi(formatter.fitToWidth(label, width), { fg: "#8aa9c8", dim: true });
}

function renderChoiceOptionLines<T>(option: ChoiceOption<T>, selected: boolean, width: number, formatter: TerminalFormatter): string[] {
    const horizontalPadding = Math.min(CHOICE_OPTION_HORIZONTAL_PADDING, Math.max(0, Math.floor((width - 1) / 2)));
    const innerWidth = Math.max(1, width - horizontalPadding * 2);
    const marker = selected ? "›" : " ";
    const firstPrefix = `${marker} `;
    const continuationPrefix = "  ";
    const descriptionPrefix = "    ";
    const firstWidth = Math.max(1, innerWidth - formatter.getVisibleTextWidth(firstPrefix));
    const descriptionWidth = Math.max(1, innerWidth - formatter.getVisibleTextWidth(descriptionPrefix));
    const contentLines: string[] = [];
    const description = option.description?.trim();

    const canRenderInlineDescription = (() => {
        if (!description) return false;
        const inlineGap = 3;
        const descriptionVisibleWidth = formatter.getVisibleTextWidth(description);
        const labelVisibleWidth = formatter.getVisibleTextWidth(option.label);
        return descriptionVisibleWidth > 0
            && labelVisibleWidth > 0
            && labelVisibleWidth + inlineGap + descriptionVisibleWidth <= firstWidth;
    })();

    if (description && canRenderInlineDescription) {
        const inlineGap = 3;
        const descriptionVisibleWidth = formatter.getVisibleTextWidth(description);
        const labelWidth = Math.max(1, firstWidth - descriptionVisibleWidth - inlineGap);
        const labelLines = formatter.wrapPlainTextWords(option.label, labelWidth);
        const firstLabelLine = labelLines[0] ?? "";
        const paddedLabel = formatter.getVisibleTextWidth(firstLabelLine) >= labelWidth
            ? firstLabelLine
            : `${firstLabelLine}${" ".repeat(labelWidth - formatter.getVisibleTextWidth(firstLabelLine))}`;
        const firstLine = `${firstPrefix}${paddedLabel}${" ".repeat(inlineGap)}${description}`;
        contentLines.push(selected
            ? formatter.styleAnsi(firstLine, CHOICE_SELECTED_TEXT_STYLE)
            : `${formatter.styleAnsi(`${firstPrefix}${paddedLabel}${" ".repeat(inlineGap)}`, { fg: "#d4d4d4" })}${formatter.styleAnsi(description, { fg: "#8f969d", dim: true })}`);

        for (const labelLine of labelLines.slice(1)) {
            const text = `${continuationPrefix}${labelLine}`;
            contentLines.push(selected
                ? formatter.styleAnsi(text, CHOICE_SELECTED_TEXT_STYLE)
                : formatter.styleAnsi(text, { fg: "#d4d4d4" }));
        }

        return renderChoiceOptionComponent(contentLines, selected, width, horizontalPadding, formatter);
    }

    const labelLines = formatter.wrapPlainTextWords(option.label, firstWidth);
    for (let index = 0; index < labelLines.length; index += 1) {
        const prefix = index === 0 ? firstPrefix : continuationPrefix;
        const content = index === 0 ? labelLines[0] ?? "" : labelLines[index] ?? "";
        const text = `${prefix}${content}`;
        contentLines.push(selected
            ? formatter.styleAnsi(text, CHOICE_SELECTED_TEXT_STYLE)
            : formatter.styleAnsi(text, { fg: "#d4d4d4" }));
    }

    if (description) {
        const descriptionLines = formatter.wrapPlainTextWords(description, descriptionWidth);
        for (const descriptionLine of descriptionLines) {
            const text = `${descriptionPrefix}${descriptionLine}`;
            contentLines.push(selected
                ? formatter.styleAnsi(text, CHOICE_SELECTED_TEXT_STYLE)
                : formatter.styleAnsi(text, { fg: "#8f969d", dim: true }));
        }
    }

    return renderChoiceOptionComponent(contentLines, selected, width, horizontalPadding, formatter);
}

function renderChoiceOptionComponent(
    contentLines: string[],
    selected: boolean,
    width: number,
    horizontalPadding: number,
    formatter: TerminalFormatter,
): string[] {
    const lines: string[] = [];
    const paddingLine = selected ? formatter.styleAnsi(" ".repeat(width), CHOICE_SELECTED_ROW_STYLE) : "";
    for (let index = 0; index < CHOICE_OPTION_VERTICAL_PADDING_ROWS; index += 1) {
        lines.push(paddingLine);
    }
    for (const contentLine of contentLines.length > 0 ? contentLines : [""]) {
        const indented = `${" ".repeat(horizontalPadding)}${contentLine}`;
        lines.push(selected
            ? renderSelectedChoiceLine(indented, width, formatter)
            : indented);
    }
    for (let index = 0; index < CHOICE_OPTION_VERTICAL_PADDING_ROWS; index += 1) {
        lines.push(paddingLine);
    }
    return lines;
}

function renderSelectedChoiceLine(content: string, width: number, formatter: TerminalFormatter): string {
    const visible = formatter.getVisibleTextWidth(content);
    const padded = visible >= width ? content : `${content}${" ".repeat(width - visible)}`;
    return formatter.styleAnsi(padded, CHOICE_SELECTED_ROW_STYLE);
}
