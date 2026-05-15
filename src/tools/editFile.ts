import fs from "node:fs/promises";
import type { EditTraceDetails } from "./traceDetails";
import type { Tool } from "./types";
import { normalizeToLf, resolveToolPath } from "./fileHelpers";

interface EditInput {
    path: string;
    edits: Array<{
        oldText: string;
        newText: string;
    }>;
}

interface MatchedEdit {
    oldStart: number;
    oldEnd: number;
    newStart: number;
    newEnd: number;
    oldText: string;
    newText: string;
    oldStartLine: number;
    oldEndLine: number;
    newStartLine: number;
    newEndLine: number;
}

interface ChangeGroup {
    oldStartLine: number;
    oldEndLine: number;
    newStartLine: number;
    newEndLine: number;
}

function buildLineStarts(text: string): number[] {
    const starts = [0];
    for (let index = 0; index < text.length; index += 1) {
        if (text[index] === "\n") {
            starts.push(index + 1);
        }
    }
    return starts;
}

function indexToLineNumber(starts: number[], index: number): number {
    let low = 0;
    let high = starts.length - 1;

    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const lineStart = starts[mid] ?? 0;
        const nextLineStart = starts[mid + 1] ?? Number.POSITIVE_INFINITY;

        if (index < lineStart) {
            high = mid - 1;
            continue;
        }

        if (index >= nextLineStart) {
            low = mid + 1;
            continue;
        }

        return mid + 1;
    }

    return starts.length;
}

function getAffectedLineRange(lineStarts: number[], textLength: number, start: number, end: number): {
    startLine: number;
    endLine: number;
} {
    if (textLength === 0) {
        return {
            startLine: 1,
            endLine: 1,
        };
    }

    const safeStart = Math.max(0, Math.min(start, textLength - 1));
    const safeEnd = Math.max(0, Math.min(end > start ? end - 1 : start, textLength - 1));

    return {
        startLine: indexToLineNumber(lineStarts, safeStart),
        endLine: indexToLineNumber(lineStarts, safeEnd),
    };
}

function findUniqueMatch(source: string, needle: string): number {
    if (needle.length === 0) {
        throw new Error("edit.oldText must not be empty.");
    }

    const firstIndex = source.indexOf(needle);
    if (firstIndex === -1) {
        throw new Error("Could not find edit.oldText in the target file.");
    }

    const secondIndex = source.indexOf(needle, firstIndex + 1);
    if (secondIndex !== -1) {
        throw new Error("edit.oldText matched multiple locations. Make it more specific.");
    }

    return firstIndex;
}

function renderLine(prefix: string, lineNumber: number, width: number, text: string): string {
    return `${prefix}${String(lineNumber).padStart(width, " ")} ${text}`;
}

function mergeChangeGroups(groups: ChangeGroup[]): ChangeGroup[] {
    if (groups.length === 0) {
        return [];
    }

    const merged: ChangeGroup[] = [groups[0]!];

    for (const group of groups.slice(1)) {
        const previous = merged[merged.length - 1]!;
        const overlaps = group.oldStartLine <= previous.oldEndLine + 1 || group.newStartLine <= previous.newEndLine + 1;

        if (!overlaps) {
            merged.push(group);
            continue;
        }

        previous.oldEndLine = Math.max(previous.oldEndLine, group.oldEndLine);
        previous.newEndLine = Math.max(previous.newEndLine, group.newEndLine);
    }

    return merged;
}

function sliceInclusive(lines: string[], startLine: number, endLine: number): string[] {
    if (endLine < startLine) {
        return [];
    }
    return lines.slice(startLine - 1, endLine);
}

function buildEditDiffPreview(original: string, updated: string, edits: MatchedEdit[]): {
    diff: string;
    firstChangedLine?: number;
    lastChangedLine?: number;
} {
    if (edits.length === 0) {
        return { diff: "" };
    }

    const contextLines = 5;
    const originalLines = original.split("\n");
    const updatedLines = updated.split("\n");
    const groups = mergeChangeGroups(edits.map((edit) => ({
        oldStartLine: edit.oldStartLine,
        oldEndLine: edit.oldEndLine,
        newStartLine: edit.newStartLine,
        newEndLine: edit.newEndLine,
    })));

    const firstGroup = groups[0]!;
    const lastGroup = groups[groups.length - 1]!;
    const maxLineNumber = Math.max(originalLines.length, updatedLines.length, 1);
    const lineNumberWidth = String(maxLineNumber).length;
    const diffLines: string[] = [];
    let renderedNewLine = 0;

    const pushEllipsis = () => {
        if (diffLines[diffLines.length - 1] !== "...") diffLines.push("...");
    };

    const pushContext = (fromLine: number, toLine: number) => {
        for (let lineNumber = fromLine; lineNumber <= toLine; lineNumber += 1) {
            diffLines.push(renderLine(" ", lineNumber, lineNumberWidth, updatedLines[lineNumber - 1] ?? ""));
        }
    };

    for (const [index, group] of groups.entries()) {
        const contextStart = Math.max(renderedNewLine + 1, group.newStartLine - contextLines, 1);
        if (contextStart > renderedNewLine + 1) pushEllipsis();
        pushContext(contextStart, group.newStartLine - 1);

        const removedLines = sliceInclusive(originalLines, group.oldStartLine, group.oldEndLine);
        removedLines.forEach((line, lineIndex) => {
            diffLines.push(renderLine("-", group.oldStartLine + lineIndex, lineNumberWidth, line));
        });

        const addedLines = sliceInclusive(updatedLines, group.newStartLine, group.newEndLine);
        addedLines.forEach((line, lineIndex) => {
            diffLines.push(renderLine("+", group.newStartLine + lineIndex, lineNumberWidth, line));
        });

        renderedNewLine = Math.max(renderedNewLine, group.newEndLine);
        const nextGroup = groups[index + 1];
        const contextEnd = nextGroup
            ? Math.min(updatedLines.length, group.newEndLine + contextLines, nextGroup.newStartLine - 1)
            : Math.min(updatedLines.length, group.newEndLine + contextLines);
        pushContext(renderedNewLine + 1, contextEnd);
        renderedNewLine = Math.max(renderedNewLine, contextEnd);
    }

    if (renderedNewLine < updatedLines.length) pushEllipsis();

    return {
        diff: diffLines.join("\n"),
        firstChangedLine: firstGroup.newStartLine,
        lastChangedLine: lastGroup.newEndLine,
    };
}

export const editTool: Tool<EditInput, EditTraceDetails> = {
    name: "edit",
    definition: {
        type: "function",
        name: "edit",
        description: "Edit a single file using exact text replacement. Each oldText must match exactly once in the original file.",
        parameters: {
            type: "object",
            properties: {
                path: {
                    type: "string",
                    description: "Path to the file to edit (relative or absolute).",
                },
                edits: {
                    type: "array",
                    description: "Targeted replacements to apply to the original file.",
                    items: {
                        type: "object",
                        properties: {
                            oldText: {
                                type: "string",
                                description: "Exact text to replace. Must match a unique location in the original file.",
                            },
                            newText: {
                                type: "string",
                                description: "Replacement text.",
                            },
                        },
                        required: ["oldText", "newText"],
                        additionalProperties: false,
                    },
                },
            },
            required: ["path", "edits"],
            additionalProperties: false,
        },
        strict: true,
    },
    execute: async (args) => {
        if (!Array.isArray(args.edits) || args.edits.length === 0) {
            return {
                output: "Edit tool requires at least one edit.",
                isError: true,
            };
        }

        try {
            const absolutePath = resolveToolPath(args.path);
            const rawOriginalContent = await fs.readFile(absolutePath, "utf8");
            const usesCrlf = rawOriginalContent.includes("\r\n");
            const normalizedOriginal = normalizeToLf(rawOriginalContent);
            const originalLineStarts = buildLineStarts(normalizedOriginal);

            const locatedEdits = args.edits.map((edit) => {
                const oldText = normalizeToLf(edit.oldText);
                const newText = normalizeToLf(edit.newText);
                const oldStart = findUniqueMatch(normalizedOriginal, oldText);
                return {
                    oldStart,
                    oldEnd: oldStart + oldText.length,
                    oldText,
                    newText,
                };
            }).sort((left, right) => left.oldStart - right.oldStart);

            for (let index = 1; index < locatedEdits.length; index += 1) {
                const previous = locatedEdits[index - 1]!;
                const current = locatedEdits[index]!;
                if (current.oldStart < previous.oldEnd) {
                    throw new Error("Edits overlap in the original file. Merge nearby edits into one replacement.");
                }
            }

            const newContentParts: string[] = [];
            const appliedEdits: MatchedEdit[] = [];
            let readCursor = 0;
            let newCursor = 0;

            for (const edit of locatedEdits) {
                const untouchedSegment = normalizedOriginal.slice(readCursor, edit.oldStart);
                newContentParts.push(untouchedSegment);
                newCursor += untouchedSegment.length;

                const newStart = newCursor;
                newContentParts.push(edit.newText);
                newCursor += edit.newText.length;
                const newEnd = newCursor;

                const oldRange = getAffectedLineRange(originalLineStarts, normalizedOriginal.length, edit.oldStart, edit.oldEnd);

                appliedEdits.push({
                    oldStart: edit.oldStart,
                    oldEnd: edit.oldEnd,
                    newStart,
                    newEnd,
                    oldText: edit.oldText,
                    newText: edit.newText,
                    oldStartLine: oldRange.startLine,
                    oldEndLine: oldRange.endLine,
                    newStartLine: 1,
                    newEndLine: 1,
                });

                readCursor = edit.oldEnd;
            }

            newContentParts.push(normalizedOriginal.slice(readCursor));
            const normalizedUpdated = newContentParts.join("");
            const updatedLineStarts = buildLineStarts(normalizedUpdated);

            for (const edit of appliedEdits) {
                const newRange = getAffectedLineRange(updatedLineStarts, normalizedUpdated.length, edit.newStart, edit.newEnd);
                edit.newStartLine = newRange.startLine;
                edit.newEndLine = newRange.endLine;
            }

            const finalContent = usesCrlf ? normalizedUpdated.replace(/\n/g, "\r\n") : normalizedUpdated;
            await fs.writeFile(absolutePath, finalContent, "utf8");

            const diffPreview = buildEditDiffPreview(normalizedOriginal, normalizedUpdated, appliedEdits);

            return {
                output: `Successfully replaced ${args.edits.length} block(s) in ${args.path}`,
                details: {
                    type: "edit",
                    path: args.path,
                    diff: diffPreview.diff,
                    firstChangedLine: diffPreview.firstChangedLine,
                    lastChangedLine: diffPreview.lastChangedLine,
                },
            };
        } catch (error) {
            return {
                output: `Error editing file: ${(error as Error).message}`,
                isError: true,
                details: {
                    type: "edit",
                    path: args.path,
                    diff: "",
                },
            };
        }
    },
};
