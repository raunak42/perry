// import fs from "node:fs/promises";
// import { Tool } from "./types";

// export const listFilesTool: Tool = {
//     name: "list_files",
//     definition: {
//         type: "function",
//         name: "list_files",
//         description: "List files and directories in the current project.",
//         parameters: {
//             type: "object",
//             properties: {
//                 path: {
//                     type: "string",
//                     description: "Directory path (default: current directory)",
//                 },
//             },
//             required: ["path"],
//             additionalProperties: false,
//         },
//         strict: true,
//     },
//     execute: async (args) => {
//         let toolResult
//         try {
//             const entries = await fs.readdir(args.path, { withFileTypes: true });

//             toolResult = entries
//                 .map(e => e.isDirectory() ? `[DIR] ${e.name}` : e.name)
//                 .join("\n");
//         } catch (err) {
//             toolResult = `Error listing files: ${(err as Error).message}`;
//         }
//         return toolResult
//     }
// }