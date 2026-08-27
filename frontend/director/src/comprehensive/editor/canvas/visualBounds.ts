/**
 * Visual bounding-box computation that only counts renderable geometry:
 * walks an object hierarchy accumulating vertex positions (instanced meshes
 * included) while skipping invisible nodes and fully transparent materials,
 * so selection outlines and drop placement reflect what the user actually
 * sees instead of raw Box3 unions that helpers and hidden meshes inflate.
 */
import {
  Matrix4,
  Vector3,
  type BufferAttribute,
  type BufferGeometry,
  type InterleavedBufferAttribute,
  type Material,
  type Object3D,
} from "three";

type RenderableObject = Object3D & {
  count?: number;
  geometry?: BufferGeometry;
  getMatrixAt?: (index: number, matrix: Matrix4) => void;
  getVertexPosition?: (index: number, target: Vector3) => Vector3;
  isInstancedMesh?: boolean;
  material?: Material | Material[];
};

function isMaterialVisible(material: Material | Material[] | undefined) {
  if (!material) return true;
  const materials = Array.isArray(material) ? material : [material];
  return materials.some((item) => item.visible !== false && (!item.transparent || item.opacity > 0));
}

function readVertex(
  object: RenderableObject,
  position: BufferAttribute | InterleavedBufferAttribute,
  index: number,
  target: Vector3,
) {
  if (object.getVertexPosition) return object.getVertexPosition(index, target);
  return target.fromBufferAttribute(position, index);
}

function getVisibleObjectsLocalBounds(referenceRoot: Object3D, visualRoots: readonly Object3D[]) {
  referenceRoot.updateWorldMatrix(true, true);
  visualRoots.forEach((root) => root.updateWorldMatrix(true, true));

  const childToWorld = new Matrix4();
  const instanceMatrix = new Matrix4();
  const vertexMatrix = new Matrix4();
  const vertex = new Vector3();
  const minimum = new Vector3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
  const maximum = new Vector3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);
  let hasVertex = false;

  visualRoots.forEach((root) => {
    root.traverseVisible((child) => {
      const object = child as RenderableObject;
      if (!object.geometry || !isMaterialVisible(object.material)) return;
      const position = object.geometry.getAttribute("position");
      if (!position?.count) return;

      const instanceCount = object.isInstancedMesh ? Math.max(0, object.count ?? 0) : 1;
      childToWorld.copy(object.matrixWorld);
      for (let instanceIndex = 0; instanceIndex < instanceCount; instanceIndex += 1) {
        if (object.isInstancedMesh && object.getMatrixAt) {
          object.getMatrixAt(instanceIndex, instanceMatrix);
          vertexMatrix.multiplyMatrices(childToWorld, instanceMatrix);
        } else {
          vertexMatrix.copy(childToWorld);
        }

        for (let vertexIndex = 0; vertexIndex < position.count; vertexIndex += 1) {
          readVertex(object, position, vertexIndex, vertex).applyMatrix4(vertexMatrix);
          minimum.min(vertex);
          maximum.max(vertex);
          hasVertex = true;
        }
      }
    });
  });

  if (!hasVertex) return null;
  return { minimum, maximum };
}

/**
 * Measures the union of visible render vertices as a world-aligned box, then
 * expresses that visual center in the requested reference object's local
 * coordinates. Hidden and fully transparent helper geometry is ignored.
 */
export function getVisibleObjectsLocalCenter(
  referenceRoot: Object3D,
  visualRoots: readonly Object3D[],
): [number, number, number] | null {
  const bounds = getVisibleObjectsLocalBounds(referenceRoot, visualRoots);
  if (!bounds) return null;
  const localCenter = referenceRoot.worldToLocal(bounds.minimum.add(bounds.maximum).multiplyScalar(0.5));
  return [localCenter.x, localCenter.y, localCenter.z];
}

/**
 * Measures the bottom-centre of the visible render bounds in the requested
 * reference object's local coordinates. This is the floor pivot used by
 * viewport transform controls for grounded assets.
 */
export function getVisibleObjectsLocalFloorPivot(
  referenceRoot: Object3D,
  visualRoots: readonly Object3D[],
): [number, number, number] | null {
  const bounds = getVisibleObjectsLocalBounds(referenceRoot, visualRoots);
  if (!bounds) return null;
  const localFloorPivot = referenceRoot.worldToLocal(
    new Vector3(
      (bounds.minimum.x + bounds.maximum.x) * 0.5,
      bounds.minimum.y,
      (bounds.minimum.z + bounds.maximum.z) * 0.5,
    ),
  );
  return [localFloorPivot.x, localFloorPivot.y, localFloorPivot.z];
}

export function getVisibleObjectLocalCenter(root: Object3D): [number, number, number] | null {
  return getVisibleObjectsLocalCenter(root, [root]);
}

export function getVisibleObjectLocalFloorPivot(root: Object3D): [number, number, number] | null {
  return getVisibleObjectsLocalFloorPivot(root, [root]);
}
