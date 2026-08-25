import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { handleAssetSizeRoute, type AssetSizeRouteDependencies } from "../../routes/assetSizeRoutes";

describe("asset size routes", () => {
  function harness(estimate?: AssetSizeRouteDependencies["sizeEstimator"]) {
    let payload: unknown = null;
    const writes: Array<{ status: number; body: unknown }> = [];
    const dependencies: AssetSizeRouteDependencies = {
      readBody: async () => payload,
      json: (_response, status, body) => writes.push({ status, body }),
      sizeEstimator: estimate,
    };
    return {
      dependencies,
      writes,
      request: (method: string) => ({ method }) as IncomingMessage,
      response: {} as ServerResponse,
      setPayload: (value: unknown) => {
        payload = value;
      },
    };
  }

  const url = (pathname: string) => new URL(`http://director.test${pathname}`);

  it("estimates a real-world height and reuses the name as the object description", async () => {
    const estimate = vi.fn(async () => ({ heightMeters: 0.92 }));
    const context = harness({ estimate });
    context.setPayload({ name: "Reading chair" });

    await expect(
      handleAssetSizeRoute(
        context.request("POST"),
        context.response,
        url("/api/assets/size-estimate"),
        context.dependencies,
      ),
    ).resolves.toBe(true);

    expect(estimate).toHaveBeenCalledWith({ name: "Reading chair", prompt: "Reading chair" });
    expect(context.writes.at(-1)).toEqual({ status: 200, body: { heightMeters: 0.92 } });
  });

  it("forwards an explicit prompt as the object description", async () => {
    const estimate = vi.fn(async () => ({ heightMeters: 4 }));
    const context = harness({ estimate });
    context.setPayload({ name: "Lamp", prompt: "A victorian street lamp" });

    await handleAssetSizeRoute(
      context.request("POST"),
      context.response,
      url("/api/assets/size-estimate"),
      context.dependencies,
    );

    expect(estimate).toHaveBeenCalledWith({ name: "Lamp", prompt: "A victorian street lamp" });
    expect(context.writes.at(-1)).toEqual({ status: 200, body: { heightMeters: 4 } });
  });

  it("rejects malformed requests before calling the estimator", async () => {
    const estimate = vi.fn(async () => ({ heightMeters: 1 }));
    const context = harness({ estimate });
    context.setPayload({ name: "   ", unexpected: true });

    await handleAssetSizeRoute(
      context.request("POST"),
      context.response,
      url("/api/assets/size-estimate"),
      context.dependencies,
    );

    expect(estimate).not.toHaveBeenCalled();
    expect(context.writes.at(-1)).toMatchObject({ status: 400, body: { message: expect.stringContaining("invalid") } });
  });

  it("reports an unconfigured estimator and an estimator failure without pretending to know a size", async () => {
    const unconfigured = harness();
    unconfigured.setPayload({ name: "Chair" });
    await handleAssetSizeRoute(
      unconfigured.request("POST"),
      unconfigured.response,
      url("/api/assets/size-estimate"),
      unconfigured.dependencies,
    );
    expect(unconfigured.writes.at(-1)).toMatchObject({
      status: 503,
      body: { code: "asset_size_estimator_not_configured" },
    });

    const failing = harness({
      estimate: async () => {
        throw new Error("estimator offline");
      },
    });
    failing.setPayload({ name: "Chair" });
    await handleAssetSizeRoute(
      failing.request("POST"),
      failing.response,
      url("/api/assets/size-estimate"),
      failing.dependencies,
    );
    expect(failing.writes.at(-1)).toMatchObject({
      status: 502,
      body: { code: "asset_size_estimate_failed", message: "estimator offline" },
    });
  });

  it("leaves other methods and paths to the rest of the gateway", async () => {
    const context = harness({ estimate: vi.fn(async () => ({ heightMeters: 1 })) });

    await expect(
      handleAssetSizeRoute(
        context.request("GET"),
        context.response,
        url("/api/assets/size-estimate"),
        context.dependencies,
      ),
    ).resolves.toBe(false);
    await expect(
      handleAssetSizeRoute(context.request("POST"), context.response, url("/api/assets"), context.dependencies),
    ).resolves.toBe(false);
    expect(context.writes).toHaveLength(0);
  });
});
