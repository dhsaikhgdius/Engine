import { useEffect, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { create } from "zustand";
import type { DirectorWorld } from "../schema/directorProject";
import { useDirectorStore } from "../store/directorStore";

/**
 * Ambient world clock.
 *
 * `worldSeconds` is timeline-frame-derived everywhere by default, which keeps
 * exports and scrubbing deterministic. Live viewing modes (idle viewport with
 * an enabled world, player mode) may additionally advance this ambient offset
 * so the world keeps evolving while the playhead is parked.
 *
 * Determinism contract (owner: sky/clock track):
 * - The offset must never advance while a capture, deterministic export, or
 *   recording render is in flight; those paths must observe a frozen value.
 * - Scrubbing or playback does not consume the offset; it is a pure additive
 *   view-time term, reset when simulation-relevant settings change.
 * - The R3F `useFrame` delta consumed by `WorldAmbientClockDriver` below is
 *   the single sanctioned wall-time source for world systems, quarantined in
 *   this module.
 */
interface WorldClockState {
  ambientOffsetSeconds: number;
  suspended: boolean;
  /** Balanced suspension holds; `suspended` mirrors `suspensionDepth > 0`. */
  suspensionDepth: number;
}

export const useWorldClockStore = create<WorldClockState>(() => ({
  ambientOffsetSeconds: 0,
  suspended: false,
  suspensionDepth: 0,
}));

/** Imperative render-loop read; unlike the hook, this never schedules React. */
export function getWorldAmbientOffsetSeconds(): number {
  return useWorldClockStore.getState().ambientOffsetSeconds;
}

/**
 * Whether the ambient clock is currently suspended, e.g. during a capture or
 * export session. When suspended, `advanceWorldAmbientClock` is a no-op.
 */
export function isWorldAmbientClockSuspended(): boolean {
  return useWorldClockStore.getState().suspended;
}

/**
 * Suspension is a balanced hold count, not a plain flag: capture sessions
 * nest (an export session wraps many per-frame captures), and the clock must
 * stay frozen until the outermost hold releases. Always call in `true`/`false`
 * pairs — acquire before the work, release in a `finally`.
 */
export function setWorldAmbientClockSuspended(suspended: boolean) {
  const depth = Math.max(0, useWorldClockStore.getState().suspensionDepth + (suspended ? 1 : -1));
  useWorldClockStore.setState({ suspensionDepth: depth, suspended: depth > 0 });
}

/** Resets the ambient clock offset to zero, e.g. on world seed change. */
export function resetWorldAmbientClock() {
  useWorldClockStore.setState({ ambientOffsetSeconds: 0 });
}

/**
 * Advances the ambient clock by the given delta. Non-finite or non-positive
 * deltas are ignored, and the call is a no-op while the clock is suspended.
 *
 * @param deltaSeconds - Wall-time delta to add, clamped to WORLD_AMBIENT_MAX_TICK_SECONDS by the caller.
 */
export function advanceWorldAmbientClock(deltaSeconds: number) {
  if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return;
  const state = useWorldClockStore.getState();
  if (state.suspended) return;
  useWorldClockStore.setState({ ambientOffsetSeconds: state.ambientOffsetSeconds + deltaSeconds });
}

/**
 * Demand-rendered stages can present sparse frames with huge deltas (idle
 * gaps, background-tab throttling). Clamping each tick keeps the ambient
 * world from visibly teleporting when rendering resumes.
 */
export const WORLD_AMBIENT_MAX_TICK_SECONDS = 0.25;

/** Run before the mutable Living World frame context is refreshed. */
export const WORLD_AMBIENT_CLOCK_FRAME_PRIORITY = -1000;

/**
 * True when the world's ambient systems can visibly evolve while the playhead
 * is parked. This gates both the stage frameloop upgrade to "always" and the
 * ambient clock itself: a fully static world (fixed time, clear weather, no
 * systems) must not accumulate offset, otherwise every clock tick would
 * re-render an image-identical frame forever on a demand-driven stage.
 */
export function isDirectorWorldAmbientActive(
  world: Pick<DirectorWorld, "settings" | "effects" | "waterBodies" | "wildlife" | "roads"> | null | undefined,
): boolean {
  if (!world || !world.settings.enabled) return false;
  const { timeOfDay, weather } = world.settings;
  return (
    world.effects.length > 0 ||
    world.waterBodies.length > 0 ||
    world.wildlife.length > 0 ||
    // Ambient traffic advances with worldSeconds like every other system.
    world.roads.length > 0 ||
    timeOfDay.mode === "cycle" ||
    timeOfDay.drivesSky ||
    weather.preset !== "clear" ||
    // A seeded weather cycle evolves even from a clear authored preset.
    weather.evolution?.mode === "cycle"
  );
}

/**
 * Advances the ambient clock from inside the R3F frameloop while the timeline
 * is paused. Playback and export paths must stay a pure function of the
 * playhead, so the driver never advances while playing, while suspended (see
 * `setWorldAmbientClockSuspended`), or while the world is ambient-inactive.
 * A world-seed change restarts the ambient evolution from zero.
 */
export default function WorldAmbientClockDriver({ isPlaying }: { isPlaying: boolean }) {
  const seed = useDirectorStore((state) => state.project.world?.settings.seed);
  const ambientActive = useDirectorStore((state) => isDirectorWorldAmbientActive(state.project.world));

  const lastSeedRef = useRef(seed);
  useEffect(() => {
    if (lastSeedRef.current === seed) return;
    lastSeedRef.current = seed;
    resetWorldAmbientClock();
  }, [seed]);

  useFrame((_, delta) => {
    if (isPlaying || !ambientActive) return;
    advanceWorldAmbientClock(Math.min(delta, WORLD_AMBIENT_MAX_TICK_SECONDS));
  }, WORLD_AMBIENT_CLOCK_FRAME_PRIORITY);

  return null;
}
