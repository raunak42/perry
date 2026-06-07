import assert from "node:assert/strict";
import { test } from "bun:test";
import { createResponseDoneSoundCommand, getResponseDoneSoundPath } from "../src/helpers/responseDoneSound";

test("response done sound uses formula 1 notification by default", () => {
    assert.equal(getResponseDoneSoundPath({}), "/home/raunak/Downloads/formula-1-radio-notification.mp3");
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
