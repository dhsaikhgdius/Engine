import { clamp } from "../../../../../../packages/protocol/src/primitives";
import type { DirectorVehicleProfile } from "../schema/directorProject";
import type { DirectorVehicleControls } from "./vehicleContracts";

/**
 * Pure arcade-car tuning math shared by the Rapier vehicle runtime and its
 * tests. Everything in this module is deterministic number crunching: no
 * physics-engine imports and no hidden state.
 *
 * Chassis frame convention (right-handed, Y up, matching three.js):
 * - forward = +Z (rapier's DynamicRayCastVehicleController default forward
 *   axis index 2, and the direction this codebase's player "forward" input
 *   already moves in),
 * - left = +X (right = forward x up = -X),
 * - positive yaw rotates forward from +Z toward +X, so positive steer means
 *   yaw increases, matching the DirectorVehicleControls comment.
 */

/** Plain {x, y, z} vector contract shared by the tuning math and the Rapier runtime. */
export interface VehicleVec3 {
  x: number;
  y: number;
  z: number;
}

/** Wheel array order required by DirectorVehiclePose. */
export const VEHICLE_WHEEL_SLOTS = ["FL", "FR", "RL", "RR"] as const;
export type VehicleWheelSlot = (typeof VEHICLE_WHEEL_SLOTS)[number];

export interface VehicleWheelSpec {
  slot: VehicleWheelSlot;
  /** Suspension hard point in chassis space, on the chassis bottom face. */
  connectionCs: VehicleVec3;
  /** Front wheels steer. */
  steered: boolean;
  /** Rear wheels receive engine force (RWD; see rapierVehicleRuntime). */
  driven: boolean;
  radiusM: number;
  suspensionRestM: number;
}

export const VEHICLE_TUNING = {
  /** Fixed physics substep; render deltas are accumulated into these. */
  substepSeconds: 1 / 120,
  /** Render deltas above this are clamped so a tab-switch hitch cannot explode physics. */
  maxStepSeconds: 1 / 20,
  gravityMps2: 9.81,
  /** Wheel |x| as a fraction of the chassis half width (track width). */
  wheelLateralPlacementRatio: 0.82,
  /** Wheel |z| as a fraction of the chassis half length (wheelbase). */
  wheelLongitudinalPlacementRatio: 0.68,
  /** Speed at which steering authority has faded to 50%. */
  steerFadeReferenceKph: 90,
  steerFadeExponent: 1.6,
  /** Steering never fades below this fraction of steerMaxDeg (wheel must not go numb). */
  steerFloorRatio: 0.22,
  /** Below this |forward speed| an opposing throttle switches from braking to driving. */
  directionSwapSpeedMps: 0.6,
  /** Fraction of the total brake force carried by the front axle. */
  frontBrakeShare: 0.6,
  /** Handbrake rear-axle force as a multiple of profile.brakeForceN. */
  handbrakeRearBrakeScale: 1.6,
  /** Rear side-grip multiplier while the handbrake is held (arcade slides). */
  handbrakeRearSideFrictionStiffness: 0.35,
  normalSideFrictionStiffness: 1,
  /**
   * Bullet-style tire traction cap. High values grip like rails (and can flip
   * the car); this sits low enough that tires slip well before the rollover
   * threshold of the profile's lowered center of mass.
   */
  wheelFrictionSlip: 5.5,
  /** Suspension damping ratio (1 = critical); slightly under-damped reads as "car". */
  suspensionDampingRatio: 0.88,
  /** Max suspension travel as a multiple of the rest length. */
  suspensionMaxTravelRatio: 1.5,
} as const;

/** Converts kilometers per hour to meters per second. */
export function kphToMps(kph: number): number {
  return kph / 3.6;
}

/** Converts meters per second to kilometers per hour. */
export function mpsToKph(mps: number): number {
  return mps * 3.6;
}

/**
 * Places the four wheels from the rendered chassis bounds: pushed out to
 * 82% of the half width and 68% of the half length, hard points on the
 * chassis bottom face, radius/suspension straight from the profile.
 */
export function computeVehicleWheelLayout(
  profile: DirectorVehicleProfile,
  halfExtents: Readonly<VehicleVec3>,
): [VehicleWheelSpec, VehicleWheelSpec, VehicleWheelSpec, VehicleWheelSpec] {
  const lateralX = halfExtents.x * VEHICLE_TUNING.wheelLateralPlacementRatio;
  const longitudinalZ = halfExtents.z * VEHICLE_TUNING.wheelLongitudinalPlacementRatio;
  const bottomY = -halfExtents.y;
  const wheel = (slot: VehicleWheelSlot, x: number, z: number, steered: boolean): VehicleWheelSpec => ({
    slot,
    connectionCs: { x, y: bottomY, z },
    steered,
    driven: !steered,
    radiusM: profile.wheelRadiusM,
    suspensionRestM: profile.suspensionRestM,
  });
  return [
    wheel("FL", lateralX, longitudinalZ, true),
    wheel("FR", -lateralX, longitudinalZ, true),
    wheel("RL", lateralX, -longitudinalZ, false),
    wheel("RR", -lateralX, -longitudinalZ, false),
  ];
}

/**
 * Speed-sensitive steering: full lock at standstill fading smoothly with
 * speed so highway-speed taps cannot spin the car, floored so the wheel
 * keeps ~22% authority at and beyond the profile's top speed.
 */
export function effectiveSteerRad(profile: DirectorVehicleProfile, forwardSpeedMps: number): number {
  const speedKph = mpsToKph(Math.abs(forwardSpeedMps));
  const fade = 1 / (1 + (speedKph / VEHICLE_TUNING.steerFadeReferenceKph) ** VEHICLE_TUNING.steerFadeExponent);
  const maxSteerRad = (profile.steerMaxDeg * Math.PI) / 180;
  return maxSteerRad * Math.max(fade, VEHICLE_TUNING.steerFloorRatio);
}

export interface VehicleDriveCommand {
  /** Force on each driven (rear) wheel; negative reverses. */
  engineForcePerDrivenWheelN: number;
  frontBrakePerWheelN: number;
  rearBrakePerWheelN: number;
  /** Rapier side-friction stiffness to apply to the rear axle this substep. */
  rearSideFrictionStiffness: number;
}

const DRIVEN_WHEEL_COUNT = 2;
const AXLE_WHEEL_COUNT = 2;

/**
 * Classic arcade throttle scheme: an opposing throttle brakes while the car
 * still rolls the other way and only becomes drive once nearly stopped, so a
 * held S is "brake, then reverse" (and a held W while rolling backward is
 * "brake, then drive"). Engine force cuts off at maxSpeedKph forward and
 * reverseSpeedKph backward. The service-brake channel and the throttle-derived
 * brake never stack; the stronger one wins. The handbrake floors the rear
 * axle's brake at 1.6x brakeForceN and loosens rear side grip while held;
 * engine force is deliberately kept so a held throttle can spin the rears.
 */
export function resolveVehicleDriveCommand(
  profile: DirectorVehicleProfile,
  controls: DirectorVehicleControls,
  forwardSpeedMps: number,
): VehicleDriveCommand {
  const throttle = clamp(controls.throttle, -1, 1);
  const forwardKph = mpsToKph(forwardSpeedMps);
  let engineTotalN = 0;
  let throttleBrakeTotalN = 0;
  if (throttle > 0) {
    if (forwardSpeedMps < -VEHICLE_TUNING.directionSwapSpeedMps) throttleBrakeTotalN = throttle * profile.brakeForceN;
    else if (forwardKph < profile.maxSpeedKph) engineTotalN = throttle * profile.engineForceN;
  } else if (throttle < 0) {
    if (forwardSpeedMps > VEHICLE_TUNING.directionSwapSpeedMps) throttleBrakeTotalN = -throttle * profile.brakeForceN;
    else if (-forwardKph < profile.reverseSpeedKph) engineTotalN = throttle * profile.engineForceN;
  }

  const brakeTotalN = Math.max(clamp(controls.brake, 0, 1) * profile.brakeForceN, throttleBrakeTotalN);
  const frontBrakePerWheelN = (brakeTotalN * VEHICLE_TUNING.frontBrakeShare) / AXLE_WHEEL_COUNT;
  let rearBrakePerWheelN = (brakeTotalN * (1 - VEHICLE_TUNING.frontBrakeShare)) / AXLE_WHEEL_COUNT;
  let rearSideFrictionStiffness: number = VEHICLE_TUNING.normalSideFrictionStiffness;
  if (controls.handbrake) {
    rearBrakePerWheelN = Math.max(
      rearBrakePerWheelN,
      (profile.brakeForceN * VEHICLE_TUNING.handbrakeRearBrakeScale) / AXLE_WHEEL_COUNT,
    );
    rearSideFrictionStiffness = VEHICLE_TUNING.handbrakeRearSideFrictionStiffness;
  }

  return {
    engineForcePerDrivenWheelN: engineTotalN / DRIVEN_WHEEL_COUNT,
    frontBrakePerWheelN,
    rearBrakePerWheelN,
    rearSideFrictionStiffness,
  };
}

/**
 * Bullet-convention suspension damping coefficient, ~0.88 x critical for the
 * given stiffness (rapier's raycast vehicle normalizes by sprung mass, so
 * critical damping is 2*sqrt(stiffness) in its units).
 */
export function suspensionDampingCoefficient(suspensionStiffness: number): number {
  return VEHICLE_TUNING.suspensionDampingRatio * 2 * Math.sqrt(suspensionStiffness);
}

/**
 * Principal angular inertia of a solid cuboid about its centroid axes. Used
 * with the profile-lowered center of mass; keeping the centroid inertia there
 * is an intentional arcade approximation (slightly over-stable in roll).
 */
export function cuboidPrincipalAngularInertia(massKg: number, halfExtents: Readonly<VehicleVec3>): VehicleVec3 {
  const third = massKg / 3;
  return {
    x: third * (halfExtents.y * halfExtents.y + halfExtents.z * halfExtents.z),
    y: third * (halfExtents.x * halfExtents.x + halfExtents.z * halfExtents.z),
    z: third * (halfExtents.x * halfExtents.x + halfExtents.y * halfExtents.y),
  };
}
