import { expect, it } from "vitest";
import {
  extractDirectorPngMetadata,
  summarizeDirectorComfyMetadata,
} from "../../../../src/comprehensive/editor/media/pngMetadata";

function uint32(value: number) {
  return new Uint8Array([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]);
}

function chunk(type: string, data: Uint8Array) {
  return new Uint8Array([...uint32(data.length), ...new TextEncoder().encode(type), ...data, 0, 0, 0, 0]);
}

function textChunk(key: string, value: string) {
  return chunk("tEXt", new Uint8Array([...new TextEncoder().encode(key), 0, ...new TextEncoder().encode(value)]));
}

it("extracts bounded PNG text metadata and summarizes ComfyUI parameters", async () => {
  const prompt = JSON.stringify({
    "1": { class_type: "CLIPTextEncode", inputs: { text: "cinematic sunrise" }, _meta: { title: "Positive" } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: "noise" }, _meta: { title: "Negative" } },
    "3": { class_type: "KSampler", inputs: { seed: 42 } },
  });
  const bytes = new Uint8Array([
    137,
    80,
    78,
    71,
    13,
    10,
    26,
    10,
    ...textChunk("prompt", prompt),
    ...textChunk("workflow", '{"nodes":[]}'),
    ...chunk("IEND", new Uint8Array()),
  ]);
  const metadata = await extractDirectorPngMetadata(new Blob([bytes], { type: "image/png" }));
  expect(metadata).toMatchObject({ prompt, workflow: '{"nodes":[]}' });
  expect(summarizeDirectorComfyMetadata(metadata)).toMatchObject({
    prompt: "cinematic sunrise",
    negativePrompt: "noise",
    seed: 42,
    workflowJson: '{"nodes":[]}',
  });
});

it("ignores non-PNG blobs and malformed chunks", async () => {
  expect(await extractDirectorPngMetadata(new Blob(["not png"], { type: "image/png" }))).toBeNull();
  expect(
    await extractDirectorPngMetadata(
      new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 255, 255, 255, 255])], { type: "image/png" }),
    ),
  ).toBeNull();
});
