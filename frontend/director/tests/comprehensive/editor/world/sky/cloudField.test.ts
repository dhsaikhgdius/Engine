import { describe, expect, it } from "vitest";
import { createDefaultDirectorWorldSettings } from "../../../../../../../packages/protocol/src/worldSystemsProtocol";
import type { DirectorWorldWeather, DirectorWorldWind } from "../../../../../src/comprehensive/editor/schema/directorProject";
import {
  createSkyCloudPlacements,
  getSkyCloudClusterCount,
  getSkyCloudDriftRadians,
  getSkyCloudPalette,
  getSkyCloudPosition,
  SKY_CLOUD_DRIFT_CIRCUIT_SECONDS,
  SKY_CLOUD_MAX_CLUSTERS,
  SKY_CLOUD_MAX_ELEVATION_RADIANS,
  SKY_CLOUD_MAX_QUAD_SIZE,
  SKY_CLOUD_MAX_QUADS_PER_CLUSTER,
  SKY_CLOUD_MAX_SHELL_RADIUS,
  SKY_CLOUD_MIN_ELEVATION_RADIANS,
  SKY_CLOUD_MIN_QUAD_SIZE,
  SKY_CLOUD_MIN_QUADS_PER_CLUSTER,
  SKY_CLOUD_MIN_SHELL_RADIUS,
} from "../../../../../src/comprehensive/editor/world/sky/cloudField";
import { evaluateSkyWeatherMood } from "../../../../../src/comprehensive/editor/world/sky/skyWeather";
import { evaluateSkyLighting } from "../../../../../src/comprehensive/editor/world/sky/solar";

function wind(overrides: Partial<DirectorWorldWind> = {}): DirectorWorldWind {
  return { directionDegrees: 90, speedMps: 10, gustiness: 0.35, turbulence: 0.3, ...overrides };
}

function weatherOf(overrides: Partial<DirectorWorldWeather> = {}): DirectorWorldWeather {
  return { preset: "clear", intensity: 0.5, wetness: 0.2, cloudCover: 0.3, ...overrides };
}

describe("seeded cloud placement", () => {
  it("reproduces the identical cloudscape for the same seed and differs across seeds", () => {
    expect(createSkyCloudPlacements(123, 0.8)).toEqual(createSkyCloudPlacements(123, 0.8));
    expect(createSkyCloudPlacements(123, 0.8)).not.toEqual(createSkyCloudPlacements(124, 0.8));
  });

  it("keeps every quad inside the elevation band, shell radii, and size/weight ranges", () => {
    const quads = createSkyCloudPlacements(9, 1);
    expect(quads.length).toBeGreaterThan(0);
    for (const quad of quads) {
      expect(quad.elevationRadians).toBeGreaterThanOrEqual(SKY_CLOUD_MIN_ELEVATION_RADIANS - 1e-12);
      expect(quad.elevationRadians).toBeLessThanOrEqual(SKY_CLOUD_MAX_ELEVATION_RADIANS + 1e-12);
      expect(quad.radius).toBeGreaterThanOrEqual(SKY_CLOUD_MIN_SHELL_RADIUS);
      expect(quad.radius).toBeLessThanOrEqual(SKY_CLOUD_MAX_SHELL_RADIUS);
      expect(quad.size).toBeGreaterThanOrEqual(SKY_CLOUD_MIN_QUAD_SIZE);
      expect(quad.size).toBeLessThanOrEqual(SKY_CLOUD_MAX_QUAD_SIZE);
      expect(quad.opacityWeight).toBeGreaterThan(0);
      expect(quad.opacityWeight).toBeLessThanOrEqual(1);
    }
  });

  it("emits full clusters of 3-6 quads at full cover", () => {
    const quads = createSkyCloudPlacements(20260813, 1);
    const quadsPerCluster = new Map<number, number>();
    for (const quad of quads) {
      quadsPerCluster.set(quad.clusterIndex, (quadsPerCluster.get(quad.clusterIndex) ?? 0) + 1);
    }
    expect(quadsPerCluster.size).toBe(SKY_CLOUD_MAX_CLUSTERS);
    for (const count of quadsPerCluster.values()) {
      expect(count).toBeGreaterThanOrEqual(SKY_CLOUD_MIN_QUADS_PER_CLUSTER);
      expect(count).toBeLessThanOrEqual(SKY_CLOUD_MAX_QUADS_PER_CLUSTER);
    }
    expect(quads.length).toBeGreaterThanOrEqual(SKY_CLOUD_MAX_CLUSTERS * SKY_CLOUD_MIN_QUADS_PER_CLUSTER);
    expect(quads.length).toBeLessThanOrEqual(SKY_CLOUD_MAX_CLUSTERS * SKY_CLOUD_MAX_QUADS_PER_CLUSTER);
  });
});

describe("cloud cover to cluster count", () => {
  it("truncates deterministically at the extremes", () => {
    expect(getSkyCloudClusterCount(0)).toBe(0);
    expect(getSkyCloudClusterCount(1)).toBe(SKY_CLOUD_MAX_CLUSTERS);
    // Below 1/18 of cover there is no cluster yet; just above there is exactly one.
    expect(getSkyCloudClusterCount(0.05)).toBe(0);
    expect(getSkyCloudClusterCount(0.06)).toBe(1);
    expect(createSkyCloudPlacements(7, 0)).toEqual([]);
  });

  it("grows monotonically with cover", () => {
    let previous = 0;
    for (let step = 0; step <= 100; step += 1) {
      const count = getSkyCloudClusterCount(step / 100);
      expect(count).toBeGreaterThanOrEqual(previous);
      previous = count;
    }
  });

  it("only appends clusters as cover grows, never moving existing quads", () => {
    const lower = createSkyCloudPlacements(7, 0.4);
    const higher = createSkyCloudPlacements(7, 0.9);
    expect(lower.length).toBeGreaterThan(0);
    expect(higher.length).toBeGreaterThan(lower.length);
    expect(higher.slice(0, lower.length)).toEqual(lower);
  });
});

describe("weather-driven cloudscape", () => {
  it("fills the sky with clusters on overcast and storm even at a low cover slider", () => {
    const clusterCountFor = (weather: DirectorWorldWeather): number =>
      getSkyCloudClusterCount(evaluateSkyWeatherMood(weather).effectiveCloudCover);
    const clear = clusterCountFor(weatherOf({ preset: "clear", cloudCover: 0.2 }));
    const overcast = clusterCountFor(weatherOf({ preset: "overcast", cloudCover: 0.2 }));
    const storm = clusterCountFor(weatherOf({ preset: "storm", cloudCover: 0.2, intensity: 1 }));
    expect(clear).toBeLessThanOrEqual(4);
    expect(overcast).toBeGreaterThanOrEqual(Math.floor(SKY_CLOUD_MAX_CLUSTERS * 0.7));
    expect(storm).toBe(SKY_CLOUD_MAX_CLUSTERS);
    // The five presets remain distinct in visible cluster count.
    const counts = (["clear", "overcast", "rain", "snow", "storm"] as const).map((preset) =>
      clusterCountFor(weatherOf({ preset })),
    );
    expect(new Set(counts).size).toBe(counts.length);
  });

  it("thickens and enlarges cloud quads as the weather worsens", () => {
    const clear = evaluateSkyWeatherMood(weatherOf({ preset: "clear" }));
    const overcast = evaluateSkyWeatherMood(weatherOf({ preset: "overcast" }));
    const storm = evaluateSkyWeatherMood(weatherOf({ preset: "storm" }));
    expect(overcast.cloudOpacityScale).toBeGreaterThan(clear.cloudOpacityScale * 1.3);
    expect(storm.cloudOpacityScale).toBeGreaterThan(overcast.cloudOpacityScale);
    expect(overcast.cloudSizeScale).toBeGreaterThan(clear.cloudSizeScale);
    expect(storm.cloudSizeScale).toBeGreaterThan(overcast.cloudSizeScale);
  });

  it("darkens the storm palette beyond the plain lighting collapse", () => {
    const settings = createDefaultDirectorWorldSettings();
    settings.timeOfDay = { ...settings.timeOfDay, mode: "fixed", hours: 12, drivesSky: true };
    const stormWeather = weatherOf({ preset: "storm", intensity: 1, cloudCover: 0.8 });
    const stormSettings = { ...settings, weather: stormWeather };
    const lighting = evaluateSkyLighting(stormSettings, 0);
    const plain = getSkyCloudPalette(lighting);
    const weathered = getSkyCloudPalette(lighting, stormWeather);
    expect(weathered.top[0]).toBeLessThan(plain.top[0]);
    expect(weathered.bottom[1]).toBeLessThan(plain.bottom[1]);
    // Clear weather leaves the palette untouched.
    const clearWeather = weatherOf({ preset: "clear" });
    const clearLighting = evaluateSkyLighting({ ...settings, weather: clearWeather }, 0);
    expect(getSkyCloudPalette(clearLighting, clearWeather)).toEqual(getSkyCloudPalette(clearLighting));
  });
});

describe("cloud drift", () => {
  it("is a pure linear function of worldSeconds: t vs t+delta rotates by the expected angle", () => {
    const easterly = wind({ directionDegrees: 90, speedMps: 10 });
    const angularSpeed = (Math.PI * 2) / SKY_CLOUD_DRIFT_CIRCUIT_SECONDS;
    expect(getSkyCloudDriftRadians(easterly, 500)).toBe(getSkyCloudDriftRadians(easterly, 500));
    for (const t of [0, 1234.5, 100000]) {
      const delta = getSkyCloudDriftRadians(easterly, t + 600) - getSkyCloudDriftRadians(easterly, t);
      expect(delta).toBeCloseTo(angularSpeed * 600, 9);
    }
    // Full circuit after two hours at the 10 m/s reference wind.
    expect(getSkyCloudDriftRadians(easterly, SKY_CLOUD_DRIFT_CIRCUIT_SECONDS)).toBeCloseTo(Math.PI * 2, 9);
  });

  it("scales with wind speed and projects the wind direction onto the yaw axis", () => {
    const t = 3600;
    const atTen = getSkyCloudDriftRadians(wind({ speedMps: 10 }), t);
    const atTwenty = getSkyCloudDriftRadians(wind({ speedMps: 20 }), t);
    expect(atTwenty).toBeCloseTo(atTen * 2, 9);
    // A westerly reverses the rotation; a due-north wind yields no azimuthal drift.
    expect(getSkyCloudDriftRadians(wind({ directionDegrees: 270 }), t)).toBeCloseTo(-atTen, 9);
    expect(getSkyCloudDriftRadians(wind({ directionDegrees: 0 }), t)).toBeCloseTo(0, 12);
  });

  it("rotates quad positions around +Y, preserving height and shell radius", () => {
    const quads = createSkyCloudPlacements(1, 1);
    const quad = quads[0];
    const drift = 0.35;
    const before = getSkyCloudPosition(quad, 0);
    const after = getSkyCloudPosition(quad, drift);
    expect(after[1]).toBeCloseTo(before[1], 9);
    expect(Math.hypot(...after)).toBeCloseTo(Math.hypot(...before), 9);
    const azimuthBefore = Math.atan2(before[0], before[2]);
    const azimuthAfter = Math.atan2(after[0], after[2]);
    const turned = ((azimuthAfter - azimuthBefore + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    expect(turned).toBeCloseTo(drift, 9);
  });
});
