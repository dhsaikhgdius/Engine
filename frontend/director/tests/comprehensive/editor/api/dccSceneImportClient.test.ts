import { afterEach, expect, it, vi } from "vitest";
import type {
  DirectorBlendSceneImportPlanV1,
  DirectorBlendSceneManifestV1,
} from "../../../../src/dcc/directorBlendSceneImportContract";

const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../../../../src/comprehensive/editor/api/directorControlPlaneClient", () => ({
  directorControlPlaneFetch: transport.fetch,
}));

import {
  applyDirectorBlendSceneImport,
  DirectorBlendSceneImportClientError,
  previewDirectorBlendSceneImport,
  uploadDirectorBlendScene,
} from "../../../../src/comprehensive/editor/api/dccSceneImportClient";

const hash = "a".repeat(64);
const revision = `director-project-revision:v1:sha256:${"b".repeat(64)}` as const;

function manifest(): DirectorBlendSceneManifestV1 {
  return {
    schemaVersion: 1,
    contract: "director-blend-scene-v1",
    packageId: "blend-package-1",
    exportedAt: "2026-08-06T08:00:00.000Z",
    blenderVersion: "Blender 5.1.0",
    source: { fileName: "stage.blend", sha256: hash, sizeBytes: 128 },
    coordinateSystem: {
      source: "right-handed-z-up-negative-z-camera-forward",
      destination: "right-handed-y-up-negative-z-forward",
      unit: "meter",
      linearMap: "(x,y,z)->(x,z,-y)",
    },
    timeline: {
      frameStart: 1,
      frameEnd: 120,
      currentFrame: 1,
      fps: 24,
      timebase: { rate: { numerator: 24, denominator: 1 } },
    },
    scene: {
      name: "Stage",
      bundleFile: "scene.glb",
      objectCount: 1,
      meshCount: 1,
      materialCount: 1,
      actionCount: 0,
    },
    cameras: [],
    unsupported: [],
    warnings: [],
    fileHashes: { "scene.glb": hash },
  };
}

function plan(ready = true): DirectorBlendSceneImportPlanV1 {
  return {
    contract: "director-blend-scene-import-plan-v1",
    planId: "blend-package-1/plans/default.json",
    ready,
    packageId: "blend-package-1",
    packageDir: "blend-package-1/package",
    manifestHash: hash,
    targetRevision: revision,
    selection: { includeScene: true, cameraSourceIds: [] },
    operations: [
      {
        op: "create_scene_asset",
        assetId: "asset-imported-stage",
        label: "Imported stage",
        glbPath: "scene.glb",
        hash,
      },
    ],
    conflicts: [],
    warnings: [],
  };
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => vi.clearAllMocks());

it("uploads the original Blender File as a raw authenticated request with an encoded file name", async () => {
  const importedPlan = plan();
  const importedManifest = manifest();
  transport.fetch.mockResolvedValue(
    jsonResponse({
      success: true,
      result: {
        jobId: "blend-job-1",
        packagePath: "blend-package-1/package",
        manifest: importedManifest,
        plan: importedPlan,
      },
    }),
  );
  const file = new File(["BLENDER-v300"], "片场 #1.blend", { type: "application/octet-stream" });

  const result = await uploadDirectorBlendScene(file);

  expect(result).toEqual({
    jobId: "blend-job-1",
    packagePath: "blend-package-1/package",
    manifest: importedManifest,
    plan: importedPlan,
  });
  expect(transport.fetch).toHaveBeenCalledWith(
    `/api/dcc/blender-scene/uploads?filename=${encodeURIComponent(file.name)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-blender" },
      body: file,
    },
  );
  expect((transport.fetch.mock.calls[0]![1] as RequestInit).body).toBe(file);
});

it("rejects an upload response whose nested Blender manifest violates the shared schema", async () => {
  transport.fetch.mockResolvedValue(
    jsonResponse({
      success: true,
      result: {
        jobId: "blend-job-1",
        packagePath: "blend-package-1/package",
        manifest: { ...manifest(), contract: "untrusted-contract" },
        plan: plan(),
      },
    }),
  );

  await expect(uploadDirectorBlendScene(new File(["BLENDER"], "stage.blend"))).rejects.toMatchObject({
    name: "DirectorBlendSceneImportClientError",
    status: 502,
    code: "invalid_response",
  });
});

it("returns a validated conflict plan from an HTTP 409 preview", async () => {
  const conflictPlan: DirectorBlendSceneImportPlanV1 = {
    ...plan(false),
    operations: [],
    conflicts: [{ sourceId: "scene", code: "id_collision", reason: "Object ID already exists." }],
  };
  transport.fetch.mockResolvedValue(jsonResponse({ success: false, result: { plan: conflictPlan } }, 409));

  await expect(
    previewDirectorBlendSceneImport("blend-package-1/package", {
      includeScene: true,
      cameraSourceIds: ["camera-main"],
    }),
  ).resolves.toEqual(conflictPlan);
  expect(JSON.parse(String((transport.fetch.mock.calls[0]![1] as RequestInit).body))).toEqual({
    input: {
      op: "preview_blend_scene_import",
      package_dir: "blend-package-1/package",
      selection: { includeScene: true, cameraSourceIds: ["camera-main"] },
    },
  });
});

it("applies only a plan identifier with revision and idempotency guards", async () => {
  const importedPlan = plan();
  transport.fetch.mockResolvedValue(
    jsonResponse({
      success: true,
      result: {
        plan: importedPlan,
        authoring: { success: true },
        copiedAssets: [{ assetId: "asset-imported-stage", url: "/dcc-import/hash/stage.glb", hash }],
      },
    }),
  );

  await applyDirectorBlendSceneImport(importedPlan.planId, revision, "operator-import-1");

  expect(JSON.parse(String((transport.fetch.mock.calls[0]![1] as RequestInit).body))).toEqual({
    input: {
      op: "apply_blend_scene_import",
      plan_id: importedPlan.planId,
      expected_revision: revision,
      idempotency_key: "operator-import-1",
    },
  });
});

it("uses a bounded deterministic apply key and validates gateway errors", async () => {
  transport.fetch.mockResolvedValue(
    jsonResponse(
      {
        success: false,
        code: "stale_project_revision",
        error: "The live project changed.",
        recovery: "Preview the import again.",
      },
      409,
    ),
  );

  await expect(applyDirectorBlendSceneImport(plan().planId, revision)).rejects.toEqual(
    expect.objectContaining<Partial<DirectorBlendSceneImportClientError>>({
      status: 409,
      code: "stale_project_revision",
      recovery: "Preview the import again.",
    }),
  );
  const request = JSON.parse(String((transport.fetch.mock.calls[0]![1] as RequestInit).body)) as {
    input: { idempotency_key: string };
  };
  expect(request.input.idempotency_key).toMatch(/^blender-scene-import-/);
  expect(request.input.idempotency_key.length).toBeLessThanOrEqual(240);
});
