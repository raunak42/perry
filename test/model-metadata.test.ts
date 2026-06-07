import assert from "node:assert/strict";
import { test } from "bun:test";
import { getContextConfig, getModelDisplayMetadata } from "../src/helpers/models";

test("openai api-key model windows match pi-mono metadata", () => {
    assert.deepEqual(getModelDisplayMetadata("gpt-5.4", "openai-api-key"), {
        contextWindow: 272_000,
        maxOutputTokens: 128_000,
    });
    assert.deepEqual(getModelDisplayMetadata("gpt-5.4-mini", "openai-api-key"), {
        contextWindow: 400_000,
        maxOutputTokens: 128_000,
    });
    assert.deepEqual(getModelDisplayMetadata("gpt-5.4-pro", "openai-api-key"), {
        contextWindow: 1_050_000,
        maxOutputTokens: 128_000,
    });
    assert.deepEqual(getModelDisplayMetadata("o3", "openai-api-key"), {
        contextWindow: 200_000,
        maxOutputTokens: 100_000,
    });
});

test("openai codex model windows match pi-mono metadata", () => {
    assert.deepEqual(getModelDisplayMetadata("gpt-5.4", "openai-codex"), {
        contextWindow: 272_000,
        maxOutputTokens: 128_000,
    });
    assert.deepEqual(getModelDisplayMetadata("gpt-5.4-mini", "openai-codex"), {
        contextWindow: 272_000,
        maxOutputTokens: 128_000,
    });
    assert.deepEqual(getModelDisplayMetadata("gpt-5.2-codex", "openai-codex"), {
        contextWindow: 272_000,
        maxOutputTokens: 128_000,
    });
    assert.deepEqual(getModelDisplayMetadata("gpt-5.3-codex-spark", "openai-codex"), {
        contextWindow: 128_000,
        maxOutputTokens: 128_000,
    });
});

test("dated model ids normalize to the same pi-mono metadata", () => {
    assert.deepEqual(getModelDisplayMetadata("gpt-5.4-2026-01-01", "openai-api-key"), {
        contextWindow: 272_000,
        maxOutputTokens: 128_000,
    });
    assert.deepEqual(getModelDisplayMetadata("gpt-5.4-mini-2026-01-01", "openai-api-key"), {
        contextWindow: 400_000,
        maxOutputTokens: 128_000,
    });
});

test("context config keeps auto truncation behavior while using provider-specific metadata", () => {
    assert.deepEqual(getContextConfig("gpt-5.4", "disabled", "openai-api-key"), { truncation: "disabled" });
    assert.deepEqual(getContextConfig("gpt-5.4-mini", "auto", "openai-codex"), { truncation: "auto" });
    assert.deepEqual(getContextConfig("gpt-5.4", "balanced", "openai-api-key"), { truncation: "auto" });
});
