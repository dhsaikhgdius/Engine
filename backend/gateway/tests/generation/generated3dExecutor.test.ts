import { Accessor, Document, NodeIO } from "@gltf-transform/core";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadDirectorControlPlaneConfig } from "../../controlPlane/controlPlaneConfig";
import { ProductionJobStore } from "../../jobs/productionJobStore";
import { Generated3DExecutor } from "../../generation/generated3dExecutor";
import { Generated3DProviderRegistry } from "../../generation/generated3dProviders";
import { Generated3DSourceStore } from "../../generation/generated3dSourceStore";

async function providerGlb() {
  const document = new Document();
  const buffer = document.createBuffer();
  const positions = document
    .createAccessor("positions")
    .setType(Accessor.Type.VEC3)
    .setArray(new Float32Array([-0.5, 1, 0, 0.5, 1, 0, 0, 2, 0.5]))
    .setBuffer(buffer);
  const mesh = document
    .createMesh("ProviderMesh")
    .addPrimitive(document.createPrimitive().setAttribute("POSITION", positions));
  const scene = document.createScene("ProviderScene").addChild(document.createNode("ProviderNode").setMesh(mesh));
  document.getRoot().setDefaultScene(scene);
  return new NodeIO().writeBinary(document);
}

describe("Generated3DExecutor", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
    directories.length = 0;
  });

  it("downloads real provider bytes, normalizes GLB, and stores model/thumbnail/receipt artifacts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "director-generated-3d-executor-"));
    directories.push(directory);
    const glb = await providerGlb();
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("thumbnail")]);
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/openapi/v2/text-to-3d") && init?.method === "POST") {
        return Response.json({ result: "provider-task-1" });
      }
      if (url.endsWith("/openapi/v2/text-to-3d/provider-task-1")) {
        return Response.json({
          status: "SUCCEEDED",
          progress: 100,
          model_urls: { glb: "https://assets.test/generated.glb" },
          thumbnail_url: "https://assets.test/generated.png",
        });
      }
      if (url === "https://assets.test/generated.glb") return new Response(glb);
      if (url === "https://assets.test/generated.png") return new Response(png);
      throw new Error(`Unexpected request ${url}`);
    });
    const config = loadDirectorControlPlaneConfig("/tmp/director", {
      DIRECTOR_MESHY_API_KEY: "meshy-secret",
      DIRECTOR_MESHY_BASE_URL: "https://meshy.test",
    });
    const jobs = new ProductionJobStore(directory);
    const providers = new Generated3DProviderRegistry(config.generation.generated3d, fetchImpl as typeof fetch);
    const sources = new Generated3DSourceStore(directory);
    const executor = new Generated3DExecutor(jobs, providers, sources, {
      fetchImpl: fetchImpl as typeof fetch,
      pollIntervalMs: 1,
      timeoutMs: 1_000,
    });
    const job = await jobs.enqueue({
      kind: "model.generate",
      input: {
        mode: "text-to-3d",
        providerId: "meshy",
        name: "Generated Chair",
        prompt: "A wooden chair",
        targetHeightMeters: 2,
        texture: false,
        pbr: false,
      },
      idempotencyKey: "generated-3d-executor-1",
      provider: "generated3d:meshy",
      createId: () => "generated-3d-job-1",
    });
    const completed = await executor.execute(job);
    expect(completed).toMatchObject({
      status: "succeeded",
      artifact: { role: "primary", fileName: "generated-model.glb", mimeType: "model/gltf-binary" },
    });
    expect(completed?.artifacts.map((artifact) => artifact.role)).toEqual(["primary", "thumbnail", "metadata"]);
    expect(completed?.attempts[0]?.externalIds).toEqual(["meshy:text-preview:provider-task-1"]);
    const receiptArtifact = completed!.artifacts.find((artifact) => artifact.role === "metadata")!;
    const receipt = JSON.parse((await jobs.readArtifact(completed!, receiptArtifact)).toString("utf8"));
    expect(receipt).toMatchObject({
      contract: "director-generated-3d-v1",
      providerId: "meshy",
      normalization: {
        stableAssetId: "generated3d:generated-3d-job-1",
        targetHeightMeters: 2,
        triangleCount: 1,
      },
    });
  });

  it("reads file:// artifacts from a local provider without any network fetch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "director-generated-3d-local-"));
    directories.push(directory);
    const modelPath = join(directory, "model.glb");
    const thumbnailPath = join(directory, "thumbnail.png");
    await writeFile(modelPath, await providerGlb());
    await writeFile(
      thumbnailPath,
      Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("thumbnail")]),
    );
    const fetchImpl = vi.fn(async () => {
      throw new Error("Local provider artifacts must not be fetched over the network");
    });
    const localProvider = {
      id: "infinigen" as const,
      localArtifacts: true,
      capability: {
        id: "infinigen" as const,
        label: "Infinigen（本地程序化）",
        configured: true,
        modes: ["text-to-3d" as const],
        modelVersion: null,
        cancellation: "local-only" as const,
        documentationUrl: "https://infinigen.org",
      },
      submit: vi.fn(async () => "infinigen:task:local-1"),
      inspect: vi.fn(async () => ({
        status: "succeeded" as const,
        progress: 1,
        externalId: "infinigen:task:local-1",
        modelUrl: `file://${modelPath}`,
        thumbnailUrl: `file://${thumbnailPath}`,
      })),
      cancel: vi.fn(async () => true),
    };
    const registry = { get: () => localProvider, capabilities: () => [localProvider.capability] };
    const jobs = new ProductionJobStore(directory);
    const sources = new Generated3DSourceStore(directory);
    const executor = new Generated3DExecutor(jobs, registry as unknown as Generated3DProviderRegistry, sources, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      pollIntervalMs: 1,
      timeoutMs: 1_000,
    });
    const job = await jobs.enqueue({
      kind: "model.generate",
      input: {
        mode: "text-to-3d",
        providerId: "infinigen",
        name: "程序化椅子",
        prompt: "ChairFactory",
        targetHeightMeters: 1,
        texture: true,
        pbr: true,
      },
      idempotencyKey: "generated-3d-executor-local-1",
      provider: "generated3d:infinigen",
      createId: () => "generated-3d-job-local-1",
    });
    const completed = await executor.execute(job);
    expect(completed).toMatchObject({
      status: "succeeded",
      artifact: { role: "primary", fileName: "generated-model.glb" },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    const receiptArtifact = completed!.artifacts.find((artifact) => artifact.role === "metadata")!;
    const receipt = JSON.parse((await jobs.readArtifact(completed!, receiptArtifact)).toString("utf8"));
    expect(receipt).toMatchObject({ providerId: "infinigen", providerOutputHosts: [] });
  });
});
