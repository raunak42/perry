import assert from "node:assert/strict";
import { test } from "bun:test";
import { withBusyIndicator } from "../src/helpers/busyIndicator";

class FakeBusyUi {
    busyMessages: string[] = [];
    clears = 0;

    setBusy(message?: string): void {
        this.busyMessages.push(message ?? "Working");
    }

    clearBusy(_options?: { showWorkedLine?: boolean }): void {
        this.clears += 1;
    }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("busy indicator stays hidden for fast operations", async () => {
    const ui = new FakeBusyUi();

    const result = await withBusyIndicator(ui, "Fast work", () => "done", { delayMs: 50 });

    assert.equal(result, "done");
    assert.deepEqual(ui.busyMessages, []);
    assert.equal(ui.clears, 0);
});

test("busy indicator shows, updates, and clears for slow operations", async () => {
    const ui = new FakeBusyUi();

    const result = await withBusyIndicator(ui, "Starting", async (indicator) => {
        await wait(5);
        indicator.setMessage("Still working");
        await wait(5);
        return 42;
    }, { delayMs: 0 });

    assert.equal(result, 42);
    assert.deepEqual(ui.busyMessages, ["Starting", "Still working"]);
    assert.equal(ui.clears, 1);
});

test("busy indicator clears when slow operations throw", async () => {
    const ui = new FakeBusyUi();

    await assert.rejects(
        () => withBusyIndicator(ui, "Exploding", async () => {
            await wait(5);
            throw new Error("boom");
        }, { delayMs: 0 }),
        /boom/,
    );

    assert.deepEqual(ui.busyMessages, ["Exploding"]);
    assert.equal(ui.clears, 1);
});
