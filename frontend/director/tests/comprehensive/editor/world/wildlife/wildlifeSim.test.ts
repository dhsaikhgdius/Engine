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
  WILDLIFE_BEHAVIOR_GRAZE,
  WILDLIFE_BEHAVIOR_WALK,
  WILDLIFE_CRUISE_SPEED_MPS,
  WILDLIFE_DEFAULT_ALTITUDE_BAND_M,
  wildlifeSimConfigKey,
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

function makeSim(species: WorldWildlifeSpecies, count: number, overrides?: Partial<DirectorWorldWildlifeGroup>) {
  return createWildlifeSim(makeGroup(species, count, overrides), WORLD_SEED, GROUND_HEIGHT);
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
