import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Bone, Group, Quaternion, Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { describe, expect, it, vi } from "vitest";
import { localAssetIt } from "../../../../../../../packages/protocol/tests/localAssetTest";
import { configureDirectorGLTFLoader } from "../../../../../src/comprehensive/editor/runtime/gltfLoader";
import { prepareMixamoCharacterInstance } from "../../../../../src/comprehensive/editor/runtime/mixamo/mixamoCharacterPrepare";
import {
  applyMixamoCharacterIk,
  type MixamoResolvedBones,
} from "../../../../../src/comprehensive/editor/runtime/mixamo/mixamoCharacterRig";
import {
  applyMixamoCrouchPose,
  createMixamoCrouchRuntime,
  getMixamoCrouchWeight,
  isMixamoCrouchEligible,
  isMixamoCrouchSettled,
  MIXAMO_CROUCH_BLEND_S,
  MIXAMO_CROUCH_HIP_DROP_LEG_FRACTION,
  updateMixamoCrouchWeight,
} from "../../../../../src/comprehensive/editor/runtime/mixamo/mixamoCrouch";
import {
  createMixamoFootLockRigRuntime,
  updateMixamoFootLockRigRuntime,
} from "../../../../../src/comprehensive/editor/runtime/mixamo/mixamoFootLockRig";

const LEG_LENGTH_M = 0.75;
const FULL_DROP_M = LEG_LENGTH_M * MIXAMO_CROUCH_HIP_DROP_LEG_FRACTION;

/**
 * Standing Director-handed test skeleton: hips at 0.85 m, straight vertical
 * legs (thigh 0.4 m, shin 0.35 m, soles at 0.05 m), spine and head above.
 */
function createCrouchTestRig({ includeLegs = true, directorTransform = false } = {}) {
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
  spine.position.set(0, 0.15, 0);
  const head = new Bone();
  head.name = "Head";
  head.position.set(0, 0.45, 0);
  spine.add(head);
  hips.add(spine);

  const bones: MixamoResolvedBones = { body: hips, torso: spine, head };

  if (includeLegs) {
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
  }

  directorSpace.updateMatrixWorld(true);
  return { directorSpace, root, bones };
}

function settleCrouchWeight(runtime: ReturnType<typeof createMixamoCrouchRuntime>, active: boolean) {
  for (let index = 0; index < 12; index += 1) updateMixamoCrouchWeight(runtime, active, MIXAMO_CROUCH_BLEND_S / 4);
}

function worldPosition(object: Bone) {
  return object.getWorldPosition(new Vector3());
}

async function loadPackagedGlb(relativePath: string) {
  const binary = readFileSync(resolve(process.cwd(), relativePath));
  const data = new ArrayBuffer(binary.byteLength);
  new Uint8Array(data).set(binary);
  vi.stubGlobal("createImageBitmap", async () => ({ close: vi.fn() }));
  return configureDirectorGLTFLoader(new GLTFLoader()).parseAsync(data, "");
}

describe("Mixamo crouch weight blend", () => {
  it("ramps a smoothstep weight in and out over the symmetric blend duration", () => {
    const runtime = createMixamoCrouchRuntime();
    expect(getMixamoCrouchWeight(runtime)).toBe(0);
    expect(isMixamoCrouchSettled(runtime)).toBe(true);
    expect(updateMixamoCrouchWeight(runtime, false, 1 / 60)).toBe(0);
    expect(isMixamoCrouchSettled(runtime)).toBe(true);

    expect(updateMixamoCrouchWeight(runtime, true, MIXAMO_CROUCH_BLEND_S / 2)).toBeCloseTo(0.5, 6);
    expect(isMixamoCrouchSettled(runtime)).toBe(false);
    expect(updateMixamoCrouchWeight(runtime, true, MIXAMO_CROUCH_BLEND_S / 2)).toBe(1);
    expect(isMixamoCrouchSettled(runtime)).toBe(true);
    // Weight saturates instead of overshooting.
    expect(updateMixamoCrouchWeight(runtime, true, 1)).toBe(1);

    expect(updateMixamoCrouchWeight(runtime, false, MIXAMO_CROUCH_BLEND_S / 2)).toBeCloseTo(0.5, 6);
    expect(updateMixamoCrouchWeight(runtime, false, MIXAMO_CROUCH_BLEND_S / 2)).toBe(0);
    expect(isMixamoCrouchSettled(runtime)).toBe(true);

    // Malformed frame deltas cannot corrupt the clock.
    expect(updateMixamoCrouchWeight(runtime, true, Number.NaN)).toBe(0);
    expect(updateMixamoCrouchWeight(runtime, true, -1)).toBe(0);
  });

  it("only activates while crouching and grounded in plain locomotion modes", () => {
    expect(isMixamoCrouchEligible(null)).toBe(false);
    expect(isMixamoCrouchEligible(undefined)).toBe(false);
    for (const mode of ["idle", "walk", "run"] as const) {
      expect(isMixamoCrouchEligible({ crouching: true, grounded: true, mode })).toBe(true);
    }
    for (const mode of ["jump", "fly", "emote"] as const) {
      expect(isMixamoCrouchEligible({ crouching: true, grounded: true, mode })).toBe(false);
    }
    expect(isMixamoCrouchEligible({ crouching: true, grounded: false, mode: "walk" })).toBe(false);
    expect(isMixamoCrouchEligible({ crouching: false, grounded: true, mode: "walk" })).toBe(false);
    expect(isMixamoCrouchEligible({ grounded: true, mode: "walk" })).toBe(false);
  });
});

describe("applyMixamoCrouchPose", () => {
  it("drops the hips by the leg fraction while both feet and ankles stay exactly planted", () => {
    const { directorSpace, root, bones } = createCrouchTestRig();
    const runtime = createMixamoCrouchRuntime();
    settleCrouchWeight(runtime, true);

    const hipsBefore = worldPosition(bones.body!);
    const headBefore = worldPosition(bones.head!);
    const leftFootBefore = worldPosition(bones.leftFoot!);
    const rightFootBefore = worldPosition(bones.rightFoot!);
    const leftAnkleBefore = bones.leftFoot!.getWorldQuaternion(new Quaternion());
    const kneeZBefore = worldPosition(bones.leftKnee!).z;

    expect(applyMixamoCrouchPose(runtime, { root, directorSpace, bones })).toBe(true);

    const hipsAfter = worldPosition(bones.body!);
    expect(hipsAfter.y).toBeCloseTo(hipsBefore.y - FULL_DROP_M, 5);
    expect(hipsAfter.x).toBeCloseTo(hipsBefore.x, 5);
    expect(hipsAfter.z).toBeCloseTo(hipsBefore.z, 5);

    // Feet return exactly onto their animated positions; no sink, no hover.
    expect(worldPosition(bones.leftFoot!).distanceTo(leftFootBefore)).toBeLessThan(0.001);
    expect(worldPosition(bones.rightFoot!).distanceTo(rightFootBefore)).toBeLessThan(0.001);
    // Ankle orientation survives the leg re-solve.
    expect(bones.leftFoot!.getWorldQuaternion(new Quaternion()).angleTo(leftAnkleBefore)).toBeLessThan(0.001);
    // The knees absorb the drop by bending forward (+Z is Director forward).
    expect(worldPosition(bones.leftKnee!).z).toBeGreaterThan(kneeZBefore + 0.01);

    // The head follows the crouch down and slightly forward for the camera.
    const headAfter = worldPosition(bones.head!);
    expect(headAfter.y).toBeLessThan(headBefore.y - FULL_DROP_M * 0.9);
    expect(headAfter.z).toBeGreaterThan(headBefore.z + 0.01);
  });

  it("scales the hip drop with the blended weight at the transition midpoint", () => {
    const { directorSpace, root, bones } = createCrouchTestRig();
    const runtime = createMixamoCrouchRuntime();
    updateMixamoCrouchWeight(runtime, true, MIXAMO_CROUCH_BLEND_S / 2);

    const hipsBefore = worldPosition(bones.body!);
    const leftFootBefore = worldPosition(bones.leftFoot!);
    expect(applyMixamoCrouchPose(runtime, { root, directorSpace, bones })).toBe(true);

    expect(worldPosition(bones.body!).y).toBeCloseTo(hipsBefore.y - FULL_DROP_M * 0.5, 5);
    expect(worldPosition(bones.leftFoot!).distanceTo(leftFootBefore)).toBeLessThan(0.001);
  });

  it("keeps the drop and planted feet correct inside a translated and rotated director space", () => {
    const { directorSpace, root, bones } = createCrouchTestRig({ directorTransform: true });
    const runtime = createMixamoCrouchRuntime();
    settleCrouchWeight(runtime, true);

    const hipsBefore = worldPosition(bones.body!);
    const leftFootBefore = worldPosition(bones.leftFoot!);
    const rightFootBefore = worldPosition(bones.rightFoot!);

    expect(applyMixamoCrouchPose(runtime, { root, directorSpace, bones })).toBe(true);

    const hipsAfter = worldPosition(bones.body!);
    expect(hipsAfter.y).toBeCloseTo(hipsBefore.y - FULL_DROP_M, 5);
    expect(hipsAfter.x).toBeCloseTo(hipsBefore.x, 5);
    expect(hipsAfter.z).toBeCloseTo(hipsBefore.z, 5);
    expect(worldPosition(bones.leftFoot!).distanceTo(leftFootBefore)).toBeLessThan(0.001);
    expect(worldPosition(bones.rightFoot!).distanceTo(rightFootBefore)).toBeLessThan(0.001);
  });

  it("takes the zero-cost fast path at zero weight and refuses rigs without leg chains", () => {
    const { directorSpace, root, bones } = createCrouchTestRig();
    const runtime = createMixamoCrouchRuntime();

    const hipsPosition = bones.body!.position.clone();
    const spineQuaternion = bones.torso!.quaternion.clone();
    expect(applyMixamoCrouchPose(runtime, { root, directorSpace, bones })).toBe(false);
    expect(bones.body!.position.equals(hipsPosition)).toBe(true);
    expect(bones.torso!.quaternion.equals(spineQuaternion)).toBe(true);

    const legless = createCrouchTestRig({ includeLegs: false });
    const leglessRuntime = createMixamoCrouchRuntime();
    settleCrouchWeight(leglessRuntime, true);
    const leglessHips = legless.bones.body!.position.clone();
    expect(
      applyMixamoCrouchPose(leglessRuntime, {
        root: legless.root,
        directorSpace: legless.directorSpace,
        bones: legless.bones,
      }),
    ).toBe(false);
    expect(legless.bones.body!.position.equals(leglessHips)).toBe(true);
  });

  it("does not fight the world-space foot lock while a crouch blends in and out", () => {
    const { directorSpace, root, bones } = createCrouchTestRig();
    const crouch = createMixamoCrouchRuntime();
    const footLock = createMixamoFootLockRigRuntime();
    const initialLocal = new Map(
      [
        bones.body!,
        bones.torso!,
        bones.leftHip!,
        bones.leftKnee!,
        bones.leftFoot!,
        bones.rightHip!,
        bones.rightKnee!,
        bones.rightFoot!,
      ].map((bone) => [bone, { position: bone.position.clone(), quaternion: bone.quaternion.clone() }]),
    );
    const groundY = worldPosition(bones.leftFoot!).y;
    let lockedFrames = 0;

    for (let frame = 0; frame < 90; frame += 1) {
      // Deterministic stand-in for per-frame clip sampling.
      initialLocal.forEach((rest, bone) => {
        bone.position.copy(rest.position);
        bone.quaternion.copy(rest.quaternion);
      });
      root.updateMatrixWorld(true);

      // Hold crouch for a second, then release while the lock is engaged.
      const crouchHeld = frame < 60;
      updateMixamoCrouchWeight(crouch, crouchHeld, 1 / 60);
      applyMixamoCrouchPose(crouch, { root, directorSpace, bones });

      const footLockIk = updateMixamoFootLockRigRuntime(footLock, {
        bones,
        directorSpace,
        deltaS: 1 / 60,
        grounded: true,
        locomotionMode: "idle",
        actionKey: "idle",
        leftGroundHeightWorld: groundY,
        rightGroundHeightWorld: groundY,
      });
      applyMixamoCharacterIk(root, bones, footLockIk);

      const leftFootY = worldPosition(bones.leftFoot!).y;
      const rightFootY = worldPosition(bones.rightFoot!).y;
      expect(Number.isFinite(leftFootY)).toBe(true);
      expect(Number.isFinite(rightFootY)).toBe(true);
      // Crouching never pushes a sole below its ground or lifts it away.
      expect(leftFootY).toBeGreaterThan(groundY - 0.005);
      expect(leftFootY).toBeLessThan(groundY + 0.02);
      expect(rightFootY).toBeGreaterThan(groundY - 0.005);
      expect(rightFootY).toBeLessThan(groundY + 0.02);
      if (footLock.lockState.output.leftFoot.locked) lockedFrames += 1;
    }

    // The lock engaged early and was never released by the crouch transitions.
    expect(lockedFrames).toBeGreaterThan(80);
    expect(footLock.lockState.output.leftFoot.locked).toBe(true);
    expect(footLock.lockState.output.rightFoot.locked).toBe(true);
  });
});

localAssetIt("crouches a prepared X Bot without moving its feet or crossing its mirrored legs", async () => {
  const gltf = await loadPackagedGlb("assets/library/mixamo-characters/models/x-bot.glb");
  const prepared = prepareMixamoCharacterInstance(gltf.scene, "x-bot-crouch-test", 1.78);
  const directorSpace = new Group();
  directorSpace.add(prepared.scene);
  directorSpace.updateMatrixWorld(true);
  const bones = prepared.resolvedBones;
  const runtime = createMixamoCrouchRuntime();
  settleCrouchWeight(runtime, true);

  const hipsBefore = worldPosition(bones.body!);
  const headBefore = worldPosition(bones.head!);
  const leftFootBefore = worldPosition(bones.leftFoot!);
  const rightFootBefore = worldPosition(bones.rightFoot!);
  const legLength =
    worldPosition(bones.leftHip!).distanceTo(worldPosition(bones.leftKnee!)) +
    worldPosition(bones.leftKnee!).distanceTo(worldPosition(bones.leftFoot!));
  const expectedDrop = legLength * MIXAMO_CROUCH_HIP_DROP_LEG_FRACTION;

  expect(applyMixamoCrouchPose(runtime, { root: prepared.scene, directorSpace, bones })).toBe(true);

  const hipsAfter = worldPosition(bones.body!);
  expect(hipsBefore.y - hipsAfter.y).toBeGreaterThan(expectedDrop * 0.9);
  expect(hipsBefore.y - hipsAfter.y).toBeLessThan(expectedDrop * 1.1);

  const leftFootAfter = worldPosition(bones.leftFoot!);
  const rightFootAfter = worldPosition(bones.rightFoot!);
  expect(leftFootAfter.distanceTo(leftFootBefore)).toBeLessThan(0.02);
  expect(rightFootAfter.distanceTo(rightFootBefore)).toBeLessThan(0.02);
  // X Bot authors its left leg on +X; a handedness bug would cross the feet.
  expect(Math.sign(leftFootAfter.x)).toBe(Math.sign(leftFootBefore.x));
  expect(Math.sign(rightFootAfter.x)).toBe(Math.sign(rightFootBefore.x));

  const headAfter = worldPosition(bones.head!);
  expect(headBefore.y - headAfter.y).toBeGreaterThan(expectedDrop * 0.8);
});
