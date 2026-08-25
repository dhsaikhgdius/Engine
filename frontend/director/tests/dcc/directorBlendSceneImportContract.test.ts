import { getDirectorProjectRevision } from "../../src/comprehensive/editor/schema/directorProjectRevision";
import { createDefaultDirectorProject } from "../../src/comprehensive/editor/store/directorStore";
import {
  DIRECTOR_BLEND_SCENE_CONTRACT,
  DIRECTOR_BLEND_SCENE_IMPORT_PLAN_CONTRACT,
  directorBlendSceneImportPlanSchema,
  directorBlendSceneManifestSchema,
} from "../../src/dcc/directorBlendSceneImportContract";

const hash = "a".repeat(64);

function manifest() {
  return {
    schemaVersion: 1 as const,
    contract: DIRECTOR_BLEND_SCENE_CONTRACT,
    packageId: "blend-scene-a",
    exportedAt: "2026-08-06T00:00:00.000Z",
    blenderVersion: "5.1.2",
    source: { fileName: "set.blend", sha256: "b".repeat(64), sizeBytes: 1_024 },
    coordinateSystem: {
      source: "right-handed-z-up-negative-z-camera-forward" as const,
      destination: "right-handed-y-up-negative-z-forward" as const,
      unit: "meter" as const,
      linearMap: "(x,y,z)->(x,z,-y)" as const,
    },
    timeline: {
      frameStart: 1,
      frameEnd: 120,
      currentFrame: 1,
      fps: 24,
      timebase: { rate: { numerator: 24, denominator: 1 } },
    },
    scene: {
      name: "Set",
      bundleFile: "assets/scene.glb",
      objectCount: 3,
      meshCount: 2,
      materialCount: 1,
      actionCount: 0,
    },
    cameras: [
      {
        sourceId: "camera-main",
        name: "Main",
        transform: {
          location: [1, 2, 3] as [number, number, number],
          rotationQuaternion: [0, 0, 0, 1] as [number, number, number, number],
          scale: [1, 1, 1] as [number, number, number],
        },
        focalLengthMm: 50,
        sensorWidthMm: 36,
        sensorHeightMm: 24,
        sensorFit: "auto" as const,
        renderAspectRatio: 16 / 9,
        verticalFovDegrees: 22.895192,
        apertureFStop: 2.8,
        focusDistanceM: 5,
        nearClipM: 0.1,
        farClipM: 1_000,
      },
    ],
    unsupported: [],
    warnings: [],
    fileHashes: { "assets/scene.glb": hash },
  };
}

describe("Blender scene import contracts", () => {
  it("accepts a hashed metric scene bundle with physical cameras", () => {
    expect(directorBlendSceneManifestSchema.parse(manifest())).toMatchObject({
      contract: DIRECTOR_BLEND_SCENE_CONTRACT,
      scene: { bundleFile: "assets/scene.glb" },
      cameras: [{ focalLengthMm: 50 }],
    });
  });

  it("rejects traversal, missing bundle hashes, and duplicate camera identities", () => {
    expect(
      directorBlendSceneManifestSchema.safeParse({
        ...manifest(),
        scene: { ...manifest().scene, bundleFile: "../scene.glb" },
      }).success,
    ).toBe(false);
    expect(directorBlendSceneManifestSchema.safeParse({ ...manifest(), fileHashes: {} }).success).toBe(false);
    expect(
      directorBlendSceneManifestSchema.safeParse({
        ...manifest(),
        cameras: [manifest().cameras[0], manifest().cameras[0]],
      }).success,
    ).toBe(false);
  });

  it("validates a revision-bound, server-addressed import plan", () => {
    const targetRevision = getDirectorProjectRevision(createDefaultDirectorProject());
    const plan = {
      contract: DIRECTOR_BLEND_SCENE_IMPORT_PLAN_CONTRACT,
      planId: "blend-job/default",
      ready: true,
      packageId: "blend-scene-a",
      packageDir: "blend-job/package",
      manifestHash: hash,
      targetRevision,
      selection: { includeScene: true, cameraSourceIds: ["camera-main"] },
      operations: [
        {
          op: "create_scene_asset" as const,
          assetId: "asset-blend-a",
          label: "Set",
          glbPath: "assets/scene.glb",
          hash,
        },
      ],
      conflicts: [],
      warnings: [],
    };
    expect(directorBlendSceneImportPlanSchema.safeParse(plan).success).toBe(true);
    expect(
      directorBlendSceneImportPlanSchema.safeParse({
        ...plan,
        selection: { ...plan.selection, cameraSourceIds: ["camera-main", "camera-main"] },
      }).success,
    ).toBe(false);
  });
});
