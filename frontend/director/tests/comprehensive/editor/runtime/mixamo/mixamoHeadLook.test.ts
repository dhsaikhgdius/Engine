import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Bone, Group, Matrix4, Quaternion, Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { describe, expect, it, vi } from "vitest";
import { localAssetIt } from "../../../../../../../packages/protocol/tests/localAssetTest";
import { configureDirectorGLTFLoader } from "../../../../../src/comprehensive/editor/runtime/gltfLoader";
import { prepareMixamoCharacterInstance } from "../../../../../src/comprehensive/editor/runtime/mixamo/mixamoCharacterPrepare";
import type { MixamoResolvedBones } from "../../../../../src/comprehensive/editor/runtime/mixamo/mixamoCharacterRig";
import {
  applyMixamoHeadLookPose,
  createMixamoHeadLookRuntime,
  getMixamoHeadLookWeight,
  isMixamoHeadLookEligible,
  isMixamoHeadLookSettled,
  MIXAMO_HEAD_LOOK_BEHIND_ENTER_RAD,
  MIXAMO_HEAD_LOOK_BEHIND_EXIT_RAD,
  MIXAMO_HEAD_LOOK_ENTER_BLEND_S,
  MIXAMO_HEAD_LOOK_EXIT_BLEND_S,
  MIXAMO_HEAD_LOOK_MAX_PITCH_RAD,
  MIXAMO_HEAD_LOOK_MAX_YAW_RAD,
  MIXAMO_HEAD_LOOK_NECK_SHARE,
  resolveMixamoHeadLookNeck,
  updateMixamoHeadLook,
} from "../../../../../src/comprehensive/editor/runtime/mixamo/mixamoHeadLook";
import { DIRECTOR_CHARACTER_LOCOMOTION_CROSSFADE_S } from "../../../../../src/comprehensive/editor/runtime/mixamo/mixamoLocomotionRuntime";

/**
 * Standing Director-handed test skeleton: hips, spine, optional neck, head,
 * plus a left arm and both legs so the tests can assert that gaze rotations
 * never leak into limbs or feet.
 */
function createHeadLookTestRig({ includeNeck = true, directorTransform = false } = {}) {
  const directorSpace = new Group();
  if (directorTransform) {
    directorSpace.position.set(3, 0, -2);
    directorSpace.rotation.y = Math.PI / 2;
  }
  const root = new Group();
  directorSpace.add(root);

  const hips = new Bone();
  hips.name = "Hips";
  hips.position.set(0, 0.85, 0);
  root.add(hips);

  const spine = new Bone();
  spine.name = "Spine2";
  spine.position.set(0, 0.3, 0);
  hips.add(spine);

  let neck: Bone | undefined;
  const head = new Bone();
  head.name = "Head";
  if (includeNeck) {
    neck = new Bone();
    neck.name = "Neck";
    neck.position.set(0, 0.12, 0);
    head.position.set(0, 0.08, 0);
    neck.add(head);
    spine.add(neck);
  } else {
    head.position.set(0, 0.2, 0);
    spine.add(head);
  }

  const shoulder = new Bone();
  shoulder.name = "LeftArm";
  shoulder.position.set(0.18, 0.05, 0);
  const elbow = new Bone();
  elbow.name = "LeftForeArm";
  elbow.position.set(0.25, 0, 0);
  const hand = new Bone();
  hand.name = "LeftHand";
  hand.position.set(0.25, 0, 0);
  elbow.add(hand);
  shoulder.add(elbow);
  spine.add(shoulder);

  // The runtime resolves the neck structurally (head's parent named Neck),
  // mirroring the shared role table which deliberately stops at `head`.
  const bones: MixamoResolvedBones = {
    body: hips,
    torso: spine,
    head,
    leftShoulder: shoulder,
    leftElbow: elbow,
    leftHand: hand,
  };

  for (const side of ["left", "right"] as const) {
    const sign = side === "left" ? -1 : 1;
    const hip = new Bone();
    hip.position.set(sign * 0.1, -0.05, 0);
    const knee = new Bone();
    knee.position.set(0, -0.4, 0);
    const foot = new Bone();
    foot.position.set(0, -0.35, 0);
    hip.add(knee);
    knee.add(foot);
    hips.add(hip);
    bones[side === "left" ? "leftHip" : "rightHip"] = hip;
    bones[side === "left" ? "leftKnee" : "rightKnee"] = knee;
    bones[side === "left" ? "leftFoot" : "rightFoot"] = foot;
  }

  directorSpace.updateMatrixWorld(true);
  return { directorSpace, root, bones, neck, head };
}

type HeadLookInput = Parameters<typeof updateMixamoHeadLook>[1];

/** Run enough fixed-step updates for both the blend clock and damping to snap. */
function settleHeadLook(runtime: ReturnType<typeof createMixamoHeadLookRuntime>, state: HeadLookInput) {
  for (let index = 0; index < 60; index += 1) updateMixamoHeadLook(runtime, state, 0.05);
}

function worldPosition(object: Bone) {
  return object.getWorldPosition(new Vector3());
}

/** Gaze direction in director-local axes after the pose pass, derived from the head's world delta. */
function measureDirectorLocalGaze(directorSpace: Group, headBefore: Quaternion, head: Bone) {
  const worldDelta = head.getWorldQuaternion(new Quaternion()).multiply(headBefore.clone().invert());
  const basis = directorSpace.matrixWorld.elements;
  const forwardWorld = new Vector3(basis[8], basis[9], basis[10]).normalize();
  const gazeWorld = forwardWorld.applyQuaternion(worldDelta);
  return gazeWorld.transformDirection(new Matrix4().copy(directorSpace.matrixWorld).invert());
}

/** Independent expectation: the camera-view parameterization used by the player. */
function expectedDirectorLocalGaze(yawRad: number, pitchRad: number) {
  return new Vector3(Math.sin(yawRad) * Math.cos(pitchRad), Math.sin(pitchRad), Math.cos(yawRad) * Math.cos(pitchRad));
}

function quaternionAngle(quaternion: Quaternion) {
  return 2 * Math.acos(Math.min(1, Math.abs(quaternion.w)));
}

async function loadPackagedGlb(relativePath: string) {
  const binary = readFileSync(resolve(process.cwd(), relativePath));
  const data = new ArrayBuffer(binary.byteLength);
  new Uint8Array(data).set(binary);
  vi.stubGlobal("createImageBitmap", async () => ({ close: vi.fn() }));
  return configureDirectorGLTFLoader(new GLTFLoader()).parseAsync(data, "");
}

describe("Mixamo head look eligibility", () => {
  it("activates only in plain locomotion and only when a gaze is published", () => {
    expect(isMixamoHeadLookEligible(null)).toBe(false);
    expect(isMixamoHeadLookEligible(undefined)).toBe(false);
    for (const mode of ["idle", "walk", "run"] as const) {
      expect(isMixamoHeadLookEligible({ mode, lookYawRad: 0.4 })).toBe(true);
      expect(isMixamoHeadLookEligible({ mode, lookPitchRad: -0.2 })).toBe(true);
      // Writers that never publish gaze fields keep their previous behavior.
      expect(isMixamoHeadLookEligible({ mode })).toBe(false);
    }
    for (const mode of ["jump", "fly", "emote"] as const) {
      expect(isMixamoHeadLookEligible({ mode, lookYawRad: 0.4, lookPitchRad: 0.1 })).toBe(false);
    }
    // A zero gaze is still a gaze: the layer engages and aims dead ahead.
    expect(isMixamoHeadLookEligible({ mode: "idle", lookYawRad: 0 })).toBe(true);
    expect(isMixamoHeadLookEligible({ mode: "walk", lookYawRad: Number.NaN })).toBe(false);
  });
});

describe("Mixamo head look weight and damping", () => {
  it("crossfades in over the enter blend and out fast enough for any emote window", () => {
    // Red line: the fade-out must complete inside the shortest clip crossfade
    // so a starting talk/wave emote never overlaps the procedural gaze.
    expect(MIXAMO_HEAD_LOOK_EXIT_BLEND_S).toBeLessThan(DIRECTOR_CHARACTER_LOCOMOTION_CROSSFADE_S);

    const runtime = createMixamoHeadLookRuntime();
    const idleLook: HeadLookInput = { mode: "idle", lookYawRad: 0, lookPitchRad: 0 };
    expect(getMixamoHeadLookWeight(runtime)).toBe(0);
    expect(isMixamoHeadLookSettled(runtime)).toBe(true);

    expect(updateMixamoHeadLook(runtime, idleLook, MIXAMO_HEAD_LOOK_ENTER_BLEND_S / 2)).toBeCloseTo(0.5, 6);
    expect(isMixamoHeadLookSettled(runtime)).toBe(false);
    expect(updateMixamoHeadLook(runtime, idleLook, MIXAMO_HEAD_LOOK_ENTER_BLEND_S / 2)).toBe(1);
    expect(isMixamoHeadLookSettled(runtime)).toBe(true);
    // Weight saturates instead of overshooting.
    expect(updateMixamoHeadLook(runtime, idleLook, 1)).toBe(1);

    expect(updateMixamoHeadLook(runtime, null, MIXAMO_HEAD_LOOK_EXIT_BLEND_S / 2)).toBeCloseTo(0.5, 6);
    expect(updateMixamoHeadLook(runtime, null, MIXAMO_HEAD_LOOK_EXIT_BLEND_S / 2)).toBe(0);
    expect(isMixamoHeadLookSettled(runtime)).toBe(true);

    // Malformed frame deltas cannot corrupt the clock.
    expect(updateMixamoHeadLook(runtime, idleLook, Number.NaN)).toBe(0);
    expect(updateMixamoHeadLook(runtime, idleLook, -1)).toBe(0);
  });

  it("lags the camera through exponential damping and converges exactly", () => {
    const runtime = createMixamoHeadLookRuntime();
    const look: HeadLookInput = { mode: "idle", lookYawRad: 0.8, lookPitchRad: 0.3 };

    // One 60 Hz frame moves noticeably but far from all the way: the lag feel.
    updateMixamoHeadLook(runtime, look, 1 / 60);
    expect(runtime.yawRad).toBeGreaterThan(0.05);
    expect(runtime.yawRad).toBeLessThan(0.3 * 0.8);

    // Convergence is monotonic and lands exactly on the clamped target.
    let previous = runtime.yawRad;
    for (let index = 0; index < 120; index += 1) {
      updateMixamoHeadLook(runtime, look, 1 / 60);
      expect(runtime.yawRad).toBeGreaterThanOrEqual(previous);
      expect(runtime.yawRad).toBeLessThanOrEqual(0.8);
      previous = runtime.yawRad;
    }
    expect(runtime.yawRad).toBeCloseTo(0.8, 10);
    expect(runtime.pitchRad).toBeCloseTo(0.3, 10);
    expect(isMixamoHeadLookSettled(runtime)).toBe(true);

    // Retargeting re-damps rather than jumping.
    updateMixamoHeadLook(runtime, { mode: "idle", lookYawRad: -0.4, lookPitchRad: 0.3 }, 1 / 60);
    expect(runtime.yawRad).toBeLessThan(0.8);
    expect(runtime.yawRad).toBeGreaterThan(-0.4);
  });

  it("clamps the aimed gaze to the head limits", () => {
    const runtime = createMixamoHeadLookRuntime();
    settleHeadLook(runtime, { mode: "idle", lookYawRad: (80 * Math.PI) / 180, lookPitchRad: (-50 * Math.PI) / 180 });
    expect(runtime.yawRad).toBeCloseTo(MIXAMO_HEAD_LOOK_MAX_YAW_RAD, 6);
    expect(runtime.pitchRad).toBeCloseTo(-MIXAMO_HEAD_LOOK_MAX_PITCH_RAD, 6);
  });

  it("recenters smoothly when the gaze points behind, with hysteresis at the boundary", () => {
    const runtime = createMixamoHeadLookRuntime();
    settleHeadLook(runtime, { mode: "idle", lookYawRad: 1.0, lookPitchRad: 0.2 });
    expect(runtime.yawRad).toBeCloseTo(1.0, 6);

    // Beyond the enter threshold the head returns to center; both axes relax.
    const behindYaw = MIXAMO_HEAD_LOOK_BEHIND_ENTER_RAD + 0.2;
    updateMixamoHeadLook(runtime, { mode: "idle", lookYawRad: behindYaw, lookPitchRad: 0.2 }, 1 / 60);
    expect(runtime.behind).toBe(true);
    expect(runtime.yawTargetRad).toBe(0);
    expect(runtime.pitchTargetRad).toBe(0);
    let previous = runtime.yawRad;
    for (let index = 0; index < 120; index += 1) {
      updateMixamoHeadLook(runtime, { mode: "idle", lookYawRad: behindYaw, lookPitchRad: 0.2 }, 1 / 60);
      expect(runtime.yawRad).toBeLessThanOrEqual(previous);
      previous = runtime.yawRad;
    }
    expect(runtime.yawRad).toBe(0);
    // The eligibility weight itself never dropped: the actor stays "alive".
    expect(getMixamoHeadLookWeight(runtime)).toBe(1);

    // Between exit (92 deg) and enter (100 deg) thresholds the latch holds...
    const boundaryYaw = (MIXAMO_HEAD_LOOK_BEHIND_ENTER_RAD + MIXAMO_HEAD_LOOK_BEHIND_EXIT_RAD) / 2;
    updateMixamoHeadLook(runtime, { mode: "idle", lookYawRad: boundaryYaw, lookPitchRad: 0 }, 1 / 60);
    expect(runtime.behind).toBe(true);
    expect(runtime.yawTargetRad).toBe(0);

    // ...and a clearly frontal gaze re-engages the aim.
    updateMixamoHeadLook(runtime, { mode: "idle", lookYawRad: 0.5, lookPitchRad: 0 }, 1 / 60);
    expect(runtime.behind).toBe(false);
    expect(runtime.yawTargetRad).toBeCloseTo(0.5, 6);
  });
});

describe("applyMixamoHeadLookPose", () => {
  it("turns the gaze to the published yaw/pitch and splits the arc between neck and head", () => {
    const { directorSpace, root, bones, neck } = createHeadLookTestRig();
    expect(resolveMixamoHeadLookNeck(bones.head!)).toBe(neck);
    const runtime = createMixamoHeadLookRuntime();
    const yaw = 0.6;
    const pitch = 0.3;
    settleHeadLook(runtime, { mode: "idle", lookYawRad: yaw, lookPitchRad: pitch });

    const headBefore = bones.head!.getWorldQuaternion(new Quaternion());
    const neckBefore = neck!.getWorldQuaternion(new Quaternion());

    expect(applyMixamoHeadLookPose(runtime, { root, directorSpace, bones })).toBe(true);

    const gaze = measureDirectorLocalGaze(directorSpace, headBefore, bones.head!);
    const expected = expectedDirectorLocalGaze(yaw, pitch);
    expect(gaze.distanceTo(expected)).toBeLessThan(0.001);

    // The neck carries its share of the total arc; the head completes it.
    const headDeltaAngle = quaternionAngle(
      bones.head!.getWorldQuaternion(new Quaternion()).multiply(headBefore.clone().invert()),
    );
    const neckDeltaAngle = quaternionAngle(
      neck!.getWorldQuaternion(new Quaternion()).multiply(neckBefore.clone().invert()),
    );
    expect(neckDeltaAngle).toBeCloseTo(headDeltaAngle * MIXAMO_HEAD_LOOK_NECK_SHARE, 3);
  });

  it("keeps hips, legs, feet, shoulders, and hands exactly where the clip put them", () => {
    const { directorSpace, root, bones } = createHeadLookTestRig();
    const runtime = createMixamoHeadLookRuntime();
    settleHeadLook(runtime, { mode: "idle", lookYawRad: MIXAMO_HEAD_LOOK_MAX_YAW_RAD, lookPitchRad: 0.3 });

    const hipsBefore = worldPosition(bones.body!);
    const leftFootBefore = worldPosition(bones.leftFoot!);
    const rightFootBefore = worldPosition(bones.rightFoot!);
    const shoulderBefore = worldPosition(bones.leftShoulder!);
    const handBefore = worldPosition(bones.leftHand!);

    expect(applyMixamoHeadLookPose(runtime, { root, directorSpace, bones })).toBe(true);

    expect(worldPosition(bones.body!).distanceTo(hipsBefore)).toBeLessThan(1e-9);
    expect(worldPosition(bones.leftFoot!).distanceTo(leftFootBefore)).toBeLessThan(1e-9);
    expect(worldPosition(bones.rightFoot!).distanceTo(rightFootBefore)).toBeLessThan(1e-9);
    // Red line: gaze must not drift the shoulder line or the arms.
    expect(worldPosition(bones.leftShoulder!).distanceTo(shoulderBefore)).toBeLessThan(1e-9);
    expect(worldPosition(bones.leftHand!).distanceTo(handBefore)).toBeLessThan(1e-9);
  });

  it("lets the head carry the whole arc on skeletons without a neck bone", () => {
    const { directorSpace, root, bones } = createHeadLookTestRig({ includeNeck: false });
    expect(resolveMixamoHeadLookNeck(bones.head!)).toBeUndefined();
    const runtime = createMixamoHeadLookRuntime();
    const yaw = -0.5;
    const pitch = 0.2;
    settleHeadLook(runtime, { mode: "walk", lookYawRad: yaw, lookPitchRad: pitch });

    const headBefore = bones.head!.getWorldQuaternion(new Quaternion());
    expect(applyMixamoHeadLookPose(runtime, { root, directorSpace, bones })).toBe(true);
    const gaze = measureDirectorLocalGaze(directorSpace, headBefore, bones.head!);
    expect(gaze.distanceTo(expectedDirectorLocalGaze(yaw, pitch))).toBeLessThan(0.001);
  });

  it("resolves the gaze in character axes inside a translated and rotated director space", () => {
    const { directorSpace, root, bones } = createHeadLookTestRig({ directorTransform: true });
    const runtime = createMixamoHeadLookRuntime();
    const yaw = 0.45;
    const pitch = -0.25;
    settleHeadLook(runtime, { mode: "run", lookYawRad: yaw, lookPitchRad: pitch });

    const headBefore = bones.head!.getWorldQuaternion(new Quaternion());
    expect(applyMixamoHeadLookPose(runtime, { root, directorSpace, bones })).toBe(true);
    const gaze = measureDirectorLocalGaze(directorSpace, headBefore, bones.head!);
    expect(gaze.distanceTo(expectedDirectorLocalGaze(yaw, pitch))).toBeLessThan(0.001);
  });

  it("scales the applied arc by the blend weight at the crossfade midpoint", () => {
    const { directorSpace, root, bones } = createHeadLookTestRig();
    const runtime = createMixamoHeadLookRuntime();
    runtime.progress = 0.5; // smoothstep(0.5) = 0.5
    runtime.targetActive = true;
    runtime.yawRad = 0.6;
    runtime.pitchRad = 0.2;

    const headBefore = bones.head!.getWorldQuaternion(new Quaternion());
    expect(applyMixamoHeadLookPose(runtime, { root, directorSpace, bones })).toBe(true);
    const gaze = measureDirectorLocalGaze(directorSpace, headBefore, bones.head!);
    expect(gaze.distanceTo(expectedDirectorLocalGaze(0.3, 0.1))).toBeLessThan(0.001);
  });

  it("takes the zero-cost fast path when inactive, recentered, or without a head bone", () => {
    const { directorSpace, root, bones, neck } = createHeadLookTestRig();
    const runtime = createMixamoHeadLookRuntime();

    // Zero weight: nothing touched.
    const headQuaternion = bones.head!.quaternion.clone();
    const neckQuaternion = neck!.quaternion.clone();
    expect(applyMixamoHeadLookPose(runtime, { root, directorSpace, bones })).toBe(false);
    expect(bones.head!.quaternion.equals(headQuaternion)).toBe(true);
    expect(neck!.quaternion.equals(neckQuaternion)).toBe(true);

    // Full weight but a dead-ahead (or recentered-behind) gaze: still free.
    settleHeadLook(runtime, { mode: "idle", lookYawRad: 0, lookPitchRad: 0 });
    expect(getMixamoHeadLookWeight(runtime)).toBe(1);
    expect(applyMixamoHeadLookPose(runtime, { root, directorSpace, bones })).toBe(false);
    settleHeadLook(runtime, { mode: "idle", lookYawRad: Math.PI * 0.9, lookPitchRad: 0.3 });
    expect(applyMixamoHeadLookPose(runtime, { root, directorSpace, bones })).toBe(false);
    expect(bones.head!.quaternion.equals(headQuaternion)).toBe(true);

    // No head bone resolved: refuse instead of guessing.
    settleHeadLook(runtime, { mode: "idle", lookYawRad: 0.5, lookPitchRad: 0 });
    expect(applyMixamoHeadLookPose(runtime, { root, directorSpace, bones: { ...bones, head: undefined } })).toBe(false);
  });

  it("fades out inside an emote start while the angles relax, leaving no residual twist", () => {
    const { directorSpace, root, bones, neck } = createHeadLookTestRig();
    const runtime = createMixamoHeadLookRuntime();
    settleHeadLook(runtime, { mode: "idle", lookYawRad: 0.9, lookPitchRad: 0.2 });

    const restQuaternion = bones.head!.quaternion.clone();
    // Emote begins: eligibility drops, weight fades within the crossfade window.
    let applied = true;
    let elapsedS = 0;
    while (applied) {
      const weight = updateMixamoHeadLook(runtime, { mode: "emote", lookYawRad: 0.9, lookPitchRad: 0.2 }, 1 / 60);
      elapsedS += 1 / 60;
      // Simulate the renderer restoring the sampled pose before modifiers.
      bones.head!.quaternion.copy(restQuaternion);
      neck!.quaternion.identity();
      root.updateMatrixWorld(true);
      applied = weight > 0 && applyMixamoHeadLookPose(runtime, { root, directorSpace, bones });
      expect(elapsedS).toBeLessThan(DIRECTOR_CHARACTER_LOCOMOTION_CROSSFADE_S + 1 / 30);
    }
    expect(getMixamoHeadLookWeight(runtime)).toBe(0);
  });
});

localAssetIt("aims a prepared X Bot's real neck and head without disturbing hands or feet", async () => {
  const gltf = await loadPackagedGlb("assets/library/mixamo-characters/models/x-bot.glb");
  const prepared = prepareMixamoCharacterInstance(gltf.scene, "x-bot-head-look-test", 1.78);
  const directorSpace = new Group();
  directorSpace.add(prepared.scene);
  directorSpace.updateMatrixWorld(true);
  const bones = prepared.resolvedBones;
  expect(bones.head).toBeDefined();
  // The packaged skeleton exposes a real neck (the head's parent) for the split.
  const neck = resolveMixamoHeadLookNeck(bones.head!);
  expect(neck).toBeDefined();

  const runtime = createMixamoHeadLookRuntime();
  const yaw = 0.7;
  const pitch = 0.25;
  settleHeadLook(runtime, { mode: "idle", lookYawRad: yaw, lookPitchRad: pitch });

  const headBefore = bones.head!.getWorldQuaternion(new Quaternion());
  const neckBefore = neck!.getWorldQuaternion(new Quaternion());
  const leftHandBefore = worldPosition(bones.leftHand!);
  const rightHandBefore = worldPosition(bones.rightHand!);
  const leftFootBefore = worldPosition(bones.leftFoot!);
  const rightFootBefore = worldPosition(bones.rightFoot!);

  expect(applyMixamoHeadLookPose(runtime, { root: prepared.scene, directorSpace, bones })).toBe(true);

  // Mixamo bone local axes are not world-aligned; the gaze must still resolve
  // exactly in the character's director-space axes.
  const gaze = measureDirectorLocalGaze(directorSpace, headBefore, bones.head!);
  expect(gaze.distanceTo(expectedDirectorLocalGaze(yaw, pitch))).toBeLessThan(0.002);

  const headDeltaAngle = quaternionAngle(
    bones.head!.getWorldQuaternion(new Quaternion()).multiply(headBefore.clone().invert()),
  );
  const neckDeltaAngle = quaternionAngle(
    neck!.getWorldQuaternion(new Quaternion()).multiply(neckBefore.clone().invert()),
  );
  expect(neckDeltaAngle / headDeltaAngle).toBeGreaterThan(MIXAMO_HEAD_LOOK_NECK_SHARE - 0.02);
  expect(neckDeltaAngle / headDeltaAngle).toBeLessThan(MIXAMO_HEAD_LOOK_NECK_SHARE + 0.02);

  expect(worldPosition(bones.leftHand!).distanceTo(leftHandBefore)).toBeLessThan(1e-6);
  expect(worldPosition(bones.rightHand!).distanceTo(rightHandBefore)).toBeLessThan(1e-6);
  expect(worldPosition(bones.leftFoot!).distanceTo(leftFootBefore)).toBeLessThan(1e-6);
  expect(worldPosition(bones.rightFoot!).distanceTo(rightFootBefore)).toBeLessThan(1e-6);
});
