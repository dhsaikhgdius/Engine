import { Matrix4, Quaternion, Vector3 } from "three";
import { expect, it } from "vitest";
import { setPlayerCameraLookQuaternion } from "../../../../src/comprehensive/editor/player/playerCameraRig";

it("orients the camera negative-Z axis toward the third-person target", () => {
  const position = new Vector3(2, 2, 5);
  const target = new Vector3(0, 1, 0);
  const quaternion = setPlayerCameraLookQuaternion({
    matrix: new Matrix4(),
    position,
    quaternion: new Quaternion(),
    target,
    up: new Vector3(0, 1, 0),
  });
  const actualDirection = new Vector3(0, 0, -1).applyQuaternion(quaternion).normalize();
  const expectedDirection = target.clone().sub(position).normalize();

  expect(actualDirection.x).toBeCloseTo(expectedDirection.x, 6);
  expect(actualDirection.y).toBeCloseTo(expectedDirection.y, 6);
  expect(actualDirection.z).toBeCloseTo(expectedDirection.z, 6);
});
