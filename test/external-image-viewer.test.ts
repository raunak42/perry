import assert from "node:assert/strict";
import { test } from "bun:test";
import { buildExternalImageCommand, shouldOpenExternalStartupImage } from "../src/helpers/externalImageViewer";

test("external startup image fallback is opt-in", () => {
    assert.equal(shouldOpenExternalStartupImage({}), false);
    assert.equal(shouldOpenExternalStartupImage({ PERRY_STARTUP_IMAGE_EXTERNAL: "off" }), false);
    assert.equal(shouldOpenExternalStartupImage({ PERRY_OPEN_STARTUP_IMAGE: "0" }), false);
    assert.equal(shouldOpenExternalStartupImage({ PERRY_STARTUP_IMAGE_EXTERNAL: "on" }), true);
    assert.equal(shouldOpenExternalStartupImage({ PERRY_OPEN_STARTUP_IMAGE: "1" }), true);
});

test("external image command is platform-specific", () => {
    assert.deepEqual(buildExternalImageCommand("/tmp/image.png", "linux"), {
        command: "xdg-open",
        args: ["/tmp/image.png"],
    });
    assert.deepEqual(buildExternalImageCommand("/tmp/image.png", "darwin"), {
        command: "open",
        args: ["/tmp/image.png"],
    });
    assert.deepEqual(buildExternalImageCommand("C:\\tmp\\image.png", "win32"), {
        command: "cmd",
        args: ["/c", "start", "", "C:\\tmp\\image.png"],
    });
});
