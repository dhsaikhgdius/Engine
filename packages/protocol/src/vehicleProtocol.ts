import { z } from "zod";

/**
 * Drivable vehicle protocol.
 *
 * A vehicle profile is an optional capability attached to a Director object
 * (any prop/asset can become drivable). The live player session builds a
 * physics vehicle from the profile plus the object's rendered bounds; the
 * project document stores intent, never runtime physics state.
 */

export const DIRECTOR_VEHICLE_PROTOCOL_VERSION = 1 as const;

const finite = z.number().finite();

export const DIRECTOR_VEHICLE_KINDS = ["car"] as const;
export type DirectorVehicleKind = (typeof DIRECTOR_VEHICLE_KINDS)[number];

export const directorVehicleProfileSchema = z.strictObject({
  version: z.literal(DIRECTOR_VEHICLE_PROTOCOL_VERSION),
  kind: z.enum(DIRECTOR_VEHICLE_KINDS),
  /** Player sessions only list drivable vehicles for enter prompts. */
  drivable: z.boolean(),
  massKg: finite.min(100).max(20_000),
  engineForceN: finite.min(500).max(100_000),
  brakeForceN: finite.min(500).max(200_000),
  maxSpeedKph: finite.min(5).max(400),
  reverseSpeedKph: finite.min(5).max(100),
  steerMaxDeg: finite.min(5).max(60),
  wheelRadiusM: finite.min(0.1).max(2),
  suspensionRestM: finite.min(0.05).max(1),
  suspensionStiffness: finite.min(5).max(200),
  /** Lowers the chassis center of mass to resist rollovers; metres, usually negative. */
  centerOfMassYOffsetM: finite.min(-2).max(2),
  /** Driver head position relative to the object origin while seated. */
  seatOffset: z.tuple([finite.min(-10).max(10), finite.min(-10).max(10), finite.min(-10).max(10)]),
  /** Exit probe offsets tried in order (left door first), object-local metres. */
  exitOffsets: z
    .array(z.tuple([finite.min(-10).max(10), finite.min(-10).max(10), finite.min(-10).max(10)]))
    .min(1)
    .max(6),
  camera: z.strictObject({
    chaseDistanceM: finite.min(2).max(30),
    chaseHeightM: finite.min(0.5).max(15),
  }),
});

export type DirectorVehicleProfile = z.infer<typeof directorVehicleProfileSchema>;

/** Arcade-tuned sedan defaults; sized so an unmeasured prop still drives well. */
export function createDefaultDirectorCarProfile(): DirectorVehicleProfile {
  return {
    version: DIRECTOR_VEHICLE_PROTOCOL_VERSION,
    kind: "car",
    drivable: true,
    massKg: 1_400,
    engineForceN: 9_000,
    brakeForceN: 14_000,
    maxSpeedKph: 140,
    reverseSpeedKph: 35,
    steerMaxDeg: 32,
    wheelRadiusM: 0.34,
    suspensionRestM: 0.25,
    suspensionStiffness: 42,
    centerOfMassYOffsetM: -0.35,
    // Chassis frame: forward = +Z, up = +Y, left = +X (see vehicleTuning.ts).
    // Left-hand-drive: driver sits left of center; the left door exits first.
    seatOffset: [0.4, 1.05, 0.1],
    exitOffsets: [
      [1.6, 0.2, 0.2],
      [-1.6, 0.2, 0.2],
      [0, 0.2, -2.6],
    ],
    camera: { chaseDistanceM: 6.5, chaseHeightM: 2.6 },
  };
}
