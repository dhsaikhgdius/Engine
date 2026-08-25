import { BatchedMesh, Box3, BoxGeometry, Color, InstancedMesh, Matrix4, MeshStandardMaterial } from "three";
import { describe, expect, it } from "vitest";
import {
  captureDirectorObjectBatchColorState,
  clearDirectorObjectBatchColors,
  getDirectorObjectBatchCount,
  getDirectorObjectBatchHitIndex,
  getDirectorObjectBatchLocalBoundsAt,
  isDirectorBatchedObjectBatchMesh,
  isDirectorObjectBatchMesh,
  replaceDirectorObjectBatchColors,
  restoreDirectorObjectBatchColors,
} from "../../../../src/comprehensive/editor/canvas/directorObjectBatch";

function createInstancedBatch() {
  const geometry = new BoxGeometry(1, 1, 1);
  const material = new MeshStandardMaterial();
  const mesh = new InstancedMesh(geometry, material, 2);
  mesh.setMatrixAt(0, new Matrix4().makeTranslation(2, 0, 0));
  mesh.setMatrixAt(1, new Matrix4().makeTranslation(4, 0, 0));
  mesh.setColorAt(0, new Color("#ff0000"));
  mesh.setColorAt(1, new Color("#0000ff"));
  return mesh;
}

function createBatchedBatch() {
  const source = new BoxGeometry(1, 1, 1);
  const material = new MeshStandardMaterial();
  const positionCount = source.getAttribute("position").count;
  const indexCount = source.getIndex()?.count ?? positionCount;
  const mesh = new BatchedMesh(2, positionCount, indexCount, material);
  const geometryId = mesh.addGeometry(source);
  const first = mesh.addInstance(geometryId);
  const second = mesh.addInstance(geometryId);
  mesh.setMatrixAt(first, new Matrix4().makeTranslation(2, 0, 0));
  mesh.setMatrixAt(second, new Matrix4().makeTranslation(4, 0, 0));
  mesh.setColorAt(first, new Color("#ff0000"));
  mesh.setColorAt(second, new Color("#0000ff"));
  source.dispose();
  return mesh;
}

function disposeBatch(mesh: ReturnType<typeof createInstancedBatch> | ReturnType<typeof createBatchedBatch>) {
  if (isDirectorBatchedObjectBatchMesh(mesh)) mesh.dispose();
  else {
    mesh.geometry.dispose();
    mesh.dispose();
  }
  mesh.material.dispose();
}

describe.each([
  ["InstancedMesh", createInstancedBatch],
  ["BatchedMesh", createBatchedBatch],
])("director object batch helpers: %s", (_label, createBatch) => {
  it("exposes stable object count, matrices, bounds, and hit indices", () => {
    const mesh = createBatch();
    const bounds = getDirectorObjectBatchLocalBoundsAt(mesh, 0, new Box3());

    expect(isDirectorObjectBatchMesh(mesh)).toBe(true);
    expect(getDirectorObjectBatchCount(mesh)).toBe(2);
    expect(bounds?.min.toArray()).toEqual([-0.5, -0.5, -0.5]);
    expect(bounds?.max.toArray()).toEqual([0.5, 0.5, 0.5]);
    expect(getDirectorObjectBatchHitIndex({ instanceId: 1 })).toBe(1);
    expect(getDirectorObjectBatchHitIndex({ batchId: 0 })).toBe(0);

    disposeBatch(mesh);
  });

  it("temporarily replaces per-object colors and restores the authored colors", () => {
    const mesh = createBatch();
    const state = captureDirectorObjectBatchColorState(mesh);

    clearDirectorObjectBatchColors(mesh);
    const white = new Color();
    mesh.getColorAt(0, white);
    expect(white.getHex()).toBe(0xffffff);

    replaceDirectorObjectBatchColors(mesh, [new Color("#00ff00"), new Color("#ffff00")]);
    const replacement = new Color();
    mesh.getColorAt(1, replacement);
    expect(replacement.getHex()).toBe(0xffff00);

    restoreDirectorObjectBatchColors(mesh, state);
    const restored = new Color();
    mesh.getColorAt(0, restored);
    expect(restored.getHex()).toBe(0xff0000);

    disposeBatch(mesh);
  });
});
