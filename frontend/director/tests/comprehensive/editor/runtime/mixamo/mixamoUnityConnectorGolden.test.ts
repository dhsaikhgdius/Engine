import { describe, expect, it } from "vitest";
import { Euler, Quaternion } from "three";
import {
  getMixamoPoseBoneRotations,
  MIXAMO_BONE_ROLE_ALIASES,
} from "../../../../../src/comprehensive/editor/runtime/mixamo/mixamoCharacterRig";

/**
 * Golden pinning tests for the Unity connector's C# pose port
 * (integrations/unity/com.director.bridge/Editor/DirectorPoseMath.cs).
 *
 * Every hard-coded number and alias here is asserted byte-for-byte (within
 * 1e-9) by DirectorPoseMathTests.cs, so this TypeScript reference and the C#
 * port cannot drift apart without a test failing on at least one side. Unity
 * itself is never required in CI: this side pins the reference output, the
 * EditMode side pins the port.
 */

/** The pose controls exercised by the golden table (clamping included). */
const GOLDEN_CONTROLS: Record<string, number> = {
  "body.pitch": 10,
  "body.yaw": -20,
  "torso.roll": 15,
  "head.pitch": -25,
  "leftShoulder.spread": 40,
  "leftShoulder.twist": 10,
  "leftShoulder.pitch": -130,
  "rightShoulder.spread": 25,
  "rightShoulder.pitch": 45,
  "leftElbow.bend": 160,
  "rightElbow.bend": 30,
  "leftHand.roll": 15,
  "leftHip.pitch": -30,
  "leftHip.spread": 12,
  "rightHip.twist": -18,
  "leftKnee.bend": 60,
  "rightKnee.bend": 45,
  "leftFoot.pitch": -20,
  "rightFoot.roll": 10,
};

function expectVectorClose(actual: readonly number[], expected: readonly number[]) {
  expect(actual.length).toBe(expected.length);
  actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index]!, 9));
}

describe("Mixamo pose golden values for the Unity connector port", () => {
  it("pins the bone role alias table the C# port hard-codes", () => {
    expect(MIXAMO_BONE_ROLE_ALIASES).toEqual({
      body: ["Hips"],
      torso: ["Spine2", "Spine1", "Spine"],
      head: ["Head"],
      leftShoulder: ["LeftArm", "LeftShoulder"],
      rightShoulder: ["RightArm", "RightShoulder"],
      leftElbow: ["LeftForeArm", "LeftLowerArm"],
      rightElbow: ["RightForeArm", "RightLowerArm"],
      leftHand: ["LeftHand"],
      rightHand: ["RightHand"],
      leftHip: ["LeftUpLeg", "LeftUpperLeg"],
      rightHip: ["RightUpLeg", "RightUpperLeg"],
      leftKnee: ["LeftLeg", "LeftLowerLeg"],
      rightKnee: ["RightLeg", "RightLowerLeg"],
      leftFoot: ["LeftFoot"],
      rightFoot: ["RightFoot"],
    });
  });

  it("pins the static pose bone rotation golden table (default body)", () => {
    const rotations = getMixamoPoseBoneRotations(GOLDEN_CONTROLS, undefined, false);
    expectVectorClose(rotations.body, [0.174532925199, -0.349065850399, 0]);
    expectVectorClose(rotations.torso, [0, 0, 0.261799387799]);
    expectVectorClose(rotations.head, [-0.436332312999, 0, 0]);
    // 70° neutral stance + 40° spread; pitch clamps -130° to -120°.
    expectVectorClose(rotations.leftShoulder, [1.919862177194, 0.174532925199, -2.094395102393]);
    expectVectorClose(rotations.rightShoulder, [0.785398163397, 0, -0.785398163397]);
    // Elbow bend clamps 160° to 150°.
    expectVectorClose(rotations.leftElbow, [0, 0, 2.617993877991]);
    expectVectorClose(rotations.rightElbow, [0, 0, -0.523598775598]);
    expectVectorClose(rotations.leftHand, [0, 0, 0.261799387799]);
    expectVectorClose(rotations.rightHand, [0, 0, 0]);
    expectVectorClose(rotations.leftHip, [-0.523598775598, 0, -0.209439510239]);
    expectVectorClose(rotations.rightHip, [0, -0.314159265359, 0]);
    expectVectorClose(rotations.leftKnee, [-1.047197551197, 0, 0]);
    expectVectorClose(rotations.rightKnee, [-0.785398163397, 0, 0]);
    expectVectorClose(rotations.leftFoot, [-0.349065850399, 0, 0]);
    expectVectorClose(rotations.rightFoot, [0, 0, 0.174532925199]);
  });

  it("pins the animated shoulder rotations (neutral stance skipped)", () => {
    const rotations = getMixamoPoseBoneRotations(GOLDEN_CONTROLS, undefined, true);
    expectVectorClose(rotations.leftShoulder, [0.698131700798, 0.174532925199, -2.094395102393]);
    expectVectorClose(rotations.rightShoulder, [-0.436332312999, 0, -0.785398163397]);
  });

  it("pins the child body-scale clamping golden values", () => {
    const rotations = getMixamoPoseBoneRotations(GOLDEN_CONTROLS, "child", false);
    // Shoulder pitch clamps to ±96° and elbow bend to 120° at 72/90 scale.
    expectVectorClose(rotations.leftShoulder, [1.919862177194, 0.174532925199, -1.675516081915]);
    expectVectorClose(rotations.leftElbow, [0, 0, 2.094395102393]);
  });

  it("pins the glTF-to-Unity bone-local quaternion conjugation goldens", () => {
    // The C# port converts glTF/three.js bone-local rotations to Unity space
    // with the X-axis-inversion conjugation (x, y, z, w) -> (x, -y, -z, w).
    const offset = new Quaternion().setFromEuler(new Euler(1.919862177194, 0.174532925199, -2.094395102393, "XYZ"));
    expectVectorClose(
      [offset.x, offset.y, offset.z, offset.w],
      [0.36472443581, 0.731702214251, -0.459144648138, 0.347525751089],
    );
    const rest = new Quaternion().setFromEuler(new Euler(0.35, -0.2, 1.1, "XYZ"));
    expectVectorClose(
      [rest.x, rest.y, rest.z, rest.w],
      [0.096305260291, -0.174359963413, 0.497314190361, 0.844394751324],
    );
    const composed = rest.clone().multiply(offset);
    expectVectorClose(
      [composed.x, composed.y, composed.z, composed.w],
      [0.057610506979, 0.782851614351, -0.080809731971, 0.614242758697],
    );
    // The conjugation is multiplicative: converting the composed rotation
    // equals composing the converted factors, so the C# port may convert
    // after composition.
    const convertedComposed = new Quaternion(rest.x, -rest.y, -rest.z, rest.w).multiply(
      new Quaternion(offset.x, -offset.y, -offset.z, offset.w),
    );
    expectVectorClose(
      [convertedComposed.x, convertedComposed.y, convertedComposed.z, convertedComposed.w],
      [composed.x, -composed.y, -composed.z, composed.w],
    );
  });
});
