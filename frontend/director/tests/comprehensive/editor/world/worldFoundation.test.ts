import { describe, expect, it } from "vitest";
import {
  createDefaultDirectorWorld,
  directorWorldSchema,
} from "../../../../../../packages/protocol/src/worldSystemsProtocol";
import { createDefaultDirectorProject } from "../../../../src/comprehensive/editor/store/directorStore";
import {
  repairDirectorProjectReferences,
  safeParseDirectorProject,
} from "../../../../src/comprehensive/editor/schema/directorProjectSchema";
import type { DirectorWorld, DirectorWorldEffect } from "../../../../src/comprehensive/editor/schema/directorProject";
import {
  evaluateWorldTimeOfDayHours,
  getWorldSecondsForFrame,
} from "../../../../src/comprehensive/editor/world/worldTime";
import {
  createWorldRng,
  hashCombine,
  worldRandom01,
  worldStreamId,
} from "../../../../src/comprehensive/editor/world/worldRandom";
import { getWorldWindVector } from "../../../../src/comprehensive/editor/world/worldWind";

function createEffect(overrides: Partial<DirectorWorldEffect> = {}): DirectorWorldEffect {
  return {
    id: "fx_fire_1",
    name: "篝火火焰",
    kind: "fire",
    anchor: { objectId: null, position: [0, 0, 0] },
    shape: { type: "point" },
    intensity: 1,
    sizeScale: 1,
    speedScale: 1,
    windInfluence: 0.5,
    seedOffset: 0,
    visible: true,
    locked: false,
    createdAt: "2026-08-13T12:00:00.000Z",
    ...overrides,
  };
}

describe("world time", () => {
  it("maps frames to seconds by fps", () => {
    expect(getWorldSecondsForFrame(48, 24)).toBe(2);
    expect(getWorldSecondsForFrame(0, 24)).toBe(0);
  });

  it("holds fixed time of day and wraps cycling time", () => {
    const fixed = { mode: "fixed", hours: 14, cycleMinutes: 12, drivesSky: true } as const;
    expect(evaluateWorldTimeOfDayHours(fixed, 10_000)).toBe(14);

    const cycle = { mode: "cycle", hours: 23, cycleMinutes: 1, drivesSky: true } as const;
    // One real minute = 24h; 30s => +12h from 23h => 11h.
    expect(evaluateWorldTimeOfDayHours(cycle, 30)).toBeCloseTo(11, 10);
    expect(evaluateWorldTimeOfDayHours(cycle, 0)).toBeCloseTo(23, 10);
  });
});

describe("world random", () => {
  it("is deterministic for identical inputs and decorrelated across streams", () => {
    expect(worldRandom01(1234, 5, 6)).toBe(worldRandom01(1234, 5, 6));
    expect(worldRandom01(1234, 5, 6)).not.toBe(worldRandom01(1234, 5, 7));
    expect(hashCombine(9, worldStreamId("fire"))).toBe(hashCombine(9, worldStreamId("fire")));
    expect(worldStreamId("fire")).not.toBe(worldStreamId("smoke"));
  });

  it("replays identical sequences from the same seed", () => {
    const first = createWorldRng(42);
    const second = createWorldRng(42);
    const sequenceA = [first(), first(), first()];
    const sequenceB = [second(), second(), second()];
    expect(sequenceA).toEqual(sequenceB);
    sequenceA.forEach((value) => {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    });
  });
});

describe("world wind", () => {
  it("is a pure function of time and follows the direction convention", () => {
    const wind = { directionDegrees: 90, speedMps: 4, gustiness: 0.5, turbulence: 0.2 };
    expect(getWorldWindVector(wind, 12.5)).toEqual(getWorldWindVector(wind, 12.5));

    const calm = { ...wind, gustiness: 0 };
    const [x, , z] = getWorldWindVector(calm, 3);
    expect(x).toBeCloseTo(4, 10);
    expect(z).toBeCloseTo(0, 10);

    const north = getWorldWindVector({ ...calm, directionDegrees: 0 }, 3);
    expect(north[0]).toBeCloseTo(0, 10);
    expect(north[2]).toBeCloseTo(4, 10);
  });
});

describe("world project block", () => {
  it("parses a project carrying a world block and rejects duplicate effect ids", () => {
    const world: DirectorWorld = {
      ...createDefaultDirectorWorld(),
      effects: [createEffect()],
    };
    const project = { ...createDefaultDirectorProject(), world };
    const parsed = safeParseDirectorProject(JSON.parse(JSON.stringify(project)));
    expect(parsed.success).toBe(true);

    const duplicated = directorWorldSchema.safeParse({
      ...world,
      effects: [createEffect(), createEffect()],
    });
    expect(duplicated.success).toBe(false);
  });

  it("repairs effect anchors that reference deleted objects", () => {
    const world: DirectorWorld = {
      ...createDefaultDirectorWorld(),
      effects: [createEffect({ anchor: { objectId: "missing_object", position: [0, 1, 0] } })],
    };
    const project = { ...createDefaultDirectorProject(), world };
    const { project: repaired, repairs } = repairDirectorProjectReferences(project);
    expect(repaired.world?.effects[0]?.anchor.objectId).toBeNull();
    expect(repairs.some((entry) => entry.includes("fx_fire_1"))).toBe(true);
  });
});
