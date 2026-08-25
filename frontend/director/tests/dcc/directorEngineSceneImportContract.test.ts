import { getDirectorProjectRevision } from "../../src/comprehensive/editor/schema/directorProjectRevision";
import { createDefaultDirectorProject } from "../../src/comprehensive/editor/store/directorStore";
import {
  DIRECTOR_ENGINE_COORDINATE_SYSTEMS,
  DIRECTOR_ENGINE_SCENE_CONTRACT,
  DIRECTOR_ENGINE_SCENE_IMPORT_PLAN_CONTRACT,
  directorEngineSceneImportPlanSchema,
  directorEngineSceneManifestSchema,
  type DirectorEngineSceneProvider,
} from "../../src/dcc/directorEngineSceneImportContract";

const hash = "a".repeat(64);
const identity = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } as const;

function manifest(provider: DirectorEngineSceneProvider = "unreal") {
  const coordinate = DIRECTOR_ENGINE_COORDINATE_SYSTEMS[provider];
  return {
    schemaVersion: 1 as const,
    contract: DIRECTOR_ENGINE_SCENE_CONTRACT,
    packageId: `${provider}-scene-a`,
    provider,
    exportedAt: "2026-08-25T00:00:00.000Z",
    engineVersion: provider === "unreal" ? "5.6.1" : "6000.0.82f1",
    exporter: { name: `director-${provider}-scene-export`, version: "1.0.0" },
    source: { projectName: "Fixture", sceneName: "Set" },
    coordinateSystem: {
      source: coordinate.source,
      destination: coordinate.destination,
      unit: coordinate.unit,
      linearMap: coordinate.linearMap,
    },
    timeline: { frameStart: 0, frameEnd: 0, currentFrame: 0, fps: 30 },
    scene: {
      name: "Set",
      bundleFile: "assets/scene.glb",
      nodeCount: 3,
      meshCount: 1,
      skinnedMeshCount: 1,
      materialCount: 2,
      animationClipCount: 1,
    },
    nodes: [
      { sourceId: "root", name: "Root", kind: "group" as const, transform: identity },
      { sourceId: "mesh-1", name: "Crate", parentSourceId: "root", kind: "mesh" as const, transform: identity },
      { sourceId: "hero", name: "Hero", parentSourceId: "root", kind: "skinned-mesh" as const, transform: identity },
    ],
    cameras: [
      {
        sourceId: "camera-main",
        name: "Main",
        position: [0, 1.7, 5] as [number, number, number],
        lookTarget: [0, 1.5, 0] as [number, number, number],
        verticalFovDegrees: 35,
        sensorWidthMm: 36,
        sensorHeightMm: 24,
        apertureFStop: 2.8,
        focusDistanceM: 5,
        nearClipM: 0.1,
        farClipM: 10_000,
        renderAspectRatio: 16 / 9,
      },
    ],
    lights: [
      {
        sourceId: "light-sun",
        name: "Sun",
        type: "directional" as const,
        color: "#fff2e0",
        intensity: 1,
        position: [0, 10, 0] as [number, number, number],
        target: [0, 0, 0] as [number, number, number],
        castShadow: true,
      },
      {
        sourceId: "light-spot",
        name: "Key",
        type: "spot" as const,
        color: "#ffcc88",
        intensity: 1.25,
        position: [2, 3, 2] as [number, number, number],
        target: [0, 1, 0] as [number, number, number],
        angleDegrees: 45,
        penumbra: 0.2,
        rangeM: 20,
        castShadow: false,
      },
    ],
    animationClips: [{ name: "Idle", durationSeconds: 2.5 }],
    unsupported: [],
    warnings: [],
    fileHashes: { "assets/scene.glb": hash },
  };
}

describe("engine scene import contracts", () => {
  it("accepts Unreal and Unity manifests already converted to Director space", () => {
    expect(directorEngineSceneManifestSchema.parse(manifest("unreal"))).toMatchObject({
      provider: "unreal",
      coordinateSystem: { linearMap: "(x,y,z)->(y,z,-x)*0.01" },
    });
    expect(directorEngineSceneManifestSchema.parse(manifest("unity"))).toMatchObject({
      provider: "unity",
      coordinateSystem: { linearMap: "(x,y,z)->(-x,y,z)" },
    });
  });

  it("pins each provider to its documented coordinate conversion", () => {
    const crossed = {
      ...manifest("unity"),
      coordinateSystem: { ...manifest("unreal").coordinateSystem },
    };
    expect(directorEngineSceneManifestSchema.safeParse(crossed).success).toBe(false);
  });

  it("requires a GLB bundle for renderable geometry and a hash for the bundle", () => {
    const base = manifest();
    expect(
      directorEngineSceneManifestSchema.safeParse({
        ...base,
        scene: { ...base.scene, bundleFile: null },
      }).success,
    ).toBe(false);
    expect(directorEngineSceneManifestSchema.safeParse({ ...base, fileHashes: {} }).success).toBe(false);
    expect(
      directorEngineSceneManifestSchema.safeParse({
        ...base,
        scene: { ...base.scene, bundleFile: "../scene.glb" },
      }).success,
    ).toBe(false);
  });

  it("rejects broken hierarchy snapshots", () => {
    const base = manifest();
    expect(
      directorEngineSceneManifestSchema.safeParse({
        ...base,
        nodes: [base.nodes[0], base.nodes[0]],
      }).success,
    ).toBe(false);
    expect(
      directorEngineSceneManifestSchema.safeParse({
        ...base,
        nodes: [{ ...base.nodes[1], parentSourceId: "missing-parent" }],
      }).success,
    ).toBe(false);
    expect(
      directorEngineSceneManifestSchema.safeParse({
        ...base,
        nodes: [{ ...base.nodes[0], parentSourceId: base.nodes[0]!.sourceId }],
      }).success,
    ).toBe(false);
  });

  it("rejects degenerate cameras and physically incomplete lights", () => {
    const base = manifest();
    const camera = base.cameras[0]!;
    expect(
      directorEngineSceneManifestSchema.safeParse({
        ...base,
        cameras: [{ ...camera, lookTarget: camera.position }],
      }).success,
    ).toBe(false);
    expect(
      directorEngineSceneManifestSchema.safeParse({
        ...base,
        cameras: [{ ...camera, farClipM: camera.nearClipM }],
      }).success,
    ).toBe(false);
    const { angleDegrees: _angle, ...spotWithoutAngle } = base.lights[1]!;
    expect(directorEngineSceneManifestSchema.safeParse({ ...base, lights: [spotWithoutAngle] }).success).toBe(false);
    const { target: _target, ...sunWithoutTarget } = base.lights[0]!;
    expect(directorEngineSceneManifestSchema.safeParse({ ...base, lights: [sunWithoutTarget] }).success).toBe(false);
    expect(
      directorEngineSceneManifestSchema.safeParse({
        ...base,
        lights: [
          {
            sourceId: "light-rect",
            name: "Rect",
            type: "rect-area",
            color: "#ffffff",
            intensity: 1,
            position: [0, 2, 0],
            target: [0, 0, 0],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("validates a revision-bound plan and rejects inconsistent readiness or selections", () => {
    const targetRevision = getDirectorProjectRevision(createDefaultDirectorProject());
    const plan = {
      contract: DIRECTOR_ENGINE_SCENE_IMPORT_PLAN_CONTRACT,
      planId: "unreal-job/plans/abc123.json",
      ready: true,
      provider: "unreal" as const,
      packageId: "unreal-scene-a",
      packageDir: "unreal-job/package",
      manifestHash: hash,
      targetRevision,
      selection: { includeScene: true, cameraSourceIds: ["camera-main"], lightSourceIds: ["light-sun"] },
      operations: [
        {
          op: "create_scene_asset" as const,
          assetId: "engine-scene-asset-a",
          label: "Set",
          glbPath: "assets/scene.glb",
          hash,
        },
        {
          op: "create_light" as const,
          sourceId: "light-sun",
          lightId: "engine-light-a",
          name: "Sun",
          type: "directional" as const,
          color: "#fff2e0",
          intensity: 1,
          position: [0, 10, 0] as [number, number, number],
          target: [0, 0, 0] as [number, number, number],
          castShadow: true,
        },
      ],
      conflicts: [],
      warnings: [],
    };
    expect(directorEngineSceneImportPlanSchema.safeParse(plan).success).toBe(true);
    expect(
      directorEngineSceneImportPlanSchema.safeParse({
        ...plan,
        conflicts: [{ sourceId: "scene", code: "id_collision" as const, reason: "Director ID exists." }],
      }).success,
    ).toBe(false);
    expect(
      directorEngineSceneImportPlanSchema.safeParse({
        ...plan,
        selection: { ...plan.selection, lightSourceIds: ["light-sun", "light-sun"] },
      }).success,
    ).toBe(false);
  });
});
