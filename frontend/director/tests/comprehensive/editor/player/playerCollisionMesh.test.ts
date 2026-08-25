import { Box3, BoxGeometry, Group, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, Vector3 } from "three";
import { describe, expect, it, vi } from "vitest";
import {
  buildPlayerCollisionMeshes,
  buildPlayerCollisionMeshesFromFlatMeshes,
  hasPlayerCollisionGeometry,
  PlayerCollisionMeshBudgetError,
} from "../../../../src/comprehensive/editor/player/playerCollisionMesh";

function boundsFromVertices(vertices: Float32Array) {
  const bounds = new Box3();
  const point = new Vector3();
  for (let index = 0; index < vertices.length; index += 3) {
    bounds.expandByPoint(point.set(vertices[index], vertices[index + 1], vertices[index + 2]));
  }
  return bounds;
}

describe("player collision mesh snapshot", () => {
  it("merges Blender render meshes in Director-local space instead of world space", () => {
    const directorSpace = new Group();
    directorSpace.position.set(30, 4, -20);
    directorSpace.rotation.y = Math.PI / 3;
    directorSpace.scale.setScalar(2.5);
    const importedScene = new Group();
    importedScene.name = "director-object-blender-scene";
    importedScene.position.set(2, 0, -1);
    directorSpace.add(importedScene);

    const floor = new Mesh(new BoxGeometry(4, 0.2, 6), new MeshBasicMaterial());
    floor.position.y = -0.1;
    importedScene.add(floor);
    const wall = new Mesh(new BoxGeometry(1, 2, 0.2), new MeshBasicMaterial());
    wall.position.set(1, 1, 2);
    importedScene.add(wall);
    directorSpace.updateMatrixWorld(true);

    const meshes = buildPlayerCollisionMeshes([importedScene], directorSpace);
    expect(meshes).toHaveLength(1);
    expect(meshes[0].sourceName).toBe("merged:2");
    const bounds = boundsFromVertices(meshes[0].vertices);
    expect(bounds.min.x).toBeCloseTo(0, 5);
    expect(bounds.max.x).toBeCloseTo(4, 5);
    expect(bounds.min.y).toBeCloseTo(-0.2, 5);
    expect(bounds.max.y).toBeCloseTo(2, 5);
    expect(bounds.min.z).toBeCloseTo(-4, 5);
    expect(bounds.max.z).toBeCloseTo(2, 5);
    expect(meshes[0].indices.length).toBe(72);
  });

  it("expands instances and excludes hidden or explicitly non-collidable meshes", () => {
    const directorSpace = new Group();
    const importedScene = new Group();
    directorSpace.add(importedScene);
    const instances = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial(), 2);
    instances.setMatrixAt(0, new Matrix4().makeTranslation(-2, 0.5, 0));
    instances.setMatrixAt(1, new Matrix4().makeTranslation(2, 0.5, 0));
    importedScene.add(instances);
    const helper = new Mesh(new BoxGeometry(20, 20, 20), new MeshBasicMaterial());
    helper.userData.hideFromViewportCapture = true;
    importedScene.add(helper);
    const noCollision = new Mesh(new BoxGeometry(20, 20, 20), new MeshBasicMaterial());
    noCollision.userData.directorCollisionDisabled = true;
    importedScene.add(noCollision);
    directorSpace.updateMatrixWorld(true);

    expect(hasPlayerCollisionGeometry(importedScene)).toBe(true);
    const meshes = buildPlayerCollisionMeshes([importedScene], directorSpace);
    expect(meshes).toHaveLength(1);
    const bounds = boundsFromVertices(meshes[0].vertices);
    expect(bounds.min.x).toBeCloseTo(-2.5, 5);
    expect(bounds.max.x).toBeCloseTo(2.5, 5);
    expect(bounds.min.y).toBeCloseTo(0, 5);
    expect(bounds.max.y).toBeCloseTo(1, 5);
    expect(meshes[0].indices.length).toBe(72);
  });

  it("fails explicitly when triangle or instance budgets are exceeded", () => {
    const directorSpace = new Group();
    const importedScene = new Group();
    directorSpace.add(importedScene);
    importedScene.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial()));
    directorSpace.updateMatrixWorld(true);

    expect(() => buildPlayerCollisionMeshes([importedScene], directorSpace, { maxTriangles: 1 })).toThrow(
      PlayerCollisionMeshBudgetError,
    );

    const instances = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial(), 2);
    importedScene.clear();
    importedScene.add(instances);
    directorSpace.updateMatrixWorld(true);
    expect(() => buildPlayerCollisionMeshes([importedScene], directorSpace, { maxInstances: 1 })).toThrow(
      PlayerCollisionMeshBudgetError,
    );
  });

  it("builds a live static snapshot in a non-default SceneRoot without another traversal", () => {
    const directorSpace = new Group();
    directorSpace.position.set(20, 3, -10);
    directorSpace.rotation.set(0.2, Math.PI / 3, -0.1);
    directorSpace.scale.setScalar(2);
    const liveRoot = new Group();
    directorSpace.add(liveRoot);
    const wall = new Mesh(new BoxGeometry(4, 2, 0.2), new MeshBasicMaterial());
    wall.position.set(0, 1, 3);
    liveRoot.add(wall);
    directorSpace.updateMatrixWorld(true);
    const traverse = vi.spyOn(liveRoot, "traverse");

    const meshes = buildPlayerCollisionMeshesFromFlatMeshes([wall], directorSpace);
    expect(traverse).not.toHaveBeenCalled();
    expect(boundsFromVertices(meshes[0].vertices).getCenter(new Vector3()).toArray()).toEqual([0, 1, 3]);
  });
});
