import assert from "node:assert/strict";
import { test } from "bun:test";
import { filterSlashCommands, getSlashCommandName, isSlashCommandInput } from "../src/helpers/commands";

test("absolute paths are not slash commands", () => {
    assert.equal(getSlashCommandName("/tmp/perry-clipboard-images/shot.png"), null);
    assert.equal(isSlashCommandInput("/tmp/perry-clipboard-images/shot.png"), false);
    assert.deepEqual(filterSlashCommands("/tmp/perry-clipboard-images/shot.png"), []);
});

test("messages that start with an absolute path are normal user messages", () => {
    const input = "/tmp/perry-clipboard-images/shot.png what is in this image?";

    assert.equal(getSlashCommandName(input), null);
    assert.equal(isSlashCommandInput(input), false);
    assert.deepEqual(filterSlashCommands(input), []);
});

test("known slash commands are detected exactly", () => {
    assert.equal(getSlashCommandName("/help"), "/help");
    assert.equal(isSlashCommandInput("/model"), true);
    assert.equal(isSlashCommandInput("/settings"), true);
    assert.equal(isSlashCommandInput("/permissions"), true);
    assert.equal(isSlashCommandInput("/mcp"), true);
    assert.equal(isSlashCommandInput("/skills"), true);
    assert.equal(isSlashCommandInput("/skill"), true);
    assert.equal(isSlashCommandInput("/plan"), true);
    assert.equal(isSlashCommandInput("/accept"), true);
});

test("trace is not a slash command", () => {
    assert.equal(getSlashCommandName("/trace 3"), null);
    assert.equal(isSlashCommandInput("/trace 3"), false);
    assert.deepEqual(filterSlashCommands("/trace"), []);
});

test("slash command suggestions show all commands for bare slash and still filter prefixes", () => {
    assert.deepEqual(filterSlashCommands("/he").map((command) => command.name), ["/help"]);
    assert.deepEqual(filterSlashCommands("/set").map((command) => command.name), ["/settings"]);
    assert.deepEqual(filterSlashCommands("/per").map((command) => command.name), ["/permissions"]);
    assert.deepEqual(filterSlashCommands("/pl").map((command) => command.name), ["/plan"]);
    assert.deepEqual(filterSlashCommands("/").map((command) => command.name), [
        "/help",
        "/login",
        "/logout",
        "/model",
        "/thinking",
        "/settings",
        "/permissions",
        "/mcp",
        "/skills",
        "/skill",
        "/plan",
        "/subagents",
        "/accept",
        "/session",
        "/resume",
        "/continue",
        "/new",
        "/compact",
        "/quit",
    ]);
});

test("unknown slash-prefixed words are treated as normal messages", () => {
    assert.equal(getSlashCommandName("/wat"), null);
    assert.equal(isSlashCommandInput("/wat"), false);
    assert.deepEqual(filterSlashCommands("/wat"), []);
});
