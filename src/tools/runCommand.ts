import { spawn } from "node:child_process";
import { Tool } from "./types";

const DEFAULT_TIMEOUT_SECONDS = 300;
const HEARTBEAT_INTERVAL_MS = 1000;

interface RunCommandInput {
    command: string;
    timeout?: number | null;
}

function formatCommandOutput(stdout: string, stderr: string, exitCode?: number | null): string {
    return [
        stdout ? `STDOUT:\n${stdout}` : "",
        stderr ? `STDERR:\n${stderr}` : "",
        exitCode === undefined ? "" : `EXIT CODE: ${exitCode}`,
    ]
        .filter(Boolean)
        .join("\n");
}

function isAllowedRedirectionTarget(target: string): boolean {
    const normalized = target.trim().toLowerCase().replace(/[;|&]+$/, "");
    return normalized === "/dev/null"
        || normalized === "/dev/stdout"
        || normalized === "/dev/stderr"
        || normalized === "&1"
        || normalized === "&2"
        || normalized === "/proc/self/fd/1"
        || normalized === "/proc/self/fd/2";
}

export function detectBlockedFileMutationReason(command: string): string | null {
    const normalized = command.toLowerCase();

    if (/\bsed\b[^\n]*\s-i(?:\b|[^\w-])/.test(normalized)) {
        return "sed -i edits files in place";
    }

    if (/\bperl\b[^\n]*\s-pi(?:\b|[^\w-])/.test(normalized)) {
        return "perl -pi edits files in place";
    }

    if (/\bruby\b[^\n]*\s-pi(?:\b|[^\w-])/.test(normalized)) {
        return "ruby -pi edits files in place";
    }

    if (/\bsponge\b/.test(normalized)) {
        return "sponge writes command output back to files";
    }

    if (/\btee\b/.test(normalized) && !/\btee\b[^\n]*\b(?:\/dev\/null|\/dev\/stdout|\/dev\/stderr)\b/.test(normalized)) {
        return "tee writes command output to files";
    }

    for (const match of command.matchAll(/(?:^|[\s;|&(])(?:\d{0,2})?(>>?)\s*([^\s&|;]+)/g)) {
        const target = match[2] ?? "";
        if (target && !isAllowedRedirectionTarget(target)) {
            return `shell redirection writes to ${target}`;
        }
    }

    if (/\b(?:node|bun)\b[\s\S]*\b(?:writefilesync|writefile|appendfilesync|appendfile|createwritestream|truncate|truncatesync)\b/i.test(command)) {
        return "Node/Bun script appears to write file contents";
    }

    if (/\bpython(?:3)?\b[\s\S]*(?:write_text|write_bytes|\.write\(|open\([^\n]*,[^\n]*["'](?:w|a|x|wb|ab|xb)["'])/i.test(command)) {
        return "Python script appears to write file contents";
    }

    return null;
}

function getTimeoutSeconds(input: RunCommandInput): number | null {
    if (input.timeout === null) return null;
    if (typeof input.timeout === "number" && Number.isFinite(input.timeout) && input.timeout > 0) {
        return Math.max(1, Math.floor(input.timeout));
    }
    return DEFAULT_TIMEOUT_SECONDS;
}

function killProcessGroup(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
    try {
        if (process.platform === "win32") {
            process.kill(pid, signal);
            return;
        }
        process.kill(-pid, signal);
        if (signal === "SIGKILL") return;
        setTimeout(() => {
            try {
                process.kill(-pid, "SIGKILL");
            } catch {
                // Already exited.
            }
        }, 2_000).unref?.();
    } catch {
        try {
            process.kill(pid, signal);
        } catch {
            // Already exited or inaccessible.
        }
    }
}

export const runCommandTool: Tool<RunCommandInput> = {
    name: "run_command",
    definition: {
        type: "function",
        name: "run_command",
        description: `
                      Execute a shell command on the user's machine.
                      
                      This provides broad shell access for non-file-content tasks.
                      
                      Good uses include:
                      - ls, pwd, find, rg
                      - git, bun, node, test runners
                      - package scripts, builds, and repo inspection
                      - other shell tasks where command output matters
                      
                      Do not use this tool to read normal file contents when the read tool can do that.
                      Do not use this tool to modify file contents when the write or edit tools can do that.
                      In-place shell edits and shell-based file rewrites may be rejected.
                      
                      If some CLI tool is not available, ask the user if they allow downloading it.
                      
                      Return the command output and use it to continue reasoning.
`, parameters: {
            type: "object",
            properties: {
                command: {
                    type: "string",
                    description: "The shell command to execute.",
                },
                timeout: {
                    type: ["number", "null"],
                    description: `Timeout in seconds. Use null only for commands that are expected to run indefinitely. Defaults to ${DEFAULT_TIMEOUT_SECONDS} seconds when omitted or invalid.`,
                },
            },
            required: ["command", "timeout"],
            additionalProperties: false,
        },
        strict: true,
    },
    execute: async (args: RunCommandInput, options) => {
        const blockedReason = detectBlockedFileMutationReason(args.command);
        if (blockedReason) {
            return {
                output: [
                    `Blocked run_command: ${blockedReason}.`,
                    `Command: ${args.command}`,
                    "Use read for file contents, write for new files/full rewrites, and edit for precise existing-file changes.",
                ].join("\n"),
                isError: true,
            };
        }

        return new Promise((resolve) => {
            const timeoutSeconds = getTimeoutSeconds(args);
            const proc = spawn(args.command, {
                shell: true,
                cwd: process.cwd(),
                detached: process.platform !== "win32",
                stdio: ["ignore", "pipe", "pipe"],
            });

            let stdout = "";
            let stderr = "";
            let settled = false;
            let timedOut = false;
            let aborted = false;
            const startedAt = Date.now();

            const buildOutput = (exitCode?: number | null): string => {
                const base = formatCommandOutput(stdout, stderr, exitCode);
                if (aborted) {
                    const abortMessage = "Process terminated.";
                    return base ? `${base}\n${abortMessage}` : abortMessage;
                }
                if (!timedOut) return base;
                const timeoutMessage = `Command timed out after ${timeoutSeconds} seconds.`;
                return base ? `${base}\n${timeoutMessage}` : timeoutMessage;
            };

            const emitUpdate = () => {
                options?.onUpdate?.({
                    output: formatCommandOutput(stdout, stderr),
                    isError: false,
                });
            };

            const onAbort = () => {
                if (settled || aborted) return;
                aborted = true;
                if (proc.pid) killProcessGroup(proc.pid);
                emitUpdate();
            };

            const cleanup = () => {
                if (timeoutHandle) clearTimeout(timeoutHandle);
                clearInterval(heartbeatHandle);
                options?.signal?.removeEventListener("abort", onAbort);
            };

            const settle = (exitCode: number | null, isError: boolean) => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve({
                    output: buildOutput(exitCode),
                    isError,
                });
            };

            const timeoutHandle = timeoutSeconds === null
                ? undefined
                : setTimeout(() => {
                    timedOut = true;
                    if (proc.pid) killProcessGroup(proc.pid);
                    emitUpdate();
                }, timeoutSeconds * 1000);
            timeoutHandle?.unref?.();

            const heartbeatHandle = setInterval(() => {
                // Keep the trace alive during silent long-running commands so
                // the user can distinguish a real running command from a frozen UI.
                emitUpdate();
            }, HEARTBEAT_INTERVAL_MS);
            heartbeatHandle.unref?.();

            if (options?.signal?.aborted) {
                onAbort();
            } else {
                options?.signal?.addEventListener("abort", onAbort, { once: true });
            }

            emitUpdate();

            proc.stdout?.on("data", (data) => {
                stdout += data.toString();
                emitUpdate();
            });

            proc.stderr?.on("data", (data) => {
                stderr += data.toString();
                emitUpdate();
            });

            proc.on("error", (err) => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve({
                    output: `Failed to start command: ${err.message}`,
                    isError: true,
                });
            });

            proc.on("close", (code, signal) => {
                const elapsedSeconds = Math.max(0, (Date.now() - startedAt) / 1000).toFixed(1);
                if (aborted) {
                    settle(null, true);
                    return;
                }
                if (timedOut) {
                    stderr = stderr.trimEnd();
                    stderr = `${stderr}${stderr ? "\n" : ""}Timed out after ${timeoutSeconds} seconds (${elapsedSeconds}s elapsed).`;
                    settle(null, true);
                    return;
                }
                if (signal) {
                    stderr = stderr.trimEnd();
                    stderr = `${stderr}${stderr ? "\n" : ""}Command terminated by signal ${signal} after ${elapsedSeconds}s.`;
                    settle(code, true);
                    return;
                }
                settle(code, code !== 0);
            });
        });
    },
};
