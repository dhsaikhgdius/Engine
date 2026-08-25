import type {
  DirectorWorldEffect,
  DirectorWorldRoad,
  DirectorWorldSettings,
  DirectorWorldWaterBody,
  DirectorWorldWildlifeGroup,
} from "../schema/directorProject";

/**
 * Per-frame evaluation context shared by every Living World sub-layer.
 *
 * Determinism contract: `worldSeconds` is the only time source, `seed` the
 * only entropy source. A sub-layer must render identically for identical
 * context values regardless of session history, so exports and scrubbing stay
 * reproducible. Stateful simulations (wildlife) must derive their state from a
 * seeded fixed-timestep replay of [0, worldSeconds] with internal checkpoints.
 */
export interface LivingWorldFrameContext {
  /** The only time source: simulation seconds since world epoch. */
  worldSeconds: number;
  /** Monotonically increasing frame counter since playback start. */
  frame: number;
  /** Target playback frame rate for this evaluation. */
  fps: number;
  /** Whether the timeline is currently playing (vs scrubbing or paused). */
  isPlaying: boolean;
  /** The only entropy source: world-level seed for deterministic replay. */
  seed: number;
  /** The current world settings block (time-of-day, weather, wind). */
  settings: DirectorWorldSettings;
  /** Evaluated wind velocity at `worldSeconds`, metres/second, world space. */
  windVector: [number, number, number];
  /** Scene ground plane height (metres) for grounded systems. */
  groundHeight: number;
  /**
   * Terrain height probe in project space, or null when nothing is below
   * (x, z). Optional: absent until the ground-sampling track provides it, and
   * grounded systems must fall back to the flat `groundHeight` plane.
   *
   * Determinism note: samples reflect the CURRENT scene, so deterministic
   * simulations must keep it out of replayed state — visually snap render
   * output instead of feeding samples into checkpointed positions.
   */
  sampleGroundHeight?: (x: number, z: number) => number | null;
}

/** An effect whose anchor was resolved to a world-space origin this frame. */
export interface ResolvedWorldEffect {
  /** The authored effect definition. */
  effect: DirectorWorldEffect;
  /** World-space origin (metres) the emitter is placed at this frame. */
  origin: [number, number, number];
}

/** Props for the GPU particle effects layer. */
export interface EffectsLayerProps {
  context: LivingWorldFrameContext;
  effects: ResolvedWorldEffect[];
}

/** Props for the water-body rendering layer. */
export interface WaterLayerProps {
  context: LivingWorldFrameContext;
  waterBodies: DirectorWorldWaterBody[];
}

/** Props for the river rendering layer. */
export interface RiverLayerProps {
  context: LivingWorldFrameContext;
  rivers: DirectorWorldWaterBody[];
}

/** Props for the sky rendering layer. */
export interface SkyLayerProps {
  context: LivingWorldFrameContext;
}

/** Props for the wildlife simulation and rendering layer. */
export interface WildlifeLayerProps {
  context: LivingWorldFrameContext;
  groups: DirectorWorldWildlifeGroup[];
}

/** Props for the traffic simulation and rendering layer. */
export interface TrafficLayerProps {
  context: LivingWorldFrameContext;
  roads: DirectorWorldRoad[];
}
