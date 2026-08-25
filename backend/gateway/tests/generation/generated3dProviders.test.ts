import { describe, expect, it, vi } from "vitest";
import { loadDirectorControlPlaneConfig } from "../../controlPlane/controlPlaneConfig";
import { Generated3DProviderRegistry } from "../../generation/generated3dProviders";

const textInput = {
  mode: "text-to-3d" as const,
  providerId: "meshy" as const,
  name: "Chair",
  prompt: "A wooden chair",
  negativePrompt: undefined,
  sourceImage: null,
  targetHeightMeters: 1,
  topology: "triangle" as const,
  targetPolygonCount: 50_000,
  texture: true,
  pbr: true,
  seed: 1,
  modelVersion: "latest",
};

describe("generated 3D provider adapters", () => {
  it("executes Meshy's current preview-to-refine task protocol", async () => {
    const calls: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      calls.push({ url, method, body });
      if (method === "POST" && body?.mode === "preview") return Response.json({ result: "preview-1" });
      if (method === "POST" && body?.mode === "refine") return Response.json({ result: "refine-1" });
      if (url.endsWith("/preview-1")) return Response.json({ status: "SUCCEEDED", progress: 100 });
      if (url.endsWith("/refine-1")) {
        return Response.json({
          status: "SUCCEEDED",
          progress: 100,
          model_urls: { glb: "https://assets.test/chair.glb" },
          alpha_thumbnail_url: "https://assets.test/chair.png",
        });
      }
      if (method === "DELETE") return new Response(null, { status: 200 });
      throw new Error(`Unexpected request ${method} ${url}`);
    });
    const config = loadDirectorControlPlaneConfig("/tmp/director", {
      DIRECTOR_MESHY_API_KEY: "meshy-secret",
      DIRECTOR_MESHY_BASE_URL: "https://meshy.test",
    });
    const provider = new Generated3DProviderRegistry(config.generation.generated3d, fetchImpl as typeof fetch).get(
      "meshy",
    );
    const signal = new AbortController().signal;
    const previewId = await provider.submit(textInput, null, signal);
    expect(previewId).toBe("meshy:text-preview:preview-1");
    const refining = await provider.inspect(previewId, textInput, signal);
    expect(refining).toMatchObject({ status: "running", progress: 0.5, externalId: "meshy:text-refine:refine-1" });
    const finished = await provider.inspect(refining.externalId, textInput, signal);
    expect(finished).toMatchObject({
      status: "succeeded",
      modelUrl: "https://assets.test/chair.glb",
      thumbnailUrl: "https://assets.test/chair.png",
    });
    expect(calls.find((call) => call.body?.mode === "preview")?.body).toMatchObject({ target_formats: ["glb"] });
    expect(calls.find((call) => call.body?.mode === "refine")?.body).toMatchObject({ enable_pbr: true });
  });

  it("uploads an image and submits Tripo's unified image_to_model task", async () => {
    let taskBody: Record<string, unknown> | null = null;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/upload/sts")) {
        expect(init?.body).toBeInstanceOf(FormData);
        return Response.json({ code: 0, data: { image_token: "image-token-1" } });
      }
      if (url.endsWith("/task") && init?.method === "POST") {
        taskBody = JSON.parse(String(init.body));
        return Response.json({ code: 0, data: { task_id: "tripo-task-1" } });
      }
      if (url.endsWith("/task/tripo-task-1")) {
        return Response.json({
          code: 0,
          data: {
            task_id: "tripo-task-1",
            status: "success",
            progress: 100,
            output: {
              pbr_model: "https://assets.test/tripo.glb",
              rendered_image: "https://assets.test/tripo.webp",
            },
          },
        });
      }
      throw new Error(`Unexpected request ${url}`);
    });
    const config = loadDirectorControlPlaneConfig("/tmp/director", {
      DIRECTOR_TRIPO_API_KEY: "tripo-secret",
      DIRECTOR_TRIPO_BASE_URL: "https://tripo.test/openapi",
      DIRECTOR_3D_PROVIDER: "tripo",
    });
    const provider = new Generated3DProviderRegistry(config.generation.generated3d, fetchImpl as typeof fetch).get(
      "tripo",
    );
    const input = {
      ...textInput,
      mode: "image-to-3d" as const,
      providerId: "tripo" as const,
      sourceImage: { sha256: "a".repeat(64), mimeType: "image/jpeg" as const, bytes: 8 },
      texture: true,
    };
    const signal = new AbortController().signal;
    const externalId = await provider.submit(
      input,
      { bytes: Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3, 4, 5]), mimeType: "image/jpeg" },
      signal,
    );
    expect(externalId).toBe("tripo:task:tripo-task-1");
    expect(taskBody).toMatchObject({
      type: "image_to_model",
      file: { type: "jpeg", file_token: "image-token-1" },
      render_image: true,
    });
    expect(await provider.inspect(externalId, input, signal)).toMatchObject({ status: "succeeded", progress: 1 });
    expect(await provider.cancel(externalId, input, signal)).toBe(false);
  });
});
