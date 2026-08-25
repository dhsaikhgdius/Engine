import { Euler, Quaternion } from "three";
import type {
  BlenderAgentOperation,
  BlenderObjectInspection,
} from "../../../../../../packages/protocol/src/blenderLiveProtocol";
import {
  blenderApplyPoseOffsetsOperation,
  blenderAddNlaStripOperation,
  blenderCreateActionOperation,
  blenderCreateNlaTrackOperation,
  blenderImportMixamoActionOperation,
  blenderRemoveNlaStripOperation,
  blenderSetActiveActionOperation,
} from "../api/blenderLiveClient";
import { resolveCharacterPoseControls } from "../presets/mannequinPosePresets";
import { getDirectorCharacterMotion } from "@director/agent-engine/character-motions";
import type { DirectorObject } from "../schema/directorProject";
import {
  canonicalizeMixamoBoneName,
  getMixamoPoseBoneRotations,
  MIXAMO_BONE_ROLE_ALIASES,
  type MixamoBoneRole,
} from "./mixamo/mixamoCharacterRig";

type RigInspection = BlenderObjectInspection & {
  rig: NonNullable<BlenderObjectInspection["rig"]>;
};

/** Resolves canonical Mixamo bone roles to their actual Blender bone references from the inspection data. */
function resolveBoneRefs(inspection: RigInspection) {
  const byCanonicalName = new Map(
    inspection.rig.bones.map((bone) => [canonicalizeMixamoBoneName(bone.boneRef), bone.boneRef]),
  );
  const resolved: Partial<Record<MixamoBoneRole, string>> = {};
  for (const [role, aliases] of Object.entries(MIXAMO_BONE_ROLE_ALIASES) as Array<
    [MixamoBoneRole, readonly string[]]
  >) {
    const boneRef = aliases
      .map((alias) => byCanonicalName.get(canonicalizeMixamoBoneName(alias)))
      .find((candidate): candidate is string => Boolean(candidate));
    if (boneRef) resolved[role] = boneRef;
  }
  return resolved;
}

/** Produces the Blender action name that identifies a Director-authored motion or rest pose in the NLA. */
function getDirectorActionName(object: DirectorObject, motionId?: string, rootMotion?: string) {
  return motionId ? `Director ${object.id} ${motionId} ${rootMotion ?? "IN_PLACE"}` : `Director ${object.id} Rest`;
}

const DIRECTOR_MOTION_TRACK_NAME = "Director Motion";

/** Float equality within a tolerance that accounts for Blender ↔ Director round-trip noise. */
function sameNumber(left: number, right: number) {
  return Math.abs(left - right) < 1e-6;
}

/**
 * Produces the minimal set of Blender operations needed to bring a character's
 * live rig into sync with the current Director pose and motion configuration.
 *
 * Operations are designed to be idempotent: when the rig's directorStateToken
 * matches the computed token and the NLA/action layout is already correct, the
 * returned array is empty. The caller compares the token before mutating the
 * live session so we never send redundant operations.
 *
 * @param options.object - The Director character object to sync.
 * @param options.inspection - The current live Blender rig inspection.
 * @param options.currentFrame - The current timeline frame for motion evaluation.
 * @returns An ordered list of Blender operations to apply, or an empty array when already in sync.
 */
export function buildBlenderCharacterOperations(options: {
  object: DirectorObject;
  inspection: RigInspection;
  currentFrame: number;
}): BlenderAgentOperation[] {
  const { object, inspection, currentFrame } = options;
  const rig = object.characterRig;
  if (object.kind !== "character" || !rig || inspection.rig.mixamoCompatibility?.compatible !== true) return [];

  const motion = rig.motion?.enabled ? rig.motion : undefined;
  const clip = motion ? getDirectorCharacterMotion(motion.clipId) : null;
  const rootMotion = motion?.rootMotion === "authored" ? "AUTHORED" : "IN_PLACE";
  const actionName = getDirectorActionName(object, clip?.id, rootMotion);
  const stateToken = JSON.stringify({
    controls: resolveCharacterPoseControls(rig),
    frame: motion ? currentFrame : null,
    motion: motion
      ? {
          clipId: motion.clipId,
          loop: motion.loop,
          speed: motion.speed,
          startFrame: motion.startFrame,
          rootMotion: motion.rootMotion,
        }
      : null,
  });
  const actions = inspection.animation.actions;
  const operations: BlenderAgentOperation[] = [];

  const motionTrack = inspection.animation.nlaTracks.find((track) => track.name === DIRECTOR_MOTION_TRACK_NAME);
  if (motion && clip) {
    const repeat = motion.loop === "once" ? 1 : 1_000;
    const scale = 1 / motion.speed;
    const desiredStrip = motionTrack?.strips.find((strip) => strip.name === actionName);
    const desiredStripReady = Boolean(
      desiredStrip &&
      desiredStrip.actionName === actionName &&
      sameNumber(desiredStrip.frameStart, motion.startFrame) &&
      sameNumber(desiredStrip.repeat, repeat) &&
      sameNumber(desiredStrip.scale, scale) &&
      inspection.animation.activeAction === null,
    );
    const motionReady = desiredStripReady && motionTrack?.strips.length === 1;
    if (inspection.rig.directorStateToken === stateToken && motionReady) return [];

    if (!actions.some((action) => action.actionName === actionName)) {
      operations.push(
        blenderImportMixamoActionOperation({
          objectId: inspection.id,
          motionId: clip.id,
          actionName,
          rootMotion,
          replaceExisting: false,
        }),
      );
    } else if (inspection.animation.activeAction && inspection.animation.activeAction.actionName !== actionName) {
      operations.push(blenderSetActiveActionOperation(inspection.id, actionName));
    }
    if (!motionTrack) {
      operations.push(blenderCreateNlaTrackOperation(inspection.id, DIRECTOR_MOTION_TRACK_NAME));
    }
    for (const strip of motionTrack?.strips ?? []) {
      if (strip.name !== actionName || !desiredStripReady) {
        operations.push(blenderRemoveNlaStripOperation(inspection.id, DIRECTOR_MOTION_TRACK_NAME, strip.name));
      }
    }
    if (!desiredStripReady) {
      operations.push(
        blenderAddNlaStripOperation({
          objectId: inspection.id,
          trackName: DIRECTOR_MOTION_TRACK_NAME,
          stripName: actionName,
          actionName,
          startFrame: motion.startFrame,
          blendMode: "REPLACE",
          influence: 1,
          repeat,
          scale,
        }),
      );
    }
  } else {
    const restReady =
      (motionTrack?.strips.length ?? 0) === 0 && inspection.animation.activeAction?.actionName === actionName;
    if (inspection.rig.directorStateToken === stateToken && restReady) return [];
    for (const strip of motionTrack?.strips ?? []) {
      operations.push(blenderRemoveNlaStripOperation(inspection.id, DIRECTOR_MOTION_TRACK_NAME, strip.name));
    }
    if (!actions.some((action) => action.actionName === actionName)) {
      operations.push(blenderCreateActionOperation(inspection.id, actionName));
    } else if (inspection.animation.activeAction?.actionName !== actionName) {
      operations.push(blenderSetActiveActionOperation(inspection.id, actionName));
    }
  }

  const controls = resolveCharacterPoseControls(rig);
  const rotations = getMixamoPoseBoneRotations(controls, object.bodyType, Boolean(motion && clip));
  const boneRefs = resolveBoneRefs(inspection);
  const euler = new Euler();
  const quaternion = new Quaternion();
  const bones = (Object.entries(rotations) as Array<[MixamoBoneRole, [number, number, number]]>)
    .map(([role, rotation]) => {
      const boneRef = boneRefs[role];
      if (!boneRef) return null;
      quaternion.setFromEuler(euler.set(rotation[0], rotation[1], rotation[2], "XYZ")).normalize();
      return {
        boneRef,
        rotationOffsetQuaternion: [quaternion.w, quaternion.x, quaternion.y, quaternion.z] as [
          number,
          number,
          number,
          number,
        ],
        ...(role === "body"
          ? { locationOffset: [0, 0, controls["body.offsetY"] ?? 0] as [number, number, number] }
          : {}),
      };
    })
    .filter((bone): bone is NonNullable<typeof bone> => bone !== null);

  if (bones.length) {
    operations.push(
      blenderApplyPoseOffsetsOperation({
        objectId: inspection.id,
        stateToken,
        resetPose: !motion,
        bones,
      }),
    );
  }
  return operations;
}
