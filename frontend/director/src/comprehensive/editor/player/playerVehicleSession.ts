import { Quaternion, Vector3 } from "three";
import { clamp } from "../../../../../../packages/protocol/src/primitives";
import type { DirectorVehicleControls } from "../vehicle/vehicleContracts";
import type { PlayerVehicleDriveInput } from "./playerInput";

/**
 * Pure drive-session logic for the live player mode: proximity selection,
 * steering smoothing, key-to-control mapping, exit-probe selection, and the
 * HUD phase selector. Everything here is deterministic for identical input
 * sequences; PlayerController owns the wiring and all physics side effects.
 */

/** Horizontal enter radius measured from the character to the seat position. */
export const PLAYER_VEHICLE_ENTER_RANGE_M = 2.5;
/** Steering approaches the held direction at this rate (full lock in ~167 ms). */
export const VEHICLE_STEER_ENGAGE_RATE_PER_S = 6;
/** Released steering re-centers slightly slower for a stable straight-line feel. */
export const VEHICLE_STEER_RECENTER_RATE_PER_S = 4;
/** Below this forward speed the brake key requests reverse instead of braking. */
export const VEHICLE_REVERSE_ENGAGE_SPEED_MPS = 0.5;
/** Exit probes are only accepted with standable ground within this drop. */
export const VEHICLE_EXIT_MAX_GROUND_DROP_M = 3;
/** A chassis below this height is treated as fallen out of the world. */
export const VEHICLE_FALL_RESET_Y = -50;
/** Chase camera looks ahead along travel: lead = clamp(speed * factor, 0, max). */
export const VEHICLE_CHASE_LOOK_LEAD_FACTOR = 0.25;
export const VEHICLE_CHASE_LOOK_LEAD_MAX_M = 4;

/** World-space position triplet [x, y, z] in metres, read-only. */
export type PlayerVehiclePosition = readonly [number, number, number];

/**
 * Transforms a vehicle-local seat offset into world space using the vehicle's
 * live pose. The result is written into the provided output vector.
 *
 * @param vehiclePosition - World position of the vehicle's origin.
 * @param vehicleQuaternion - World rotation of the vehicle.
 * @param seatOffset - Local seat offset relative to the vehicle origin.
 * @param out - Output vector to receive the world-space seat position.
 * @returns The output vector for chaining.
 */
export function getVehicleSeatWorldPosition(
  vehiclePosition: Vector3,
  vehicleQuaternion: Quaternion,
  seatOffset: PlayerVehiclePosition,
  out: Vector3,
): Vector3 {
  return out.set(seatOffset[0], seatOffset[1], seatOffset[2]).applyQuaternion(vehicleQuaternion).add(vehiclePosition);
}

/** A vehicle that is a candidate for entering, with its enterable status and seat position. */
export interface PlayerVehicleEnterCandidate {
  id: string;
  /** False while the physics runtime for this vehicle is missing or failed. */
  enterable: boolean;
  /** World-space seat position derived from the vehicle's live transform. */
  seatPosition: PlayerVehiclePosition;
}

/**
 * Nearest enterable vehicle by horizontal distance to its seat position, or
 * null when none is inside the enter range. Ties keep the earliest candidate
 * so the result is stable across frames with identical input.
 */
export function selectNearestEnterableVehicle(
  characterPosition: PlayerVehiclePosition,
  candidates: readonly PlayerVehicleEnterCandidate[],
  maxDistanceM = PLAYER_VEHICLE_ENTER_RANGE_M,
): string | null {
  let nearestId: string | null = null;
  let nearestDistance = maxDistanceM;
  for (const candidate of candidates) {
    if (!candidate.enterable) continue;
    const distance = Math.hypot(
      candidate.seatPosition[0] - characterPosition[0],
      candidate.seatPosition[2] - characterPosition[2],
    );
    if (distance <= nearestDistance && (nearestId === null || distance < nearestDistance)) {
      nearestId = candidate.id;
      nearestDistance = distance;
    }
  }
  return nearestId;
}

/** Held steer direction from the drive keys: +1 left, -1 right, 0 neutral/both. */
export function getVehicleSteerDirection(input: Pick<PlayerVehicleDriveInput, "left" | "right">): -1 | 0 | 1 {
  if (input.left === input.right) return 0;
  // Contract convention: positive steer turns left (three.js +Y yaw).
  return input.left ? 1 : -1;
}

/**
 * Advances the smoothed steer value linearly toward the held direction. The
 * engage and re-center rates are asymmetric so releasing the key settles the
 * wheel without the twitchiness of instantly snapping to zero.
 */
export function stepVehicleSteerSmoothing(current: number, direction: -1 | 0 | 1, deltaSeconds: number): number {
  const safeCurrent = clamp(current, -1, 1);
  const safeDelta = Number.isFinite(deltaSeconds) ? Math.max(0, deltaSeconds) : 0;
  const target = direction;
  const rate = direction !== 0 ? VEHICLE_STEER_ENGAGE_RATE_PER_S : VEHICLE_STEER_RECENTER_RATE_PER_S;
  const maxStep = rate * safeDelta;
  const difference = target - safeCurrent;
  if (Math.abs(difference) <= maxStep) return target;
  return safeCurrent + Math.sign(difference) * maxStep;
}

/**
 * Maps held drive keys plus the smoothed steer value onto the vehicle control
 * contract. The brake key is speed-sensitive: while rolling forward it is a
 * service brake, once (nearly) stopped it becomes reverse throttle. A held
 * throttle key wins over reverse so W+S at a standstill still creeps forward.
 */
export function mapVehicleDriveControls({
  input,
  steer,
  forwardSpeedMps,
}: {
  input: PlayerVehicleDriveInput;
  steer: number;
  forwardSpeedMps: number;
}): DirectorVehicleControls {
  const rollingForward = forwardSpeedMps > VEHICLE_REVERSE_ENGAGE_SPEED_MPS;
  const throttle = input.forward ? 1 : input.backward && !rollingForward ? -1 : 0;
  const brake = input.backward && rollingForward ? 1 : 0;
  return {
    throttle,
    steer: clamp(steer, -1, 1),
    brake,
    handbrake: input.handbrake,
  };
}

const exitProbeScratch = new Vector3();

/**
 * Tries the profile's exit offsets in authored order (left door first) against
 * the vehicle's live pose. The first probe that is not inside static collision
 * and has standable ground within the allowed drop wins; the returned position
 * sits on that ground so the restored character never spawns mid-air.
 */
export function selectVehicleExitPose({
  exitOffsets,
  vehiclePosition,
  vehicleQuaternion,
  isBlocked,
  findGroundYBelow,
  maxGroundDropM = VEHICLE_EXIT_MAX_GROUND_DROP_M,
}: {
  exitOffsets: readonly PlayerVehiclePosition[];
  vehiclePosition: Vector3;
  vehicleQuaternion: Quaternion;
  /** True when the probe point intersects static collision (walls, props). */
  isBlocked: (probe: Vector3) => boolean;
  /** Highest static surface below the probe, or null when none is in reach. */
  findGroundYBelow: (probe: Vector3) => number | null;
  maxGroundDropM?: number;
}): { position: [number, number, number]; offsetIndex: number } | null {
  for (let index = 0; index < exitOffsets.length; index += 1) {
    const offset = exitOffsets[index]!;
    const probe = exitProbeScratch
      .set(offset[0], offset[1], offset[2])
      .applyQuaternion(vehicleQuaternion)
      .add(vehiclePosition);
    if (isBlocked(probe)) continue;
    const groundY = findGroundYBelow(probe);
    if (groundY === null || probe.y - groundY > maxGroundDropM) continue;
    return { position: [probe.x, groundY, probe.z], offsetIndex: index };
  }
  return null;
}

/** Visibility phase of the vehicle HUD overlay in the roam viewport. */
export type PlayerVehicleHudPhase = "hidden" | "prompt" | "driving";

/** HUD phase for the roam overlay: driving wins, then a nearby enterable vehicle. */
export function getPlayerVehicleHudPhase({
  driving,
  nearestEnterableVehicleId,
}: {
  driving: boolean;
  nearestEnterableVehicleId: string | null;
}): PlayerVehicleHudPhase {
  if (driving) return "driving";
  return nearestEnterableVehicleId !== null ? "prompt" : "hidden";
}

/** Forward look-ahead distance for the chase camera along the travel direction. */
export function getVehicleChaseLookLead(forwardSpeedMps: number): number {
  if (!Number.isFinite(forwardSpeedMps)) return 0;
  return clamp(forwardSpeedMps * VEHICLE_CHASE_LOOK_LEAD_FACTOR, 0, VEHICLE_CHASE_LOOK_LEAD_MAX_M);
}
