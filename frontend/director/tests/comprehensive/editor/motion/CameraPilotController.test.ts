import { BatchedMesh, BoxGeometry, InstancedMesh, MeshBasicMaterial } from "three";
import { describe, expect, it } from "vitest";
import {
  getDirectorObjectIdFromPilotIntersection,
  getPilotFovAfterWheel,
  getPilotMouseSensitivity,
} from "../../../../src/comprehensive/editor/motion/CameraPilotController";
import {
  getCameraPilotBankTarget,
  getCameraPilotDampingAlpha,
  getCameraPilotInputResponse,
  getCameraPilotLookResponse,
} from "../../../../src/comprehensive/editor/motion/cameraPilotMotion";
import { getPilotLookIntent, getPilotMovementIntent, getPilotSpeedMultiplier } from "../../../../src/comprehensive/editor/motion/pilotControls";

describe("camera pilot controls", () => {
  it("maps movement and scales look sensitivity", () => {
    expect(getPilotMovementIntent(new Set(["KeyW", "KeyA", "KeyE"]))).toEqual({
      forward: 1,
      strafe: -1,
      vertical: 1,
    });
    expect(getPilotLookIntent(new Set(["ArrowRight", "ArrowDown"]))).toEqual({
      yaw: 1,
      pitchDown: 1,
    });
    expect(getPilotMouseSensitivity(0.2)).toBeLessThan(getPilotMouseSensitivity(1));
  });

  it("caps wheel lens changes", () => {
    expect(getPilotFovAfterWheel(50, 10_000, 0.4)).toBeLessThanOrEqual(50.6);
    expect(getPilotFovAfterWheel(5, -10_000, 1.5)).toBe(5);
  });

  it("provides cinematic acceleration, braking, look smoothing and constrained banking", () => {
    expect(getCameraPilotInputResponse(0, true)).toBeGreaterThan(getCameraPilotInputResponse(1, true));
    expect(getCameraPilotInputResponse(0.4, false)).toBeGreaterThan(getCameraPilotInputResponse(0.4, true));
    expect(getCameraPilotLookResponse(0)).toBeGreaterThan(getCameraPilotLookResponse(1));
    expect(getCameraPilotDampingAlpha(10, 1 / 60)).toBeGreaterThan(0);

    const bank = getCameraPilotBankTarget({ bankStrength: 1, strafe: 1, yawVelocity: 100 });
    expect(bank).toBeLessThan(0);
    expect(Math.abs(bank)).toBeLessThanOrEqual((8 * Math.PI) / 180);
  });

  it("supports boost and precision speed gears with precision taking priority", () => {
    expect(getPilotSpeedMultiplier(new Set(["ShiftLeft"]))).toBe(2.5);
    expect(getPilotSpeedMultiplier(new Set(["AltLeft"]))).toBe(0.25);
    expect(getPilotSpeedMultiplier(new Set(["ShiftLeft", "AltLeft"]))).toBe(0.25);
  });

  it("resolves the stable object id for a batched primitive ray hit", () => {
    const instances = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial(), 2);
    instances.userData.directorInstanceObjectIds = ["box-a", "box-b"];

    expect(getDirectorObjectIdFromPilotIntersection({ instanceId: 1, object: instances })).toBe("box-b");
  });

  it("resolves the stable object id for a GPU multi-draw ray hit", () => {
    const source = new BoxGeometry(1, 1, 1);
    const positionCount = source.getAttribute("position").count;
    const indexCount = source.getIndex()?.count ?? positionCount;
    const batch = new BatchedMesh(2, positionCount, indexCount, new MeshBasicMaterial());
    const geometryId = batch.addGeometry(source);
    batch.addInstance(geometryId);
    batch.addInstance(geometryId);
    batch.userData.directorInstanceObjectIds = ["box-a", "box-b"];

    expect(getDirectorObjectIdFromPilotIntersection({ batchId: 1, object: batch })).toBe("box-b");
  });
});
