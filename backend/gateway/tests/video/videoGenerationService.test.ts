import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultScene } from "@director/stage-protocol";
import type { VideoProviderCapability } from "../../../../packages/protocol/src/videoGenerationProtocol";
import type {
  VideoGenerationRequest,
  VideoProvider,
  VideoProviderHealth,
  VideoProviderJob,
} from "../../video/providers/videoProvider";
import { VideoGenerationService } from "../../video/videoGenerationService";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function providerJob(status: VideoProviderJob["status"]): VideoProviderJob {
  const now = new Date().toISOString();
  return {
    id: "video-provider-12345678",
    provider: "ltx-2.3",
    status,
    createdAt: now,
    updatedAt: now,
    progress: status === "completed" ? { phase: "complete", percent: 100 } : { phase: "queued", percent: 0 },
    outputs:
      status === "completed"
        ? [{ kind: "video", uri: "artifact://video-provider-12345678/output.mp4", mimeType: "video/mp4" }]
        : [],
    error: null,
    cancelRequested: status === "cancelled",
    warnings: [],
  };
}

class FakeLtxProvider implements VideoProvider {
  readonly id = "ltx-2.3" as const;
  requests: VideoGenerationRequest[] = [];
  nextStatus: VideoProviderJob["status"] = "queued";

  async capabilities(): Promise<VideoProviderCapability> {
    return {
      id: this.id,
      label: "Fake LTX-2.3",
      configured: true,
      supportsImageConditioning: true,
      supportsAudio: true,
      supportsNegativePrompt: false,
      dimensionMultiple: 64,
      frameCountRule: "8k+1",
      model: "ltx-2.3-22b-distilled",
    };
  }

  async health(): Promise<VideoProviderHealth> {
    return { provider: this.id, status: "ready", modelLoaded: true, activeJobId: null, detail: null };
  }

  async submit(request: VideoGenerationRequest): Promise<VideoProviderJob> {
    this.requests.push(request);
    return providerJob(this.nextStatus);
  }

  async getJob(): Promise<VideoProviderJob> {
    return providerJob("completed");
  }

  async cancel(): Promise<VideoProviderJob> {
    return providerJob("cancelled");
  }
}

async function createRoot() {
  const root = await mkdtemp(resolve(tmpdir(), "director-video-service-"));
  temporaryDirectories.push(root);
  return root;
}

describe("VideoGenerationService", () => {
  it("normalizes an LTX job and persists the exact reproducible provider request", async () => {
    const root = await createRoot();
    const provider = new FakeLtxProvider();
    const service = new VideoGenerationService({
      workspaceRoot: root,
      dataDirectory: resolve(root, "data"),
      defaultProvider: "ltx-2.3",
      providers: [provider],
      capturePreview: async () =>
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zs2kAAAAASUVORK5CYII=",
    });

    const execution = await service.execute(createDefaultScene(), {
      op: "render",
      prompt: "A carefully blocked cinematic white-box shot",
      width: 1280,
      height: 720,
      fps: 24,
      duration_s: 5,
      seed: 42,
      generate_audio: false,
      enhance_prompt: true,
    });

    expect(execution).toMatchObject({
      success: true,
      result: {
        provider: "ltx-2.3",
        status: "queued",
        render: {
          width: 1280,
          height: 704,
          fps: 24,
          numFrames: 121,
          deliveryWidth: 1280,
          deliveryHeight: 720,
        },
      },
    });
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]).toMatchObject({
      idempotencyKey: (execution.result as { job_id: string }).job_id,
      width: 1280,
      height: 704,
      frameRate: 24,
      numFrames: 121,
      seed: 42,
      generateAudio: false,
      enhancePrompt: true,
      conditioning: [{ role: "clean-frame", frameIndex: 0, strength: 1, crf: 0 }],
    });

    const jobId = (execution.result as { job_id: string }).job_id;
    const manifest = JSON.parse(await readFile(resolve(root, "data", "video-jobs", jobId, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({
      generation: { seed: 42, generateAudio: false, enhancePrompt: true },
      requested: { width: 1280, height: 720, numFrames: 120 },
      resolved: {
        generationWidth: 1280,
        generationHeight: 704,
        deliveryWidth: 1280,
        deliveryHeight: 720,
        numFrames: 121,
        deliveryTransformRequired: true,
      },
    });

    const status = await service.execute(createDefaultScene(), { op: "status", job_id: jobId });
    expect(status).toMatchObject({ success: true, result: { status: "completed" } });
  });

  it("returns a durable prepared receipt when the selected GPU provider is not configured", async () => {
    const root = await createRoot();
    const service = new VideoGenerationService({
      workspaceRoot: root,
      dataDirectory: resolve(root, "data"),
      defaultProvider: "ltx-2.3",
    });

    const execution = await service.execute(createDefaultScene(), {
      op: "render",
      prompt: "A recoverable render request",
      seed: 7,
    });

    expect(execution).toMatchObject({
      success: false,
      error: expect.stringContaining("not configured"),
      result: { provider: "ltx-2.3", status: "prepared" },
    });
    const jobId = (execution.result as { job_id: string }).job_id;
    const manifest = JSON.parse(await readFile(resolve(root, "data", "video-jobs", jobId, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ jobId, status: "prepared", generation: { seed: 7 } });
  });

  it("submits the dialect-expanded prompt and keeps the original in the manifest", async () => {
    const root = await createRoot();
    const provider = new FakeLtxProvider();
    const service = new VideoGenerationService({
      workspaceRoot: root,
      dataDirectory: resolve(root, "data"),
      defaultProvider: "ltx-2.3",
      providers: [provider],
      promptExpander: {
        async expand(input) {
          expect(input.prompt).toBe("A chef plating a dish");
          expect(input.durationSeconds).toBe(5);
          expect(input.provider).toBe("ltx-2.3");
          expect(input.scene?.cameraPlan?.[0]).toMatchObject({
            framing: expect.stringContaining("on a 35mm lens"),
            actions: ["orbit left 360° around the subject @0.00s+5.00s"],
          });
          return { expandedPrompt: "A handheld medium shot follows a chef plating a dish.", dialect: "cinematic" };
        },
      },
    });

    const execution = await service.execute(createDefaultScene(), {
      op: "render",
      prompt: "A chef plating a dish",
      duration_s: 5,
      enhance_prompt: true,
    });

    expect(execution).toMatchObject({
      success: true,
      result: {
        expanded_prompt: "A handheld medium shot follows a chef plating a dish.",
        warnings: expect.arrayContaining([expect.stringContaining("expanded in the cinematic dialect")]),
      },
    });
    expect(provider.requests[0]).toMatchObject({
      prompt: "A handheld medium shot follows a chef plating a dish.",
      // Gateway expansion replaces provider-side enhancement.
      enhancePrompt: false,
    });

    const jobId = (execution.result as { job_id: string }).job_id;
    const manifest = JSON.parse(await readFile(resolve(root, "data", "video-jobs", jobId, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({
      prompt: "A chef plating a dish",
      expandedPrompt: "A handheld medium shot follows a chef plating a dish.",
      generation: { enhancePrompt: true },
    });
  });

  it("falls back to the verbatim prompt when expansion fails", async () => {
    const root = await createRoot();
    const provider = new FakeLtxProvider();
    const service = new VideoGenerationService({
      workspaceRoot: root,
      dataDirectory: resolve(root, "data"),
      defaultProvider: "ltx-2.3",
      providers: [provider],
      promptExpander: {
        async expand() {
          throw new Error("writer endpoint unreachable");
        },
      },
    });

    const execution = await service.execute(createDefaultScene(), {
      op: "render",
      prompt: "A recoverable prompt",
      enhance_prompt: true,
    });

    expect(execution).toMatchObject({
      success: true,
      result: {
        expanded_prompt: null,
        warnings: expect.arrayContaining([
          expect.stringContaining("Prompt expansion failed (writer endpoint unreachable)"),
        ]),
      },
    });
    expect(provider.requests[0]).toMatchObject({
      prompt: "A recoverable prompt",
      // Provider-side enhancement stays available when gateway expansion failed.
      enhancePrompt: true,
    });
  });

  it("keeps long ComfyUI requests inside the shared provider frame limit", async () => {
    const root = await createRoot();
    const service = new VideoGenerationService({
      workspaceRoot: root,
      dataDirectory: resolve(root, "data"),
      defaultProvider: "comfyui",
    });

    const execution = await service.execute(createDefaultScene(), {
      op: "prepare",
      prompt: "A thirty-second editorial reference sequence",
      duration_s: 30,
      fps: 60,
    });

    expect(execution).toMatchObject({
      success: true,
      result: {
        render: { fps: 60, numFrames: 1441 },
        warnings: [expect.stringContaining("provider contract limit")],
      },
    });
  });
});
