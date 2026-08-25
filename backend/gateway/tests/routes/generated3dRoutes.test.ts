import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadDirectorControlPlaneConfig } from "../../controlPlane/controlPlaneConfig";
import type { Generated3DExecutor } from "../../generation/generated3dExecutor";
import { Generated3DProviderRegistry } from "../../generation/generated3dProviders";
import type { Generated3DPromotionStore } from "../../generation/generated3dPromotionStore";
import { Generated3DSourceStore } from "../../generation/generated3dSourceStore";
import { ProductionJobStore } from "../../jobs/productionJobStore";
import { handleGenerated3DRoute, type Generated3DRouteDependencies } from "../../routes/generated3dRoutes";

describe("generated 3D routes", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
    directories.length = 0;
  });

  async function harness(configured = true) {
    const directory = await mkdtemp(join(tmpdir(), "director-generated-3d-routes-"));
    directories.push(directory);
    const config = loadDirectorControlPlaneConfig("/tmp/director", {
      ...(configured ? { DIRECTOR_MESHY_API_KEY: "route-secret" } : {}),
    });
    const store = new ProductionJobStore(directory);
    const execute = vi.fn(async () => undefined);
    const cancel = vi.fn(async () => null);
    const reconcile = vi.fn(async () => null);
    const promote = vi.fn(async () => null);
    let payload: unknown = null;
    const writes: Array<{ status: number; body: unknown }> = [];
    const dependencies: Generated3DRouteDependencies = {
      readBody: async () => payload,
      json: (_response, status, body) => writes.push({ status, body }),
      store,
      providers: new Generated3DProviderRegistry(config.generation.generated3d, vi.fn() as typeof fetch),
      sources: new Generated3DSourceStore(directory),
      executor: { execute, cancel, reconcile } as unknown as Generated3DExecutor,
      promotions: { promote } as unknown as Generated3DPromotionStore,
      createJobId: () => "generated-route-job",
    };
    return {
      dependencies,
      execute,
      promote,
      store,
      writes,
      request: (method: string) => ({ method }) as IncomingMessage,
      response: {} as ServerResponse,
      setPayload: (value: unknown) => {
        payload = value;
      },
    };
  }

  it("publishes secret-free capabilities and enqueues a durable provider job", async () => {
    const context = await harness();
    await handleGenerated3DRoute(
      context.request("GET"),
      context.response,
      new URL("http://director.test/api/generation/3d/providers"),
      context.dependencies,
    );
    expect(context.writes.at(-1)).toMatchObject({
      status: 200,
      body: {
        defaultProvider: "meshy",
        providers: expect.arrayContaining([expect.objectContaining({ id: "meshy", configured: true })]),
      },
    });
    expect(JSON.stringify(context.writes.at(-1))).not.toContain("route-secret");

    context.setPayload({
      mode: "text-to-3d",
      providerId: "meshy",
      name: "Route chair",
      prompt: "A production chair",
      targetHeightMeters: 1.2,
      topology: "triangle",
      targetPolygonCount: 40_000,
      texture: true,
      pbr: true,
      seed: 7,
      idempotencyKey: "generated-route-key",
    });
    await handleGenerated3DRoute(
      context.request("POST"),
      context.response,
      new URL("http://director.test/api/generation/3d/jobs"),
      context.dependencies,
    );
    expect(context.writes.at(-1)).toMatchObject({
      status: 202,
      body: { job: { id: "generated-route-job", kind: "model.generate", status: "queued" } },
    });
    expect(context.execute).toHaveBeenCalledWith(expect.objectContaining({ id: "generated-route-job" }));
    expect(await context.store.get("generated-route-job")).toMatchObject({
      input: { providerId: "meshy", targetHeightMeters: 1.2 },
      attempts: [{ provider: "generated3d:meshy" }],
    });
  });

  it("estimates a real-world height when the submission omits one", async () => {
    const context = await harness();
    context.dependencies.sizeEstimator = {
      estimate: async (input) => {
        expect(input).toMatchObject({ name: "Street lamp", prompt: "A victorian street lamp" });
        return { heightMeters: 4.2 };
      },
    };
    context.setPayload({
      mode: "text-to-3d",
      providerId: "meshy",
      name: "Street lamp",
      prompt: "A victorian street lamp",
      topology: "triangle",
      targetPolygonCount: 40_000,
      texture: true,
      pbr: true,
      seed: 7,
    });
    await handleGenerated3DRoute(
      context.request("POST"),
      context.response,
      new URL("http://director.test/api/generation/3d/jobs"),
      context.dependencies,
    );
    expect(context.writes.at(-1)).toMatchObject({ status: 202 });
    expect(await context.store.get("generated-route-job")).toMatchObject({
      input: { targetHeightMeters: 4.2 },
    });
  });

  it("falls back to the default height when estimation fails or an explicit height is given", async () => {
    const failing = await harness();
    failing.dependencies.sizeEstimator = {
      estimate: async () => {
        throw new Error("estimator offline");
      },
    };
    failing.setPayload({
      mode: "text-to-3d",
      providerId: "meshy",
      name: "Mystery object",
      prompt: "An object",
      topology: "triangle",
      targetPolygonCount: 40_000,
      texture: true,
      pbr: true,
      seed: 7,
    });
    await handleGenerated3DRoute(
      failing.request("POST"),
      failing.response,
      new URL("http://director.test/api/generation/3d/jobs"),
      failing.dependencies,
    );
    expect(failing.writes.at(-1)).toMatchObject({ status: 202 });
    expect(await failing.store.get("generated-route-job")).toMatchObject({ input: { targetHeightMeters: 1 } });

    const explicit = await harness();
    const estimate = vi.fn(async () => ({ heightMeters: 9 }));
    explicit.dependencies.sizeEstimator = { estimate };
    explicit.setPayload({
      mode: "text-to-3d",
      providerId: "meshy",
      name: "Chair",
      prompt: "A chair",
      targetHeightMeters: 0.9,
      topology: "triangle",
      targetPolygonCount: 40_000,
      texture: true,
      pbr: true,
      seed: 7,
    });
    await handleGenerated3DRoute(
      explicit.request("POST"),
      explicit.response,
      new URL("http://director.test/api/generation/3d/jobs"),
      explicit.dependencies,
    );
    expect(estimate).not.toHaveBeenCalled();
    expect(await explicit.store.get("generated-route-job")).toMatchObject({ input: { targetHeightMeters: 0.9 } });
  });

  it("rejects malformed and unconfigured requests before charging a provider", async () => {
    const invalid = await harness();
    invalid.setPayload({ mode: "image-to-3d", providerId: "meshy", name: "Missing image", prompt: "Object" });
    await handleGenerated3DRoute(
      invalid.request("POST"),
      invalid.response,
      new URL("http://director.test/api/generation/3d/jobs"),
      invalid.dependencies,
    );
    expect(invalid.writes.at(-1)).toMatchObject({ status: 400 });
    expect(invalid.execute).not.toHaveBeenCalled();

    const missing = await harness(false);
    missing.setPayload({
      mode: "text-to-3d",
      providerId: "meshy",
      name: "No provider",
      prompt: "Object",
      targetHeightMeters: 1,
      topology: "triangle",
      targetPolygonCount: 50_000,
      texture: true,
      pbr: true,
      seed: 0,
    });
    await handleGenerated3DRoute(
      missing.request("POST"),
      missing.response,
      new URL("http://director.test/api/generation/3d/jobs"),
      missing.dependencies,
    );
    expect(missing.writes.at(-1)).toMatchObject({
      status: 409,
      body: { message: expect.stringContaining("not configured") },
    });
    expect(missing.execute).not.toHaveBeenCalled();
  });

  it("routes explicit promotion requests through the verified promotion store", async () => {
    const context = await harness();
    context.promote.mockResolvedValue({ contract: "director-generated-3d-v1", jobId: "job-1" } as never);
    await handleGenerated3DRoute(
      context.request("POST"),
      context.response,
      new URL("http://director.test/api/generation/3d/jobs/job-1/promote"),
      context.dependencies,
    );
    expect(context.promote).toHaveBeenCalledWith("job-1");
    expect(context.writes.at(-1)).toMatchObject({ status: 200, body: { promotion: { jobId: "job-1" } } });
  });
});
