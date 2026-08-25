import { describe, expect, it } from "vitest";
import {
  DIRECTOR_WORLD_SIMULATION_HZ,
  WORLD_WILDLIFE_SPECIES,
  WORLD_WILDLIFE_SPECIES_ARCHETYPE,
  type DirectorWorldWildlifeGroup,
  type WorldWildlifeSpecies,
} from "../../../../../../../packages/protocol/src/worldSystemsProtocol";
import { createWorldRng } from "../../../../../src/comprehensive/editor/world/worldRandom";
import {
  createWildlifeRng,
  createWildlifeSim,
  shouldRecreateWildlifeSim,
  WILDLIFE_BEHAVIOR_FLEE,
  WILDLIFE_BEHAVIOR_GRAZE,
  WILDLIFE_BEHAVIOR_SPRINT,
  WILDLIFE_BEHAVIOR_WALK,
  WILDLIFE_CALM_ENVIRONMENT,
  WILDLIFE_CRUISE_SPEED_MPS,
  WILDLIFE_DEFAULT_ALTITUDE_BAND_M,
  wildlifeSimConfigKey,
  type WildlifeEnvironment,
  type WildlifeSim,
  type WildlifeSimStateView,
} from "../../../../../src/comprehensive/editor/world/wildlife/wildlifeSim";

const WORLD_SEED = 20_260_813;
const GROUND_HEIGHT = 0.5;
const AREA_CENTER: [number, number, number] = [4, 2, -3];
const AREA_RADIUS = 24;

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
    area: { center: AREA_CENTER, radius: AREA_RADIUS },
    speedScale: 1,
    sizeScale: 1,
    seedOffset: 7,
    visible: true,
    locked: false,
    ...overrides,
  };
}

function makeSim(
  species: WorldWildlifeSpecies,
  count: number,
  overrides?: Partial<DirectorWorldWildlifeGroup>,
  environment?: WildlifeEnvironment,
) {
  return createWildlifeSim(makeGroup(species, count, overrides), WORLD_SEED, GROUND_HEIGHT, environment);
}

/** Storm blowing toward +X (meteorological 90° = wind vector (sin 90°, 0, cos 90°)). */
const STORM_EAST: WildlifeEnvironment = {
  wind: { directionDegrees: 90, speedMps: 10, gustiness: 0.3, turbulence: 0.3 },
  weather: { preset: "storm", intensity: 1, wetness: 0.8, cloudCover: 1 },
};

function meanDistanceToCenter(sim: WildlifeSim): number {
  const state = sim.readState();
  let total = 0;
  for (let i = 0; i < state.count; i += 1) {
    const dx = state.posX[i] - AREA_CENTER[0];
    const dz = state.posZ[i] - AREA_CENTER[2];
    total += Math.sqrt(dx * dx + dz * dz);
  }
  return total / state.count;
}

function rmsDistanceToCentroid(sim: WildlifeSim): number {
  const state = sim.readState();
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i < state.count; i += 1) {
    cx += state.posX[i];
    cy += state.posY[i];
    cz += state.posZ[i];
  }
  cx /= state.count;
  cy /= state.count;
  cz /= state.count;
  let sum = 0;
  for (let i = 0; i < state.count; i += 1) {
    const dx = state.posX[i] - cx;
    const dy = state.posY[i] - cy;
    const dz = state.posZ[i] - cz;
    sum += dx * dx + dy * dy + dz * dz;
  }
  return Math.sqrt(sum / state.count);
}

/** Samples behaviorState + planar speed over [0, seconds] at 0.2 s cadence. */
function sampleHerdRun(sim: WildlifeSim, seconds: number) {
  const seenStates = new Set<number>();
  let maxSpeed = 0;
  for (let t = 0; t <= seconds; t += 0.2) {
    sim.stepTo(t);
    const state = sim.readState();
    for (let i = 0; i < state.count; i += 1) {
      seenStates.add(state.behaviorState[i]);
      const speed = Math.hypot(state.velX[i], state.velZ[i]);
      if (speed > maxSpeed) maxSpeed = speed;
    }
  }
  return { seenStates, maxSpeed };
}

/** Concatenated raw bytes of every state array — the strictest equality. */
function viewBytes(view: WildlifeSimStateView): Uint8Array {
  const arrays = [
    view.posX,
    view.posY,
    view.posZ,
    view.velX,
    view.velY,
    view.velZ,
    view.heading,
    view.behaviorState,
    view.grazeBlend,
    view.phase,
  ];
  const total = arrays.reduce((sum, array) => sum + array.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const array of arrays) {
    bytes.set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength), offset);
    offset += array.byteLength;
  }
  return bytes;
}

function expectSimsIdentical(a: WildlifeSim, b: WildlifeSim): void {
  const stateA = a.readState();
  const stateB = b.readState();
  expect(stateA.tick).toBe(stateB.tick);
  expect(viewBytes(stateA)).toEqual(viewBytes(stateB));
  // The interpolation lookahead tick must match too.
  const renderA = a.readRenderState();
  const renderB = b.readRenderState();
  expect(renderA.curr.tick).toBe(renderB.curr.tick);
  expect(viewBytes(renderA.curr)).toEqual(viewBytes(renderB.curr));
}

function expectAllFinite(view: WildlifeSimStateView): void {
  const arrays = [view.posX, view.posY, view.posZ, view.velX, view.velY, view.velZ, view.heading, view.grazeBlend];
  for (const array of arrays) {
    for (let i = 0; i < array.length; i += 1) {
      expect(Number.isFinite(array[i])).toBe(true);
    }
  }
}

describe("wildlife rng", () => {
  it("mirrors createWorldRng sequences exactly and serializes state", () => {
    const reference = createWorldRng(4242);
    const serializable = createWildlifeRng(4242);
    for (let i = 0; i < 32; i += 1) {
      expect(serializable.next()).toBe(reference());
    }
    const saved = serializable.getState();
    const forkA = [serializable.next(), serializable.next(), serializable.next()];
    serializable.setState(saved);
    const forkB = [serializable.next(), serializable.next(), serializable.next()];
    expect(forkA).toEqual(forkB);
  });
});

describe("wildlife sim determinism (random access in time)", () => {
  const speciesUnderTest: WorldWildlifeSpecies[] = ["birds", "fish", "deer"];

  it("two fresh sims reach byte-identical state at stepTo(37.4)", () => {
    for (const species of speciesUnderTest) {
      const a = makeSim(species, 24);
      const b = makeSim(species, 24);
      a.stepTo(37.4);
      b.stepTo(37.4);
      expect(a.readState().tick).toBe(Math.floor(37.4 * DIRECTOR_WORLD_SIMULATION_HZ));
      expectSimsIdentical(a, b);
    }
  });

  it("stepTo(10) then stepTo(37.4) equals fresh stepTo(37.4)", () => {
    for (const species of speciesUnderTest) {
      const incremental = makeSim(species, 24);
      incremental.stepTo(10);
      incremental.stepTo(37.4);
      const fresh = makeSim(species, 24);
      fresh.stepTo(37.4);
      expectSimsIdentical(incremental, fresh);
    }
  });

  it("stepTo(37.4) then BACK to stepTo(12.2) equals fresh stepTo(12.2)", () => {
    for (const species of speciesUnderTest) {
      const scrubbed = makeSim(species, 24);
      scrubbed.stepTo(37.4);
      scrubbed.stepTo(12.2);
      const fresh = makeSim(species, 24);
      fresh.stepTo(12.2);
      expect(scrubbed.readState().tick).toBe(Math.floor(12.2 * DIRECTOR_WORLD_SIMULATION_HZ));
      expectSimsIdentical(scrubbed, fresh);
    }
  });

  it("many small forward steps equal one large jump (herd consumes rng)", () => {
    const incremental = makeSim("deer", 12);
    for (let i = 0; i <= 49; i += 1) incremental.stepTo(i * 0.1);
    incremental.stepTo(5); // land exactly on the comparison target
    const fresh = makeSim("deer", 12);
    fresh.stepTo(5);
    expectSimsIdentical(incremental, fresh);
  });

  it("falls back to the tick-0 snapshot when ring checkpoints were evicted", () => {
    // 340 s = 10200 ticks > 64 checkpoints × 150 ticks: the early ring slots
    // are overwritten, so scrubbing back to 5 s must replay from tick 0.
    const longRun = makeSim("deer", 6);
    longRun.stepTo(340);
    longRun.stepTo(5);
    const fresh = makeSim("deer", 6);
    fresh.stepTo(5);
    expectSimsIdentical(longRun, fresh);
  });
});

describe("wildlife containment", () => {
  it("keeps flock agents inside the area radius and altitude band after 60 s", () => {
    const sim = makeSim("birds", 24);
    sim.stepTo(60);
    const state = sim.readState();
    const [bandMin, bandMax] = WILDLIFE_DEFAULT_ALTITUDE_BAND_M.birds;
    const minY = AREA_CENTER[1] + bandMin;
    const maxY = AREA_CENTER[1] + bandMax;
    const bandMargin = (maxY - minY) * 0.15;
    for (let i = 0; i < state.count; i += 1) {
      const dx = state.posX[i] - AREA_CENTER[0];
      const dz = state.posZ[i] - AREA_CENTER[2];
      expect(Math.sqrt(dx * dx + dz * dz)).toBeLessThanOrEqual(AREA_RADIUS * 1.15);
      expect(state.posY[i]).toBeGreaterThanOrEqual(minY - bandMargin);
      expect(state.posY[i]).toBeLessThanOrEqual(maxY + bandMargin);
    }
  });

  it("keeps herd agents at ground height inside the area after 60 s", () => {
    const sim = makeSim("deer", 16);
    sim.stepTo(60);
    const state = sim.readState();
    for (let i = 0; i < state.count; i += 1) {
      expect(state.posY[i]).toBe(GROUND_HEIGHT);
      const dx = state.posX[i] - AREA_CENTER[0];
      const dz = state.posZ[i] - AREA_CENTER[2];
      expect(Math.sqrt(dx * dx + dz * dz)).toBeLessThanOrEqual(AREA_RADIUS * 1.15);
    }
  });

  it("keeps fish below the water surface inside the area sphere after 60 s", () => {
    const sim = makeSim("fish", 20);
    sim.stepTo(60);
    const state = sim.readState();
    for (let i = 0; i < state.count; i += 1) {
      expect(state.posY[i]).toBeLessThan(AREA_CENTER[1]);
      const dx = state.posX[i] - AREA_CENTER[0];
      const dy = state.posY[i] - AREA_CENTER[1];
      const dz = state.posZ[i] - AREA_CENTER[2];
      expect(Math.sqrt(dx * dx + dy * dy + dz * dz)).toBeLessThanOrEqual(AREA_RADIUS * 1.15);
    }
  });
});

describe("wildlife behavior sanity", () => {
  it("herd agents alternate between walk and graze over time", () => {
    const sim = makeSim("sheep", 16);
    let walkSamples = 0;
    let grazeSamples = 0;
    for (let t = 0; t <= 60; t += 0.5) {
      sim.stepTo(t);
      const state = sim.readState();
      for (let i = 0; i < state.count; i += 1) {
        if (state.behaviorState[i] === WILDLIFE_BEHAVIOR_WALK) walkSamples += 1;
        else if (state.behaviorState[i] === WILDLIFE_BEHAVIOR_GRAZE) grazeSamples += 1;
        expect(state.grazeBlend[i]).toBeGreaterThanOrEqual(0);
        expect(state.grazeBlend[i]).toBeLessThanOrEqual(1);
      }
    }
    expect(walkSamples).toBeGreaterThan(0);
    expect(grazeSamples).toBeGreaterThan(0);
  });

  it("flock mean speed stays within ±40% of cruise speed", () => {
    const sim = makeSim("birds", 24);
    sim.stepTo(30);
    const state = sim.readState();
    let total = 0;
    for (let i = 0; i < state.count; i += 1) {
      total += Math.sqrt(state.velX[i] ** 2 + state.velY[i] ** 2 + state.velZ[i] ** 2);
    }
    const mean = total / state.count;
    const cruise = WILDLIFE_CRUISE_SPEED_MPS.birds;
    expect(mean).toBeGreaterThanOrEqual(cruise * 0.6);
    expect(mean).toBeLessThanOrEqual(cruise * 1.4);
  });

  it("never produces NaN state for any species", () => {
    for (const species of WORLD_WILDLIFE_SPECIES) {
      const sim = makeSim(species, 8);
      for (const t of [0, 13.37, 60]) {
        sim.stepTo(t);
        expectAllFinite(sim.readState());
        expectAllFinite(sim.readRenderState().curr);
      }
    }
  });
});

describe("wildlife species → archetype mapping", () => {
  it("covers every species exhaustively and honors archetype placement", () => {
    for (const species of WORLD_WILDLIFE_SPECIES) {
      const sim = makeSim(species, 6);
      expect(sim.archetype).toBe(WORLD_WILDLIFE_SPECIES_ARCHETYPE[species]);
      sim.stepTo(5);
      const state = sim.readState();
      for (let i = 0; i < state.count; i += 1) {
        if (sim.archetype === "herd") {
          expect(state.posY[i]).toBe(GROUND_HEIGHT);
        } else if (sim.archetype === "school") {
          expect(state.posY[i]).toBeLessThan(AREA_CENTER[1]);
        } else {
          expect(state.posY[i]).toBeGreaterThan(AREA_CENTER[1]);
        }
      }
    }
  });
});

/**
 * Species-distinct motion. No absolute trajectory goldens exist in this
 * suite; behavior DID change relative to earlier revisions (the spatial-hash
 * neighbor gather reordered float accumulation, and species tuning was
 * deliberately differentiated), which is why every assertion below is a
 * relative or structural property of a fixed-seed run rather than a stored
 * trajectory snapshot.
 */
describe("wildlife species-distinct motion", () => {
  it("keeps sheep knotted near the centre while wolves range wide", () => {
    const sheep = makeSim("sheep", 16);
    const wolves = makeSim("wolves", 16);
    let sheepTotal = 0;
    let wolvesTotal = 0;
    for (const t of [30, 60, 90]) {
      sheep.stepTo(t);
      wolves.stepTo(t);
      sheepTotal += meanDistanceToCenter(sheep);
      wolvesTotal += meanDistanceToCenter(wolves);
    }
    expect(sheepTotal / 3).toBeLessThan((wolvesTotal / 3) * 0.7);
  });

  it("rabbits alternate graze with sprint bursts well above cruise speed", () => {
    const { seenStates, maxSpeed } = sampleHerdRun(makeSim("rabbits", 16), 120);
    expect(seenStates.has(WILDLIFE_BEHAVIOR_SPRINT)).toBe(true);
    expect(seenStates.has(WILDLIFE_BEHAVIOR_GRAZE)).toBe(true);
    expect(maxSpeed).toBeGreaterThan(WILDLIFE_CRUISE_SPEED_MPS.rabbits * 1.5);
  });

  it("wolves chase-lope, sheep startle-flee, deer do neither", () => {
    const wolves = sampleHerdRun(makeSim("wolves", 16), 120);
    expect(wolves.seenStates.has(WILDLIFE_BEHAVIOR_SPRINT)).toBe(true);
    expect(wolves.seenStates.has(WILDLIFE_BEHAVIOR_FLEE)).toBe(false);
    expect(wolves.maxSpeed).toBeGreaterThan(WILDLIFE_CRUISE_SPEED_MPS.wolves * 1.5);

    const sheep = sampleHerdRun(makeSim("sheep", 16), 120);
    expect(sheep.seenStates.has(WILDLIFE_BEHAVIOR_FLEE)).toBe(true);
    expect(sheep.seenStates.has(WILDLIFE_BEHAVIOR_SPRINT)).toBe(false);
    expect(sheep.maxSpeed).toBeGreaterThan(WILDLIFE_CRUISE_SPEED_MPS.sheep * 1.4);

    const deer = sampleHerdRun(makeSim("deer", 16), 120);
    expect(deer.seenStates.has(WILDLIFE_BEHAVIOR_SPRINT)).toBe(false);
    expect(deer.seenStates.has(WILDLIFE_BEHAVIOR_FLEE)).toBe(false);
  });

  it("birds occupy layered strata across the whole altitude band", () => {
    const sim = makeSim("birds", 24);
    sim.stepTo(30);
    const state = sim.readState();
    const [bandMin, bandMax] = WILDLIFE_DEFAULT_ALTITUDE_BAND_M.birds;
    const minY = AREA_CENTER[1] + bandMin;
    const span = bandMax - bandMin;
    let low = 0;
    let middle = 0;
    let high = 0;
    for (let i = 0; i < state.count; i += 1) {
      const fraction = (state.posY[i] - minY) / span;
      if (fraction < 1 / 3) low += 1;
      else if (fraction < 2 / 3) middle += 1;
      else high += 1;
    }
    // Layered flight: every third of the band holds birds (the old sim
    // collapsed the flock onto one sheet near the band centre).
    expect(low).toBeGreaterThanOrEqual(2);
    expect(middle).toBeGreaterThanOrEqual(2);
    expect(high).toBeGreaterThanOrEqual(2);
  });

  it("fish school much tighter than the bird flock", () => {
    const fish = makeSim("fish", 24);
    const birds = makeSim("birds", 24);
    fish.stepTo(30);
    birds.stepTo(30);
    const fishSpread = rmsDistanceToCentroid(fish);
    expect(fishSpread).toBeLessThan(rmsDistanceToCentroid(birds) * 0.6);
    expect(fishSpread).toBeLessThan(AREA_RADIUS * 0.45);
  });
});

describe("wildlife weather and wind response", () => {
  it("storm wind biases birds downwind (time-averaged flock offset)", () => {
    const clear = makeSim("birds", 24, undefined, WILDLIFE_CALM_ENVIRONMENT);
    const storm = makeSim("birds", 24, undefined, STORM_EAST);
    let clearOffset = 0;
    let stormOffset = 0;
    let samples = 0;
    for (let t = 5; t <= 60; t += 0.5) {
      clear.stepTo(t);
      storm.stepTo(t);
      const meanX = (sim: WildlifeSim) => {
        const state = sim.readState();
        let total = 0;
        for (let i = 0; i < state.count; i += 1) total += state.posX[i];
        return total / state.count - AREA_CENTER[0];
      };
      clearOffset += meanX(clear);
      stormOffset += meanX(storm);
      samples += 1;
    }
    clearOffset /= samples;
    stormOffset /= samples;
    // Wind blows toward +X; the storm flock's centre lives far downwind of
    // the area centre while the calm flock stays roughly centred.
    expect(Math.abs(clearOffset)).toBeLessThan(5);
    expect(stormOffset).toBeGreaterThan(10);
  });

  it("storm slows the herd and clusters it toward the centre", () => {
    const clear = makeSim("sheep", 16, undefined, WILDLIFE_CALM_ENVIRONMENT);
    const storm = makeSim("sheep", 16, undefined, STORM_EAST);
    let clearMovingSum = 0;
    let clearMovingCount = 0;
    let stormMovingSum = 0;
    let stormMovingCount = 0;
    let clearDistance = 0;
    let stormDistance = 0;
    let distanceSamples = 0;
    for (let t = 0; t <= 90; t += 0.5) {
      clear.stepTo(t);
      storm.stepTo(t);
      const clearState = clear.readState();
      const stormState = storm.readState();
      for (let i = 0; i < clearState.count; i += 1) {
        const clearSpeed = Math.hypot(clearState.velX[i], clearState.velZ[i]);
        const stormSpeed = Math.hypot(stormState.velX[i], stormState.velZ[i]);
        if (clearSpeed > 0.05) {
          clearMovingSum += clearSpeed;
          clearMovingCount += 1;
        }
        if (stormSpeed > 0.05) {
          stormMovingSum += stormSpeed;
          stormMovingCount += 1;
        }
      }
      if (t >= 30) {
        clearDistance += meanDistanceToCenter(clear);
        stormDistance += meanDistanceToCenter(storm);
        distanceSamples += 1;
      }
    }
    expect(stormMovingSum / stormMovingCount).toBeLessThan((clearMovingSum / clearMovingCount) * 0.75);
    expect(stormDistance / distanceSamples).toBeLessThan((clearDistance / distanceSamples) * 0.85);
  });

  it("seek equals continuous play under a storm environment (bit-identical)", () => {
    for (const species of ["birds", "sheep"] as const) {
      const scrubbed = makeSim(species, 16, undefined, STORM_EAST);
      scrubbed.stepTo(37.4);
      scrubbed.stepTo(12.2);
      scrubbed.stepTo(37.4);
      const fresh = makeSim(species, 16, undefined, STORM_EAST);
      fresh.stepTo(37.4);
      expectSimsIdentical(scrubbed, fresh);
    }
  });

  it("keys the sim on consumed weather fields only", () => {
    const group = makeGroup("sheep", 8);
    const calmKey = wildlifeSimConfigKey(group, WORLD_SEED, GROUND_HEIGHT, WILDLIFE_CALM_ENVIRONMENT);
    // Preset, intensity, and wind changes replay the sim.
    expect(wildlifeSimConfigKey(group, WORLD_SEED, GROUND_HEIGHT, STORM_EAST)).not.toBe(calmKey);
    const windier: WildlifeEnvironment = {
      ...WILDLIFE_CALM_ENVIRONMENT,
      wind: { ...WILDLIFE_CALM_ENVIRONMENT.wind, speedMps: 6 },
    };
    expect(wildlifeSimConfigKey(group, WORLD_SEED, GROUND_HEIGHT, windier)).not.toBe(calmKey);
    // Wetness/cloud-cover (and turbulence) are not consumed: evolution
    // systems may drift them mid-shot without resetting herds.
    const wetter: WildlifeEnvironment = {
      wind: { ...WILDLIFE_CALM_ENVIRONMENT.wind, turbulence: 0.9 },
      weather: { ...WILDLIFE_CALM_ENVIRONMENT.weather, wetness: 1, cloudCover: 1 },
    };
    expect(wildlifeSimConfigKey(group, WORLD_SEED, GROUND_HEIGHT, wetter)).toBe(calmKey);
    const sim = createWildlifeSim(group, WORLD_SEED, GROUND_HEIGHT, WILDLIFE_CALM_ENVIRONMENT);
    expect(shouldRecreateWildlifeSim(sim, group, WORLD_SEED, GROUND_HEIGHT, wetter)).toBe(false);
    expect(shouldRecreateWildlifeSim(sim, group, WORLD_SEED, GROUND_HEIGHT, STORM_EAST)).toBe(true);
  });

  it("keeps herd checkpoint state on the flat sim plane even while scrubbing", () => {
    // Terrain snapping is render-only (wildlifeGrounding); replayed sim
    // state must never ingest scene mesh heights. posY must bit-equal the
    // flat ground plane after arbitrary scrub patterns.
    const sim = makeSim("wolves", 12, undefined, STORM_EAST);
    for (const t of [8, 42.5, 3.1, 61.7, 20]) {
      sim.stepTo(t);
      const state = sim.readState();
      for (let i = 0; i < state.count; i += 1) {
        expect(state.posY[i]).toBe(GROUND_HEIGHT);
      }
    }
  });
});

describe("wildlife sim lifecycle", () => {
  it("produces a fresh sim when count changes and reuses it otherwise", () => {
    const group = makeGroup("rabbits", 12);
    const sim = createWildlifeSim(group, WORLD_SEED, GROUND_HEIGHT);
    expect(sim.count).toBe(12);
    expect(shouldRecreateWildlifeSim(sim, group, WORLD_SEED, GROUND_HEIGHT)).toBe(false);
    // Render-only fields must not reset the simulation.
    const renderTweaked = { ...group, sizeScale: 3, name: "改名", visible: false };
    expect(shouldRecreateWildlifeSim(sim, renderTweaked, WORLD_SEED, GROUND_HEIGHT)).toBe(false);
    // Simulation-relevant fields must.
    const recounted = { ...group, count: 13 };
    expect(shouldRecreateWildlifeSim(sim, recounted, WORLD_SEED, GROUND_HEIGHT)).toBe(true);
    expect(wildlifeSimConfigKey(recounted, WORLD_SEED, GROUND_HEIGHT)).not.toBe(
      wildlifeSimConfigKey(group, WORLD_SEED, GROUND_HEIGHT),
    );
    expect(createWildlifeSim(recounted, WORLD_SEED, GROUND_HEIGHT).count).toBe(13);
    expect(shouldRecreateWildlifeSim(sim, group, WORLD_SEED + 1, GROUND_HEIGHT)).toBe(true);
    expect(shouldRecreateWildlifeSim(sim, group, WORLD_SEED, GROUND_HEIGHT + 1)).toBe(true);
  });
});

// Placeholder geometry builder tests live in placeholderModels.test.ts.
