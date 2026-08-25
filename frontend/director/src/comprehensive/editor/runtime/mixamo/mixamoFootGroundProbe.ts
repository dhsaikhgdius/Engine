import { Matrix3, Raycaster, Vector3, type Intersection, type Object3D } from "three";
import { getOrCollectPlayerSceneRaycastMeshesNearSegment } from "../../player/playerRaycastAcceleration";

const HIDE_FROM_VIEWPORT_CAPTURE_KEY = "hideFromViewportCapture";
const COLLISION_DISABLED_KEY = "collisionDisabled";
const DIRECTOR_COLLISION_DISABLED_KEY = "directorCollisionDisabled";
const GROUND_RAYCAST_DISABLED_KEY = "directorGroundRaycastDisabled";
const NON_WALKABLE_OBJECT_KINDS = new Set(["camera", "character", "panorama"]);
const NON_WALKABLE_NAME =
  /transformcontrols|viewport-ground-grid|panorama-backdrop|camera-frustum|frame-trajectory-overlay|drop-preview/i;

export const DEFAULT_MIXAMO_FOOT_GROUND_PROBE_CONFIG = {
  /** Enough headroom for the Stage player motor's 34 cm auto-step. */
  probeAboveFootM: 0.5,
  /** Covers a descending gait and a short ledge without selecting a lower storey. */
  probeBelowFootM: 0.85,
  /** Mirrors the player motor's 48-degree maximum climb angle. */
  minimumUpDot: Math.cos((48 * Math.PI) / 180),
} as const;

export interface MixamoFootGroundProbeResult {
  leftGroundHeightWorld: number;
  rightGroundHeightWorld: number;
  /** World normal of the accepted walkable hit; (0, 1, 0) without one. Stable instance reused across samples. */
  leftGroundNormalWorld: Vector3;
  rightGroundNormalWorld: Vector3;
  leftHit: boolean;
  rightHit: boolean;
}

export interface MixamoFootGroundProbeInput {
  sceneRoot: Object3D;
  characterRoot: Object3D;
  leftFoot?: Object3D;
  rightFoot?: Object3D;
  fallbackGroundHeightWorld: number;
  probeAboveFootM?: number;
  probeBelowFootM?: number;
  minimumUpDot?: number;
}

function isMesh(object: Object3D) {
  return "isMesh" in object && object.isMesh === true;
}

function isDescendantOf(object: Object3D, root: Object3D) {
  let current: Object3D | null = object;
  while (current) {
    if (current === root) return true;
    current = current.parent;
  }
  return false;
}

/**
 * Only scene and prop meshes are walkable. Character meshes, camera hit
 * volumes, panorama domes, transform helpers, hidden nodes, and explicit
 * no-ground-raycast nodes are ignored even when they are geometrically hit.
 */
export function isMixamoWalkableGroundHit(object: Object3D, characterRoot: Object3D) {
  if (!isMesh(object) || isDescendantOf(object, characterRoot)) return false;

  let current: Object3D | null = object;
  while (current) {
    if (
      !current.visible ||
      current.userData?.[COLLISION_DISABLED_KEY] ||
      current.userData?.[DIRECTOR_COLLISION_DISABLED_KEY] ||
      current.userData?.[HIDE_FROM_VIEWPORT_CAPTURE_KEY] ||
      current.userData?.[GROUND_RAYCAST_DISABLED_KEY] ||
      current.userData?.directorDropPreview ||
      NON_WALKABLE_NAME.test(current.name)
    ) {
      return false;
    }
    const ownerKind = current.userData?.directorObjectKind;
    if (typeof ownerKind === "string" && NON_WALKABLE_OBJECT_KINDS.has(ownerKind)) return false;
    current = current.parent;
  }
  return true;
}

/**
 * Two independent downward probes for runtime foot locking. The returned
 * record, all vector/matrix scratch values, and the optional Raycaster result
 * array remain stable for the lifetime of the character.
 *
 * Each foot reports the scalar height of its independently sampled surface
 * plus the world normal of that surface, so the ankle slope-alignment pass can
 * match the sole to an incline. Without a walkable hit the normal is up.
 */
export class MixamoFootGroundProbe {
  private readonly raycaster = new Raycaster();
  private readonly rayOrigin = new Vector3();
  private readonly rayEnd = new Vector3();
  private readonly rayDirection = new Vector3(0, -1, 0);
  private readonly footWorld = new Vector3();
  private readonly worldNormal = new Vector3();
  private readonly normalMatrix = new Matrix3();
  private readonly intersections: Intersection[] = [];
  private readonly result: MixamoFootGroundProbeResult = {
    leftGroundHeightWorld: 0,
    rightGroundHeightWorld: 0,
    leftGroundNormalWorld: new Vector3(0, 1, 0),
    rightGroundNormalWorld: new Vector3(0, 1, 0),
    leftHit: false,
    rightHit: false,
  };

  constructor() {
    (this.raycaster as Raycaster & { firstHitOnly?: boolean }).firstHitOnly = true;
  }

  sample(input: MixamoFootGroundProbeInput): MixamoFootGroundProbeResult {
    const fallback = Number.isFinite(input.fallbackGroundHeightWorld) ? input.fallbackGroundHeightWorld : 0;
    const left = this.sampleFoot(input.leftFoot, input, fallback, this.result.leftGroundNormalWorld);
    this.result.leftGroundHeightWorld = left.height;
    this.result.leftHit = left.hit;
    const right = this.sampleFoot(input.rightFoot, input, fallback, this.result.rightGroundNormalWorld);
    this.result.rightGroundHeightWorld = right.height;
    this.result.rightHit = right.hit;
    return this.result;
  }

  private readonly footResult = { height: 0, hit: false };

  private sampleFoot(
    foot: Object3D | undefined,
    input: MixamoFootGroundProbeInput,
    fallbackGroundHeightWorld: number,
    // The shared footResult scratch cannot carry per-foot vectors safely, so
    // the normal is written straight into the caller's stable result slot.
    groundNormalWorld: Vector3,
  ) {
    this.footResult.height = fallbackGroundHeightWorld;
    this.footResult.hit = false;
    groundNormalWorld.set(0, 1, 0);
    if (!foot) return this.footResult;

    foot.getWorldPosition(this.footWorld);
    const probeAboveFootM = Math.max(
      0.01,
      input.probeAboveFootM ?? DEFAULT_MIXAMO_FOOT_GROUND_PROBE_CONFIG.probeAboveFootM,
    );
    const probeBelowFootM = Math.max(
      0.01,
      input.probeBelowFootM ?? DEFAULT_MIXAMO_FOOT_GROUND_PROBE_CONFIG.probeBelowFootM,
    );
    const minimumUpDot = Math.min(
      1,
      Math.max(-1, input.minimumUpDot ?? DEFAULT_MIXAMO_FOOT_GROUND_PROBE_CONFIG.minimumUpDot),
    );

    const originY = this.footWorld.y + probeAboveFootM;
    // Always reach the flat-stage fallback while limiting lower-floor hits.
    const lowestY = Math.min(this.footWorld.y - probeBelowFootM, fallbackGroundHeightWorld - 0.02);
    this.rayOrigin.set(this.footWorld.x, originY, this.footWorld.z);
    this.rayEnd.set(this.footWorld.x, lowestY, this.footWorld.z);
    this.raycaster.set(this.rayOrigin, this.rayDirection);
    this.raycaster.near = 0;
    this.raycaster.far = Math.max(0.01, originY - lowestY);
    this.intersections.length = 0;
    // Never recursively raycast the whole R3F scene. drei camera frusta use
    // LineSegments2, whose raycast requires Raycaster.camera and throws during
    // a world-space foot probe. The cached candidate list contains only real
    // Mesh/InstancedMesh geometry and is shared with the BVH prewarm path.
    this.raycaster.intersectObjects(
      getOrCollectPlayerSceneRaycastMeshesNearSegment(input.sceneRoot, this.rayOrigin, this.rayEnd, 0.05),
      false,
      this.intersections,
    );

    for (const intersection of this.intersections) {
      if (!intersection.face || !isMixamoWalkableGroundHit(intersection.object, input.characterRoot)) continue;
      this.normalMatrix.getNormalMatrix(intersection.object.matrixWorld);
      this.worldNormal.copy(intersection.face.normal).applyNormalMatrix(this.normalMatrix);
      if (this.worldNormal.y < minimumUpDot) continue;
      this.footResult.height = intersection.point.y;
      this.footResult.hit = true;
      groundNormalWorld.copy(this.worldNormal);
      break;
    }
    return this.footResult;
  }
}
