import { beforeEach, describe, expect, it } from "vitest";
import { createDefaultDirectorWorld } from "../../../../../../packages/protocol/src/worldSystemsProtocol";
import type { DirectorWorld } from "../../../../src/comprehensive/editor/schema/directorProject";
import {
  advanceWorldAmbientClock,
  isDirectorWorldAmbientActive,
  isWorldAmbientClockSuspended,
  resetWorldAmbientClock,
  setWorldAmbientClockSuspended,
  useWorldClockStore,
} from "../../../../src/comprehensive/editor/world/worldClock";

function offset() {
  return useWorldClockStore.getState().ambientOffsetSeconds;
}

/** Default world block: enabled, fixed 14h, drivesSky off, clear weather, no systems. */
function staticWorld(): DirectorWorld {
  return createDefaultDirectorWorld();
}

describe("world ambient clock", () => {
  beforeEach(() => {
    useWorldClockStore.setState({ ambientOffsetSeconds: 0, suspended: false, suspensionDepth: 0 });
  });

  it("accumulates positive finite deltas and ignores everything else", () => {
    advanceWorldAmbientClock(0.5);
    advanceWorldAmbientClock(0.25);
    expect(offset()).toBeCloseTo(0.75, 12);

    for (const junk of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      advanceWorldAmbientClock(junk);
    }
    expect(offset()).toBeCloseTo(0.75, 12);
  });

  it("blocks advancement while suspended and resumes after release", () => {
    setWorldAmbientClockSuspended(true);
    advanceWorldAmbientClock(1);
    expect(offset()).toBe(0);

    setWorldAmbientClockSuspended(false);
    advanceWorldAmbientClock(1);
    expect(offset()).toBe(1);
  });

  it("treats suspension as a balanced hold count for nested capture sessions", () => {
    // Export session acquires, then a per-frame capture acquires and releases.
    setWorldAmbientClockSuspended(true);
    setWorldAmbientClockSuspended(true);
    setWorldAmbientClockSuspended(false);
    advanceWorldAmbientClock(1);
    expect(offset()).toBe(0);
    expect(useWorldClockStore.getState().suspended).toBe(true);

    setWorldAmbientClockSuspended(false);
    advanceWorldAmbientClock(1);
    expect(offset()).toBe(1);
  });

  it("clamps an unbalanced release at zero instead of going negative", () => {
    setWorldAmbientClockSuspended(false);
    expect(useWorldClockStore.getState().suspensionDepth).toBe(0);
    expect(isWorldAmbientClockSuspended()).toBe(false);
    setWorldAmbientClockSuspended(true);
    advanceWorldAmbientClock(1);
    expect(offset()).toBe(0);
    expect(isWorldAmbientClockSuspended()).toBe(true);
    setWorldAmbientClockSuspended(false);
  });

  it("resets the accumulated offset", () => {
    advanceWorldAmbientClock(2.5);
    expect(offset()).toBeCloseTo(2.5, 12);
    resetWorldAmbientClock();
    expect(offset()).toBe(0);
  });
});

describe("isDirectorWorldAmbientActive", () => {
  it("is inactive for missing, disabled, or fully static worlds", () => {
    expect(isDirectorWorldAmbientActive(undefined)).toBe(false);
    expect(isDirectorWorldAmbientActive(null)).toBe(false);
    expect(isDirectorWorldAmbientActive(staticWorld())).toBe(false);

    const disabled = staticWorld();
    disabled.settings.enabled = false;
    disabled.settings.timeOfDay.mode = "cycle";
    expect(isDirectorWorldAmbientActive(disabled)).toBe(false);
  });

  it("activates for any continuously evolving world setting or system", () => {
    const cycling = staticWorld();
    cycling.settings.timeOfDay.mode = "cycle";
    expect(isDirectorWorldAmbientActive(cycling)).toBe(true);

    const skyDriven = staticWorld();
    skyDriven.settings.timeOfDay.drivesSky = true;
    expect(isDirectorWorldAmbientActive(skyDriven)).toBe(true);

    const raining = staticWorld();
    raining.settings.weather.preset = "rain";
    expect(isDirectorWorldAmbientActive(raining)).toBe(true);

    const withEffect = staticWorld();
    withEffect.effects.push({
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
    });
    expect(isDirectorWorldAmbientActive(withEffect)).toBe(true);

    const withWater = staticWorld();
    withWater.waterBodies.push({
      id: "water_1",
      name: "湖面",
      surface: { center: [0, 0, 0], sizeX: 10, sizeZ: 10, rotationDegrees: 0 },
      waveAmplitude: 0.2,
      waveLengthM: 4,
      flowDirectionDegrees: 0,
      flowSpeedMps: 0.5,
      colorShallow: "#3fa9f5",
      colorDeep: "#0b2e4f",
      opacity: 0.8,
      foamIntensity: 0.4,
      visible: true,
      locked: false,
    });
    expect(isDirectorWorldAmbientActive(withWater)).toBe(true);

    const withWildlife = staticWorld();
    withWildlife.wildlife.push({
      id: "flock_1",
      name: "鸟群",
      species: "birds",
      count: 12,
      area: { center: [0, 10, 0], radius: 30 },
      speedScale: 1,
      sizeScale: 1,
      seedOffset: 0,
      visible: true,
      locked: false,
    });
    expect(isDirectorWorldAmbientActive(withWildlife)).toBe(true);
  });
});
