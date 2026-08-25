import {
  DIRECTOR_WORLD_SIMULATION_HZ,
  WORLD_WILDLIFE_SPECIES_ARCHETYPE,
  type DirectorWorldWildlifeGroup,
  type WorldWildlifeArchetype,
  type WorldWildlifeSpecies,
} from "../../../../../../../packages/protocol/src/worldSystemsProtocol";
import { hashCombine, hashUint32, worldStreamId } from "../worldRandom";

/**
 * Pure wildlife simulation core (no three.js imports).
 *
 * Determinism contract: state is a pure function of (group config, world seed,
 * groundHeight, quantized tick). Time is quantized to the fixed
 * DIRECTOR_WORLD_SIMULATION_HZ timestep; `stepTo(seconds)` may be called with
 * arbitrary, non-monotonic targets (scrubbing, out-of-order frame export) and
 * must resolve to bit-identical Float32Array state regardless of the path
 * taken. Backward (and far-forward) jumps restore the nearest checkpoint at or
 * before the target tick and replay; replay executes the exact same float ops
 * on bit-identical restored state, so results match continuous stepping.
 *
 * All per-agent state lives in preallocated SoA typed arrays; stepping
 * performs zero allocations. Neighbor queries are O(N^2) with squared-distance
 * early-outs, which is fine at N <= 256.
 */

const HZ = DIRECTOR_WORLD_SIMULATION_HZ;
const DT = 1 / HZ;
const TWO_PI = Math.PI * 2;

/** Checkpoint cadence: one full snapshot every 5 simulated seconds. */
export const WILDLIFE_CHECKPOINT_INTERVAL_TICKS = 150;
/** Ring capacity; the tick-0 snapshot is kept separately and never evicted. */
export const WILDLIFE_MAX_CHECKPOINTS = 64;

/**
 * Containment tuning. The sim softly steers agents back from 85% of the area
 * radius and hard-clamps at 108%, comfortably inside the 15% soft margin the
 * behavior tests (and the visual contract) allow.
 */
const SOFT_CONTAINMENT_SCALE = 0.85;
const HARD_CONTAINMENT_SCALE = 1.08;
/** Altitude band hard clamp expands the band by 8% of its span (min 0.05 m). */
const BAND_HARD_MARGIN_SCALE = 0.08;

/** Agent is moving toward a walk target. */
export const WILDLIFE_BEHAVIOR_WALK = 0;
/** Agent is stationary, grazing (herd species only). */
export const WILDLIFE_BEHAVIOR_GRAZE = 1;
/** Agent is returning to the herd center after being pushed out. */
export const WILDLIFE_BEHAVIOR_REGROUP = 2;

/** Nominal cruise/walk speed per species (m/s) before `speedScale`. */
export const WILDLIFE_CRUISE_SPEED_MPS: Record<WorldWildlifeSpecies, number> = {
  birds: 9,
  butterflies: 1.2,
  fish: 1.6,
  deer: 1.8,
  rabbits: 2.2,
  wolves: 2.5,
  sheep: 1.2,
};

/** Default flight band (metres above area.center.y) when `altitude` is absent. */
export const WILDLIFE_DEFAULT_ALTITUDE_BAND_M: Record<"birds" | "butterflies", [number, number]> = {
  birds: [8, 25],
  butterflies: [0.5, 3],
};

// ---------------------------------------------------------------------------
// Serializable RNG
// ---------------------------------------------------------------------------

/**
 * Serializable RNG contract so checkpoint save/restore can capture the state.
 */
export interface WildlifeRng {
  /** Returns the next pseudo-random float in [0, 1). */
  next(): number;
  /** Returns the current internal state for checkpoint serialization. */
  getState(): number;
  /** Restores the internal state from a checkpoint. */
  setState(state: number): void;
}

/**
 * Serializable twin of `createWorldRng`.
 *
 * `createWorldRng` hides its state inside a closure, so checkpoints could not
 * capture or restore it. This wrapper re-implements the exact same algorithm
 * (a Weyl sequence advanced by the golden-ratio increment, avalanched through
 * the shared lowbias32 `hashUint32` — a splitmix32-family generator) with
 * explicit get/set state. A unit test locks both sequences together so the
 * implementations can never drift apart.
 */
export function createWildlifeRng(seed: number): WildlifeRng {
  let state = hashUint32(seed === 0 ? 0x1234_5678 : seed);
  return {
    next(): number {
      state = (state + 0x9e37_79b9) >>> 0;
      return hashUint32(state) / 4_294_967_296;
    },
    getState(): number {
      return state;
    },
    setState(next: number): void {
      state = next >>> 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Public state views
// ---------------------------------------------------------------------------

/**
 * Read-only window onto sim buffers. Arrays are live views (no copies); the
 * sim rewrites them on `stepTo`, so consumers must not retain values across
 * frames or mutate them. `tick` is managed by the sim.
 */
export interface WildlifeSimStateView {
  /** Number of agents in this group. */
  readonly count: number;
  /** Current simulation tick (managed by the sim). */
  tick: number;
  /** Agent X positions (live view, do not retain across frames). */
  readonly posX: Float32Array;
  /** Agent Y positions (live view, do not retain across frames). */
  readonly posY: Float32Array;
  /** Agent Z positions (live view, do not retain across frames). */
  readonly posZ: Float32Array;
  /** Agent X velocity components (live view). */
  readonly velX: Float32Array;
  /** Agent Y velocity components (live view). */
  readonly velY: Float32Array;
  /** Agent Z velocity components (live view). */
  readonly velZ: Float32Array;
  /** Herd steering heading (radians, yaw around +Y, forward +Z). */
  readonly heading: Float32Array;
  /** WILDLIFE_BEHAVIOR_* flag per agent (flock/school agents stay at WALK). */
  readonly behaviorState: Float32Array;
  /** Smoothed 0..1 graze pose blend for render (head-down transition). */
  readonly grazeBlend: Float32Array;
  /** Immutable per-agent animation phase offset in [0, 2π). */
  readonly phase: Float32Array;
}

/** Two surrounding ticks plus blend factor for inter-tick interpolation. */
export interface WildlifeSimRenderView {
  /** Number of agents in this group. */
  readonly count: number;
  /** Interpolation factor in [0, 1] between `prev` and `curr` ticks. */
  alpha: number;
  /** State at tick floor(seconds × HZ). */
  readonly prev: WildlifeSimStateView;
  /** State at the following tick (lookahead for interpolation). */
  readonly curr: WildlifeSimStateView;
}

export interface WildlifeSim {
  /** Deterministic identity key of the sim; changing it forces recreation. */
  readonly configKey: string;
  /** Behavioral archetype: flock, school, or herd. */
  readonly archetype: WorldWildlifeArchetype;
  /** Wildlife species driving gait and visual tuning. */
  readonly species: WorldWildlifeSpecies;
  /** Total number of agents in this group. */
  readonly count: number;
  /**
   * Advance/rewind to the quantized tick floor(targetSeconds × HZ). Safe to
   * call with any finite value in any order.
   */
  stepTo(targetSeconds: number): void;
  /** Canonical state at the last stepTo target tick. */
  readState(): WildlifeSimStateView;
  /** Interpolation pair around the last stepTo target time. */
  readRenderState(): WildlifeSimRenderView;
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

interface ResolvedSimConfig {
  archetype: WorldWildlifeArchetype;
  species: WorldWildlifeSpecies;
  count: number;
  centerX: number;
  centerY: number;
  centerZ: number;
  radius: number;
  groundY: number;
  cruise: number;
  // Boids (flock/school)
  neighborRadius: number;
  separationRadius: number;
  alignWeight: number;
  cohesionWeight: number;
  separationWeight: number;
  containAccel: number;
  maxAccel: number;
  flutterAccel: number;
  /** Absolute altitude band (flock) or [unused, soft ceiling] (school). */
  bandMinY: number;
  bandMaxY: number;
  bandHardMinY: number;
  bandHardMaxY: number;
  // Herd
  turnRate: number;
  accel: number;
  herdSeparationRadius: number;
}

function resolveSimConfig(group: DirectorWorldWildlifeGroup, groundHeight: number): ResolvedSimConfig {
  const species = group.species;
  const archetype = WORLD_WILDLIFE_SPECIES_ARCHETYPE[species];
  const [centerX, centerY, centerZ] = group.area.center;
  const radius = group.area.radius;
  const cruise = WILDLIFE_CRUISE_SPEED_MPS[species] * group.speedScale;

  const config: ResolvedSimConfig = {
    archetype,
    species,
    count: group.count,
    centerX,
    centerY,
    centerZ,
    radius,
    groundY: groundHeight,
    cruise,
    neighborRadius: 6,
    separationRadius: 2,
    alignWeight: 1.5,
    cohesionWeight: 1.2,
    separationWeight: 4,
    containAccel: cruise * 3,
    maxAccel: cruise * 3.5,
    flutterAccel: 0,
    bandMinY: centerY,
    bandMaxY: centerY,
    bandHardMinY: centerY,
    bandHardMaxY: centerY,
    turnRate: 2.5,
    accel: 2.5,
    herdSeparationRadius: 1.6,
  };

  if (archetype === "flock") {
    const defaults = WILDLIFE_DEFAULT_ALTITUDE_BAND_M[species === "birds" ? "birds" : "butterflies"];
    const minM = group.altitude ? group.altitude.minM : defaults[0];
    const maxM = group.altitude ? group.altitude.maxM : defaults[1];
    config.bandMinY = centerY + Math.min(minM, maxM);
    config.bandMaxY = centerY + Math.max(minM, maxM);
    const hardMargin = Math.max((config.bandMaxY - config.bandMinY) * BAND_HARD_MARGIN_SCALE, 0.05);
    config.bandHardMinY = config.bandMinY - hardMargin;
    config.bandHardMaxY = config.bandMaxY + hardMargin;
    if (species === "birds") {
      config.neighborRadius = 6;
      config.separationRadius = 2.2;
    } else {
      // Butterflies: loose micro-flock with strong per-agent flutter.
      config.neighborRadius = 2;
      config.separationRadius = 0.5;
      config.alignWeight = 0.8;
      config.cohesionWeight = 0.6;
      config.flutterAccel = 3;
    }
  } else if (archetype === "school") {
    // area.center.y is the water surface; fish live in the sphere below it.
    config.neighborRadius = 2.5;
    config.separationRadius = 0.7;
    config.alignWeight = 2;
    config.cohesionWeight = 2.4;
    config.separationWeight = 5;
    config.bandMinY = centerY - radius;
    config.bandMaxY = centerY - Math.min(0.5, radius * 0.6); // soft ceiling
    config.bandHardMaxY = centerY - Math.min(0.05, radius * 0.1); // hard ceiling
    config.bandHardMinY = centerY - radius;
  } else {
    const herdTuning: Record<string, { turnRate: number; accel: number }> = {
      deer: { turnRate: 2.5, accel: 2.5 },
      rabbits: { turnRate: 4, accel: 6 },
      wolves: { turnRate: 2.8, accel: 3 },
      sheep: { turnRate: 2, accel: 1.5 },
    };
    const tuning = herdTuning[species] ?? { turnRate: 2.5, accel: 2.5 };
    config.turnRate = tuning.turnRate;
    config.accel = tuning.accel;
  }
  return config;
}

/**
 * Identity of a sim run. Any field that influences simulation state is part
 * of the key; render-only fields (sizeScale, assetId, name, visible, locked)
 * are deliberately excluded so tweaking them never resets the simulation.
 */
export function wildlifeSimConfigKey(
  group: DirectorWorldWildlifeGroup,
  worldSeed: number,
  groundHeight: number,
): string {
  const altitude = group.altitude ? `${group.altitude.minM},${group.altitude.maxM}` : "default";
  return [
    group.id,
    group.species,
    group.count,
    group.seedOffset,
    group.speedScale,
    group.area.center.join(","),
    group.area.radius,
    altitude,
    worldSeed,
    groundHeight,
  ].join("|");
}

/** True when the render layer must throw away `sim` and create a fresh one. */
export function shouldRecreateWildlifeSim(
  sim: WildlifeSim,
  group: DirectorWorldWildlifeGroup,
  worldSeed: number,
  groundHeight: number,
): boolean {
  return sim.configKey !== wildlifeSimConfigKey(group, worldSeed, groundHeight);
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

interface CheckpointSlot {
  tick: number;
  rngState: number;
  arrays: Float32Array[];
}

function wrapAngle(angle: number): number {
  let wrapped = angle % TWO_PI;
  if (wrapped > Math.PI) wrapped -= TWO_PI;
  else if (wrapped < -Math.PI) wrapped += TWO_PI;
  return wrapped;
}

/**
 * Creates a deterministic wildlife simulation for a group.
 *
 * All state lives in preallocated SoA typed arrays; stepping performs zero
 * allocations. The sim is a pure function of (group config, world seed,
 * groundHeight, quantized tick) — no three.js, no scene, no DOM.
 *
 * @param group - The wildlife group configuration from the world system.
 * @param worldSeed - The world-level seed for deterministic RNG.
 * @param groundHeight - Flat ground-plane Y for the sim (terrain is applied in render).
 * @returns A WildlifeSim ready to stepTo any target time.
 */
export function createWildlifeSim(
  group: DirectorWorldWildlifeGroup,
  worldSeed: number,
  groundHeight: number,
): WildlifeSim {
  const config = resolveSimConfig(group, groundHeight);
  const configKey = wildlifeSimConfigKey(group, worldSeed, groundHeight);
  const n = config.count;
  const rng = createWildlifeRng(hashCombine(worldSeed, group.seedOffset, worldStreamId(group.id)));

  // Live SoA state -----------------------------------------------------------
  const posX = new Float32Array(n);
  const posY = new Float32Array(n);
  const posZ = new Float32Array(n);
  const velX = new Float32Array(n);
  const velY = new Float32Array(n);
  const velZ = new Float32Array(n);
  const heading = new Float32Array(n);
  const behaviorState = new Float32Array(n);
  const behaviorTimer = new Float32Array(n);
  const targetX = new Float32Array(n);
  const targetZ = new Float32Array(n);
  const speedCur = new Float32Array(n);
  const grazeBlend = new Float32Array(n);
  const phase = new Float32Array(n); // immutable after spawn — excluded from checkpoints

  // Scratch accumulators (Float64 to keep pair sums in double precision).
  const accSepX = new Float64Array(n);
  const accSepY = new Float64Array(n);
  const accSepZ = new Float64Array(n);
  const accAliX = new Float64Array(n);
  const accAliY = new Float64Array(n);
  const accAliZ = new Float64Array(n);
  const accCohX = new Float64Array(n);
  const accCohY = new Float64Array(n);
  const accCohZ = new Float64Array(n);
  const neighborCount = new Float64Array(n);

  // Previous-tick copies exposed to the render layer for interpolation.
  const prevPosX = new Float32Array(n);
  const prevPosY = new Float32Array(n);
  const prevPosZ = new Float32Array(n);
  const prevVelX = new Float32Array(n);
  const prevVelY = new Float32Array(n);
  const prevVelZ = new Float32Array(n);
  const prevHeading = new Float32Array(n);
  const prevBehaviorState = new Float32Array(n);
  const prevGrazeBlend = new Float32Array(n);

  /**
   * Every mutable array a step can touch. Flock/school steering never writes
   * the herd behavior arrays (they stay at their spawn values), so their
   * checkpoints only carry pos+vel — roughly half the memory of a herd slot.
   */
  const mutableArrays: Float32Array[] =
    config.archetype === "herd"
      ? [
          posX,
          posY,
          posZ,
          velX,
          velY,
          velZ,
          heading,
          behaviorState,
          behaviorTimer,
          targetX,
          targetZ,
          speedCur,
          grazeBlend,
        ]
      : [posX, posY, posZ, velX, velY, velZ];

  const makeSlot = (): CheckpointSlot => ({
    tick: -1,
    rngState: 0,
    arrays: mutableArrays.map((array) => new Float32Array(array.length)),
  });
  // Preallocated up front so stepping (including checkpoint stores) never allocates.
  const ringSlots: CheckpointSlot[] = Array.from({ length: WILDLIFE_MAX_CHECKPOINTS }, makeSlot);
  const zeroSlot = makeSlot();

  let simTick = 0;
  let prevTick = -1;
  let lastAlpha = 0;

  function storeCheckpoint(slot: CheckpointSlot): void {
    slot.tick = simTick;
    slot.rngState = rng.getState();
    for (let index = 0; index < mutableArrays.length; index += 1) {
      slot.arrays[index].set(mutableArrays[index]);
    }
  }

  function restoreCheckpoint(slot: CheckpointSlot): void {
    for (let index = 0; index < mutableArrays.length; index += 1) {
      mutableArrays[index].set(slot.arrays[index]);
    }
    rng.setState(slot.rngState);
    simTick = slot.tick;
    prevTick = -1; // prev copies are stale until the next stepTo refills them
  }

  /**
   * Newest checkpoint at or before `tick`. The dedicated tick-0 slot always
   * qualifies, so lookup never fails; ring entries ahead of the current sim
   * tick stay valid too (the trajectory is deterministic, so previously
   * simulated futures can be jumped to directly).
   */
  function bestCheckpointAtMost(tick: number): CheckpointSlot {
    let best = zeroSlot;
    for (let index = 0; index < ringSlots.length; index += 1) {
      const slot = ringSlots[index];
      if (slot.tick >= 0 && slot.tick <= tick && slot.tick > best.tick) best = slot;
    }
    return best;
  }

  // --- Spawn -----------------------------------------------------------------

  function spawn(): void {
    const { centerX, centerZ, radius } = config;
    for (let i = 0; i < n; i += 1) {
      if (config.archetype === "herd") {
        const angle = rng.next() * TWO_PI;
        const dist = radius * 0.7 * Math.sqrt(rng.next());
        posX[i] = centerX + Math.sin(angle) * dist;
        posZ[i] = centerZ + Math.cos(angle) * dist;
        posY[i] = config.groundY;
        heading[i] = rng.next() * TWO_PI;
        phase[i] = rng.next() * TWO_PI;
        behaviorState[i] = WILDLIFE_BEHAVIOR_GRAZE;
        behaviorTimer[i] = 0.5 + rng.next() * 4; // staggered first transitions
        targetX[i] = posX[i];
        targetZ[i] = posZ[i];
        speedCur[i] = 0;
        grazeBlend[i] = 1;
        velX[i] = 0;
        velY[i] = 0;
        velZ[i] = 0;
      } else {
        const angle = rng.next() * TWO_PI;
        const dist = radius * 0.6 * Math.sqrt(rng.next());
        const yMix = rng.next();
        const velYaw = rng.next() * TWO_PI;
        const velPitch = (rng.next() - 0.5) * 0.5;
        phase[i] = rng.next() * TWO_PI;
        posX[i] = centerX + Math.sin(angle) * dist;
        posZ[i] = centerZ + Math.cos(angle) * dist;
        posY[i] =
          config.archetype === "school"
            ? config.bandHardMaxY - Math.min(0.1, config.radius * 0.1) - yMix * config.radius * 0.5
            : config.bandMinY + (config.bandMaxY - config.bandMinY) * yMix;
        const cosPitch = Math.cos(velPitch);
        velX[i] = Math.sin(velYaw) * cosPitch * config.cruise;
        velY[i] = Math.sin(velPitch) * config.cruise;
        velZ[i] = Math.cos(velYaw) * cosPitch * config.cruise;
        heading[i] = velYaw;
        behaviorState[i] = WILDLIFE_BEHAVIOR_WALK;
        behaviorTimer[i] = 0;
        targetX[i] = posX[i];
        targetZ[i] = posZ[i];
        speedCur[i] = config.cruise;
        grazeBlend[i] = 0;
      }
    }
  }

  // --- Boids step (flock + school) -------------------------------------------

  function stepBoids(): void {
    const {
      centerX,
      centerY,
      centerZ,
      radius,
      cruise,
      neighborRadius,
      separationRadius,
      alignWeight,
      cohesionWeight,
      separationWeight,
      containAccel,
      maxAccel,
      flutterAccel,
    } = config;
    const isSchool = config.archetype === "school";
    const neighborR2 = neighborRadius * neighborRadius;
    const separationR2 = separationRadius * separationRadius;
    const softRadius = radius * SOFT_CONTAINMENT_SCALE;
    const hardRadius = radius * HARD_CONTAINMENT_SCALE;
    const bandEdge = Math.max((config.bandMaxY - config.bandMinY) * 0.2, 0.1);
    const stateSeconds = simTick * DT;

    for (let i = 0; i < n; i += 1) {
      accSepX[i] = 0;
      accSepY[i] = 0;
      accSepZ[i] = 0;
      accAliX[i] = 0;
      accAliY[i] = 0;
      accAliZ[i] = 0;
      accCohX[i] = 0;
      accCohY[i] = 0;
      accCohZ[i] = 0;
      neighborCount[i] = 0;
    }

    // Phase 1: symmetric pair accumulation against the pre-step snapshot.
    for (let i = 0; i < n; i += 1) {
      const pix = posX[i];
      const piy = posY[i];
      const piz = posZ[i];
      for (let j = i + 1; j < n; j += 1) {
        const dx = posX[j] - pix;
        const dy = posY[j] - piy;
        const dz = posZ[j] - piz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > neighborR2) continue;
        accAliX[i] += velX[j];
        accAliY[i] += velY[j];
        accAliZ[i] += velZ[j];
        accAliX[j] += velX[i];
        accAliY[j] += velY[i];
        accAliZ[j] += velZ[i];
        accCohX[i] += posX[j];
        accCohY[i] += posY[j];
        accCohZ[i] += posZ[j];
        accCohX[j] += pix;
        accCohY[j] += piy;
        accCohZ[j] += piz;
        neighborCount[i] += 1;
        neighborCount[j] += 1;
        if (d2 < separationR2 && d2 > 1e-9) {
          const inv = 1 / d2;
          accSepX[i] -= dx * inv;
          accSepY[i] -= dy * inv;
          accSepZ[i] -= dz * inv;
          accSepX[j] += dx * inv;
          accSepY[j] += dy * inv;
          accSepZ[j] += dz * inv;
        }
      }
    }

    // Phase 2: integrate.
    for (let i = 0; i < n; i += 1) {
      let px = posX[i];
      let py = posY[i];
      let pz = posZ[i];
      let vx = velX[i];
      let vy = velY[i];
      let vz = velZ[i];

      let ax = accSepX[i] * separationWeight;
      let ay = accSepY[i] * separationWeight;
      let az = accSepZ[i] * separationWeight;
      const neighbors = neighborCount[i];
      if (neighbors > 0) {
        const inv = 1 / neighbors;
        ax += (accAliX[i] * inv - vx) * alignWeight;
        ay += (accAliY[i] * inv - vy) * alignWeight;
        az += (accAliZ[i] * inv - vz) * alignWeight;
        ax += (accCohX[i] * inv - px) * cohesionWeight;
        ay += (accCohY[i] * inv - py) * cohesionWeight;
        az += (accCohZ[i] * inv - pz) * cohesionWeight;
      }

      // Containment steering toward the area center.
      if (isSchool) {
        const ox = px - centerX;
        const oy = py - centerY;
        const oz = pz - centerZ;
        const dist = Math.sqrt(ox * ox + oy * oy + oz * oz);
        if (dist > softRadius && dist > 1e-6) {
          const excess = Math.min((dist - softRadius) / Math.max(radius - softRadius, 1e-6), 1.5);
          const pull = containAccel * excess * excess;
          ax -= (ox / dist) * pull;
          ay -= (oy / dist) * pull;
          az -= (oz / dist) * pull;
        }
        // Soft ceiling below the water surface.
        if (py > config.bandMaxY) ay -= containAccel * Math.min((py - config.bandMaxY) / bandEdge, 1.5);
      } else {
        const ox = px - centerX;
        const oz = pz - centerZ;
        const dist = Math.sqrt(ox * ox + oz * oz);
        if (dist > softRadius && dist > 1e-6) {
          const excess = Math.min((dist - softRadius) / Math.max(radius - softRadius, 1e-6), 1.5);
          const pull = containAccel * excess * excess;
          ax -= (ox / dist) * pull;
          az -= (oz / dist) * pull;
        }
        // Altitude band springs.
        if (py < config.bandMinY + bandEdge) {
          ay += containAccel * Math.min((config.bandMinY + bandEdge - py) / bandEdge, 1.5);
        } else if (py > config.bandMaxY - bandEdge) {
          ay -= containAccel * Math.min((py - (config.bandMaxY - bandEdge)) / bandEdge, 1.5);
        }
      }

      // Butterfly flutter: seeded sine jitter, deterministic in (tick, phase).
      if (flutterAccel > 0) {
        const flutterPhase = phase[i];
        ax += Math.sin(stateSeconds * 5.1 + flutterPhase * 1.7) * flutterAccel;
        ay += Math.sin(stateSeconds * 7.3 + flutterPhase) * flutterAccel * 1.6;
        az += Math.cos(stateSeconds * 4.3 + flutterPhase * 2.3) * flutterAccel;
      }

      const accel2 = ax * ax + ay * ay + az * az;
      if (accel2 > maxAccel * maxAccel) {
        const scale = maxAccel / Math.sqrt(accel2);
        ax *= scale;
        ay *= scale;
        az *= scale;
      }

      vx += ax * DT;
      vy += ay * DT;
      vz += az * DT;

      // Speed regulation: clamp into [0.5, 1.5] × cruise, then relax toward cruise.
      const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (speed < 1e-4) {
        // Deterministic recovery from a degenerate stall: head out by phase.
        vx = Math.sin(phase[i]) * cruise;
        vy = 0;
        vz = Math.cos(phase[i]) * cruise;
      } else {
        let targetSpeed = Math.min(Math.max(speed, cruise * 0.5), cruise * 1.5);
        targetSpeed += (cruise - targetSpeed) * 0.06;
        const scale = targetSpeed / speed;
        vx *= scale;
        vy *= scale;
        vz *= scale;
      }

      px += vx * DT;
      py += vy * DT;
      pz += vz * DT;

      // Hard clamps guarantee the containment contract regardless of tuning.
      if (isSchool) {
        const ox = px - centerX;
        const oy = py - centerY;
        const oz = pz - centerZ;
        const dist = Math.sqrt(ox * ox + oy * oy + oz * oz);
        if (dist > hardRadius) {
          const scale = hardRadius / dist;
          px = centerX + ox * scale;
          py = centerY + oy * scale;
          pz = centerZ + oz * scale;
          const radialDot = (vx * ox + vy * oy + vz * oz) / dist;
          if (radialDot > 0) {
            vx -= (radialDot * ox) / dist;
            vy -= (radialDot * oy) / dist;
            vz -= (radialDot * oz) / dist;
          }
        }
        if (py > config.bandHardMaxY) {
          py = config.bandHardMaxY;
          if (vy > 0) vy = 0;
        }
      } else {
        const ox = px - centerX;
        const oz = pz - centerZ;
        const dist = Math.sqrt(ox * ox + oz * oz);
        if (dist > hardRadius) {
          const scale = hardRadius / dist;
          px = centerX + ox * scale;
          pz = centerZ + oz * scale;
          const radialDot = (vx * ox + vz * oz) / dist;
          if (radialDot > 0) {
            vx -= (radialDot * ox) / dist;
            vz -= (radialDot * oz) / dist;
          }
        }
        if (py < config.bandHardMinY) {
          py = config.bandHardMinY;
          if (vy < 0) vy = 0;
        } else if (py > config.bandHardMaxY) {
          py = config.bandHardMaxY;
          if (vy > 0) vy = 0;
        }
      }

      posX[i] = px;
      posY[i] = py;
      posZ[i] = pz;
      velX[i] = vx;
      velY[i] = vy;
      velZ[i] = vz;
    }
  }

  // --- Herd step ---------------------------------------------------------------

  function pickWalkTarget(i: number): void {
    const angle = rng.next() * TWO_PI;
    const dist = config.radius * (0.12 + 0.68 * rng.next());
    targetX[i] = config.centerX + Math.sin(angle) * dist;
    targetZ[i] = config.centerZ + Math.cos(angle) * dist;
    behaviorTimer[i] = 4 + 6 * rng.next();
  }

  function pickRegroupTarget(i: number): void {
    const angle = rng.next() * TWO_PI;
    const dist = config.radius * 0.25 * rng.next();
    targetX[i] = config.centerX + Math.sin(angle) * dist;
    targetZ[i] = config.centerZ + Math.cos(angle) * dist;
    behaviorTimer[i] = 8 + 4 * rng.next();
  }

  function stepHerd(): void {
    const { centerX, centerZ, radius, cruise, turnRate, accel, herdSeparationRadius } = config;
    const separationR2 = herdSeparationRadius * herdSeparationRadius;
    const hardRadius = radius * HARD_CONTAINMENT_SCALE;
    const containTrigger2 = radius * 0.95 * (radius * 0.95);
    const regroupDone2 = radius * 0.4 * (radius * 0.4);

    for (let i = 0; i < n; i += 1) {
      accSepX[i] = 0;
      accSepZ[i] = 0;
    }
    for (let i = 0; i < n; i += 1) {
      const pix = posX[i];
      const piz = posZ[i];
      for (let j = i + 1; j < n; j += 1) {
        const dx = posX[j] - pix;
        const dz = posZ[j] - piz;
        const d2 = dx * dx + dz * dz;
        if (d2 > separationR2 || d2 < 1e-9) continue;
        const inv = 1 / d2;
        accSepX[i] -= dx * inv;
        accSepZ[i] -= dz * inv;
        accSepX[j] += dx * inv;
        accSepZ[j] += dz * inv;
      }
    }

    for (let i = 0; i < n; i += 1) {
      let px = posX[i];
      let pz = posZ[i];
      let state = behaviorState[i];
      behaviorTimer[i] -= DT;

      const offCenterX = px - centerX;
      const offCenterZ = pz - centerZ;
      const centerDist2 = offCenterX * offCenterX + offCenterZ * offCenterZ;

      // Transitions. RNG is consumed only here, in fixed agent order, so the
      // draw sequence is a pure function of the replayed trajectory.
      if (centerDist2 > containTrigger2 && state !== WILDLIFE_BEHAVIOR_REGROUP) {
        state = WILDLIFE_BEHAVIOR_REGROUP;
        pickRegroupTarget(i);
      } else if (state === WILDLIFE_BEHAVIOR_GRAZE) {
        if (behaviorTimer[i] <= 0) {
          state = WILDLIFE_BEHAVIOR_WALK;
          pickWalkTarget(i);
        }
      } else if (state === WILDLIFE_BEHAVIOR_WALK) {
        const toTargetX = targetX[i] - px;
        const toTargetZ = targetZ[i] - pz;
        const arrived = toTargetX * toTargetX + toTargetZ * toTargetZ < 0.64;
        if (arrived || behaviorTimer[i] <= 0) {
          state = WILDLIFE_BEHAVIOR_GRAZE;
          behaviorTimer[i] = 2 + 6 * rng.next(); // graze pause 2–8 s
        }
      } else if (centerDist2 < regroupDone2) {
        state = WILDLIFE_BEHAVIOR_GRAZE;
        behaviorTimer[i] = 1 + 2 * rng.next();
      } else if (behaviorTimer[i] <= 0) {
        pickRegroupTarget(i);
      }

      // Desired direction: normalized target bearing plus separation push.
      let dirX = 0;
      let dirZ = 0;
      if (state !== WILDLIFE_BEHAVIOR_GRAZE) {
        const toTargetX = targetX[i] - px;
        const toTargetZ = targetZ[i] - pz;
        const dist = Math.sqrt(toTargetX * toTargetX + toTargetZ * toTargetZ);
        if (dist > 1e-6) {
          dirX = toTargetX / dist;
          dirZ = toTargetZ / dist;
        }
      }
      dirX += accSepX[i] * 0.8;
      dirZ += accSepZ[i] * 0.8;

      // Turn-rate-limited heading keeps motion animal-like (no pivoting).
      let yaw = heading[i];
      if (dirX * dirX + dirZ * dirZ > 1e-8) {
        const desiredYaw = Math.atan2(dirX, dirZ);
        const delta = wrapAngle(desiredYaw - yaw);
        const maxTurn = turnRate * DT;
        yaw = wrapAngle(yaw + Math.min(Math.max(delta, -maxTurn), maxTurn));
      }

      const targetSpeed =
        state === WILDLIFE_BEHAVIOR_GRAZE ? 0 : state === WILDLIFE_BEHAVIOR_REGROUP ? cruise * 1.25 : cruise;
      let speed = speedCur[i];
      const speedDelta = targetSpeed - speed;
      const maxSpeedStep = accel * DT;
      speed += Math.min(Math.max(speedDelta, -maxSpeedStep), maxSpeedStep);

      const vx = Math.sin(yaw) * speed;
      const vz = Math.cos(yaw) * speed;
      px += vx * DT;
      pz += vz * DT;

      // Hard containment: project back onto the allowed disc.
      const ox = px - centerX;
      const oz = pz - centerZ;
      const dist = Math.sqrt(ox * ox + oz * oz);
      if (dist > hardRadius) {
        const scale = hardRadius / dist;
        px = centerX + ox * scale;
        pz = centerZ + oz * scale;
      }

      const grazeTarget = state === WILDLIFE_BEHAVIOR_GRAZE ? 1 : 0;
      const blendDelta = grazeTarget - grazeBlend[i];
      const maxBlendStep = 2.5 * DT;
      grazeBlend[i] += Math.min(Math.max(blendDelta, -maxBlendStep), maxBlendStep);

      posX[i] = px;
      posY[i] = config.groundY;
      posZ[i] = pz;
      velX[i] = vx;
      velY[i] = 0;
      velZ[i] = vz;
      heading[i] = yaw;
      behaviorState[i] = state;
      speedCur[i] = speed;
    }
  }

  // --- Tick machinery ------------------------------------------------------------

  function step(): void {
    if (config.archetype === "herd") stepHerd();
    else stepBoids();
    simTick += 1;
    if (simTick % WILDLIFE_CHECKPOINT_INTERVAL_TICKS === 0) {
      const slotIndex = (simTick / WILDLIFE_CHECKPOINT_INTERVAL_TICKS) % WILDLIFE_MAX_CHECKPOINTS;
      storeCheckpoint(ringSlots[slotIndex]);
    }
  }

  function copyLiveToPrev(): void {
    prevPosX.set(posX);
    prevPosY.set(posY);
    prevPosZ.set(posZ);
    prevVelX.set(velX);
    prevVelY.set(velY);
    prevVelZ.set(velZ);
    prevHeading.set(heading);
    prevBehaviorState.set(behaviorState);
    prevGrazeBlend.set(grazeBlend);
    prevTick = simTick;
  }

  // Spawn, snapshot tick 0, and pre-step one lookahead tick so readState()
  // is valid (tick 0) before the first stepTo call.
  spawn();
  storeCheckpoint(zeroSlot);
  copyLiveToPrev();
  step();

  const prevView: WildlifeSimStateView = {
    count: n,
    tick: prevTick,
    posX: prevPosX,
    posY: prevPosY,
    posZ: prevPosZ,
    velX: prevVelX,
    velY: prevVelY,
    velZ: prevVelZ,
    heading: prevHeading,
    behaviorState: prevBehaviorState,
    grazeBlend: prevGrazeBlend,
    phase,
  };
  const currView: WildlifeSimStateView = {
    count: n,
    tick: simTick,
    posX,
    posY,
    posZ,
    velX,
    velY,
    velZ,
    heading,
    behaviorState,
    grazeBlend,
    phase,
  };
  const renderView: WildlifeSimRenderView = { count: n, alpha: 0, prev: prevView, curr: currView };

  function stepTo(targetSeconds: number): void {
    const seconds = Number.isFinite(targetSeconds) ? Math.max(0, targetSeconds) : 0;
    const canonicalTick = Math.floor(seconds * HZ);
    lastAlpha = Math.min(1, Math.max(0, seconds * HZ - canonicalTick));
    if (prevTick === canonicalTick && simTick === canonicalTick + 1) return;

    if (simTick > canonicalTick) {
      restoreCheckpoint(bestCheckpointAtMost(canonicalTick));
    } else {
      // Forward jump: a previously stored future checkpoint may be closer.
      const best = bestCheckpointAtMost(canonicalTick);
      if (best.tick > simTick) restoreCheckpoint(best);
    }
    while (simTick < canonicalTick) step();
    copyLiveToPrev();
    step(); // lookahead tick for interpolation
  }

  return {
    configKey,
    archetype: config.archetype,
    species: config.species,
    count: n,
    stepTo,
    readState(): WildlifeSimStateView {
      prevView.tick = prevTick;
      return prevView;
    },
    readRenderState(): WildlifeSimRenderView {
      prevView.tick = prevTick;
      currView.tick = simTick;
      renderView.alpha = lastAlpha;
      return renderView;
    },
  };
}
