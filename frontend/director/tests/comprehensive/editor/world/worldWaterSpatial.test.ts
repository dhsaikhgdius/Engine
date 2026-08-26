import { describe, expect, it } from "vitest";
import type {
  DirectorWorldRoad,
  DirectorWorldWaterBody,
} from "../../../../src/comprehensive/editor/schema/directorProject";
import {
  buildWaterSpatialIndex,
  evaluateCombustionWaterFactor,
  findCombustionWaterConflict,
  findRoadWaterConflict,
  queryWaterSurfaceCeiling,
  raiseRoadAboveWater,
} from "../../../../src/comprehensive/editor/world/worldWaterSpatial";

function waterBody(overrides: Partial<DirectorWorldWaterBody> = {}): DirectorWorldWaterBody {
  return {
    id: "water-1",
    name: "水体",
    surface: { center: [0, 0, 0], sizeX: 10, sizeZ: 2, rotationDegrees: 0 },
    waveAmplitude: 0.1,
    waveLengthM: 8,
    flowDirectionDegrees: 0,
    flowSpeedMps: 0.4,
    colorShallow: "#4fa8c7",
    colorDeep: "#0b2e4f",
    opacity: 0.9,
    foamIntensity: 0.5,
    visible: true,
    locked: false,
    ...overrides,
  };
}

function road(overrides: Partial<DirectorWorldRoad> = {}): DirectorWorldRoad {
  return {
    id: "road-1",
    name: "道路",
    points: [
      [-15, 0, 0],
      [0, 0.2, 0],
      [15, 0.4, 0],
    ],
    widthM: 4,
    loop: false,
    vehicleCount: 4,
    speedKph: 35,
    showSurface: true,
    seedOffset: 0,
    visible: true,
    locked: false,
    ...overrides,
  };
}

describe("world water spatial index", () => {
  it("queries a rotated basin in its local frame", () => {
    const water = buildWaterSpatialIndex([
      waterBody({
        surface: { center: [0, 1, 0], sizeX: 10, sizeZ: 2, rotationDegrees: 90 },
        waveAmplitude: 0.2,
      }),
    ]);

    expect(queryWaterSurfaceCeiling(water, 0, 4)).toBeCloseTo(1.2);
    expect(queryWaterSurfaceCeiling(water, 4, 0)).toBeNull();
  });

  it("matches the renderer's trough lift when a water body meets the ground plane", () => {
    const water = buildWaterSpatialIndex([waterBody()], 0);

    // Mean 0 + 0.12 m trough lift + 0.1 m crest = 0.22 m.
    expect(queryWaterSurfaceCeiling(water, 0, 0)).toBeCloseTo(0.22);
  });

  it("uses the rendered river ribbon instead of its placeholder surface rectangle", () => {
    const water = buildWaterSpatialIndex([
      waterBody({
        surface: { center: [100, 100, 100], sizeX: 500, sizeZ: 500, rotationDegrees: 0 },
        river: {
          points: [
            [0, 1, 0],
            [10, 2, 0],
          ],
          widthM: 4,
        },
        waveAmplitude: 0.2,
      }),
    ]);

    expect(queryWaterSurfaceCeiling(water, 5, 1)).toBeCloseTo(1.5 + 0.2 * 1.22, 4);
    expect(queryWaterSurfaceCeiling(water, 5, 3)).toBeNull();
    expect(queryWaterSurfaceCeiling(water, 100, 100)).toBeNull();
  });

  it("fully suppresses submerged combustion and recovers above the crest", () => {
    const water = buildWaterSpatialIndex([
      waterBody({ surface: { center: [0, 0, 0], sizeX: 20, sizeZ: 20, rotationDegrees: 0 } }),
    ]);

    expect(evaluateCombustionWaterFactor([0, 0, 0], water)).toBe(0);
    expect(evaluateCombustionWaterFactor([0, 0.35, 0], water)).toBe(1);
    expect(evaluateCombustionWaterFactor([20, 0, 0], water)).toBe(1);
  });

  it("returns the semantic lift needed for submerged combustion", () => {
    const water = buildWaterSpatialIndex(
      [waterBody({ surface: { center: [0, 0, 0], sizeX: 20, sizeZ: 20, rotationDegrees: 0 } })],
      0,
    );
    const conflict = findCombustionWaterConflict([0, 0, 0], water)!;

    expect(conflict.waterCeilingY).toBeCloseTo(0.22);
    expect(conflict.requiredLiftM).toBeCloseTo(0.47);
    expect(findCombustionWaterConflict([0, conflict.requiredLiftM, 0], water)).toBeNull();
  });

  it("detects a full-width road intersection but accepts a road above the crest", () => {
    const water = buildWaterSpatialIndex([
      waterBody({ surface: { center: [0, 0, 0], sizeX: 20, sizeZ: 20, rotationDegrees: 0 } }),
    ]);

    expect(findRoadWaterConflict(road(), water)?.requiredLiftM).toBeGreaterThan(0);
    expect(
      findRoadWaterConflict(
        road({
          points: [
            [-15, 2, 0],
            [0, 2.2, 0],
            [15, 2.4, 0],
          ],
        }),
        water,
      ),
    ).toBeNull();
  });

  it("raises a conflicting road uniformly and preserves its grade", () => {
    const water = buildWaterSpatialIndex([
      waterBody({ surface: { center: [0, 0, 0], sizeX: 20, sizeZ: 20, rotationDegrees: 0 } }),
    ]);
    const original = road();
    const conflict = findRoadWaterConflict(original, water)!;
    const raised = raiseRoadAboveWater(original, conflict);

    expect(raised.points[1]![1] - raised.points[0]![1]).toBeCloseTo(0.2);
    expect(raised.points[2]![1] - raised.points[1]![1]).toBeCloseTo(0.2);
    expect(findRoadWaterConflict(raised, water)).toBeNull();
  });
});
