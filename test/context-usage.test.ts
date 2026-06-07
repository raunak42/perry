import assert from "node:assert/strict";
import { test } from "bun:test";
import { formatContextUsageLine } from "../src/helpers/contextUsage";

test("context usage line shows used tokens, window, and percent", () => {
    assert.equal(
        formatContextUsageLine({ usedTokens: 184_000, approximate: false }, 400_000),
        "context [184k/400k · 46%]",
    );
});

test("context usage line marks approximate estimates", () => {
    assert.equal(
        formatContextUsageLine({ usedTokens: 12_345, approximate: true }, 272_000),
        "context [~12k/272k · 4.5%]",
    );
});

test("context usage line handles unknown windows and unavailable usage", () => {
    assert.equal(formatContextUsageLine({ usedTokens: 2_400, approximate: true }), "context [~2.4k]");
    assert.equal(formatContextUsageLine({ usedTokens: null, approximate: false }, 400_000), "context [—]");
});
