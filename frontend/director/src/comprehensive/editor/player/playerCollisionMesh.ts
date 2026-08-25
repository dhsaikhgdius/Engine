import {
  Matrix4,
  Vector3,
  type BufferAttribute,
  type BufferGeometry,
  type InterleavedBufferAttribute,
  type Material,
  type Object3D,
} from "three";

const HIDE_FROM_VIEWPORT_CAPTURE_KEY = "hideFromViewportCapture";
const COLLISION_DISABLED_KEY = "directorCollisionDisabled";
const GROUND_RAYCAST_DISABLED_KEY = "directorGroundRaycastDisabled";

type CollisionRenderable = Object3D & {
  count?: number;
  geometry?: BufferGeometry;
  getMatrixAt?: (index: number, matrix: Matrix4) => void;
  getVertexPosition?: (index: number, target: Vector3) => Vector3;
  isInstancedMesh?: boolean;
  isMesh?: boolean;
  isSkinnedMesh?: boolean;
  material?: Material | Material[];
};

type CollidableRenderable = CollisionRenderable & {
  geometry: BufferGeometry;
  isMesh: true;
};

export interface PlayerCollisionMesh {
  /** Merged triangle indices (3 per triangle). */
  indices: Uint32Array;
  /** Human-readable label for the source geometry or merged batch. */
  sourceName: string;
  /** Merged vertex positions in [x, y, z, x, y, z, ...] order. */
  vertices: Float32Array;
}

/** Default safety limits that prevent runaway memory allocation on large imports. */
export const DEFAULT_PLAYER_COLLISION_MESH_BUDGET = {
  maxInstances: 20_000,
  maxTriangles: 2_000_000,
} as const;

export interface PlayerCollisionMeshBudget {
  /** Maximum distinct-instance count (InstancedMesh counts × instanceCount). */
  maxInstances: number;
  /** Maximum total triangle count across all merged geometry. */
  maxTriangles: number;
}

/** Thrown when a scene import exceeds the configured collision budget. */
export class PlayerCollisionMeshBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlayerCollisionMeshBudgetError";
  }
}

function isMaterialCollidable(material: Material | Material[] | undefined) {
  if (!material) return true;
  const materials = Array.isArray(material) ? material : [material];
  return materials.some((item) => item.visible !== false && (!item.transparent || item.opacity > 0));
}

function isCollisionHierarchyVisible(object: Object3D, root: Object3D) {
  let current: Object3D | null = object;
  while (current) {
    if (
      !current.visible ||
      current.userData?.[HIDE_FROM_VIEWPORT_CAPTURE_KEY] ||
      current.userData?.[COLLISION_DISABLED_KEY] ||
      current.userData?.[GROUND_RAYCAST_DISABLED_KEY] ||
      current.userData?.directorDropPreview
    ) {
      return false;
    }
    if (current === root) break;
    current = current.parent;
  }
  return true;
}

function isCollisionRenderable(object: Object3D, root: Object3D): object is CollidableRenderable {
  const renderable = object as CollisionRenderable;
  return Boolean(
    renderable.isMesh &&
    !renderable.isSkinnedMesh &&
    renderable.geometry?.getAttribute("position")?.count &&
    isMaterialCollidable(renderable.material) &&
    isCollisionHierarchyVisible(object, root),
  );
}

function readVertex(
  object: CollisionRenderable,
  position: BufferAttribute | InterleavedBufferAttribute,
  index: number,
  target: Vector3,
) {
  if (object.getVertexPosition) return object.getVertexPosition(index, target);
  return target.fromBufferAttribute(position, index);
}

function visitValidTriangleIndices(
  geometry: BufferGeometry,
  vertexCount: number,
  visit?: (a: number, b: number, c: number) => void,
) {
  const source = geometry.index;
  const sourceCount = source ? source.count : vertexCount;
  const triangleIndexCount = Math.floor(sourceCount / 3) * 3;
  let validIndexCount = 0;

  for (let sourceIndex = 0; sourceIndex < triangleIndexCount; sourceIndex += 3) {
    const a = source ? source.getX(sourceIndex) : sourceIndex;
    const b = source ? source.getX(sourceIndex + 1) : sourceIndex + 1;
    const c = source ? source.getX(sourceIndex + 2) : sourceIndex + 2;
    if (
      !Number.isInteger(a) ||
      !Number.isInteger(b) ||
      !Number.isInteger(c) ||
      a < 0 ||
      b < 0 ||
      c < 0 ||
      a >= vertexCount ||
      b >= vertexCount ||
      c >= vertexCount ||
      a === b ||
      b === c ||
      c === a
    ) {
      continue;
    }
    visit?.(a, b, c);
    validIndexCount += 3;
  }
  return validIndexCount;
}

/**
 * Returns whether an asynchronously mounted scene root already exposes at
 * least one usable render mesh. This check is allocation-free and is used
 * only while the GLB Suspense boundary is still settling.
 */
export function hasPlayerCollisionGeometry(root: Object3D) {
  let found = false;
  root.traverse((child) => {
    if (!found && isCollisionRenderable(child, root)) found = true;
  });
  return found;
}

/**
 * Snapshots visible render geometry into the Director scene's local coordinate
 * system. The result is created only when an imported environment mounts or
 * changes; no geometry traversal or typed-array allocation occurs per frame.
 */
export function buildPlayerCollisionMeshes(
  roots: readonly Object3D[],
  referenceRoot: Object3D,
  budget: Partial<PlayerCollisionMeshBudget> = {},
) {
  const renderables: CollidableRenderable[] = [];
  roots.forEach((root) => {
    root.traverse((child) => {
      if (isCollisionRenderable(child, root)) renderables.push(child);
    });
  });
  return buildPlayerCollisionMeshSnapshot(renderables, referenceRoot, budget);
}

/**
 * Builds the Rapier snapshot from a version-owned flat static mesh set. Unlike
 * the compatibility root API above, this path never traverses the render tree.
 */
export function buildPlayerCollisionMeshesFromFlatMeshes(
  meshes: readonly Object3D[],
  referenceRoot: Object3D,
  budget: Partial<PlayerCollisionMeshBudget> = {},
) {
  const known = new Set<Object3D>();
  const renderables: CollidableRenderable[] = [];
  for (const mesh of meshes) {
    if (known.has(mesh) || !isCollisionRenderable(mesh, referenceRoot)) continue;
    known.add(mesh);
    renderables.push(mesh);
  }
  return buildPlayerCollisionMeshSnapshot(renderables, referenceRoot, budget);
}

function buildPlayerCollisionMeshSnapshot(
  renderables: readonly CollidableRenderable[],
  referenceRoot: Object3D,
  budget: Partial<PlayerCollisionMeshBudget>,
) {
  referenceRoot.updateWorldMatrix(true, true);

  const maxInstances = Math.max(1, budget.maxInstances ?? DEFAULT_PLAYER_COLLISION_MESH_BUDGET.maxInstances);
  const maxTriangles = Math.max(1, budget.maxTriangles ?? DEFAULT_PLAYER_COLLISION_MESH_BUDGET.maxTriangles);
  let instanceCountTotal = 0;
  let vertexFloatCount = 0;
  let indexCount = 0;
  let firstSourceName = "scene";

  // Pass one only counts validated source data. This avoids allocating one
  // typed-array pair per Blender object and then allocating the merged pair a
  // second time, which doubled peak memory on large environments.
  for (const child of renderables) {
    const position = child.geometry.getAttribute("position");
    const validIndices = visitValidTriangleIndices(child.geometry, position.count);
    if (validIndices < 3) continue;
    const instanceCount = child.isInstancedMesh ? Math.max(0, child.count ?? 0) : 1;
    if (instanceCount <= 0) continue;
    if (instanceCountTotal === 0) firstSourceName = child.name || "scene";
    instanceCountTotal += instanceCount;
    vertexFloatCount += position.count * 3 * instanceCount;
    indexCount += validIndices * instanceCount;
    if (instanceCountTotal > maxInstances) {
      throw new PlayerCollisionMeshBudgetError(
        `Imported scene exceeds collision instance budget (${instanceCountTotal} > ${maxInstances}).`,
      );
    }
    const triangleCount = indexCount / 3;
    if (triangleCount > maxTriangles) {
      throw new PlayerCollisionMeshBudgetError(
        `Imported scene exceeds collision triangle budget (${triangleCount} > ${maxTriangles}).`,
      );
    }
  }

  if (instanceCountTotal === 0 || indexCount < 3) return [];

  const vertices = new Float32Array(vertexFloatCount);
  const indices = new Uint32Array(indexCount);
  const referenceInverse = new Matrix4().copy(referenceRoot.matrixWorld).invert();
  const instanceMatrix = new Matrix4();
  const vertexMatrix = new Matrix4();
  const vertex = new Vector3();
  let vertexFloatOffset = 0;
  let indexOffset = 0;

  // Pass two writes directly into the final merged arrays.
  for (const child of renderables) {
    const geometry = child.geometry;
    const position = geometry.getAttribute("position");
    const vertexCount = position.count;
    const validIndexCount = visitValidTriangleIndices(geometry, vertexCount);
    if (validIndexCount < 3) continue;

    const instanceCount = child.isInstancedMesh ? Math.max(0, child.count ?? 0) : 1;
    for (let instanceIndex = 0; instanceIndex < instanceCount; instanceIndex += 1) {
      vertexMatrix.multiplyMatrices(referenceInverse, child.matrixWorld);
      if (child.isInstancedMesh && child.getMatrixAt) {
        child.getMatrixAt(instanceIndex, instanceMatrix);
        vertexMatrix.multiply(instanceMatrix);
      }

      for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex += 1) {
        readVertex(child, position, vertexIndex, vertex).applyMatrix4(vertexMatrix);
        const offset = vertexFloatOffset + vertexIndex * 3;
        vertices[offset] = vertex.x;
        vertices[offset + 1] = vertex.y;
        vertices[offset + 2] = vertex.z;
      }
      const vertexOffset = vertexFloatOffset / 3;
      visitValidTriangleIndices(geometry, vertexCount, (a, b, c) => {
        indices[indexOffset] = a + vertexOffset;
        indices[indexOffset + 1] = b + vertexOffset;
        indices[indexOffset + 2] = c + vertexOffset;
        indexOffset += 3;
      });
      vertexFloatOffset += vertexCount * 3;
    }
  }

  return [
    { indices, sourceName: instanceCountTotal === 1 ? firstSourceName : `merged:${instanceCountTotal}`, vertices },
  ];
}
