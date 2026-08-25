import { beforeEach, describe, expect, it, vi } from "vitest";

const clientMocks = vi.hoisted(() => ({ directorControlPlaneFetch: vi.fn() }));

vi.mock("../../../../src/comprehensive/editor/api/directorControlPlaneClient", () => ({
  directorControlPlaneFetch: clientMocks.directorControlPlaneFetch,
}));

import {
  AssetSizeClientError,
  estimateAssetRealWorldSize,
} from "../../../../src/comprehensive/editor/api/assetSizeClient";

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("assetSizeClient", () => {
  it("posts the object description and returns the estimated height in meters", async () => {
    clientMocks.directorControlPlaneFetch.mockResolvedValue(response({ heightMeters: 0.92 }));

    await expect(estimateAssetRealWorldSize({ name: "本地椅子" })).resolves.toBe(0.92);

    expect(clientMocks.directorControlPlaneFetch).toHaveBeenCalledWith(
      "/api/assets/size-estimate",
      expect.objectContaining({ method: "POST" }),
    );
    const init = clientMocks.directorControlPlaneFetch.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ name: "本地椅子" });
  });

  it("sends an explicit prompt and forwards the abort signal", async () => {
    clientMocks.directorControlPlaneFetch.mockResolvedValue(response({ heightMeters: 4 }));
    const controller = new AbortController();

    await estimateAssetRealWorldSize(
      { name: "Lamp", prompt: "A victorian street lamp" },
      { signal: controller.signal },
    );

    const init = clientMocks.directorControlPlaneFetch.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ name: "Lamp", prompt: "A victorian street lamp" });
    expect(init.signal).toBe(controller.signal);
  });

  it("surfaces the gateway failure code when estimation is unconfigured or fails", async () => {
    clientMocks.directorControlPlaneFetch.mockResolvedValueOnce(
      response({ code: "asset_size_estimator_not_configured", message: "not configured" }, 503),
    );
    await expect(estimateAssetRealWorldSize({ name: "Chair" })).rejects.toMatchObject({
      name: "AssetSizeClientError",
      message: "not configured",
      status: 503,
      code: "asset_size_estimator_not_configured",
    } satisfies Partial<AssetSizeClientError>);

    clientMocks.directorControlPlaneFetch.mockResolvedValueOnce(new Response("<html>", { status: 502 }));
    await expect(estimateAssetRealWorldSize({ name: "Chair" })).rejects.toMatchObject({
      name: "AssetSizeClientError",
      status: 502,
    });
  });

  it("rejects a success body that does not carry a usable metric size", async () => {
    clientMocks.directorControlPlaneFetch.mockResolvedValueOnce(response({ heightMeters: 0 }));
    await expect(estimateAssetRealWorldSize({ name: "Chair" })).rejects.toMatchObject({ code: "invalid_response" });

    clientMocks.directorControlPlaneFetch.mockResolvedValueOnce(response({ heightMeters: "0.9" }));
    await expect(estimateAssetRealWorldSize({ name: "Chair" })).rejects.toMatchObject({ code: "invalid_response" });
  });
});
