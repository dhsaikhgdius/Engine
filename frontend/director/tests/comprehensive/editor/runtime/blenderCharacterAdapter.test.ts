import { describe, expect, it } from "vitest";
import type { BlenderObjectInspection } from "../../../../../../packages/protocol/src/blenderLiveProtocol";
import type { DirectorObject } from "../../../../src/comprehensive/editor/schema/directorProject";
import { buildBlenderCharacterOperations } from "../../../../src/comprehensive/editor/runtime/blenderCharacterAdapter";

const BONE_NAMES = [
  "Hips",
  "Spine2",
  "Head",
  "LeftArm",
  "RightArm",
  "LeftForeArm",
  "RightForeArm",
  "LeftHand",
  "RightHand",
  "LeftUpLeg",
  "RightUpLeg",
  "LeftLeg",
  "RightLeg",
  "LeftFoot",
  "RightFoot",
];

function inspection(
  directorStateToken = "",
  motionReady = false,
): BlenderObjectInspection & {
  rig: NonNullable<BlenderObjectInspection["rig"]>;
} {
  const result: BlenderObjectInspection & {
    rig: NonNullable<BlenderObjectInspection["rig"]>;
  } = {
    id: "rig-a",
    name: "Rig",
    type: "ARMATURE",
    mode: "OBJECT",
    dimensions: [1, 1, 1],
    evaluatedBounds: {
      min: [-0.5, -0.5, -0.5],
      max: [0.5, 0.5, 0.5],
      center: [0, 0, 0],
      size: [1, 1, 1],
    },
    selection: { selected: true, active: true },
    materialNodes: [],
    materialSlots: [],
    materialGraphs: [],
    geometryGraphs: [],
    rig: {
      boneCount: BONE_NAMES.length,
      poseBoneCount: BONE_NAMES.length,
      deformBoneCount: BONE_NAMES.length,
      constraintCount: 0,
      activeBoneRef: null,
      selectedBoneRefs: [],
      directorStateToken,
      bones: BONE_NAMES.map((boneRef) => ({
        boneRef,
        parentRef: null,
        deform: true,
        selected: false,
        local: { location: [0, 0, 0], rotationQuaternion: [1, 0, 0, 0], scale: [1, 1, 1] },
        restLocal: { location: [0, 0, 0], rotationQuaternion: [1, 0, 0, 0], scale: [1, 1, 1] },
      })),
      mixamoCompatibility: { compatible: true, missingBoneRoles: [], mappedBoneCount: BONE_NAMES.length },
    },
    animation: {
      action: null,
      activeAction: null,
      actions: motionReady
        ? [
            {
              actionName: "Director character-a walk IN_PLACE",
              active: false,
              frameRange: [1, 31],
              fCurveCount: 1,
              keyframeCount: 2,
              keyedFrames: [1, 31],
            },
          ]
        : [],
      fCurveCount: 0,
      keyframeCount: 0,
      driverCount: 0,
      nlaTrackCount: motionReady ? 1 : 0,
      nlaStripCount: motionReady ? 1 : 0,
      nlaTracks: motionReady
        ? [
            {
              name: "Director Motion",
              mute: false,
              solo: false,
              strips: [
                {
                  name: "Director character-a walk IN_PLACE",
                  actionName: "Director character-a walk IN_PLACE",
                  frameStart: 0,
                  frameEnd: 30_000,
                  actionFrameStart: 1,
                  actionFrameEnd: 31,
                  blendMode: "REPLACE",
                  influence: 1,
                  repeat: 1_000,
                  scale: 1,
                },
              ],
            },
          ]
        : [],
    },
    warnings: [],
  };
  return result;
}

function character(): DirectorObject {
  return {
    id: "character-a",
    name: "Character A",
    kind: "character",
    visible: true,
    locked: false,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    characterRig: {
      rigType: "mixamo",
      posePresetId: null,
      controls: { "head.yaw": 30, "body.offsetY": 0.2 },
      motion: {
        clipId: "walk",
        enabled: true,
        loop: "repeat",
        speed: 1,
        weight: 1,
        startFrame: 0,
        blendInS: 0.12,
        blendOutS: 0,
        rootMotion: "in-place",
      },
    },
  };
}

describe("Blender character adapter", () => {
  it("maps one Director character state into typed native Action, NLA and pose operations", () => {
    const operations = buildBlenderCharacterOperations({
      object: character(),
      inspection: inspection(),
      currentFrame: 24,
    });

    expect(operations.map((operation) => operation.op)).toEqual([
      "import_mixamo_action",
      "create_nla_track",
      "add_nla_strip",
      "apply_pose_offsets",
    ]);
    expect(operations[0]).toMatchObject({
      motionId: "walk",
      actionName: "Director character-a walk IN_PLACE",
      replaceExisting: false,
    });
    expect(operations[2]).toMatchObject({
      trackName: "Director Motion",
      startFrame: 0,
      influence: 1,
      repeat: 1_000,
      scale: 1,
    });
    expect(operations[3]).toMatchObject({
      id: "rig-a",
      resetPose: false,
      bones: expect.arrayContaining([
        expect.objectContaining({ boneRef: "Head" }),
        expect.objectContaining({ boneRef: "Hips", locationOffset: [0, 0, 0.2] }),
      ]),
    });
  });

  it("is idempotent once Blender reports the same Director state token", () => {
    const first = buildBlenderCharacterOperations({
      object: character(),
      inspection: inspection(),
      currentFrame: 24,
    });
    const stateToken = first.find((operation) => operation.op === "apply_pose_offsets")?.stateToken;
    expect(stateToken).toBeTypeOf("string");

    expect(
      buildBlenderCharacterOperations({
        object: character(),
        inspection: inspection(stateToken, true),
        currentFrame: 24,
      }),
    ).toEqual([]);
  });

  it("does not resubmit native motion for browser-only blend controls", () => {
    const source = character();
    const first = buildBlenderCharacterOperations({
      object: source,
      inspection: inspection(),
      currentFrame: 24,
    });
    const stateToken = first.find((operation) => operation.op === "apply_pose_offsets")?.stateToken;
    expect(stateToken).toBeTypeOf("string");

    const adjusted = structuredClone(source);
    adjusted.characterRig!.motion!.weight = 0.2;
    adjusted.characterRig!.motion!.blendInS = 2;
    adjusted.characterRig!.motion!.blendOutS = 3;
    expect(
      buildBlenderCharacterOperations({
        object: adjusted,
        inspection: inspection(stateToken, true),
        currentFrame: 24,
      }),
    ).toEqual([]);
  });

  it("replaces a stale active Action before restoring the Director NLA strip", () => {
    const stale = inspection("", true);
    stale.animation.activeAction = {
      actionName: "Legacy Action",
      active: true,
      frameRange: [1, 12],
      fCurveCount: 1,
      keyframeCount: 2,
      keyedFrames: [1, 12],
    };
    stale.animation.actions.push(stale.animation.activeAction);

    expect(
      buildBlenderCharacterOperations({
        object: character(),
        inspection: stale,
        currentFrame: 24,
      }).map((operation) => operation.op),
    ).toEqual(["set_active_action", "remove_nla_strip", "add_nla_strip", "apply_pose_offsets"]);
  });

  it("does not claim support for an incompatible native rig", () => {
    const incompatible = inspection();
    incompatible.rig.mixamoCompatibility = {
      compatible: false,
      missingBoneRoles: ["lefthand"],
      mappedBoneCount: 14,
    };

    expect(
      buildBlenderCharacterOperations({
        object: character(),
        inspection: incompatible,
        currentFrame: 0,
      }),
    ).toEqual([]);
  });
});
