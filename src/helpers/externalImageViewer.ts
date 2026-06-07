import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

export interface ExternalImageCommand {
    command: string;
    args: string[];
}

export function shouldOpenExternalStartupImage(env: NodeJS.ProcessEnv = process.env): boolean {
    const value = (env.PERRY_STARTUP_IMAGE_EXTERNAL ?? env.PERRY_OPEN_STARTUP_IMAGE ?? "off").trim().toLowerCase();
    return ["on", "1", "true", "yes", "external", "open"].includes(value);
}

export function buildExternalImageCommand(path: string, platform: NodeJS.Platform = process.platform): ExternalImageCommand {
    if (platform === "darwin") return { command: "open", args: [path] };
    if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", path] };
    return { command: "xdg-open", args: [path] };
}

export function openImageExternally(path: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
    if (!shouldOpenExternalStartupImage(env)) return false;
    if (!existsSync(path)) return false;
    const { command, args } = buildExternalImageCommand(path, platform);
    try {
        const child = spawn(command, args, {
            detached: true,
            stdio: "ignore",
            env,
        });
        child.unref();
        return true;
    } catch {
        return false;
    }
}
