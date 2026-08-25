import { afterEach, expect, it, vi } from "vitest";
import type { DirectorDccProviderStatus } from "../../../../src/dcc/directorDccProviderContract";

const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../../../../src/comprehensive/editor/api/directorControlPlaneClient", () => ({
  directorControlPlaneFetch: transport.fetch,
}));

import {
  DirectorDccProviderClientError,
  discoverDirectorDccProviders,
  exportDirectorDccExchangePackage,
} from "../../../../src/comprehensive/editor/api/dccProviderClient";

const hash = "a".repeat(64);

function providerStatus(id = "maya", nativeReady = false): DirectorDccProviderStatus {
  return {
    provider: {
      id,
      label: id === "blender" ? "Blender" : "Autodesk Maya",
      category: "dcc",
      integration: id === "blender" ? "native-roundtrip" : "exchange-package",
      preferredFormat: id === "blender" ? "blend" : "usda",
      exchangeFormats: id === "blender" ? ["blend", "usda", "glb"] : ["usda", "glb"],
      capabilities: [
        { id: "scene", level: nativeReady ? "native" : "exchange" },
        { id: "camera", level: nativeReady ? "native" : "exchange" },
      ],
      connectorDirectory: `integrations/${id}`,
    },
    installed: nativeReady,
    executable: nativeReady ? `/opt/${id}` : null,
    version: nativeReady ? "1.0" : null,
    nativeReady,
    exchangeReady: true,
    reason: nativeReady ? null : "Portable USD/GLB exchange is ready; native automation is unavailable.",
  };
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function exchangeResult(provider = "maya") {
  return {
    contract: "director-dcc-exchange-result-v1" as const,
    jobId: "550e8400-e29b-41d4-a716-446655440000",
    provider,
    packagePath: "/workspace/data/dcc-jobs/exchange/job-1",
    manifestPath: "/workspace/data/dcc-jobs/exchange/job-1/manifest.json",
    manifestSha256: hash,
    packageDigest: hash,
    sourceRevision: `director-project-revision:v1:sha256:${hash}`,
    formats: [
      {
        format: "usda" as const,
        fileName: "scene.usda",
        path: "/workspace/data/dcc-jobs/exchange/job-1/scene.usda",
        mimeType: "model/vnd.usda" as const,
        sha256: hash,
        byteLength: 1024,
      },
    ],
    assets: [],
    warnings: [],
  };
}

afterEach(() => vi.clearAllMocks());

it("discovers and validates the dynamic DCC provider catalog", async () => {
  const catalog = {
    contract: "director-dcc-provider-catalog-v1" as const,
    providers: [providerStatus("blender", true), providerStatus("maya", false)],
  };
  transport.fetch.mockResolvedValue(jsonResponse({ success: true, result: catalog }));

  await expect(discoverDirectorDccProviders()).resolves.toEqual(catalog);
  expect(transport.fetch).toHaveBeenCalledWith("/api/dcc/providers", { signal: undefined });
});

it("rejects a malformed provider catalog instead of trusting gateway JSON", async () => {
  transport.fetch.mockResolvedValue(
    jsonResponse({
      success: true,
      result: {
        contract: "director-dcc-provider-catalog-v1",
        providers: [{ ...providerStatus(), exchangeReady: "yes" }],
      },
    }),
  );

  await expect(discoverDirectorDccProviders()).rejects.toMatchObject({
    name: "DirectorDccProviderClientError",
    status: 502,
    code: "invalid_response",
  });
});

it("exports a portable package through the provider-neutral director_dcc operation", async () => {
  const result = exchangeResult();
  transport.fetch.mockResolvedValue(jsonResponse({ success: true, result }));

  await expect(
    exportDirectorDccExchangePackage({ provider: "maya", formats: ["usda"], cameraId: "camera-main", frame: 12 }),
  ).resolves.toEqual(result);
  expect(JSON.parse(String((transport.fetch.mock.calls[0]![1] as RequestInit).body))).toEqual({
    input: {
      op: "export_exchange_package",
      provider: "maya",
      formats: ["usda"],
      camera_id: "camera-main",
      frame: 12,
    },
  });
});

it("rejects a package receipt for a different provider and preserves gateway recovery", async () => {
  transport.fetch.mockResolvedValueOnce(jsonResponse({ success: true, result: exchangeResult("unreal") }));
  await expect(exportDirectorDccExchangePackage({ provider: "maya", formats: ["usda"] })).rejects.toMatchObject({
    name: "DirectorDccProviderClientError",
    status: 502,
    code: "provider_mismatch",
  });

  transport.fetch.mockResolvedValueOnce(
    jsonResponse(
      {
        success: false,
        code: "provider_unavailable",
        error: "The selected provider is unavailable.",
        recovery: "Refresh provider discovery and choose an exchange-ready provider.",
      },
      503,
    ),
  );
  await expect(exportDirectorDccExchangePackage({ provider: "maya", formats: ["usda"] })).rejects.toEqual(
    expect.objectContaining<Partial<DirectorDccProviderClientError>>({
      status: 503,
      code: "provider_unavailable",
      recovery: "Refresh provider discovery and choose an exchange-ready provider.",
    }),
  );
});
