import { spawn } from "node:child_process";
import { Tool } from "./types";

export const runCommandTool: Tool<{ command: string }> = {
    name: "run_command",
    definition: {
        type: "function",
        name: "run_command",
        description: `
                      Execute a shell command on the user's machine.
                      
                      This provides full access to the system shell.
                      
                      Use standard system tools like:
                      - ls, pwd, cd, find
                      - cat, grep, sed, awk
                      - git, npm, node
                      - or any available CLI tools
                      - if some cli tool is not available, ask the user if they allow to download it
                      
                      Use this tool whenever you need to do anything on the computer.
                      
                      Return the command output and use it to continue reasoning.
`, parameters: {
            type: "object",
            properties: {
                command: {
                    type: "string",
                    description: "The shell command to execute.",
                },
            },
            required: ["command"],
            additionalProperties: false,
        },
        strict: true,
    },
    execute: async (args: { command: string }): Promise<string> => {
        return new Promise((resolve) => {
            console.log(`\n$ ${args.command}\n`);

            const proc = spawn(args.command, {
                shell: true,
                cwd: process.cwd(),
            });

            let stdout = "";
            let stderr = "";

            proc.stdout.on("data", (data) => {
                const text = data.toString();
                process.stdout.write(text);
                stdout += text;
            });

            proc.stderr.on("data", (data) => {
                const text = data.toString();
                process.stderr.write(text);
                stderr += text;
            });

            proc.on("error", (err) => {
                resolve(`Failed to start command: ${err.message}`);
            });

            proc.on("close", (code) => {
                resolve(
                    [
                        stdout ? `STDOUT:\n${stdout}` : "",
                        stderr ? `STDERR:\n${stderr}` : "",
                        `EXIT CODE: ${code}`,
                    ]
                        .filter(Boolean)
                        .join("\n")
                );
            });
        });
    }
}