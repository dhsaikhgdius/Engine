import { clamp } from "../../../../../../packages/protocol/src/primitives";
import playerDefaults from "./playerDefaults.json";

/**
 * Director play-mode locomotion and third-person follow camera math.
 *
 * Values are authored at a 6.8 m reference hero height and scaled into
 * Director's metre-based stage through {@link getScaledPlayerConfig}.
 */

/** Reference hero target height used to author follow and locomotion defaults. */
export const CHARACTER_REFERENCE_HEIGHT = 6.8;

/** Default authored hero height in Director metre space (matches Mixamo scale target). */
export const DIRECTOR_DEFAULT_CHARACTER_HEIGHT = 1.78;

/** Default hero locomotion tuning at the reference height. */
export const HERO_LOCOMOTION_DEFAULTS = playerDefaults.heroLocomotion;

/** Default third-person follow camera tuning at the reference height. */
export const FOLLOW_CAMERA_DEFAULTS = playerDefaults.followCamera;

/** Camera mode governing orbit, pitch clamping, and visibility rules. */
export type FollowCameraMode = "first-person" | "third-person" | "isometric";

/** Locomotion and follow-camera tuning scaled to a specific character height. */
export type ScaledPlayerConfig = {
  walkSpeed: number;
  runSpeed: number;
  acceleration: number;
  decelerationAcceleration: number;
  playerRadius: number;
  cameraDistance: number;
  cameraMinDistance: number;
  cameraMaxDistance: number;
  cameraLookHeight: number;
  cameraLookAtHeight: number;
  cameraFollowHeight: number;
  cameraTargetLead: number;
  cameraShoulderOffset: number;
  cameraZoomStep: number;
  cameraHidePlayerDistance: number;
  followSmoothing: number;
  pointerSensitivity: number;
  verticalDeadband: number;
  verticalSnapDistance: number;
  verticalWalkLambda: number;
  verticalIdleLambda: number;
  occlusionPadding: number;
  occlusionMinDistance: number;
  occlusionTargetClearanceMin: number;
  occlusionTargetClearanceRatio: number;
  cameraGroundClearance: number;
  cameraGroundSoftness: number;
};

/** Input to the planar obstacle solver used by the legacy locomotion path. */
export type PlanarObstacle = {
  id?: string;
  position: [number, number, number];
  radius?: number;
  halfX?: number;
  halfZ?: number;
  rotationY?: number;
};

const LOCOMOTION_CAMERA_STABLE_STATES = new Set([
  "walkForward",
  "walkBack",
  "walkLeft",
  "walkRight",
  "runForward",
  "runBack",
  "runLeft",
  "runRight",
]);

/**
 * Converts a reference-space authored value to character-scale metres.
 *
 * @param value - The reference-space value (authored at {@link CHARACTER_REFERENCE_HEIGHT}).
 * @param characterHeight - The current character's height in Director metres.
 * @returns The value scaled to the character's actual height.
 */
function scaleReferenceLength(value: number, characterHeight: number) {
  return value * (characterHeight / CHARACTER_REFERENCE_HEIGHT);
}

/**
 * Upper bound for a single follow-camera integration step.
 *
 * Browser tabs can resume with a multi-second frame delta. Treating that as a
 * normal render frame makes every damped value jump to its target and is the
 * source of an otherwise very visible follow-camera hitch.
 */
export const FOLLOW_CAMERA_MAX_DELTA_SECONDS = 0.1;

/**
 * Returns the finite frame interval used by every follow-camera damper.
 * Invalid and reversed time never advances the simulation; long hitches are
 * capped so resuming a background tab remains controlled.
 */
export function sanitizeFollowDelta(delta: number) {
  if (!Number.isFinite(delta) || delta <= 0) return 0;
  return Math.min(delta, FOLLOW_CAMERA_MAX_DELTA_SECONDS);
}

/**
 * Wraps an angle into the range (-π, π].
 *
 * @param angle - Any finite angle in radians.
 * @returns The equivalent angle in (-π, π].
 */
export function wrapAngle(angle: number) {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

/**
 * Exponentially damps a scalar toward a target. The damping rate lambda is
 * measured in s⁻¹; a larger value reaches the target faster.
 *
 * @param current - The current damped value.
 * @param target - The value to approach asymptotically.
 * @param lambda - Damping rate (s⁻¹).
 * @param delta - The frame interval in seconds.
 * @returns The next damped value.
 */
export function dampScalar(current: number, target: number, lambda: number, delta: number) {
  return current + (target - current) * (1 - Math.exp(-lambda * sanitizeFollowDelta(delta)));
}

/**
 * Exponentially damps a wrapped angle toward a target. The shorter arc is
 * always taken, so -π and π are treated as the same direction.
 *
 * @param current - The current damped angle in radians.
 * @param target - The target angle in radians.
 * @param lambda - Damping rate (s⁻¹).
 * @param delta - The frame interval in seconds.
 * @returns The next damped angle, wrapped to (-π, π].
 */
export function dampAngle(current: number, target: number, lambda: number, delta: number) {
  const deltaAngle = wrapAngle(target - current);
  return wrapAngle(current + deltaAngle * (1 - Math.exp(-lambda * sanitizeFollowDelta(delta))));
}

/**
 * Softly keeps a desired camera height above the terrain safety floor.
 *
 * This is the numerically stable softplus floor used by awplanet's follow rig:
 * it is monotonic, never drops below `floor`, and approaches an ordinary hard
 * floor far below the terrain without introducing a discontinuity near it.
 */
export function smoothCameraGroundFloor(value: number, floor: number, softness: number) {
  const safeSoftness = Number.isFinite(softness) ? Math.max(0, softness) : 0;
  if (safeSoftness === 0) return Math.max(value, floor);
  const normalized = (value - floor) / safeSoftness;
  if (normalized > 18) return value;
  if (normalized < -18) return floor;
  return floor + Math.log1p(Math.exp(normalized)) * safeSoftness;
}

/**
 * Decomposes a view pitch value into horizontal and vertical orbit scaling
 * factors. The 0.82 constant is a tunable mapping from the raw pitch trackball
 * to actual orbit tilt, matching the feel of the awplanet follow rig.
 *
 * @param viewPitch - The raw view pitch trackball value.
 * @param mode - The current follow-camera mode.
 * @returns The horizontal and vertical orbit scale for the pitch.
 */
export function getPitchOrbit(viewPitch: number, mode: FollowCameraMode) {
  const pitchAngle = Math.atan(viewPitch * 0.82);
  const minHorizontalScale = mode === "third-person" || mode === "isometric" ? 0.08 : 0.34;
  return {
    horizontalScale: Math.max(minHorizontalScale, Math.cos(pitchAngle)),
    verticalScale: Math.sin(pitchAngle),
  };
}

/**
 * Returns the scale factor from the authored Director default character height
 * to a given character height.
 *
 * @param characterHeight - The character's actual height in Director metres.
 * @param referenceHeight - The reference height to scale from.
 * @returns The multiplicative scale factor.
 */
export function getCharacterScaleFactor(characterHeight: number, referenceHeight = DIRECTOR_DEFAULT_CHARACTER_HEIGHT) {
  return characterHeight / referenceHeight;
}

/**
 * Produces a full locomotion and camera config scaled from the reference
 * 6.8 m hero height to the actual character height. Distance-based values are
 * scaled linearly; damping rates (s⁻¹) are used as-authored.
 *
 * @param characterHeight - The character's actual height in Director metres.
 * @param shoulderOffset - A lateral camera shoulder offset in metres.
 * @returns The scaled player configuration.
 */
export function getScaledPlayerConfig(
  characterHeight = DIRECTOR_DEFAULT_CHARACTER_HEIGHT,
  shoulderOffset = 0,
): ScaledPlayerConfig {
  const scale = (value: number) => scaleReferenceLength(value, characterHeight);
  return {
    walkSpeed: scale(HERO_LOCOMOTION_DEFAULTS.walkSpeed),
    runSpeed: scale(HERO_LOCOMOTION_DEFAULTS.runSpeed),
    // These are exponential damping rates (s^-1), not authored distances.
    // Scaling them with character height makes a normal 1.78 m actor take
    // roughly four times longer to start and stop than the 6.8 m reference.
    acceleration: HERO_LOCOMOTION_DEFAULTS.acceleration,
    decelerationAcceleration: HERO_LOCOMOTION_DEFAULTS.deceleration,
    playerRadius: scale(HERO_LOCOMOTION_DEFAULTS.colliderRadius),
    cameraDistance: scale(FOLLOW_CAMERA_DEFAULTS.followDistance),
    cameraMinDistance: scale(FOLLOW_CAMERA_DEFAULTS.minDistance),
    cameraMaxDistance: scale(FOLLOW_CAMERA_DEFAULTS.maxDistance),
    cameraLookHeight: characterHeight * 0.86,
    cameraLookAtHeight: scale(FOLLOW_CAMERA_DEFAULTS.lookHeight),
    cameraFollowHeight: scale(FOLLOW_CAMERA_DEFAULTS.followHeight),
    cameraTargetLead: scale(FOLLOW_CAMERA_DEFAULTS.targetLead),
    cameraShoulderOffset: shoulderOffset,
    cameraZoomStep: scale(FOLLOW_CAMERA_DEFAULTS.zoomStep),
    cameraHidePlayerDistance:
      scale(FOLLOW_CAMERA_DEFAULTS.minDistance) + characterHeight * FOLLOW_CAMERA_DEFAULTS.hidePlayerDistanceRatio,
    followSmoothing: FOLLOW_CAMERA_DEFAULTS.followSmoothing,
    pointerSensitivity: FOLLOW_CAMERA_DEFAULTS.pointerSensitivity,
    verticalDeadband: scale(FOLLOW_CAMERA_DEFAULTS.verticalDeadband),
    verticalSnapDistance: scale(FOLLOW_CAMERA_DEFAULTS.verticalSnapDistance),
    verticalWalkLambda: FOLLOW_CAMERA_DEFAULTS.verticalWalkLambda,
    verticalIdleLambda: FOLLOW_CAMERA_DEFAULTS.verticalIdleLambda,
    occlusionPadding: scale(FOLLOW_CAMERA_DEFAULTS.occlusionPadding),
    occlusionMinDistance: scale(FOLLOW_CAMERA_DEFAULTS.occlusionMinDistance),
    occlusionTargetClearanceMin: scale(FOLLOW_CAMERA_DEFAULTS.occlusionTargetClearanceMin),
    occlusionTargetClearanceRatio: FOLLOW_CAMERA_DEFAULTS.occlusionTargetClearanceRatio,
    cameraGroundClearance: scale(FOLLOW_CAMERA_DEFAULTS.groundClearance),
    cameraGroundSoftness: scale(FOLLOW_CAMERA_DEFAULTS.groundSoftness),
  };
}

/**
 * Resolves a desired planar movement against circular and box obstacles with
 * per-axis sliding. If the desired position is blocked, the X-only and Z-only
 * components are each tried independently; the first that clears wins.
 *
 * @param currentPosition - The actor's current world position.
 * @param desiredPosition - The intended next world position.
 * @param obstacles - Planar obstacles to test against.
 * @param radius - The character's collision radius.
 * @returns The resolved position, which may be unchanged if fully blocked.
 */
export function resolveCharacterMovement({
  currentPosition,
  desiredPosition,
  obstacles,
  radius,
}: {
  currentPosition: [number, number, number];
  desiredPosition: [number, number, number];
  obstacles: PlanarObstacle[];
  radius: number;
}): [number, number, number] {
  if (canOccupyPosition(desiredPosition, obstacles, radius)) {
    return desiredPosition;
  }

  const slideX: [number, number, number] = [desiredPosition[0], desiredPosition[1], currentPosition[2]];
  if (canOccupyPosition(slideX, obstacles, radius)) {
    return slideX;
  }

  const slideZ: [number, number, number] = [currentPosition[0], desiredPosition[1], desiredPosition[2]];
  if (canOccupyPosition(slideZ, obstacles, radius)) {
    return slideZ;
  }

  return [currentPosition[0], desiredPosition[1], currentPosition[2]];
}

function canOccupyPosition(position: [number, number, number], obstacles: PlanarObstacle[], radius: number) {
  return !obstacles.some((obstacle) => collidesWithObstacle(position, obstacle, radius));
}

function collidesWithObstacle(position: [number, number, number], obstacle: PlanarObstacle, radius: number) {
  if (obstacle.radius) {
    const distance = Math.hypot(position[0] - obstacle.position[0], position[2] - obstacle.position[2]);
    return distance < obstacle.radius + radius;
  }

  const halfX = obstacle.halfX ?? 0.5;
  const halfZ = obstacle.halfZ ?? 0.5;
  const rotationY = obstacle.rotationY ?? 0;
  const dx = position[0] - obstacle.position[0];
  const dz = position[2] - obstacle.position[2];
  // World -> obstacle-local is the inverse yaw rotation R_y(-rotationY). The
  // planar form of R_y(theta) is [x cos + z sin, -x sin + z cos], so the
  // inverse is [x cos - z sin, x sin + z cos]. This matches the box solver in
  // playerLocomotion.ts; negating the angle *and* using the inverse formula
  // mirrored the footprint of every yawed box.
  const cos = Math.cos(rotationY);
  const sin = Math.sin(rotationY);
  const localX = dx * cos - dz * sin;
  const localZ = dx * sin + dz * cos;
  return Math.abs(localX) <= halfX + radius && Math.abs(localZ) <= halfZ + radius;
}

/** The resolved camera position, look-at point, and orientation axes. */
export type ThirdPersonCameraPose = {
  position: [number, number, number];
  lookAt: [number, number, number];
  forward: [number, number, number];
  right: [number, number, number];
  up: [number, number, number];
};

export type FollowCameraReferenceFrame = {
  /** The scene-local +Z character-forward axis expressed in world space. */
  forward: [number, number, number];
  /** The scene-local +X axis expressed in world space. */
  right: [number, number, number];
  /** The scene-local +Y axis expressed in world space. */
  up: [number, number, number];
};

const DEFAULT_FOLLOW_CAMERA_REFERENCE_FRAME: FollowCameraReferenceFrame = {
  forward: [0, 0, 1],
  right: [1, 0, 0],
  up: [0, 1, 0],
};

function normalizeVector3(vector: [number, number, number], fallback: [number, number, number]) {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  if (!Number.isFinite(length) || length < 0.000001) return [...fallback] as [number, number, number];
  return vector.map((value) => value / length) as [number, number, number];
}

function addScaledVector3(target: [number, number, number], vector: [number, number, number], scale: number) {
  target[0] += vector[0] * scale;
  target[1] += vector[1] * scale;
  target[2] += vector[2] * scale;
  return target;
}

/**
 * Computes the full third-person follow-camera pose from the actor's position,
 * orbit angles, and follow tuning. The camera is positioned behind and above
 * the actor according to the view yaw and pitch, with optional lateral offset.
 *
 * @param targetPosition - The actor's world position.
 * @param viewYaw - The horizontal orbit angle in radians.
 * @param viewPitch - The vertical orbit trackball value.
 * @param distance - The desired follow distance in metres.
 * @param followHeight - The vertical offset from the target to the camera pivot.
 * @param lookHeight - The vertical offset from the target to the look-at point.
 * @param targetLead - How far ahead of the target to look.
 * @param lateralOffset - Optional shoulder offset in metres.
 * @param orbitYaw - Additional yaw offset from the editor camera.
 * @param orbitPitch - Additional pitch offset from the editor camera.
 * @param referenceFrame - The stage's scene axes in world space.
 * @returns The resolved camera pose.
 */
export function computeThirdPersonCameraPose({
  targetPosition,
  viewYaw,
  viewPitch,
  distance,
  followHeight,
  lookHeight,
  targetLead,
  lateralOffset = 0,
  orbitYaw = 0,
  orbitPitch = 0,
  referenceFrame = DEFAULT_FOLLOW_CAMERA_REFERENCE_FRAME,
}: {
  targetPosition: [number, number, number];
  viewYaw: number;
  viewPitch: number;
  distance: number;
  followHeight: number;
  lookHeight: number;
  targetLead: number;
  lateralOffset?: number;
  orbitYaw?: number;
  orbitPitch?: number;
  /** Scene axes in world space, so a rotated stage keeps its camera rig coherent. */
  referenceFrame?: FollowCameraReferenceFrame;
}): ThirdPersonCameraPose {
  const effectiveYaw = wrapAngle(viewYaw + orbitYaw);
  const effectivePitch = viewPitch + orbitPitch;
  const pitchOrbit = getPitchOrbit(effectivePitch, "third-person");
  const baseForward = normalizeVector3(referenceFrame.forward, DEFAULT_FOLLOW_CAMERA_REFERENCE_FRAME.forward);
  const baseRight = normalizeVector3(referenceFrame.right, DEFAULT_FOLLOW_CAMERA_REFERENCE_FRAME.right);
  const up = normalizeVector3(referenceFrame.up, DEFAULT_FOLLOW_CAMERA_REFERENCE_FRAME.up);
  const sineYaw = Math.sin(effectiveYaw);
  const cosineYaw = Math.cos(effectiveYaw);
  // Director's authored characters and Mixamo assets face local +Z at yaw
  // zero. Keep the follow basis on that same contract so the camera stays
  // behind the direction used by blocking, audits and locomotion.
  const forward = normalizeVector3(
    [
      baseForward[0] * cosineYaw + baseRight[0] * sineYaw,
      baseForward[1] * cosineYaw + baseRight[1] * sineYaw,
      baseForward[2] * cosineYaw + baseRight[2] * sineYaw,
    ],
    baseForward,
  );
  const right = normalizeVector3(
    [
      baseRight[0] * cosineYaw - baseForward[0] * sineYaw,
      baseRight[1] * cosineYaw - baseForward[1] * sineYaw,
      baseRight[2] * cosineYaw - baseForward[2] * sineYaw,
    ],
    baseRight,
  );
  const leadTarget = [...targetPosition] as [number, number, number];
  addScaledVector3(leadTarget, forward, targetLead);
  const horizontalDistance = distance * pitchOrbit.horizontalScale;
  const position = [...leadTarget] as [number, number, number];
  addScaledVector3(position, forward, -horizontalDistance);
  addScaledVector3(position, up, followHeight + pitchOrbit.verticalScale * distance * 0.96);
  addScaledVector3(position, right, lateralOffset);
  const lookAt = [...leadTarget] as [number, number, number];
  addScaledVector3(lookAt, up, lookHeight);

  return {
    position,
    lookAt,
    forward,
    right,
    up,
  };
}

/**
 * Computes a first-person camera pose at the actor's eye height, looking
 * along the view direction.
 *
 * @param targetPosition - The actor's world position.
 * @param forward - The already-pitched view direction in world space.
 * @param forwardOffset - Distance from the target position along the view.
 * @param lookDistance - Distance from the camera to the look-at point.
 * @returns The camera position, look-at point, and view forward.
 */
export function computeFirstPersonCameraPose({
  targetPosition,
  forward,
  forwardOffset,
  lookDistance,
}: {
  targetPosition: [number, number, number];
  /** Already-pitched view direction expressed in world space. */
  forward: [number, number, number];
  forwardOffset: number;
  lookDistance: number;
}) {
  const viewForward = normalizeVector3(forward, DEFAULT_FOLLOW_CAMERA_REFERENCE_FRAME.forward);
  const position = [...targetPosition] as [number, number, number];
  addScaledVector3(position, viewForward, forwardOffset);
  const lookAt = [...position] as [number, number, number];
  addScaledVector3(lookAt, viewForward, lookDistance);
  return { position, lookAt, forward: viewForward };
}

const WHEEL_LINE_HEIGHT_PX = 16;
const WHEEL_PAGE_HEIGHT_PX = 800;
const FOLLOW_ZOOM_LOG_SENSITIVITY = 0.0015;
const FOLLOW_ZOOM_MAX_PIXEL_IMPULSE = 240;

/**
 * Converts mouse-wheel and high-resolution trackpad deltas into a continuous,
 * scale-independent logarithmic zoom target. Tiny deltas stay tiny instead of
 * each producing the same fixed jump.
 */
export function applyFollowCameraZoomImpulse({
  currentDistance,
  deltaMode = 0,
  deltaY,
  minDistance,
  maxDistance,
}: {
  currentDistance: number;
  deltaMode?: number;
  deltaY: number;
  minDistance: number;
  maxDistance: number;
}) {
  const unitScale = deltaMode === 1 ? WHEEL_LINE_HEIGHT_PX : deltaMode === 2 ? WHEEL_PAGE_HEIGHT_PX : 1;
  const pixelImpulse = clamp(deltaY * unitScale, -FOLLOW_ZOOM_MAX_PIXEL_IMPULSE, FOLLOW_ZOOM_MAX_PIXEL_IMPULSE);
  const nextDistance = currentDistance * Math.exp(pixelImpulse * FOLLOW_ZOOM_LOG_SENSITIVITY);
  return clamp(nextDistance, minDistance, maxDistance);
}

/**
 * Obstructions must contract the rig immediately, while intentional zoom and
 * obstruction release remain damped. Treating every shorter desired distance
 * as a collision made wheel zoom-in snap even though zoom-out was smooth.
 */
export function stepFollowCameraDistance({
  currentDistance,
  safeDistance,
  obstructed,
  snap,
  response,
  delta,
}: {
  currentDistance: number;
  safeDistance: number;
  obstructed: boolean;
  snap: boolean;
  response: number;
  delta: number;
}) {
  if (snap || (obstructed && safeDistance < currentDistance)) return safeDistance;
  return dampScalar(currentDistance, safeDistance, response, delta);
}

/**
 * Smooths the follow camera's vertical look target so rapid terrain changes
 * do not jerk the camera. Uses a deadband to ignore small vertical noise while
 * walking and a snap-distance cap to prevent the camera from trailing too far
 * behind during a fast drop or climb.
 */
export class FollowTargetVerticalSmoother {
  private signature = "";
  private smoothedY: number | null = null;

  /** Resets the smoother, forgetting the current signature and smoothed height. */
  reset() {
    this.signature = "";
    this.smoothedY = null;
  }

  /**
   * Advances the vertical smoother by one frame. The smoother tracks the raw
   * target Y through a deadband and damping; large jumps are clamped to the
   * snap distance rather than teleporting the camera.
   *
   * @param signature - A string that identifies the current follow target.
   * @param rawTargetY - The raw target Y in world space.
   * @param delta - The frame interval in seconds.
   * @param locomotionState - The current locomotion state string.
   * @param stableLocomotion - Whether the current locomotion is stable.
   * @param deadband - Vertical deadband in metres.
   * @param snapDistance - Maximum per-frame snap distance in metres.
   * @param walkLambda - Damping rate while walking.
   * @param idleLambda - Damping rate while idling.
   * @returns The smoothed Y height.
   */
  step({
    signature,
    rawTargetY,
    delta,
    locomotionState,
    stableLocomotion,
    deadband,
    snapDistance,
    walkLambda,
    idleLambda,
  }: {
    signature: string;
    rawTargetY: number;
    delta: number;
    locomotionState?: string | null;
    stableLocomotion?: boolean;
    deadband: number;
    snapDistance: number;
    walkLambda: number;
    idleLambda: number;
  }) {
    const isStable =
      stableLocomotion ?? (locomotionState ? LOCOMOTION_CAMERA_STABLE_STATES.has(locomotionState) : false);

    if (this.signature !== signature || this.smoothedY == null) {
      this.signature = signature;
      this.smoothedY = rawTargetY;
      return this.smoothedY;
    }

    // Bound the tracking lag instead of snapping the whole way there. A fast
    // jump or long fall legitimately outruns the damper; snapshotting the full
    // gap in one frame read as a vertical camera pop mid-motion. Clamping to
    // the snap distance keeps the same "never trail further than this" bound
    // while staying continuous: at the bound the camera moves in lockstep with
    // the target until damping wins the gap back.
    const lag = rawTargetY - this.smoothedY;
    if (Math.abs(lag) > snapDistance) {
      this.smoothedY = rawTargetY - Math.sign(lag) * snapDistance;
    }

    const yDelta = rawTargetY - this.smoothedY;
    const shouldIgnoreSmallStepMotion = isStable && Math.abs(yDelta) < deadband;
    if (!shouldIgnoreSmallStepMotion) {
      this.smoothedY = dampScalar(this.smoothedY, rawTargetY, isStable ? walkLambda : idleLambda, delta);
    }
    return this.smoothedY;
  }
}

/**
 * Returns the first-person camera forward offset (eye position) scaled to
 * the given character height.
 *
 * @param characterHeight - The character's actual height in Director metres.
 * @returns The forward offset in metres.
 */
export function getFirstPersonForwardOffset(characterHeight = DIRECTOR_DEFAULT_CHARACTER_HEIGHT) {
  return scaleReferenceLength(FOLLOW_CAMERA_DEFAULTS.firstPersonForwardOffset, characterHeight);
}

/** The initial follow-camera orbit derived from the live editor camera. */
export type FollowCameraEntryPose = {
  /** True when the pose was derived from the live editor camera. */
  derivedFromCamera: boolean;
  /** Preferred follow distance in default-character reference space. */
  preferredDistance: number;
  viewPitch: number;
  viewYaw: number;
};

/** Longest roam entry distance, as a multiple of the default follow distance. */
export const FOLLOW_ENTRY_PLAYABLE_DISTANCE_RATIO = 2.5;

/**
 * Derives the initial follow-camera orbit from the live editor camera so
 * entering roam continues the shot the user was already looking at instead of
 * teleporting the camera behind the actor's authored facing.
 *
 * The inverse only needs to be approximate: the follow rig snaps to the
 * derived orbit on its first frame, so matching yaw exactly and pitch and
 * distance closely keeps the perceived cut seamless.
 */
export function deriveFollowCameraEntryPose({
  actorPosition,
  actorYaw,
  cameraPosition,
  characterHeight = DIRECTOR_DEFAULT_CHARACTER_HEIGHT,
  fallbackDistance,
  fallbackPitch,
  maxPitch,
  minPitch,
}: {
  actorPosition: [number, number, number];
  actorYaw: number;
  cameraPosition: [number, number, number];
  characterHeight?: number;
  /** Reference-space distance used when no camera pose can be derived. */
  fallbackDistance: number;
  fallbackPitch: number;
  maxPitch: number;
  minPitch: number;
}): FollowCameraEntryPose {
  const fallback: FollowCameraEntryPose = {
    derivedFromCamera: false,
    preferredDistance: fallbackDistance,
    viewPitch: fallbackPitch,
    viewYaw: actorYaw,
  };
  const characterScale = getCharacterScaleFactor(Math.max(0.01, characterHeight));
  const offsetX = cameraPosition[0] - actorPosition[0];
  const offsetY = cameraPosition[1] - actorPosition[1];
  const offsetZ = cameraPosition[2] - actorPosition[2];
  if (![offsetX, offsetY, offsetZ].every(Number.isFinite)) return fallback;
  const planarDistance = Math.hypot(offsetX, offsetZ);
  // A top-down or co-located editor camera has no usable orbit direction.
  if (planarDistance < Math.max(0.1, 0.75 * characterScale)) return fallback;

  // computeThirdPersonCameraPose places the camera opposite the view forward.
  const viewYaw = wrapAngle(Math.atan2(-offsetX, -offsetZ));
  const config = getScaledPlayerConfig(Math.max(0.01, characterHeight));
  const verticalAboveFollow = offsetY - config.cameraFollowHeight;
  const pitchAngle = Math.atan2(verticalAboveFollow, planarDistance);
  const viewPitch = clamp(Math.tan(pitchAngle) / 0.82, minPitch, maxPitch);
  const worldDistance = Math.hypot(planarDistance, verticalAboveFollow);
  const referenceConfig = getScaledPlayerConfig(DIRECTOR_DEFAULT_CHARACTER_HEIGHT);
  // Direction continuity matters more than raw distance: an editor overview
  // shot can sit dozens of metres out, which as a follow distance turns the
  // actor into a speck. Ease long entries down to a playable band while the
  // orbit direction still matches what the user was framing.
  const playableMaxDistance = Math.min(
    referenceConfig.cameraMaxDistance,
    referenceConfig.cameraDistance * FOLLOW_ENTRY_PLAYABLE_DISTANCE_RATIO,
  );
  const preferredDistance = clamp(
    worldDistance / characterScale,
    referenceConfig.cameraMinDistance,
    playableMaxDistance,
  );
  return { derivedFromCamera: true, preferredDistance, viewPitch, viewYaw };
}

/**
 * Determines the character's locomotion gait from planar speed using
 * hysteresis thresholds. The previous state is used to prevent rapid
 * oscillation at the walk/run boundary.
 *
 * @param planarSpeed - The current horizontal speed in m/s.
 * @param characterHeight - The character's actual height in Director metres.
 * @param previousState - The previous gait state.
 * @returns The current gait state: "idle", "walkForward", or "runForward".
 */
export function getLocomotionState(
  planarSpeed: number,
  characterHeight = DIRECTOR_DEFAULT_CHARACTER_HEIGHT,
  previousState: "idle" | "walkForward" | "runForward" = "idle",
) {
  const runThreshold = scaleReferenceLength(HERO_LOCOMOTION_DEFAULTS.runBlendThreshold, characterHeight);
  const walkThreshold = scaleReferenceLength(HERO_LOCOMOTION_DEFAULTS.walkBlendThreshold, characterHeight);
  // Separate enter/exit thresholds prevent physics noise and crossfade overlap
  // from restarting the gait at the walk/run boundary.
  if (previousState === "runForward" && planarSpeed > runThreshold * 0.82) return "runForward";
  if (planarSpeed > runThreshold) return "runForward";
  if (previousState !== "idle" && planarSpeed > walkThreshold * 0.65) return "walkForward";
  if (planarSpeed > walkThreshold) return "walkForward";
  return "idle";
}

/** Natural frequency of the third-person pivot spring, rad/s-ish. */
export const FOLLOW_PIVOT_SPRING_FREQ = 7.5;
/** Critical damping ratio: 1 = no overshoot. */
export const FOLLOW_PIVOT_SPRING_DAMPING = 1;
/** Peak bank into a carve, radians. */
export const FOLLOW_BANK_MAX_RADIANS = 0.085;
export const FOLLOW_BANK_RESPONSE = 5;
/** Ground-lift rates: rise fast, fall slow so a crest never pops the lens. */
export const FOLLOW_GROUND_LIFT_RISE_RATE = 26;
export const FOLLOW_GROUND_LIFT_FALL_RATE = 4.5;
/** Extra vertical FOV fraction at full run, matching a spring-arm action rig. */
export const FOLLOW_SPEED_FOV_FRACTION = 0.19;
export const FOLLOW_ARM_GROUND_SAMPLES = 5;
export const FOLLOW_VELOCITY_LEAD_SECONDS = 0.09;

/**
 * Semi-implicit critically-damped spring. Mutates `position` and `velocity`.
 * A hitch cannot blow the integrator because dt is sanitized and capped.
 */
export function stepCriticallyDampedSpring3(
  position: [number, number, number],
  velocity: [number, number, number],
  target: readonly [number, number, number],
  freq: number,
  damping: number,
  dt: number,
) {
  const h = Math.min(sanitizeFollowDelta(dt), 1 / 45);
  if (h <= 0) return;
  const k = freq * freq;
  const c = 2 * damping * freq;
  velocity[0] += (k * (target[0] - position[0]) - c * velocity[0]) * h;
  velocity[1] += (k * (target[1] - position[1]) - c * velocity[1]) * h;
  velocity[2] += (k * (target[2] - position[2]) - c * velocity[2]) * h;
  position[0] += velocity[0] * h;
  position[1] += velocity[1] * h;
  position[2] += velocity[2] * h;
}

/** Exponential approach that rises faster than it falls. */
export function stepAsymmetricExpDamp(current: number, target: number, riseRate: number, fallRate: number, dt: number) {
  return dampScalar(current, target, target > current ? riseRate : fallRate, dt);
}

/**
 * Samples a configurable number of points along the follow arm (pivot to
 * camera) and returns the largest ground-penetration delta. This is used to
 * lift the camera when terrain rises between the pivot and the lens.
 *
 * @param pivot - The pivot position (at the actor).
 * @param camera - The desired camera position.
 * @param groundY - The terrain height at each sample.
 * @param clearance - The minimum ground clearance.
 * @param samples - The number of sample points along the arm.
 * @returns The largest penetration depth, or 0 if none.
 */
export function sampleFollowArmGroundLift({
  pivot,
  camera,
  groundY,
  clearance,
  samples = FOLLOW_ARM_GROUND_SAMPLES,
}: {
  pivot: readonly [number, number, number];
  camera: readonly [number, number, number];
  groundY: number;
  clearance: number;
  samples?: number;
}) {
  let need = 0;
  const count = Math.max(1, samples);
  for (let i = 0; i <= count; i += 1) {
    const t = i / count;
    const y = pivot[1] + (camera[1] - pivot[1]) * t;
    const alongClearance = clearance * (0.35 + 0.65 * t);
    const delta = groundY + alongClearance - y;
    if (delta > need) need = delta;
  }
  return need;
}

/**
 * A critically-damped spring for the follow-camera pivot. Softens lateral
 * motion so the camera does not snap to every small character movement.
 */
export class FollowPivotSpring {
  private position: [number, number, number] | null = null;
  private velocity: [number, number, number] = [0, 0, 0];

  /** Resets the spring to a neutral state. */
  reset() {
    this.position = null;
    this.velocity = [0, 0, 0];
  }

  /**
   * Advances the spring by one frame. On the first step or when `snap` is
   * true, the spring jumps to the target immediately.
   *
   * @param target - The target position.
   * @param delta - The frame interval in seconds.
   * @param freq - The natural frequency of the spring.
   * @param damping - The damping ratio.
   * @param snap - Whether to snap immediately to the target.
   * @returns The current spring position.
   */
  step({
    target,
    delta,
    freq = FOLLOW_PIVOT_SPRING_FREQ,
    damping = FOLLOW_PIVOT_SPRING_DAMPING,
    snap = false,
  }: {
    target: readonly [number, number, number];
    delta: number;
    freq?: number;
    damping?: number;
    snap?: boolean;
  }): [number, number, number] {
    if (snap || this.position == null) {
      this.position = [target[0], target[1], target[2]];
      this.velocity = [0, 0, 0];
      return this.position;
    }
    stepCriticallyDampedSpring3(this.position, this.velocity, target, freq, damping, delta);
    return this.position;
  }
}
