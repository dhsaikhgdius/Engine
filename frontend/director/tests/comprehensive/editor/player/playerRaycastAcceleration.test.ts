import {
  BatchedMesh,
  BoxGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Raycaster,
  Vector3,
} from "three";
import { describe, expect, it, vi } from "vitest";
import {
  acceleratePlayerSceneRaycastBatch,
  collectPlayerRaycastMeshes,
  findPlayerCollisionRootsByDirectorObjectIds,
  getPlayerSceneRaycastMeshes,
  getPlayerSceneRaycastMeshesNearSegment,
  registerPlayerSceneRaycastOwner,
} from "../../../../src/comprehensive/editor/player/playerRaycastAcceleration";

describe("player scene raycast acceleration", () => {
  it("builds each shared BVH once and accelerates imported meshes in bounded batches", () => {
    const root = new Group();
    const sharedGeometry = new BoxGeometry(1, 1, 1);
    const first = new Mesh(sharedGeometry, new MeshBasicMaterial());
    const second = new Mesh(sharedGeometry, new MeshBasicMaterial());
    second.position.x = 4;
    root.add(first, second);
    root.updateMatrixWorld(true);

    const meshes = collectPlayerRaycastMeshes([root]);
    expect(meshes).toHaveLength(2);
    const firstBatch = acceleratePlayerSceneRaycastBatch(meshes, 0, 1);
    expect(firstBatch).toEqual({ geometryCount: 1, nextIndex: 1 });
    expect(sharedGeometry.boundsTree).toBeDefined();
    const secondBatch = acceleratePlayerSceneRaycastBatch(meshes, firstBatch.nextIndex, 1);
    expect(secondBatch).toEqual({ geometryCount: 0, nextIndex: 2 });

    const hits = new Raycaster(new Vector3(0, 0, 4), new Vector3(0, 0, -1)).intersectObject(root, true);
    expect(hits[0]?.object).toBe(first);
  });

  it("preserves native InstancedMesh raycast and instanceId hits", () => {
    const root = new Group();
    const instances = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial(), 2);
    instances.setMatrixAt(0, new Matrix4().makeTranslation(-2, 0, 0));
    instances.setMatrixAt(1, new Matrix4().makeTranslation(2, 0, 0));
    root.add(instances);
    root.updateMatrixWorld(true);
    const nativeRaycast = instances.raycast;
    const meshes = collectPlayerRaycastMeshes([root]);

    acceleratePlayerSceneRaycastBatch(meshes, 0, meshes.length);

    expect(instances.raycast).toBe(nativeRaycast);
    const hits = new Raycaster(new Vector3(2, 0, 3), new Vector3(0, 0, -1), 0, 10).intersectObject(instances, false);
    expect(hits[0]?.instanceId).toBe(1);
  });

  it("preserves native BatchedMesh raycast and batchId hits", () => {
    const root = new Group();
    const source = new BoxGeometry(1, 1, 1);
    const positionCount = source.getAttribute("position").count;
    const indexCount = source.getIndex()?.count ?? positionCount;
    const batch = new BatchedMesh(2, positionCount, indexCount, new MeshBasicMaterial());
    const geometryId = batch.addGeometry(source);
    const left = batch.addInstance(geometryId);
    const right = batch.addInstance(geometryId);
    batch.setMatrixAt(left, new Matrix4().makeTranslation(-2, 0, 0));
    batch.setMatrixAt(right, new Matrix4().makeTranslation(2, 0, 0));
    root.add(batch);
    root.updateMatrixWorld(true);
    const nativeRaycast = batch.raycast;
    const meshes = collectPlayerRaycastMeshes([root]);

    acceleratePlayerSceneRaycastBatch(meshes, 0, meshes.length);

    expect(batch.raycast).toBe(nativeRaycast);
    const hits = new Raycaster(new Vector3(2, 0, 3), new Vector3(0, 0, -1), 0, 10).intersectObject(batch, false);
    expect(hits[0]?.batchId).toBe(right);
  });

  it("expands static primitive batches into spatially indexed collision proxies", () => {
    const scene = new Group();
    const source = new BoxGeometry(1, 1, 1);
    const positionCount = source.getAttribute("position").count;
    const indexCount = source.getIndex()?.count ?? positionCount;
    const batch = new BatchedMesh(2, positionCount, indexCount, new MeshBasicMaterial());
    const geometryId = batch.addGeometry(source);
    const nearId = batch.addInstance(geometryId);
    const farId = batch.addInstance(geometryId);
    batch.setMatrixAt(nearId, new Matrix4().makeTranslation(0, 0, 0));
    batch.setMatrixAt(farId, new Matrix4().makeTranslation(96, 0, 96));
    batch.userData.directorInstanceObjectIds = ["near", "far"];
    batch.userData.directorStaticPrimitiveBatch = true;
    scene.add(batch);
    scene.updateMatrixWorld(true);

    const meshes = collectPlayerRaycastMeshes([batch]);
    expect(meshes).toHaveLength(2);
    expect(meshes).not.toContain(batch);
    const unregister = registerPlayerSceneRaycastOwner(scene, batch, meshes);
    const nearby = getPlayerSceneRaycastMeshesNearSegment(scene, new Vector3(0, 0, 3), new Vector3(0, 0, -3), 0.2);
    expect(nearby).toHaveLength(1);

    acceleratePlayerSceneRaycastBatch(nearby, 0, nearby.length);
    const hits = new Raycaster(new Vector3(0, 0, 3), new Vector3(0, 0, -1), 0, 10).intersectObjects(nearby, false);
    expect(hits[0]?.object.userData.directorObjectId).toBe("near");
    unregister();
  });

  it("finds direct and batched collision roots from stable object IDs in one scene walk", () => {
    const scene = new Group();
    const direct = new Group();
    direct.userData.directorObjectId = "direct";
    direct.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial()));

    const source = new BoxGeometry(1, 1, 1);
    const positionCount = source.getAttribute("position").count;
    const indexCount = source.getIndex()?.count ?? positionCount;
    const batch = new BatchedMesh(2, positionCount, indexCount, new MeshBasicMaterial());
    const geometryId = batch.addGeometry(source);
    batch.addInstance(geometryId);
    batch.addInstance(geometryId);
    batch.userData.directorInstanceObjectIds = ["box-a", "box-b"];
    scene.add(direct, batch);

    expect(findPlayerCollisionRootsByDirectorObjectIds(scene, ["direct", "box-b"])).toEqual([direct, batch]);
  });

  it("excludes screen-space line helpers from ground and collision raycasts", () => {
    const root = new Group();
    const helper = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial()) as Mesh & {
      isLineSegments2?: boolean;
    };
    helper.isLineSegments2 = true;
    root.add(helper);

    expect(collectPlayerRaycastMeshes([root])).toEqual([]);
  });

  it("reuses an immutable live-environment mesh set without topology walks", () => {
    const scene = new Group();
    const liveRoot = new Group();
    const wall = new Mesh(new BoxGeometry(1, 2, 0.2), new MeshBasicMaterial());
    liveRoot.add(wall);
    scene.add(liveRoot);
    const traverse = vi.spyOn(liveRoot, "traverse");
    const unregister = registerPlayerSceneRaycastOwner(scene, liveRoot, [wall]);

    for (let frame = 0; frame < 600; frame += 1) {
      expect(getPlayerSceneRaycastMeshes(scene)).toEqual([wall]);
    }
    expect(traverse).not.toHaveBeenCalled();

    unregister();
    expect(getPlayerSceneRaycastMeshes(scene)).toEqual([]);
  });

  it("keeps only meshes whose world bounds can intersect a short ray segment", () => {
    const scene = new Group();
    const root = new Group();
    const near = new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial());
    const far = new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial());
    far.position.set(96, 0, 96);
    root.add(near, far);
    scene.add(root);
    scene.updateMatrixWorld(true);
    const unregister = registerPlayerSceneRaycastOwner(scene, root, [near, far]);

    expect(getPlayerSceneRaycastMeshesNearSegment(scene, new Vector3(0, 1, 4), new Vector3(0, 1, -4), 0.2)).toEqual([
      near,
    ]);
    expect(getPlayerSceneRaycastMeshesNearSegment(scene, new Vector3(96, 1, 100), new Vector3(96, 1, 92), 0.2)).toEqual(
      [far],
    );

    unregister();
  });

  it("always includes oversized scene surfaces in nearby queries", () => {
    const scene = new Group();
    const root = new Group();
    const ground = new Mesh(new BoxGeometry(1000, 0.2, 1000), new MeshBasicMaterial());
    root.add(ground);
    scene.add(root);
    scene.updateMatrixWorld(true);
    const unregister = registerPlayerSceneRaycastOwner(scene, root, [ground]);

    expect(getPlayerSceneRaycastMeshesNearSegment(scene, new Vector3(240, 1, 240), new Vector3(240, -1, 240))).toEqual([
      ground,
    ]);

    unregister();
  });
});
