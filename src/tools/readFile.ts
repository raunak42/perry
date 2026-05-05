// import fs from "node:fs/promises";
// import { Tool } from "./types";

// export const readFileTool: Tool = {
//     name: "read_file",
//     definition: {
//         type: "function",
//         name: "read_file",
//         description: "Read the contents of a file from the user's current project.",
//         parameters: {
//             type: "object",
//             properties: {
//                 path: {
//                     type: "string",
//                     description: "The relative path of the file to read.",
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
//             toolResult = await fs.readFile(args.path, "utf-8");
//         } catch (err) {
//             toolResult = `Error reading file: ${(err as Error).message}`;
//         }
//         return toolResult
//     }
// }