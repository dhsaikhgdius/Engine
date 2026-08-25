import { useCallback, useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Euler, Matrix4, Quaternion, Raycaster, Vector3, type Intersection, type Object3D } from "three";
import {
  acceleratePlayerSceneRaycastBatch,
  getOrCollectPlayerSceneRaycastMeshes,
  type PlayerRaycastMesh,
} from "../player/playerRaycastAcceleration";
import { useDirectorStore } from "../store/directorStore";

/**
 * Terrain ground sampling for grounded Living World systems.
 *
 * Coordinate frame: the probe accepts and returns PROJECT-space values (the
 * space every Living World sub-layer works in, inside the SceneRoot group).
 * SceneRoot mounts its group directly under the R3F scene with the project's
 * `scene.position/rotation/scale`, so the project->world matrix is rebuilt
 * from those store values and every ray is cast in world space against the
 * scene meshes, then the hit is mapped back to project space. Scene
 * transforms are usually identity, but a moved/rotated/scaled scene keeps
 * sampling correct instead of silently breaking.
 *
 * Determinism: samples reflect the CURRENT scene, so they must never enter
 * checkpoint-replayed simulation state; consumers snap render output only
 * (see the note on `LivingWorldFrameContext.sampleGroundHeight`).
 */
export type WorldGroundSampler = (x: number, z: number) => number | null;

/** Probe span in project space: rays go from y=+500 straight down to y=-500. */
export const WORLD_GROUND_PROBE_TOP_Y = 500;
export const WORLD_GROUND_PROBE_BOTTOM_Y = -500;

/** Quantization grid for the sample cache (metres, project space). */
export const WORLD_GROUND_CELL_SIZE_M = 0.5;

/**
 * Full cache flush cadence. Store-object identity and mesh-set signature
 * changes invalidate immediately; this periodic flush bounds staleness for
 * everything they cannot see (animated platforms, live DCC mesh edits that
 * keep object ids stable). Trade-off: terrain that moves without an authored
 * edit can render up to ~5 s (at 60 fps) of stale heights, in exchange for
 * near-zero steady-state raycast work.
 */
const CACHE_FLUSH_INTERVAL_FRAMES = 300;

// Filtering conventions replicated from the player collision/ground-probe
// modules (playerCollisionMesh.ts, mixamoFootGroundProbe.ts). Each consumer
// re-declares the userData keys rather than importing them; the shared
// contract is the string values.
const HIDE_FROM_VIEWPORT_CAPTURE_KEY = "hideFromViewportCapture";
const COLLISION_DISABLED_KEY = "collisionDisabled";
const DIRECTOR_COLLISION_DISABLED_KEY = "directorCollisionDisabled";
const GROUND_RAYCAST_DISABLED_KEY = "directorGroundRaycastDisabled";
const NON_TERRAIN_OBJECT_KINDS = new Set(["camera", "character", "panorama"]);
const NON_TERRAIN_NAME =
  /transformcontrols|viewport-ground-grid|panorama-backdrop|camera-frustum|frame-trajectory-overlay|drop-preview/i;
/**
 * The Living World's own renderables must never count as terrain (a deer must
 * not stand on a bird). Layer group names are `living-world-*` except the
 * water layer's `director-living-world-water`, so this is a substring marker
 * rather than a prefix match. Effect particles are Points (not meshes) and
 * never enter the raycast candidate list in the first place.
 */
const LIVING_WORLD_NAME_MARKER = "living-world-";

/**
 * Whether a raycast hit counts as terrain. Walks the ancestor chain like the
 * player/mixamo ground probes: hidden nodes, collision/ground-raycast opt-outs,
 * viewport helpers, Living World renderables, and camera/character/panorama
 * owners are all rejected. Evaluated at hit time because visibility and flags
 * can change without a scene-topology change.
 */
export function isWorldGroundHitUsable(object: Object3D): boolean {
  let current: Object3D | null = object;
  while (current) {
    if (
      !current.visible ||
      current.userData?.[COLLISION_DISABLED_KEY] ||
      current.userData?.[DIRECTOR_COLLISION_DISABLED_KEY] ||
      current.userData?.[HIDE_FROM_VIEWPORT_CAPTURE_KEY] ||
      current.userData?.[GROUND_RAYCAST_DISABLED_KEY] ||
      current.userData?.directorDropPreview ||
      NON_TERRAIN_NAME.test(current.name) ||
      current.name.includes(LIVING_WORLD_NAME_MARKER)
    ) {
      return false;
    }
    const ownerKind = current.userData?.directorObjectKind;
    if (typeof ownerKind === "string" && NON_TERRAIN_OBJECT_KINDS.has(ownerKind)) return false;
    current = current.parent;
  }
  return true;
}

/**
 * Injective integer key for a quantized (x, z) cell. Valid while |x|, |z|
 * stay under ~260 km — far beyond the 1 km maximum wildlife area radius — and
 * exact in float64 (|key| < 2^40).
 */
export function worldGroundCellKey(x: number, z: number): number {
  const qx = Math.round(x / WORLD_GROUND_CELL_SIZE_M);
  const qz = Math.round(z / WORLD_GROUND_CELL_SIZE_M);
  return qx * 1_048_576 + qz;
}

/** Project-space centre of the cache cell containing (x, z). */
export function worldGroundCellCenter(value: number): number {
  return Math.round(value / WORLD_GROUND_CELL_SIZE_M) * WORLD_GROUND_CELL_SIZE_M;
}

/**
 * Mirrors how SceneRoot mounts its group: `position` then Euler-XYZ
 * `rotation` then uniform `scale`, under an identity parent. Scale is clamped
 * away from zero so the inverse stays finite.
 */
export function composeProjectToWorldMatrix(
  position: readonly [number, number, number],
  rotation: readonly [number, number, number],
  scale: number,
  target: Matrix4,
): Matrix4 {
  const safeScale = Math.abs(scale) < 1e-6 ? 1e-6 : scale;
  return target.compose(
    new Vector3(position[0], position[1], position[2]),
    new Quaternion().setFromEuler(new Euler(rotation[0], rotation[1], rotation[2], "XYZ")),
    new Vector3(safeScale, safeScale, safeScale),
  );
}

export interface WorldGroundProbe {
  /** Sample the terrain height at a project-space (x, z) position, returning null when no terrain is hit. */
  sample: WorldGroundSampler;
  /** Clear the internal cell cache so the next sample re-raycasts. */
  invalidate(): void;
  /** Cached cell count, exposed for tests and diagnostics. */
  cellCount(): number;
}

interface WorldGroundProbeOptions {
  getMeshes(): readonly Object3D[];
  /** Live matrices owned by the caller; read on every fresh raycast. */
  projectToWorld: Matrix4;
  worldToProject: Matrix4;
}

/**
 * Pure probe core (no React): quantizes to the cache grid, raycasts the cell
 * centre once, and memoizes the project-space height (NaN encodes "no hit").
 * Rays are cast at the cell centre rather than the query point so a cell has
 * one canonical value regardless of which agent touches it first.
 */
export function createWorldGroundProbe(options: WorldGroundProbeOptions): WorldGroundProbe {
  const cells = new Map<number, number>();
  const raycaster = new Raycaster();
  // three-mesh-bvh honours firstHitOnly on accelerated meshes; per-object
  // filter flags apply to whole objects, so losing an object's deeper hits is
  // safe (they would be rejected for the same reason as its first hit).
  (raycaster as Raycaster & { firstHitOnly?: boolean }).firstHitOnly = true;
  const origin = new Vector3();
  const end = new Vector3();
  const direction = new Vector3();
  const projectedHit = new Vector3();
  const intersections: Intersection[] = [];

  function raycastCell(cellX: number, cellZ: number): number {
    origin.set(cellX, WORLD_GROUND_PROBE_TOP_Y, cellZ).applyMatrix4(options.projectToWorld);
    end.set(cellX, WORLD_GROUND_PROBE_BOTTOM_Y, cellZ).applyMatrix4(options.projectToWorld);
    direction.subVectors(end, origin);
    const span = direction.length();
    if (!(span > 1e-6)) return Number.NaN;
    direction.divideScalar(span);
    raycaster.set(origin, direction);
    raycaster.near = 0;
    raycaster.far = span;
    intersections.length = 0;
    // Never raycast the scene recursively: the flat candidate list from the
    // player registry contains only real Mesh/InstancedMesh geometry (drei
    // helpers such as LineSegments2 throw without a Raycaster.camera).
    raycaster.intersectObjects(options.getMeshes() as Object3D[], false, intersections);
    for (const intersection of intersections) {
      if (!isWorldGroundHitUsable(intersection.object)) continue;
      projectedHit.copy(intersection.point).applyMatrix4(options.worldToProject);
      return projectedHit.y;
    }
    return Number.NaN;
  }

  return {
    sample(x: number, z: number): number | null {
      if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
      const key = worldGroundCellKey(x, z);
      let height = cells.get(key);
      if (height === undefined) {
        height = raycastCell(worldGroundCellCenter(x), worldGroundCellCenter(z));
        cells.set(key, height);
      }
      return Number.isNaN(height) ? null : height;
    },
    invalidate(): void {
      cells.clear();
    },
    cellCount(): number {
      return cells.size;
    },
  };
}

/** Order-sensitive FNV-style signature of the raycast candidate mesh set. */
function meshSetSignature(meshes: readonly Object3D[]): number {
  let hash = 2166136261 ^ meshes.length;
  for (const mesh of meshes) hash = Math.imul(hash ^ mesh.id, 16777619);
  return hash;
}

/**
 * Project-space terrain probe for Living World consumers.
 *
 * Returns `undefined` while the world block is disabled (every consumer stays
 * on the flat `groundHeight` plane and no per-frame work happens). When
 * enabled, the returned sampler keeps a stable identity for the lifetime of
 * the hook; invalidation clears the internal cell cache instead of swapping
 * the function, because consumers re-sample inside their own frame loops.
 *
 * Cache invalidation, in order of latency:
 * - authored edits: `project.objects` identity changes flush immediately;
 * - scene transform edits: position/rotation/scale changes rebuild matrices
 *   and flush immediately;
 * - meshes appearing/disappearing (async GLB mounts, deletions): the flat
 *   candidate-list signature flushes within one frame;
 * - anything else (animated transforms): the periodic full flush above.
 */
export function useWorldGroundSampler(): WorldGroundSampler | undefined {
  const scene = useThree((state) => state.scene);
  const enabled = useDirectorStore((state) => state.project.world?.settings.enabled === true);

  const stateRef = useRef<{
    projectToWorld: Matrix4;
    worldToProject: Matrix4;
    probe: WorldGroundProbe;
    meshes: readonly PlayerRaycastMesh[];
    transformKey: string;
    objectsIdentity: unknown;
    meshSignature: number;
    framesSinceFlush: number;
    accelerationIndex: number;
  } | null>(null);

  const state = useMemo(() => {
    if (stateRef.current) return stateRef.current;
    const projectToWorld = new Matrix4();
    const worldToProject = new Matrix4();
    const created = {
      projectToWorld,
      worldToProject,
      probe: createWorldGroundProbe({
        getMeshes: () => stateRef.current?.meshes ?? [],
        projectToWorld,
        worldToProject,
      }),
      meshes: [] as readonly PlayerRaycastMesh[],
      transformKey: "",
      objectsIdentity: null as unknown,
      meshSignature: 0,
      framesSinceFlush: 0,
      accelerationIndex: 0,
    };
    stateRef.current = created;
    return created;
  }, []);

  const refreshTransform = useCallback(() => {
    const sceneSettings = useDirectorStore.getState().project.scene;
    const key = `${sceneSettings.position.join(",")}|${sceneSettings.rotation.join(",")}|${sceneSettings.scale}`;
    if (key === state.transformKey) return false;
    state.transformKey = key;
    composeProjectToWorldMatrix(
      sceneSettings.position,
      sceneSettings.rotation,
      sceneSettings.scale,
      state.projectToWorld,
    );
    state.worldToProject.copy(state.projectToWorld).invert();
    return true;
  }, [state]);

  // Drop stale heights when the world toggles off so a re-enable starts clean.
  useEffect(() => {
    if (!enabled) state.probe.invalidate();
  }, [enabled, state]);

  useFrame(() => {
    if (!enabled) return;
    let flush = refreshTransform();

    const store = useDirectorStore.getState();
    if (store.project.objects !== state.objectsIdentity) {
      state.objectsIdentity = store.project.objects;
      flush = true;
    }

    state.meshes = getOrCollectPlayerSceneRaycastMeshes(scene);
    const signature = meshSetSignature(state.meshes);
    if (signature !== state.meshSignature) {
      state.meshSignature = signature;
      state.accelerationIndex = 0;
      flush = true;
    }

    // Share the player system's BVH prewarm (WeakSet-cached per geometry) in
    // bounded batches so a large import never stalls a single frame here.
    if (state.accelerationIndex < state.meshes.length) {
      state.accelerationIndex = acceleratePlayerSceneRaycastBatch(state.meshes, state.accelerationIndex).nextIndex;
    }

    state.framesSinceFlush += 1;
    if (flush || state.framesSinceFlush >= CACHE_FLUSH_INTERVAL_FRAMES) {
      state.probe.invalidate();
      state.framesSinceFlush = 0;
    }
  });

  const sample = useCallback<WorldGroundSampler>(
    (x, z) => {
      // Lazy fallback for samples taken before the first frame tick.
      if (state.meshes.length === 0) {
        refreshTransform();
        state.meshes = getOrCollectPlayerSceneRaycastMeshes(scene);
      }
      return state.probe.sample(x, z);
    },
    [refreshTransform, scene, state],
  );

  return enabled ? sample : undefined;
}
