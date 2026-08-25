import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AnimationMixer, Bone, Group, Quaternion, Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { describe, expect, it, vi } from "vitest";
import { localAssetIt } from "../../../../../../../packages/protocol/tests/localAssetTest";
import { DIRECTOR_DEFAULT_CHARACTER_HEIGHT, getScaledPlayerConfig } from "../../../../../src/comprehensive/editor/player/characterFollowRuntime";
import { configureDirectorGLTFLoader } from "../../../../../src/comprehensive/editor/runtime/gltfLoader";
import type { DirectorCharacterIkState } from "../../../../../src/comprehensive/editor/schema/directorProject";
import { prepareMixamoCharacterInstance } from "../../../../../src/comprehensive/editor/runtime/mixamo/mixamoCharacterPrepare";
import { applyMixamoCharacterIk, type MixamoResolvedBones } from "../../../../../src/comprehensive/editor/runtime/mixamo/mixamoCharacterRig";
import { DEFAULT_MIXAMO_FOOT_LOCK_CONFIG } from "../../../../../src/comprehensive/editor/runtime/mixamo/mixamoFootLock";
import {
  applyMixamoFootSlopeAlignment,
  createMixamoFootLockRigRuntime,
  updateMixamoFootLockRigRuntime,
} from "../../../../../src/comprehensive/editor/runtime/mixamo/mixamoFootLockRig";
import {
  applyDirectorCharacterWeightedMotionFrame,
  configureDirectorCharacterMotionAction,
  retargetMixamoAnimationClip,
} from "../../../../../src/comprehensive/editor/runtime/mixamo/mixamoMotion";

const PACKAGED_GAIT_FILES = [
  "walk.glb",
  "walk-back.glb",
  "walk-left.glb",
  "walk-right.glb",
  "run.glb",
  "run-back.glb",
  "run-left.glb",
  "run-right.glb",
] as const;

const NOMINAL_PLAYER_SPEED = getScaledPlayerConfig(DIRECTOR_DEFAULT_CHARACTER_HEIGHT);

function getGaitWorldVelocity(fileName: (typeof PACKAGED_GAIT_FILES)[number]) {
  const speed = fileName.startsWith("run") ? NOMINAL_PLAYER_SPEED.runSpeed : NOMINAL_PLAYER_SPEED.walkSpeed;
  if (fileName.includes("-back")) return [0, 0, -speed] as const;
  if (fileName.includes("-left")) return [speed, 0, 0] as const;
  if (fileName.includes("-right")) return [-speed, 0, 0] as const;
  return [0, 0, speed] as const;
}

async function loadPackagedGlb(relativePath: string) {
  const binary = readFileSync(resolve(process.cwd(), relativePath));
  const data = new ArrayBuffer(binary.byteLength);
  new Uint8Array(data).set(binary);
  vi.stubGlobal("createImageBitmap", async () => ({ close: vi.fn() }));
  return configureDirectorGLTFLoader(new GLTFLoader()).parseAsync(data, "");
}

function expectFiniteVector(vector: Vector3) {
  expect(Number.isFinite(vector.x)).toBe(true);
  expect(Number.isFinite(vector.y)).toBe(true);
  expect(Number.isFinite(vector.z)).toBe(true);
}

function expectFiniteTuple(tuple: readonly number[]) {
  tuple.forEach((value) => expect(Number.isFinite(value)).toBe(true));
}

function createTestRig({ includeRightFoot = true } = {}) {
  const directorSpace = new Group();
  directorSpace.position.set(5, 0, -2);
  directorSpace.rotation.y = Math.PI / 2;
  directorSpace.scale.set(1.5, 0.8, 2);
  const skeleton = new Group();
  directorSpace.add(skeleton);

  const leftHip = new Bone();
  leftHip.position.set(-0.2, 0, 0);
  const leftKnee = new Bone();
  leftKnee.position.set(0, 0.5, 0);
  const leftFoot = new Bone();
  leftFoot.position.set(0, -0.41, 0);
  leftHip.add(leftKnee);
  leftKnee.add(leftFoot);

  const rightHip = new Bone();
  rightHip.position.set(0.2, 0, 0);
  const rightKnee = new Bone();
  rightKnee.position.set(0, 0.5, 0);
  const rightFoot = new Bone();
  rightFoot.position.set(0, -0.38, 0);
  rightHip.add(rightKnee);
  rightKnee.add(rightFoot);
  skeleton.add(leftHip, rightHip);
  directorSpace.updateMatrixWorld(true);

  const bones: MixamoResolvedBones = {
    leftHip,
    leftKnee,
    leftFoot,
    rightHip,
    rightKnee,
    ...(includeRightFoot ? { rightFoot } : {}),
  };
  return { bones, directorSpace, leftFoot, rightFoot };
}

describe("Mixamo foot-lock rig adapter", () => {
  it("samples real bone world positions and writes stable Director-local foot IK", () => {
    const { bones, directorSpace } = createTestRig();
    const runtime = createMixamoFootLockRigRuntime();
    const ik = runtime.ik;
    const leftTarget = runtime.leftFootTarget;
    const frameInput = runtime.frameInput;
    const leftPosition = runtime.frameInput.leftFoot.positionWorld;
    const leftHand = {
      target: [-0.5, 1.2, 0.2] as [number, number, number],
      pole: [-0.7, 1, 0.5] as [number, number, number],
      weight: 0.8,
      reachClamp: 0.95,
    };
    const authoredIk: DirectorCharacterIkState = { leftHand };

    for (let index = 0; index < 6; index += 1) {
      expect(
        updateMixamoFootLockRigRuntime(runtime, {
          bones,
          directorSpace,
          deltaS: 1 / 60,
          grounded: true,
          locomotionMode: "walk",
          actionKey: "walk",
          leftGroundHeightWorld: 0,
          rightGroundHeightWorld: 0,
          authoredIk,
        }),
      ).toBe(ik);
    }

    expect(runtime.frameInput).toBe(frameInput);
    expect(runtime.frameInput.leftFoot.positionWorld).toBe(leftPosition);
    expect(runtime.ik.leftFoot).toBe(leftTarget);
    expect(runtime.ik.leftHand).toBe(leftHand);
    expect(runtime.lockState.output.leftFoot.locked).toBe(true);
    expect(runtime.lockState.output.rightFoot.locked).toBe(true);
    expect(runtime.leftFootTarget.target[0]).toBeCloseTo(-0.2, 6);
    expect(runtime.leftFootTarget.target[1]).toBeCloseTo(0.09, 6);
    expect(runtime.leftFootTarget.target[2]).toBeCloseTo(0, 6);
    expect(runtime.leftFootTarget.pole[0]).toBeCloseTo(-0.2, 6);
    expect(runtime.leftFootTarget.pole[1]).toBeCloseTo(0.5, 6);
    expect(runtime.leftFootTarget.pole[2]).toBeCloseTo(0.45, 6);
    expect(runtime.leftFootTarget.weight).toBeGreaterThan(0);
  });

  it("crossfades authored foot IK with the runtime lock at enter and exit midpoints", () => {
    const { bones, directorSpace } = createTestRig();
    const runtime = createMixamoFootLockRigRuntime();
    const stableIk = runtime.ik;
    const stableTarget = runtime.leftFootTarget;
    const authoredLeftFoot = {
      target: [-0.8, 0.24, 0.35] as [number, number, number],
      pole: [-0.65, 0.72, 0.18] as [number, number, number],
      weight: 0.8,
      reachClamp: 0.9,
    };
    const authoredSnapshot = structuredClone(authoredLeftFoot);
    const authoredIk: DirectorCharacterIkState = { leftFoot: authoredLeftFoot };
    const update = (runtimeOwnershipWeight: number) =>
      updateMixamoFootLockRigRuntime(runtime, {
        bones,
        directorSpace,
        deltaS: 1 / 60,
        grounded: true,
        locomotionMode: "walk",
        actionKey: "walk",
        leftGroundHeightWorld: 0,
        rightGroundHeightWorld: 0,
        authoredIk,
        runtimeOwnershipWeight,
      });
    const expectMidpointBlend = () => {
      const lock = runtime.leftFootLockTarget;
      const authoredContribution = authoredLeftFoot.weight * 0.5;
      const lockContribution = lock.weight * 0.5;
      const total = authoredContribution + lockContribution;
      const authoredMix = authoredContribution / total;
      const lockMix = lockContribution / total;
      expect(runtime.leftFootTarget.weight).toBeCloseTo(Math.min(1, total), 6);
      for (const axis of [0, 1, 2] as const) {
        expect(runtime.leftFootTarget.target[axis]).toBeCloseTo(
          authoredLeftFoot.target[axis] * authoredMix + lock.target[axis] * lockMix,
          6,
        );
        expect(runtime.leftFootTarget.pole[axis]).toBeCloseTo(
          authoredLeftFoot.pole[axis] * authoredMix + lock.pole[axis] * lockMix,
          6,
        );
      }
      expect(runtime.leftFootTarget.reachClamp).toBeCloseTo(
        authoredLeftFoot.reachClamp * authoredMix + lock.reachClamp * lockMix,
        6,
      );
    };

    // Acquire the world lock while authored IK still owns the visible result.
    for (let index = 0; index < 8; index += 1) update(0);
    expect(runtime.leftFootTarget).toMatchObject(authoredLeftFoot);

    update(0.5);
    expectMidpointBlend();

    update(1);
    expect(runtime.leftFootTarget).toMatchObject(runtime.leftFootLockTarget);

    update(0.5);
    expectMidpointBlend();

    update(0);
    expect(runtime.leftFootTarget).toMatchObject(authoredLeftFoot);
    expect(runtime.ik).toBe(stableIk);
    expect(runtime.ik.leftFoot).toBe(stableTarget);
    expect(authoredLeftFoot).toEqual(authoredSnapshot);
  });

  it("stores per-foot ground normals and pure lock weights for slope alignment", () => {
    const { bones, directorSpace } = createTestRig();
    const runtime = createMixamoFootLockRigRuntime();
    const leftNormal = new Vector3(0, Math.cos(0.35), Math.sin(0.35));
    const rightNormal = new Vector3(Math.sin(0.25), Math.cos(0.25), 0);
    const authoredIk: DirectorCharacterIkState = {
      leftFoot: {
        target: [-0.8, 0.24, 0.35],
        pole: [-0.65, 0.72, 0.18],
        weight: 0.8,
        reachClamp: 0.9,
      },
    };

    for (let index = 0; index < 8; index += 1) {
      updateMixamoFootLockRigRuntime(runtime, {
        bones,
        directorSpace,
        deltaS: 1 / 60,
        grounded: true,
        locomotionMode: "walk",
        actionKey: "walk",
        leftGroundHeightWorld: 0,
        rightGroundHeightWorld: 0,
        leftGroundNormalWorld: leftNormal,
        rightGroundNormalWorld: rightNormal,
        authoredIk,
        runtimeOwnershipWeight: 0.5,
      });
    }

    expect(runtime.leftGroundNormalWorld).not.toBe(leftNormal);
    expect(runtime.leftGroundNormalWorld.z).toBeCloseTo(Math.sin(0.35), 6);
    expect(runtime.rightGroundNormalWorld.x).toBeCloseTo(Math.sin(0.25), 6);
    expect(runtime.leftFootLockWeight).toBe(runtime.leftFootLockTarget.weight);
    expect(runtime.leftFootLockWeight).toBeGreaterThan(0);
    expect(runtime.rightFootLockWeight).toBe(runtime.rightFootLockTarget.weight);
    // The blended target weight carries the authored contribution; the pure
    // lock weight used by slope alignment must not.
    expect(runtime.leftFootTarget.weight).toBeCloseTo(0.8 * 0.5 + runtime.leftFootLockWeight * 0.5, 6);

    updateMixamoFootLockRigRuntime(runtime, {
      bones,
      directorSpace,
      deltaS: 1 / 60,
      grounded: true,
      locomotionMode: "walk",
      actionKey: "walk",
      leftGroundHeightWorld: 0,
      rightGroundHeightWorld: 0,
    });
    expect(runtime.leftGroundNormalWorld.x).toBe(0);
    expect(runtime.leftGroundNormalWorld.y).toBe(1);
    expect(runtime.leftGroundNormalWorld.z).toBe(0);
    expect(runtime.rightGroundNormalWorld.y).toBe(1);
  });

  it("releases only an unresolved foot chain", () => {
    const { bones, directorSpace } = createTestRig({ includeRightFoot: false });
    const runtime = createMixamoFootLockRigRuntime();

    for (let index = 0; index < 6; index += 1) {
      updateMixamoFootLockRigRuntime(runtime, {
        bones,
        directorSpace,
        deltaS: 1 / 60,
        grounded: true,
        locomotionMode: "walk",
        actionKey: "walk",
        leftGroundHeightWorld: 0,
        rightGroundHeightWorld: 0,
      });
    }

    expect(runtime.lockState.output.leftFoot.locked).toBe(true);
    expect(runtime.leftFootTarget.weight).toBeGreaterThan(0);
    expect(runtime.lockState.output.rightFoot).toMatchObject({ locked: false, weight: 0 });
    expect(runtime.rightFootTarget.weight).toBe(0);
  });
});

describe("applyMixamoFootSlopeAlignment", () => {
  const TILT_RAD = Math.PI / 9;

  function createSlopeAlignmentRig() {
    const root = new Group();
    const pelvis = new Bone();
    pelvis.position.set(0, 0.5, 0);
    const leftFoot = new Bone();
    leftFoot.position.set(-0.2, -0.4, 0);
    const rightFoot = new Bone();
    rightFoot.position.set(0.2, -0.4, 0);
    pelvis.add(leftFoot, rightFoot);
    root.add(pelvis);
    root.updateMatrixWorld(true);
    const bones: MixamoResolvedBones = { leftFoot, rightFoot };
    return { bones, leftFoot, rightFoot };
  }

  function soleUpWorld(foot: Bone) {
    return new Vector3(0, 1, 0).applyQuaternion(foot.getWorldQuaternion(new Quaternion()));
  }

  it("tilts each fully locked foot onto its own 20 degree ground normal", () => {
    const { bones, leftFoot, rightFoot } = createSlopeAlignmentRig();
    const runtime = createMixamoFootLockRigRuntime();
    runtime.leftGroundNormalWorld.set(0, Math.cos(TILT_RAD), Math.sin(TILT_RAD));
    runtime.rightGroundNormalWorld.set(0, Math.cos(TILT_RAD), -Math.sin(TILT_RAD));
    runtime.leftFootLockWeight = 1;
    runtime.rightFootLockWeight = 1;

    applyMixamoFootSlopeAlignment(runtime, bones, 1);

    const leftSoleUp = soleUpWorld(leftFoot);
    expect(leftSoleUp.x).toBeCloseTo(0, 5);
    expect(leftSoleUp.y).toBeCloseTo(Math.cos(TILT_RAD), 5);
    expect(leftSoleUp.z).toBeCloseTo(Math.sin(TILT_RAD), 5);
    const rightSoleUp = soleUpWorld(rightFoot);
    expect(rightSoleUp.x).toBeCloseTo(0, 5);
    expect(rightSoleUp.y).toBeCloseTo(Math.cos(TILT_RAD), 5);
    expect(rightSoleUp.z).toBeCloseTo(-Math.sin(TILT_RAD), 5);
  });

  it("leaves the foot untouched for zero lock weight, an up normal, zero ownership, and a non-finite normal", () => {
    const { bones, leftFoot } = createSlopeAlignmentRig();
    leftFoot.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 6);
    leftFoot.updateWorldMatrix(false, true);
    const before = leftFoot.quaternion.clone();
    const runtime = createMixamoFootLockRigRuntime();
    runtime.rightFootLockWeight = 0;

    runtime.leftFootLockWeight = 0;
    runtime.leftGroundNormalWorld.set(0, Math.cos(TILT_RAD), Math.sin(TILT_RAD));
    applyMixamoFootSlopeAlignment(runtime, bones, 1);
    expect(leftFoot.quaternion.angleTo(before)).toBeCloseTo(0, 6);

    runtime.leftFootLockWeight = 1;
    runtime.leftGroundNormalWorld.set(0, 1, 0);
    applyMixamoFootSlopeAlignment(runtime, bones, 1);
    expect(leftFoot.quaternion.angleTo(before)).toBeCloseTo(0, 6);

    runtime.leftGroundNormalWorld.set(0, Math.cos(TILT_RAD), Math.sin(TILT_RAD));
    applyMixamoFootSlopeAlignment(runtime, bones, 0);
    expect(leftFoot.quaternion.angleTo(before)).toBeCloseTo(0, 6);

    runtime.leftGroundNormalWorld.set(0, Number.NaN, Math.sin(TILT_RAD));
    applyMixamoFootSlopeAlignment(runtime, bones, 1);
    expect(leftFoot.quaternion.angleTo(before)).toBeCloseTo(0, 6);
  });

  it("clamps a 60 degree ground normal to the 35 degree ankle limit", () => {
    const { bones, leftFoot } = createSlopeAlignmentRig();
    const runtime = createMixamoFootLockRigRuntime();
    const steepRad = Math.PI / 3;
    runtime.leftGroundNormalWorld.set(0, Math.cos(steepRad), Math.sin(steepRad));
    runtime.leftFootLockWeight = 1;

    applyMixamoFootSlopeAlignment(runtime, bones, 1);

    const clampedRad = (35 * Math.PI) / 180;
    const soleUp = soleUpWorld(leftFoot);
    expect(soleUp.x).toBeCloseTo(0, 5);
    expect(soleUp.y).toBeCloseTo(Math.cos(clampedRad), 5);
    expect(soleUp.z).toBeCloseTo(Math.sin(clampedRad), 5);
  });

  it("scales the tilt by ownership weight multiplied with the lock weight", () => {
    const { bones, leftFoot, rightFoot } = createSlopeAlignmentRig();
    const runtime = createMixamoFootLockRigRuntime();
    runtime.leftGroundNormalWorld.set(0, Math.cos(TILT_RAD), Math.sin(TILT_RAD));
    runtime.rightGroundNormalWorld.set(0, Math.cos(TILT_RAD), Math.sin(TILT_RAD));
    runtime.leftFootLockWeight = 1;
    runtime.rightFootLockWeight = 0.6;

    // Identity parents make the local slerp equal a world-space arc fraction.
    applyMixamoFootSlopeAlignment(runtime, bones, 0.5);

    const leftSoleUp = soleUpWorld(leftFoot);
    expect(leftSoleUp.y).toBeCloseTo(Math.cos(TILT_RAD * 0.5), 5);
    expect(leftSoleUp.z).toBeCloseTo(Math.sin(TILT_RAD * 0.5), 5);
    const rightSoleUp = soleUpWorld(rightFoot);
    expect(rightSoleUp.y).toBeCloseTo(Math.cos(TILT_RAD * 0.3), 5);
    expect(rightSoleUp.z).toBeCloseTo(Math.sin(TILT_RAD * 0.3), 5);
  });
});

localAssetIt("keeps prepared X Bot feet inside the calibrated default contact band", async () => {
  const gltf = await loadPackagedGlb("assets/library/mixamo-characters/models/x-bot.glb");
  const prepared = prepareMixamoCharacterInstance(gltf.scene, "x-bot-foot-lock-test", 1.78);
  const leftFootY = prepared.resolvedBones.leftFoot!.getWorldPosition(new Vector3()).y;
  const rightFootY = prepared.resolvedBones.rightFoot!.getWorldPosition(new Vector3()).y;
  const directorSpace = new Group();
  directorSpace.add(prepared.scene);
  const runtime = createMixamoFootLockRigRuntime();
  for (let index = 0; index < 4; index += 1) {
    updateMixamoFootLockRigRuntime(runtime, {
      bones: prepared.resolvedBones,
      directorSpace,
      deltaS: 1 / 60,
      grounded: true,
      locomotionMode: "idle",
      actionKey: "idle",
      leftGroundHeightWorld: 0,
      rightGroundHeightWorld: 0,
    });
  }

  expect(leftFootY).toBeGreaterThan(0.07);
  expect(leftFootY).toBeLessThan(DEFAULT_MIXAMO_FOOT_LOCK_CONFIG.contactHeightM);
  expect(rightFootY).toBeGreaterThan(0.07);
  expect(rightFootY).toBeLessThan(DEFAULT_MIXAMO_FOOT_LOCK_CONFIG.contactHeightM);
  expect(DEFAULT_MIXAMO_FOOT_LOCK_CONFIG.contactHeightM).toBe(0.14);
  expect(DEFAULT_MIXAMO_FOOT_LOCK_CONFIG.releaseHeightM).toBe(0.22);
  expect(runtime.lockState.output.leftFoot.locked).toBe(true);
  expect(runtime.lockState.output.rightFoot.locked).toBe(true);
  expect(runtime.leftFootTarget.target[0]).toBeLessThan(0);
  expect(runtime.rightFootTarget.target[0]).toBeGreaterThan(0);

  const leftBeforeSolve = prepared.resolvedBones.leftFoot!.getWorldPosition(new Vector3());
  const rightBeforeSolve = prepared.resolvedBones.rightFoot!.getWorldPosition(new Vector3());
  applyMixamoCharacterIk(prepared.scene, prepared.resolvedBones, runtime.ik);
  const leftAfterSolve = prepared.resolvedBones.leftFoot!.getWorldPosition(new Vector3());
  const rightAfterSolve = prepared.resolvedBones.rightFoot!.getWorldPosition(new Vector3());
  expect(leftAfterSolve.x).toBeGreaterThan(0);
  expect(rightAfterSolve.x).toBeLessThan(0);
  // The analytic two-bone solve can relax the authored knee plane by a few
  // centimetres, but a handedness error would cross the legs by ~0.16 m.
  expect(leftAfterSolve.distanceTo(leftBeforeSolve)).toBeLessThan(0.06);
  expect(rightAfterSolve.distanceTo(rightBeforeSolve)).toBeLessThan(0.06);
});

localAssetIt(
  "keeps real X Bot gait foot locks finite, bounded, independent, and anatomically assigned at 60 fps",
  async () => {
    const [characterGltf, ...motionGltfs] = await Promise.all([
      loadPackagedGlb("assets/library/mixamo-characters/models/x-bot.glb"),
      ...PACKAGED_GAIT_FILES.map((fileName) => loadPackagedGlb(`assets/library/mixamo-animations/clips/${fileName}`)),
    ]);
    let totalLeftLocks = 0;
    let totalRightLocks = 0;
    let totalLeftReleases = 0;
    let totalRightReleases = 0;

    for (const [motionIndex, motionFileName] of PACKAGED_GAIT_FILES.entries()) {
      const prepared = prepareMixamoCharacterInstance(characterGltf.scene, `x-bot-${motionFileName}`, 1.78);
      const sourceMotion = motionGltfs[motionIndex]!;
      const clip = retargetMixamoAnimationClip({
        clip: sourceMotion.animations[0]!,
        sourceRoot: sourceMotion.scene,
        targetRoot: prepared.scene,
        targetRestPose: prepared.restPose,
        rootMotion: "in-place",
        name: `foot-lock-${motionFileName}`,
      });
      const mixer = new AnimationMixer(prepared.scene);
      const action = configureDirectorCharacterMotionAction(mixer.clipAction(clip));
      const directorSpace = new Group();
      directorSpace.add(prepared.scene);
      const runtime = createMixamoFootLockRigRuntime();
      const leftBefore = new Vector3();
      const rightBefore = new Vector3();
      const leftAfter = new Vector3();
      const rightAfter = new Vector3();
      const leftGoal = new Vector3();
      const rightGoal = new Vector3();
      let previousLeftLocked = false;
      let previousRightLocked = false;
      let leftLocks = 0;
      let rightLocks = 0;
      let leftReleases = 0;
      let rightReleases = 0;
      const sampleCount = Math.max(120, Math.ceil(clip.duration * 60 * 2));
      const worldVelocity = getGaitWorldVelocity(motionFileName);

      for (let frame = 0; frame < sampleCount; frame += 1) {
        const elapsedS = frame / 60;
        const timeS = elapsedS % clip.duration;
        directorSpace.position.set(
          worldVelocity[0] * elapsedS,
          worldVelocity[1] * elapsedS,
          worldVelocity[2] * elapsedS,
        );
        directorSpace.updateMatrixWorld(true);
        applyDirectorCharacterWeightedMotionFrame({
          scene: prepared.scene,
          restPose: prepared.restPose,
          deformBones: prepared.deformBones,
          resolvedBones: prepared.resolvedBones,
          controls: {},
          ik: undefined,
          actions: [action],
          layers: [{ action, durationS: clip.duration, timeS, weight: 1 }],
          mixer,
        });
        prepared.resolvedBones.leftFoot!.getWorldPosition(leftBefore);
        prepared.resolvedBones.rightFoot!.getWorldPosition(rightBefore);

        updateMixamoFootLockRigRuntime(runtime, {
          bones: prepared.resolvedBones,
          directorSpace,
          deltaS: 1 / 60,
          grounded: true,
          locomotionMode: motionFileName.startsWith("run") ? "run" : "walk",
          actionKey: motionFileName,
          leftGroundHeightWorld: 0,
          rightGroundHeightWorld: 0,
        });

        const leftOutput = runtime.lockState.output.leftFoot;
        const rightOutput = runtime.lockState.output.rightFoot;
        leftGoal.fromArray(leftOutput.targetWorld);
        rightGoal.fromArray(rightOutput.targetWorld);
        expectFiniteVector(leftBefore);
        expectFiniteVector(rightBefore);
        expectFiniteTuple(leftOutput.targetWorld);
        expectFiniteTuple(rightOutput.targetWorld);
        expect(leftOutput.weight).toBeGreaterThanOrEqual(0);
        expect(leftOutput.weight).toBeLessThanOrEqual(1);
        expect(rightOutput.weight).toBeGreaterThanOrEqual(0);
        expect(rightOutput.weight).toBeLessThanOrEqual(1);
        expect(leftGoal.distanceTo(leftBefore)).toBeLessThanOrEqual(
          DEFAULT_MIXAMO_FOOT_LOCK_CONFIG.maxCorrectionM + 1e-6,
        );
        expect(rightGoal.distanceTo(rightBefore)).toBeLessThanOrEqual(
          DEFAULT_MIXAMO_FOOT_LOCK_CONFIG.maxCorrectionM + 1e-6,
        );

        if (!previousLeftLocked && leftOutput.locked) leftLocks += 1;
        if (!previousRightLocked && rightOutput.locked) rightLocks += 1;
        if (previousLeftLocked && !leftOutput.locked) leftReleases += 1;
        if (previousRightLocked && !rightOutput.locked) rightReleases += 1;
        previousLeftLocked = leftOutput.locked;
        previousRightLocked = rightOutput.locked;

        applyMixamoCharacterIk(prepared.scene, prepared.resolvedBones, runtime.ik);
        prepared.resolvedBones.leftFoot!.getWorldPosition(leftAfter);
        prepared.resolvedBones.rightFoot!.getWorldPosition(rightAfter);
        expectFiniteVector(leftAfter);
        expectFiniteVector(rightAfter);
        expect(leftAfter.distanceTo(leftBefore)).toBeLessThanOrEqual(
          DEFAULT_MIXAMO_FOOT_LOCK_CONFIG.maxCorrectionM + 0.06,
        );
        expect(rightAfter.distanceTo(rightBefore)).toBeLessThanOrEqual(
          DEFAULT_MIXAMO_FOOT_LOCK_CONFIG.maxCorrectionM + 0.06,
        );
        // Unreachable targets and a changing pole plane do not guarantee that
        // an analytic two-bone iteration monotonically reduces endpoint error.
        // Anatomical assignment is the invariant: the solved pair must remain
        // collectively closer to its own pre-solve feet than to swapped feet.
        const ownAssignmentDistance = leftAfter.distanceTo(leftBefore) + rightAfter.distanceTo(rightBefore);
        const swappedAssignmentDistance = leftAfter.distanceTo(rightBefore) + rightAfter.distanceTo(leftBefore);
        expect(ownAssignmentDistance).toBeLessThanOrEqual(swappedAssignmentDistance + 0.02);
      }

      expect(leftLocks + rightLocks, `${motionFileName}: neither foot ever locked`).toBeGreaterThan(0);
      expect(leftReleases + rightReleases, `${motionFileName}: neither foot ever released`).toBeGreaterThan(0);
      totalLeftLocks += leftLocks;
      totalRightLocks += rightLocks;
      totalLeftReleases += leftReleases;
      totalRightReleases += rightReleases;
      mixer.stopAllAction();
    }

    // Both effectors must have exercised their own state machine across the
    // real forward/back/strafe matrix; one global planted-foot flag would fail.
    expect(totalLeftLocks).toBeGreaterThan(0);
    expect(totalRightLocks).toBeGreaterThan(0);
    expect(totalLeftReleases).toBeGreaterThan(0);
    expect(totalRightReleases).toBeGreaterThan(0);
  },
  30_000,
);

localAssetIt("keeps real jump and fly foot-lock weights at zero on every 60 fps sample", async () => {
  const [characterGltf, jumpGltf] = await Promise.all([
    loadPackagedGlb("assets/library/mixamo-characters/models/x-bot.glb"),
    loadPackagedGlb("assets/library/mixamo-animations/clips/jump.glb"),
  ]);
  const prepared = prepareMixamoCharacterInstance(characterGltf.scene, "x-bot-jump-foot-lock", 1.78);
  const clip = retargetMixamoAnimationClip({
    clip: jumpGltf.animations[0]!,
    sourceRoot: jumpGltf.scene,
    targetRoot: prepared.scene,
    targetRestPose: prepared.restPose,
    rootMotion: "in-place",
    name: "foot-lock-jump",
  });
  const mixer = new AnimationMixer(prepared.scene);
  const action = configureDirectorCharacterMotionAction(mixer.clipAction(clip));
  const directorSpace = new Group();
  directorSpace.add(prepared.scene);
  const runtime = createMixamoFootLockRigRuntime();
  const sampleCount = Math.max(1, Math.ceil(clip.duration * 60));

  for (const mode of ["jump", "fly"] as const) {
    for (let frame = 0; frame < sampleCount; frame += 1) {
      applyDirectorCharacterWeightedMotionFrame({
        scene: prepared.scene,
        restPose: prepared.restPose,
        deformBones: prepared.deformBones,
        resolvedBones: prepared.resolvedBones,
        controls: {},
        ik: undefined,
        actions: [action],
        layers: [{ action, durationS: clip.duration, timeS: Math.min(clip.duration, frame / 60), weight: 1 }],
        mixer,
      });
      updateMixamoFootLockRigRuntime(runtime, {
        bones: prepared.resolvedBones,
        directorSpace,
        deltaS: 1 / 60,
        grounded: true,
        locomotionMode: mode,
        actionKey: mode,
        leftGroundHeightWorld: 0,
        rightGroundHeightWorld: 0,
      });
      expect(runtime.lockState.output.leftFoot).toMatchObject({ locked: false, weight: 0 });
      expect(runtime.lockState.output.rightFoot).toMatchObject({ locked: false, weight: 0 });
      expect(runtime.leftFootTarget.weight).toBe(0);
      expect(runtime.rightFootTarget.weight).toBe(0);
      expectFiniteTuple(runtime.lockState.output.leftFoot.targetWorld);
      expectFiniteTuple(runtime.lockState.output.rightFoot.targetWorld);
    }
  }
});
