import { Box3, BoxGeometry, Group, Mesh, MeshBasicMaterial, Vector3 } from "three";
import { expect, it } from "vitest";
import {
  getVisibleObjectLocalCenter,
  getVisibleObjectLocalFloorPivot,
  getVisibleObjectsLocalCenter,
  getVisibleObjectsLocalFloorPivot,
} from "../../../../src/comprehensive/editor/canvas/visualBounds";

it("measures the visible mesh center in object-local space through nested transforms", () => {
  const root = new Group();
  root.position.set(8, 3, -5);
  root.rotation.set(0.2, 0.7, -0.1);
  root.scale.set(1.5, 0.75, 2);

  const normalizedAsset = new Group();
  normalizedAsset.position.set(-1, 2, 4);
  normalizedAsset.scale.setScalar(0.5);
  root.add(normalizedAsset);

  const mesh = new Mesh(new BoxGeometry(2, 4, 6), new MeshBasicMaterial());
  mesh.position.set(3, 5, -2);
  normalizedAsset.add(mesh);

  const hiddenOutlier = new Mesh(new BoxGeometry(50, 50, 50), new MeshBasicMaterial());
  hiddenOutlier.position.set(1_000, 1_000, 1_000);
  hiddenOutlier.visible = false;
  root.add(hiddenOutlier);

  const center = getVisibleObjectLocalCenter(root);

  expect(center?.[0]).toBeCloseTo(0.5, 6);
  expect(center?.[1]).toBeCloseTo(4.5, 6);
  expect(center?.[2]).toBeCloseTo(3, 6);
});

it("measures the visible mesh floor pivot in object-local space through nested transforms", () => {
  const root = new Group();
  root.position.set(8, 3, -5);
  root.rotation.set(0.2, 0.7, -0.1);
  root.scale.set(1.5, 0.75, 2);

  const normalizedAsset = new Group();
  normalizedAsset.position.set(-1, 2, 4);
  normalizedAsset.scale.setScalar(0.5);
  root.add(normalizedAsset);

  const mesh = new Mesh(new BoxGeometry(2, 4, 6), new MeshBasicMaterial());
  mesh.position.set(3, 5, -2);
  normalizedAsset.add(mesh);

  root.updateWorldMatrix(true, true);
  const bounds = new Box3().setFromObject(mesh, true);
  const expectedWorldFloorPivot = new Vector3(
    (bounds.min.x + bounds.max.x) * 0.5,
    bounds.min.y,
    (bounds.min.z + bounds.max.z) * 0.5,
  );
  const expectedLocalFloorPivot = root.worldToLocal(expectedWorldFloorPivot);
  const floorPivot = getVisibleObjectLocalFloorPivot(root);

  expect(floorPivot?.[0]).toBeCloseTo(expectedLocalFloorPivot.x, 6);
  expect(floorPivot?.[1]).toBeCloseTo(expectedLocalFloorPivot.y, 6);
  expect(floorPivot?.[2]).toBeCloseTo(expectedLocalFloorPivot.z, 6);
});

it("ignores fully transparent helper geometry", () => {
  const root = new Group();
  root.add(new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial()));

  const transparentHelper = new Mesh(
    new BoxGeometry(10, 10, 10),
    new MeshBasicMaterial({ opacity: 0, transparent: true }),
  );
  transparentHelper.position.set(100, 0, 0);
  root.add(transparentHelper);

  expect(getVisibleObjectLocalCenter(root)).toEqual([0, 0, 0]);
  expect(getVisibleObjectLocalFloorPivot(root)).toEqual([0, -1, 0]);
});

it("measures sibling composite children relative to their empty parent pivot", () => {
  const sceneRoot = new Group();
  sceneRoot.position.set(-3, 1, 5);
  sceneRoot.rotation.set(0.15, 0.45, -0.1);
  sceneRoot.scale.setScalar(0.75);
  const compositePivot = new Group();
  compositePivot.position.set(10, 2, -4);
  compositePivot.rotation.set(0.1, -0.35, 0.2);
  sceneRoot.add(compositePivot);

  const leftChild = new Group();
  leftChild.position.set(8, 3, -4);
  leftChild.add(new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial()));
  sceneRoot.add(leftChild);

  const rightChild = new Group();
  rightChild.position.set(14, 5, -2);
  rightChild.add(new Mesh(new BoxGeometry(2, 4, 2), new MeshBasicMaterial()));
  sceneRoot.add(rightChild);

  const center = getVisibleObjectsLocalCenter(compositePivot, [leftChild, rightChild]);
  sceneRoot.updateWorldMatrix(true, true);
  const expectedWorldCenter = new Box3()
    .setFromObject(leftChild, true)
    .union(new Box3().setFromObject(rightChild, true))
    .getCenter(new Vector3());
  const expectedLocalCenter = compositePivot.worldToLocal(expectedWorldCenter);

  expect(center?.[0]).toBeCloseTo(expectedLocalCenter.x, 6);
  expect(center?.[1]).toBeCloseTo(expectedLocalCenter.y, 6);
  expect(center?.[2]).toBeCloseTo(expectedLocalCenter.z, 6);
});

it("measures sibling composite floor pivots relative to their empty parent pivot", () => {
  const sceneRoot = new Group();
  sceneRoot.position.set(-3, 1, 5);
  sceneRoot.rotation.set(0.15, 0.45, -0.1);
  sceneRoot.scale.setScalar(0.75);
  const compositePivot = new Group();
  compositePivot.position.set(10, 2, -4);
  compositePivot.rotation.set(0.1, -0.35, 0.2);
  sceneRoot.add(compositePivot);

  const leftChild = new Group();
  leftChild.position.set(8, 3, -4);
  leftChild.add(new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial()));
  sceneRoot.add(leftChild);

  const rightChild = new Group();
  rightChild.position.set(14, 5, -2);
  rightChild.add(new Mesh(new BoxGeometry(2, 4, 2), new MeshBasicMaterial()));
  sceneRoot.add(rightChild);

  const floorPivot = getVisibleObjectsLocalFloorPivot(compositePivot, [leftChild, rightChild]);
  sceneRoot.updateWorldMatrix(true, true);
  const unionBounds = new Box3().setFromObject(leftChild, true).union(new Box3().setFromObject(rightChild, true));
  const expectedWorldFloorPivot = new Vector3(
    (unionBounds.min.x + unionBounds.max.x) * 0.5,
    unionBounds.min.y,
    (unionBounds.min.z + unionBounds.max.z) * 0.5,
  );
  const expectedLocalFloorPivot = compositePivot.worldToLocal(expectedWorldFloorPivot);

  expect(floorPivot?.[0]).toBeCloseTo(expectedLocalFloorPivot.x, 6);
  expect(floorPivot?.[1]).toBeCloseTo(expectedLocalFloorPivot.y, 6);
  expect(floorPivot?.[2]).toBeCloseTo(expectedLocalFloorPivot.z, 6);
});
