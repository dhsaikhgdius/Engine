import { Raycaster, Vector3, type Intersection, type Object3D } from "three";
import { clamp } from "../../../../../../packages/protocol/src/primitives";

const HIDE_FROM_VIEWPORT_CAPTURE_KEY = "hideFromViewportCapture";
const NON_OCCLUDING_DIRECTOR_KINDS = new Set(["camera", "character", "panorama"]);

/** Default radius of the near-plane footprint in the horizontal plane (meters). */
const DEFAULT_CAMERA_PROBE_RADIUS = 0.14;

/** Default radius of the near-plane footprint in the vertical direction (meters). */
const DEFAULT_CAMERA_VERTICAL_PROBE_RADIUS = 0.1;

/** Five-sample cross pattern for the near-plane probe: center plus four cardinals. */
const CAMERA_PROBE_SAMPLES: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

function isVisibleMesh(object: Object3D) {
  if (!("isMesh" in object) || !object.isMesh) return false;

  let current: Object3D | null = object;
  while (current) {
    if (!current.visible || current.userData?.[HIDE_FROM_VIEWPORT_CAPTURE_KEY]) return false;
    current = current.parent;
  }

  return true;
}

/**
 * Character locomotion uses lightweight Rapier proxies for actor-to-actor
 * contact. The follow camera must not also recurse through an animated
 * character's full render hierarchy: `SkinnedMesh.raycast` is intentionally
 * not BVH-accelerated and becomes a large frame-time spike when two actors
 * stand close enough for the near-plane probes to enter the second rig.
 *
 * Keep camera obstruction on static scene geometry. Characters still collide
 * physically through the motor, while walking up to another actor no longer
 * performs five exact skinned-mesh raycasts per rendered frame.
 */
export function isPlayerCameraCollisionRoot(object: Object3D) {
  let current: Object3D | null = object;
  while (current) {
    const kind = current.userData?.directorObjectKind;
    if (typeof kind === "string" && NON_OCCLUDING_DIRECTOR_KINDS.has(kind)) return false;
    if (!current.visible || current.userData?.[HIDE_FROM_VIEWPORT_CAPTURE_KEY]) return false;
    current = current.parent;
  }
  return true;
}

/**
 * Allocation-free camera obstruction probe. Five parallel rays approximate
 * the camera's near-plane footprint so thin edges do not clip into view.
 */
export class PlayerCameraCollisionProbe {
  private readonly raycaster = new Raycaster();
  private readonly rayDirection = new Vector3();
  private readonly rayOrigin = new Vector3();
  private readonly rayTarget = new Vector3();
  private readonly sampleOffset = new Vector3();
  private readonly intersections: Intersection[] = [];

  constructor() {
    // three-mesh-bvh can stop at the nearest triangle inside each candidate;
    // intersectObjects still compares those candidates to preserve the exact
    // nearest world hit.
    (this.raycaster as Raycaster & { firstHitOnly?: boolean }).firstHitOnly = true;
  }

  /**
   * Computes the closest collision-safe distance along the look axis using a
   * five-sample near-plane probe. Returns the unclamped desired distance when
   * there are no colliders or the separation is negligible.
   *
   * @param target - The world-space point the camera is looking at.
   * @param desiredPosition - The world-space position the camera would occupy
   *  without any obstruction.
   * @param right - The camera's right vector (unit length).
   * @param up - The camera's up vector (unit length).
   * @param colliders - Flat set of static meshes to test against.
   * @param clearance - How far to pull the camera back from a hit surface.
   * @param minimumNearDistance - Smallest renderable camera distance (normally
   *  the camera near plane).
   * @param probeRadius - Horizontal radius of the near-plane footprint.
   * @param verticalProbeRadius - Vertical radius of the near-plane footprint.
   * @returns The collision-safe distance from target, clamped between
   *  minimumNearDistance and the desired distance.
   */
  getSafeDistance({
    target,
    desiredPosition,
    right,
    up,
    colliders,
    clearance,
    minimumNearDistance,
    probeRadius = DEFAULT_CAMERA_PROBE_RADIUS,
    verticalProbeRadius = DEFAULT_CAMERA_VERTICAL_PROBE_RADIUS,
  }: {
    target: Vector3;
    desiredPosition: Vector3;
    right: Vector3;
    up: Vector3;
    colliders: Object3D[];
    clearance: number;
    minimumNearDistance: number;
    probeRadius?: number;
    verticalProbeRadius?: number;
  }) {
    const desiredDistance = target.distanceTo(desiredPosition);
    if (desiredDistance <= 0.0001 || colliders.length === 0) return desiredDistance;

    const safeClearance = Math.max(0, clearance);
    let safeDistance = desiredDistance;
    for (const [horizontalSample, verticalSample] of CAMERA_PROBE_SAMPLES) {
      this.sampleOffset
        .copy(right)
        .multiplyScalar(horizontalSample * probeRadius)
        .addScaledVector(up, verticalSample * verticalProbeRadius);
      // The probe radius models the near plane, which lives at the camera end
      // of the ray. Offsetting the origin as well made side samples start
      // inside whatever wall the player was hugging (killing that sample) and
      // pulled the camera in for thin props near the look target that could
      // never clip the near plane in the first place.
      this.rayOrigin.copy(target);
      this.rayTarget.copy(desiredPosition).add(this.sampleOffset);
      this.rayDirection.copy(this.rayTarget).sub(this.rayOrigin);
      const rayLength = this.rayDirection.length();
      if (rayLength <= 0.0001) continue;

      this.rayDirection.multiplyScalar(1 / rayLength);
      this.raycaster.set(this.rayOrigin, this.rayDirection);
      this.raycaster.near = 0.01;
      // Probe past the desired position by the clearance. Ending the ray at
      // the desired position made the safe distance jump by `clearance` the
      // moment a wall face crossed that boundary, which showed up as the
      // camera visibly popping while backing toward a wall. Hits inside
      // (rayLength, rayLength + clearance] now contract the rig continuously.
      this.raycaster.far = rayLength + safeClearance;
      this.intersections.length = 0;
      // PlayerController supplies a versioned flat static-mesh set. Recursive
      // raycasts here would re-enter imported hierarchies and animated rigs on
      // every near-plane sample.
      this.raycaster.intersectObjects(colliders, false, this.intersections);

      for (const intersection of this.intersections) {
        if (!isVisibleMesh(intersection.object)) continue;
        safeDistance = Math.min(safeDistance, intersection.distance - safeClearance);
        break;
      }
    }

    // The preferred follow minimum is not a collision-safe lower bound. If an
    // obstacle is closer than that value, forcing the camera back out to the
    // preference puts it inside or behind the obstacle. Allow an obstructed rig
    // to contract all the way to the renderable near distance; PlayerController
    // hides the character at close range so this remains visually stable.
    return clamp(safeDistance, Math.min(minimumNearDistance, desiredDistance), desiredDistance);
  }
}
