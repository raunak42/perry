import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { findExecutable } from "./inlineImage";

const MAX_CLIPBOARD_IMAGE_BYTES = 24 * 1024 * 1024;
const CLIPBOARD_COMMAND_TIMEOUT_MS = 2_000;

export type ClipboardPasteSource = "file" | "image";

export interface PastedClipboardImage {
    path: string;
    source: ClipboardPasteSource;
    mimeType?: string;
}

type CommandResult = {
    status: number | null;
    stdout: Buffer;
    stderr: Buffer;
    error?: unknown;
};

type CommandRunner = (command: string, args: string[], options?: { env?: NodeJS.ProcessEnv; timeoutMs?: number; maxBuffer?: number }) => CommandResult;

interface ClipboardImageOptions {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    cwd?: string;
    tempDir?: string;
    commandRunner?: CommandRunner;
    now?: () => Date;
    randomId?: () => string;
}

type ClipboardImageBuffer = {
    data: Buffer;
    mimeType: string;
    extension: string;
};

const MIME_EXTENSIONS: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
};

export async function pasteClipboardImageAsTempFile(options: ClipboardImageOptions = {}): Promise<PastedClipboardImage | null> {
    const env = options.env ?? process.env;
    const platform = options.platform ?? process.platform;
    const runner = options.commandRunner ?? runCommand;
    const cwd = options.cwd ?? process.cwd();

    const existingPath = readClipboardImagePath({ ...options, env, platform, commandRunner: runner, cwd });
    if (existingPath) {
        const mimeType = readSupportedImageMimeType(existingPath);
        return { path: existingPath, source: "file", mimeType: mimeType ?? undefined };
    }

    const directPath = writeClipboardImageDirectly({ ...options, env, platform, commandRunner: runner });
    if (directPath) {
        const mimeType = readSupportedImageMimeType(directPath);
        return { path: directPath, source: "image", mimeType: mimeType ?? undefined };
    }

    const image = readClipboardImageBuffer({ ...options, env, platform, commandRunner: runner });
    if (!image) return null;

    const outputPath = createClipboardImagePath(image.extension, options);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, image.data);
    return { path: outputPath, source: "image", mimeType: image.mimeType };
}

export function formatClipboardPathForPrompt(path: string): string {
    return /[\s"']/.test(path) ? JSON.stringify(path) : path;
}

export function parseClipboardPathCandidates(text: string, platform: NodeJS.Platform = process.platform): string[] {
    return normalizeClipboardText(text)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#"))
        .map((line) => stripWrappingQuotes(line))
        .map((line) => decodeClipboardPathLine(line, platform))
        .filter((path): path is string => !!path);
}

export function detectSupportedClipboardImageMimeType(buffer: Buffer): string | null {
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

function readClipboardImagePath(options: Required<Pick<ClipboardImageOptions, "env" | "platform" | "commandRunner" | "cwd">>): string | null {
    for (const text of readClipboardTextValues(options)) {
        for (const candidate of parseClipboardPathCandidates(text, options.platform)) {
            const resolved = resolveCandidatePath(candidate, options.cwd);
            if (resolved && isSupportedImageFile(resolved)) return resolved;
        }
    }
    return null;
}

function readClipboardTextValues(options: Required<Pick<ClipboardImageOptions, "env" | "platform" | "commandRunner">>): string[] {
    const { env, platform, commandRunner } = options;
    const values: string[] = [];
    const pushText = (command: string | null, args: string[]) => {
        if (!command) return;
        const result = commandRunner(command, args, { env, timeoutMs: CLIPBOARD_COMMAND_TIMEOUT_MS, maxBuffer: 512 * 1024 });
        if (result.status !== 0 || result.stdout.length === 0) return;
        const text = result.stdout.toString("utf8");
        if (text.trim().length > 0 && !text.includes("\0")) values.push(text);
    };

    if (platform === "darwin") {
        pushText(findExecutable("pbpaste", env), []);
        return values;
    }

    if (platform === "win32") {
        const powershell = findWindowsPowerShell(env);
        pushText(powershell.command, [
            ...powershell.args,
            "-Command",
            "Add-Type -AssemblyName System.Windows.Forms; if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) { [System.Windows.Forms.Clipboard]::GetFileDropList() | Select-Object -First 1 } elseif ([System.Windows.Forms.Clipboard]::ContainsText()) { [System.Windows.Forms.Clipboard]::GetText() }",
        ]);
        return values;
    }

    const wlPaste = findExecutable("wl-paste", env);
    pushText(wlPaste, ["--type", "text/uri-list", "--no-newline"]);
    pushText(wlPaste, ["--type", "text/plain", "--no-newline"]);

    const xclip = findExecutable("xclip", env);
    pushText(xclip, ["-selection", "clipboard", "-t", "text/uri-list", "-o"]);
    pushText(xclip, ["-selection", "clipboard", "-t", "UTF8_STRING", "-o"]);

    const xsel = findExecutable("xsel", env);
    pushText(xsel, ["--clipboard", "--output"]);

    return values;
}

function writeClipboardImageDirectly(options: Required<Pick<ClipboardImageOptions, "env" | "platform" | "commandRunner">> & ClipboardImageOptions): string | null {
    if (options.platform === "darwin") return writeMacClipboardImage(options);
    if (options.platform === "win32") return writeWindowsClipboardImage(options);
    return null;
}

function writeMacClipboardImage(options: Required<Pick<ClipboardImageOptions, "env" | "commandRunner">> & ClipboardImageOptions): string | null {
    const outputPath = createClipboardImagePath("png", options);
    mkdirSync(dirname(outputPath), { recursive: true });

    const pngpaste = findExecutable("pngpaste", options.env);
    if (pngpaste) {
        const result = options.commandRunner(pngpaste, [outputPath], { env: options.env, timeoutMs: CLIPBOARD_COMMAND_TIMEOUT_MS, maxBuffer: 256 * 1024 });
        if (result.status === 0 && isSupportedImageFile(outputPath)) return outputPath;
        rmSync(outputPath, { force: true });
    }

    const osascript = findExecutable("osascript", options.env);
    if (!osascript) return null;

    const script = [
        "on run argv",
        "set outPath to item 1 of argv",
        "set pngData to the clipboard as «class PNGf»",
        "set outFile to open for access POSIX file outPath with write permission",
        "set eof of outFile to 0",
        "write pngData to outFile",
        "close access outFile",
        "end run",
    ];
    const args = script.flatMap((line) => ["-e", line]).concat(outputPath);
    const result = options.commandRunner(osascript, args, { env: options.env, timeoutMs: CLIPBOARD_COMMAND_TIMEOUT_MS, maxBuffer: 256 * 1024 });
    if (result.status === 0 && isSupportedImageFile(outputPath)) return outputPath;
    rmSync(outputPath, { force: true });
    return null;
}

function writeWindowsClipboardImage(options: Required<Pick<ClipboardImageOptions, "env" | "commandRunner">> & ClipboardImageOptions): string | null {
    const powershell = findWindowsPowerShell(options.env);
    if (!powershell.command) return null;

    const outputPath = createClipboardImagePath("png", options);
    mkdirSync(dirname(outputPath), { recursive: true });

    const script = [
        "Add-Type -AssemblyName System.Windows.Forms;",
        "Add-Type -AssemblyName System.Drawing;",
        "if (-not [System.Windows.Forms.Clipboard]::ContainsImage()) { exit 1 }",
        "$image = [System.Windows.Forms.Clipboard]::GetImage();",
        "$image.Save($args[0], [System.Drawing.Imaging.ImageFormat]::Png);",
        "$image.Dispose();",
    ].join(" ");
    const result = options.commandRunner(powershell.command, [...powershell.args, "-Command", script, outputPath], {
        env: options.env,
        timeoutMs: CLIPBOARD_COMMAND_TIMEOUT_MS,
        maxBuffer: 256 * 1024,
    });
    if (result.status === 0 && isSupportedImageFile(outputPath)) return outputPath;
    rmSync(outputPath, { force: true });
    return null;
}

function readClipboardImageBuffer(options: Required<Pick<ClipboardImageOptions, "env" | "platform" | "commandRunner">>): ClipboardImageBuffer | null {
    if (options.platform === "darwin" || options.platform === "win32") return null;

    const commands: Array<{ command: string | null; args: string[] }> = [];
    const wlPaste = findExecutable("wl-paste", options.env);
    const xclip = findExecutable("xclip", options.env);
    const xsel = findExecutable("xsel", options.env);

    for (const mimeType of Object.keys(MIME_EXTENSIONS)) {
        commands.push({ command: wlPaste, args: ["--type", mimeType] });
        commands.push({ command: xclip, args: ["-selection", "clipboard", "-t", mimeType, "-o"] });
        commands.push({ command: xsel, args: ["--clipboard", "--output", "--mime-type", mimeType] });
    }

    for (const { command, args } of commands) {
        if (!command) continue;
        const result = options.commandRunner(command, args, {
            env: options.env,
            timeoutMs: CLIPBOARD_COMMAND_TIMEOUT_MS,
            maxBuffer: MAX_CLIPBOARD_IMAGE_BYTES,
        });
        if (result.status !== 0 || result.stdout.length === 0) continue;
        const mimeType = detectSupportedClipboardImageMimeType(result.stdout);
        if (!mimeType) continue;
        return {
            data: result.stdout,
            mimeType,
            extension: MIME_EXTENSIONS[mimeType] ?? "png",
        };
    }

    return null;
}

function createClipboardImagePath(extension: string, options: ClipboardImageOptions): string {
    const root = options.tempDir ?? process.env.PERRY_CLIPBOARD_IMAGE_DIR ?? join(tmpdir(), "perry-clipboard-images");
    const now = options.now?.() ?? new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, "-");
    const id = (options.randomId?.() ?? randomUUID()).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 12) || "image";
    return join(root, `clipboard-${timestamp}-${id}.${extension}`);
}

function resolveCandidatePath(candidate: string, cwd: string): string | null {
    const expanded = candidate.startsWith("~/") || candidate === "~"
        ? join(homedir(), candidate.slice(2))
        : candidate;
    return resolve(cwd, expanded);
}

function isSupportedImageFile(path: string): boolean {
    try {
        const stat = statSync(path);
        if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_CLIPBOARD_IMAGE_BYTES) return false;
        return !!readSupportedImageMimeType(path);
    } catch {
        return false;
    }
}

function readSupportedImageMimeType(path: string): string | null {
    try {
        if (!existsSync(path)) return null;
        const buffer = readFileSync(path);
        return detectSupportedClipboardImageMimeType(buffer);
    } catch {
        return null;
    }
}

function decodeClipboardPathLine(line: string, platform: NodeJS.Platform): string | null {
    if (line.startsWith("file://")) {
        try {
            return fileURLToPath(line);
        } catch {
            return null;
        }
    }

    if (platform === "win32") {
        if (/^[A-Za-z]:[\\/]/.test(line) || line.startsWith("\\\\")) return line;
        return null;
    }

    if (line.startsWith("/") || line.startsWith("~/") || line === "~") return line;
    if (extname(basename(line)).length > 0) return line;
    return null;
}

function stripWrappingQuotes(text: string): string {
    if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
        return text.slice(1, -1);
    }
    return text;
}

function normalizeClipboardText(text: string): string {
    return text.replace(/^\uFEFF/, "").replace(/\0/g, "").trim();
}

function findWindowsPowerShell(env: NodeJS.ProcessEnv): { command: string | null; args: string[] } {
    const powershell = findExecutable("powershell.exe", env) ?? findExecutable("powershell", env);
    if (powershell) return { command: powershell, args: ["-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass"] };
    const pwsh = findExecutable("pwsh.exe", env) ?? findExecutable("pwsh", env);
    return { command: pwsh, args: ["-NoProfile", "-NonInteractive"] };
}

function runCommand(command: string, args: string[], options: { env?: NodeJS.ProcessEnv; timeoutMs?: number; maxBuffer?: number } = {}): CommandResult {
    const result = spawnSync(command, args, {
        env: options.env,
        timeout: options.timeoutMs ?? CLIPBOARD_COMMAND_TIMEOUT_MS,
        maxBuffer: options.maxBuffer ?? MAX_CLIPBOARD_IMAGE_BYTES,
        encoding: "buffer",
        stdio: ["ignore", "pipe", "pipe"],
    });

    const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr ?? "");
    return {
        status: result.status,
        stdout,
        stderr,
        error: result.error,
    };
}
