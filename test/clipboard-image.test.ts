import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import {
    detectSupportedClipboardImageMimeType,
    formatClipboardPathForPrompt,
    parseClipboardPathCandidates,
    pasteClipboardImageAsTempFile,
} from "../src/helpers/clipboardImage";

const ONE_PIXEL_PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGOSHzRgAAAAABJRU5ErkJggg==",
    "base64",
);

test("clipboard path parser handles file URIs, quotes, and plain paths", () => {
    assert.deepEqual(parseClipboardPathCandidates("file:///tmp/example%20image.png\n"), ["/tmp/example image.png"]);
    assert.deepEqual(parseClipboardPathCandidates('"/tmp/example image.png"\n'), ["/tmp/example image.png"]);
    assert.deepEqual(parseClipboardPathCandidates("# comment\n/tmp/example.png\n"), ["/tmp/example.png"]);
});

test("clipboard image mime detection recognizes png", () => {
    assert.equal(detectSupportedClipboardImageMimeType(ONE_PIXEL_PNG), "image/png");
});

test("formatClipboardPathForPrompt quotes paths with spaces", () => {
    assert.equal(formatClipboardPathForPrompt("/tmp/example.png"), "/tmp/example.png");
    assert.equal(formatClipboardPathForPrompt("/tmp/example image.png"), '"/tmp/example image.png"');
});

test("pasteClipboardImageAsTempFile returns an image path copied as text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perry-clipboard-path-"));
    try {
        const imagePath = join(dir, "shot.png");
        const binDir = join(dir, "bin");
        const wlPastePath = join(binDir, "wl-paste");
        writeFileSync(imagePath, ONE_PIXEL_PNG);
        mkdirSync(binDir);
        writeFileSync(wlPastePath, "#!/bin/sh\nexit 0\n");
        chmodSync(wlPastePath, 0o755);
        const pasted = await pasteClipboardImageAsTempFile({
            platform: "linux",
            cwd: dir,
            env: { PATH: binDir },
            commandRunner: (command, args) => {
                if (command.endsWith("wl-paste") && args.includes("text/uri-list")) {
                    return { status: 0, stdout: Buffer.from(`file://${imagePath}\n`), stderr: Buffer.alloc(0) };
                }
                return { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
            },
        });

        assert.deepEqual(pasted, { path: imagePath, source: "file", mimeType: "image/png" });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("pasteClipboardImageAsTempFile writes raw clipboard image bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perry-clipboard-image-"));
    try {
        const pasted = await pasteClipboardImageAsTempFile({
            platform: "linux",
            tempDir: dir,
            env: (() => {
                const binDir = join(dir, "bin");
                const wlPastePath = join(binDir, "wl-paste");
                mkdirSync(binDir);
                writeFileSync(wlPastePath, "#!/bin/sh\nexit 0\n");
                chmodSync(wlPastePath, 0o755);
                return { PATH: binDir };
            })(),
            now: () => new Date("2026-01-02T03:04:05.006Z"),
            randomId: () => "fixed-id",
            commandRunner: (command, args) => {
                if (command.endsWith("wl-paste") && args.includes("image/png")) {
                    return { status: 0, stdout: ONE_PIXEL_PNG, stderr: Buffer.alloc(0) };
                }
                return { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
            },
        });

        assert.equal(pasted?.source, "image");
        assert.equal(pasted?.mimeType, "image/png");
        assert.equal(pasted?.path, join(dir, "clipboard-2026-01-02T03-04-05-006Z-fixed-id.png"));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
