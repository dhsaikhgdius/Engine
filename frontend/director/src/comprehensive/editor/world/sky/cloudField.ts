import type { DirectorWorldWeather, DirectorWorldWind } from "../../schema/directorProject";
import { hashCombine, worldRandom01, worldStreamId } from "../worldRandom";
import { evaluateSkyWeatherMood } from "./skyWeather";
import { SKY_NOON_SUN_INTENSITY, type SkyLightingState } from "./solar";

/**
 * Seeded cloud placement and drift for the Living World sky layer.
 *
 * Everything in this module is a pure function of `(seed, cloudCover)` for
 * placement and `(wind, worldSeconds)` for drift — no Math.random, no wall
 * clock — so identical projects render the identical cloudscape across
 * sessions, scrubs, and exports.
 *
 * The cloudscape is a set of clusters on a dome shell; each cluster is a
 * handful of soft billboard quads jittered around the cluster anchor. Cloud
 * cover maps monotonically onto the number of visible clusters: growing cover
 * only appends clusters at the tail of the list, so already-placed puffs never
 * move when the user nudges the weather.
 */

export const SKY_CLOUD_MAX_CLUSTERS = 18;
export const SKY_CLOUD_MIN_QUADS_PER_CLUSTER = 3;
export const SKY_CLOUD_MAX_QUADS_PER_CLUSTER = 6;
export const SKY_CLOUD_MAX_QUAD_COUNT = SKY_CLOUD_MAX_CLUSTERS * SKY_CLOUD_MAX_QUADS_PER_CLUSTER;

/** Shell radii sit inside the star field (1500 m) and the sky dome half-extent (2000 m). */
export const SKY_CLOUD_MIN_SHELL_RADIUS = 800;
export const SKY_CLOUD_MAX_SHELL_RADIUS = 1500;

/** Elevation band: high enough to clear terrain silhouettes, low enough to read in wide shots. */
export const SKY_CLOUD_MIN_ELEVATION_RADIANS = (12 * Math.PI) / 180;
export const SKY_CLOUD_MAX_ELEVATION_RADIANS = (45 * Math.PI) / 180;

export const SKY_CLOUD_MIN_QUAD_SIZE = 60;
export const SKY_CLOUD_MAX_QUAD_SIZE = 220;

/** Drift calibration: a full dome circuit takes two hours under a 10 m/s easterly. */
export const SKY_CLOUD_DRIFT_CIRCUIT_SECONDS = 7200;
export const SKY_CLOUD_DRIFT_REFERENCE_WIND_MPS = 10;

const SKY_CLOUD_STREAM = worldStreamId("sky-clouds");

/** Cluster footprint jitter in tangential metres, converted to angles per shell radius. */
const CLUSTER_AZIMUTH_SPREAD_METRES = 340;
const CLUSTER_ELEVATION_SPREAD_METRES = 150;
const CLUSTER_RADIUS_SPREAD_METRES = 120;
const MIN_OPACITY_WEIGHT = 0.55;

/** Stable stream field ids — never renumber, or every existing sky changes. */
const FIELD_CLUSTER_AZIMUTH = 1;
const FIELD_CLUSTER_ELEVATION = 2;
const FIELD_CLUSTER_RADIUS = 3;
const FIELD_CLUSTER_QUAD_COUNT = 4;
const FIELD_QUAD_AZIMUTH = 5;
const FIELD_QUAD_ELEVATION = 6;
const FIELD_QUAD_RADIUS = 7;
const FIELD_QUAD_SIZE = 8;
const FIELD_QUAD_WEIGHT = 9;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const clamp01 = (value: number) => clamp(value, 0, 1);
const lerp = (from: number, to: number, t: number) => from + (to - from) * t;

export interface SkyCloudQuad {
  /** Index of the parent cluster; quads are emitted cluster-major. */
  clusterIndex: number;
  /** Base azimuth (radians clockwise from +Z) before wind drift is applied. */
  azimuthRadians: number;
  /** Elevation above the horizon, clamped to the cloud band. */
  elevationRadians: number;
  /** Distance from the world origin along the dome shell, metres. */
  radius: number;
  /** Billboard quad width, metres. */
  size: number;
  /** Per-quad opacity multiplier in [MIN_OPACITY_WEIGHT, 1]. */
  opacityWeight: number;
}

/**
 * Deterministic cluster count for a cloud-cover fraction: 0 → no clusters,
 * 1 → the full set, truncating (never rounding up) in between so the count is
 * monotonic in cover and stable against tiny cover edits.
 */
export function getSkyCloudClusterCount(cloudCover: number, maxClusters = SKY_CLOUD_MAX_CLUSTERS): number {
  if (!Number.isFinite(cloudCover)) return 0;
  return Math.floor(clamp01(cloudCover) * maxClusters);
}

/**
 * Seeded cloud quads, emitted cluster-major. For a fixed seed the first
 * `getSkyCloudClusterCount(a)` clusters are byte-identical for any cover
 * `b >= a`: cover only truncates the tail of the full placement list.
 */
export function createSkyCloudPlacements(seed: number, cloudCover: number): SkyCloudQuad[] {
  const clusterCount = getSkyCloudClusterCount(cloudCover);
  const fieldSeed = hashCombine(seed, SKY_CLOUD_STREAM);
  const quads: SkyCloudQuad[] = [];
  for (let cluster = 0; cluster < clusterCount; cluster += 1) {
    const azimuth = worldRandom01(fieldSeed, cluster, FIELD_CLUSTER_AZIMUTH) * Math.PI * 2;
    const elevation = lerp(
      SKY_CLOUD_MIN_ELEVATION_RADIANS,
      SKY_CLOUD_MAX_ELEVATION_RADIANS,
      worldRandom01(fieldSeed, cluster, FIELD_CLUSTER_ELEVATION),
    );
    const radius = lerp(
      SKY_CLOUD_MIN_SHELL_RADIUS,
      SKY_CLOUD_MAX_SHELL_RADIUS,
      worldRandom01(fieldSeed, cluster, FIELD_CLUSTER_RADIUS),
    );
    const quadCount =
      SKY_CLOUD_MIN_QUADS_PER_CLUSTER +
      Math.floor(
        worldRandom01(fieldSeed, cluster, FIELD_CLUSTER_QUAD_COUNT) *
          (SKY_CLOUD_MAX_QUADS_PER_CLUSTER - SKY_CLOUD_MIN_QUADS_PER_CLUSTER + 1),
      );
    for (let quad = 0; quad < quadCount; quad += 1) {
      const azimuthJitter =
        (worldRandom01(fieldSeed, cluster, FIELD_QUAD_AZIMUTH, quad) - 0.5) * (CLUSTER_AZIMUTH_SPREAD_METRES / radius);
      const elevationJitter =
        (worldRandom01(fieldSeed, cluster, FIELD_QUAD_ELEVATION, quad) - 0.5) *
        (CLUSTER_ELEVATION_SPREAD_METRES / radius);
      const radiusJitter =
        (worldRandom01(fieldSeed, cluster, FIELD_QUAD_RADIUS, quad) - 0.5) * CLUSTER_RADIUS_SPREAD_METRES;
      quads.push({
        clusterIndex: cluster,
        azimuthRadians: azimuth + azimuthJitter,
        elevationRadians: clamp(
          elevation + elevationJitter,
          SKY_CLOUD_MIN_ELEVATION_RADIANS,
          SKY_CLOUD_MAX_ELEVATION_RADIANS,
        ),
        radius: clamp(radius + radiusJitter, SKY_CLOUD_MIN_SHELL_RADIUS, SKY_CLOUD_MAX_SHELL_RADIUS),
        size: lerp(
          SKY_CLOUD_MIN_QUAD_SIZE,
          SKY_CLOUD_MAX_QUAD_SIZE,
          worldRandom01(fieldSeed, cluster, FIELD_QUAD_SIZE, quad),
        ),
        opacityWeight: lerp(MIN_OPACITY_WEIGHT, 1, worldRandom01(fieldSeed, cluster, FIELD_QUAD_WEIGHT, quad)),
      });
    }
  }
  return quads;
}

/**
 * Wind drift as a rigid yaw of the whole cloud shell, in radians of azimuth.
 *
 * A yaw around +Y can only advect clouds azimuthally, so the wind vector is
 * projected onto the east–west axis (sin of its azimuth): a full 10 m/s
 * easterly completes one dome circuit in two hours, a westerly reverses the
 * rotation, and a due north/south wind produces no azimuthal drift. Uses the
 * steady `speedMps`, not the gusted speed — accumulating gusts would require
 * integrating history, and drift must remain a pure linear function of
 * `worldSeconds`.
 */
export function getSkyCloudDriftRadians(wind: DirectorWorldWind, worldSeconds: number): number {
  const eastwardProjection = Math.sin((wind.directionDegrees * Math.PI) / 180);
  const angularSpeed =
    ((Math.PI * 2) / SKY_CLOUD_DRIFT_CIRCUIT_SECONDS) * (wind.speedMps / SKY_CLOUD_DRIFT_REFERENCE_WIND_MPS);
  return angularSpeed * eastwardProjection * worldSeconds;
}

/** World-space quad anchor for a placement after applying the drift yaw. */
export function getSkyCloudPosition(quad: SkyCloudQuad, driftRadians: number): [number, number, number] {
  const azimuth = quad.azimuthRadians + driftRadians;
  const cosElevation = Math.cos(quad.elevationRadians);
  return [
    Math.sin(azimuth) * cosElevation * quad.radius,
    Math.sin(quad.elevationRadians) * quad.radius,
    Math.cos(azimuth) * cosElevation * quad.radius,
  ];
}

export interface SkyCloudPalette {
  /** Sunlit crown color for the top of each puff. */
  top: [number, number, number];
  /** Shaded base color, pulled toward the ambient sky term. */
  bottom: [number, number, number];
}

/**
 * Two-tone cloud shading derived from the sky lighting state: crowns blend
 * the ambient sky toward the key (sun/moon) color, bases stay on the ambient
 * term. `sunIntensity` already encodes twilight, night, cloud cover, and
 * storm darkening; passing the weather additionally applies the preset's
 * cloud darkening so storm decks read slate-dark rather than merely unlit.
 */
export function getSkyCloudPalette(lighting: SkyLightingState, weather?: DirectorWorldWeather): SkyCloudPalette {
  const darkening = weather ? evaluateSkyWeatherMood(weather).cloudShaderDarkening : 1;
  const direct = clamp01(lighting.sunIntensity / SKY_NOON_SUN_INTENSITY);
  const litBrightness = (0.45 + 0.55 * direct) * darkening;
  const baseBrightness = (0.3 + 0.42 * direct) * darkening;
  return {
    top: [
      lerp(lighting.ambientColor[0], lighting.sunColor[0], 0.62) * litBrightness,
      lerp(lighting.ambientColor[1], lighting.sunColor[1], 0.62) * litBrightness,
      lerp(lighting.ambientColor[2], lighting.sunColor[2], 0.62) * litBrightness,
    ],
    bottom: [
      lighting.ambientColor[0] * baseBrightness,
      lighting.ambientColor[1] * baseBrightness,
      lighting.ambientColor[2] * baseBrightness,
    ],
  };
}
