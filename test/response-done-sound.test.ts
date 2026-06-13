import assert from "node:assert/strict";
import path from "node:path";
import { test } from "bun:test";
import { createResponseDoneSoundCommand, getResponseDoneSoundPath } from "../src/helpers/responseDoneSound";

test("response done sound defaults to a packaged asset path when present", () => {
    const soundPath = getResponseDoneSoundPath({});
    assert.ok(soundPath === null || path.basename(soundPath) === "response-done.mp3");
});

test("response done sound can be disabled with env override", () => {
    assert.equal(getResponseDoneSoundPath({ PERRY_RESPONSE_DONE_SOUND: "off" }), null);
    assert.equal(getResponseDoneSoundPath({ PERRY_DONE_SOUND: "0" }), null);
});

test("response done sound env override can choose another file", () => {
    assert.equal(getResponseDoneSoundPath({ PERRY_RESPONSE_DONE_SOUND: "/tmp/notify.mp3" }), "/tmp/notify.mp3");
});

test("response done sound prefers quiet non-blocking player commands", () => {
    const ffplay = createResponseDoneSoundCommand("/tmp/notify.mp3", (command) => command === "ffplay");
    assert.deepEqual(ffplay, {
        command: "ffplay",
        args: ["-nodisp", "-autoexit", "-loglevel", "quiet", "/tmp/notify.mp3"],
    });

    const mpv = createResponseDoneSoundCommand("/tmp/notify.mp3", (command) => command === "mpv");
    assert.deepEqual(mpv, {
        command: "mpv",
        args: ["--no-video", "--really-quiet", "/tmp/notify.mp3"],
    });
});
