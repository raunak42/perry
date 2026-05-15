import fs from "node:fs/promises";
import path from "node:path";
import { detectLanguageFromPath, resolveToolPath } from "./fileHelpers";
import type { WriteTraceDetails } from "./traceDetails";
import type { Tool } from "./types";

export const writeTool: Tool<{ path: string; content: string }, WriteTraceDetails> = {
    name: "write",
    definition: {
        type: "function",
        name: "write",
        description: "Write content to a file. Creates the file if it does not exist and overwrites it if it does.",
        parameters: {
            type: "object",
            properties: {
                path: {
                    type: "string",
                    description: "Path to the file to write (relative or absolute).",
                },
                content: {
                    type: "string",
                    description: "Content to write to the file.",
                },
            },
            required: ["path", "content"],
            additionalProperties: false,
        },
        strict: true,
    },
    execute: async (args) => {
        try {
            const absolutePath = resolveToolPath(args.path);
            await fs.mkdir(path.dirname(absolutePath), { recursive: true });
            await fs.writeFile(absolutePath, args.content, "utf8");

            return {
                output: `Successfully wrote ${Buffer.byteLength(args.content, "utf8")} bytes to ${args.path}`,
                details: {
                    type: "write",
                    path: args.path,
                    language: detectLanguageFromPath(args.path),
                    content: args.content,
                },
            };
        } catch (error) {
            return {
                output: `Error writing file: ${(error as Error).message}`,
                isError: true,
                details: {
                    type: "write",
                    path: args.path,
                    language: detectLanguageFromPath(args.path),
                    content: args.content,
                },
            };
        }
    },
};
