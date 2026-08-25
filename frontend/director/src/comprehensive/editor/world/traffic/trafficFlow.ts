/**
 * Pure, stateless-in-time vehicle flow model for ambient road traffic.
 *
 * Every vehicle's arc-length position is a closed-form function of
 * (worldSeed, road.seedOffset, road.id, vehicleIndex, worldSeconds), so the
 * timeline can scrub backwards and deterministic export can render frames in
 * any order with zero simulation state.
 *
 * NO-OVERTAKE GUARANTEE: both loop and open roads evaluate
 * s(t) = mod(s0 ± v·t, L), so any speed difference between two vehicles in
 * the same lane grows without bound and eventually laps around the modulus —
 * "faster cars start ahead" only delays the pass, it cannot prevent it. The
 * only stateless choice that truly preserves ordering forever is a shared
 * speed per lane, so each lane (= travel direction) gets ONE hashed speed in
 * 0.85..1.15 × speedKph and all its vehicles inherit it. Per-lane initial
 * offsets are spread evenly with hashed jitter capped at ±20% of the slot
 * spacing, keeping pairwise gaps ≥ 60% of the even spacing forever (≥ 7 m on
 * representative roads, asserted by tests).
 *
 * Open roads reuse the same modulo wrap: vehicles reaching the end teleport
 * back to the start (documented behavior — no despawn animation).
 */

import { hashCombine, worldRandom01, worldStreamId } from "../worldRandom";

/** User-facing road descriptor that seeds the traffic flow model. */
export interface TrafficRoadInput {
  /** Stable identifier for the road; hashed into the per-road seed. */
  id: string;
  /** Per-road seed tweak so two roads with the same id can diverge. */
  seedOffset: number;
  /** Total vehicles on this road (split evenly across both directions). */
  vehicleCount: number;
  /** Base travel speed in km/h; each lane gets a ±15% hashed variation. */
  speedKph: number;
}

/** Per-vehicle deterministic streams for a single road, derived once from seed. */
export interface RoadTrafficStreams {
  /** Number of vehicles on this road. */
  count: number;
  /** +1 travels toward increasing arc length, -1 toward decreasing. */
  directions: Int8Array;
  /** Metres/second; identical for every vehicle in the same lane. */
  speedsMps: Float64Array;
  /** Initial arc offset s0 in [0, totalLengthM). */
  arcOffsetsM: Float64Array;
  /** Index into the fixed 8-color vehicle palette. */
  colorIndices: Uint8Array;
  /** Phase in [0, 2π) for the cosmetic suspension bounce. */
  bouncePhases: Float64Array;
  /** Total arc length of the road centreline in metres. */
  totalLengthM: number;
}

/** Number of entries in the fixed vehicle color palette. */
export const TRAFFIC_VEHICLE_COLOR_COUNT = 8;

/** Documented lower bound for same-lane spacing on representative roads. */
export const TRAFFIC_MIN_GAP_M = 7;

const TRAFFIC_STREAM = worldStreamId("world-traffic");
const STREAM_LANE_SPEED = worldStreamId("traffic-lane-speed");
const STREAM_LANE_PHASE = worldStreamId("traffic-lane-phase");
const STREAM_SLOT_JITTER = worldStreamId("traffic-slot-jitter");
const STREAM_COLOR = worldStreamId("traffic-color");
const STREAM_BOUNCE = worldStreamId("traffic-bounce");

const KPH_TO_MPS = 1 / 3.6;
/** Jitter stays below half of the (spacing - guarantee) budget on long roads. */
const SLOT_JITTER_RATIO = 0.2;

/**
 * Derives a stable per-road seed from the world seed and road identity.
 *
 * @param worldSeed - The global world seed driving all deterministic variation.
 * @param road - The road's id and seed offset, hashed into the result.
 * @returns A deterministic integer seed unique to this road.
 */
export function roadTrafficSeed(worldSeed: number, road: Pick<TrafficRoadInput, "id" | "seedOffset">): number {
  return hashCombine(worldSeed, road.seedOffset, worldStreamId(road.id), TRAFFIC_STREAM);
}

/**
 * Derives the per-vehicle streams for one road. Lane split: the first
 * ceil(count/2) vehicles travel forward (+1), the rest backward (-1), so both
 * directions stay populated for any vehicleCount.
 *
 * `laneSpeedScale` is a UNIFORM multiplier applied on top of the hashed
 * 0.85..1.15 lane band — weather slowdowns (storm, snow) scale the whole
 * lane at once, so same-lane relative speeds stay zero and the no-overtake
 * guarantee (see module header) is untouched. Per-car scales are forbidden.
 */
export function buildRoadTrafficStreams(
  road: TrafficRoadInput,
  worldSeed: number,
  totalLengthM: number,
  laneSpeedScale = 1,
): RoadTrafficStreams {
  const count = road.vehicleCount;
  const directions = new Int8Array(count);
  const speedsMps = new Float64Array(count);
  const arcOffsetsM = new Float64Array(count);
  const colorIndices = new Uint8Array(count);
  const bouncePhases = new Float64Array(count);

  const seed = roadTrafficSeed(worldSeed, road);
  const forwardCount = Math.ceil(count / 2);
  const laneCounts = [forwardCount, count - forwardCount] as const;
  const safeLaneSpeedScale = Math.max(0, laneSpeedScale);
  const baseSpeedMps = road.speedKph * KPH_TO_MPS * safeLaneSpeedScale;

  for (let index = 0; index < count; index += 1) {
    const lane = index < forwardCount ? 0 : 1;
    const slot = lane === 0 ? index : index - forwardCount;
    const laneVehicles = laneCounts[lane]!;

    directions[index] = lane === 0 ? 1 : -1;
    speedsMps[index] = baseSpeedMps * (0.85 + 0.3 * worldRandom01(seed, STREAM_LANE_SPEED, lane));

    const spacing = laneVehicles > 0 ? totalLengthM / laneVehicles : 0;
    const lanePhase = worldRandom01(seed, STREAM_LANE_PHASE, lane) * totalLengthM;
    const jitter = spacing * SLOT_JITTER_RATIO * (worldRandom01(seed, STREAM_SLOT_JITTER, lane, slot) * 2 - 1);
    const rawOffset = lanePhase + slot * spacing + jitter;
    arcOffsetsM[index] = totalLengthM > 1e-9 ? ((rawOffset % totalLengthM) + totalLengthM) % totalLengthM : 0;

    colorIndices[index] = hashCombine(seed, STREAM_COLOR, index) % TRAFFIC_VEHICLE_COLOR_COUNT;
    bouncePhases[index] = worldRandom01(seed, STREAM_BOUNCE, index) * Math.PI * 2;
  }

  return { count, directions, speedsMps, arcOffsetsM, colorIndices, bouncePhases, totalLengthM };
}

/**
 * Arc-length position of vehicle `index` at `worldSeconds`. Pure closed form:
 * loop roads circulate, open roads wrap back to the start (teleport respawn).
 */
export function vehicleArcPositionAt(streams: RoadTrafficStreams, index: number, worldSeconds: number): number {
  const length = streams.totalLengthM;
  if (length <= 1e-9) return 0;
  const travelled = streams.arcOffsetsM[index]! + streams.directions[index]! * streams.speedsMps[index]! * worldSeconds;
  return ((travelled % length) + length) % length;
}

/**
 * Minimum circular pairwise gap within one lane at `worldSeconds`. Test/debug
 * helper backing the no-overtake guarantee; O(n²) on ≤ 24 vehicles.
 */
export function minSameLaneGapAt(streams: RoadTrafficStreams, worldSeconds: number): number {
  const length = streams.totalLengthM;
  let minGap = Number.POSITIVE_INFINITY;
  for (let a = 0; a < streams.count; a += 1) {
    for (let b = a + 1; b < streams.count; b += 1) {
      if (streams.directions[a] !== streams.directions[b]) continue;
      const sa = vehicleArcPositionAt(streams, a, worldSeconds);
      const sb = vehicleArcPositionAt(streams, b, worldSeconds);
      const direct = Math.abs(sa - sb);
      const gap = Math.min(direct, length - direct);
      if (gap < minGap) minGap = gap;
    }
  }
  return minGap;
}
