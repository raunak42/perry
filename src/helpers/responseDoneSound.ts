import { spawn } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { getPackageRoot } from "./packageInfo";

const DEFAULT_RESPONSE_DONE_SOUND_PATH = join(getPackageRoot(), "assets", "response-done.mp3");

export type ResponseDoneSoundCommand = {
    command: string;
    args: string[];
};

type CommandProbe = (command: string) => boolean;

export function getResponseDoneSoundPath(env: NodeJS.ProcessEnv = process.env): string | null {
    const override = env.PERRY_RESPONSE_DONE_SOUND ?? env.PERRY_DONE_SOUND;
    if (override !== undefined) {
        const trimmed = override.trim();
        if (!trimmed || trimmed === "0" || trimmed.toLowerCase() === "false" || trimmed.toLowerCase() === "off") {
            return null;
        }
        return trimmed;
    }

    return existsSync(DEFAULT_RESPONSE_DONE_SOUND_PATH) ? DEFAULT_RESPONSE_DONE_SOUND_PATH : null;
}

export function createResponseDoneSoundCommand(filePath: string, hasCommand: CommandProbe): ResponseDoneSoundCommand | null {
    if (hasCommand("ffplay")) {
        return {
            command: "ffplay",
            args: ["-nodisp", "-autoexit", "-loglevel", "quiet", filePath],
        };
    }

    if (hasCommand("mpv")) {
        return {
            command: "mpv",
            args: ["--no-video", "--really-quiet", filePath],
        };
    }

    if (hasCommand("mpg123")) {
        return {
            command: "mpg123",
            args: ["-q", filePath],
        };
    }

    if (hasCommand("pw-play")) {
        return {
            command: "pw-play",
            args: [filePath],
        };
    }

    if (hasCommand("paplay")) {
        return {
            command: "paplay",
            args: [filePath],
        };
    }

    if (hasCommand("afplay")) {
        return {
            command: "afplay",
            args: [filePath],
        };
    }

    if (hasCommand("play")) {
        return {
            command: "play",
            args: ["-q", filePath],
        };
    }

    return null;
}

function isExecutableOnPath(command: string): boolean {
    if (command.includes("/")) return existsSync(command);

    const pathValue = process.env.PATH ?? "";
    for (const dir of pathValue.split(":")) {
        if (!dir) continue;
        if (existsSync(join(dir, command))) return true;
    }

    return false;
}

export function playResponseDoneSound(): void {
    const filePath = getResponseDoneSoundPath();
    if (!filePath || !existsSync(filePath)) return;

    const soundCommand = createResponseDoneSoundCommand(filePath, isExecutableOnPath);
    if (!soundCommand) return;

    try {
        const child = spawn(soundCommand.command, soundCommand.args, {
            detached: true,
            stdio: "ignore",
        });
        child.on("error", () => undefined);
        child.unref();
    } catch {
        // Notification sounds should never affect the assistant turn.
    }
}
