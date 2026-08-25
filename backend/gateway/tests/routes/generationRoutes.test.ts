import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComfyGenerationExecutor } from "../../generation/comfyGenerationExecutor";
import { ComfyNodePool } from "../../generation/comfyNodePool";
import { ComfyWorkflowStore } from "../../generation/comfyWorkflowStore";
import { ProductionJobStore } from "../../jobs/productionJobStore";
import { handleGenerationRoute, type GenerationRouteDependencies } from "../../routes/generationRoutes";

const workflow = {
  "1": { class_type: "CLIPTextEncode", inputs: { text: "prompt" }, _meta: { title: "Positive Prompt" } },
  "2": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512, batch_size: 1 } },
  "3": { class_type: "KSampler", inputs: { seed: 1, steps: 20 } },
  "4": { class_type: "SaveImage", inputs: { images: ["3", 0] } },
};

describe("generation routes", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((directory) => rm(directory, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  async function harness() {
    const directory = await mkdtemp(join(tmpdir(), "director-generation-routes-"));
    tempDirs.push(directory);
    let outputKind: "image" | "audio" = "image";
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/system_stats")) {
        return new Response(JSON.stringify({ system: {}, devices: [{ name: "Route GPU" }] }));
      }
      if (url.endsWith("/queue")) return new Response(JSON.stringify({ queue_running: [], queue_pending: [] }));
      if (url.endsWith("/object_info")) {
        return new Response(
          JSON.stringify({
            CLIPTextEncode: {},
            EmptyLatentImage: {},
            KSampler: {},
            SaveImage: {},
            LoadImage: {},
            TextToAudio: {},
            SaveAudio: {},
          }),
        );
      }
      if (url.endsWith("/prompt")) {
        const submitted = JSON.parse(String(init?.body)) as { prompt?: Record<string, { class_type?: string }> };
        outputKind = Object.values(submitted.prompt ?? {}).some((node) => node.class_type === "SaveAudio")
          ? "audio"
          : "image";
        return new Response(JSON.stringify({ prompt_id: "route-prompt-1" }));
      }
      if (url.endsWith("/upload/image")) {
        expect(init?.method).toBe("POST");
        expect(init?.body).toBeInstanceOf(FormData);
        return new Response(JSON.stringify({ name: "director-reference.png", subfolder: "director", type: "input" }));
      }
      if (url.endsWith("/history/route-prompt-1")) {
        return new Response(
          JSON.stringify({
            "route-prompt-1": {
              status: { status_str: "success", completed: true },
              outputs:
                outputKind === "audio"
                  ? { "2": { audio: [{ filename: "route.wav", subfolder: "", type: "output" }] } }
                  : { "4": { images: [{ filename: "route.png", subfolder: "", type: "output" }] } },
            },
          }),
        );
      }
      if (url.includes("/view?"))
        return new Response(Buffer.from(outputKind === "audio" ? "route-audio" : "route-image"));
      throw new Error(`Unexpected request ${url}`);
    });
    const store = new ProductionJobStore(directory);
    const nodes = new ComfyNodePool(
      directory,
      [{ id: "route-gpu", label: "Route GPU", baseUrl: "http://route.comfy", enabled: true, maxConcurrent: 1 }],
      fetchImpl as typeof fetch,
    );
    const workflows = new ComfyWorkflowStore(directory);
    const executor = new ComfyGenerationExecutor(store, nodes, workflows, {
      pollIntervalMs: 1,
      timeoutMs: 1_000,
      webSocketFactory: null,
    });
    let payload: unknown = null;
    const writes: Array<{ status: number; body: unknown }> = [];
    const dependencies: GenerationRouteDependencies = {
      readBody: async () => payload,
      json: (_response, status, body) => writes.push({ status, body }),
      store,
      nodes,
      workflows,
      executor,
      createJobId: () => "generation-route-job",
    };
    return {
      dependencies,
      store,
      writes,
      response: {} as ServerResponse,
      request: (method: string) => ({ method }) as IncomingMessage,
      setPayload: (value: unknown) => {
        payload = value;
      },
    };
  }

  async function waitForSuccess(store: ProductionJobStore) {
    for (let index = 0; index < 100; index += 1) {
      const job = await store.get("generation-route-job");
      if (job?.status === "succeeded") return job;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Generation route job did not finish");
  }

  it("imports an API workflow, schedules a real provider job, and lists its durable result", async () => {
    const context = await harness();
    context.setPayload({ name: "Route workflow", mediaKind: "image", workflow });
    await handleGenerationRoute(
      context.request("POST"),
      context.response,
      new URL("http://director.test/api/generation/workflows"),
      context.dependencies,
    );
    expect(context.writes[0]).toMatchObject({ status: 201, body: { workflow: { mediaKind: "image" } } });
    const workflowId = (context.writes[0]!.body as { workflow: { id: string } }).workflow.id;

    context.setPayload({
      kind: "image.generate",
      workflowId,
      prompt: "route generated portrait",
      width: 640,
      height: 640,
      seed: 9,
      nodeIds: ["route-gpu"],
      copies: 1,
    });
    await handleGenerationRoute(
      context.request("POST"),
      context.response,
      new URL("http://director.test/api/generation/jobs"),
      context.dependencies,
    );
    expect(context.writes.at(-1)).toMatchObject({ status: 202, body: { jobs: [{ id: "generation-route-job" }] } });
    const finished = await waitForSuccess(context.store);
    expect(finished).toMatchObject({ status: "succeeded" });
    expect(finished.artifacts).toEqual(expect.arrayContaining([expect.objectContaining({ mimeType: "image/png" })]));

    await handleGenerationRoute(
      context.request("GET"),
      context.response,
      new URL("http://director.test/api/generation/jobs"),
      context.dependencies,
    );
    expect(context.writes.at(-1)).toMatchObject({ status: 200, body: { jobs: [{ status: "succeeded" }] } });
  });

  it("expands the prompt at the gateway when enhancePrompt is requested", async () => {
    const context = await harness();
    context.dependencies.imagePromptExpander = {
      expand: async (input) => ({
        expandedPrompt: `Expanded: ${input.prompt}, warm rim light, ${input.width}x${input.height} framing`,
        suggestedNegativePrompt: "warped text, watermark",
      }),
    };
    context.setPayload({ name: "PE workflow", mediaKind: "image", workflow });
    await handleGenerationRoute(
      context.request("POST"),
      context.response,
      new URL("http://director.test/api/generation/workflows"),
      context.dependencies,
    );
    const workflowId = (context.writes.at(-1)!.body as { workflow: { id: string } }).workflow.id;

    context.setPayload({
      kind: "image.generate",
      workflowId,
      prompt: "复古咖啡馆海报",
      width: 640,
      height: 640,
      seed: 9,
      nodeIds: ["route-gpu"],
      copies: 1,
      enhancePrompt: true,
    });
    await handleGenerationRoute(
      context.request("POST"),
      context.response,
      new URL("http://director.test/api/generation/jobs"),
      context.dependencies,
    );
    expect(context.writes.at(-1)).toMatchObject({
      status: 202,
      body: {
        jobs: [
          {
            input: {
              prompt: "Expanded: 复古咖啡馆海报, warm rim light, 640x640 framing",
              negativePrompt: "warped text, watermark",
              sourceContext: { metadata: { raw_prompt: "复古咖啡馆海报", prompt_expanded: true } },
            },
          },
        ],
      },
    });
    expect((context.writes.at(-1)!.body as { warnings?: string[] }).warnings).toBeUndefined();
    await waitForSuccess(context.store);
  });

  it("falls back to the verbatim prompt with a warning when expansion fails", async () => {
    const context = await harness();
    context.dependencies.imagePromptExpander = {
      expand: async () => {
        throw new Error("expansion model unavailable");
      },
    };
    context.setPayload({ name: "PE fallback workflow", mediaKind: "image", workflow });
    await handleGenerationRoute(
      context.request("POST"),
      context.response,
      new URL("http://director.test/api/generation/workflows"),
      context.dependencies,
    );
    const workflowId = (context.writes.at(-1)!.body as { workflow: { id: string } }).workflow.id;

    context.setPayload({
      kind: "image.generate",
      workflowId,
      prompt: "复古咖啡馆海报",
      width: 640,
      height: 640,
      seed: 9,
      nodeIds: ["route-gpu"],
      copies: 1,
      enhancePrompt: true,
    });
    await handleGenerationRoute(
      context.request("POST"),
      context.response,
      new URL("http://director.test/api/generation/jobs"),
      context.dependencies,
    );
    expect(context.writes.at(-1)).toMatchObject({
      status: 202,
      body: {
        jobs: [{ input: { prompt: "复古咖啡馆海报" } }],
        warnings: [expect.stringContaining("expansion model unavailable")],
      },
    });
    await waitForSuccess(context.store);
  });

  it("returns the original durable generation job for an exact idempotent retry", async () => {
    const context = await harness();
    context.setPayload({ name: "Retry workflow", mediaKind: "image", workflow });
    await handleGenerationRoute(
      context.request("POST"),
      context.response,
      new URL("http://director.test/api/generation/workflows"),
      context.dependencies,
    );
    const workflowId = (context.writes.at(-1)!.body as { workflow: { id: string } }).workflow.id;
    const submit = {
      kind: "image.generate",
      workflowId,
      prompt: "exact retry city plate",
      width: 640,
      height: 640,
      seed: 9,
      nodeIds: ["route-gpu"],
      copies: 1,
      idempotencyKey: "generation-route-exact-retry",
    };
    context.setPayload(submit);
    await handleGenerationRoute(
      context.request("POST"),
      context.response,
      new URL("http://director.test/api/generation/jobs"),
      context.dependencies,
    );
    const first = context.writes.at(-1)!.body as { groupId: string; jobs: Array<{ id: string }> };
    await waitForSuccess(context.store);

    context.setPayload(submit);
    await handleGenerationRoute(
      context.request("POST"),
      context.response,
      new URL("http://director.test/api/generation/jobs"),
      context.dependencies,
    );
    const replay = context.writes.at(-1)!.body as { groupId: string; jobs: Array<{ id: string }> };
    expect(replay).toMatchObject({ groupId: first.groupId, jobs: [{ id: first.jobs[0]!.id }] });
    expect(await context.store.list(["image.generate"])).toHaveLength(1);
  });

  it("rejects imported workflows that use classes unavailable on the configured node pool", async () => {
    const context = await harness();
    context.setPayload({
      name: "Unsupported",
      mediaKind: "image",
      workflow: { ...workflow, "9": { class_type: "MissingCustomNode", inputs: {} } },
    });
    await handleGenerationRoute(
      context.request("POST"),
      context.response,
      new URL("http://director.test/api/generation/workflows"),
      context.dependencies,
    );
    expect(context.writes.at(-1)).toMatchObject({
      status: 422,
      body: { message: expect.stringContaining("MissingCustomNode") },
    });
  });

  it("submits typed audio modes and persists an audio provider receipt", async () => {
    const context = await harness();
    context.setPayload({
      name: "Route audio workflow",
      mediaKind: "audio",
      workflow: {
        "1": {
          class_type: "TextToAudio",
          inputs: { prompt: "old", duration_seconds: 4, sample_rate: 44_100, audio_mode: "sound-effect", seed: 1 },
        },
        "2": { class_type: "SaveAudio", inputs: { audio: ["1", 0] } },
      },
    });
    await handleGenerationRoute(
      context.request("POST"),
      context.response,
      new URL("http://director.test/api/generation/workflows"),
      context.dependencies,
    );
    const workflowId = (context.writes.at(-1)!.body as { workflow: { id: string } }).workflow.id;

    context.setPayload({
      kind: "audio.generate",
      workflowId,
      prompt: "calm Mandarin narration",
      audioMode: "speech",
      durationSeconds: 8,
      sampleRate: 48_000,
      voice: "narrator-a",
      language: "zh",
      seed: 4,
      nodeIds: ["route-gpu"],
      copies: 1,
    });
    await handleGenerationRoute(
      context.request("POST"),
      context.response,
      new URL("http://director.test/api/generation/jobs"),
      context.dependencies,
    );
    expect(context.writes.at(-1)).toMatchObject({
      status: 202,
      body: { jobs: [{ kind: "audio.generate", input: { mode: "speech", sampleRate: 48_000 } }] },
    });
    const finished = await waitForSuccess(context.store);
    expect(finished).toMatchObject({
      status: "succeeded",
      artifact: { mimeType: "audio/wav" },
    });
  });

  it("uploads a hash-verified reference image to one exact node and persists its workflow binding", async () => {
    const context = await harness();
    context.setPayload({
      name: "Reference workflow",
      mediaKind: "image",
      workflow: {
        "0": { class_type: "LoadImage", inputs: { image: "reference.png" } },
        ...workflow,
      },
    });
    await handleGenerationRoute(
      context.request("POST"),
      context.response,
      new URL("http://director.test/api/generation/workflows"),
      context.dependencies,
    );
    const workflowId = (context.writes.at(-1)!.body as { workflow: { id: string } }).workflow.id;
    const bytes = Buffer.from("exact-reference-image");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const request = Readable.from([bytes]) as IncomingMessage;
    Object.assign(request, {
      method: "POST",
      headers: { "content-type": "image/png", "content-length": String(bytes.byteLength) },
    });
    await handleGenerationRoute(
      request,
      context.response,
      new URL(
        `http://director.test/api/generation/nodes/route-gpu/input-images?source_media_id=${encodeURIComponent("creative-media:image:sha256:source")}&source_sha256=${sha256}&file_name=reference.png`,
      ),
      context.dependencies,
    );
    expect(context.writes.at(-1)).toMatchObject({
      status: 201,
      body: {
        nodeId: "route-gpu",
        sourceSha256: sha256,
        workflowValue: "director/director-reference.png",
      },
    });
    const upload = context.writes.at(-1)!.body as Record<string, unknown>;

    context.setPayload({
      kind: "image.generate",
      workflowId,
      prompt: "preserve the referenced character design",
      width: 640,
      height: 640,
      seed: 9,
      parameters: { "0.image": upload.workflowValue },
      inputImages: [{ ...upload, parameterId: "0.image" }],
      sourceArtifactIds: ["creative-media:image:sha256:source"],
      sourceContext: { source: "storyboard", metadata: { shotId: "shot-1" } },
      nodeIds: ["route-gpu"],
      copies: 1,
    });
    await handleGenerationRoute(
      context.request("POST"),
      context.response,
      new URL("http://director.test/api/generation/jobs"),
      context.dependencies,
    );
    expect(context.writes.at(-1)).toMatchObject({
      status: 202,
      body: {
        jobs: [
          {
            input: {
              parameters: { "0.image": "director/director-reference.png" },
              sourceArtifactIds: ["creative-media:image:sha256:source"],
              sourceContext: { source: "storyboard", metadata: { shotId: "shot-1" } },
              inputImages: [{ parameterId: "0.image", sourceSha256: sha256, nodeId: "route-gpu" }],
            },
          },
        ],
      },
    });
    const finished = await waitForSuccess(context.store);
    expect(finished.attempts[0]?.sourceRevisions).toMatchObject({ inputImage1: sha256 });
  });
});
