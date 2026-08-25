import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AnimationMixer, Box3, Quaternion, Vector3, type Bone, type Object3D } from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { expect, vi } from "vitest";
import { localAssetIt } from "../../../../../../../packages/protocol/tests/localAssetTest";
import type { DirectorCharacterMotionState } from "../../../../../src/comprehensive/editor/schema/directorProject";
import {
  DIRECTOR_CHARACTER_MOTION_CATALOG,
  isDirectorLocomotionMotion,
  type DirectorCharacterMotionCatalogItem,
} from "@director/agent-engine/character-motions";
import { configureDirectorGLTFLoader } from "../../../../../src/comprehensive/editor/runtime/gltfLoader";
import {
  applyMixamoRestPoseAndRig,
  captureMixamoRestPoseAndBones,
  cloneMixamoCharacterScene,
  resolveMixamoBones,
} from "../../../../../src/comprehensive/editor/runtime/mixamo/mixamoCharacterRig";
import {
  applyDirectorCharacterMotionFrame,
  applyDirectorCharacterWeightedMotionFrame,
  configureDirectorCharacterMotionAction,
  retargetMixamoAnimationClip,
} from "../../../../../src/comprehensive/editor/runtime/mixamo/mixamoMotion";
import {
  applyMixamoFootGrounding,
  createMixamoFootGroundingState,
} from "../../../../../src/comprehensive/editor/runtime/mixamo/mixamoFootGrounding";

/**
 * Numeric quality gates for the packaged Mixamo motion pipeline on X Bot.
 *
 * The invariants below were the symptoms of three regressions that all passed
 * the unit suite: constant PropertyMixer channels snapping to the T-pose
 * between deterministic samples, right-hand IK goals mirrored onto the wrong
 * body side, and timeline foot grounding covering only `walk`/`run` instead of
 * the whole locomotion family. Every threshold documents the healthy value
 * measured after those fixes and keeps 1.5-2x headroom so asset noise cannot
 * flake the suite while a real regression (usually an order of magnitude
 * larger) still fails loudly.
 */

const SAMPLING_FPS = 60;

/**
 * Healthy worst adjacent-frame bone rotation at 60 fps is run-right at ~26.1
 * deg (run-left ~17.0, walk ~14.7, run ~14.6, idle ~0.2). The rest-pose
 * snapping bug produced 79-83 deg steps on walk-left/run.
 */
const MAX_ADJACENT_FRAME_ROTATION_DEG = 40;

/** The packaged repeat clips loop seamlessly; measured seams are 0.04-0.14 deg. */
const MAX_LOOP_SEAM_ROTATION_DEG = 5;

/**
 * Grounded locomotion bounds stay near the stage floor: measured min -0.0077
 * and max 0.0437 (both run-left) across all eight gait clips.
 */
const GROUNDED_BOUNDS_MIN_Y_M = -0.02;
const GROUNDED_BOUNDS_MAX_Y_M = 0.08;

/** Without grounding, the walk/run pelvis bob pushes feet through the floor. */
const UNGROUNDED_PENETRATION_Y_M = -0.02;

/**
 * All four chains converge to sub-millimetre residuals on these reachable
 * goals; the hand budget keeps headroom because aim-based arm solving can
 * leave a few centimetres on harder targets. The broken mirror pulled only
 * the right-hand goal across the body (0.324 m error against a converged
 * 0.039 m left hand), so the left/right gap is the decisive symmetry signal.
 */
const MAX_FOOT_IK_ERROR_M = 0.01;
const MAX_HAND_IK_ERROR_M = 0.06;
const MAX_IK_SYMMETRY_GAP_M = 0.01;

/** Healthy idle-to-walk smoothstep crossfade peaks at ~7.2 deg per 60 fps step. */
const MAX_CROSSFADE_STEP_ROTATION_DEG = 20;

const REPEAT_MOTIONS = DIRECTOR_CHARACTER_MOTION_CATALOG.filter((item) => item.defaultLoop === "repeat");
const LOCOMOTION_MOTIONS = DIRECTOR_CHARACTER_MOTION_CATALOG.filter((item) => item.category === "locomotion");

async function loadPackagedMixamoCharacter(fileName: string) {
  const binary = readFileSync(resolve(process.cwd(), "assets/library/mixamo-characters/models", fileName));
  const data = new ArrayBuffer(binary.byteLength);
  new Uint8Array(data).set(binary);
  const loader = configureDirectorGLTFLoader(new GLTFLoader());

  vi.stubGlobal("createImageBitmap", async () => ({ close: vi.fn() }));
  return loader.parseAsync(data, "");
}

async function loadPackagedMixamoMotion(fileName: string) {
  const binary = readFileSync(resolve(process.cwd(), "assets/library/mixamo-animations/clips", fileName));
  const data = new ArrayBuffer(binary.byteLength);
  new Uint8Array(data).set(binary);
  return configureDirectorGLTFLoader(new GLTFLoader()).parseAsync(data, "");
}

function createCharacterFrameRig(characterScene: Object3D) {
  const scene = cloneMixamoCharacterScene(characterScene);
  const { restPose, bones: deformBones } = captureMixamoRestPoseAndBones(scene);
  return {
    scene,
    restPose,
    deformBones,
    resolvedBones: resolveMixamoBones(scene, deformBones),
    controls: {},
  };
}

function bindRetargetedCatalogClip(
  rig: ReturnType<typeof createCharacterFrameRig>,
  motionGltf: GLTF,
  item: DirectorCharacterMotionCatalogItem,
  mixer = new AnimationMixer(rig.scene),
) {
  const clip = retargetMixamoAnimationClip({
    clip: motionGltf.animations[0]!,
    sourceRoot: motionGltf.scene,
    targetRoot: rig.scene,
    targetRestPose: rig.restPose,
    rootMotion: "in-place",
    name: item.id,
  });
  return { action: configureDirectorCharacterMotionAction(mixer.clipAction(clip)), clip, mixer };
}

function createTimelineMotion(
  clipId: string,
  loop: DirectorCharacterMotionState["loop"],
): DirectorCharacterMotionState {
  return {
    clipId,
    enabled: true,
    loop,
    speed: 1,
    weight: 1,
    startFrame: 0,
    blendInS: 0,
    blendOutS: 0,
    rootMotion: "in-place",
  };
}

const poseCompareFirst = new Quaternion();
const poseCompareSecond = new Quaternion();

function writeBoneQuaternions(bones: readonly Bone[], target: Float64Array) {
  bones.forEach((bone, index) => bone.quaternion.toArray(target, index * 4));
}

function maxBoneRotationDeltaDeg(first: Float64Array, second: Float64Array, boneCount: number) {
  let widestRad = 0;
  for (let index = 0; index < boneCount; index += 1) {
    poseCompareFirst.fromArray(first, index * 4);
    poseCompareSecond.fromArray(second, index * 4);
    widestRad = Math.max(widestRad, poseCompareFirst.angleTo(poseCompareSecond));
  }
  return (widestRad * 180) / Math.PI;
}

localAssetIt(
  "keeps every repeating catalog clip frame-to-frame continuous on X Bot at 60 fps",
  async () => {
    const [characterGltf, ...motionGltfs] = await Promise.all([
      loadPackagedMixamoCharacter("x-bot.glb"),
      ...REPEAT_MOTIONS.map((item) => loadPackagedMixamoMotion(item.fileName)),
    ]);

    for (const [index, item] of REPEAT_MOTIONS.entries()) {
      const rig = createCharacterFrameRig(characterGltf.scene);
      const { action, clip, mixer } = bindRetargetedCatalogClip(rig, motionGltfs[index]!, item);
      const motion = createTimelineMotion(item.id, "repeat");
      const previousPose = new Float64Array(rig.deformBones.length * 4);
      const currentPose = new Float64Array(rig.deformBones.length * 4);
      // One full loop plus the repeat wrap, so the seam crossing is sampled too.
      const lastFrame = Math.ceil(clip.duration * SAMPLING_FPS) + 1;
      let widestStepDeg = 0;

      for (let frame = 0; frame <= lastFrame; frame += 1) {
        applyDirectorCharacterMotionFrame({
          ...rig,
          action,
          currentFrame: frame,
          durationS: clip.duration,
          fps: SAMPLING_FPS,
          mixer,
          motion,
        });
        writeBoneQuaternions(rig.deformBones, currentPose);
        if (frame > 0) {
          widestStepDeg = Math.max(
            widestStepDeg,
            maxBoneRotationDeltaDeg(previousPose, currentPose, rig.deformBones.length),
          );
        }
        previousPose.set(currentPose);
      }

      // A silent no-op sampler would trivially "pass"; require real animation.
      expect(widestStepDeg, item.id).toBeGreaterThan(0.01);
      expect(widestStepDeg, item.id).toBeLessThan(MAX_ADJACENT_FRAME_ROTATION_DEG);
    }
  },
  120_000,
);

localAssetIt(
  "returns every repeating catalog clip to its starting pose at the loop seam",
  async () => {
    const [characterGltf, ...motionGltfs] = await Promise.all([
      loadPackagedMixamoCharacter("x-bot.glb"),
      ...REPEAT_MOTIONS.map((item) => loadPackagedMixamoMotion(item.fileName)),
    ]);

    for (const [index, item] of REPEAT_MOTIONS.entries()) {
      const rig = createCharacterFrameRig(characterGltf.scene);
      const { action, clip, mixer } = bindRetargetedCatalogClip(rig, motionGltfs[index]!, item);
      // Repeat playback wraps an exact-duration sample back to time zero, so
      // sample the loop endpoint through "once", which clamps to the final key.
      const motion = createTimelineMotion(item.id, "once");
      const startPose = new Float64Array(rig.deformBones.length * 4);
      const endPose = new Float64Array(rig.deformBones.length * 4);

      applyDirectorCharacterMotionFrame({
        ...rig,
        action,
        currentFrame: 0,
        durationS: clip.duration,
        fps: SAMPLING_FPS,
        mixer,
        motion,
      });
      writeBoneQuaternions(rig.deformBones, startPose);

      applyDirectorCharacterMotionFrame({
        ...rig,
        action,
        currentFrame: clip.duration * SAMPLING_FPS,
        durationS: clip.duration,
        fps: SAMPLING_FPS,
        mixer,
        motion,
      });
      writeBoneQuaternions(rig.deformBones, endPose);

      const seamDeg = maxBoneRotationDeltaDeg(startPose, endPose, rig.deformBones.length);
      expect(seamDeg, item.id).toBeLessThan(MAX_LOOP_SEAM_ROTATION_DEG);
    }
  },
  120_000,
);

localAssetIt.each(LOCOMOTION_MOTIONS)(
  "keeps grounded $id inside the stage floor envelope through the production grounding gate",
  async (item) => {
    const [characterGltf, motionGltf] = await Promise.all([
      loadPackagedMixamoCharacter("x-bot.glb"),
      loadPackagedMixamoMotion(item.fileName),
    ]);
    // The whole gait family must stay behind the timeline grounding gate; the
    // regression only covered `walk`/`run` and let strafe/back clips sink.
    expect(LOCOMOTION_MOTIONS.length).toBeGreaterThanOrEqual(8);
    expect(isDirectorLocomotionMotion(item.id)).toBe(true);

    const rig = createCharacterFrameRig(characterGltf.scene);
    const grounding = createMixamoFootGroundingState(rig.scene);
    expect(grounding).not.toBeNull();
    const { action, clip, mixer } = bindRetargetedCatalogClip(rig, motionGltf, item);
    const motion = createTimelineMotion(item.id, "repeat");
    // Exactly the gate MixamoRiggedCharacter applies on the timeline path.
    const groundingEnabled =
      motion.enabled && motion.rootMotion === "in-place" && isDirectorLocomotionMotion(motion.clipId);
    const documentsPenetration = item.id === "walk" || item.id === "run";
    const lastFrame = Math.ceil(clip.duration * SAMPLING_FPS);
    let groundedLowestY = Number.POSITIVE_INFINITY;
    let groundedHighestY = Number.NEGATIVE_INFINITY;
    let ungroundedLowestY = Number.POSITIVE_INFINITY;

    for (let frame = 0; frame <= lastFrame; frame += 1) {
      applyDirectorCharacterMotionFrame({
        ...rig,
        action,
        currentFrame: frame,
        durationS: clip.duration,
        fps: SAMPLING_FPS,
        mixer,
        motion,
      });
      if (documentsPenetration) {
        applyMixamoFootGrounding(rig.scene, grounding, false);
        ungroundedLowestY = Math.min(ungroundedLowestY, new Box3().setFromObject(rig.scene, true).min.y);
      }
      applyMixamoFootGrounding(rig.scene, grounding, groundingEnabled);
      const boundsMinY = new Box3().setFromObject(rig.scene, true).min.y;
      groundedLowestY = Math.min(groundedLowestY, boundsMinY);
      groundedHighestY = Math.max(groundedHighestY, boundsMinY);
    }

    expect(groundedLowestY).toBeGreaterThan(GROUNDED_BOUNDS_MIN_Y_M);
    expect(groundedHighestY).toBeLessThan(GROUNDED_BOUNDS_MAX_Y_M);
    // Documents why grounding must stay enabled for gait clips at all.
    if (documentsPenetration) {
      expect(ungroundedLowestY).toBeLessThan(UNGROUNDED_PENETRATION_Y_M);
    }
  },
  120_000,
);

localAssetIt(
  "converges mirrored Director IK goals symmetrically on all four X Bot chains",
  async () => {
    const characterGltf = await loadPackagedMixamoCharacter("x-bot.glb");
    const rig = createCharacterFrameRig(characterGltf.scene);
    // Director semantics: the actor's left side is -X. Packaged Mixamo rigs
    // author the opposite X handedness, so a converged effector must land on
    // the mirrored asset-local point.
    const handGoal = { reach: 0.45, height: 1.1, forward: 0.1 };
    const footGoal = { reach: 0.15, height: 0.4, forward: 0.25 };

    applyMixamoRestPoseAndRig(rig.scene, {
      controls: {},
      ik: {
        leftHand: {
          target: [-handGoal.reach, handGoal.height, handGoal.forward],
          pole: [-0.4, 1, 0.7],
          weight: 1,
          reachClamp: 1,
        },
        rightHand: {
          target: [handGoal.reach, handGoal.height, handGoal.forward],
          pole: [0.4, 1, 0.7],
          weight: 1,
          reachClamp: 1,
        },
        leftFoot: {
          target: [-footGoal.reach, footGoal.height, footGoal.forward],
          pole: [-0.2, 0.7, 0.9],
          weight: 1,
          reachClamp: 1,
        },
        rightFoot: {
          target: [footGoal.reach, footGoal.height, footGoal.forward],
          pole: [0.2, 0.7, 0.9],
          weight: 1,
          reachClamp: 1,
        },
      },
      restPose: rig.restPose,
    });
    rig.scene.updateMatrixWorld(true);

    const chainErrorM = (bone: Bone | undefined, directorX: number, height: number, forward: number) => {
      const position = rig.scene.worldToLocal(bone!.getWorldPosition(new Vector3()));
      return position.distanceTo(new Vector3(-directorX, height, forward));
    };
    const leftHandError = chainErrorM(rig.resolvedBones.leftHand, -handGoal.reach, handGoal.height, handGoal.forward);
    const rightHandError = chainErrorM(rig.resolvedBones.rightHand, handGoal.reach, handGoal.height, handGoal.forward);
    const leftFootError = chainErrorM(rig.resolvedBones.leftFoot, -footGoal.reach, footGoal.height, footGoal.forward);
    const rightFootError = chainErrorM(rig.resolvedBones.rightFoot, footGoal.reach, footGoal.height, footGoal.forward);

    expect(leftFootError).toBeLessThan(MAX_FOOT_IK_ERROR_M);
    expect(rightFootError).toBeLessThan(MAX_FOOT_IK_ERROR_M);
    expect(leftHandError).toBeLessThan(MAX_HAND_IK_ERROR_M);
    expect(rightHandError).toBeLessThan(MAX_HAND_IK_ERROR_M);
    // The mirror regression pulled only the right-hand goal across the body,
    // so left/right convergence quality must match, not merely both converge.
    expect(Math.abs(leftHandError - rightHandError)).toBeLessThan(MAX_IK_SYMMETRY_GAP_M);
    expect(Math.abs(leftFootError - rightFootError)).toBeLessThan(MAX_IK_SYMMETRY_GAP_M);
  },
  60_000,
);

localAssetIt(
  "crossfades idle into walk without rotation pops through the weighted mixer path",
  async () => {
    const idleItem = DIRECTOR_CHARACTER_MOTION_CATALOG.find((item) => item.id === "idle")!;
    const walkItem = DIRECTOR_CHARACTER_MOTION_CATALOG.find((item) => item.id === "walk")!;
    const [characterGltf, idleGltf, walkGltf] = await Promise.all([
      loadPackagedMixamoCharacter("x-bot.glb"),
      loadPackagedMixamoMotion(idleItem.fileName),
      loadPackagedMixamoMotion(walkItem.fileName),
    ]);
    const rig = createCharacterFrameRig(characterGltf.scene);
    const mixer = new AnimationMixer(rig.scene);
    const idle = bindRetargetedCatalogClip(rig, idleGltf, idleItem, mixer);
    const walk = bindRetargetedCatalogClip(rig, walkGltf, walkItem, mixer);
    const fadeDurationS = 0.16;
    // Covers the whole fade plus two fully-walk steps at 60 fps.
    const lastStep = 12;
    const previousPose = new Float64Array(rig.deformBones.length * 4);
    const currentPose = new Float64Array(rig.deformBones.length * 4);
    let widestStepDeg = 0;

    for (let step = 0; step <= lastStep; step += 1) {
      const timeS = step / SAMPLING_FPS;
      const fadeProgress = Math.min(1, timeS / fadeDurationS);
      const walkWeight = fadeProgress * fadeProgress * (3 - 2 * fadeProgress);
      const result = applyDirectorCharacterWeightedMotionFrame({
        ...rig,
        actions: [idle.action, walk.action],
        layers: [
          { action: idle.action, durationS: idle.clip.duration, timeS, weight: 1 - walkWeight },
          { action: walk.action, durationS: walk.clip.duration, timeS, weight: walkWeight },
        ],
        mixer,
      });
      expect(result.active).toBe(true);
      writeBoneQuaternions(rig.deformBones, currentPose);
      if (step > 0) {
        widestStepDeg = Math.max(
          widestStepDeg,
          maxBoneRotationDeltaDeg(previousPose, currentPose, rig.deformBones.length),
        );
      }
      previousPose.set(currentPose);
    }

    expect(widestStepDeg).toBeGreaterThan(0.01);
    expect(widestStepDeg).toBeLessThan(MAX_CROSSFADE_STEP_ROTATION_DEG);
  },
  60_000,
);
