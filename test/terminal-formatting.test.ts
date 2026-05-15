import assert from "node:assert/strict";
import { test } from "bun:test";
import { TerminalFormatter } from "../src/ui/terminal-formatting";

const formatter = new TerminalFormatter(() => 70);
const strip = (text: string) => formatter.stripAnsi(text);

test("markdown formatting renders content without leaking markdown markers", () => {
    const markdown = [
        "## Heading",
        "",
        "1. **This is a very long numbered item** that should wrap with a hanging indent instead of looking like a paragraph.",
        "2. Second item with `inline code` and https://example.com.",
        "",
        "- **Long bullet** that should also wrap with a hanging indent under the text, not under the marker.",
        "- [x] Completed task",
        "",
        "> Quoted text should keep a visible quote marker when it wraps across terminal width.",
        "",
        "| Area | Expected |",
        "| --- | --- |",
        "| titles | styled |",
        "| bullets | wrapped |",
        "",
        "```ts",
        "const renderer = 'append-only terminal ui';",
        "console.log(renderer);",
        "```",
    ].join("\n");

    const rendered = strip(formatter.renderMarkdownBlock(markdown));

    assert.equal(rendered.includes("## Heading"), false, "heading marker leaked");
    assert.equal(rendered.includes("**"), false, "bold marker leaked");
    assert.equal(rendered.includes("```ts"), false, "code fence marker leaked");
    assert.match(rendered, /Heading/);
    assert.match(rendered, /1\. This is a very long numbered item/);
    assert.match(rendered, /\n   indent instead of looking like a paragraph\./);
    assert.match(rendered, /• Long bullet/);
    assert.match(rendered, /☒ Completed task/);
    assert.match(rendered, /│ Quoted text/);
    assert.match(rendered, /\| Area/);
    assert.match(rendered, /const renderer/);
});

test("assistant markdown strips decorative emoji and private-use icon glyphs", () => {
    const iconList = strip(formatter.renderMarkdownBlock("- 📁 `src` – main application code\n- private".replace("private", "\ue000 private")));

    assert.equal(iconList.includes("📁"), false, "decorative emoji leaked into assistant markdown");
    assert.equal(/[\ue000-\uf8ff]/.test(iconList), false, "private-use icon glyph leaked into assistant markdown");
    assert.match(iconList, /src – main application code/);
});

test("open code fences render body without leaking fence markers", () => {
    const openFence = strip(formatter.renderMarkdownBlock("```ts\nconst x = 1;"));

    assert.equal(openFence.includes("```ts"), false, "open code fence marker leaked");
    assert.match(openFence, /const x = 1;/);
    assert.equal(openFence.trimEnd().endsWith("```"), false, "open code fence should not synthesize a closing fence while streaming");
});

test("thinking blocks stay gray and within the safe terminal width", () => {
    const thinkingBlock = formatter.renderThinkingBlock("**Muted thinking title**\n\n- quiet bullet");
    const thinking = strip(thinkingBlock);

    assert.equal(thinking.includes("**"), false, "thinking bold marker leaked");
    assert.match(thinking, /Muted thinking title/);
    assert.match(thinking, /• quiet bullet/);
    assert.equal(thinkingBlock.includes("38;2;255;255;255"), false, "thinking title should stay gray, not bright white");

    for (const line of thinking.split("\n")) {
        assert.ok(formatter.getVisibleTextWidth(line) < 70, "thinking panel wrote into the terminal's final column");
    }
});
