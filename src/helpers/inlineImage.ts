import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export type InlineImageProtocol = "kitty" | "iterm2";
export type TerminalImageBackend = InlineImageProtocol | "sixel";

const SIXEL_TERMS = ["mlterm", "contour", "foot", "wezterm", "rio", "yaft"];

export interface InlineImageOptions {
    widthCells?: number;
    heightCells?: number;
    widthPx?: number;
    heightPx?: number;
    name?: string;
}

export interface RenderedTerminalImage {
    data: string;
    backend: TerminalImageBackend;
}

const KITTY_CHUNK_SIZE = 4096;

export function detectInlineImageProtocol(env: NodeJS.ProcessEnv = process.env): InlineImageProtocol | null {
    const backend = detectTerminalImageBackend(env);
    return backend === "kitty" || backend === "iterm2" ? backend : null;
}

export function detectTerminalImageBackend(env: NodeJS.ProcessEnv = process.env): TerminalImageBackend | null {
    const override = (env.PERRY_INLINE_IMAGE_PROTOCOL ?? env.PERRY_IMAGE_PROTOCOL ?? "").trim().toLowerCase();
    if (["off", "0", "false", "none", "disabled"].includes(override)) return null;
    if (["kitty", "iterm2", "sixel"].includes(override)) return override as TerminalImageBackend;
    if (override === "iterm" || override === "wezterm") return "iterm2";

    const termProgram = (env.TERM_PROGRAM ?? "").toLowerCase();
    const term = (env.TERM ?? "").toLowerCase();

    if (env.WEZTERM_PANE || termProgram.includes("wezterm")) return "iterm2";
    if (termProgram.includes("iterm")) return "iterm2";
    if (env.KITTY_WINDOW_ID || term.includes("kitty")) return "kitty";
    if (termProgram.includes("ghostty") || env.GHOSTTY_RESOURCES_DIR) return "kitty";
    if (env.KONSOLE_VERSION) return "kitty";

    // SIXEL is a real bitmap protocol, but it must be supported by the
    // terminal emulator. Do not assume GNOME/VTE supports it just because VTE is
    // present: many GNOME Terminal builds ignore SIXEL escapes, which makes the
    // image silently disappear. Prefer explicit terminal identifiers or an env
    // override for SIXEL.
    if (findExecutable("img2sixel", env) && terminalAdvertisesSixel(env, term, termProgram)) return "sixel";

    return null;
}

export function renderInlineImage(path: string, options: InlineImageOptions = {}, env: NodeJS.ProcessEnv = process.env): string | null {
    return renderTerminalImage(path, options, env)?.data ?? null;
}

export function renderTerminalImage(path: string, options: InlineImageOptions = {}, env: NodeJS.ProcessEnv = process.env): RenderedTerminalImage | null {
    if (!existsSync(path)) return null;
    const backend = detectTerminalImageBackend(env);
    if (!backend) return null;
    if (backend === "sixel") {
        const sixel = renderSixelImage(path, options, env);
        return sixel ? { data: sixel, backend } : null;
    }
    const data = readFileSync(path);
    if (data.length === 0) return null;
    return { data: renderInlineImageData(data, backend, options), backend };
}

export function renderInlineImageData(data: Buffer, protocol: InlineImageProtocol, options: InlineImageOptions = {}): string {
    const base64 = data.toString("base64");
    return protocol === "kitty"
        ? renderKittyImage(base64, options)
        : renderIterm2Image(base64, options);
}

export function findExecutable(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
    if (command.includes("/")) return isExecutable(command) ? command : null;
    const candidates = [
        ...(env.PATH ?? "").split(":").filter(Boolean).map((dir) => join(dir, command)),
        join(env.HOME ?? homedir(), ".local", "bin", command),
    ];
    for (const candidate of candidates) if (isExecutable(candidate)) return candidate;
    return null;
}

function isExecutable(path: string): boolean {
    try {
        accessSync(path, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

function terminalAdvertisesSixel(env: NodeJS.ProcessEnv, term: string, termProgram: string): boolean {
    const explicit = `${env.TERM_IMAGE_SUPPORT ?? env.TERMINAL_IMAGE_SUPPORT ?? ""}`.toLowerCase();
    if (explicit.split(/[,:;\s]+/).includes("sixel")) return true;
    if (env.WEZTERM_PANE || termProgram.includes("wezterm")) return true;
    if (env.MLTERM || termProgram.includes("mlterm")) return true;
    if (termProgram.includes("foot") || termProgram.includes("contour")) return true;
    return SIXEL_TERMS.some((knownTerm) => term.includes(knownTerm));
}

function renderSixelImage(path: string, options: InlineImageOptions, env: NodeJS.ProcessEnv): string | null {
    const executable = findExecutable("img2sixel", env);
    if (!executable) return null;
    const args = ["--7bit-mode", "--colors=256"];
    const widthPx = options.widthPx ?? (options.widthCells ? Math.floor(options.widthCells * 10) : undefined);
    const heightPx = options.heightPx ?? (options.heightCells ? Math.floor(options.heightCells * 20) : undefined);
    if (widthPx && widthPx > 0) args.push("--width", String(Math.floor(widthPx)));
    if (heightPx && heightPx > 0) args.push("--height", String(Math.floor(heightPx)));
    args.push(path);

    const result = spawnSync(executable, args, {
        env,
        encoding: "buffer",
        maxBuffer: 24 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status !== 0 || !result.stdout || result.stdout.length === 0) return null;
    return result.stdout.toString("utf8");
}

function renderKittyImage(base64: string, options: InlineImageOptions): string {
    const params = ["a=T", "f=100"];
    if (options.widthCells && options.widthCells > 0) params.push(`c=${Math.floor(options.widthCells)}`);
    if (options.heightCells && options.heightCells > 0) params.push(`r=${Math.floor(options.heightCells)}`);

    const chunks = base64.match(new RegExp(`.{1,${KITTY_CHUNK_SIZE}}`, "g")) ?? [""];
    return chunks.map((chunk, index) => {
        const more = index < chunks.length - 1 ? 1 : 0;
        const chunkParams = index === 0 ? [...params, `m=${more}`] : [`m=${more}`];
        return `\u001b_G${chunkParams.join(",")};${chunk}\u001b\\`;
    }).join("");
}

function renderIterm2Image(base64: string, options: InlineImageOptions): string {
    const params = ["inline=1", "preserveAspectRatio=1"];
    if (options.name) params.push(`name=${Buffer.from(options.name).toString("base64")}`);
    if (options.widthPx && options.widthPx > 0) params.push(`width=${Math.floor(options.widthPx)}px`);
    else if (options.widthCells && options.widthCells > 0) params.push(`width=${Math.floor(options.widthCells)}`);
    if (options.heightPx && options.heightPx > 0) params.push(`height=${Math.floor(options.heightPx)}px`);
    else if (options.heightCells && options.heightCells > 0) params.push(`height=${Math.floor(options.heightCells)}`);
    return `\u001b]1337;File=${params.join(";")}:${base64}\u0007`;
}
