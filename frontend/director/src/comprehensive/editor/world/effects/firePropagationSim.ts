import {
  DIRECTOR_WORLD_SIMULATION_HZ,
  type DirectorWorldEffect,
  type DirectorWorldSettings,
  type DirectorWorldWaterBody,
} from "../../../../../../../packages/protocol/src/worldSystemsProtocol";
import { hashCombine, worldStreamId } from "../worldRandom";
import { writeWorldWindVector } from "../worldWind";
import { evaluateWorldClimate } from "../worldClimate";
import { computeClimateSurfaceWetness } from "../surface/worldSurfaceResponse";

/**
 * Minimal deterministic fire-spread cellular automaton (no three.js).
 *
 * One sim per propagating `fire` effect: a coarse 2D ground grid centred on
 * the (unbound) anchor. Cell state is integer-only — status, accumulated
 * damage, remaining burn ticks — so replay is trivially bit-exact. Burning
 * cells deal Rothermel-shaped damage to their 8 neighbors each tick:
 * `base × spreadRate × (1 + k_w·max(0, ŵ·d̂)) × (1 − surfaceWetness)`,
 * with every factor quantized to 1/64 fixed point before the integer multiply.
 *
 * Determinism contract (same as wildlifeSim): state is a pure function of
 * (config, seed, quantized tick). `stepTo(seconds)` accepts arbitrary
 * non-monotonic targets; backward jumps restore the nearest ring checkpoint
 * at or before the target and replay the identical integer ops. Climate
 * inputs (surface wetness, rain level, wind gain) are sampled from the
 * deterministic climate evaluator at 1 Hz-quantized ticks, so they too are
 * pure functions of the tick, never of query order.
 *
 * View coupling: burning cells are exposed ordered by (ignitionTick, index)
 * so the render layer can key stateless particle emitters on
 * `(cell, ignitionTick)` — scrubbing regrows the exact same fire front.
 */

const HZ = DIRECTOR_WORLD_SIMULATION_HZ;
const DT = 1 / HZ;

/** Checkpoint cadence: one full snapshot every 5 simulated seconds. */
export const FIRE_CHECKPOINT_INTERVAL_TICKS = 150;
/** Ring capacity; the tick-0 snapshot is kept separately and never evicted. */
export const FIRE_MAX_CHECKPOINTS = 64;

/** Cell has never been touched by fire. */
export const FIRE_CELL_UNBURNT = 0;
/** Cell has accumulated damage but has not ignited yet. */
export const FIRE_CELL_IGNITING = 1;
/** Cell is actively burning (drives a view emitter). */
export const FIRE_CELL_BURNING = 2;
/** Cell has exhausted its fuel. */
export const FIRE_CELL_BURNT = 3;

/** Preferred cell edge; grows when the radius would exceed the grid cap. */
export const FIRE_CELL_SIZE_M = 1.5;
/** Cells per axis cap: 64 × 64 = 4096 cells per propagating fire. */
export const FIRE_MAX_GRID_DIM = 64;
/** View budget: spread-cell emitters per propagating fire (2 draws each). */
export const FIRE_VIEW_MAX_EMITTERS = 18;
/** View budget: propagating fire simulations per scene (authored order wins). */
export const FIRE_PROPAGATION_MAX_SYSTEMS = 4;

/**
 * Base neighbor damage per tick (fixed-point pipeline input). A front cell
 * usually takes damage from ~3 burning neighbors at once, so the effective
 * dry calm front speed is ~0.6–1 m/s (creeping previz fire, not a flashover).
 */
const BASE_DAMAGE = 4;
/** Wind bias strength k_w in the Rothermel-shaped spread factor. */
const WIND_BIAS = 0.9;
/** Wind speed (m/s) at which the directional bias saturates. */
const WIND_FULL_BIAS_MPS = 8;
/** Cap on the wind bias saturation ratio. */
const WIND_BIAS_MAX_RATIO = 1.5;
/** Fuel hit points hashed per cell into [min, max]. ~2.2–3.7 s per cell dry. */
const FUEL_HP_MIN = 520;
const FUEL_HP_MAX = 880;
/** Burn duration hashed per cell into [min, max] ticks (8–14 s). */
const BURN_TICKS_MIN = 240;
const BURN_TICKS_MAX = 420;
/** Ignition-source cells burn 3× longer so the origin anchors the fire. */
const SOURCE_BURN_MULTIPLIER = 3;
/** Rain level at which active extinguishing starts. */
const RAIN_EXTINGUISH_THRESHOLD = 0.3;
/** Extra burn-tick drain per tick at rain level 1 (burns out 5× faster). */
const RAIN_EXTINGUISH_DRAIN = 4;
/** Climate sample cadence: once per simulated second. */
const CLIMATE_SAMPLE_TICKS = HZ;

const FIRE_STREAM = worldStreamId("world-fire-propagation");
const HP_STREAM = 0;
const BURN_STREAM = 1;

/** 8-neighbor offsets, row-major order (stable iteration = stable sums). */
const NEIGHBOR_DX = [-1, 0, 1, -1, 1, -1, 0, 1] as const;
const NEIGHBOR_DZ = [-1, -1, -1, 0, 0, 1, 1, 1] as const;
/** Unit direction per neighbor (for the wind dot product). */
const NEIGHBOR_UX = NEIGHBOR_DX.map((dx, i) => dx / Math.hypot(dx, NEIGHBOR_DZ[i]));
const NEIGHBOR_UZ = NEIGHBOR_DZ.map((dz, i) => dz / Math.hypot(NEIGHBOR_DX[i], dz));
/** Distance falloff: diagonals are √2 away, so they take 1/√2 damage. */
const NEIGHBOR_DIST_SCALE = NEIGHBOR_DX.map((dx, i) => 1 / Math.hypot(dx, NEIGHBOR_DZ[i]));

/** Axis-aligned-in-local-frame water rectangle blocking fuel cells. */
export interface FireWaterRect {
  centerX: number;
  centerZ: number;
  sizeX: number;
  sizeZ: number;
  rotationDegrees: number;
}

/** Extracts blocking rectangles from authored water bodies (surface rects). */
export function toFireWaterRects(waterBodies: ReadonlyArray<DirectorWorldWaterBody>): FireWaterRect[] {
  return waterBodies.map((body) => ({
    centerX: body.surface.center[0],
    centerZ: body.surface.center[2],
    sizeX: body.surface.sizeX,
    sizeZ: body.surface.sizeZ,
    rotationDegrees: body.surface.rotationDegrees,
  }));
}

/** One burning cell exposed to the view layer. */
export interface FireBurningCell {
  /** Row-major cell index (stable across replays). */
  cellIndex: number;
  /** Tick at which this cell ignited; part of the emitter key. */
  ignitionTick: number;
  /** Cell centre X in world space (metres). */
  x: number;
  /** Cell centre Z in world space (metres). */
  z: number;
  /** Remaining burn fraction in (0, 1]; fades the view emitter out. */
  lifeFraction: number;
}

export interface FirePropagationSim {
  /** Deterministic identity key; changing it forces recreation. */
  readonly configKey: string;
  /** Cells per axis (square grid). */
  readonly gridDim: number;
  /** Cell edge length in metres. */
  readonly cellSizeM: number;
  /** World X of the grid's minimum corner. */
  readonly originX: number;
  /** World Z of the grid's minimum corner. */
  readonly originZ: number;
  /** Advance/rewind to the quantized tick floor(targetSeconds × HZ). */
  stepTo(targetSeconds: number): void;
  /** Current simulation tick after the last stepTo. */
  currentTick(): number;
  /** Live status view (FIRE_CELL_*); do not retain or mutate. */
  readStatus(): Uint8Array;
  /**
   * Burning cells ordered by (ignitionTick asc, cellIndex asc), capped at
   * `maxCount`. Allocation is bounded by the cap; safe to call per frame.
   */
  getBurningCells(maxCount: number): FireBurningCell[];
  /** Remaining burn fraction of one cell in [0, 1]; 0 when not burning. */
  readCellLife(cellIndex: number): number;
  /** Seconds since the cell ignited; 0 when not burning. */
  readCellAgeSeconds(cellIndex: number): number;
}

/** True when this authored effect should run the propagation CA. */
export function isFirePropagationEffect(effect: DirectorWorldEffect): boolean {
  return (
    effect.kind === "fire" &&
    effect.propagation?.enabled === true &&
    // Object-bound anchors would make ignition history depend on when the
    // binding was evaluated; the protocol restricts propagation to unbound.
    (effect.anchor.objectId === null || effect.anchor.objectId === undefined)
  );
}

/**
 * Identity of a fire sim run. Everything that influences the integer state is
 * part of the key: grid placement, spread tuning, world seed, wind block,
 * weather block (the climate suppression inputs), and the water rectangles.
 * View-only fields (intensity, sizeScale, colorTint) are excluded.
 */
export function firePropagationConfigKey(
  effect: DirectorWorldEffect,
  settings: DirectorWorldSettings,
  waterRects: ReadonlyArray<FireWaterRect>,
): string {
  const propagation = effect.propagation;
  const weather = settings.weather;
  return [
    effect.id,
    effect.seedOffset,
    effect.anchor.position.join(","),
    propagation ? `${propagation.radiusM},${propagation.spreadRate}` : "off",
    settings.seed,
    // Every field the wind evaluator reads: turbulence drives the flutter
    // band and heading meander, so an edit must invalidate the sim too.
    `${settings.wind.directionDegrees},${settings.wind.speedMps},${settings.wind.gustiness},${settings.wind.turbulence}`,
    `${weather.preset},${weather.intensity},${weather.wetness}`,
    weather.evolution ? `${weather.evolution.mode},${weather.evolution.periodSeconds}` : "static",
    waterRects
      .map((rect) => `${rect.centerX},${rect.centerZ},${rect.sizeX},${rect.sizeZ},${rect.rotationDegrees}`)
      .join(";"),
  ].join("|");
}

interface FireCheckpointSlot {
  tick: number;
  status: Uint8Array;
  damage: Int32Array;
  burnLeft: Int32Array;
  ignitionTick: Int32Array;
}

/**
 * Creates the deterministic fire-spread simulation for one propagating fire
 * effect. All mutable state lives in preallocated integer typed arrays;
 * stepping performs zero allocations (climate samples reuse a cached record).
 */
export function createFirePropagationSim(
  effect: DirectorWorldEffect,
  settings: DirectorWorldSettings,
  waterRects: ReadonlyArray<FireWaterRect>,
): FirePropagationSim {
  const propagation = effect.propagation;
  if (!propagation?.enabled) throw new Error("createFirePropagationSim requires propagation.enabled");
  const configKey = firePropagationConfigKey(effect, settings, waterRects);
  const radius = propagation.radiusM;
  const gridDim = Math.min(FIRE_MAX_GRID_DIM, Math.max(4, Math.ceil((2 * radius) / FIRE_CELL_SIZE_M)));
  const cellSizeM = (2 * radius) / gridDim;
  const anchorX = effect.anchor.position[0];
  const anchorZ = effect.anchor.position[2];
  const originX = anchorX - radius;
  const originZ = anchorZ - radius;
  const cellCount = gridDim * gridDim;
  const seedBase = hashCombine(settings.seed, effect.seedOffset, worldStreamId(effect.id), FIRE_STREAM);
  const spreadQ = Math.round(Math.min(3, Math.max(0.1, propagation.spreadRate)) * 64);

  // Immutable per-cell fuel (excluded from checkpoints) -----------------------
  const flammable = new Uint8Array(cellCount);
  const fuelHp = new Int32Array(cellCount);
  const burnDuration = new Int32Array(cellCount);

  // Mutable integer state ------------------------------------------------------
  const status = new Uint8Array(cellCount);
  const damage = new Int32Array(cellCount);
  const burnLeft = new Int32Array(cellCount);
  const ignitionTick = new Int32Array(cellCount);

  // Precompute water-rect local frames once.
  const rectCos = waterRects.map((rect) => Math.cos((-rect.rotationDegrees * Math.PI) / 180));
  const rectSin = waterRects.map((rect) => Math.sin((-rect.rotationDegrees * Math.PI) / 180));

  function cellCenterX(index: number): number {
    return originX + ((index % gridDim) + 0.5) * cellSizeM;
  }
  function cellCenterZ(index: number): number {
    return originZ + (Math.floor(index / gridDim) + 0.5) * cellSizeM;
  }

  function isWaterCovered(x: number, z: number): boolean {
    for (let r = 0; r < waterRects.length; r += 1) {
      const rect = waterRects[r];
      const dx = x - rect.centerX;
      const dz = z - rect.centerZ;
      const localX = dx * rectCos[r] - dz * rectSin[r];
      const localZ = dx * rectSin[r] + dz * rectCos[r];
      if (Math.abs(localX) <= rect.sizeX / 2 && Math.abs(localZ) <= rect.sizeZ / 2) return true;
    }
    return false;
  }

  for (let index = 0; index < cellCount; index += 1) {
    const x = cellCenterX(index);
    const z = cellCenterZ(index);
    const wet = isWaterCovered(x, z);
    flammable[index] = wet ? 0 : 1;
    const hpRoll = hashCombine(seedBase, index, HP_STREAM) / 4_294_967_296;
    fuelHp[index] = FUEL_HP_MIN + Math.floor((FUEL_HP_MAX - FUEL_HP_MIN) * hpRoll);
    const burnRoll = hashCombine(seedBase, index, BURN_STREAM) / 4_294_967_296;
    burnDuration[index] = BURN_TICKS_MIN + Math.floor((BURN_TICKS_MAX - BURN_TICKS_MIN) * burnRoll);
  }

  // Ignition sources: the anchor cell plus axis neighbors within 1.2 cells.
  const igniteRadius = cellSizeM * 1.2;
  const sourceCells: number[] = [];
  for (let index = 0; index < cellCount; index += 1) {
    if (!flammable[index]) continue;
    const dx = cellCenterX(index) - anchorX;
    const dz = cellCenterZ(index) - anchorZ;
    if (dx * dx + dz * dz <= igniteRadius * igniteRadius) sourceCells.push(index);
  }
  for (const index of sourceCells) {
    burnDuration[index] *= SOURCE_BURN_MULTIPLIER;
    status[index] = FIRE_CELL_BURNING;
    ignitionTick[index] = 0;
    burnLeft[index] = burnDuration[index];
  }

  // Checkpoints ----------------------------------------------------------------
  const makeSlot = (): FireCheckpointSlot => ({
    tick: -1,
    status: new Uint8Array(cellCount),
    damage: new Int32Array(cellCount),
    burnLeft: new Int32Array(cellCount),
    ignitionTick: new Int32Array(cellCount),
  });
  const ringSlots: FireCheckpointSlot[] = Array.from({ length: FIRE_MAX_CHECKPOINTS }, makeSlot);
  const zeroSlot = makeSlot();

  let simTick = 0;

  function storeCheckpoint(slot: FireCheckpointSlot): void {
    slot.tick = simTick;
    slot.status.set(status);
    slot.damage.set(damage);
    slot.burnLeft.set(burnLeft);
    slot.ignitionTick.set(ignitionTick);
  }

  function restoreCheckpoint(slot: FireCheckpointSlot): void {
    status.set(slot.status);
    damage.set(slot.damage);
    burnLeft.set(slot.burnLeft);
    ignitionTick.set(slot.ignitionTick);
    simTick = slot.tick;
    climateSampleTick = -1; // resample lazily; the sample is a pure fn of tick
  }

  function bestCheckpointAtMost(tick: number): FireCheckpointSlot {
    let best = zeroSlot;
    for (let index = 0; index < ringSlots.length; index += 1) {
      const slot = ringSlots[index];
      if (slot.tick >= 0 && slot.tick <= tick && slot.tick > best.tick) best = slot;
    }
    return best;
  }

  // Climate sampling (pure function of the quantized tick) ---------------------
  let climateSampleTick = -1;
  let dryQ = 64;
  let rainDrain = 0;
  let windGain = 1;

  function sampleClimate(tick: number): void {
    const sampleTick = tick - (tick % CLIMATE_SAMPLE_TICKS);
    if (sampleTick === climateSampleTick) return;
    climateSampleTick = sampleTick;
    const climate = evaluateWorldClimate(settings, sampleTick * DT);
    const surfaceWetness = computeClimateSurfaceWetness(climate);
    dryQ = Math.round(Math.min(1, Math.max(0, 1 - surfaceWetness)) * 64);
    rainDrain =
      climate.rainLevel >= RAIN_EXTINGUISH_THRESHOLD
        ? Math.floor(Math.min(1, climate.rainLevel) * RAIN_EXTINGUISH_DRAIN)
        : 0;
    windGain = climate.windGain;
  }

  // Stepping --------------------------------------------------------------------
  const windScratch: [number, number, number] = [0, 0, 0];
  const dirWeightQ = new Int32Array(8);

  function step(): void {
    const tick = simTick;
    sampleClimate(tick);

    // Directional wind bias, quantized once per tick (not per cell).
    writeWorldWindVector(windScratch, settings.wind, tick * DT);
    const windX = windScratch[0] * windGain;
    const windZ = windScratch[2] * windGain;
    const windSpeed = Math.hypot(windX, windZ);
    const biasRatio = Math.min(windSpeed / WIND_FULL_BIAS_MPS, WIND_BIAS_MAX_RATIO);
    const invSpeed = windSpeed > 1e-6 ? 1 / windSpeed : 0;
    for (let d = 0; d < 8; d += 1) {
      const dot = invSpeed > 0 ? (windX * NEIGHBOR_UX[d] + windZ * NEIGHBOR_UZ[d]) * invSpeed : 0;
      const factor = 1 + WIND_BIAS * Math.max(0, dot) * biasRatio;
      dirWeightQ[d] = Math.round(factor * NEIGHBOR_DIST_SCALE[d] * 64);
    }

    // Phase 1: burning cells deal integer damage to their 8 neighbors.
    if (dryQ > 0) {
      for (let index = 0; index < cellCount; index += 1) {
        if (status[index] !== FIRE_CELL_BURNING) continue;
        const col = index % gridDim;
        const row = (index - col) / gridDim;
        for (let d = 0; d < 8; d += 1) {
          const ncol = col + NEIGHBOR_DX[d];
          const nrow = row + NEIGHBOR_DZ[d];
          if (ncol < 0 || ncol >= gridDim || nrow < 0 || nrow >= gridDim) continue;
          const neighbor = nrow * gridDim + ncol;
          if (!flammable[neighbor] || status[neighbor] >= FIRE_CELL_BURNING) continue;
          const dealt = Math.floor((BASE_DAMAGE * dirWeightQ[d] * dryQ * spreadQ) / 262_144);
          if (dealt <= 0) continue;
          damage[neighbor] += dealt;
          if (status[neighbor] === FIRE_CELL_UNBURNT) status[neighbor] = FIRE_CELL_IGNITING;
        }
      }
    }

    // Phase 2: synchronous ignition resolve (new fires start next tick).
    for (let index = 0; index < cellCount; index += 1) {
      if (status[index] !== FIRE_CELL_IGNITING) continue;
      if (damage[index] < fuelHp[index]) continue;
      status[index] = FIRE_CELL_BURNING;
      ignitionTick[index] = tick + 1;
      burnLeft[index] = burnDuration[index];
    }

    // Phase 3: burn down; rain drains extra ticks.
    for (let index = 0; index < cellCount; index += 1) {
      if (status[index] !== FIRE_CELL_BURNING || ignitionTick[index] > tick) continue;
      burnLeft[index] -= 1 + rainDrain;
      if (burnLeft[index] <= 0) {
        burnLeft[index] = 0;
        status[index] = FIRE_CELL_BURNT;
      }
    }

    simTick += 1;
    if (simTick % FIRE_CHECKPOINT_INTERVAL_TICKS === 0) {
      const slotIndex = (simTick / FIRE_CHECKPOINT_INTERVAL_TICKS) % FIRE_MAX_CHECKPOINTS;
      storeCheckpoint(ringSlots[slotIndex]);
    }
  }

  storeCheckpoint(zeroSlot);

  function stepTo(targetSeconds: number): void {
    const seconds = Number.isFinite(targetSeconds) ? Math.max(0, targetSeconds) : 0;
    const targetTick = Math.floor(seconds * HZ);
    if (simTick === targetTick) return;
    if (simTick > targetTick) {
      restoreCheckpoint(bestCheckpointAtMost(targetTick));
    } else {
      const best = bestCheckpointAtMost(targetTick);
      if (best.tick > simTick) restoreCheckpoint(best);
    }
    while (simTick < targetTick) step();
  }

  function getBurningCells(maxCount: number): FireBurningCell[] {
    const cells: FireBurningCell[] = [];
    for (let index = 0; index < cellCount; index += 1) {
      if (status[index] !== FIRE_CELL_BURNING) continue;
      cells.push({
        cellIndex: index,
        ignitionTick: ignitionTick[index],
        x: cellCenterX(index),
        z: cellCenterZ(index),
        lifeFraction: burnLeft[index] / burnDuration[index],
      });
    }
    cells.sort((a, b) => a.ignitionTick - b.ignitionTick || a.cellIndex - b.cellIndex);
    if (cells.length > maxCount) cells.length = maxCount;
    return cells;
  }

  return {
    configKey,
    gridDim,
    cellSizeM,
    originX,
    originZ,
    stepTo,
    currentTick: () => simTick,
    readStatus: () => status,
    getBurningCells,
    readCellLife(cellIndex: number): number {
      if (status[cellIndex] !== FIRE_CELL_BURNING) return 0;
      return burnLeft[cellIndex] / burnDuration[cellIndex];
    },
    readCellAgeSeconds(cellIndex: number): number {
      if (status[cellIndex] !== FIRE_CELL_BURNING) return 0;
      return Math.max(0, (simTick - ignitionTick[cellIndex]) * DT);
    },
  };
}
