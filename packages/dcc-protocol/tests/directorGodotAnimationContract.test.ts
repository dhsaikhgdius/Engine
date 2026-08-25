import { describe, expect, it } from "vitest";
import {
  DIRECTOR_GODOT_ANIMATION_BAKE_CONTRACT,
  directorGodotAnimationBakeSchema,
  directorGodotBakedEntitySchema,
  directorGodotConnectorHealthSchema,
  directorGodotImportReceiptSchema,
  directorGodotTimecodeSchema,
} from "../src/directorGodotAnimationContract";

const REVISION = `director-project-revision:v1:sha256:${"a".repeat(64)}`;
const PACKAGE_ID = "0f9f1c8e-8f4c-4c1e-b2ff-95a5f34f9e51";

const CANONICAL_COORDINATES = {
  source: "right-handed-y-up-negative-z-forward",
  destination: "right-handed-y-up-negative-z-forward",
  unit: "meter",
  linearMap: "identity",
} as const;

function transformSample(frame: number) {
  return {
    frame,
    transform: {
      location: [frame, 0, 0] as [number, number, number],
      rotationQuaternion: [0, 0, 0, 1] as [number, number, number, number],
      scale: [1, 1, 1] as [number, number, number],
    },
  };
}

function validBake() {
  return {
    contract: DIRECTOR_GODOT_ANIMATION_BAKE_CONTRACT,
    schemaVersion: 1,
    packageId: PACKAGE_ID,
    provider: "godot",
    sourceRevision: REVISION,
    coordinateSystem: CANONICAL_COORDINATES,
    timebase: {
      rate: { numerator: 24000, denominator: 1001 },
      dropFrame: false,
      startTimecode: "00:00:00:00",
    },
    playback: { frameStart: 0, frameEnd: 24 },
    frameStride: 1,
    entities: [
      {
        directorId: "obj-1",
        entityType: "object",
        name: "Prop",
        transformSamples: [transformSample(0), transformSample(12), transformSample(24)],
        warnings: [],
      },
      {
        directorId: "cam-1",
        entityType: "camera",
        name: "Main",
        transformSamples: [transformSample(0), transformSample(24)],
        fovSamples: [
          { frame: 0, fovDeg: 40 },
          { frame: 24, fovDeg: 60 },
        ],
        warnings: [],
      },
    ],
    warnings: [],
  };
}

describe("director-godot-animation-bake-v1", () => {
  it("accepts a canonical-space bake with a rational timebase", () => {
    const bake = directorGodotAnimationBakeSchema.parse(validBake());
    expect(bake.timebase.rate).toEqual({ numerator: 24000, denominator: 1001 });
    expect(bake.entities).toHaveLength(2);
  });

  it("rejects non-increasing sample frames on both transform and fov tracks", () => {
    const badTransforms = validBake();
    badTransforms.entities[0]!.transformSamples = [transformSample(10), transformSample(10)];
    expect(directorGodotAnimationBakeSchema.safeParse(badTransforms).success).toBe(false);

    const badFov = validBake();
    badFov.entities[1]!.fovSamples = [
      { frame: 24, fovDeg: 40 },
      { frame: 0, fovDeg: 60 },
    ];
    expect(directorGodotAnimationBakeSchema.safeParse(badFov).success).toBe(false);
  });

  it("keeps fov samples a camera-only channel", () => {
    expect(
      directorGodotBakedEntitySchema.safeParse({
        directorId: "obj-1",
        entityType: "object",
        name: "Prop",
        transformSamples: [transformSample(0)],
        fovSamples: [{ frame: 0, fovDeg: 50 }],
        warnings: [],
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate baked entities and inverted playback ranges", () => {
    const duplicated = validBake();
    duplicated.entities[1] = { ...duplicated.entities[0]! };
    expect(directorGodotAnimationBakeSchema.safeParse(duplicated).success).toBe(false);

    const inverted = validBake();
    inverted.playback = { frameStart: 24, frameEnd: 0 };
    expect(directorGodotAnimationBakeSchema.safeParse(inverted).success).toBe(false);
  });

  it("constrains omitted channels to the known warn-and-omit vocabulary", () => {
    const entity = {
      directorId: "obj-1",
      entityType: "object",
      name: "Prop",
      transformSamples: [transformSample(0)],
      omittedChannels: ["pose_values", "motion_blocks", "character_rig"],
      warnings: ["fixture"],
    };
    expect(directorGodotBakedEntitySchema.parse(entity).omittedChannels).toEqual([
      "pose_values",
      "motion_blocks",
      "character_rig",
    ]);
    expect(directorGodotBakedEntitySchema.safeParse({ ...entity, omittedChannels: ["shader_graph"] }).success).toBe(
      false,
    );
  });

  it("validates SMPTE timecodes in drop and non-drop form", () => {
    expect(directorGodotTimecodeSchema.parse("00:00:00:00")).toBe("00:00:00:00");
    expect(directorGodotTimecodeSchema.parse("01:02:03;04")).toBe("01:02:03;04");
    expect(directorGodotTimecodeSchema.safeParse("1:2:3:4").success).toBe(false);
  });
});

describe("Godot import receipt and connector health", () => {
  it("accepts a read-back import receipt with a rational display rate", () => {
    const receipt = directorGodotImportReceiptSchema.parse({
      animationPlayerPath: "res://director/scenes/director_0f9f1c8e.tscn",
      animationLibrary: "director",
      displayRate: "24000/1001",
      bakedKeyCount: 175,
      transformTrackCount: 2,
      fovTrackCount: 1,
      shotCutTrackCount: 1,
      mappedShotCount: 2,
      payloadAnimationPlayerCount: 1,
      importedSkeletonCount: 1,
      importedLightCount: 3,
      worldEnvironmentAmbient: true,
      omittedLightCount: 1,
      appliedMaterialCount: 1,
      externalizedTextureCount: 2,
    });
    expect(receipt.displayRate).toBe("24000/1001");
    expect(receipt.mappedShotCount).toBe(2);
    expect(receipt.worldEnvironmentAmbient).toBe(true);
  });

  it("accepts a static import (no animation keyed) and rejects malformed rates", () => {
    const staticReceipt = {
      animationPlayerPath: null,
      animationLibrary: null,
      displayRate: null,
      bakedKeyCount: 0,
      transformTrackCount: 0,
      fovTrackCount: 0,
      shotCutTrackCount: 0,
      mappedShotCount: 0,
      payloadAnimationPlayerCount: 0,
      importedSkeletonCount: 0,
      importedLightCount: 0,
      worldEnvironmentAmbient: false,
      omittedLightCount: 0,
      appliedMaterialCount: 0,
      externalizedTextureCount: 0,
    };
    expect(directorGodotImportReceiptSchema.parse(staticReceipt).bakedKeyCount).toBe(0);
    expect(directorGodotImportReceiptSchema.safeParse({ ...staticReceipt, displayRate: "23.976" }).success).toBe(false);
    expect(directorGodotImportReceiptSchema.safeParse({ ...staticReceipt, bakedKeyCount: -1 }).success).toBe(false);
  });

  it("only accepts an ok Godot health line for provider godot", () => {
    expect(
      directorGodotConnectorHealthSchema.parse({
        ok: true,
        provider: "godot",
        hostVersion: "4.3.stable.official.77dcf97d8",
        connectorVersion: "0.2.0",
      }).hostVersion,
    ).toContain("4.3");
    expect(
      directorGodotConnectorHealthSchema.safeParse({
        ok: false,
        provider: "godot",
        hostVersion: "4.3",
        connectorVersion: "0.2.0",
      }).success,
    ).toBe(false);
    expect(
      directorGodotConnectorHealthSchema.safeParse({
        ok: true,
        provider: "unity",
        hostVersion: "4.3",
        connectorVersion: "0.2.0",
      }).success,
    ).toBe(false);
  });
});
