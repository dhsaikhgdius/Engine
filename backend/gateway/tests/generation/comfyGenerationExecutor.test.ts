import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductionJobStore } from "../../jobs/productionJobStore";
import { ComfyGenerationExecutor } from "../../generation/comfyGenerationExecutor";
import { ComfyNodePool } from "../../generation/comfyNodePool";
import { ComfyWorkflowStore } from "../../generation/comfyWorkflowStore";

const workflow = {
  "1": { class_type: "CLIPTextEncode", inputs: { text: "old" }, _meta: { title: "Positive Prompt" } },
  "2": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512, batch_size: 1 } },
  "3": { class_type: "KSampler", inputs: { seed: 1, steps: 20, cfg: 7 } },
  "4": { class_type: "SaveImage", inputs: { images: ["3", 0], filename_prefix: "Director" } },
};

describe("ComfyGenerationExecutor", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((directory) => rm(directory, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it("submits a patched real provider workflow and stores downloaded outputs as immutable artifacts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "director-comfy-executor-"));
    tempDirs.push(directory);
    let submittedPrompt: Record<string, { inputs: Record<string, unknown> }> | null = null;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/prompt")) {
        const body = JSON.parse(String(init?.body)) as { prompt: typeof submittedPrompt };
        submittedPrompt = body.prompt;
        return new Response(JSON.stringify({ prompt_id: "provider-prompt-1" }), { status: 200 });
      }
      if (url.endsWith("/history/provider-prompt-1")) {
        return new Response(
          JSON.stringify({
            "provider-prompt-1": {
              status: { status_str: "success", completed: true },
              outputs: { "4": { images: [{ filename: "Director_00001_.png", subfolder: "", type: "output" }] } },
            },
          }),
        );
      }
      if (url.includes("/view?"))
        return new Response(Buffer.from("generated-image-bytes"), { headers: { "content-type": "image/png" } });
      throw new Error(`Unexpected request ${url}`);
    });
    const jobs = new ProductionJobStore(directory);
    const nodes = new ComfyNodePool(
      directory,
      [{ id: "gpu-a", label: "GPU A", baseUrl: "http://comfy.test", enabled: true, maxConcurrent: 1 }],
      fetchImpl as typeof fetch,
    );
    const workflows = new ComfyWorkflowStore(directory);
    const imported = await workflows.import({ name: "Image workflow", mediaKind: "image", workflow });
    const job = await jobs.enqueue({
      kind: "image.generate",
      input: {
        prompt: "cinematic rainy alley",
        negativePrompt: "flicker",
        width: 1280,
        height: 720,
        seed: 42,
        workflowId: imported.id,
        nodeId: "gpu-a",
        parameters: { "3.steps": 28 },
      },
      idempotencyKey: "executor-image-1",
      provider: "comfyui:gpu-a",
      createId: () => "generation-job-image-1",
    });
    const executor = new ComfyGenerationExecutor(jobs, nodes, workflows, {
      pollIntervalMs: 1,
      timeoutMs: 1_000,
      webSocketFactory: null,
    });

    const completed = await executor.execute(job);
    expect(completed).toMatchObject({
      status: "succeeded",
      progress: 1,
      artifact: { mimeType: "image/png", fileName: "output-1.png" },
    });
    expect(completed?.artifacts.map((artifact) => artifact.role)).toEqual(["primary", "metadata"]);
    expect(completed?.attempts[0]?.externalId).toBe("provider-prompt-1");
    const captured = submittedPrompt as unknown as Record<string, { inputs: Record<string, unknown> }>;
    expect(captured["1"]?.inputs.text).toBe("cinematic rainy alley");
    expect(captured["2"]?.inputs).toMatchObject({ width: 1280, height: 720 });
    expect(captured["3"]?.inputs).toMatchObject({ seed: 42, steps: 28 });
    expect(await jobs.readArtifact(completed!, completed!.artifact!)).toEqual(Buffer.from("generated-image-bytes"));
  });

  it("runs audio, speech, music, or SFX workflows through the same durable executor", async () => {
    const directory = await mkdtemp(join(tmpdir(), "director-comfy-audio-executor-"));
    tempDirs.push(directory);
    let submittedPrompt: Record<string, { inputs: Record<string, unknown> }> | null = null;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/prompt")) {
        submittedPrompt = (JSON.parse(String(init?.body)) as { prompt: typeof submittedPrompt }).prompt;
        return new Response(JSON.stringify({ prompt_id: "provider-audio-1" }), { status: 200 });
      }
      if (url.endsWith("/history/provider-audio-1")) {
        return new Response(
          JSON.stringify({
            "provider-audio-1": {
              status: { status_str: "success", completed: true },
              outputs: { "2": { audio: [{ filename: "Director_audio.wav", subfolder: "", type: "output" }] } },
            },
          }),
        );
      }
      if (url.includes("/view?")) {
        return new Response(Buffer.from("generated-audio-bytes"), { headers: { "content-type": "audio/wav" } });
      }
      throw new Error(`Unexpected request ${url}`);
    });
    const jobs = new ProductionJobStore(directory);
    const nodes = new ComfyNodePool(
      directory,
      [{ id: "gpu-a", label: "GPU A", baseUrl: "http://comfy.test", enabled: true, maxConcurrent: 1 }],
      fetchImpl as typeof fetch,
    );
    const workflows = new ComfyWorkflowStore(directory);
    const imported = await workflows.import({
      name: "Audio workflow",
      mediaKind: "audio",
      workflow: {
        "1": {
          class_type: "TextToAudio",
          inputs: { prompt: "old", duration_seconds: 4, sample_rate: 44_100, audio_mode: "sound-effect", seed: 1 },
        },
        "2": { class_type: "SaveAudio", inputs: { audio: ["1", 0] } },
      },
    });
    const job = await jobs.enqueue({
      kind: "audio.generate",
      input: {
        prompt: "low cinematic cello pulse",
        mode: "music",
        durationSeconds: 12,
        sampleRate: 48_000,
        workflowId: imported.id,
        nodeId: "gpu-a",
        seed: 77,
      },
      idempotencyKey: "executor-audio-1",
      provider: "comfyui:gpu-a",
      createId: () => "generation-job-audio-1",
    });
    const executor = new ComfyGenerationExecutor(jobs, nodes, workflows, {
      pollIntervalMs: 1,
      timeoutMs: 1_000,
      webSocketFactory: null,
    });

    const completed = await executor.execute(job);
    expect(completed).toMatchObject({
      status: "succeeded",
      artifact: { mimeType: "audio/wav", fileName: "output-1.wav" },
    });
    const captured = submittedPrompt as unknown as Record<string, { inputs: Record<string, unknown> }>;
    expect(captured["1"]?.inputs).toMatchObject({
      prompt: "low cinematic cello pulse",
      duration_seconds: 12,
      sample_rate: 48_000,
      audio_mode: "music",
      seed: 77,
    });
    expect(await jobs.readArtifact(completed!, completed!.artifact!)).toEqual(Buffer.from("generated-audio-bytes"));
  });
});
