import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { readTool } from "../src/tools/readFile";

test("read attaches supported images as multimodal model input", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perry-image-read-"));

    try {
        const imagePath = join(dir, "pixel.png");
        writeFileSync(imagePath, Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
            "base64",
        ));

        const result = await readTool.execute({ path: imagePath, offset: null, limit: null });
        assert.equal(!!result.isError, false);
        assert.match(result.output, /Read image file \[image\/png\]/);
        assert.ok(Array.isArray(result.modelOutput), "image read should produce multimodal model output");

        const image = result.modelOutput.find((item) => item.type === "input_image");
        assert.ok(image, "image read should include an input_image attachment");
        assert.ok(image.image_url?.startsWith("data:image/png;base64,"), "image attachment should be a data URL");

        assert.equal(result.details?.type, "read");
        assert.equal(result.details?.isImage, true);
        assert.equal(result.details?.mimeType, "image/png");
        assert.equal(result.details?.attachedToModel, true);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
