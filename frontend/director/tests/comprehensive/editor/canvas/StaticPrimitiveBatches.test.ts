import { PerspectiveCamera } from "three";
import { describe, expect, it } from "vitest";
import type { DirectorObject } from "../../../../src/comprehensive/editor/schema/directorProject";
import {
  createDirectorStaticPrimitiveBatchPartition,
  createDirectorStaticPrimitiveRenderMesh,
  disposeDirectorStaticPrimitiveRenderMesh,
  getDirectorStaticPrimitiveMaterialProps,
} from "../../../../src/comprehensive/editor/canvas/StaticPrimitiveBatches";
import {
  isDirectorBatchedObjectBatchMesh,
  isDirectorInstancedObjectBatchMesh,
} from "../../../../src/comprehensive/editor/canvas/directorObjectBatch";

function createBox(id: string, patch: Partial<DirectorObject> = {}): DirectorObject {
  return {
    id,
    name: id,
    kind: "prop",
    visible: true,
    locked: false,
    color: "#d7e7ff",
    geometryType: "box",
    transform: {
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    },
    ...patch,
  };
}

describe("createDirectorStaticPrimitiveBatchPartition", () => {
  it("groups compatible primitives while preserving per-object colors", () => {
    const objects = Array.from({ length: 5 }, (_, index) =>
      createBox(`box_${index}`, { color: index % 2 ? "#f4a261" : "#264653" }),
    );

    const result = createDirectorStaticPrimitiveBatchPartition(objects, new Set(), true);

    expect(result.batches).toHaveLength(1);
    expect(result.batches[0]?.objects.map((object) => object.id)).toEqual(objects.map((object) => object.id));
    expect(result.batchedObjectIds).toEqual(new Set(objects.map((object) => object.id)));
  });

  it("uses instance colors without multiplying a missing geometry color attribute", () => {
    const objects = Array.from({ length: 4 }, (_, index) =>
      createBox(`box_${index}`, { color: index % 2 ? "#f4a261" : "#264653" }),
    );
    const batch = createDirectorStaticPrimitiveBatchPartition(objects, new Set(), true).batches[0];

    expect(batch).toBeDefined();
    expect(getDirectorStaticPrimitiveMaterialProps(batch!.material)).not.toHaveProperty("vertexColors");
  });

  it("keeps the selected primitive independent while batching the compatible remainder", () => {
    const objects = Array.from({ length: 5 }, (_, index) => createBox(`box_${index}`));

    const result = createDirectorStaticPrimitiveBatchPartition(objects, new Set(["box_2"]), true);

    expect(result.batches).toHaveLength(1);
    expect(result.batches[0]?.objects).toHaveLength(4);
    expect(result.batchedObjectIds.has("box_2")).toBe(false);
  });

  it("keeps a large wall out of the same depth batch as a flush door slab", () => {
    const walls = Array.from({ length: 4 }, (_, index) =>
      createBox(`wall_${index}`, {
        color: "#992d20",
        transform: { position: [index * 22, 8.2, 190.1], rotation: [0, 0, 0], scale: [20.1, 8.4, 0.8] },
      }),
    );
    const doors = Array.from({ length: 4 }, (_, index) =>
      createBox(`door_${index}`, {
        color: "#7c241a",
        transform: { position: [index * 3, 8.2, 190.78], rotation: [0, 0, 0], scale: [2.95, 5.4, 0.13] },
      }),
    );

    const result = createDirectorStaticPrimitiveBatchPartition([...walls, ...doors], new Set(), true);

    expect(result.batches).toHaveLength(2);
    const wallBatch = result.batches.find((batch) => batch.objects[0]?.id.startsWith("wall_"));
    const doorBatch = result.batches.find((batch) => batch.objects[0]?.id.startsWith("door_"));
    const wallMesh = createDirectorStaticPrimitiveRenderMesh(wallBatch!, false, true);
    const doorMesh = createDirectorStaticPrimitiveRenderMesh(doorBatch!, false, true);
    expect((wallMesh.material as { polygonOffsetUnits: number }).polygonOffsetUnits).toBeLessThan(
      (doorMesh.material as { polygonOffsetUnits: number }).polygonOffsetUnits,
    );
    disposeDirectorStaticPrimitiveRenderMesh(wallMesh);
    disposeDirectorStaticPrimitiveRenderMesh(doorMesh);
  });

  it("does not batch primitives that need a texture-backed material", () => {
    const objects = [
      ...Array.from({ length: 4 }, (_, index) => createBox(`box_${index}`)),
      createBox("textured_box", {
        material: {
          textures: { baseColorMapAssetId: "texture_asset" },
        },
      }),
    ];

    const result = createDirectorStaticPrimitiveBatchPartition(objects, new Set(), true);

    expect(result.batches).toHaveLength(1);
    expect(result.batchedObjectIds.has("textured_box")).toBe(false);
  });

  it("uses per-object frustum culling when GPU multi-draw is available", () => {
    const objects = [
      createBox("visible", { transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }),
      createBox("culled", { transform: { position: [1_000, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }),
      createBox("culled_2", { transform: { position: [1_100, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }),
      createBox("culled_3", { transform: { position: [1_200, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }),
    ];
    const batch = createDirectorStaticPrimitiveBatchPartition(objects, new Set(), true).batches[0]!;
    const mesh = createDirectorStaticPrimitiveRenderMesh(batch, true);
    const camera = new PerspectiveCamera(50, 1, 0.1, 100);
    camera.position.set(0, 2, 10);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();

    expect(isDirectorBatchedObjectBatchMesh(mesh)).toBe(true);
    if (!isDirectorBatchedObjectBatchMesh(mesh)) throw new Error("expected a BatchedMesh");
    mesh.onBeforeRender(null!, null!, camera, mesh.geometry, mesh.material, null!);
    expect((mesh as typeof mesh & { _multiDrawCount: number })._multiDrawCount).toBe(1);
    expect(mesh.perObjectFrustumCulled).toBe(true);
    expect(mesh.sortObjects).toBe(false);
    expect(mesh.userData.directorInstanceObjectIds).toEqual(objects.map((object) => object.id));

    disposeDirectorStaticPrimitiveRenderMesh(mesh);
  });

  it("keeps InstancedMesh as the compatibility path without GPU multi-draw", () => {
    const objects = Array.from({ length: 4 }, (_, index) => createBox(`box_${index}`));
    const batch = createDirectorStaticPrimitiveBatchPartition(objects, new Set(), true).batches[0]!;
    const mesh = createDirectorStaticPrimitiveRenderMesh(batch, false);

    expect(isDirectorInstancedObjectBatchMesh(mesh)).toBe(true);
    expect(mesh.userData.directorInstanceObjectIds).toEqual(objects.map((object) => object.id));

    disposeDirectorStaticPrimitiveRenderMesh(mesh);
  });

  it("disposes batches after React Three Fiber disables automatic disposal", () => {
    const objects = Array.from({ length: 4 }, (_, index) => createBox(`box_${index}`));
    const batch = createDirectorStaticPrimitiveBatchPartition(objects, new Set(), true).batches[0]!;

    for (const supportsMultiDraw of [true, false]) {
      const mesh = createDirectorStaticPrimitiveRenderMesh(batch, supportsMultiDraw);
      Object.defineProperty(mesh, "dispose", { configurable: true, value: null });
      expect(() => disposeDirectorStaticPrimitiveRenderMesh(mesh)).not.toThrow();
    }
  });
});
