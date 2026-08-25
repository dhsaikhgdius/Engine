import { describe, expect, it } from "vitest";
import { Euler, Matrix4, Quaternion, Vector3 } from "three";
import {
  directorDirectionToEngine,
  directorPointToEngine,
  directorTransformToEngine,
  engineCameraForward,
  engineTransformToDirector,
} from "../src/directorDccEngineSpace";
import { directorCameraLookQuaternion } from "@director/dcc-interchange";
import {
  evaluateDirectorTimingCurve,
  evaluateTrajectoryTransform,
  evaluateTransformAnimation,
  getDirectorCameraSensorGate,
  getVerticalFovFromFocalLength,
  type DirectorEntityAnimation,
  type DirectorTransform,
} from "@director/project-schema";

/**
 * Golden pinning tests for the Unity connector's C# math ports.
 *
 * Every hard-coded number in this file is asserted byte-for-byte (within
 * 1e-9) by the Unity EditMode tests in
 * integrations/unity/com.director.bridge/Tests/Editor/, so the TypeScript
 * reference implementations and the C# ports cannot drift apart without a
 * test failing on at least one side. Unity itself is never required in CI:
 * this side pins the reference output, the EditMode side pins the port.
 */

function expectVectorClose(actual: readonly number[], expected: readonly number[], precision = 9) {
  expect(actual.length).toBe(expected.length);
  actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index]!, precision));
}

/**
 * The C# DirectorSpace.DirectorMatrixToUnity conjugation: element
 * (row, column) is negated exactly when one of row/column is the Z axis.
 */
function directorMatrixToUnity(columnMajor: readonly number[]) {
  const converted = new Array<number>(16);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      const sign = (row === 2 ? -1 : 1) * (column === 2 ? -1 : 1);
      converted[column * 4 + row] = sign * columnMajor[column * 4 + row]!;
    }
  }
  return converted;
}

describe("Director Unity connector golden values", () => {
  it("pins the Unity linear map for points and directions", () => {
    expectVectorClose(directorPointToEngine("unity", [1, 2, 3]), [1, 2, -3]);
    expectVectorClose(directorDirectionToEngine("unity", [0, 0, -1]), [0, 0, 1]);
    expectVectorClose(directorDirectionToEngine("unity", [0, 1, 0]), [0, 1, 0]);
  });

  it("keeps mirrored negative-scale transforms representable in Unity space", () => {
    const mirrored: DirectorTransform = {
      position: [1, 2, 3],
      rotation: [0, Math.PI / 4, 0],
      scale: [-1, 1, 2],
    };
    const unity = directorTransformToEngine("unity", mirrored);
    expect(Math.sign(unity.scale[0] * unity.scale[1] * unity.scale[2])).toBe(-1);
    const roundTripped = engineTransformToDirector("unity", unity);
    expectVectorClose(roundTripped.position, mirrored.position, 8);
    expect(Math.sign(roundTripped.scale[0] * roundTripped.scale[1] * roundTripped.scale[2])).toBe(-1);
  });

  it("carries the Director camera forward ray onto Unity +Z", () => {
    // Identity Director rotation looks down -Z; the Unity camera looks down +Z.
    const identity = directorTransformToEngine("unity", {
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    });
    expectVectorClose(engineCameraForward("unity", identity), [0, 0, 1], 8);

    // A Director camera yawed 90° left looks along -X in both bases (the
    // basis change keeps X and Y).
    const yawedLeft = directorTransformToEngine("unity", {
      position: [0, 1.7, 4],
      rotation: [0, Math.PI / 2, 0],
      scale: [1, 1, 1],
    });
    expectVectorClose(engineCameraForward("unity", yawedLeft), [-1, 0, 0], 8);
  });

  it("pins the bind-matrix conjugation golden table and its involution", () => {
    const source = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
    const expected = [1, 2, -3, 4, 5, 6, -7, 8, -9, -10, 11, -12, 13, 14, -15, 16];
    const converted = directorMatrixToUnity(source);
    expectVectorClose(converted, expected);
    expectVectorClose(directorMatrixToUnity(converted), source);
  });

  it("keeps full-matrix conjugation consistent with the TRS transform conversion", () => {
    const transform: DirectorTransform = {
      position: [2.5, 1.25, -6],
      rotation: [0.3, -1.1, 2.4],
      scale: [1.5, 0.75, 2],
    };
    const directorMatrix = new Matrix4().compose(
      new Vector3(...transform.position),
      new Quaternion().setFromEuler(new Euler(...transform.rotation, "XYZ")),
      new Vector3(...transform.scale),
    );
    const conjugated = directorMatrixToUnity(directorMatrix.toArray());

    const unity = directorTransformToEngine("unity", transform);
    const unityMatrix = new Matrix4()
      .compose(new Vector3(...unity.location), new Quaternion(...unity.rotationQuaternion), new Vector3(...unity.scale))
      .toArray();
    expectVectorClose(conjugated, unityMatrix, 8);
  });

  it("pins the physical sensor gates the C# port hard-codes", () => {
    expect(getDirectorCameraSensorGate("super16")).toMatchObject({ width: 12.52, height: 7.41 });
    expect(getDirectorCameraSensorGate("super35")).toMatchObject({ width: 24.89, height: 18.66 });
    expect(getDirectorCameraSensorGate("fullFrame")).toMatchObject({ width: 36, height: 24 });
    expect(getDirectorCameraSensorGate("imax65")).toMatchObject({ width: 52.63, height: 23.01 });
  });

  it("pins the vertical fov formula golden value", () => {
    expect(getVerticalFovFromFocalLength(35, "16:9", "fullFrame")).toBeCloseTo(32.268802171116, 6);
  });

  it("pins the camera look-quaternion golden table", () => {
    expectVectorClose(
      directorCameraLookQuaternion({
        transform: { position: [2, 1.5, 3], rotation: [0, 0, 0], scale: [1, 1, 1] },
        target: [-1, 0.5, -2],
      }),
      [-0.081743364218, 0.265971605706, 0.022641601129, 0.960241888933],
    );
    // Looking straight down flips world up to +Z.
    expectVectorClose(
      directorCameraLookQuaternion({
        transform: { position: [0, 5, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        target: [0, 0, 0],
      }),
      [0, 0.707106781187, 0.707106781187, 0],
    );
    // Coincident position and target falls back to the Euler rotation.
    expectVectorClose(
      directorCameraLookQuaternion({
        transform: { position: [1, 2, 3], rotation: [0.3, -0.7, 1.2], scale: [1, 1, 1] },
        target: [1, 2, 3],
      }),
      [-0.075581533421, -0.359091362801, 0.482161948317, 0.795525411638],
    );
  });

  it("pins the cubic-bezier easing golden table", () => {
    const golden: Array<[number, number, number, number, number]> = [
      [0.1, 0.017026610766, 0.16057221801, 0.019722447264, -0.419775878343],
      [0.25, 0.093464650994, 0.378138130826, 0.129161900569, -0.388025640598],
      [0.5, 0.315356812506, 0.684643187494, 0.5, 0.5],
      [0.75, 0.621861869174, 0.906535349006, 0.870838099431, 1.388025640598],
      [0.9, 0.83942778199, 0.982973389234, 0.980277552736, 1.419775878343],
    ];
    for (const [progress, easeIn, easeOut, easeInOut, overshoot] of golden) {
      expect(evaluateDirectorTimingCurve(progress, { x1: 0.42, y1: 0, x2: 1, y2: 1 })).toBeCloseTo(easeIn, 9);
      expect(evaluateDirectorTimingCurve(progress, { x1: 0, y1: 0, x2: 0.58, y2: 1 })).toBeCloseTo(easeOut, 9);
      expect(evaluateDirectorTimingCurve(progress, { x1: 0.42, y1: 0, x2: 0.58, y2: 1 })).toBeCloseTo(easeInOut, 9);
      expect(evaluateDirectorTimingCurve(progress, { x1: 0.3, y1: -2, x2: 0.7, y2: 3 })).toBeCloseTo(overshoot, 9);
    }
  });

  it("pins the keyframe transform golden table", () => {
    const animation: DirectorEntityAnimation = {
      version: 1,
      enabled: true,
      keyframes: [
        {
          frame: 0,
          interpolation: "smooth",
          transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        },
        {
          frame: 24,
          interpolation: "linear",
          transform: { position: [4, 2, -6], rotation: [0, Math.PI / 2, 0], scale: [2, 2, 2] },
        },
        {
          frame: 48,
          interpolation: "step",
          transform: { position: [8, 0, 0], rotation: [0, Math.PI, 0], scale: [1, 1, 1] },
        },
      ],
    };
    const base: DirectorTransform = { position: [9, 9, 9], rotation: [0, 0, 0], scale: [1, 1, 1] };
    const golden: Array<[number, [number, number, number], number, number]> = [
      [0, [0, 0, 0], 0, 1],
      [6, [0.625, 0.3125, -0.9375], 0.245436926062, 1.15625],
      [12, [2, 1, -3], 0.785398163397, 1.5],
      [30, [5, 1.5, -4.5], 1.963495408494, 1.75],
      [47, [7.833333333333, 0.083333333333, -0.25], 3.07614280664, 1.041666666667],
      [48, [8, 0, 0], 3.14159265359, 1],
      [60, [8, 0, 0], 3.14159265359, 1],
    ];
    for (const [frame, position, rotationY, scale] of golden) {
      const value = evaluateTransformAnimation(base, animation, frame);
      expectVectorClose(value.position, position);
      expect(value.rotation[1]).toBeCloseTo(rotationY, 9);
      expect(value.scale[0]).toBeCloseTo(scale, 9);
    }
  });

  it("pins the circle trajectory golden table", () => {
    const animation: DirectorEntityAnimation = {
      version: 1,
      enabled: true,
      preset: "circle",
      orientToPath: true,
      circle: { center: [1, 0.5, -1], radius: 2, startAngle: 0, clockwise: false },
      keyframes: [
        {
          frame: 0,
          interpolation: "linear",
          transform: { position: [3, 0.5, -1], rotation: [0, 0, 0], scale: [1, 1, 1] },
        },
        {
          frame: 40,
          interpolation: "linear",
          transform: { position: [3, 0.5, -1], rotation: [0, 0, 0], scale: [1, 1, 1] },
        },
      ],
    };
    const golden: Array<[number, [number, number, number], number]> = [
      [0, [3, 0.5, -1], 0],
      [10, [1, 0.5, 1], -1.570796326795],
      [25, [-0.414213562373, 0.5, -2.414213562373], 2.356194490192],
      [40, [3, 0.5, -1], 0],
    ];
    for (const [frame, position, rotationY] of golden) {
      const value = evaluateTrajectoryTransform(animation, frame);
      expect(value).not.toBeNull();
      expectVectorClose(value!.position, position);
      expect(value!.rotation[1]).toBeCloseTo(rotationY, 9);
    }
  });

  it("pins the bezier trajectory with speed golden table", () => {
    const animation: DirectorEntityAnimation = {
      version: 1,
      enabled: true,
      preset: "custom",
      orientToPath: true,
      speed: 2,
      keyframes: [
        {
          frame: 0,
          interpolation: "smooth",
          transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          curve: { out: [1, 0, 2] },
        },
        {
          frame: 60,
          interpolation: "smooth",
          transform: { position: [6, 0, -3], rotation: [0, 0, 0], scale: [1, 1, 1] },
          curve: { in: [-2, 0, -1] },
        },
      ],
    };
    const golden: Array<[number, [number, number, number], number]> = [
      [0, [0, 0, 0], 0.463647609001],
      [10, [1.128791342783, 0, 0.203779911599], 2.12656907991],
      [20, [4.295076969974, 0, -2.627648224356], 2.181403073254],
      [30, [6, 0, -3], 0],
    ];
    for (const [frame, position, rotationY] of golden) {
      const value = evaluateTrajectoryTransform(animation, frame);
      expect(value).not.toBeNull();
      expectVectorClose(value!.position, position);
      expect(value!.rotation[1]).toBeCloseTo(rotationY, 9);
    }
  });
});
