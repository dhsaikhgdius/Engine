import { Box3, Matrix4, Mesh, type BufferGeometry, type Object3D, type Vector3 } from "three";
import { acceleratedRaycast, computeBoundsTree } from "three-mesh-bvh";

const acceleratedGeometries = new WeakSet<BufferGeometry>();
const acceleratedMeshes = new WeakSet<Mesh>();
const staticPrimitiveCollisionProxies = new WeakMap<Object3D, PlayerRaycastMesh[]>();
const sceneRaycastRegistries = new WeakMap<Object3D, PlayerSceneRaycastRegistry>();
const NON_COLLIDABLE_NAME =
  /transformcontrols|viewport-ground-grid|panorama-backdrop|camera-frustum|frame-trajectory-overlay|drop-preview/i;
const DEEP_TOPOLOGY_POLL_MS = 500;
const SPATIAL_CELL_SIZE_M = 16;
const MAX_INDEX_CELLS_PER_MESH = 256;
const MAX_QUERY_CELLS = 256;

/**
 * A Three.js Mesh that participates in the raycast acceleration system.
 * Instanced, batched, and skinned meshes are tracked separately because
 * their raycast paths differ from ordinary Mesh.
 */
export type PlayerRaycastMesh = Mesh & {
  isBatchedMesh?: boolean;
  isInstancedMesh?: boolean;
  isLineSegments2?: boolean;
  isSkinnedMesh?: boolean;
};

type PlayerRaycastOwner = {
  deepHash: number;
  directHash: number;
  lastDeepCheckMs: number;
  meshes: PlayerRaycastMesh[];
  registrations: Set<symbol>;
  root: Object3D;
  topologyPolling: boolean;
};

type PlayerSceneRaycastRegistry = {
  fallbackCleanup: (() => void) | null;
  flatMeshes: PlayerRaycastMesh[];
  flatMeshesDirty: boolean;
  lastPollMs: number;
  owners: Map<Object3D, PlayerRaycastOwner>;
  oversizedMeshes: PlayerRaycastMesh[];
  pollingOwners: Set<PlayerRaycastOwner>;
  queryMeshes: PlayerRaycastMesh[];
  querySerial: number;
  queryStamps: WeakMap<PlayerRaycastMesh, number>;
  spatialCells: Map<string, PlayerRaycastMesh[]>;
};

const spatialBounds = new Box3();

function spatialCell(value: number) {
  return Math.floor(value / SPATIAL_CELL_SIZE_M);
}

function spatialCellKey(x: number, z: number) {
  return `${x}:${z}`;
}

function getPlayerRaycastMeshWorldBounds(mesh: PlayerRaycastMesh, target: Box3) {
  if (mesh.isInstancedMesh || mesh.isBatchedMesh) {
    const instanced = mesh as PlayerRaycastMesh & {
      boundingBox: Box3 | null;
      computeBoundingBox(): void;
    };
    if (!instanced.boundingBox) instanced.computeBoundingBox();
    if (!instanced.boundingBox) return null;
    return target.copy(instanced.boundingBox).applyMatrix4(mesh.matrixWorld);
  }

  if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
  if (!mesh.geometry.boundingBox) return null;
  return target.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld);
}

function rebuildSpatialIndex(registry: PlayerSceneRaycastRegistry) {
  registry.spatialCells.clear();
  registry.oversizedMeshes.length = 0;

  for (const mesh of registry.flatMeshes) {
    const bounds = getPlayerRaycastMeshWorldBounds(mesh, spatialBounds);
    if (!bounds || bounds.isEmpty()) {
      registry.oversizedMeshes.push(mesh);
      continue;
    }
    const minX = spatialCell(bounds.min.x);
    const maxX = spatialCell(bounds.max.x);
    const minZ = spatialCell(bounds.min.z);
    const maxZ = spatialCell(bounds.max.z);
    const cellCount = (maxX - minX + 1) * (maxZ - minZ + 1);
    if (!Number.isFinite(cellCount) || cellCount > MAX_INDEX_CELLS_PER_MESH) {
      registry.oversizedMeshes.push(mesh);
      continue;
    }
    for (let x = minX; x <= maxX; x += 1) {
      for (let z = minZ; z <= maxZ; z += 1) {
        const key = spatialCellKey(x, z);
        const cell = registry.spatialCells.get(key);
        if (cell) cell.push(mesh);
        else registry.spatialCells.set(key, [mesh]);
      }
    }
  }
}

function hashTopologyObject(hash: number, object: Object3D) {
  const geometryId = (object as PlayerRaycastMesh).geometry?.id ?? 0;
  return Math.imul(hash ^ object.id ^ object.children.length ^ geometryId, 16777619);
}

function directTopologyHash(root: Object3D) {
  let hash = hashTopologyObject(2166136261, root);
  for (const child of root.children) {
    hash = hashTopologyObject(hash, child);
    // R3F asset wrappers commonly mount the loaded primitive one level down.
    for (const grandchild of child.children) hash = hashTopologyObject(hash, grandchild);
  }
  return hash;
}

function deepTopologyHash(root: Object3D) {
  let hash = 2166136261;
  root.traverse((object) => {
    hash = hashTopologyObject(hash, object);
  });
  return hash;
}

function getOrCreateSceneRegistry(sceneRoot: Object3D) {
  let registry = sceneRaycastRegistries.get(sceneRoot);
  if (!registry) {
    registry = {
      fallbackCleanup: null,
      flatMeshes: [],
      flatMeshesDirty: true,
      lastPollMs: 0,
      owners: new Map(),
      oversizedMeshes: [],
      pollingOwners: new Set(),
      queryMeshes: [],
      querySerial: 0,
      queryStamps: new WeakMap(),
      spatialCells: new Map(),
    };
    sceneRaycastRegistries.set(sceneRoot, registry);
  }
  return registry;
}

function refreshRaycastOwner(owner: PlayerRaycastOwner, now: number) {
  if (!owner.topologyPolling) return false;
  const nextDirectHash = directTopologyHash(owner.root);
  let topologyChanged = nextDirectHash !== owner.directHash;
  if (topologyChanged || now - owner.lastDeepCheckMs >= DEEP_TOPOLOGY_POLL_MS) {
    const nextDeepHash = deepTopologyHash(owner.root);
    topologyChanged ||= nextDeepHash !== owner.deepHash;
    owner.deepHash = nextDeepHash;
    owner.lastDeepCheckMs = now;
  }
  owner.directHash = nextDirectHash;
  if (topologyChanged) owner.meshes = collectPlayerRaycastMeshes([owner.root]);
  return topologyChanged;
}

function readSceneRegistryMeshes(registry: PlayerSceneRaycastRegistry) {
  const now = Date.now();
  if (now - registry.lastPollMs >= 16) {
    registry.lastPollMs = now;
    for (const owner of registry.pollingOwners) {
      if (refreshRaycastOwner(owner, now)) registry.flatMeshesDirty = true;
    }
  }
  if (!registry.flatMeshesDirty) return registry.flatMeshes;
  registry.flatMeshes.length = 0;
  const known = new Set<PlayerRaycastMesh>();
  for (const owner of registry.owners.values()) {
    for (const mesh of owner.meshes) {
      if (known.has(mesh)) continue;
      known.add(mesh);
      registry.flatMeshes.push(mesh);
    }
  }
  registry.flatMeshesDirty = false;
  rebuildSpatialIndex(registry);
  return registry.flatMeshes;
}

function appendSpatialQueryMesh(registry: PlayerSceneRaycastRegistry, mesh: PlayerRaycastMesh, serial: number) {
  if (registry.queryStamps.get(mesh) === serial) return;
  registry.queryStamps.set(mesh, serial);
  registry.queryMeshes.push(mesh);
}

function isStaticPlayerRaycastCandidate(object: Object3D, root: Object3D) {
  let current: Object3D | null = object;
  while (current) {
    // Visibility and collision flags are evaluated at hit time, because both
    // can be toggled without changing scene topology. Only stable helper
    // identity belongs in the cached candidate filter.
    if (NON_COLLIDABLE_NAME.test(current.name)) return false;
    if (current === root) break;
    current = current.parent;
  }
  return true;
}

function getStaticPrimitiveCollisionProxies(mesh: PlayerRaycastMesh) {
  const objectIds = mesh.userData?.directorInstanceObjectIds;
  const getMatrixAt = (mesh as PlayerRaycastMesh & { getMatrixAt?: (index: number, matrix: Matrix4) => void })
    .getMatrixAt;
  if (!Array.isArray(objectIds) || !getMatrixAt) return [mesh];

  let proxies = staticPrimitiveCollisionProxies.get(mesh);
  if (!proxies || proxies.length !== objectIds.length) {
    proxies = objectIds.map((objectId, index) => {
      const proxy = new Mesh(mesh.geometry, mesh.material) as PlayerRaycastMesh;
      proxy.matrixAutoUpdate = false;
      proxy.name = `${mesh.name || "director-primitive-batch"}-collision-${index}`;
      proxy.userData.directorObjectId = objectId;
      proxy.userData.directorObjectKind = mesh.userData.directorObjectKind;
      return proxy;
    });
    staticPrimitiveCollisionProxies.set(mesh, proxies);
  }

  mesh.updateWorldMatrix(true, false);
  const instanceMatrix = new Matrix4();
  proxies.forEach((proxy, index) => {
    getMatrixAt.call(mesh, index, instanceMatrix);
    proxy.matrix.multiplyMatrices(mesh.matrixWorld, instanceMatrix);
    proxy.matrixWorld.copy(proxy.matrix);
    proxy.visible = mesh.visible;
  });
  return proxies;
}

/**
 * Returns every scene-graph node whose `directorObjectId` or
 * `directorInstanceObjectIds` userData matches one of the requested ids.
 * Used to locate the mounted roots of collision-eligible objects.
 *
 * @param sceneRoot - The Three.js scene root to traverse.
 * @param objectIds - Director object ids to search for.
 * @returns Matching Object3D nodes in traversal order.
 */
export function findPlayerCollisionRootsByDirectorObjectIds(sceneRoot: Object3D, objectIds: readonly string[]) {
  const requestedIds = new Set(objectIds);
  const roots = new Set<Object3D>();
  sceneRoot.traverse((object) => {
    const objectId = object.userData?.directorObjectId;
    if (typeof objectId === "string" && requestedIds.has(objectId)) roots.add(object);
    const instanceObjectIds = object.userData?.directorInstanceObjectIds;
    if (Array.isArray(instanceObjectIds) && instanceObjectIds.some((id) => requestedIds.has(id))) roots.add(object);
  });
  return [...roots];
}

/**
 * Collects every static Mesh suitable for raycast acceleration from the given
 * roots. Skinned meshes, LineSegments2, and helper-named objects are excluded.
 * Batched static primitives are expanded into per-instance collision proxies.
 *
 * @param roots - Scene-graph roots to traverse.
 * @returns Flat list of collision-eligible meshes.
 */
export function collectPlayerRaycastMeshes(roots: readonly Object3D[]) {
  const meshes: PlayerRaycastMesh[] = [];
  for (const root of roots) {
    root.traverse((child) => {
      const mesh = child as PlayerRaycastMesh;
      if (
        !mesh.isMesh ||
        mesh.isLineSegments2 ||
        mesh.isSkinnedMesh ||
        !mesh.geometry?.getAttribute("position")?.count ||
        !isStaticPlayerRaycastCandidate(mesh, root)
      ) {
        return;
      }
      if (mesh.isBatchedMesh && mesh.userData?.directorStaticPrimitiveBatch) {
        meshes.push(...getStaticPrimitiveCollisionProxies(mesh));
      } else {
        meshes.push(mesh);
      }
    });
  }
  return meshes;
}

/**
 * Registers one obstacle owner. Async children are detected from a cheap
 * two-level signature immediately and a deeper allocation-free signature at
 * a bounded 500 ms cadence. Cleanup removes stale/disposed mesh candidates.
 */
export function registerPlayerSceneRaycastOwner(
  sceneRoot: Object3D,
  ownerRoot: Object3D,
  staticMeshes?: readonly PlayerRaycastMesh[],
) {
  const registry = getOrCreateSceneRegistry(sceneRoot);
  if (registry.fallbackCleanup) {
    const cleanup = registry.fallbackCleanup;
    registry.fallbackCleanup = null;
    cleanup();
  }
  return registerSceneRaycastOwner(registry, ownerRoot, staticMeshes);
}

function registerSceneRaycastOwner(
  registry: PlayerSceneRaycastRegistry,
  ownerRoot: Object3D,
  staticMeshes?: readonly PlayerRaycastMesh[],
) {
  const token = Symbol("player-raycast-owner");
  let owner = registry.owners.get(ownerRoot);
  if (!owner) {
    const topologyPolling = staticMeshes === undefined;
    owner = {
      deepHash: topologyPolling ? deepTopologyHash(ownerRoot) : 0,
      directHash: topologyPolling ? directTopologyHash(ownerRoot) : 0,
      lastDeepCheckMs: Date.now(),
      meshes: staticMeshes ? [...staticMeshes] : collectPlayerRaycastMeshes([ownerRoot]),
      registrations: new Set(),
      root: ownerRoot,
      topologyPolling,
    };
    registry.owners.set(ownerRoot, owner);
    if (topologyPolling) registry.pollingOwners.add(owner);
    registry.flatMeshesDirty = true;
  }
  owner.registrations.add(token);
  return () => {
    const current = registry.owners.get(ownerRoot);
    if (!current) return;
    current.registrations.delete(token);
    if (current.registrations.size > 0) return;
    registry.owners.delete(ownerRoot);
    registry.pollingOwners.delete(current);
    registry.flatMeshesDirty = true;
  };
}

/** Flat meshes registered by active collision owners; never recurses at hit time. */
export function getPlayerSceneRaycastMeshes(sceneRoot: Object3D) {
  return readSceneRegistryMeshes(getOrCreateSceneRegistry(sceneRoot));
}

/**
 * Exact X/Z broad phase for short camera and foot rays. Every mesh whose world
 * bounds can intersect the padded segment is returned; the narrow-phase Three
 * raycast remains unchanged, so this removes object scans without reducing
 * collision precision.
 */
export function getPlayerSceneRaycastMeshesNearSegment(
  sceneRoot: Object3D,
  start: Pick<Vector3, "x" | "z">,
  end: Pick<Vector3, "x" | "z">,
  padding = 0,
) {
  const registry = getOrCreateSceneRegistry(sceneRoot);
  const allMeshes = readSceneRegistryMeshes(registry);
  const safePadding = Number.isFinite(padding) ? Math.max(0, padding) : 0;
  const minX = spatialCell(Math.min(start.x, end.x) - safePadding);
  const maxX = spatialCell(Math.max(start.x, end.x) + safePadding);
  const minZ = spatialCell(Math.min(start.z, end.z) - safePadding);
  const maxZ = spatialCell(Math.max(start.z, end.z) + safePadding);
  const cellCount = (maxX - minX + 1) * (maxZ - minZ + 1);
  if (!Number.isFinite(cellCount) || cellCount > MAX_QUERY_CELLS) return allMeshes;

  registry.queryMeshes.length = 0;
  registry.querySerial += 1;
  const serial = registry.querySerial;
  for (const mesh of registry.oversizedMeshes) appendSpatialQueryMesh(registry, mesh, serial);
  for (let x = minX; x <= maxX; x += 1) {
    for (let z = minZ; z <= maxZ; z += 1) {
      const cell = registry.spatialCells.get(spatialCellKey(x, z));
      if (!cell) continue;
      for (const mesh of cell) appendSpatialQueryMesh(registry, mesh, serial);
    }
  }
  return registry.queryMeshes;
}

/**
 * Standalone/test fallback. Production roam normally receives the list that
 * PlayerController already collected and prewarmed.
 */
export function getOrCollectPlayerSceneRaycastMeshes(sceneRoot: Object3D) {
  const registry = getOrCreateSceneRegistry(sceneRoot);
  if (registry.owners.size === 0 && !registry.fallbackCleanup) {
    const cleanup = registerSceneRaycastOwner(registry, sceneRoot);
    registry.fallbackCleanup = () => {
      cleanup();
      registry.fallbackCleanup = null;
    };
  }
  return readSceneRegistryMeshes(registry);
}

/**
 * Convenience that ensures a fallback owner is registered before querying the
 * spatial index. Production roam should prefer the prewarmed list from
 * PlayerController; this is for standalone callers and tests.
 *
 * @param sceneRoot - The Three.js scene root.
 * @param start - Segment start point (only x and z are read).
 * @param end - Segment end point (only x and z are read).
 * @param padding - Extra metres to expand the spatial query bounds.
 * @returns Meshes whose world bounds intersect the padded segment.
 */
export function getOrCollectPlayerSceneRaycastMeshesNearSegment(
  sceneRoot: Object3D,
  start: Pick<Vector3, "x" | "z">,
  end: Pick<Vector3, "x" | "z">,
  padding = 0,
) {
  getOrCollectPlayerSceneRaycastMeshes(sceneRoot);
  return getPlayerSceneRaycastMeshesNearSegment(sceneRoot, start, end, padding);
}

/**
 * Applies three-mesh-bvh acceleration to a contiguous batch of meshes.
 * Instanced and batched meshes are skipped because their raycast paths
 * cannot be replaced without losing per-instance hit data.
 *
 * @param meshes - The full mesh list to accelerate from.
 * @param startIndex - Index into meshes where this batch begins.
 * @param maxMeshCount - Maximum number of meshes to process in this batch.
 * @returns Count of geometries accelerated and the next unprocessed index.
 */
export function acceleratePlayerSceneRaycastBatch(
  meshes: readonly PlayerRaycastMesh[],
  startIndex: number,
  maxMeshCount = 32,
) {
  const endIndex = Math.min(meshes.length, startIndex + Math.max(1, maxMeshCount));
  let geometryCount = 0;
  for (let index = startIndex; index < endIndex; index += 1) {
    const mesh = meshes[index];
    // three-mesh-bvh 0.7.8 accelerates ordinary Mesh.raycast only. Replacing
    // InstancedMesh/BatchedMesh raycast loses their per-object matrix walk and
    // therefore loses instanceId/batchId hits. Keep Three's native paths.
    if (mesh.isInstancedMesh || mesh.isBatchedMesh) continue;
    if (!acceleratedGeometries.has(mesh.geometry)) {
      computeBoundsTree.call(mesh.geometry, { maxLeafTris: 12, setBoundingBox: true });
      acceleratedGeometries.add(mesh.geometry);
      geometryCount += 1;
    }
    if (!acceleratedMeshes.has(mesh)) {
      mesh.raycast = acceleratedRaycast;
      acceleratedMeshes.add(mesh);
    }
  }
  return { geometryCount, nextIndex: endIndex };
}

/**
 * Prewarms cached BVHs for imported static environments. Camera occlusion and
 * the two independent foot probes continue to query the visible render meshes,
 * but no longer scan every triangle of a Blender scene on every ray.
 */
export function acceleratePlayerSceneRaycasts(roots: readonly Object3D[]) {
  const meshes = collectPlayerRaycastMeshes(roots);
  let geometryCount = 0;
  let nextIndex = 0;
  while (nextIndex < meshes.length) {
    const batch = acceleratePlayerSceneRaycastBatch(meshes, nextIndex, meshes.length);
    geometryCount += batch.geometryCount;
    nextIndex = batch.nextIndex;
  }
  return { geometryCount, meshCount: meshes.length };
}
