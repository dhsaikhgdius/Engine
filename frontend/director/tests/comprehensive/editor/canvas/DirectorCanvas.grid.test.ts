import {
  DEFAULT_DIRECTOR_VIEW_SNAPSHOT,
  getViewportGizmoHitButtonStyle,
  getViewportSnapshotFromGizmoDrag,
  getViewportSnapshotFromGizmoDirection,
  shouldRenderViewportGrid,
} from "../../../../src/comprehensive/editor/canvas/DirectorCanvas";
import { createDefaultDirectorProject } from "../../../../src/comprehensive/editor/store/directorStore";
import { getCameraViewSnapshotFromShot } from "../../../../src/comprehensive/editor/schema/cameraGeometry";
import { Spherical, Vector3 } from "three";

function expectTupleToBeCloseTo(received: [number, number, number], expected: [number, number, number]) {
  received.forEach((value, index) => {
    expect(value).toBeCloseTo(expected[index], 5);
  });
}

it("keeps the viewport grid visible when there is no panorama background", () => {
  expect(shouldRenderViewportGrid(false, false)).toBe(true);
});

it("keeps the viewport grid visible when a panorama background is active", () => {
  expect(shouldRenderViewportGrid(true, false)).toBe(true);
});

it("keeps the viewport grid visible when snap to grid is enabled during a panorama background", () => {
  expect(shouldRenderViewportGrid(true, true)).toBe(true);
});

it("starts the director and default camera view from the calibrated Flick reference pose", () => {
  const defaultCamera = createDefaultDirectorProject().cameras[0];

  expect(DEFAULT_DIRECTOR_VIEW_SNAPSHOT).toEqual({
    fov: 32.268802,
    position: [-0.843, 1.676, 0.675],
    target: [0.107576, 1.066338, -3.328788],
  });
  const defaultCameraView = getCameraViewSnapshotFromShot(defaultCamera);

  expect(defaultCameraView.fov).toBe(DEFAULT_DIRECTOR_VIEW_SNAPSHOT.fov);
  expectTupleToBeCloseTo(defaultCameraView.position, DEFAULT_DIRECTOR_VIEW_SNAPSHOT.position);
  expect(defaultCameraView.target).toEqual(DEFAULT_DIRECTOR_VIEW_SNAPSHOT.target);
  expect(defaultCamera.transform.position).not.toEqual(DEFAULT_DIRECTOR_VIEW_SNAPSHOT.position);
});

it("keeps the current orbit distance when native gizmo axis clicks switch viewport direction", () => {
  const snapshot = getViewportSnapshotFromGizmoDirection(DEFAULT_DIRECTOR_VIEW_SNAPSHOT, new Vector3(1, 0, 0));

  expect(snapshot.fov).toBe(DEFAULT_DIRECTOR_VIEW_SNAPSHOT.fov);
  expect(snapshot.target).toEqual(DEFAULT_DIRECTOR_VIEW_SNAPSHOT.target);
  expectTupleToBeCloseTo(snapshot.position, [4.267576, 1.066338, -3.328788]);
});

it.each([
  ["+X", [1, 0, 0] as [number, number, number]],
  ["-X", [-1, 0, 0] as [number, number, number]],
  ["+Y", [0, 1, 0] as [number, number, number]],
  ["-Y", [0, -1, 0] as [number, number, number]],
  ["+Z", [0, 0, 1] as [number, number, number]],
  ["-Z", [0, 0, -1] as [number, number, number]],
])("snaps exactly to the %s viewport axis while preserving the orbit", (_label, direction) => {
  const target = new Vector3(...DEFAULT_DIRECTOR_VIEW_SNAPSHOT.target);
  const originalRadius = new Vector3(...DEFAULT_DIRECTOR_VIEW_SNAPSHOT.position).distanceTo(target);
  const snapshot = getViewportSnapshotFromGizmoDirection(DEFAULT_DIRECTOR_VIEW_SNAPSHOT, new Vector3(...direction));
  const offset = new Vector3(...snapshot.position).sub(target);

  expect(snapshot.fov).toBe(DEFAULT_DIRECTOR_VIEW_SNAPSHOT.fov);
  expect(snapshot.target).toEqual(DEFAULT_DIRECTOR_VIEW_SNAPSHOT.target);
  expect(offset.length()).toBeCloseTo(originalRadius, 5);
  expectTupleToBeCloseTo(offset.normalize().toArray(), direction);
});

it("orbits the viewport from a full-size gizmo drag while preserving target, FOV, and radius", () => {
  const snapshot = getViewportSnapshotFromGizmoDrag(DEFAULT_DIRECTOR_VIEW_SNAPSHOT, 20, -12);
  const target = new Vector3(...DEFAULT_DIRECTOR_VIEW_SNAPSHOT.target);
  const originalRadius = new Vector3(...DEFAULT_DIRECTOR_VIEW_SNAPSHOT.position).distanceTo(target);
  const nextRadius = new Vector3(...snapshot.position).distanceTo(target);

  expect(snapshot.fov).toBe(DEFAULT_DIRECTOR_VIEW_SNAPSHOT.fov);
  expect(snapshot.target).toEqual(DEFAULT_DIRECTOR_VIEW_SNAPSHOT.target);
  expect(nextRadius).toBeCloseTo(originalRadius, 5);
  expect(snapshot.position).not.toEqual(DEFAULT_DIRECTOR_VIEW_SNAPSHOT.position);
});

it("clamps vertical gizmo drags away from unstable camera poles", () => {
  const top = getViewportSnapshotFromGizmoDrag(DEFAULT_DIRECTOR_VIEW_SNAPSHOT, 0, -10_000);
  const bottom = getViewportSnapshotFromGizmoDrag(DEFAULT_DIRECTOR_VIEW_SNAPSHOT, 0, 10_000);
  const target = new Vector3(...DEFAULT_DIRECTOR_VIEW_SNAPSHOT.target);
  const topSpherical = new Vector3(...top.position).sub(target);
  const bottomSpherical = new Vector3(...bottom.position).sub(target);

  expect(new Spherical().setFromVector3(topSpherical).phi).toBeCloseTo(0.05, 5);
  expect(new Spherical().setFromVector3(bottomSpherical).phi).toBeCloseTo(Math.PI - 0.05, 5);
});

it("positions the transparent native gizmo hit target over the visible X axis head inside the 80px overlay", () => {
  const style = getViewportGizmoHitButtonStyle(DEFAULT_DIRECTOR_VIEW_SNAPSHOT, [1, 0, 0]);

  expect(style.left).toBe("56.824px");
  expect(style.top).toBe("31.654px");
  expect(style.zIndex).toBe(77);
});
