import { describe, expect, it } from "vitest";
import {
  DIRECTOR_WORLD_PROTOCOL_VERSION,
  DIRECTOR_WORLD_WEATHER_DEFAULT_PERIOD_SECONDS,
  createDefaultDirectorWorld,
  createDefaultDirectorWorldSettings,
  directorWorldEffectSchema,
  directorWorldSchema,
  directorWorldWeatherSchema,
} from "../src/worldSystemsProtocol";

/** A pre-evolution world block exactly as older projects persisted it. */
function legacyWorldJson() {
  return {
    version: DIRECTOR_WORLD_PROTOCOL_VERSION,
    settings: {
      enabled: true,
      seed: 42,
      wind: { directionDegrees: 45, speedMps: 2.5, gustiness: 0.35, turbulence: 0.3 },
      timeOfDay: { mode: "fixed", hours: 14, cycleMinutes: 12, drivesSky: false },
      weather: { preset: "rain", intensity: 0.8, wetness: 0.2, cloudCover: 0.6 },
    },
    effects: [
      {
        id: "fx_fire_1",
        name: "火焰",
        kind: "fire",
        anchor: { objectId: null, position: [1, 0, 2] },
        shape: { type: "point" },
        intensity: 1,
        sizeScale: 1,
        speedScale: 1,
        windInfluence: 0.35,
        seedOffset: 0,
        visible: true,
        locked: false,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    waterBodies: [],
    wildlife: [],
  };
}

describe("world protocol backward compatibility", () => {
  it("parses a pre-evolution world block without the new fields", () => {
    const parsed = directorWorldSchema.parse(legacyWorldJson());
    expect(parsed.settings.weather.evolution).toBeUndefined();
    expect(parsed.effects[0].propagation).toBeUndefined();
    expect(parsed.roads).toEqual([]);
  });

  it("keeps the protocol version at 1 (additive fields only)", () => {
    expect(DIRECTOR_WORLD_PROTOCOL_VERSION).toBe(1);
    const world = createDefaultDirectorWorld();
    expect(directorWorldSchema.parse(world)).toEqual(world);
  });

  it("default settings still ship without an evolution block", () => {
    expect(createDefaultDirectorWorldSettings().weather.evolution).toBeUndefined();
  });
});

describe("weather evolution schema", () => {
  it("defaults periodSeconds when only the mode is supplied", () => {
    const parsed = directorWorldWeatherSchema.parse({
      preset: "clear",
      intensity: 0.5,
      wetness: 0,
      cloudCover: 0.2,
      evolution: { mode: "cycle" },
    });
    expect(parsed.evolution).toEqual({
      mode: "cycle",
      periodSeconds: DIRECTOR_WORLD_WEATHER_DEFAULT_PERIOD_SECONDS,
    });
  });

  it("rejects unknown evolution modes and out-of-range periods", () => {
    const base = { preset: "clear", intensity: 0.5, wetness: 0, cloudCover: 0.2 };
    expect(directorWorldWeatherSchema.safeParse({ ...base, evolution: { mode: "chaos" } }).success).toBe(false);
    expect(
      directorWorldWeatherSchema.safeParse({ ...base, evolution: { mode: "cycle", periodSeconds: 10 } }).success,
    ).toBe(false);
    expect(
      directorWorldWeatherSchema.safeParse({ ...base, evolution: { mode: "cycle", periodSeconds: 7200 } }).success,
    ).toBe(false);
  });
});

describe("fire propagation schema", () => {
  const baseEffect = legacyWorldJson().effects[0];

  it("defaults radius and spread rate when only enabled is supplied", () => {
    const parsed = directorWorldEffectSchema.parse({ ...baseEffect, propagation: { enabled: true } });
    expect(parsed.propagation).toEqual({ enabled: true, radiusM: 12, spreadRate: 1 });
  });

  it("round-trips explicit propagation parameters", () => {
    const parsed = directorWorldEffectSchema.parse({
      ...baseEffect,
      propagation: { enabled: true, radiusM: 24, spreadRate: 1.5 },
    });
    expect(parsed.propagation).toEqual({ enabled: true, radiusM: 24, spreadRate: 1.5 });
  });

  it("rejects out-of-range propagation parameters", () => {
    expect(
      directorWorldEffectSchema.safeParse({ ...baseEffect, propagation: { enabled: true, radiusM: 1000 } }).success,
    ).toBe(false);
    expect(
      directorWorldEffectSchema.safeParse({ ...baseEffect, propagation: { enabled: true, spreadRate: 0 } }).success,
    ).toBe(false);
  });
});
