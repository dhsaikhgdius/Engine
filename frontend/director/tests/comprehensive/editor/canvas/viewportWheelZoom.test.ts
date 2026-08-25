import { PerspectiveCamera, Vector3 } from "three";
import { OrbitControls } from "three-stdlib";
import { describe, expect, it, vi } from "vitest";

import {
  applyViewportWheelZoomFrame,
  ensureViewportCameraClippingRange,
  enqueueViewportWheelZoom,
  getViewportWheelZoomFrameStep,
  getViewportGridDensityFade,
  getViewportGridFadeDistance,
  getViewportNearClipDistance,
  getViewportWheelZoomImpulse,
  normalizeViewportWheelDelta,
  VIEWPORT_FAR_CLIP_DISTANCE,
  VIEWPORT_MAX_NEAR_CLIP_DISTANCE,
  VIEWPORT_MIN_NEAR_CLIP_DISTANCE,
  VIEWPORT_GRID_FADE_DISTANCE,
  VIEWPORT_GRID_FADE_DISTANCE_MAX,
  VIEWPORT_GRID_FADE_STRENGTH,
  VIEWPORT_GRID_MAJOR_DENSITY_FADE,
  VIEWPORT_GRID_MINOR_DENSITY_FADE,
  VIEWPORT_MAX_ORBIT_DISTANCE,
  VIEWPORT_MAX_PENDING_ZOOM,
  VIEWPORT_MIN_ORBIT_DISTANCE,
} from "../../../../src/comprehensive/editor/canvas/viewportWheelZoom";

function createControls(distance = 10) {
  const target = new Vector3(1, 2, 3);
  const camera = new PerspectiveCamera(50, 16 / 9, 0.01, 10_000);
  camera.position.copy(target).add(new Vector3(0, 0, distance));
  const element = document.createElement("div");
  const controls = new OrbitControls(camera, element);
  controls.target.copy(target);
  controls.minDistance = VIEWPORT_MIN_ORBIT_DISTANCE;
  controls.maxDistance = VIEWPORT_MAX_ORBIT_DISTANCE;
  controls.update();
  return { camera, controls, target };
}

function advanceZoom(controls: OrbitControls, initialPending: number, frames: number, deltaSeconds: number) {
  let pending = initialPending;
  for (let frame = 0; frame < frames; frame += 1) {
    pending = applyViewportWheelZoomFrame(controls, pending, deltaSeconds);
  }
  return pending;
}

describe("viewport wheel zoom", () => {
  it("keeps editor geometry inside the far clipping plane throughout viewport navigation", () => {
    const camera = new PerspectiveCamera(50, 16 / 9, 0.1, 100);
    const updateProjectionMatrix = vi.spyOn(camera, "updateProjectionMatrix");

    ensureViewportCameraClippingRange(camera);

    expect(camera.far).toBe(VIEWPORT_FAR_CLIP_DISTANCE);
    expect(camera.far).toBeGreaterThan(VIEWPORT_MAX_ORBIT_DISTANCE);
    expect(updateProjectionMatrix).toHaveBeenCalledOnce();
  });

  it("widens the near clip with view distance so distant coplanar walls keep depth precision", () => {
    expect(getViewportNearClipDistance(10)).toBeCloseTo(VIEWPORT_MIN_NEAR_CLIP_DISTANCE);
    expect(getViewportNearClipDistance(800)).toBeGreaterThan(getViewportNearClipDistance(80));
    expect(getViewportNearClipDistance(4_000)).toBeLessThanOrEqual(VIEWPORT_MAX_NEAR_CLIP_DISTANCE);

    const camera = new PerspectiveCamera(50, 16 / 9, 0.1, 100);
    ensureViewportCameraClippingRange(camera, 800);
    expect(camera.near).toBeCloseTo(getViewportNearClipDistance(800));
    expect(camera.far).toBe(VIEWPORT_FAR_CLIP_DISTANCE);
  });

  it("normalizes pixel, line, and page wheel units without allowing non-finite input", () => {
    expect(normalizeViewportWheelDelta(100, 0, 800)).toBe(100);
    expect(normalizeViewportWheelDelta(3, 1, 800)).toBe(48);
    expect(normalizeViewportWheelDelta(1, 2, 800)).toBe(800);
    expect(normalizeViewportWheelDelta(Number.NaN, 0, 800)).toBe(0);
  });

  it("keeps trackpad streams linear while bounding large wheel impulses", () => {
    const trackpadImpulse = Array.from({ length: 40 }, () => getViewportWheelZoomImpulse(2.5, 0, 800)).reduce(
      (sum, impulse) => sum + impulse,
      0,
    );
    expect(trackpadImpulse).toBeCloseTo(getViewportWheelZoomImpulse(100, 0, 800));
    expect(getViewportWheelZoomImpulse(10_000, 0, 800)).toBeCloseTo(getViewportWheelZoomImpulse(400, 0, 800));
  });

  it("caps queued inertia and reverses immediately when the wheel changes direction", () => {
    expect(enqueueViewportWheelZoom(0.8, 0.4)).toBe(VIEWPORT_MAX_PENDING_ZOOM);
    expect(enqueueViewportWheelZoom(-0.8, -0.4)).toBe(-VIEWPORT_MAX_PENDING_ZOOM);
    expect(enqueueViewportWheelZoom(0.6, -0.12)).toBe(-0.12);
    expect(enqueueViewportWheelZoom(-0.6, 0.12)).toBe(0.12);

    const { controls } = createControls();
    const outwardPending = applyViewportWheelZoomFrame(controls, 0.6, 1 / 60);
    const distanceBeforeReversal = controls.getDistance();
    const inwardPending = enqueueViewportWheelZoom(outwardPending, -0.12);
    applyViewportWheelZoomFrame(controls, inwardPending, 1 / 60);
    expect(controls.getDistance()).toBeLessThan(distanceBeforeReversal);
  });

  it("moves away for positive wheel delta and toward the target for negative wheel delta", () => {
    const outward = createControls();
    const inward = createControls();

    applyViewportWheelZoomFrame(outward.controls, getViewportWheelZoomImpulse(100, 0, 800), 1 / 60);
    applyViewportWheelZoomFrame(inward.controls, getViewportWheelZoomImpulse(-100, 0, 800), 1 / 60);

    expect(outward.controls.getDistance()).toBeGreaterThan(10);
    expect(inward.controls.getDistance()).toBeLessThan(10);
    expect(outward.controls.target.toArray()).toEqual(outward.target.toArray());
    expect(inward.controls.target.toArray()).toEqual(inward.target.toArray());
  });

  it("uses reciprocal distance scales for symmetric frame steps", () => {
    const { controls } = createControls();
    applyViewportWheelZoomFrame(controls, 0.4, 1 / 60);
    applyViewportWheelZoomFrame(controls, -0.4, 1 / 60);
    expect(controls.getDistance()).toBeCloseTo(10, 10);
  });

  it("converges to the same distance at 30, 60, and 120 fps", () => {
    const thirtyFps = createControls();
    const sixtyFps = createControls();
    const oneTwentyFps = createControls();
    advanceZoom(thirtyFps.controls, 0.6, 30, 1 / 30);
    advanceZoom(sixtyFps.controls, 0.6, 60, 1 / 60);
    advanceZoom(oneTwentyFps.controls, 0.6, 120, 1 / 120);
    const distances = [
      thirtyFps.controls.getDistance(),
      sixtyFps.controls.getDistance(),
      oneTwentyFps.controls.getDistance(),
    ];
    expect(Math.max(...distances) - Math.min(...distances)).toBeLessThan(0.0001);
  });

  it("limits long frames and settles at camera distance boundaries", () => {
    expect(getViewportWheelZoomFrameStep(0.5, 1).applied).toBeCloseTo(
      getViewportWheelZoomFrameStep(0.5, 1 / 20).applied,
    );

    const minimum = createControls(VIEWPORT_MIN_ORBIT_DISTANCE);
    const setScaleSpy = vi.spyOn(minimum.controls, "setScale");
    expect(applyViewportWheelZoomFrame(minimum.controls, -0.5, 1 / 60)).toBe(0);
    expect(setScaleSpy).toHaveBeenCalledTimes(1);

    const reversed = enqueueViewportWheelZoom(0, 0.2);
    applyViewportWheelZoomFrame(minimum.controls, reversed, 1 / 60);
    expect(minimum.controls.getDistance()).toBeGreaterThan(VIEWPORT_MIN_ORBIT_DISTANCE);

    const maximum = createControls(VIEWPORT_MAX_ORBIT_DISTANCE);
    expect(applyViewportWheelZoomFrame(maximum.controls, 0.5, 1 / 60)).toBe(0);
  });

  it("keeps the editor grid readable when the camera pulls back", () => {
    expect(getViewportGridFadeDistance(2)).toBe(VIEWPORT_GRID_FADE_DISTANCE);
    expect(getViewportGridFadeDistance(60)).toBe(VIEWPORT_GRID_FADE_DISTANCE);
    expect(getViewportGridFadeDistance(200)).toBeGreaterThan(VIEWPORT_GRID_FADE_DISTANCE);
    expect(getViewportGridFadeDistance(2_000)).toBe(VIEWPORT_GRID_FADE_DISTANCE_MAX);
  });

  it("dissolves packed grid lines before they smear at the horizon", () => {
    expect(getViewportGridDensityFade(0.1)).toBe(1);
    expect(getViewportGridDensityFade(VIEWPORT_GRID_MINOR_DENSITY_FADE.start)).toBe(1);
    expect(getViewportGridDensityFade(VIEWPORT_GRID_MINOR_DENSITY_FADE.end)).toBe(0);
    expect(getViewportGridDensityFade(0.6)).toBeGreaterThan(0);
    expect(getViewportGridDensityFade(0.6)).toBeLessThan(1);
    expect(getViewportGridDensityFade(0.6, VIEWPORT_GRID_MAJOR_DENSITY_FADE)).toBeGreaterThan(
      getViewportGridDensityFade(0.6, VIEWPORT_GRID_MINOR_DENSITY_FADE),
    );
  });

  it("keeps geometry visible across the expanded zoom range while fading only the editor grid", () => {
    expect(VIEWPORT_MAX_ORBIT_DISTANCE).toBeGreaterThanOrEqual(5_000);
    expect(VIEWPORT_MAX_ORBIT_DISTANCE).toBeGreaterThan(VIEWPORT_GRID_FADE_DISTANCE);
    expect(VIEWPORT_GRID_FADE_STRENGTH).toBeGreaterThan(0);
    const { controls } = createControls(VIEWPORT_MAX_ORBIT_DISTANCE - 1);

    const pending = advanceZoom(controls, VIEWPORT_MAX_PENDING_ZOOM, 240, 1 / 60);

    expect(controls.getDistance()).toBeCloseTo(VIEWPORT_MAX_ORBIT_DISTANCE, 6);
    expect(pending).toBe(0);
  });
});
