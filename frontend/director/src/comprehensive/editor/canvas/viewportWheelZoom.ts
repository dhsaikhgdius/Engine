import type { OrthographicCamera, PerspectiveCamera } from "three";
import type { OrbitControls } from "three-stdlib";

import { DEFAULT_VIEWPORT_ZOOM_SENSITIVITY } from "../schema/viewportNavigation";

const VIEWPORT_WHEEL_REFERENCE_DELTA = 100;
const VIEWPORT_WHEEL_BASE_LOG_SCALE = Math.log(1 / 0.95);
const VIEWPORT_SMOOTH_ZOOM_RESPONSE = 16;
const VIEWPORT_ZOOM_FRAME_LIMIT_SECONDS = 1 / 20;
const VIEWPORT_ZOOM_SETTLED_EPSILON = 0.00001;

export const VIEWPORT_MAX_PENDING_ZOOM = 0.85;
export const VIEWPORT_MIN_ORBIT_DISTANCE = 0.1;
// Fade only the editor grid, never scene geometry. The infinite-grid mesh is
// scaled by `1 + fadeDistance`, so a short fade also shrinks the drawable disc.
// Grow the fade with orbit distance so a pulled-back camera still has a grid,
// and dissolve lines by screen-space density before they pack into a horizon band.
export const VIEWPORT_GRID_FADE_DISTANCE = 400;
export const VIEWPORT_GRID_FADE_DISTANCE_RATIO = 6;
export const VIEWPORT_GRID_FADE_DISTANCE_MAX = 4_000;
export const VIEWPORT_GRID_FADE_STRENGTH = 1;
export const VIEWPORT_GRID_CELL_SIZE = 1;
export const VIEWPORT_GRID_SECTION_SIZE = 10;
export const VIEWPORT_GRID_CELL_THICKNESS = 0.5;
export const VIEWPORT_GRID_SECTION_THICKNESS = 1;
/** Screen-space cell frequency (≈ px per cell) where minor lines start dissolving. */
export const VIEWPORT_GRID_MINOR_DENSITY_FADE = { start: 0.32, end: 0.9 } as const;
/** Major lines stay a little longer, then dissolve before they smear. */
export const VIEWPORT_GRID_MAJOR_DENSITY_FADE = { start: 0.45, end: 1.15 } as const;
export const VIEWPORT_MAX_ORBIT_DISTANCE = 5_000;
export const VIEWPORT_FAR_CLIP_DISTANCE = 10_000;
export const VIEWPORT_MIN_NEAR_CLIP_DISTANCE = 0.05;
export const VIEWPORT_MAX_NEAR_CLIP_DISTANCE = 12;
/** Near plane grows with orbit distance so kilometre sets keep depth precision. */
export const VIEWPORT_NEAR_CLIP_DISTANCE_RATIO = 0.0025;
const VIEWPORT_NEAR_CLIP_RELATIVE_EPSILON = 0.05;

export function getViewportNearClipDistance(viewDistance: number, far = VIEWPORT_FAR_CLIP_DISTANCE) {
  const distance = Number.isFinite(viewDistance) && viewDistance > 0 ? viewDistance : 10;
  const scaled = Math.min(
    VIEWPORT_MAX_NEAR_CLIP_DISTANCE,
    Math.max(VIEWPORT_MIN_NEAR_CLIP_DISTANCE, distance * VIEWPORT_NEAR_CLIP_DISTANCE_RATIO),
  );
  return Math.min(scaled, Math.max(VIEWPORT_MIN_NEAR_CLIP_DISTANCE, far * 0.002));
}

export function getViewportGridFadeDistance(viewDistance: number) {
  const distance = Number.isFinite(viewDistance) && viewDistance > 0 ? viewDistance : 10;
  return Math.min(
    VIEWPORT_GRID_FADE_DISTANCE_MAX,
    Math.max(VIEWPORT_GRID_FADE_DISTANCE, distance * VIEWPORT_GRID_FADE_DISTANCE_RATIO),
  );
}

function smoothstep01(edge0: number, edge1: number, value: number) {
  if (!(edge1 > edge0)) return value >= edge1 ? 1 : 0;
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Matches the grid shader: 1 when a cell is larger than a pixel, 0 when it smears. */
export function getViewportGridDensityFade(
  cellFrequency: number,
  fade: { start: number; end: number } = VIEWPORT_GRID_MINOR_DENSITY_FADE,
) {
  if (!Number.isFinite(cellFrequency) || cellFrequency <= fade.start) return 1;
  if (cellFrequency >= fade.end) return 0;
  return 1 - smoothstep01(fade.start, fade.end, cellFrequency);
}

export function ensureViewportCameraClippingRange(
  camera: PerspectiveCamera | OrthographicCamera,
  viewDistance?: number,
) {
  let changed = false;
  if (camera.far < VIEWPORT_FAR_CLIP_DISTANCE) {
    camera.far = VIEWPORT_FAR_CLIP_DISTANCE;
    changed = true;
  }
  if (
    viewDistance !== undefined &&
    (camera as PerspectiveCamera).isPerspectiveCamera &&
    Number.isFinite(viewDistance)
  ) {
    const near = getViewportNearClipDistance(viewDistance, camera.far);
    const relativeDelta = Math.abs(camera.near - near) / Math.max(camera.near, near, 1e-6);
    if (relativeDelta > VIEWPORT_NEAR_CLIP_RELATIVE_EPSILON) {
      camera.near = near;
      changed = true;
    }
  }
  if (changed) camera.updateProjectionMatrix();
}

type ViewportZoomControls = Pick<OrbitControls, "getDistance" | "maxDistance" | "minDistance" | "setScale">;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function normalizeViewportWheelDelta(deltaY: number, deltaMode: number, viewportHeight: number) {
  if (!Number.isFinite(deltaY)) return 0;

  const safeViewportHeight = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 1;
  const modeScale = deltaMode === 1 ? 16 : deltaMode === 2 ? safeViewportHeight : 1;
  return deltaY * modeScale;
}

export function getViewportWheelZoomImpulse(
  deltaY: number,
  deltaMode: number,
  viewportHeight: number,
  zoomSensitivity = DEFAULT_VIEWPORT_ZOOM_SENSITIVITY,
) {
  if (!Number.isFinite(zoomSensitivity) || zoomSensitivity <= 0) return 0;

  const normalizedDelta = normalizeViewportWheelDelta(deltaY, deltaMode, viewportHeight);
  const boundedDelta = clamp(normalizedDelta / VIEWPORT_WHEEL_REFERENCE_DELTA, -4, 4);
  return boundedDelta * VIEWPORT_WHEEL_BASE_LOG_SCALE * (zoomSensitivity / DEFAULT_VIEWPORT_ZOOM_SENSITIVITY);
}

/**
 * Accumulates wheel input as logarithmic camera distance. A direction change
 * deliberately replaces the old inertia so the viewport reverses immediately
 * instead of making the user "brake" through a hidden queue first.
 */
export function enqueueViewportWheelZoom(currentPending: number, impulse: number) {
  const safePending = Number.isFinite(currentPending) ? currentPending : 0;
  if (!Number.isFinite(impulse) || impulse === 0) {
    return clamp(safePending, -VIEWPORT_MAX_PENDING_ZOOM, VIEWPORT_MAX_PENDING_ZOOM);
  }

  const nextPending = safePending * impulse < 0 ? impulse : safePending + impulse;
  return clamp(nextPending, -VIEWPORT_MAX_PENDING_ZOOM, VIEWPORT_MAX_PENDING_ZOOM);
}

export function getViewportWheelZoomFrameStep(pending: number, deltaSeconds: number) {
  if (!Number.isFinite(pending) || !Number.isFinite(deltaSeconds) || deltaSeconds <= 0) {
    return { applied: 0, remaining: Number.isFinite(pending) ? pending : 0 };
  }

  const frameDelta = Math.min(deltaSeconds, VIEWPORT_ZOOM_FRAME_LIMIT_SECONDS);
  const applied = pending * (1 - Math.exp(-VIEWPORT_SMOOTH_ZOOM_RESPONSE * frameDelta));
  const remaining = pending - applied;
  return {
    applied,
    remaining: Math.abs(remaining) < VIEWPORT_ZOOM_SETTLED_EPSILON ? 0 : remaining,
  };
}

/**
 * Advances one smooth zoom frame. OrbitControls.setScale expects a direct
 * distance multiplier: values above one move away from the target and values
 * below one move toward it. setScale already performs the controls update.
 */
export function applyViewportWheelZoomFrame(controls: ViewportZoomControls, pending: number, deltaSeconds: number) {
  const { applied, remaining } = getViewportWheelZoomFrameStep(pending, deltaSeconds);
  if (applied === 0) return remaining;

  controls.setScale(Math.exp(applied));

  const distance = controls.getDistance();
  const boundaryEpsilon = Math.max(0.000001, Math.abs(distance) * 0.000001);
  const reachedMinimum = applied < 0 && distance <= controls.minDistance + boundaryEpsilon;
  const reachedMaximum = applied > 0 && distance >= controls.maxDistance - boundaryEpsilon;
  return reachedMinimum || reachedMaximum ? 0 : remaining;
}
