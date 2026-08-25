/*
 * Frame-native clean adaptation of the orbit, wave and bounce animation
 * descriptors in Yuan-ManX/Trigen (MIT). Recipes compile to ordinary Director
 * keyframes so they remain editable, exportable and deterministic.
 */
import { z } from "zod";
import type {
  DirectorAnimationRecipeMetadata,
  DirectorEntityAnimation,
  DirectorTrajectoryMotion,
  DirectorTrajectorySource,
  DirectorTransform,
} from "./directorProject";
import { createFrameTrajectoryAnimation, type DirectorTrajectoryWaypoint } from "./trajectoryMath";

type Vec3 = [number, number, number];
type Axis = "x" | "y" | "z";

const finite = z.number().finite();
const axis = z.enum(["x", "y", "z"]);
const vec3 = z.tuple([finite, finite, finite]);

/**
 * Schema for the three procedural animation recipe types — orbit, wave, and bounce.
 * Each variant validates its own geometry parameters with sensible defaults so
 * recipes are self-contained and safe to serialize across the editor ↔ gateway boundary.
 */
export const directorAnimationRecipeInputSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("orbit"),
    axis: axis.default("y"),
    center: vec3.optional(),
    radius: finite.positive().max(1_000_000).optional(),
    cycles: finite.int().positive().max(64).default(1),
    clockwise: z.boolean().default(false),
    face_center: z.boolean().default(true),
  }),
  z.strictObject({
    type: z.literal("wave"),
    axis: axis.default("y"),
    amplitude: finite.positive().max(1_000_000).default(1),
    cycles: finite.int().positive().max(64).default(2),
    phase_degrees: finite.default(0),
  }),
  z.strictObject({
    type: z.literal("bounce"),
    height: finite.positive().max(1_000_000).default(1.5),
    bounces: finite.int().positive().max(32).default(3),
    squash: z.boolean().default(true),
  }),
]);

/** Parsed, defaulted form of a procedural animation recipe after validation. */
export type DirectorAnimationRecipeInput = z.output<typeof directorAnimationRecipeInputSchema>;

/** Input bundle that drives a single recipe compilation into a trajectory animation. */
export interface CompileDirectorAnimationRecipeInput {
  /** Entity transform at the start of the animation window. */
  baseTransform: DirectorTransform;
  /** First timeline frame (inclusive) of the animation segment. */
  frameStart: number;
  /** Last timeline frame (inclusive) of the animation segment. */
  frameEnd: number;
  /** The recipe descriptor — orbit, wave, or bounce — with its geometry parameters. */
  recipe: z.input<typeof directorAnimationRecipeInputSchema>;
  /** Existing animation to merge pose-only keyframes from (preserves authored poses). */
  existingAnimation?: DirectorEntityAnimation;
  /** Optional look-at target for camera-facing rotation during the recipe. */
  cameraTarget?: Vec3;
  /** Optional field-of-view override for camera entities. */
  cameraFov?: number;
  /** Locomotion gait to associate with the compiled animation. */
  motion?: DirectorTrajectoryMotion;
  /** Provenance marker for the trajectory source. */
  source?: DirectorTrajectorySource;
  /** Timeline color for the animation track. */
  color?: string;
}

function cloneVec3(value: readonly [number, number, number]): Vec3 {
  // Defensive copy so downstream mutation never leaks into the caller's array.
  return [value[0], value[1], value[2]];
}

function axisIndex(value: Axis): 0 | 1 | 2 {
  return value === "x" ? 0 : value === "y" ? 1 : 2;
}

function normalizedBounds(frameStart: number, frameEnd: number) {
  const start = Math.round(Math.min(frameStart, frameEnd));
  const end = Math.round(Math.max(frameStart, frameEnd));
  // Reject degenerate spans early — a single frame cannot host a recipe animation.
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start === end) {
    throw new Error("Animation recipes require at least two safe integer timeline frames.");
  }
  return { start, end, span: end - start };
}

function sampleFrames(start: number, span: number, requestedIntervals: number) {
  // Cap at 256 intervals to keep keyframe count bounded for real-time playback.
  const intervals = Math.max(1, Math.min(256, span, Math.round(requestedIntervals)));
  return Array.from({ length: intervals + 1 }, (_, index) => ({
    frame: start + Math.round((span * index) / intervals),
    progress: index / intervals,
  }));
}

function orbitCenter(base: Vec3, orbitAxis: Axis, radius: number): Vec3 {
  // Default orbit center: offset along the orthogonal plane so the entity
  // sits on the circle perimeter at its current position.
  if (orbitAxis === "x") return [base[0], base[1] - radius, base[2]];
  if (orbitAxis === "z") return [base[0] - radius, base[1], base[2]];
  return [base[0] - radius, base[1], base[2]];
}

function planarRadius(base: Vec3, center: Vec3, orbitAxis: Axis) {
  if (orbitAxis === "x") return Math.hypot(base[1] - center[1], base[2] - center[2]);
  if (orbitAxis === "z") return Math.hypot(base[0] - center[0], base[1] - center[1]);
  return Math.hypot(base[0] - center[0], base[2] - center[2]);
}

function orbitStartAngle(base: Vec3, center: Vec3, orbitAxis: Axis) {
  if (orbitAxis === "x") return Math.atan2(base[2] - center[2], base[1] - center[1]);
  if (orbitAxis === "z") return Math.atan2(base[1] - center[1], base[0] - center[0]);
  return Math.atan2(base[2] - center[2], base[0] - center[0]);
}

function orbitPosition(base: Vec3, center: Vec3, orbitAxis: Axis, radius: number, angle: number): Vec3 {
  if (orbitAxis === "x") return [base[0], center[1] + Math.cos(angle) * radius, center[2] + Math.sin(angle) * radius];
  if (orbitAxis === "z") return [center[0] + Math.cos(angle) * radius, center[1] + Math.sin(angle) * radius, base[2]];
  return [center[0] + Math.cos(angle) * radius, base[1], center[2] + Math.sin(angle) * radius];
}

function facePointRotation(position: Vec3, target: Vec3, fallback: Vec3): Vec3 {
  const dx = target[0] - position[0];
  const dy = target[1] - position[1];
  const dz = target[2] - position[2];
  const horizontal = Math.hypot(dx, dz);
  // When the entity sits on top of / inside the target, the horizontal
  // vector collapses; fall back to the caller's rotation to avoid NaN.
  if (horizontal < 1e-8 && Math.abs(dy) < 1e-8) return cloneVec3(fallback);
  return [-Math.atan2(dy, Math.max(horizontal, 1e-8)), Math.atan2(dx, dz), fallback[2]];
}

function compileOrbit(
  baseTransform: DirectorTransform,
  recipe: Extract<DirectorAnimationRecipeInput, { type: "orbit" }>,
  start: number,
  span: number,
) {
  const base = cloneVec3(baseTransform.position);
  const requestedRadius = recipe.radius ?? 3;
  const center = recipe.center ? cloneVec3(recipe.center) : orbitCenter(base, recipe.axis, requestedRadius);
  const measuredRadius = planarRadius(base, center, recipe.axis);
  const radius = recipe.radius ?? (measuredRadius > 1e-6 ? measuredRadius : 3);
  const startAngle = orbitStartAngle(base, center, recipe.axis);
  const direction = recipe.clockwise ? -1 : 1;
  const waypoints = sampleFrames(start, span, recipe.cycles * 16).map(({ frame, progress }) => {
    const angle = startAngle + direction * Math.PI * 2 * recipe.cycles * progress;
    const position = orbitPosition(base, center, recipe.axis, radius, angle);
    return {
      frame,
      position,
      rotation: recipe.face_center
        ? facePointRotation(position, center, cloneVec3(baseTransform.rotation))
        : cloneVec3(baseTransform.rotation),
      scale: cloneVec3(baseTransform.scale),
      interpolation: "linear" as const,
    };
  });
  const metadata: DirectorAnimationRecipeMetadata = {
    type: "orbit",
    axis: recipe.axis,
    center,
    radius,
    cycles: recipe.cycles,
    clockwise: recipe.clockwise,
    faceCenter: recipe.face_center,
  };
  return { metadata, waypoints };
}

function compileWave(
  baseTransform: DirectorTransform,
  recipe: Extract<DirectorAnimationRecipeInput, { type: "wave" }>,
  start: number,
  span: number,
) {
  const base = cloneVec3(baseTransform.position);
  const index = axisIndex(recipe.axis);
  const phase = (recipe.phase_degrees * Math.PI) / 180;
  const waypoints = sampleFrames(start, span, recipe.cycles * 8).map(({ frame, progress }) => {
    const position = cloneVec3(base);
    position[index] += recipe.amplitude * Math.sin(phase + Math.PI * 2 * recipe.cycles * progress);
    return {
      frame,
      position,
      rotation: cloneVec3(baseTransform.rotation),
      scale: cloneVec3(baseTransform.scale),
      interpolation: "smooth" as const,
    };
  });
  const metadata: DirectorAnimationRecipeMetadata = {
    type: "wave",
    axis: recipe.axis,
    amplitude: recipe.amplitude,
    cycles: recipe.cycles,
    phaseDegrees: recipe.phase_degrees,
  };
  return { metadata, waypoints };
}

function compileBounce(
  baseTransform: DirectorTransform,
  recipe: Extract<DirectorAnimationRecipeInput, { type: "bounce" }>,
  start: number,
  span: number,
) {
  const basePosition = cloneVec3(baseTransform.position);
  const baseScale = cloneVec3(baseTransform.scale);
  const waypoints = sampleFrames(start, span, recipe.bounces * 8).map(({ frame, progress }) => {
    const completed = progress * recipe.bounces;
    const local = progress === 1 ? 1 : completed - Math.floor(completed);
    const position = cloneVec3(basePosition);
    position[1] += recipe.height * Math.sin(Math.PI * local);
    const scale = cloneVec3(baseScale);
    if (recipe.squash && local > 0 && local < 1) {
      // Volume-preserving squash-and-stretch: landing compresses vertically
      // (cos⁸ peak) and widens horizontally; airborne stretches vertically.
      // The sqrt(vertical) reciprocal keeps the apparent volume roughly constant.
      const landing = Math.pow(Math.abs(Math.cos(Math.PI * local)), 8);
      const airborne = Math.pow(Math.sin(Math.PI * local), 2);
      const vertical = Math.max(0.5, 1 - landing * 0.18 + airborne * 0.12);
      const horizontal = 1 / Math.sqrt(vertical);
      scale[0] *= horizontal;
      scale[1] *= vertical;
      scale[2] *= horizontal;
    }
    return {
      frame,
      position,
      rotation: cloneVec3(baseTransform.rotation),
      scale,
      interpolation: "smooth" as const,
    };
  });
  const metadata: DirectorAnimationRecipeMetadata = {
    type: "bounce",
    height: recipe.height,
    bounces: recipe.bounces,
    squash: recipe.squash,
  };
  return { metadata, waypoints };
}

/**
 * Compiles a procedural animation recipe (orbit, wave, or bounce) into a
 * frame-authoritative trajectory animation. The recipe is validated against
 * {@link directorAnimationRecipeInputSchema}, then sampled into keyframes
 * spanning the given frame range. The result carries the recipe metadata
 * so it remains round-trippable and editable.
 *
 * @param input - The compilation context: base transform, timeline bounds,
 *   recipe descriptor, and optional existing animation to merge pose keys from.
 * @returns A complete {@link DirectorEntityAnimation} with the recipe's
 *   keyframes and provenance metadata.
 */
export function compileDirectorAnimationRecipe(input: CompileDirectorAnimationRecipeInput): DirectorEntityAnimation {
  const recipe = directorAnimationRecipeInputSchema.parse(input.recipe);
  const { start, span } = normalizedBounds(input.frameStart, input.frameEnd);
  const compiled =
    recipe.type === "orbit"
      ? compileOrbit(input.baseTransform, recipe, start, span)
      : recipe.type === "wave"
        ? compileWave(input.baseTransform, recipe, start, span)
        : compileBounce(input.baseTransform, recipe, start, span);
  const animation = createFrameTrajectoryAnimation({
    baseTransform: input.baseTransform,
    frameStart: input.frameStart,
    frameEnd: input.frameEnd,
    preset: "custom",
    existingAnimation: input.existingAnimation,
    waypoints: compiled.waypoints as DirectorTrajectoryWaypoint[],
    cameraTarget: input.cameraTarget,
    cameraFov: input.cameraFov,
    orientToPath: false,
    motion: input.motion ?? "none",
    source: input.source ?? "manual",
    color: input.color,
  });
  return { ...animation, recipe: compiled.metadata };
}
