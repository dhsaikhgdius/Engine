/**
 * Pure player roam-mode locomotion for the Stage's playable exploration mode:
 * input intent resolution (walk/sprint/dash/jump/flight/swim), planar obstacle
 * avoidance with step-up and ground settling, and third-person camera distance
 * rules. Everything here is framework-free math over plain data — the R3F
 * PlayerController owns the render loop and Rapier physics, and calls into
 * these functions so behavior stays unit-testable and deterministic. The same
 * state machine also backs headless playtest evaluation via `director_game`.
 */
import {
  DIRECTOR_DEFAULT_CHARACTER_HEIGHT,
  getScaledPlayerConfig,
  resolveCharacterMovement,
  type PlanarObstacle,
} from "./characterFollowRuntime";
import { clamp } from "../../../../../../packages/protocol/src/primitives";

/** Active camera perspective for the roam controller. */
export type PlayerViewMode = "third" | "first";

/** World-space position triplet [x, y, z] in metres. */
export type PlayerPosition = [number, number, number];

/** A collision obstacle the player capsule must avoid or step onto. */
export type PlayerObstacle = {
  /** Optional stable identifier used for obstacle deduplication. */
  id?: string;
  /** World-space centre position of the obstacle. */
  position: PlayerPosition;
  /** Bounding radius for circle obstacles, or fallback for box extents. */
  radius: number;
  /** False for solid obstacles that must never act as ground or a step, such as another character. */
  walkableSurface?: boolean;
  /** `mesh` is resolved from the mounted Stage object by the Rapier motor. */
  shape?: "circle" | "box" | "mesh";
  halfExtents?: [number, number];
  /** Vertical half extent used by the Rapier environment proxy. */
  halfHeight?: number;
  /** Full object rotation, in radians. Legacy planar collision only reads yaw. */
  rotation?: PlayerPosition;
  /** Required to invalidate a mounted mesh collider after authored scaling. */
  scale?: PlayerPosition;
  /** Asset identity/version used to invalidate an asynchronously mounted mesh. */
  meshRevision?: string;
  /** Legacy planar-only yaw angle in radians. Prefer `rotation` for new code. */
  yaw?: number;
};

/** Per-frame digital and analog input intent from keyboard, mouse, and gamepad. */
export type PlayerInput = {
  /** Held W key or gamepad forward stick. */
  forward: boolean;
  /** Held S key or gamepad backward stick. */
  backward: boolean;
  /** Held A key or gamepad left stick. */
  left: boolean;
  /** Held D key or gamepad right stick. */
  right: boolean;
  /** Held Shift key requests sprint gait. */
  sprint: boolean;
  /** Held Space key requests jump or flight rise. */
  jump: boolean;
  /** Edge-triggered latch so a short tap cannot disappear between frames. */
  jumpPressed?: boolean;
  /** Flight-only vertical rise that never schedules a ground jump. */
  ascend?: boolean;
  /** Held descend key (Q in flight, Ctrl on foot). */
  descend: boolean;
  /** Short controller-timed burst that outruns sprint (double-tap gesture). */
  dash?: boolean;
  /**
   * Hold-to-crouch. Caps planar speed at crouchSpeed and suppresses sprint
   * and dash; a jump implicitly stands up first, so it is never blocked.
   */
  crouch?: boolean;
  /** Toggled slow-walk gait for precise blocking walks (sprint overrides it). */
  slowWalk?: boolean;
  /**
   * Internal edge latch for the slow-walk toggle key. Browsers auto-repeat
   * keydown, so the toggle must only flip on the first physical press.
   */
  slowWalkKeyHeld?: boolean;
  /** Held arrow-key look. Optional so locomotion tests can omit them. */
  lookLeft?: boolean;
  lookRight?: boolean;
  lookUp?: boolean;
  lookDown?: boolean;
  /**
   * Analog move axes from a gamepad stick, -1..1 with +forward/+right. When
   * either is non-zero they replace the digital WASD vector, and a partial
   * tilt walks proportionally slower than the current gait's full speed.
   */
  moveForwardAxis?: number;
  moveRightAxis?: number;
};

/** Full kinematic state of the player capsule produced by one simulation step. */
export type PlayerLocomotionState = {
  /** Foot-height world position (not capsule centre). */
  position: PlayerPosition;
  /** Current velocity [vx, vy, vz] in m/s. */
  velocity: PlayerPosition;
  /** Heading around +Y in radians. */
  yaw: number;
  /** Pitch around +X in radians. */
  pitch: number;
  /** Whether the character is in flight mode. */
  flying: boolean;
  /** Whether the character is standing on a surface. */
  onGround: boolean;
  /** Whether the jump key was held on the previous frame. */
  jumpHeld: boolean;
  /** Grace period after leaving a ledge in which a jump is still accepted. */
  coyoteTimeRemaining: number;
  /** Queues a jump pressed just before landing. */
  jumpBufferTimeRemaining: number;
};

/** Live drive-session digest surfaced to the HUD through the status channel. */
export type PlayerVehicleRuntimeStatus = {
  phase: "prompt" | "driving";
  vehicleName: string;
  speedKph: number;
};

/** Nearest usable interactive object and its prompt label. */
export type PlayerInteractionRuntimeStatus = {
  objectId: string;
  prompt: string;
};

/** Aggregate roam telemetry consumed by the HUD overlay. */
export type PlayerRuntimeStatus = {
  /** Whether the right mouse button is held for aiming. */
  aiming: boolean;
  /** Current third-person camera distance in metres. */
  cameraDistance: number;
  /** Whether the camera line-of-sight is blocked by an obstacle. */
  cameraObstructed: boolean;
  /** World-space position of the follow camera. */
  cameraPosition: PlayerPosition;
  /** Grounded crouch gait is active (held key, not flying). */
  crouching?: boolean;
  /** Clip id of the currently playing emote, or null when idle. */
  emoteClipId: string | null;
  /** World-space foot position of the player character. */
  playerPosition: PlayerPosition;
  /** Whether the third-person character mesh is visible at this camera distance. */
  playerVisible: boolean;
  /** Slow-walk toggle currently governs the gait (not overridden). */
  slowWalking?: boolean;
  /** World-space look-at target of the follow camera. */
  targetPosition: PlayerPosition;
  /** Null while no drivable vehicle is nearby and none is being driven. */
  vehicle?: PlayerVehicleRuntimeStatus | null;
  /** Nearest usable object while on foot; vehicles retain KeyE priority. */
  interaction?: PlayerInteractionRuntimeStatus | null;
  /** Active camera perspective. */
  viewMode: PlayerViewMode;
};

/** Structured key hints so the HUD can render readable keycap chips. */
export const PLAYER_CONTROLLER_KEY_HINTS = [
  { keys: ["W", "A", "S", "D"], action: "移动" },
  { keys: ["↑", "↓", "←", "→"], action: "方向键转视角" },
  { keys: ["Shift"], action: "冲刺" },
  { keys: ["双击方向"], action: "冲刺步" },
  { keys: ["C"], action: "蹲伏（按住）" },
  { keys: ["R"], action: "缓步开关" },
  { keys: ["Space"], action: "跳跃 / 上升" },
  { keys: ["右键"], action: "按住瞄准" },
  { keys: ["1", "2", "3", "4"], action: "表情动作" },
  { keys: ["F"], action: "切换飞行" },
  { keys: ["E"], action: "交互 / 进入载具" },
  { keys: ["Q", "E"], action: "飞行下降 / 上升" },
  { keys: ["V"], action: "第一 / 第三人称" },
  { keys: ["Enter"], action: "记录移动" },
  { keys: ["Esc"], action: "解锁 / 再按退出" },
  { keys: ["手柄"], action: "摇杆移动 / 视角（即插即用）" },
] as const;

const PLAYER_FOLLOW_DEFAULTS = getScaledPlayerConfig(DIRECTOR_DEFAULT_CHARACTER_HEIGHT);

/** Tuned locomotion constants shared by the legacy and Rapier motor paths. */
export const PLAYER_CONTROLLER_CONFIG = {
  acceleration: PLAYER_FOLLOW_DEFAULTS.acceleration,
  cameraClearance: PLAYER_FOLLOW_DEFAULTS.occlusionPadding,
  cameraCollisionMinDistance: PLAYER_FOLLOW_DEFAULTS.occlusionMinDistance,
  cameraDistance: PLAYER_FOLLOW_DEFAULTS.cameraDistance,
  cameraFollowHeight: PLAYER_FOLLOW_DEFAULTS.cameraFollowHeight,
  cameraHidePlayerDistance: PLAYER_FOLLOW_DEFAULTS.cameraHidePlayerDistance,
  cameraLookHeight: PLAYER_FOLLOW_DEFAULTS.cameraLookHeight,
  cameraMaxDistance: PLAYER_FOLLOW_DEFAULTS.cameraMaxDistance,
  cameraMinDistance: PLAYER_FOLLOW_DEFAULTS.cameraMinDistance,
  cameraShoulderOffset: PLAYER_FOLLOW_DEFAULTS.cameraShoulderOffset,
  cameraTargetLead: PLAYER_FOLLOW_DEFAULTS.cameraTargetLead,
  cameraZoomStep: PLAYER_FOLLOW_DEFAULTS.cameraZoomStep,
  coyoteTime: 0.11,
  /** Crouched planar speed cap; also disables sprint and dash. */
  crouchSpeed: PLAYER_FOLLOW_DEFAULTS.walkSpeed * 0.55,
  dashCooldownS: 0.9,
  dashDurationS: 0.22,
  /** Multiplied into runSpeed for the dash burst. */
  dashSpeedMultiplier: 2.05,
  decelerationAcceleration: PLAYER_FOLLOW_DEFAULTS.decelerationAcceleration,
  followSmoothing: PLAYER_FOLLOW_DEFAULTS.followSmoothing,
  flySpeed: PLAYER_FOLLOW_DEFAULTS.runSpeed,
  groundSnapDistance: 0.28,
  gravity: 22,
  jumpBufferTime: 0.13,
  jumpSpeed: 7.6,
  /**
   * Terminal fall speed. Long falls otherwise integrate unbounded downward
   * velocity, which degrades Rapier shape-cast precision and makes the legacy
   * path cover huge per-substep distances.
   */
  maxFallSpeed: 40,
  maxSlopeClimbAngle: Math.PI * (48 / 180),
  minSlopeSlideAngle: Math.PI * (52 / 180),
  occlusionTargetClearanceMin: PLAYER_FOLLOW_DEFAULTS.occlusionTargetClearanceMin,
  occlusionTargetClearanceRatio: PLAYER_FOLLOW_DEFAULTS.occlusionTargetClearanceRatio,
  playerHeight: DIRECTOR_DEFAULT_CHARACTER_HEIGHT,
  playerRadius: PLAYER_FOLLOW_DEFAULTS.playerRadius,
  pointerSensitivity: PLAYER_FOLLOW_DEFAULTS.pointerSensitivity,
  runSpeed: PLAYER_FOLLOW_DEFAULTS.runSpeed,
  /** Toggled slow-walk gait for deliberate, precise blocking walks. */
  slowWalkSpeed: PLAYER_FOLLOW_DEFAULTS.walkSpeed * 0.5,
  stepHeight: 0.34,
  stepMinWidth: 0.18,
  verticalDeadband: PLAYER_FOLLOW_DEFAULTS.verticalDeadband,
  verticalIdleLambda: PLAYER_FOLLOW_DEFAULTS.verticalIdleLambda,
  verticalSnapDistance: PLAYER_FOLLOW_DEFAULTS.verticalSnapDistance,
  verticalWalkLambda: PLAYER_FOLLOW_DEFAULTS.verticalWalkLambda,
  walkSpeed: PLAYER_FOLLOW_DEFAULTS.walkSpeed,
} as const;

/** How far above the actor a roam spawn may still snap down onto a floor. */
export const PLAYER_ROAM_SPAWN_SNAP_BELOW_M = 24;

const MAX_SIMULATION_DELTA = 0.1;
const MAX_SIMULATION_STEP = 1 / 60;

function damp(current: number, target: number, rate: number, delta: number) {
  return current + (target - current) * (1 - Math.exp(-rate * delta));
}

/**
 * Digital keys and the optional analog stick merged into one move vector.
 * Analog input wins when present so a gamepad and keyboard can coexist; the
 * vector is clamped to unit length while preserving sub-unit magnitudes for
 * proportional analog walking.
 */
export function getPlayerMoveAxes(input: PlayerInput): [number, number] {
  const axisForward = input.moveForwardAxis ?? 0;
  const axisRight = input.moveRightAxis ?? 0;
  if (Math.abs(axisForward) > 0.0001 || Math.abs(axisRight) > 0.0001) {
    const length = Math.hypot(axisForward, axisRight);
    const scale = length > 1 ? 1 / length : 1;
    return [axisForward * scale, axisRight * scale];
  }
  return [Number(input.forward) - Number(input.backward), Number(input.right) - Number(input.left)];
}

/** Shared input-to-velocity protocol for legacy and Rapier player motors. */
export function resolvePlayerMotorIntent(
  state: PlayerLocomotionState,
  input: PlayerInput,
  delta: number,
  groundStickSpeed?: number,
  speedScale = 1,
) {
  const [forwardX, forwardZ] = getPlayerForward(state.yaw);
  const [rightX, rightZ] = getPlayerRight(state.yaw);
  const [moveForward, moveRight] = getPlayerMoveAxes(input);
  const moveLength = Math.hypot(moveForward, moveRight);
  const normalizedForward = moveLength > 1 ? moveForward / moveLength : moveForward;
  const normalizedRight = moveLength > 1 ? moveRight / moveLength : moveRight;
  const directionX = forwardX * normalizedForward + rightX * normalizedRight;
  const directionZ = forwardZ * normalizedForward + rightZ * normalizedRight;
  const moving = Math.hypot(directionX, directionZ) > 0.0001;
  const scale = typeof speedScale === "number" && Number.isFinite(speedScale) && speedScale > 0 ? speedScale : 1;
  // Crouch is the strongest grounded gait modifier: it caps planar speed and
  // suppresses sprint and an armed dash burst. Sprint and dash in turn
  // override the slow-walk toggle, so a held Shift always wins over KeyR.
  const crouching = !state.flying && input.crouch === true;
  const speed =
    (state.flying
      ? PLAYER_CONTROLLER_CONFIG.flySpeed
      : crouching
        ? PLAYER_CONTROLLER_CONFIG.crouchSpeed
        : input.dash
          ? PLAYER_CONTROLLER_CONFIG.runSpeed * PLAYER_CONTROLLER_CONFIG.dashSpeedMultiplier
          : input.sprint
            ? PLAYER_CONTROLLER_CONFIG.runSpeed
            : input.slowWalk
              ? PLAYER_CONTROLLER_CONFIG.slowWalkSpeed
              : PLAYER_CONTROLLER_CONFIG.walkSpeed) * scale;
  const response = moving ? PLAYER_CONTROLLER_CONFIG.acceleration : PLAYER_CONTROLLER_CONFIG.decelerationAcceleration;
  const velocityX = damp(state.velocity[0], moving ? directionX * speed : 0, response, delta);
  const velocityZ = damp(state.velocity[2], moving ? directionZ * speed : 0, response, delta);
  let velocityY = state.velocity[1];
  // Jump eligibility is decided against the windows as they stood at the
  // start of this substep. Decrementing first silently shaved one substep off
  // both the coyote and buffer windows at their boundary.
  const jumpRequested = input.jumpPressed === true || (input.jump && !state.jumpHeld);
  const coyoteWindowOpen = state.onGround || state.coyoteTimeRemaining > 0;
  const bufferWindowOpen = jumpRequested || state.jumpBufferTimeRemaining > 0;
  let coyoteTimeRemaining = state.onGround
    ? PLAYER_CONTROLLER_CONFIG.coyoteTime
    : Math.max(0, state.coyoteTimeRemaining - delta);
  let jumpBufferTimeRemaining = jumpRequested
    ? PLAYER_CONTROLLER_CONFIG.jumpBufferTime
    : Math.max(0, state.jumpBufferTimeRemaining - delta);

  if (state.flying) {
    const flightRise = input.jump || input.ascend ? 1 : 0;
    velocityY = (flightRise - Number(input.descend)) * PLAYER_CONTROLLER_CONFIG.flySpeed;
    coyoteTimeRemaining = 0;
    jumpBufferTimeRemaining = 0;
  } else if (bufferWindowOpen && coyoteWindowOpen) {
    // A jump from crouch is never blocked: the takeoff implicitly stands the
    // character up, while the held key keeps governing planar speed. Gravity
    // integrates into the takeoff substep on both motor paths (semi-implicit
    // Euler), so the legacy and Rapier motors share one jump arc.
    velocityY = PLAYER_CONTROLLER_CONFIG.jumpSpeed - PLAYER_CONTROLLER_CONFIG.gravity * delta;
    coyoteTimeRemaining = 0;
    jumpBufferTimeRemaining = 0;
  } else if (groundStickSpeed !== undefined && state.onGround && velocityY <= 0) {
    velocityY = -groundStickSpeed;
  } else {
    velocityY = Math.max(velocityY - PLAYER_CONTROLLER_CONFIG.gravity * delta, -PLAYER_CONTROLLER_CONFIG.maxFallSpeed);
  }
  return { velocityX, velocityY, velocityZ, coyoteTimeRemaining, jumpBufferTimeRemaining };
}

function getFallbackNormal(velocityX: number, velocityZ: number) {
  const velocityLength = Math.hypot(velocityX, velocityZ);
  return velocityLength > 0.0001
    ? ([-velocityX / velocityLength, -velocityZ / velocityLength] as const)
    : ([1, 0] as const);
}

function resolveCircleObstacle({
  positionX,
  positionZ,
  velocityX,
  velocityZ,
  obstacle,
  playerRadius,
}: {
  positionX: number;
  positionZ: number;
  velocityX: number;
  velocityZ: number;
  obstacle: PlayerObstacle;
  playerRadius: number;
}) {
  const requiredDistance = playerRadius + Math.max(0, obstacle.radius);
  const dx = positionX - obstacle.position[0];
  const dz = positionZ - obstacle.position[2];
  const distance = Math.hypot(dx, dz);
  if (distance >= requiredDistance) return null;

  const fallback = getFallbackNormal(velocityX, velocityZ);
  const normalX = distance ? dx / distance : fallback[0];
  const normalZ = distance ? dz / distance : fallback[1];
  return {
    normalX,
    normalZ,
    penetration: requiredDistance - distance + 0.0001,
  };
}

function resolveBoxObstacle({
  positionX,
  positionZ,
  obstacle,
  playerRadius,
}: {
  positionX: number;
  positionZ: number;
  obstacle: PlayerObstacle;
  playerRadius: number;
}) {
  const [halfWidth, halfDepth] = obstacle.halfExtents ?? [obstacle.radius, obstacle.radius];
  const yaw = obstacle.yaw ?? 0;
  const cosine = Math.cos(yaw);
  const sine = Math.sin(yaw);
  const dx = positionX - obstacle.position[0];
  const dz = positionZ - obstacle.position[2];
  const localX = cosine * dx - sine * dz;
  const localZ = sine * dx + cosine * dz;
  const closestX = clamp(localX, -Math.max(0, halfWidth), Math.max(0, halfWidth));
  const closestZ = clamp(localZ, -Math.max(0, halfDepth), Math.max(0, halfDepth));
  const outsideX = localX - closestX;
  const outsideZ = localZ - closestZ;
  const outsideDistance = Math.hypot(outsideX, outsideZ);
  let localNormalX: number;
  let localNormalZ: number;
  let penetration: number;

  if (outsideDistance > 0.0001) {
    if (outsideDistance >= playerRadius) return null;
    localNormalX = outsideX / outsideDistance;
    localNormalZ = outsideZ / outsideDistance;
    penetration = playerRadius - outsideDistance + 0.0001;
  } else {
    const distanceToXFace = Math.max(0, halfWidth) - Math.abs(localX);
    const distanceToZFace = Math.max(0, halfDepth) - Math.abs(localZ);
    if (distanceToXFace < distanceToZFace) {
      localNormalX = Math.sign(localX) || 1;
      localNormalZ = 0;
      penetration = playerRadius + distanceToXFace + 0.0001;
    } else {
      localNormalX = 0;
      localNormalZ = Math.sign(localZ) || 1;
      penetration = playerRadius + distanceToZFace + 0.0001;
    }
  }

  return {
    normalX: cosine * localNormalX + sine * localNormalZ,
    normalZ: -sine * localNormalX + cosine * localNormalZ,
    penetration,
  };
}

function toPlanarObstacle(obstacle: PlayerObstacle): PlanarObstacle {
  if (obstacle.shape === "box") {
    const [halfWidth, halfDepth] = obstacle.halfExtents ?? [obstacle.radius, obstacle.radius];
    return {
      id: obstacle.id,
      position: obstacle.position,
      halfX: halfWidth,
      halfZ: halfDepth,
      rotationY: obstacle.yaw ?? 0,
    };
  }
  return {
    id: obstacle.id,
    position: obstacle.position,
    radius: Math.max(0, obstacle.radius),
  };
}

function isPlanarPlayerObstacle(obstacle: PlayerObstacle) {
  return obstacle.shape !== "mesh";
}

function getObstacleTopY(obstacle: PlayerObstacle) {
  const halfHeight = Math.max(0.025, obstacle.halfHeight ?? obstacle.radius);
  return obstacle.position[1] + halfHeight * 2;
}

function isStepableSurface(obstacle: PlayerObstacle, playerFootY: number) {
  if (!isPlanarPlayerObstacle(obstacle) || obstacle.walkableSurface === false) return false;
  const [rotationX, , rotationZ] = obstacle.rotation ?? [0, obstacle.yaw ?? 0, 0];
  if (Math.abs(rotationX) > 0.001 || Math.abs(rotationZ) > 0.001) return false;
  return getObstacleTopY(obstacle) <= playerFootY + PLAYER_CONTROLLER_CONFIG.stepHeight + 0.001;
}

function blocksPlanarMovementAtFootHeight(obstacle: PlayerObstacle, playerFootY: number) {
  if (!isPlanarPlayerObstacle(obstacle)) return false;
  const topY = getObstacleTopY(obstacle);
  return topY > playerFootY + 0.001 && !isStepableSurface(obstacle, playerFootY);
}

function toPlanarObstacles(obstacles: PlayerObstacle[], playerFootY: number) {
  const result: PlanarObstacle[] = [];
  for (const obstacle of obstacles) {
    if (blocksPlanarMovementAtFootHeight(obstacle, playerFootY)) result.push(toPlanarObstacle(obstacle));
  }
  return result;
}

function containsWalkableSurfacePoint(obstacle: PlayerObstacle, x: number, z: number) {
  if (obstacle.shape === "box") {
    const [halfWidth, halfDepth] = obstacle.halfExtents ?? [obstacle.radius, obstacle.radius];
    const yaw = obstacle.yaw ?? 0;
    const cosine = Math.cos(yaw);
    const sine = Math.sin(yaw);
    const dx = x - obstacle.position[0];
    const dz = z - obstacle.position[2];
    const localX = cosine * dx - sine * dz;
    const localZ = sine * dx + cosine * dz;
    return Math.abs(localX) <= halfWidth + 0.001 && Math.abs(localZ) <= halfDepth + 0.001;
  }
  return Math.hypot(x - obstacle.position[0], z - obstacle.position[2]) <= obstacle.radius + 0.001;
}

/**
 * Whether any imported mesh environment can serve as walkable ground, replacing
 * the Director plane. Only a live imported scene counts; project props alone
 * must not leave the actor in free fall on an empty stage.
 */
export function hasWalkableMeshPlayerEnvironment(_obstacles: readonly PlayerObstacle[], liveMeshCount = 0) {
  // Only a live imported scene can replace the Director plane. A chair, tree,
  // or other project mesh must not leave an empty-stage actor in free fall.
  return liveMeshCount > 0;
}

/**
 * Hide the visual ground only when a real imported floor can catch the capsule.
 * An empty stage still walks on the Director plane so roam does not require props.
 */
export function resolvePlayerRoamGroundEnabled({
  showGround,
  hasWalkableMeshEnvironment,
}: {
  showGround: boolean;
  hasWalkableMeshEnvironment: boolean;
}) {
  return showGround || !hasWalkableMeshEnvironment;
}

/**
 * Puts a floating roam spawn on the nearest walkable support instead of letting
 * gravity play out the drop. Platforms underfoot win over the fallback plane.
 */
export function settlePlayerLocomotionOntoGround(
  state: PlayerLocomotionState,
  {
    groundEnabled,
    groundHeight,
    maxBelow = PLAYER_ROAM_SPAWN_SNAP_BELOW_M,
    obstacles = [],
  }: {
    groundEnabled: boolean;
    groundHeight: number;
    maxBelow?: number;
    obstacles?: readonly PlayerObstacle[];
  },
): PlayerLocomotionState {
  if (state.flying) return state;
  const [x, footY, z] = state.position;
  const maxStepUp = PLAYER_CONTROLLER_CONFIG.stepHeight + 0.001;
  let floorY: number | null = null;
  for (const obstacle of obstacles) {
    if (!isPlanarPlayerObstacle(obstacle) || obstacle.walkableSurface === false) continue;
    const [rotationX, , rotationZ] = obstacle.rotation ?? [0, obstacle.yaw ?? 0, 0];
    if (Math.abs(rotationX) > 0.001 || Math.abs(rotationZ) > 0.001) continue;
    if (!containsWalkableSurfacePoint(obstacle, x, z)) continue;
    const topY = getObstacleTopY(obstacle);
    if (topY > footY + maxStepUp || topY < footY - maxBelow) continue;
    if (floorY === null || topY > floorY) floorY = topY;
  }
  if (floorY === null && groundEnabled && groundHeight <= footY + maxStepUp && groundHeight >= footY - maxBelow) {
    floorY = groundHeight;
  }
  if (floorY === null) return state;
  if (state.onGround && state.velocity[1] === 0 && Math.abs(footY - floorY) <= 0.0001) return state;
  // A Rapier mesh floor is invisible to the planar probe. If the capsule is
  // already planted there, do not pull it down onto the fallback plane.
  if (state.onGround && footY > floorY) return state;
  return {
    ...state,
    position: [x, floorY, z],
    velocity: [state.velocity[0], 0, state.velocity[2]],
    onGround: true,
    coyoteTimeRemaining: PLAYER_CONTROLLER_CONFIG.coyoteTime,
  };
}

function findHighestWalkableSurfaceY(obstacles: PlayerObstacle[], x: number, z: number, playerFootY: number) {
  let highest: number | null = null;
  for (const obstacle of obstacles) {
    if (!isStepableSurface(obstacle, playerFootY) || !containsWalkableSurfacePoint(obstacle, x, z)) continue;
    const topY = getObstacleTopY(obstacle);
    if (highest === null || topY > highest) highest = topY;
  }
  return highest;
}

function resolvePlanarCollisions({
  nextX,
  nextZ,
  velocityX,
  velocityZ,
  obstacles,
  playerFootY,
  playerRadius,
}: {
  nextX: number;
  nextZ: number;
  velocityX: number;
  velocityZ: number;
  obstacles: PlayerObstacle[];
  playerFootY: number;
  playerRadius: number;
}) {
  let resolvedX = nextX;
  let resolvedZ = nextZ;
  let resolvedVelocityX = velocityX;
  let resolvedVelocityZ = velocityZ;

  // Repeating this a few times makes neighbouring props behave like a wall
  // instead of alternately pushing the character between their boundaries.
  for (let pass = 0; pass < 3; pass += 1) {
    let collided = false;

    for (const obstacle of obstacles) {
      if (!blocksPlanarMovementAtFootHeight(obstacle, playerFootY)) continue;
      const collision =
        obstacle.shape === "box"
          ? resolveBoxObstacle({
              positionX: resolvedX,
              positionZ: resolvedZ,
              obstacle,
              playerRadius,
            })
          : resolveCircleObstacle({
              positionX: resolvedX,
              positionZ: resolvedZ,
              velocityX: resolvedVelocityX,
              velocityZ: resolvedVelocityZ,
              obstacle,
              playerRadius,
            });
      if (!collision) continue;

      resolvedX += collision.normalX * collision.penetration;
      resolvedZ += collision.normalZ * collision.penetration;

      // Keep the tangential part of the velocity so the player glides along
      // props instead of being pushed back every frame while a key is held.
      const velocityIntoSurface = resolvedVelocityX * collision.normalX + resolvedVelocityZ * collision.normalZ;
      if (velocityIntoSurface < 0) {
        resolvedVelocityX -= collision.normalX * velocityIntoSurface;
        resolvedVelocityZ -= collision.normalZ * velocityIntoSurface;
      }
      collided = true;
    }

    if (!collided) break;
  }

  return {
    position: [resolvedX, resolvedZ] as const,
    velocity: [resolvedVelocityX, resolvedVelocityZ] as const,
  };
}

function distanceToSegmentSquared(
  pointX: number,
  pointZ: number,
  startX: number,
  startZ: number,
  endX: number,
  endZ: number,
) {
  const segmentX = endX - startX;
  const segmentZ = endZ - startZ;
  const lengthSquared = segmentX * segmentX + segmentZ * segmentZ;
  if (lengthSquared <= 0.000001) {
    const dx = pointX - startX;
    const dz = pointZ - startZ;
    return { distanceSquared: dx * dx + dz * dz, t: 0 };
  }
  const t = clamp(((pointX - startX) * segmentX + (pointZ - startZ) * segmentZ) / lengthSquared, 0, 1);
  const closestX = startX + segmentX * t;
  const closestZ = startZ + segmentZ * t;
  const dx = pointX - closestX;
  const dz = pointZ - closestZ;
  return { distanceSquared: dx * dx + dz * dz, t };
}

/**
 * Builds an initial locomotion state at a world position, optionally clamped
 * above the ground plane so the actor never spawns below the floor.
 *
 * @param position - World-space foot position [x, y, z].
 * @param yaw - Initial heading around +Y in radians.
 * @param groundHeight - Fallback ground plane Y; position is clamped to at least this value.
 * @returns A fresh locomotion state with zero velocity.
 */
export function createPlayerLocomotionState(
  position: PlayerPosition,
  yaw = 0,
  groundHeight = 0,
): PlayerLocomotionState {
  const onGround = position[1] <= groundHeight + 0.0001;
  return {
    position: [position[0], Math.max(position[1], groundHeight), position[2]],
    velocity: [0, 0, 0],
    yaw,
    pitch: -0.12,
    flying: false,
    onGround,
    jumpHeld: false,
    coyoteTimeRemaining: onGround ? PLAYER_CONTROLLER_CONFIG.coyoteTime : 0,
    jumpBufferTimeRemaining: 0,
  };
}

/**
 * Normalized forward direction vector for a given yaw in the XZ plane.
 * Uses local +Z as forward at yaw zero, matching Director's authored character
 * contract and Mixamo asset orientation.
 *
 * @param yaw - Heading around +Y in radians.
 * @returns Unit-length [x, z] forward vector.
 */
export function getPlayerForward(yaw: number): [number, number] {
  // Director's authored character contract (blocking, look targets, audit and
  // the Mixamo assets themselves) uses local +Z as forward at yaw zero.
  // Keeping locomotion on -Z made a character walk backwards even though its
  // persisted rotation passed the scene-facing audit.
  return [Math.sin(yaw), Math.cos(yaw)];
}

/**
 * Normalized right direction vector for a given yaw in the XZ plane.
 * At yaw zero the right vector points toward -X, matching the screen-right
 * direction of the third-person camera behind a +Z-forward character.
 *
 * @param yaw - Heading around +Y in radians.
 * @returns Unit-length [x, z] right vector.
 */
export function getPlayerRight(yaw: number): [number, number] {
  // The third-person camera sits behind +Z-forward characters. Its screen
  // right therefore points toward -X at yaw zero.
  return [-Math.cos(yaw), Math.sin(yaw)];
}

/**
 * Yaw derived from the current velocity direction, falling back to the last
 * known heading when the character is stationary.
 *
 * @param velocity - Current velocity vector [vx, vy, vz].
 * @param fallbackYaw - Heading to use when planar speed is below threshold.
 * @returns Movement-facing yaw in radians.
 */
export function getPlayerMovementFacingYaw(velocity: PlayerPosition, fallbackYaw: number) {
  const planarSpeed = Math.hypot(velocity[0], velocity[2]);
  return planarSpeed > 0.04 ? Math.atan2(velocity[0], velocity[2]) : fallbackYaw;
}

/**
 * Whether the third-person character mesh should be visible at the current
 * camera distance. Hides the mesh when the camera is too close to avoid
 * clipping through the character's head.
 *
 * @param cameraDistance - Current third-person camera distance in metres.
 * @param worldScale - World scale factor applied to the threshold.
 * @returns True when the character mesh should be rendered.
 */
export function shouldShowThirdPersonPlayer(cameraDistance: number, worldScale = 1) {
  return cameraDistance >= PLAYER_CONTROLLER_CONFIG.cameraHidePlayerDistance * Math.max(0.01, worldScale);
}

/**
 * Clamps the third-person camera distance so it never passes through a planar
 * obstacle between the target and the desired camera position.
 *
 * @param position - Target world position the camera orbits around.
 * @param yaw - Current heading for the camera's behind direction.
 * @param obstacles - Planar obstacles to check for occlusion.
 * @param desiredDistance - Preferred camera distance before clamping.
 * @returns Safe camera distance clamped between min and desired.
 */
export function getThirdPersonCameraDistance(
  position: PlayerPosition,
  yaw: number,
  obstacles: PlayerObstacle[],
  desiredDistance: number = PLAYER_CONTROLLER_CONFIG.cameraDistance,
) {
  const [forwardX, forwardZ] = getPlayerForward(yaw);
  const targetX = position[0];
  const targetZ = position[2];
  const endX = targetX - forwardX * desiredDistance;
  const endZ = targetZ - forwardZ * desiredDistance;
  let safeDistance = desiredDistance;

  for (const obstacle of obstacles) {
    if (!isPlanarPlayerObstacle(obstacle)) continue;
    const radius = Math.max(0, obstacle.radius) + PLAYER_CONTROLLER_CONFIG.cameraClearance;
    const hit = distanceToSegmentSquared(obstacle.position[0], obstacle.position[2], targetX, targetZ, endX, endZ);
    if (hit.t <= 0 || hit.distanceSquared >= radius * radius) continue;
    safeDistance = Math.min(safeDistance, desiredDistance * hit.t - radius);
  }

  return clamp(safeDistance, PLAYER_CONTROLLER_CONFIG.cameraMinDistance, desiredDistance);
}

function stepPlayerLocomotionStep({
  state,
  input,
  delta,
  groundHeight,
  groundEnabled,
  obstacles,
  playerRadius,
  speedScale,
}: {
  state: PlayerLocomotionState;
  input: PlayerInput;
  delta: number;
  groundHeight: number;
  groundEnabled: boolean;
  obstacles: PlayerObstacle[];
  playerRadius: number;
  speedScale: number;
}): PlayerLocomotionState {
  let { velocityX, velocityY, velocityZ, coyoteTimeRemaining, jumpBufferTimeRemaining } = resolvePlayerMotorIntent(
    state,
    input,
    delta,
    undefined,
    speedScale,
  );
  let nextY = state.position[1];
  let onGround = state.onGround;

  if (state.flying) {
    nextY += velocityY * delta;
    onGround = groundEnabled && nextY <= groundHeight;
    if (onGround) nextY = groundHeight;
    coyoteTimeRemaining = onGround ? PLAYER_CONTROLLER_CONFIG.coyoteTime : 0;
  } else {
    if (velocityY > 0) onGround = false;
    nextY += velocityY * delta;
    if (groundEnabled && nextY <= groundHeight) {
      nextY = groundHeight;
      velocityY = 0;
      onGround = true;
      coyoteTimeRemaining = PLAYER_CONTROLLER_CONFIG.coyoteTime;
    }
  }

  let nextX = state.position[0] + velocityX * delta;
  let nextZ = state.position[2] + velocityZ * delta;

  if (!state.flying) {
    const desiredX = nextX;
    const desiredZ = nextZ;
    const slideResolved = resolveCharacterMovement({
      currentPosition: [state.position[0], nextY, state.position[2]],
      desiredPosition: [nextX, nextY, nextZ],
      obstacles: toPlanarObstacles(obstacles, nextY),
      radius: playerRadius,
    });
    nextX = slideResolved[0];
    nextZ = slideResolved[2];
    const correctionX = nextX - desiredX;
    const correctionZ = nextZ - desiredZ;
    const correctionLength = Math.hypot(correctionX, correctionZ);
    if (correctionLength > 0.000001) {
      const normalX = correctionX / correctionLength;
      const normalZ = correctionZ / correctionLength;
      const velocityIntoSurface = velocityX * normalX + velocityZ * normalZ;
      if (velocityIntoSurface < 0) {
        velocityX -= normalX * velocityIntoSurface;
        velocityZ -= normalZ * velocityIntoSurface;
      }
    }
    const resolved = resolvePlanarCollisions({
      nextX,
      nextZ,
      velocityX,
      velocityZ,
      obstacles,
      playerFootY: nextY,
      playerRadius,
    });
    [nextX, nextZ] = resolved.position;
    [velocityX, velocityZ] = resolved.velocity;

    const supportY = findHighestWalkableSurfaceY(obstacles, nextX, nextZ, state.position[1]);
    if (velocityY <= 0 && supportY !== null && nextY <= supportY + 0.001) {
      nextY = supportY;
      velocityY = 0;
      onGround = true;
      coyoteTimeRemaining = PLAYER_CONTROLLER_CONFIG.coyoteTime;
    } else if (!groundEnabled || nextY > groundHeight + 0.001) {
      onGround = false;
    }
  }

  return {
    ...state,
    position: [nextX, nextY, nextZ],
    velocity: [velocityX, velocityY, velocityZ],
    onGround,
    jumpHeld: input.jump,
    coyoteTimeRemaining,
    jumpBufferTimeRemaining,
  };
}

/**
 * Advances the controller with small fixed-size steps. Rendering can still
 * stutter under load, but movement and collision response no longer lose most
 * of a long frame or change character feel with the display refresh rate.
 */
export function stepPlayerLocomotion({
  state,
  input,
  delta,
  groundHeight,
  groundEnabled = true,
  obstacles,
  playerRadius = PLAYER_CONTROLLER_CONFIG.playerRadius,
  speedScale = 1,
}: {
  state: PlayerLocomotionState;
  input: PlayerInput;
  delta: number;
  groundHeight: number;
  groundEnabled?: boolean;
  obstacles: PlayerObstacle[];
  playerRadius?: number;
  speedScale?: number;
}): PlayerLocomotionState {
  const totalDelta = clamp(Number.isFinite(delta) ? delta : 0, 0, MAX_SIMULATION_DELTA);
  const stepCount = Math.max(1, Math.ceil(totalDelta / MAX_SIMULATION_STEP));
  const stepDelta = totalDelta / stepCount;
  let next = state;

  for (let index = 0; index < stepCount; index += 1) {
    next = stepPlayerLocomotionStep({
      state: next,
      input,
      delta: stepDelta,
      groundHeight,
      groundEnabled,
      obstacles,
      playerRadius: Math.max(0, playerRadius),
      speedScale,
    });
  }

  return next;
}
