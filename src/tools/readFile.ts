import fs from "node:fs/promises";
import { detectLanguageFromPath, normalizeToLf, resolveToolPath } from "./fileHelpers";
import type { ReadTraceDetails } from "./traceDetails";
import type { Tool } from "./types";

const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 50 * 1024;
const MAX_IMAGE_BASE64_BYTES = 4.5 * 1024 * 1024;

type ImageDimensions = { width: number; height: number };

function detectSupportedImageMimeType(buffer: Buffer): string | null {
    if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return "image/png";
    }
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        return "image/jpeg";
    }
    if (buffer.length >= 6 && (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a")) {
        return "image/gif";
    }
    if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
        return "image/webp";
    }
    return null;
}

function getImageDimensions(buffer: Buffer, mimeType: string): ImageDimensions | null {
    try {
        if (mimeType === "image/png" && buffer.length >= 24) {
            return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
        }
        if (mimeType === "image/gif" && buffer.length >= 10) {
            return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
        }
        if (mimeType === "image/jpeg") {
            let offset = 2;
            while (offset + 9 < buffer.length) {
                if (buffer[offset] !== 0xff) {
                    offset += 1;
                    continue;
                }
                const marker = buffer[offset + 1];
                offset += 2;
                if (marker === undefined || marker === 0xd8 || marker === 0xd9 || marker === 0x01) continue;
                const length = buffer.readUInt16BE(offset);
                if (length < 2 || offset + length > buffer.length) break;
                const isSof = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
                if (isSof) {
                    return { width: buffer.readUInt16BE(offset + 5), height: buffer.readUInt16BE(offset + 3) };
                }
                offset += length;
            }
        }
        if (mimeType === "image/webp" && buffer.length >= 30) {
            const chunk = buffer.subarray(12, 16).toString("ascii");
            if (chunk === "VP8X") {
                const width = 1 + buffer.readUIntLE(24, 3);
                const height = 1 + buffer.readUIntLE(27, 3);
                return { width, height };
            }
        }
    } catch {
        return null;
    }
    return null;
}

function isLikelyBinary(buffer: Buffer): boolean {
    if (buffer.includes(0)) {
        return true;
    }

    const sample = buffer.subarray(0, Math.min(buffer.length, 2048));
    let suspiciousBytes = 0;

    for (const byte of sample) {
        if (byte === 9 || byte === 10 || byte === 13) {
            continue;
        }
        if (byte < 32 || byte > 126) {
            suspiciousBytes += 1;
        }
    }

    return sample.length > 0 && suspiciousBytes / sample.length > 0.3;
}

function truncateTextContent(text: string, maxLines: number, maxBytes: number): {
    content: string;
    truncated: boolean;
    totalLines: number;
    shownLines: number;
} {
    const lines = normalizeToLf(text).split("\n");
    const selectedLines: string[] = [];
    let usedBytes = 0;

    for (const line of lines) {
        const nextLine = selectedLines.length === 0 ? line : `\n${line}`;
        const nextBytes = Buffer.byteLength(nextLine, "utf8");

        if (selectedLines.length >= maxLines || usedBytes + nextBytes > maxBytes) {
            break;
        }

        selectedLines.push(line);
        usedBytes += nextBytes;
    }

    return {
        content: selectedLines.join("\n"),
        truncated: selectedLines.length < lines.length,
        totalLines: lines.length,
        shownLines: selectedLines.length,
    };
}

export const readTool: Tool<{ path: string; offset?: number | null; limit?: number | null }, ReadTraceDetails> = {
    name: "read",
    definition: {
        type: "function",
        name: "read",
        description: "Read the contents of a file. Supports text files and images (png, jpg/jpeg, gif, webp). Images are sent to the model as attachments. For large text files, prefer offset and limit to read in chunks.",
        parameters: {
            type: "object",
            properties: {
                path: {
                    type: "string",
                    description: "Path to the file to read (relative or absolute).",
                },
                offset: {
                    type: ["number", "null"],
                    description: "Line number to start reading from (1-indexed). Use null when not needed.",
                },
                limit: {
                    type: ["number", "null"],
                    description: "Maximum number of lines to read. Use null when not needed.",
                },
            },
            required: ["path", "offset", "limit"],
            additionalProperties: false,
        },
        strict: true,
    },
    execute: async (args) => {
        try {
            const absolutePath = resolveToolPath(args.path);
            const buffer = await fs.readFile(absolutePath);
            const imageMimeType = detectSupportedImageMimeType(buffer);

            if (imageMimeType) {
                const base64 = buffer.toString("base64");
                const dimensions = getImageDimensions(buffer, imageMimeType);
                const dimensionText = dimensions ? `\n[Image: ${dimensions.width}x${dimensions.height}]` : "";
                const baseText = `Read image file [${imageMimeType}]${dimensionText}`;
                const base64Bytes = Buffer.byteLength(base64, "utf8");

                if (base64Bytes > MAX_IMAGE_BASE64_BYTES) {
                    const output = `${baseText}\n[Image omitted: ${Math.ceil(base64Bytes / 1024 / 1024)}MB base64 payload exceeds ${Math.floor(MAX_IMAGE_BASE64_BYTES / 1024 / 1024)}MB inline image limit.]`;
                    return {
                        output,
                        isError: true,
                        details: {
                            type: "read",
                            path: args.path,
                            language: null,
                            content: output,
                            isImage: true,
                            mimeType: imageMimeType,
                            width: dimensions?.width,
                            height: dimensions?.height,
                            imageBytes: buffer.length,
                            attachedToModel: false,
                            remainingLines: 0,
                        },
                    };
                }

                return {
                    output: baseText,
                    modelOutput: [
                        { type: "input_text", text: baseText },
                        { type: "input_image", detail: "auto", image_url: `data:${imageMimeType};base64,${base64}` },
                    ],
                    details: {
                        type: "read",
                        path: args.path,
                        language: null,
                        content: baseText,
                        isImage: true,
                        mimeType: imageMimeType,
                        width: dimensions?.width,
                        height: dimensions?.height,
                        imageBytes: buffer.length,
                        attachedToModel: true,
                        remainingLines: 0,
                    },
                };
            }

            if (isLikelyBinary(buffer)) {
                const output = `Binary file not shown: ${args.path}`;
                return {
                    output,
                    details: {
                        type: "read",
                        path: args.path,
                        language: null,
                        content: output,
                        startLine: 1,
                        endLine: 1,
                        totalLines: 1,
                        remainingLines: 0,
                    },
                };
            }

            const rawText = normalizeToLf(buffer.toString("utf8"));
            const allLines = rawText.split("\n");
            const startLine = args.offset ? Math.max(1, Math.floor(args.offset)) : 1;

            if (startLine > allLines.length) {
                return {
                    output: `Offset ${startLine} is beyond end of file (${allLines.length} lines).`,
                    isError: true,
                    details: {
                        type: "read",
                        path: args.path,
                        language: detectLanguageFromPath(args.path),
                        content: "",
                        notice: `Offset ${startLine} is beyond end of file (${allLines.length} lines).`,
                        startLine,
                        endLine: startLine,
                        totalLines: allLines.length,
                        remainingLines: 0,
                    },
                };
            }

            const limit = args.limit ? Math.max(1, Math.floor(args.limit)) : undefined;
            const selectedLines = limit
                ? allLines.slice(startLine - 1, startLine - 1 + limit)
                : allLines.slice(startLine - 1);
            const truncatedSelection = truncateTextContent(selectedLines.join("\n"), DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES);
            const shownEndLine = startLine + truncatedSelection.shownLines - 1;
            const linesConsumedBeforeTruncation = limit ? Math.min(limit, selectedLines.length) : selectedLines.length;
            const moreLinesExist = startLine - 1 + linesConsumedBeforeTruncation < allLines.length;

            let notice = "";
            let remainingLines = 0;
            if (truncatedSelection.truncated) {
                const nextOffset = shownEndLine + 1;
                remainingLines = Math.max(0, allLines.length - shownEndLine);
                notice = `[Showing lines ${startLine}-${shownEndLine} of ${allLines.length}. Use offset=${nextOffset} to continue.]`;
            } else if (moreLinesExist) {
                const nextOffset = startLine - 1 + selectedLines.length + 1;
                remainingLines = Math.max(0, allLines.length - (startLine - 1 + selectedLines.length));
                notice = `[${remainingLines} more lines in file. Use offset=${nextOffset} to continue.]`;
            }

            const output = notice
                ? `${truncatedSelection.content}\n\n${notice}`
                : truncatedSelection.content;

            return {
                output,
                details: {
                    type: "read",
                    path: args.path,
                    language: detectLanguageFromPath(args.path),
                    content: truncatedSelection.content,
                    notice: notice || undefined,
                    truncated: truncatedSelection.truncated,
                    startLine,
                    endLine: shownEndLine,
                    totalLines: allLines.length,
                    remainingLines,
                },
            };
        } catch (error) {
            return {
                output: `Error reading file: ${(error as Error).message}`,
                isError: true,
                details: {
                    type: "read",
                    path: args.path,
                    language: detectLanguageFromPath(args.path),
                    content: "",
                    notice: `Error reading file: ${(error as Error).message}`,
                    startLine: args.offset ? Math.max(1, Math.floor(args.offset)) : 1,
                    endLine: args.offset ? Math.max(1, Math.floor(args.offset)) : 1,
                    remainingLines: 0,
                },
            };
        }
    },
};
