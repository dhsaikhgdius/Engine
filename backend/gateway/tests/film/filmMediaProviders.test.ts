// @vitest-environment node

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentUsageMeterInput } from "../../../../packages/protocol/src/agentObservabilityProtocol";
import { HostedImagesApiGenerator, HostedVideosApiGenerator } from "../../film/filmMediaProviders";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempPng() {
  const directory = mkdtempSync(resolve(tmpdir(), "director-film-media-"));
  directories.push(directory);
  const path = resolve(directory, "frame.png");
  // Minimal 1×1 PNG.
  writeFileSync(
    path,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
  return path;
}

describe("HostedImagesApiGenerator usage metering", () => {
  it("records film-image samples on success and failure with zero tokens", async () => {
    const samples: AgentUsageMeterInput[] = [];
    const pngB64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ b64_json: pngB64 }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(new Response("boom", { status: 500 }));

    const generator = new HostedImagesApiGenerator({
      baseUrl: "https://film.example/v1",
      apiKey: "secret",
      model: "gpt-image-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      meter: (sample) => samples.push(sample),
    });

    const bytes = await generator.generateImage({ prompt: "a quiet street" });
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(samples).toEqual([
      expect.objectContaining({
        scope: "film-image",
        provider: "images-api:gpt-image-test",
        model: "gpt-image-test",
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        retries: 0,
        succeeded: true,
      }),
    ]);
    expect(samples[0]!.duration_ms).toBeGreaterThanOrEqual(0);

    await expect(generator.generateImage({ prompt: "fail me" })).rejects.toThrow();
    expect(samples.at(-1)).toEqual(expect.objectContaining({ scope: "film-image", succeeded: false, total_tokens: 0 }));
    expect(JSON.stringify(samples)).not.toContain("secret");
  });
});

describe("HostedVideosApiGenerator usage metering", () => {
  it("meters wall-clock including poll rounds under film-video", async () => {
    const samples: AgentUsageMeterInput[] = [];
    const frame = tempPng();
    const fetchImpl = vi
      .fn()
      // create
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "vid-1", status: "queued" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      // first poll — still running
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "in_progress" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      // second poll — completed
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "completed", unsigned_urls: ["https://cdn.example/out.mp4"] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      // content download
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }));

    const generator = new HostedVideosApiGenerator({
      baseUrl: "https://film.example/v1",
      model: "veo-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      pollIntervalMs: 1,
      timeoutMs: 5_000,
      meter: (sample) => samples.push(sample),
    });

    const bytes = await generator.generateVideoClip({
      prompt: "camera push-in",
      frameImagePaths: [frame],
      durationSec: 4,
    });
    expect(bytes.equals(Buffer.from([1, 2, 3, 4]))).toBe(true);
    expect(samples).toHaveLength(1);
    expect(samples[0]).toEqual(
      expect.objectContaining({
        scope: "film-video",
        provider: "videos-api:veo-test",
        model: "veo-test",
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        retries: 1,
        succeeded: true,
      }),
    );
    expect(samples[0]!.duration_ms).toBeGreaterThanOrEqual(1);
  });

  it("records a failed film-video sample when the job fails", async () => {
    const samples: AgentUsageMeterInput[] = [];
    const frame = tempPng();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "vid-2", status: "queued" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "failed", error: { message: "quota" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const generator = new HostedVideosApiGenerator({
      baseUrl: "https://film.example/v1",
      model: "veo-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      pollIntervalMs: 1,
      meter: (sample) => samples.push(sample),
    });

    await expect(generator.generateVideoClip({ prompt: "fail", frameImagePaths: [frame] })).rejects.toThrow(/failed/);
    expect(samples).toEqual([
      expect.objectContaining({ scope: "film-video", succeeded: false, total_tokens: 0, retries: 0 }),
    ]);
  });
});
