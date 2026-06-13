import assert from "node:assert/strict";
import path from "node:path";
import { test } from "bun:test";
import { detectInlineImageProtocol, detectTerminalImageBackend, renderInlineImageData } from "../src/helpers/inlineImage";
import { buildStartupCard, getStartupAnsiImagePath, getStartupAnsiImageSize, getStartupImagePath, resolveStartupImagePath } from "../src/helpers/startupImage";

test("detectTerminalImageBackend honors explicit overrides", () => {
    assert.equal(detectTerminalImageBackend({ PERRY_INLINE_IMAGE_PROTOCOL: "kitty" }), "kitty");
    assert.equal(detectTerminalImageBackend({ PERRY_IMAGE_PROTOCOL: "iterm" }), "iterm2");
    assert.equal(detectTerminalImageBackend({ PERRY_INLINE_IMAGE_PROTOCOL: "sixel" }), "sixel");
    assert.equal(detectTerminalImageBackend({ PERRY_INLINE_IMAGE_PROTOCOL: "off", KITTY_WINDOW_ID: "1" }), null);
    assert.equal(detectInlineImageProtocol({ PERRY_INLINE_IMAGE_PROTOCOL: "sixel" }), null);
});

test("renderInlineImageData emits real image protocol escapes", () => {
    const data = Buffer.from("png-data");
    const kitty = renderInlineImageData(data, "kitty", { widthCells: 12, heightCells: 6 });
    assert.match(kitty, /^\u001b_G/);
    assert.match(kitty, /a=T,f=100,c=12,r=6/);
    assert.match(kitty, /\u001b\\$/);

    const iterm = renderInlineImageData(data, "iterm2", { widthPx: 320, heightPx: 240 });
    assert.match(iterm, /^\u001b\]1337;File=/);
    assert.match(iterm, /width=320px/);
    assert.match(iterm, /height=240px/);
    assert.match(iterm, /\u0007$/);
});

test("startup image path can be disabled or overridden", () => {
    assert.equal(getStartupImagePath({ PERRY_STARTUP_IMAGE: "off" }), null);
    assert.equal(getStartupImagePath({ PERRY_STARTUP_IMAGE: "/tmp/example.png" }), "/tmp/example.png");
});

test("startup image path resolves file URIs", () => {
    assert.equal(resolveStartupImagePath("file:///tmp/example%20image.png"), "/tmp/example image.png");
});

test("startup ANSI image path defaults to packaged asset and can be disabled or overridden", () => {
    const defaultPath = getStartupAnsiImagePath({});
    assert.ok(defaultPath === null || path.basename(defaultPath) === "startup.ans");
    assert.equal(getStartupAnsiImagePath({ PERRY_STARTUP_IMAGE_ANSI: "off" }), null);
    assert.equal(getStartupAnsiImagePath({ PERRY_STARTUP_IMAGE_ANSI: "/tmp/perry.ansi" }), "/tmp/perry.ansi");
});

test("startup ANSI image size env overrides are optional and configurable", () => {
    assert.deepEqual(getStartupAnsiImageSize({}), { width: undefined, height: undefined });
    assert.deepEqual(getStartupAnsiImageSize({ PERRY_STARTUP_IMAGE_ANSI_WIDTH: "40", PERRY_STARTUP_IMAGE_ANSI_HEIGHT: "12" }), { width: 40, height: 12 });
    assert.deepEqual(getStartupAnsiImageSize({ PERRY_STARTUP_IMAGE_ANSI_WIDTH: "bad", PERRY_STARTUP_IMAGE_ANSI_HEIGHT: "0" }), { width: undefined, height: undefined });
});

test("buildStartupCard includes session metadata without image details", () => {
    const card = buildStartupCard({
        sessionId: "abcdef123456",
        persisted: true,
        sessionDir: "/tmp/sessions",
        cwd: "/repo",
        messageCount: 3,
        provider: "openai-api-key",
        model: "gpt-5.4",
        reasoningLevel: "high",
        contextLevel: "auto",
        imagePath: "/tmp/image.png",
        contextFiles: [
            { path: "/repo/AGENTS.md", content: "repo instructions" },
            { path: "/repo/packages/app/CLAUDE.md", content: "package instructions" },
        ],
    });

    assert.equal(card.title, "Perry");
    assert.equal(card.imagePath, "/tmp/image.png");
    assert.ok(card.lines.some((line) => line.left === "Session" && line.right === "abcdef12"));
    assert.ok(card.lines.some((line) => line.left === "Model" && line.right === "gpt-5.4 · high"));
    assert.ok(card.lines.some((line) => line.left === "Subagents" && line.right === "disabled · thinking medium"));
    assert.ok(card.lines.some((line) => line.left === "Context files" && line.right === "AGENTS.md, CLAUDE.md"));
    assert.ok(card.lines.some((line) => line.left === "Permissions" && line.right === "ask"));
    assert.ok(card.lines.some((line) => line.left === "Plan mode" && line.right === "disabled"));
    assert.ok(card.lines.some((line) => line.left === "Skills" && line.right === "0"));
    assert.ok(!card.lines.some((line) => line.left === "Startup image"));
});

test("GNOME/VTE is not treated as SIXEL-capable unless explicitly configured", () => {
    assert.equal(detectTerminalImageBackend({
        TERM: "xterm-256color",
        VTE_VERSION: "6800",
        GNOME_TERMINAL_SCREEN: "/org/gnome/Terminal/screen/example",
        PATH: process.env.PATH,
        HOME: process.env.HOME,
    }), null);
    assert.equal(detectTerminalImageBackend({
        PERRY_INLINE_IMAGE_PROTOCOL: "sixel",
        TERM: "xterm-256color",
        VTE_VERSION: "6800",
        PATH: process.env.PATH,
        HOME: process.env.HOME,
    }), "sixel");
});
