import { Euler, Matrix3, Matrix4, Plane, Quaternion, Ray, Vector3 } from "three";
import type { DirectorObject } from "../schema/directorProject";
import { getDirectorPrimitiveMetrics } from "@director/project-schema";

const WALKABLE_UP_DOT = Math.cos((48 * Math.PI) / 180);
const SUPPORT_CONTACT_EPSILON_M = 0.025;
/** Matches the character motor's step plus ground-snap reach. */
export const DIRECTOR_SUPPORT_RAISE_LIMIT_M = 0.64;
const EXPLICIT_SUPPORT_RAISE_LIMIT_M = 5;
/**
 * The precise footprint test carries a 1e-4 local-space slack (baked into
 * halfWidth/halfDepth below), so the cached world XZ bounds inherit that same
 * margin through the projected corners. This extra absolute pad only absorbs
 * floating-point round-off between the forward corner projection and the
 * inverse-matrix hit transform, keeping the cheap rejection strictly
 * conservative: it may pass a point the precise test rejects, never the
 * reverse.
 */
const SUPPORT_BOUNDS_PADDING_M = 1e-3;
/**
 * The cylinder footprint accepts (x/hw)^2 + (z/hd)^2 <= 1 + 1e-4, so its
 * circumscribed local box must be inflated by sqrt(1 + 1e-4) as well.
 */
const CYLINDER_BOUNDS_SCALE = Math.sqrt(1 + 1e-4);

/**
 * Result of a physical foot-pivot placement query for a single character.
 *
 * The height is the world-space Y coordinate where the character's floor pivot
 * should rest. When `supportObjectId` is null, the character rests on the
 * ground plane; otherwise it rests on the identified support primitive.
 */
export interface DirectorSupportContact {
  /** World-space Y coordinate of the walkable surface directly under the character's foot pivot. */
  height: number;
  /** ID of the support primitive the character rests on, or `null` for the ground plane. */
  supportObjectId: string | null;
}

function isPhysicalPlacementCandidate(object: DirectorObject) {
  const mode = object.placementMode ?? "auto";
  return (
    object.kind === "character" && object.visible && mode !== "floating" && mode !== "attached" && mode !== "suspended"
  );
}

/**
 * Mirrors the per-support skip conditions of the original scan: only visible
 * box/cylinder primitives that are not characters, cameras, panoramas, or
 * composite parents can ever return a support height, so everything else is
 * filtered out once per resolve instead of once per character.
 */
function isSupportSurfaceCandidate(object: DirectorObject) {
  return (
    object.visible &&
    object.kind !== "character" &&
    object.kind !== "camera" &&
    object.kind !== "panorama" &&
    !object.isCompositeParent &&
    (object.geometryType === "box" || object.geometryType === "cylinder")
  );
}

interface WalkableSupportSurface {
  walkable: true;
  isBox: boolean;
  /** Composed local-to-world matrix of the support primitive. */
  matrix: Matrix4;
  /** Normalized world-space normal of the walkable top face. */
  normal: Vector3;
  /** Infinite plane through the top face; the footprint test bounds it. */
  plane: Plane;
  inverseMatrix: Matrix4;
  halfWidth: number;
  halfDepth: number;
  /** Conservative world-space XZ bounds of the slack-inflated footprint. */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

type SupportSurface = WalkableSupportSurface | { walkable: false };

const NOT_WALKABLE: SupportSurface = { walkable: false };

/**
 * Derived support geometry per object snapshot. Director objects are immutable
 * store data with structural sharing: any transform (or other field) edit
 * replaces the whole object reference, so keying this cache by reference can
 * never serve stale math, and entries are garbage-collected together with the
 * snapshots they describe. Static supports therefore reuse their matrices,
 * plane, and bounds across every timeline playback frame.
 */
const supportSurfaceCache = new WeakMap<DirectorObject, SupportSurface>();

const scratchCorner = new Vector3();
/** Downward probe reused across queries; the direction is never mutated. */
const scratchRay = new Ray(new Vector3(), new Vector3(0, -1, 0));
const scratchHit = new Vector3();

function computeSupportSurface(support: DirectorObject): SupportSurface {
  if (support.geometryType !== "box" && support.geometryType !== "cylinder") return NOT_WALKABLE;

  const metrics = getDirectorPrimitiveMetrics(support.geometryType);
  const matrix = new Matrix4().compose(
    new Vector3(...support.transform.position),
    new Quaternion().setFromEuler(new Euler(...support.transform.rotation, "XYZ")),
    new Vector3(...support.transform.scale),
  );
  const normal = new Vector3(0, 1, 0).applyNormalMatrix(new Matrix3().getNormalMatrix(matrix)).normalize();
  if (normal.y < WALKABLE_UP_DOT) return NOT_WALKABLE;

  const topPoint = new Vector3(0, metrics.size[1], 0).applyMatrix4(matrix);
  const plane = new Plane().setFromNormalAndCoplanarPoint(normal, topPoint);
  const halfWidth = metrics.size[0] / 2 + 1e-4;
  const halfDepth = metrics.size[2] / 2 + 1e-4;
  const isBox = support.geometryType === "box";

  // A vertical probe hits the top plane at the query's exact XZ, so the world
  // XZ bounds of the top face bound every acceptable query. Project the four
  // slack-inflated top-face corners; a cylinder uses the circumscribed box of
  // its tolerance-inflated ellipse.
  const boundsHalfWidth = isBox ? halfWidth : halfWidth * CYLINDER_BOUNDS_SCALE;
  const boundsHalfDepth = isBox ? halfDepth : halfDepth * CYLINDER_BOUNDS_SCALE;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const cornerX of [-boundsHalfWidth, boundsHalfWidth]) {
    for (const cornerZ of [-boundsHalfDepth, boundsHalfDepth]) {
      scratchCorner.set(cornerX, metrics.size[1], cornerZ).applyMatrix4(matrix);
      minX = Math.min(minX, scratchCorner.x);
      maxX = Math.max(maxX, scratchCorner.x);
      minZ = Math.min(minZ, scratchCorner.z);
      maxZ = Math.max(maxZ, scratchCorner.z);
    }
  }

  return {
    walkable: true,
    isBox,
    matrix,
    normal,
    plane,
    inverseMatrix: matrix.clone().invert(),
    halfWidth,
    halfDepth,
    minX: minX - SUPPORT_BOUNDS_PADDING_M,
    maxX: maxX + SUPPORT_BOUNDS_PADDING_M,
    minZ: minZ - SUPPORT_BOUNDS_PADDING_M,
    maxZ: maxZ + SUPPORT_BOUNDS_PADDING_M,
  };
}

function getSupportSurface(support: DirectorObject): SupportSurface {
  let surface = supportSurfaceCache.get(support);
  if (!surface) {
    surface = computeSupportSurface(support);
    supportSurfaceCache.set(support, surface);
  }
  return surface;
}

function getSupportHeightAt(
  surface: SupportSurface,
  x: number,
  z: number,
  referenceY: number,
  maximumRaise: number,
): number | null {
  if (!surface.walkable) return null;
  // Cheap world-space rejection before any ray or matrix math.
  if (x < surface.minX || x > surface.maxX || z < surface.minZ || z > surface.maxZ) return null;

  scratchRay.origin.set(x, referenceY + maximumRaise + 0.01, z);
  const hit = scratchRay.intersectPlane(surface.plane, scratchHit);
  if (!hit) return null;
  if (hit.y < referenceY - SUPPORT_CONTACT_EPSILON_M || hit.y > referenceY + maximumRaise) return null;

  // Read the world height first: applyMatrix4 rewrites the shared scratch hit
  // vector in place when deriving the local-space footprint coordinates.
  const worldHeight = hit.y;
  const localHit = hit.applyMatrix4(surface.inverseMatrix);
  const insideFootprint = surface.isBox
    ? Math.abs(localHit.x) <= surface.halfWidth && Math.abs(localHit.z) <= surface.halfDepth
    : (localHit.x / surface.halfWidth) ** 2 + (localHit.z / surface.halfDepth) ** 2 <= 1 + 1e-4;
  return insideFootprint ? worldHeight : null;
}

function getSupportContactWithCandidates(
  object: DirectorObject,
  supportCandidates: readonly DirectorObject[],
  groundHeight: number,
  groundEnabled: boolean,
): DirectorSupportContact | null {
  if (!isPhysicalPlacementCandidate(object)) return null;
  const [x, referenceY, z] = object.transform.position;
  const maximumRaise =
    object.placementMode === "supported" ? EXPLICIT_SUPPORT_RAISE_LIMIT_M : DIRECTOR_SUPPORT_RAISE_LIMIT_M;
  let best: DirectorSupportContact | null =
    groundEnabled && groundHeight >= referenceY - SUPPORT_CONTACT_EPSILON_M && groundHeight <= referenceY + maximumRaise
      ? { height: groundHeight, supportObjectId: null }
      : null;

  for (const support of supportCandidates) {
    if (support.id === object.id) continue;
    const height = getSupportHeightAt(getSupportSurface(support), x, z, referenceY, maximumRaise);
    // Strictly greater keeps the original tie-break: among equal heights the
    // support that appears earliest in scene order wins.
    if (height === null || (best && height <= best.height)) continue;
    best = { height, supportObjectId: support.id };
  }
  return best;
}

/**
 * Finds a real walkable surface that intersects a character's authored foot
 * pivot. It only raises a penetrating character; airborne animation remains
 * airborne and is never pulled down to the floor.
 */
export function getDirectorSupportContact(
  object: DirectorObject,
  objects: readonly DirectorObject[],
  groundHeight: number,
  groundEnabled = true,
): DirectorSupportContact | null {
  if (!isPhysicalPlacementCandidate(object)) return null;
  return getSupportContactWithCandidates(
    object,
    objects.filter(isSupportSurfaceCandidate),
    groundHeight,
    groundEnabled,
  );
}

/**
 * Applies the physical foot-pivot contract to frame-evaluated objects. The
 * returned objects are cloned only when a correction is actually required.
 *
 * Identity contract: when no object needs a correction the exact input array
 * reference is returned (not a copy), so referential-equality consumers such
 * as SceneRoot's downstream useMemo chain skip rebuilding entirely on static
 * playback frames.
 */
export function resolveDirectorPhysicalPlacements(
  objects: readonly DirectorObject[],
  groundHeight: number,
  groundEnabled = true,
): DirectorObject[] {
  const hasPlacementCandidate = objects.some(isPhysicalPlacementCandidate);
  const supportCandidates = hasPlacementCandidate ? objects.filter(isSupportSurfaceCandidate) : [];
  // Fast path: with no character to place, or nothing it could possibly rest
  // on (no support primitive and no ground plane), no correction can happen.
  // The ground plane alone can still raise characters, so an empty support
  // list only short-circuits when the ground is disabled too.
  if (!hasPlacementCandidate || (!groundEnabled && supportCandidates.length === 0)) {
    return objects as DirectorObject[];
  }

  let corrected: DirectorObject[] | null = null;
  for (let index = 0; index < objects.length; index += 1) {
    const object = objects[index];
    const contact = getSupportContactWithCandidates(object, supportCandidates, groundHeight, groundEnabled);
    const next: DirectorObject =
      !contact || contact.height <= object.transform.position[1] + 1e-5
        ? object
        : {
            ...object,
            transform: {
              ...object.transform,
              position: [object.transform.position[0], contact.height, object.transform.position[2]],
            },
          };
    if (corrected) {
      corrected.push(next);
    } else if (next !== object) {
      corrected = objects.slice(0, index);
      corrected.push(next);
    }
  }
  return corrected ?? (objects as DirectorObject[]);
}
