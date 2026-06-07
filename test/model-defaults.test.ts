import assert from "node:assert/strict";
import { test } from "bun:test";
import {
    resolveDefaultModel,
    resolveDefaultReasoningLevel,
    withSavedDefaultModelAndReasoning,
} from "../src/helpers/modelDefaults";

test("saved model default overrides provider fallback", () => {
    assert.equal(resolveDefaultModel("openai-api-key", null), "gpt-5.4-mini");
    assert.equal(resolveDefaultModel("openai-codex", null), "gpt-5.4");

    assert.equal(resolveDefaultModel("openai-api-key", {
        activeProvider: "openai-api-key",
        modelDefaults: {
            "openai-api-key": "gpt-5.4-pro",
            "openai-codex": "gpt-5.5",
        },
    }), "gpt-5.4-pro");

    assert.equal(resolveDefaultModel("openai-codex", {
        activeProvider: "openai-codex",
        modelDefaults: {
            "openai-api-key": "gpt-5.4-pro",
            "openai-codex": "gpt-5.5",
        },
    }), "gpt-5.5");
});

test("saved reasoning default overrides provider fallback when supported", () => {
    assert.equal(resolveDefaultReasoningLevel("openai-api-key", "gpt-5.4", null), "high");

    assert.equal(resolveDefaultReasoningLevel("openai-api-key", "gpt-5.4", {
        activeProvider: "openai-api-key",
        reasoningDefaults: {
            "openai-api-key": "low",
        },
    }), "low");

    assert.equal(resolveDefaultReasoningLevel("openai-api-key", "gpt-5-pro", {
        activeProvider: "openai-api-key",
        reasoningDefaults: {
            "openai-api-key": "low",
        },
    }), "high");
});

test("saving provider model and reasoning defaults preserves auth fields and other provider defaults", () => {
    const next = withSavedDefaultModelAndReasoning({
        activeProvider: "openai-codex",
        openaiApiKey: {
            apiKey: "sk-test",
        },
        modelDefaults: {
            "openai-codex": "gpt-5.5",
        },
        reasoningDefaults: {
            "openai-codex": "xhigh",
        },
    }, "openai-api-key", "gpt-5.4-pro", "medium");

    assert.deepEqual(next, {
        activeProvider: "openai-codex",
        openaiApiKey: {
            apiKey: "sk-test",
        },
        modelDefaults: {
            "openai-codex": "gpt-5.5",
            "openai-api-key": "gpt-5.4-pro",
        },
        reasoningDefaults: {
            "openai-codex": "xhigh",
            "openai-api-key": "medium",
        },
    });
});
