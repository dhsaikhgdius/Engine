import { beforeEach, describe, expect, it } from "vitest";
import type {
  DirectorWorldEffect,
  DirectorWorldSettings,
} from "../../../../../../../packages/protocol/src/worldSystemsProtocol";
import {
  FIRE_CELL_BURNING,
  FIRE_CELL_BURNT,
  FIRE_CELL_UNBURNT,
  FIRE_MAX_GRID_DIM,
  FIRE_VIEW_MAX_EMITTERS,
  createFirePropagationSim,
  firePropagationConfigKey,
  isFirePropagationEffect,
  toFireWaterRects,
  type FireWaterRect,
} from "../../../../../src/comprehensive/editor/world/effects/firePropagationSim";
import { resetWorldClimateCaches } from "../../../../../src/comprehensive/editor/world/worldClimate";

const SEED = 90_210;

function makeSettings(overrides: Partial<DirectorWorldSettings> = {}): DirectorWorldSettings {
  return {
    enabled: true,
    seed: SEED,
    wind: { directionDegrees: 0, speedMps: 0, gustiness: 0, turbulence: 0 },
    timeOfDay: { mode: "fixed", hours: 14, cycleMinutes: 12, drivesSky: false },
    weather: { preset: "clear", intensity: 0.5, wetness: 0, cloudCover: 0.2 },
    ...overrides,
  };
}

function makeFireEffect(overrides: Partial<DirectorWorldEffect> = {}): DirectorWorldEffect {
  return {
    id: "fx-fire-1",
    name: "campfire",
    kind: "fire",
    anchor: { position: [0, 0, 0] },
    shape: { type: "point" },
    intensity: 1,
    sizeScale: 1,
    speedScale: 1,
    windInfluence: 0.3,
    propagation: { enabled: true, radiusM: 12, spreadRate: 1 },
    seedOffset: 7,
    visible: true,
    locked: false,
    createdAt: "2026-08-25T00:00:00.000Z",
    ...overrides,
  };
}

function countStatus(status: Uint8Array, value: number): number {
  let count = 0;
  for (let index = 0; index < status.length; index += 1) if (status[index] === value) count += 1;
  return count;
}

function countIgnited(status: Uint8Array): number {
  return countStatus(status, FIRE_CELL_BURNING) + countStatus(status, FIRE_CELL_BURNT);
}

beforeEach(() => {
  resetWorldClimateCaches();
});

describe("grid construction", () => {
  it("uses 1.5 m cells for a default radius and caps the grid at 64x64", () => {
    const small = createFirePropagationSim(makeFireEffect(), makeSettings(), []);
    expect(small.gridDim).toBe(16);
    expect(small.cellSizeM).toBeCloseTo(1.5, 10);

    const large = createFirePropagationSim(
      makeFireEffect({ propagation: { enabled: true, radiusM: 64, spreadRate: 1 } }),
      makeSettings(),
      [],
    );
    expect(large.gridDim).toBe(FIRE_MAX_GRID_DIM);
    expect(large.cellSizeM).toBeCloseTo(2, 10);
  });

  it("ignites the anchor neighborhood at tick 0", () => {
    const sim = createFirePropagationSim(makeFireEffect(), makeSettings(), []);
    sim.stepTo(0);
    const burning = sim.getBurningCells(64);
    expect(burning.length).toBeGreaterThanOrEqual(1);
    expect(burning.length).toBeLessThanOrEqual(6);
    for (const cell of burning) {
      expect(cell.ignitionTick).toBe(0);
      expect(Math.hypot(cell.x, cell.z)).toBeLessThan(2.5);
    }
  });
});

describe("propagation gating", () => {
  it("only unbound fire effects with enabled propagation qualify", () => {
    expect(isFirePropagationEffect(makeFireEffect())).toBe(true);
    expect(isFirePropagationEffect(makeFireEffect({ kind: "smoke" }))).toBe(false);
    expect(isFirePropagationEffect(makeFireEffect({ propagation: undefined }))).toBe(false);
    expect(
      isFirePropagationEffect(makeFireEffect({ propagation: { enabled: false, radiusM: 12, spreadRate: 1 } })),
    ).toBe(false);
    expect(
      isFirePropagationEffect(makeFireEffect({ anchor: { objectId: "obj-1", position: [0, 0, 0] } })),
    ).toBe(false);
  });

  it("config key tracks sim-relevant fields and ignores view-only ones", () => {
    const settings = makeSettings();
    const base = firePropagationConfigKey(makeFireEffect(), settings, []);
    expect(firePropagationConfigKey(makeFireEffect({ intensity: 2, sizeScale: 3 }), settings, [])).toBe(base);
    expect(
      firePropagationConfigKey(makeFireEffect({ propagation: { enabled: true, radiusM: 20, spreadRate: 1 } }), settings, []),
    ).not.toBe(base);
    expect(
      firePropagationConfigKey(makeFireEffect(), { ...settings, weather: { ...settings.weather, wetness: 0.5 } }, []),
    ).not.toBe(base);
    const rect: FireWaterRect = { centerX: 4, centerZ: 0, sizeX: 4, sizeZ: 4, rotationDegrees: 0 };
    expect(firePropagationConfigKey(makeFireEffect(), settings, [rect])).not.toBe(base);
  });
});

describe("deterministic replay", () => {
  it("out-of-order seeks are bit-identical to continuous play", () => {
    const effect = makeFireEffect();
    const settings = makeSettings({ wind: { directionDegrees: 45, speedMps: 6, gustiness: 0.4, turbulence: 0.2 } });
    const continuous = createFirePropagationSim(effect, settings, []);
    const scrubbed = createFirePropagationSim(effect, settings, []);

    const probeTimes = [5, 12.5, 20, 33.5];
    const snapshots = new Map<number, Uint8Array>();
    for (let t = 0; t <= 35; t += 0.5) {
      continuous.stepTo(t);
      if (probeTimes.includes(t)) snapshots.set(t, new Uint8Array(continuous.readStatus()));
    }
    for (const t of [33.5, 5, 20, 12.5, 33.5, 5]) {
      scrubbed.stepTo(t);
      expect(new Uint8Array(scrubbed.readStatus()), `t=${t}`).toEqual(snapshots.get(t));
    }
  });

  it("replay stays identical under an evolving climate cycle", () => {
    const effect = makeFireEffect();
    const settings = makeSettings({
      weather: { preset: "rain", intensity: 1, wetness: 0, cloudCover: 0.5, evolution: { mode: "cycle", periodSeconds: 120 } },
    });
    const a = createFirePropagationSim(effect, settings, []);
    const b = createFirePropagationSim(effect, settings, []);
    for (let t = 0; t <= 40; t += 1) a.stepTo(t);
    a.stepTo(25);
    b.stepTo(25);
    expect(new Uint8Array(a.readStatus())).toEqual(new Uint8Array(b.readStatus()));
    expect(a.getBurningCells(FIRE_VIEW_MAX_EMITTERS)).toEqual(b.getBurningCells(FIRE_VIEW_MAX_EMITTERS));
  });

  it("burning cells are ordered by ignition tick then index and capped", () => {
    const sim = createFirePropagationSim(makeFireEffect(), makeSettings(), []);
    sim.stepTo(18);
    const cells = sim.getBurningCells(FIRE_VIEW_MAX_EMITTERS);
    expect(cells.length).toBeLessThanOrEqual(FIRE_VIEW_MAX_EMITTERS);
    for (let index = 1; index < cells.length; index += 1) {
      const previous = cells[index - 1];
      const current = cells[index];
      expect(
        previous.ignitionTick < current.ignitionTick ||
          (previous.ignitionTick === current.ignitionTick && previous.cellIndex < current.cellIndex),
      ).toBe(true);
    }
  });
});

describe("fire as a system", () => {
  it("spreads outward over time on a dry, calm set", () => {
    const sim = createFirePropagationSim(makeFireEffect(), makeSettings(), []);
    sim.stepTo(2);
    const early = countIgnited(sim.readStatus());
    sim.stepTo(20);
    const late = countIgnited(sim.readStatus());
    expect(early).toBeGreaterThanOrEqual(1);
    expect(late).toBeGreaterThan(early + 8);
  });

  it("wind biases the spread direction downwind", () => {
    // Wind blows toward +X (azimuth 90). The larger substrate keeps the
    // downwind front from saturating at the grid edge before the probe.
    const sim = createFirePropagationSim(
      makeFireEffect({ propagation: { enabled: true, radiusM: 24, spreadRate: 1 } }),
      makeSettings({ wind: { directionDegrees: 90, speedMps: 12, gustiness: 0, turbulence: 0 } }),
      [],
    );
    sim.stepTo(10);
    const status = sim.readStatus();
    const dim = sim.gridDim;
    let downwind = 0;
    let upwind = 0;
    for (let index = 0; index < status.length; index += 1) {
      if (status[index] !== FIRE_CELL_BURNING && status[index] !== FIRE_CELL_BURNT) continue;
      const x = sim.originX + ((index % dim) + 0.5) * sim.cellSizeM;
      if (x > 1) downwind += 1;
      else if (x < -1) upwind += 1;
    }
    expect(downwind).toBeGreaterThan(upwind * 1.5);
  });

  it("authored wetness suppresses spread; saturation stops it entirely", () => {
    const dry = createFirePropagationSim(makeFireEffect(), makeSettings(), []);
    const damp = createFirePropagationSim(
      makeFireEffect(),
      makeSettings({ weather: { preset: "clear", intensity: 0.5, wetness: 0.9, cloudCover: 0.2 } }),
      [],
    );
    const soaked = createFirePropagationSim(
      makeFireEffect(),
      makeSettings({ weather: { preset: "clear", intensity: 0.5, wetness: 1, cloudCover: 0.2 } }),
      [],
    );
    dry.stepTo(15);
    damp.stepTo(15);
    soaked.stepTo(15);
    const dryCount = countIgnited(dry.readStatus());
    const dampCount = countIgnited(damp.readStatus());
    const soakedBurning = soaked.getBurningCells(64);
    expect(dryCount).toBeGreaterThan(dampCount);
    // A fully soaked substrate never ignites beyond the tick-0 sources.
    for (const cell of soakedBurning) expect(cell.ignitionTick).toBe(0);
  });

  it("storm rain extinguishes the fire", () => {
    const sim = createFirePropagationSim(
      makeFireEffect(),
      makeSettings({ weather: { preset: "storm", intensity: 1, wetness: 0, cloudCover: 1 } }),
      [],
    );
    sim.stepTo(0);
    expect(sim.getBurningCells(64).length).toBeGreaterThanOrEqual(1);
    sim.stepTo(20);
    expect(sim.getBurningCells(64)).toEqual([]);
    // Sources burned out early instead of consuming their full dry duration.
    const status = sim.readStatus();
    expect(countStatus(status, FIRE_CELL_BURNT)).toBeGreaterThanOrEqual(1);
    expect(countIgnited(status)).toBeLessThanOrEqual(6);
  });

  it("water rectangles forbid burning under them", () => {
    // Basin covering the +X half of the substrate.
    const rects = toFireWaterRects([
      {
        id: "water-1",
        name: "lake",
        surface: { center: [7, 0, 0], sizeX: 14, sizeZ: 40, rotationDegrees: 0 },
        waveAmplitude: 0.1,
        waveLengthM: 8,
        flowDirectionDegrees: 0,
        flowSpeedMps: 0.5,
        colorShallow: "#3fb8c8",
        colorDeep: "#0c3a4a",
        opacity: 0.8,
        foamIntensity: 0.5,
        visible: true,
        locked: false,
      },
    ]);
    const sim = createFirePropagationSim(makeFireEffect(), makeSettings(), rects);
    sim.stepTo(25);
    const status = sim.readStatus();
    const dim = sim.gridDim;
    let west = 0;
    for (let index = 0; index < status.length; index += 1) {
      const x = sim.originX + ((index % dim) + 0.5) * sim.cellSizeM;
      if (x > 0) {
        expect(status[index]).toBe(FIRE_CELL_UNBURNT);
      } else if (status[index] === FIRE_CELL_BURNING || status[index] === FIRE_CELL_BURNT) {
        west += 1;
      }
    }
    expect(west).toBeGreaterThan(4);
  });

  it("cell life fades from 1 toward 0 while burning", () => {
    const sim = createFirePropagationSim(makeFireEffect(), makeSettings(), []);
    sim.stepTo(0);
    const [first] = sim.getBurningCells(1);
    expect(sim.readCellLife(first.cellIndex)).toBeGreaterThan(0.9);
    sim.stepTo(6);
    const lifeLater = sim.readCellLife(first.cellIndex);
    expect(lifeLater).toBeGreaterThan(0);
    expect(lifeLater).toBeLessThan(0.95);
    expect(sim.readCellAgeSeconds(first.cellIndex)).toBeCloseTo(6, 1);
  });
});
