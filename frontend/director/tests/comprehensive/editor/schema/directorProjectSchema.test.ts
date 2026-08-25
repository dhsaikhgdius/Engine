import { describe, expect, it } from "vitest";
import { createDefaultDirectorProject } from "../../../../src/comprehensive/editor/store/directorStore";
import {
  directorProjectSchema,
  parseDirectorProject,
  repairDirectorProjectReferences,
  safeParseDirectorProject,
  safeParseDirectorProjectStructural,
} from "../../../../src/comprehensive/editor/schema/directorProjectSchema";

describe("Director project schema", () => {
  it("accepts a current Director project and preserves the portable JSON shape", () => {
    const project = createDefaultDirectorProject();

    expect(parseDirectorProject(structuredClone(project))).toEqual(project);
    expect(directorProjectSchema.safeParse(project).success).toBe(true);
  });

  it("persists 4DGS splat sequence metadata and restricts it to model assets", () => {
    const project = createDefaultDirectorProject();
    project.assets.push({
      id: "asset-dance",
      kind: "prop",
      sourceType: "model",
      fileName: "dance.4dgs.json",
      url: "/native-models/asset-dance/dance.4dgs.json",
      splatSequence: { frameCount: 48, fps: 24 },
    });

    expect(parseDirectorProject(structuredClone(project)).assets.at(-1)?.splatSequence).toEqual({
      frameCount: 48,
      fps: 24,
    });

    const invalid = structuredClone(project);
    invalid.assets.at(-1)!.sourceType = "image";
    expect(safeParseDirectorProject(invalid)).toMatchObject({
      success: false,
      error: expect.stringContaining("splatSequence"),
    });
  });

  it("persists measured local bounds and rejects inverted bounds", () => {
    const project = createDefaultDirectorProject();
    project.nativeScene = {
      engine: "blender",
      projectId: "project-a",
      sceneEpoch: "scene-a",
      revision: 8,
      contentRevision: 7,
    };
    project.assets.push({
      id: "asset-building",
      kind: "prop",
      sourceType: "model",
      fileName: "building.glb",
      url: "/models/building.glb",
      modelNormalization: "preserve",
      localBoundsM: { min: [-12, 0, -8], max: [12, 36, 8] },
    });
    project.objects.push({
      id: "building",
      name: "Building",
      kind: "prop",
      visible: true,
      locked: false,
      assetRefId: "asset-building",
      localBoundsM: { min: [-11.5, -0.2, -7.5], max: [11.5, 35.8, 7.5] },
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    });

    expect(parseDirectorProject(structuredClone(project))).toEqual(project);

    project.objects.at(-1)!.localBoundsM = { min: [1, 0, 0], max: [0, 1, 1] };
    expect(safeParseDirectorProject(project)).toMatchObject({
      success: false,
      error: expect.stringContaining("localBoundsM"),
    });
  });

  it("persists Blender camera and light identity in the same Director project", () => {
    const project = createDefaultDirectorProject();
    project.cameras[0] = {
      ...project.cameras[0]!,
      nativeSource: { engine: "blender", objectId: "native-camera-a", provisioned: true },
      projectionType: "orthographic",
      orthographicScaleM: 24,
      sensorFit: "horizontal",
      sensorWidthMm: 36,
      sensorHeightMm: 24,
      lensShiftX: 0.1,
      lensShiftY: -0.05,
    };
    project.lights![0] = {
      ...project.lights![0]!,
      nativeSource: { engine: "blender", objectId: "native-light-a", provisioned: true },
    };

    expect(parseDirectorProject(structuredClone(project))).toEqual(project);
  });

  it("keeps legacy storyboard shots valid and persists optional screenplay beat identity", () => {
    const legacyProject = createDefaultDirectorProject();
    expect(parseDirectorProject(structuredClone(legacyProject))).toEqual(legacyProject);

    const project = structuredClone(legacyProject);
    project.storyboard = {
      version: 1,
      title: "Beat identity",
      logline: "",
      shots: [
        {
          id: "shot-opening-001",
          title: "Opening",
          cameraId: project.cameras[0]?.id ?? null,
          frameStart: 0,
          frameEnd: 71,
          shotSize: "wide",
          movement: "static",
          action: "Establish the location.",
        },
      ],
    };
    project.storyboard!.shots[0]!.scriptBeatId = "beat-opening-001";
    expect(parseDirectorProject(structuredClone(project)).storyboard?.shots[0]?.scriptBeatId).toBe("beat-opening-001");
  });

  it("persists bounded storyboard thumbnail metadata", () => {
    const project = createDefaultDirectorProject();
    project.storyboard = {
      version: 1,
      title: "画面证据",
      logline: "",
      shots: [
        {
          id: "shot-thumbnail",
          title: "入点",
          cameraId: project.cameras[0]!.id,
          frameStart: 12,
          frameEnd: 35,
          shotSize: "medium",
          movement: "static",
          action: "",
          thumbnail: {
            mediaId: "creative-media:image:example",
            cameraId: project.cameras[0]!.id,
            frame: 12,
            width: 960,
            height: 540,
            capturedAt: "2026-08-07T00:00:00.000Z",
          },
        },
      ],
    };

    expect(parseDirectorProject(structuredClone(project)).storyboard?.shots[0]?.thumbnail).toEqual(
      project.storyboard.shots[0]!.thumbnail,
    );
    project.storyboard.shots[0]!.thumbnail!.width = 0;
    expect(safeParseDirectorProject(project)).toMatchObject({
      success: false,
      error: expect.stringContaining("storyboard.shots.0.thumbnail.width"),
    });
  });

  it("keeps timelines saved before stage audio existed parsing without audio tracks", () => {
    const project = createDefaultDirectorProject();
    expect(project.scene.timeline?.audioTracks).toBeUndefined();
    expect(parseDirectorProject(structuredClone(project))).toEqual(project);
    expect(parseDirectorProject(structuredClone(project)).scene.timeline?.audioTracks).toBeUndefined();
  });

  it("round-trips stage timeline audio tracks and clips", () => {
    const project = createDefaultDirectorProject();
    project.scene.timeline!.audioTracks = [
      {
        id: "audio_track_1",
        name: "音频轨 1",
        muted: false,
        clips: [
          {
            id: "audio_clip_1",
            name: "环境声",
            mediaId: "creative-media:audio:abc123",
            sourceUrl: "https://example.com/ambience.mp3",
            startFrame: 12,
            durationFrames: 96,
            inSec: 0.5,
            sourceDurationSec: 30,
            volume: 0.8,
            fadeInSec: 1,
            fadeOutSec: 2,
            muted: false,
          },
        ],
      },
    ];

    expect(parseDirectorProject(structuredClone(project))).toEqual(project);
  });

  it("rejects out-of-range and duplicate stage audio clips", () => {
    const project = createDefaultDirectorProject();
    const clip = {
      id: "audio_clip_1",
      name: "环境声",
      mediaId: "creative-media:audio:abc123",
      startFrame: 0,
      durationFrames: 24,
      inSec: 0,
      volume: 1,
      fadeInSec: 0,
      fadeOutSec: 0,
      muted: false,
    };
    project.scene.timeline!.audioTracks = [{ id: "audio_track_1", name: "音频轨 1", muted: false, clips: [clip] }];

    const overVolume = structuredClone(project);
    overVolume.scene.timeline!.audioTracks![0]!.clips[0]!.volume = 1.2;
    expect(safeParseDirectorProject(overVolume)).toMatchObject({
      success: false,
      error: expect.stringContaining("volume"),
    });

    const zeroDuration = structuredClone(project);
    zeroDuration.scene.timeline!.audioTracks![0]!.clips[0]!.durationFrames = 0;
    expect(safeParseDirectorProject(zeroDuration)).toMatchObject({
      success: false,
      error: expect.stringContaining("durationFrames"),
    });

    const duplicate = structuredClone(project);
    duplicate.scene.timeline!.audioTracks![0]!.clips = [structuredClone(clip), structuredClone(clip)];
    expect(safeParseDirectorProject(duplicate)).toMatchObject({
      success: false,
      error: expect.stringContaining("audio clip"),
    });
  });

  it("rejects malformed nested transform data before project migration", () => {
    const project = structuredClone(createDefaultDirectorProject());
    project.objects[0]!.transform.position = [0, 0] as unknown as [number, number, number];

    const result = safeParseDirectorProject(project);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("objects.0.transform.position");
  });

  it("rejects a malformed camera action instead of silently accepting it", () => {
    const project = structuredClone(createDefaultDirectorProject());
    project.cameras[0]!.action = { mode: "follow" } as never;

    expect(safeParseDirectorProject(project).success).toBe(false);
  });

  it("accepts a per-waypoint camera subject lock", () => {
    const project = createDefaultDirectorProject();
    project.cameras[0]!.animation = {
      version: 1,
      keyframes: [{ frame: 0, lookTargetObjectId: project.objects[0]!.id }],
    };

    expect(directorProjectSchema.safeParse(project).success).toBe(true);
  });

  it("validates packaged Mixamo character metadata at the project boundary", () => {
    const project = createDefaultDirectorProject();
    project.assets.push({
      id: "asset_mixamo_test",
      kind: "character",
      sourceType: "model",
      fileName: "test-character.glb",
      name: "Test Character",
      url: "/mixamo-characters/models/test-character.glb",
      assetSource: "library",
      characterMetadata: {
        heightM: 1.78,
        groundOffsetY: 0,
        visualCenter: [0, 0.89, 0],
        labelAnchorY: 1.9,
        rig: {
          type: "mixamo",
          boneCount: 65,
          boneNames: ["Hips", "Spine2", "Head"],
        },
      },
    });

    expect(parseDirectorProject(structuredClone(project))).toEqual(project);

    project.assets[project.assets.length - 1]!.kind = "prop";
    expect(safeParseDirectorProject(project)).toMatchObject({
      success: false,
      error: expect.stringContaining("characterMetadata"),
    });
  });

  it("validates physical camera metadata and clipping-plane order", () => {
    const project = createDefaultDirectorProject();
    project.cameras[0]!.apertureFStop = 2;
    project.cameras[0]!.focusDistanceM = 3.5;
    project.cameras[0]!.shutterAngle = 172.8;
    project.cameras[0]!.iso = 1_250;
    project.cameras[0]!.nearClipM = 0.05;
    project.cameras[0]!.farClipM = 5_000;
    project.cameras[0]!.anamorphicSqueeze = 2;

    expect(directorProjectSchema.safeParse(project).success).toBe(true);

    project.cameras[0]!.farClipM = 0.01;
    expect(safeParseDirectorProject(project)).toMatchObject({
      success: false,
      error: expect.stringContaining("farClipM"),
    });
  });

  it("keeps legacy characters without IK valid and persists finite IK goals", () => {
    const legacyProject = createDefaultDirectorProject();
    const character = legacyProject.objects.find((object) => object.kind === "character")!;
    expect(character.characterRig?.ik).toBeUndefined();
    expect(parseDirectorProject(structuredClone(legacyProject))).toEqual(legacyProject);

    character.characterRig!.ik = {
      leftHand: {
        target: [-0.8, 1.3, 0.25],
        pole: [-0.6, 1.1, 0.9],
        weight: 0.75,
        reachClamp: 0.92,
      },
    };
    expect(parseDirectorProject(structuredClone(legacyProject))).toEqual(legacyProject);
  });

  it("rejects invalid IK weights, reach limits, and unknown effectors", () => {
    const project = createDefaultDirectorProject();
    const character = project.objects.find((object) => object.kind === "character")!;
    character.characterRig!.ik = {
      leftHand: { target: [0, 1, 0], pole: [0, 0, 1], weight: 1.2, reachClamp: 1 },
    };
    expect(safeParseDirectorProject(project)).toMatchObject({
      success: false,
      error: expect.stringContaining("characterRig.ik.leftHand.weight"),
    });

    const unknownEffector = structuredClone(createDefaultDirectorProject()) as unknown as {
      objects: Array<{ characterRig?: { ik?: Record<string, unknown> } }>;
    };
    unknownEffector.objects[0]!.characterRig!.ik = {
      tail: { target: [0, 1, 0], pole: [0, 0, 1], weight: 1, reachClamp: 1 },
    };
    expect(safeParseDirectorProject(unknownEffector).success).toBe(false);
  });

  it("persists bounded frame-native character motion while keeping legacy rigs valid", () => {
    const project = createDefaultDirectorProject();
    const character = project.objects.find((object) => object.kind === "character")!;
    character.characterRig!.motion = {
      clipId: "walk",
      enabled: true,
      loop: "repeat",
      speed: 1.25,
      weight: 0.8,
      startFrame: 12,
      blendInS: 0.2,
      blendOutS: 0,
      rootMotion: "in-place",
    };
    expect(parseDirectorProject(structuredClone(project))).toEqual(project);

    character.characterRig!.motion!.speed = 10;
    expect(safeParseDirectorProject(project)).toMatchObject({
      success: false,
      error: expect.stringContaining("characterRig.motion.speed"),
    });
  });

  it("persists non-overlapping character motion blocks and rejects ambiguous ranges", () => {
    const project = createDefaultDirectorProject();
    const character = project.objects.find((object) => object.kind === "character")!;
    character.animation = {
      version: 1,
      keyframes: [],
      motionBlocks: [
        {
          id: "motion-walk",
          clipId: "walk",
          enabled: true,
          frameStart: 0,
          frameEnd: 23,
          loop: "repeat",
          speed: 1,
          weight: 1,
          blendInS: 0.12,
          blendOutS: 0.12,
          rootMotion: "in-place",
        },
        {
          id: "motion-wave",
          clipId: "wave",
          enabled: true,
          frameStart: 24,
          frameEnd: 47,
          loop: "once",
          speed: 1,
          weight: 1,
          blendInS: 0.12,
          blendOutS: 0.12,
          rootMotion: "in-place",
        },
      ],
    };

    expect(parseDirectorProject(structuredClone(project))).toEqual(project);

    character.animation.motionBlocks![1]!.frameStart = 23;
    expect(safeParseDirectorProject(project)).toMatchObject({
      success: false,
      error: expect.stringContaining("motionBlocks"),
    });
  });

  it("rejects structurally valid production data with dangling semantic references", () => {
    const project = createDefaultDirectorProject();
    project.production!.sequences[0]!.shots[0]!.takeId = "missing-take";

    expect(safeParseDirectorProject(project)).toMatchObject({
      success: false,
      error: expect.stringMatching(/production\.sequences\.0\.shots\.0\.takeId.*missing-take.*不存在/),
    });
  });

  it("persists editable lights, fog, environment lighting, and PBR texture bindings", () => {
    const project = createDefaultDirectorProject();
    project.assets.push({
      id: "texture_base",
      kind: "prop",
      sourceType: "image",
      assetSource: "local",
      fileName: "paint.png",
      url: "data:image/png;base64,paint",
    });
    const object = project.objects.find((item) => item.kind === "character")!;
    object.material = {
      baseColor: "#778899",
      metalness: 0.8,
      roughness: 0.25,
      transmission: 0.1,
      textures: { baseColorMapAssetId: "texture_base" },
    };
    project.scene.fog = {
      enabled: true,
      mode: "exponential",
      color: "#223344",
      near: 5,
      far: 120,
      density: 0.015,
    };
    project.scene.environment = { enabled: true, usePanorama: true, intensity: 0.7, rotation: [0, 0.5, 0] };

    expect(parseDirectorProject(structuredClone(project))).toEqual(project);
    expect(project.lights).toHaveLength(2);
  });

  it("rejects duplicate lights and dangling or non-image material texture assets", () => {
    const duplicateLights = createDefaultDirectorProject();
    duplicateLights.lights!.push(structuredClone(duplicateLights.lights![0]!));
    expect(safeParseDirectorProject(duplicateLights)).toMatchObject({
      success: false,
      error: expect.stringContaining("lights.2.id"),
    });

    const danglingTexture = createDefaultDirectorProject();
    danglingTexture.objects[0]!.material = { textures: { normalMapAssetId: "missing_texture" } };
    expect(safeParseDirectorProject(danglingTexture)).toMatchObject({
      success: false,
      error: expect.stringContaining("missing_texture"),
    });

    const modelAsTexture = createDefaultDirectorProject();
    modelAsTexture.objects[0]!.material = {
      textures: { baseColorMapAssetId: modelAsTexture.assets[0]!.id },
    };
    expect(safeParseDirectorProject(modelAsTexture)).toMatchObject({
      success: false,
      error: expect.stringContaining("must be an image"),
    });
  });

  it("parses dangling references structurally and repairs them back to the strict schema", () => {
    const project = createDefaultDirectorProject();
    project.production!.takes[0]!.objectIds.push("ghost_object");
    project.scene.annotations = [
      {
        id: "note_1",
        text: "跟拍提示",
        anchor: { objectId: "ghost_object", position: [0, 1, 0] },
        color: "#ffcc00",
        visible: true,
        createdAt: "2026-08-01T00:00:00.000Z",
      },
    ];
    project.scene.measurements = [
      {
        id: "measure_1",
        start: { objectId: "ghost_object", position: [0, 0, 0] },
        end: { objectId: null, position: [1, 0, 0] },
        color: "#00ccff",
        visible: true,
        createdAt: "2026-08-01T00:00:00.000Z",
      },
    ];
    project.objects[0]!.material = { textures: { baseColorMapAssetId: "missing_texture" } };

    expect(safeParseDirectorProject(structuredClone(project)).success).toBe(false);

    const structural = safeParseDirectorProjectStructural(structuredClone(project));
    if (!structural.success) throw new Error(structural.error);

    const repaired = repairDirectorProjectReferences(structural.project);
    expect(repaired.repairs.length).toBeGreaterThan(0);
    expect(safeParseDirectorProject(repaired.project).success).toBe(true);
    expect(repaired.project.production!.takes[0]!.objectIds).not.toContain("ghost_object");
    expect(repaired.project.scene.annotations![0]!.anchor.objectId).toBeNull();
    expect(repaired.project.scene.measurements![0]!.start.objectId).toBeNull();
    expect(repaired.project.objects[0]!.material?.textures?.baseColorMapAssetId).toBeUndefined();
  });

  it("still rejects structural corruption in the structural parse", () => {
    const duplicateLights = createDefaultDirectorProject();
    duplicateLights.lights!.push(structuredClone(duplicateLights.lights![0]!));
    expect(safeParseDirectorProjectStructural(duplicateLights)).toMatchObject({
      success: false,
      error: expect.stringContaining("lights.2.id"),
    });

    const brokenTuple = createDefaultDirectorProject();
    brokenTuple.cameras[0]!.target = [0, 1] as unknown as [number, number, number];
    expect(safeParseDirectorProjectStructural(brokenTuple).success).toBe(false);
  });
});
