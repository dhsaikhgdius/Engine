import { describe, expect, it } from "vitest";
import type {
  DirectorWorldSettings,
  DirectorWorldWildlifeGroup,
  WorldWildlifeSpecies,
} from "../../../../../../../packages/protocol/src/worldSystemsProtocol";
import {
  buildWildlifeEnvironment,
  createWildlifeSim,
  wildlifeSimConfigKey,
  type WildlifeSim,
  type WildlifeSimEnvironment,
  type WildlifeSimStateView,
} from "../../../../../src/comprehensive/editor/world/wildlife/wildlifeSim";
import {
  collectWildlifeNeighbors,
  createWildlifeSpatialHash,
} from "../../../../../src/comprehensive/editor/world/wildlife/wildlifeSpatialHash";
import { worldRandom01 } from "../../../../../src/comprehensive/editor/world/worldRandom";

const WORLD_SEED = 20_260_813;
const GROUND_HEIGHT = 0.5;

function makeGroup(
  species: WorldWildlifeSpecies,
  count: number,
  overrides: Partial<DirectorWorldWildlifeGroup> = {},
): DirectorWorldWildlifeGroup {
  return {
    id: `wl_${species}`,
    name: `测试${species}`,
    species,
    count,
    area: { center: [0, 2, 0], radius: 24 },
    speedScale: 1,
    sizeScale: 1,
    seedOffset: 7,
    visible: true,
    locked: false,
    ...overrides,
  };
}

function makeSettings(overrides: Partial<DirectorWorldSettings> = {}): DirectorWorldSettings {
  return {
    enabled: true,
    seed: WORLD_SEED,
    wind: { directionDegrees: 90, speedMps: 0, gustiness: 0, turbulence: 0 },
    timeOfDay: { mode: "fixed", hours: 14, cycleMinutes: 12, drivesSky: false },
    weather: { preset: "clear", intensity: 1, wetness: 0, cloudCover: 0.2 },
    ...overrides,
  };
}

function viewBytes(view: WildlifeSimStateView): Uint8Array {
  const arrays = [view.posX, view.posY, view.posZ, view.velX, view.velY, view.velZ];
  const total = arrays.reduce((sum, array) => sum + array.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const array of arrays) {
    bytes.set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength), offset);
    offset += array.byteLength;
  }
  return bytes;
}

function meanOf(view: WildlifeSimStateView, array: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < view.count; i += 1) sum += array[i];
  return sum / view.count;
}

describe("spatial hash", () => {
  it("neighbor sets match a brute-force scan exactly", () => {
    const n = 200;
    const posX = new Float32Array(n);
    const posY = new Float32Array(n);
    const posZ = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      posX[i] = (worldRandom01(WORLD_SEED, 1, i) - 0.5) * 40;
      posY[i] = (worldRandom01(WORLD_SEED, 2, i) - 0.5) * 16;
      posZ[i] = (worldRandom01(WORLD_SEED, 3, i) - 0.5) * 40;
    }
    const radius = 6;
    const hash = createWildlifeSpatialHash({
      capacity: n,
      cellSize: radius,
      minX: -26,
      maxX: 26,
      minY: -14,
      maxY: 14,
      minZ: -26,
      maxZ: 26,
    });
    hash.build(posX, posY, posZ, n);
    for (let i = 0; i < n; i += 1) {
      const viaHash = collectWildlifeNeighbors(hash, posX, posY, posZ, i, radius).sort((a, b) => a - b);
      const brute: number[] = [];
      for (let j = 0; j < n; j += 1) {
        if (j === i) continue;
        const dx = posX[j] - posX[i];
        const dy = posY[j] - posY[i];
        const dz = posZ[j] - posZ[i];
        if (dx * dx + dy * dy + dz * dz <= radius * radius) brute.push(j);
      }
      expect(viaHash, `agent ${i}`).toEqual(brute);
    }
  });

  it("collapses to 2D when the domain has no Y extent", () => {
    const hash = createWildlifeSpatialHash({
      capacity: 4,
      cellSize: 2,
      minX: -10,
      maxX: 10,
      minY: 0,
      maxY: 0,
      minZ: -10,
      maxZ: 10,
    });
    expect(hash.ny).toBe(1);
    expect(hash.cellY(123)).toBe(0);
  });
});

describe("environment determinism", () => {
  it("seek-vs-play stays byte-identical with wind, storm, and predators active", () => {
    const settings = makeSettings({
      wind: { directionDegrees: 90, speedMps: 10, gustiness: 0.5, turbulence: 0.3 },
      weather: { preset: "storm", intensity: 1, wetness: 0.5, cloudCover: 1 },
    });
    const cases: Array<[DirectorWorldWildlifeGroup, WildlifeSimEnvironment]> = [
      [makeGroup("birds", 48), { settings }],
      [makeGroup("sheep", 32), { settings, predatorZones: [{ x: 10, z: 0, radius: 8 }] }],
      [
        makeGroup("fish", 40, { area: { center: [0, 2, 0], radius: 10 } }),
        { settings, waterRects: [{ centerX: 0, centerZ: 0, sizeX: 16, sizeZ: 16, rotationDegrees: 20 }] },
      ],
    ];
    for (const [group, environment] of cases) {
      const continuous = createWildlifeSim(group, WORLD_SEED, GROUND_HEIGHT, environment);
      const scrubbed = createWildlifeSim(group, WORLD_SEED, GROUND_HEIGHT, environment);
      for (let t = 0; t <= 30; t += 0.4) continuous.stepTo(t);
      continuous.stepTo(18.2);
      scrubbed.stepTo(29.8);
      scrubbed.stepTo(3.1);
      scrubbed.stepTo(18.2);
      expect(viewBytes(scrubbed.readState()), group.species).toEqual(viewBytes(continuous.readState()));
    }
  });

  it("config key folds in only the archetype-relevant environment", () => {
    const group = makeGroup("fish", 16);
    const settings = makeSettings();
    const windier = makeSettings({ wind: { directionDegrees: 0, speedMps: 30, gustiness: 1, turbulence: 1 } });
    // Fish ignore wind: same key despite different wind blocks.
    expect(wildlifeSimConfigKey(group, WORLD_SEED, GROUND_HEIGHT, { settings })).toBe(
      wildlifeSimConfigKey(group, WORLD_SEED, GROUND_HEIGHT, { settings: windier }),
    );
    // Birds do respond to wind: the key must differ.
    const birds = makeGroup("birds", 16);
    expect(wildlifeSimConfigKey(birds, WORLD_SEED, GROUND_HEIGHT, { settings })).not.toBe(
      wildlifeSimConfigKey(birds, WORLD_SEED, GROUND_HEIGHT, { settings: windier }),
    );
    // Turbulence feeds the flock wind evaluator (flutter band + meander), so
    // a turbulence-only edit must reset birds — but never fish.
    const turbulent = makeSettings({ wind: { directionDegrees: 90, speedMps: 0, gustiness: 0, turbulence: 0.9 } });
    expect(wildlifeSimConfigKey(birds, WORLD_SEED, GROUND_HEIGHT, { settings })).not.toBe(
      wildlifeSimConfigKey(birds, WORLD_SEED, GROUND_HEIGHT, { settings: turbulent }),
    );
    expect(wildlifeSimConfigKey(group, WORLD_SEED, GROUND_HEIGHT, { settings })).toBe(
      wildlifeSimConfigKey(group, WORLD_SEED, GROUND_HEIGHT, { settings: turbulent }),
    );
    // No environment matches an empty environment fragment.
    expect(wildlifeSimConfigKey(group, WORLD_SEED, GROUND_HEIGHT)).toBe(
      wildlifeSimConfigKey(group, WORLD_SEED, GROUND_HEIGHT, { settings }),
    );
  });
});

describe("wind and storm coupling", () => {
  function meanDrift(sim: WildlifeSim, seconds: number): number {
    sim.stepTo(seconds);
    return meanOf(sim.readState(), sim.readState().posX);
  }

  it("wind drifts birds downwind", () => {
    const group = makeGroup("birds", 64);
    const calm = createWildlifeSim(group, WORLD_SEED, GROUND_HEIGHT, { settings: makeSettings() });
    const windy = createWildlifeSim(group, WORLD_SEED, GROUND_HEIGHT, {
      settings: makeSettings({ wind: { directionDegrees: 90, speedMps: 12, gustiness: 0, turbulence: 0 } }),
    });
    // Wind blows toward +X; the windy flock's mean X sits farther downwind.
    expect(meanDrift(windy, 20)).toBeGreaterThan(meanDrift(calm, 20) + 1);
  });

  it("storms press flocks toward the bottom of their altitude band", () => {
    const group = makeGroup("birds", 64);
    const clear = createWildlifeSim(group, WORLD_SEED, GROUND_HEIGHT, { settings: makeSettings() });
    const storm = createWildlifeSim(group, WORLD_SEED, GROUND_HEIGHT, {
      settings: makeSettings({ weather: { preset: "storm", intensity: 1, wetness: 0, cloudCover: 1 } }),
    });
    clear.stepTo(30);
    storm.stepTo(30);
    const clearY = meanOf(clear.readState(), clear.readState().posY);
    const stormY = meanOf(storm.readState(), storm.readState().posY);
    expect(stormY).toBeLessThan(clearY - 1.5);
  });

  it("storms slow sheep but not wolves", () => {
    function meanMovingSpeed(species: WorldWildlifeSpecies, preset: "clear" | "storm"): number {
      const sim = createWildlifeSim(makeGroup(species, 48), WORLD_SEED, GROUND_HEIGHT, {
        settings: makeSettings({ weather: { preset, intensity: 1, wetness: 0, cloudCover: 0.5 } }),
      });
      let sum = 0;
      let samples = 0;
      for (let t = 10; t <= 40; t += 2) {
        sim.stepTo(t);
        const view = sim.readState();
        for (let i = 0; i < view.count; i += 1) {
          const speed = Math.hypot(view.velX[i], view.velZ[i]);
          if (speed > 0.15) {
            sum += speed;
            samples += 1;
          }
        }
      }
      return samples > 0 ? sum / samples : 0;
    }
    const sheepClear = meanMovingSpeed("sheep", "clear");
    const sheepStorm = meanMovingSpeed("sheep", "storm");
    expect(sheepStorm).toBeLessThan(sheepClear * 0.85);
    const wolvesClear = meanMovingSpeed("wolves", "clear");
    const wolvesStorm = meanMovingSpeed("wolves", "storm");
    expect(Math.abs(wolvesStorm - wolvesClear)).toBeLessThan(wolvesClear * 0.1);
  });
});

describe("water and predator coupling", () => {
  it("fish never leave an overlapping water rectangle", () => {
    const group = makeGroup("fish", 48, { area: { center: [0, 2, 0], radius: 12 } });
    const rect = { centerX: 2, centerZ: -1, sizeX: 14, sizeZ: 10, rotationDegrees: 30 };
    const sim = createWildlifeSim(group, WORLD_SEED, GROUND_HEIGHT, {
      settings: makeSettings(),
      waterRects: [rect],
    });
    const cos = Math.cos((-rect.rotationDegrees * Math.PI) / 180);
    const sin = Math.sin((-rect.rotationDegrees * Math.PI) / 180);
    for (const t of [5, 20, 45]) {
      sim.stepTo(t);
      const view = sim.readState();
      for (let i = 0; i < view.count; i += 1) {
        const ox = view.posX[i] - rect.centerX;
        const oz = view.posZ[i] - rect.centerZ;
        const localX = ox * cos - oz * sin;
        const localZ = ox * sin + oz * cos;
        expect(Math.abs(localX)).toBeLessThanOrEqual(rect.sizeX / 2 + 1e-3);
        expect(Math.abs(localZ)).toBeLessThanOrEqual(rect.sizeZ / 2 + 1e-3);
      }
    }
  });

  it("prey herds thin out inside wolf territory", () => {
    const group = makeGroup("sheep", 96, { area: { center: [0, 2, 0], radius: 20 } });
    const zone = { x: 8, z: 0, radius: 9 };
    function countInZone(environment: WildlifeSimEnvironment): number {
      const sim = createWildlifeSim(group, WORLD_SEED, GROUND_HEIGHT, environment);
      let inside = 0;
      for (const t of [20, 30, 40]) {
        sim.stepTo(t);
        const view = sim.readState();
        for (let i = 0; i < view.count; i += 1) {
          if (Math.hypot(view.posX[i] - zone.x, view.posZ[i] - zone.z) < zone.radius) inside += 1;
        }
      }
      return inside;
    }
    const settings = makeSettings();
    const withWolves = countInZone({ settings, predatorZones: [zone] });
    const without = countInZone({ settings });
    expect(withWolves).toBeLessThan(without * 0.5);
  });

  it("builds per-group environments from world state", () => {
    const settings = makeSettings();
    const sheep = makeGroup("sheep", 8, { area: { center: [0, 0, 0], radius: 10 } });
    const wolves = makeGroup("wolves", 4, { id: "wl_wolves_near", area: { center: [12, 0, 0], radius: 6 } });
    const farWolves = makeGroup("wolves", 4, { id: "wl_wolves_far", area: { center: [100, 0, 0], radius: 6 } });
    const fish = makeGroup("fish", 8, { area: { center: [0, 1, 0], radius: 8 } });
    const rects = [
      { centerX: 0, centerZ: 0, sizeX: 10, sizeZ: 10, rotationDegrees: 0 },
      { centerX: 200, centerZ: 0, sizeX: 10, sizeZ: 10, rotationDegrees: 0 },
    ];
    const sheepEnv = buildWildlifeEnvironment(settings, sheep, [sheep, wolves, farWolves], rects);
    expect(sheepEnv.predatorZones).toEqual([{ x: 12, z: 0, radius: 6 }]);
    const fishEnv = buildWildlifeEnvironment(settings, fish, [fish], rects);
    expect(fishEnv.waterRects).toEqual([rects[0]]);
    const wolfEnv = buildWildlifeEnvironment(settings, wolves, [sheep, wolves], rects);
    expect(wolfEnv.predatorZones).toBeUndefined();
    expect(wolfEnv.waterRects).toBeUndefined();
  });
});
