import type { DirectorAnimationInterpolation, DirectorAnimationTimingCurve } from "./directorProject";
import { clamp } from "../../../../../../packages/protocol/src/primitives";

export const DIRECTOR_TIMING_CURVE_PRESETS = {
  linear: { x1: 0, y1: 0, x2: 1, y2: 1 },
  easeIn: { x1: 0.42, y1: 0, x2: 1, y2: 1 },
  easeOut: { x1: 0, y1: 0, x2: 0.58, y2: 1 },
  easeInOut: { x1: 0.42, y1: 0, x2: 0.58, y2: 1 },
} as const satisfies Record<string, DirectorAnimationTimingCurve>;

function cubicCoordinate(t: number, first: number, second: number) {
  const inverse = 1 - t;
  return 3 * inverse * inverse * t * first + 3 * inverse * t * t * second + t * t * t;
}

function cubicDerivative(t: number, first: number, second: number) {
  const inverse = 1 - t;
  return 3 * inverse * inverse * first + 6 * inverse * t * (second - first) + 3 * t * t * (1 - second);
}

/** Resolve CSS-style cubic-bezier timing while keeping x monotonic. */
export function evaluateDirectorTimingCurve(progress: number, curve: DirectorAnimationTimingCurve) {
  const requestedX = clamp(progress, 0, 1);
  const x1 = clamp(curve.x1, 0, 1);
  const x2 = clamp(curve.x2, 0, 1);
  let t = requestedX;

  for (let iteration = 0; iteration < 8; iteration += 1) {
    const error = cubicCoordinate(t, x1, x2) - requestedX;
    if (Math.abs(error) < 0.000001) break;
    const derivative = cubicDerivative(t, x1, x2);
    if (Math.abs(derivative) < 0.000001) break;
    const next = t - error / derivative;
    if (next < 0 || next > 1) break;
    t = next;
  }

  let lower = 0;
  let upper = 1;
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const resolvedX = cubicCoordinate(t, x1, x2);
    if (Math.abs(resolvedX - requestedX) < 0.000001) break;
    if (resolvedX < requestedX) lower = t;
    else upper = t;
    t = (lower + upper) / 2;
  }

  return cubicCoordinate(t, curve.y1, curve.y2);
}

export function getDirectorInterpolationWeight(
  interpolation: DirectorAnimationInterpolation | undefined,
  progress: number,
  timingCurve?: DirectorAnimationTimingCurve,
) {
  if (interpolation === "step") return 0;
  const clamped = clamp(progress, 0, 1);
  if (timingCurve) return evaluateDirectorTimingCurve(clamped, timingCurve);
  return interpolation === "smooth" ? clamped * clamped * (3 - 2 * clamped) : clamped;
}
