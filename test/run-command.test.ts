import assert from "node:assert/strict";
import { test } from "bun:test";
import { runCommandTool } from "../src/tools/runCommand";

test("run_command times out silent commands", async () => {
    const started = Date.now();
    const result = await runCommandTool.execute({ command: "sleep 2", timeout: 1 });
    const elapsed = Date.now() - started;

    assert.equal(!!result.isError, true);
    assert.match(result.output, /timed out|Timed out/);
    assert.ok(elapsed <= 2_500, `timeout took too long: ${elapsed}ms`);
});

test("run_command ignores stdin so child processes do not hang", async () => {
    const command = `${JSON.stringify(process.execPath)} -e "process.stdin.resume(); setTimeout(() => console.log('done'), 10)"`;
    const started = Date.now();
    const result = await runCommandTool.execute({ command, timeout: 2 });
    const elapsed = Date.now() - started;

    assert.equal(!!result.isError, false);
    assert.match(result.output, /done/);
    assert.ok(elapsed <= 1_500, `stdin command appears to have hung until timeout: ${elapsed}ms`);
});

test("run_command abort signal stops running commands", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const resultPromise = runCommandTool.execute({ command: "sleep 5", timeout: null }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    const result = await resultPromise;
    const elapsed = Date.now() - started;

    assert.equal(!!result.isError, true);
    assert.match(result.output, /Process terminated/);
    assert.ok(elapsed <= 2_500, `abort took too long: ${elapsed}ms`);
});
