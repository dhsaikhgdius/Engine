import { describe, expect, it } from "vitest";
import { buildRoadSpline, type RoadVec3 } from "../../../../../src/comprehensive/editor/world/traffic/roadSpline";
import {
  buildRoadTrafficStreams,
  minSameLaneGapAt,
  TRAFFIC_MIN_GAP_M,
  TRAFFIC_VEHICLE_COLOR_COUNT,
  vehicleArcPositionAt,
  type TrafficRoadInput,
} from "../../../../../src/comprehensive/editor/world/traffic/trafficFlow";

const CITY_LOOP_POINTS: readonly RoadVec3[] = [
  [30, 0.05, 20],
  [0, 0.05, 20],
  [-30, 0.05, 20],
  [-30, 0.05, 0],
  [-30, 0.05, -20],
  [0, 0.05, -20],
  [30, 0.05, -20],
  [30, 0.05, 0],
];

/** The panel's default rounded rectangle (24 × 16 m). */
const DEFAULT_PANEL_LOOP_POINTS: readonly RoadVec3[] = [
  [12, 0.05, 8],
  [0, 0.05, 8],
  [-12, 0.05, 8],
  [-12, 0.05, 0],
  [-12, 0.05, -8],
  [0, 0.05, -8],
  [12, 0.05, -8],
  [12, 0.05, 0],
];

const ROAD: TrafficRoadInput = { id: "road_1", seedOffset: 0, vehicleCount: 12, speedKph: 60 };

describe("trafficFlow", () => {
  it("derives deterministic per-vehicle streams that respond to the road identity", () => {
    const first = buildRoadTrafficStreams(ROAD, 42, 200);
    const second = buildRoadTrafficStreams(ROAD, 42, 200);
    expect([...first.arcOffsetsM]).toEqual([...second.arcOffsetsM]);
    expect([...first.speedsMps]).toEqual([...second.speedsMps]);
    expect([...first.colorIndices]).toEqual([...second.colorIndices]);

    const otherRoad = buildRoadTrafficStreams({ ...ROAD, id: "road_2" }, 42, 200);
    expect([...otherRoad.arcOffsetsM]).not.toEqual([...first.arcOffsetsM]);
    const otherSeed = buildRoadTrafficStreams(ROAD, 43, 200);
    expect([...otherSeed.arcOffsetsM]).not.toEqual([...first.arcOffsetsM]);
  });

  it("splits vehicles into two directed lanes and hashes speeds within 0.85..1.15 × limit", () => {
    const streams = buildRoadTrafficStreams(ROAD, 42, 200);
    const forward = [...streams.directions].filter((direction) => direction === 1);
    const backward = [...streams.directions].filter((direction) => direction === -1);
    expect(forward.length).toBe(6);
    expect(backward.length).toBe(6);

    const odd = buildRoadTrafficStreams({ ...ROAD, vehicleCount: 5 }, 42, 200);
    expect([...odd.directions].filter((direction) => direction === 1).length).toBe(3);
    expect([...odd.directions].filter((direction) => direction === -1).length).toBe(2);

    const baseMps = 60 / 3.6;
    for (let index = 0; index < streams.count; index += 1) {
      expect(streams.speedsMps[index]!).toBeGreaterThanOrEqual(baseMps * 0.85);
      expect(streams.speedsMps[index]!).toBeLessThanOrEqual(baseMps * 1.15);
    }
    // No-overtake choice: one shared hashed speed per lane.
    const laneSpeeds = new Set([...streams.speedsMps].map((speed, index) => `${streams.directions[index]}:${speed}`));
    expect(laneSpeeds.size).toBe(2);
  });

  it("evaluates positions as a pure closed form that wraps in both time directions", () => {
    const streams = buildRoadTrafficStreams(ROAD, 42, 180);
    for (let index = 0; index < streams.count; index += 1) {
      expect(vehicleArcPositionAt(streams, index, 0)).toBeCloseTo(streams.arcOffsetsM[index]!, 9);
      const forwardWay = vehicleArcPositionAt(streams, index, 3600);
      const backwardWay = vehicleArcPositionAt(streams, index, -3600);
      expect(forwardWay).toBeGreaterThanOrEqual(0);
      expect(forwardWay).toBeLessThan(180);
      expect(backwardWay).toBeGreaterThanOrEqual(0);
      expect(backwardWay).toBeLessThan(180);
    }
    // Scrub-anywhere determinism: evaluation order cannot matter.
    const late = vehicleArcPositionAt(streams, 3, 1234.5);
    vehicleArcPositionAt(streams, 3, 9.25);
    expect(vehicleArcPositionAt(streams, 3, 1234.5)).toBe(late);
  });

  it("never lets same-lane vehicles close within 7 m on representative roads", () => {
    const cityLoop = buildRoadSpline(CITY_LOOP_POINTS, true);
    const panelLoop = buildRoadSpline(DEFAULT_PANEL_LOOP_POINTS, true);
    const openRoad = buildRoadSpline(
      [
        [-75, 0, 0],
        [0, 0, 6],
        [75, 0, 0],
      ],
      false,
    );
    const configs = [
      { streams: buildRoadTrafficStreams(ROAD, 42, cityLoop.totalLengthM), label: "city loop 12 cars" },
      {
        streams: buildRoadTrafficStreams(
          { id: "road_default", seedOffset: 3, vehicleCount: 6, speedKph: 40 },
          7,
          panelLoop.totalLengthM,
        ),
        label: "panel default loop 6 cars",
      },
      {
        streams: buildRoadTrafficStreams(
          { id: "road_open", seedOffset: 9, vehicleCount: 8, speedKph: 90 },
          11,
          openRoad.totalLengthM,
        ),
        label: "open road 8 cars",
      },
    ];
    for (const config of configs) {
      let minGap = Number.POSITIVE_INFINITY;
      // Long horizon both directions; prime-ish step avoids period aliasing.
      for (let t = -1800; t <= 3600; t += 7.3) {
        minGap = Math.min(minGap, minSameLaneGapAt(config.streams, t));
      }
      expect(minGap, config.label).toBeGreaterThanOrEqual(TRAFFIC_MIN_GAP_M);
      // Shared per-lane speed keeps gaps constant, not merely bounded.
      expect(minSameLaneGapAt(config.streams, 0)).toBeCloseTo(minSameLaneGapAt(config.streams, 2400), 6);
    }
  });

  it("applies a uniform lane speed scale (storm slowdown) without breaking no-overtake", () => {
    const cityLoop = buildRoadSpline(CITY_LOOP_POINTS, true);
    const base = buildRoadTrafficStreams(ROAD, 42, cityLoop.totalLengthM);
    const storm = buildRoadTrafficStreams(ROAD, 42, cityLoop.totalLengthM, 0.55);

    // The whole lane scales at once: exactly one speed per lane, and the
    // hashed 0.85..1.15 band applies to the SCALED base.
    const laneSpeeds = new Set([...storm.speedsMps].map((speed, index) => `${storm.directions[index]}:${speed}`));
    expect(laneSpeeds.size).toBe(2);
    const scaledBaseMps = (60 / 3.6) * 0.55;
    for (let index = 0; index < storm.count; index += 1) {
      expect(storm.speedsMps[index]!).toBeCloseTo(base.speedsMps[index]! * 0.55, 9);
      expect(storm.speedsMps[index]!).toBeGreaterThanOrEqual(scaledBaseMps * 0.85);
      expect(storm.speedsMps[index]!).toBeLessThanOrEqual(scaledBaseMps * 1.15);
    }
    // Slot offsets are untouched by the scale.
    expect([...storm.arcOffsetsM]).toEqual([...base.arcOffsetsM]);

    // Same-lane gaps stay constant and above the guarantee forever.
    let minGap = Number.POSITIVE_INFINITY;
    for (let t = -1800; t <= 3600; t += 7.3) {
      minGap = Math.min(minGap, minSameLaneGapAt(storm, t));
    }
    expect(minGap).toBeGreaterThanOrEqual(TRAFFIC_MIN_GAP_M);
    expect(minSameLaneGapAt(storm, 0)).toBeCloseTo(minSameLaneGapAt(storm, 2400), 6);
  });

  it("returns identical positions for seek(t) and play-to-t evaluation orders", () => {
    const streams = buildRoadTrafficStreams(ROAD, 42, 180, 0.7);
    const target = 137.25;
    // Direct seek: one evaluation at the target time.
    const seeked: number[] = [];
    for (let index = 0; index < streams.count; index += 1) {
      seeked.push(vehicleArcPositionAt(streams, index, target));
    }
    // Play-to-t: step through every intermediate frame first (24 fps), the
    // way playback reaches the same world time.
    const played: number[] = [];
    for (let index = 0; index < streams.count; index += 1) {
      let position = 0;
      for (let t = 0; t <= target + 1e-9; t += 1 / 24) {
        position = vehicleArcPositionAt(streams, index, Math.min(t, target));
      }
      position = vehicleArcPositionAt(streams, index, target);
      played.push(position);
    }
    expect(played).toEqual(seeked);
  });

  it("hashes palette indices and bounce phases into range", () => {
    const streams = buildRoadTrafficStreams({ ...ROAD, vehicleCount: 24 }, 42, 200);
    for (let index = 0; index < streams.count; index += 1) {
      expect(streams.colorIndices[index]!).toBeGreaterThanOrEqual(0);
      expect(streams.colorIndices[index]!).toBeLessThan(TRAFFIC_VEHICLE_COLOR_COUNT);
      expect(streams.bouncePhases[index]!).toBeGreaterThanOrEqual(0);
      expect(streams.bouncePhases[index]!).toBeLessThan(Math.PI * 2);
    }
    // The palette should actually get used across a full road.
    expect(new Set([...streams.colorIndices]).size).toBeGreaterThan(2);
  });

  it("degrades safely on zero-length roads", () => {
    const streams = buildRoadTrafficStreams(ROAD, 42, 0);
    expect(vehicleArcPositionAt(streams, 0, 100)).toBe(0);
  });
});
