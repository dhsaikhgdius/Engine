import { expect, it } from "vitest";
import { createDefaultDirectorCarProfile } from "../../../../../../packages/protocol/src/vehicleProtocol";
import type { DirectorVehicleControls } from "../../../../src/comprehensive/editor/vehicle/vehicleContracts";
import {
  computeVehicleWheelLayout,
  cuboidPrincipalAngularInertia,
  effectiveSteerRad,
  kphToMps,
  mpsToKph,
  resolveVehicleDriveCommand,
  suspensionDampingCoefficient,
  VEHICLE_TUNING,
} from "../../../../src/comprehensive/editor/vehicle/vehicleTuning";

const profile = createDefaultDirectorCarProfile();
/** Sedan-shaped bounds: 2 m wide (x), 1.5 m tall (y), 4.4 m long (z, forward). */
const halfExtents = { x: 1, y: 0.75, z: 2.2 };

function controlsWith(overrides: Partial<DirectorVehicleControls> = {}): DirectorVehicleControls {
  return { throttle: 0, steer: 0, brake: 0, handbrake: false, ...overrides };
}

it("lays out four mirrored wheels in FL/FR/RL/RR order on the chassis bottom", () => {
  const [fl, fr, rl, rr] = computeVehicleWheelLayout(profile, halfExtents);
  expect([fl.slot, fr.slot, rl.slot, rr.slot]).toEqual(["FL", "FR", "RL", "RR"]);

  // Chassis frame: forward = +Z, left = +X (see vehicleTuning header).
  const lateralX = halfExtents.x * VEHICLE_TUNING.wheelLateralPlacementRatio;
  const longitudinalZ = halfExtents.z * VEHICLE_TUNING.wheelLongitudinalPlacementRatio;
  expect(fl.connectionCs).toEqual({ x: lateralX, y: -halfExtents.y, z: longitudinalZ });
  expect(fr.connectionCs).toEqual({ x: -lateralX, y: -halfExtents.y, z: longitudinalZ });
  expect(rl.connectionCs).toEqual({ x: lateralX, y: -halfExtents.y, z: -longitudinalZ });
  expect(rr.connectionCs).toEqual({ x: -lateralX, y: -halfExtents.y, z: -longitudinalZ });

  expect(fl.steered && fr.steered).toBe(true);
  expect(rl.steered || rr.steered).toBe(false);
  expect(rl.driven && rr.driven).toBe(true);
  expect(fl.driven || fr.driven).toBe(false);
  for (const wheel of [fl, fr, rl, rr]) {
    expect(wheel.radiusM).toBe(profile.wheelRadiusM);
    expect(wheel.suspensionRestM).toBe(profile.suspensionRestM);
  }
});

it("steers fully at standstill and decays monotonically to the floor", () => {
  const maxSteerRad = (profile.steerMaxDeg * Math.PI) / 180;
  expect(effectiveSteerRad(profile, 0)).toBeCloseTo(maxSteerRad, 10);

  let previous = Number.POSITIVE_INFINITY;
  for (let kph = 0; kph <= 300; kph += 10) {
    const steer = effectiveSteerRad(profile, kphToMps(kph));
    expect(steer).toBeLessThanOrEqual(previous);
    expect(steer).toBeGreaterThanOrEqual(maxSteerRad * VEHICLE_TUNING.steerFloorRatio);
    previous = steer;
  }

  // Far beyond top speed the floor holds the wheel at ~22% authority.
  expect(effectiveSteerRad(profile, kphToMps(500))).toBeCloseTo(maxSteerRad * VEHICLE_TUNING.steerFloorRatio, 6);
  // At the profile's own top speed the fade is still above the floor.
  expect(effectiveSteerRad(profile, kphToMps(profile.maxSpeedKph))).toBeGreaterThan(
    maxSteerRad * VEHICLE_TUNING.steerFloorRatio,
  );
  // Reverse uses the same fade as forward.
  expect(effectiveSteerRad(profile, -kphToMps(60))).toBeCloseTo(effectiveSteerRad(profile, kphToMps(60)), 12);
});

it("cuts engine force at the forward and reverse speed limits", () => {
  const stopped = resolveVehicleDriveCommand(profile, controlsWith({ throttle: 1 }), 0);
  expect(stopped.engineForcePerDrivenWheelN).toBeCloseTo(profile.engineForceN / 2, 8);
  expect(stopped.frontBrakePerWheelN).toBe(0);
  expect(stopped.rearBrakePerWheelN).toBe(0);

  const atTop = resolveVehicleDriveCommand(profile, controlsWith({ throttle: 1 }), kphToMps(profile.maxSpeedKph));
  expect(atTop.engineForcePerDrivenWheelN).toBe(0);
  const nearTop = resolveVehicleDriveCommand(profile, controlsWith({ throttle: 1 }), kphToMps(profile.maxSpeedKph - 1));
  expect(nearTop.engineForcePerDrivenWheelN).toBeGreaterThan(0);

  const atReverseTop = resolveVehicleDriveCommand(
    profile,
    controlsWith({ throttle: -1 }),
    -kphToMps(profile.reverseSpeedKph),
  );
  expect(atReverseTop.engineForcePerDrivenWheelN).toBe(0);
  const reversing = resolveVehicleDriveCommand(
    profile,
    controlsWith({ throttle: -1 }),
    -kphToMps(profile.reverseSpeedKph - 5),
  );
  expect(reversing.engineForcePerDrivenWheelN).toBeLessThan(0);
});

it("brakes on an opposing throttle until nearly stopped, then reverses", () => {
  const frontShare = VEHICLE_TUNING.frontBrakeShare;
  const brakingForward = resolveVehicleDriveCommand(profile, controlsWith({ throttle: -1 }), 12);
  expect(brakingForward.engineForcePerDrivenWheelN).toBe(0);
  expect(brakingForward.frontBrakePerWheelN).toBeCloseTo((profile.brakeForceN * frontShare) / 2, 8);
  expect(brakingForward.rearBrakePerWheelN).toBeCloseTo((profile.brakeForceN * (1 - frontShare)) / 2, 8);

  const nearlyStopped = resolveVehicleDriveCommand(profile, controlsWith({ throttle: -1 }), 0.2);
  expect(nearlyStopped.engineForcePerDrivenWheelN).toBeLessThan(0);
  expect(nearlyStopped.frontBrakePerWheelN).toBe(0);

  // Symmetric scheme: a held W while rolling backward brakes first.
  const brakingBackward = resolveVehicleDriveCommand(profile, controlsWith({ throttle: 1 }), -4);
  expect(brakingBackward.engineForcePerDrivenWheelN).toBe(0);
  expect(brakingBackward.frontBrakePerWheelN).toBeGreaterThan(0);
  const creepingBackward = resolveVehicleDriveCommand(profile, controlsWith({ throttle: 1 }), -0.2);
  expect(creepingBackward.engineForcePerDrivenWheelN).toBeGreaterThan(0);
});

it("scales the service brake and keeps the stronger brake source instead of stacking", () => {
  const frontShare = VEHICLE_TUNING.frontBrakeShare;
  const half = resolveVehicleDriveCommand(profile, controlsWith({ brake: 0.5 }), 20);
  expect(half.frontBrakePerWheelN).toBeCloseTo((profile.brakeForceN * 0.5 * frontShare) / 2, 8);
  expect(half.rearBrakePerWheelN).toBeCloseTo((profile.brakeForceN * 0.5 * (1 - frontShare)) / 2, 8);

  const combined = resolveVehicleDriveCommand(profile, controlsWith({ brake: 0.25, throttle: -1 }), 20);
  expect(combined.frontBrakePerWheelN).toBeCloseTo((profile.brakeForceN * frontShare) / 2, 8);
});

it("floors the rear brake at 1.6x brakeForceN and loosens rear side grip while the handbrake is held", () => {
  const sliding = resolveVehicleDriveCommand(profile, controlsWith({ handbrake: true }), 15);
  expect(sliding.rearBrakePerWheelN).toBeCloseTo((profile.brakeForceN * VEHICLE_TUNING.handbrakeRearBrakeScale) / 2, 8);
  expect(sliding.frontBrakePerWheelN).toBe(0);
  expect(sliding.rearSideFrictionStiffness).toBe(VEHICLE_TUNING.handbrakeRearSideFrictionStiffness);
  expect(sliding.rearSideFrictionStiffness).toBeLessThan(VEHICLE_TUNING.normalSideFrictionStiffness);

  const normal = resolveVehicleDriveCommand(profile, controlsWith({ throttle: 1 }), 15);
  expect(normal.rearSideFrictionStiffness).toBe(VEHICLE_TUNING.normalSideFrictionStiffness);
});

it("converts kph and mps in both directions", () => {
  expect(kphToMps(36)).toBeCloseTo(10, 12);
  expect(mpsToKph(10)).toBeCloseTo(36, 12);
  expect(mpsToKph(kphToMps(profile.maxSpeedKph))).toBeCloseTo(profile.maxSpeedKph, 10);
});

it("derives near-critical suspension damping and solid-cuboid inertia", () => {
  expect(suspensionDampingCoefficient(profile.suspensionStiffness)).toBeCloseTo(
    VEHICLE_TUNING.suspensionDampingRatio * 2 * Math.sqrt(profile.suspensionStiffness),
    12,
  );

  const inertia = cuboidPrincipalAngularInertia(12, { x: 1, y: 2, z: 3 });
  expect(inertia).toEqual({ x: 4 * (4 + 9), y: 4 * (1 + 9), z: 4 * (1 + 4) });
});
