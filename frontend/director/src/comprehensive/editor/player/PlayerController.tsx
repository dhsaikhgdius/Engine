import { useFrame, useThree } from "@react-three/fiber";
import { clamp } from "../../../../../../packages/protocol/src/primitives";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { Euler, Matrix4, Object3D, Quaternion, Vector3, type PerspectiveCamera as ThreePerspectiveCamera } from "three";
import type { DirectorObject, DirectorTransform } from "../schema/directorProject";
import { useDirectorStore, type CameraShotSnapshot } from "../store/directorStore";
import {
  createPlayerLocomotionState,
  getPlayerForward,
  getPlayerMoveAxes,
  getPlayerMovementFacingYaw,
  getPlayerRight,
  PLAYER_CONTROLLER_CONFIG,
  PLAYER_ROAM_SPAWN_SNAP_BELOW_M,
  settlePlayerLocomotionOntoGround,
  stepPlayerLocomotion,
  type PlayerInput,
  type PlayerLocomotionState,
  type PlayerObstacle,
  type PlayerRuntimeStatus,
  type PlayerViewMode,
} from "./playerLocomotion";
import { selectNearestPlayerInteraction, type PlayerInteractionCandidate } from "./playerInteractions";
import { isPlayerCameraCollisionRoot, PlayerCameraCollisionProbe } from "./playerCameraCollision";
import { setPlayerCameraLookQuaternion } from "./playerCameraRig";
import {
  blocksPlayerKeyboardInput,
  createEmptyPlayerInput,
  createEmptyPlayerVehicleDriveInput,
  createPlayerDoubleTapTracker,
  getPlayerLookAxes,
  isPlayerLookKey,
  isPlayerMovementKey,
  isPlayerVehicleDriveKey,
  PLAYER_KEYBOARD_LOOK_PITCH_RAD_S,
  PLAYER_KEYBOARD_LOOK_YAW_RAD_S,
  PLAYER_VEHICLE_TOGGLE_CODE,
  registerPlayerDirectionTap,
  updatePlayerLookKey,
  updatePlayerMovementKey,
  updatePlayerVehicleDriveKey,
} from "./playerInput";
import {
  areVehicleCandidateListsEquivalent,
  collectPlayerVehicleCandidates,
  createPlayerVehicleSessionEntries,
  disposePlayerVehicleEntries,
  ensurePlayerVehicleRuntime,
  type PlayerVehicleCandidate,
  type PlayerVehicleSessionEntry,
} from "./playerVehicles";
import {
  getPlayerVehicleHudPhase,
  getVehicleChaseLookLead,
  getVehicleSeatWorldPosition,
  getVehicleSteerDirection,
  mapVehicleDriveControls,
  selectNearestEnterableVehicle,
  selectVehicleExitPose,
  stepVehicleSteerSmoothing,
  VEHICLE_EXIT_MAX_GROUND_DROP_M,
  VEHICLE_FALL_RESET_Y,
  type PlayerVehicleEnterCandidate,
} from "./playerVehicleSession";
import {
  getPlayerEmoteByCode,
  getPlayerEmoteByClipId,
  PLAYER_ROAM_EMOTES,
  type PlayerEmoteDefinition,
} from "./playerEmotes";
import {
  createEmptyPlayerGamepadFrame,
  createPlayerGamepadTracker,
  PLAYER_GAMEPAD_LOOK_PITCH_RAD_S,
  PLAYER_GAMEPAD_LOOK_YAW_RAD_S,
  pollPlayerGamepad,
} from "./playerGamepad";
import { PlayerRoamAudio } from "./playerRoamAudio";
import { resolveMixamoBones } from "../runtime/mixamo/mixamoCharacterRig";
import {
  advanceDirectorCharacterLocomotionClock,
  clearDirectorCharacterLocomotionRuntimeState,
  DIRECTOR_CHARACTER_LOCOMOTION_CROSSFADE_S,
  writeDirectorCharacterLocomotionRuntimeState,
  type DirectorCharacterLocomotionClock,
  type DirectorCharacterLocomotionMode,
} from "../runtime/mixamo/mixamoLocomotionRuntime";
import {
  createDirectorCharacterLocomotionMachineState,
  stepDirectorCharacterLocomotionMachine,
} from "../runtime/mixamo/mixamoLocomotionStateMachine";
import {
  CHARACTER_REFERENCE_HEIGHT,
  FollowPivotSpring,
  FollowTargetVerticalSmoother,
  FOLLOW_BANK_MAX_RADIANS,
  FOLLOW_BANK_RESPONSE,
  FOLLOW_GROUND_LIFT_FALL_RATE,
  FOLLOW_GROUND_LIFT_RISE_RATE,
  FOLLOW_SPEED_FOV_FRACTION,
  FOLLOW_VELOCITY_LEAD_SECONDS,
  applyFollowCameraZoomImpulse,
  computeFirstPersonCameraPose,
  computeThirdPersonCameraPose,
  deriveFollowCameraEntryPose,
  getCharacterScaleFactor,
  getFirstPersonForwardOffset,
  getScaledPlayerConfig,
  sampleFollowArmGroundLift,
  sanitizeFollowDelta,
  smoothCameraGroundFloor,
  stepAsymmetricExpDamp,
  stepFollowCameraDistance,
} from "./characterFollowRuntime";
import {
  DEFAULT_VIEWPORT_CHARACTER_MOVE_SPEED,
  DEFAULT_VIEWPORT_ROTATE_SENSITIVITY,
  DEFAULT_VIEWPORT_ZOOM_SENSITIVITY,
  normalizeViewportCharacterMoveSpeed,
  normalizeViewportSensitivity,
} from "../schema/viewportNavigation";
import { createRapierPlayerMotor, type RapierPlayerMotor } from "./rapierPlayerMotor";
import { buildPlayerCollisionMeshesFromFlatMeshes, hasPlayerCollisionGeometry } from "./playerCollisionMesh";
import {
  acceleratePlayerSceneRaycastBatch,
  collectPlayerRaycastMeshes,
  findPlayerCollisionRootsByDirectorObjectIds,
  getPlayerSceneRaycastMeshesNearSegment,
  registerPlayerSceneRaycastOwner,
  type PlayerRaycastMesh,
} from "./playerRaycastAcceleration";
import type { PlayerStaticEnvironment } from "./playerStaticEnvironment";

const CAMERA_POSITION_RESPONSE_SCALE = 2.6;
const CAMERA_TARGET_RESPONSE_SCALE = 2.4;
// Look is driven 1:1 from pointer deltas; this rate only closes residual
// error (gamepad frames, external yaw snaps) so the orbit never chases.
const CAMERA_VIEW_RESPONSE_SCALE = 8;
const CAMERA_ZOOM_RESPONSE_SCALE = 1.6;
const PLAYER_MAX_PITCH = 1.2;
const PLAYER_MIN_PITCH = -1.2;
const PLAYER_ROTATION_RESPONSE = 12;
const PLAYER_MOVEMENT_YAW_RESPONSE = 14;
const EXTERNAL_CAMERA_SNAP_DISTANCE = 12;
const WORLD_UP = new Vector3(0, 1, 0);
/** Aim (hold right mouse) game-feel tuning. */
const AIM_WEIGHT_RESPONSE = 14;
const AIM_FOV_SCALE = 0.7;
const AIM_LOOK_SENSITIVITY_SCALE = 0.55;
const AIM_DISTANCE_SCALE = 0.55;
const AIM_SHOULDER_OFFSET_M = 0.55;
const SPRINT_FOV_KICK_RESPONSE = 6;
/** Landing dip spring (critically-ish damped, slight overshoot). */
const LANDING_DIP_STIFFNESS = 170;
const LANDING_DIP_DAMPING = 16;
const LANDING_DIP_IMPULSE_SCALE = 0.014;
const LANDING_DIP_MIN_IMPACT_MPS = 3;
const LANDING_DIP_MAX_OFFSET_M = 0.24;
/** First-person head bob amplitudes at full run intensity. */
const HEAD_BOB_VERTICAL_M = 0.016;
const HEAD_BOB_LATERAL_M = 0.01;
/** Crossfade used when an emote starts, restarts, or is cancelled. */
const EMOTE_TRANSITION_S = 0.22;
/** Crouch camera feel: eye/target drop at full crouch, damped in/out. */
const CROUCH_WEIGHT_RESPONSE = 10;
const CROUCH_FIRST_PERSON_EYE_DROP_M = 0.3;
const CROUCH_THIRD_PERSON_TARGET_DROP_M = 0.16;

type PlayerEmotePlayback = {
  clipId: string;
  durationS: number;
  elapsedS: number;
  loop: "once" | "repeat";
  startedFrame: number;
};

/**
 * Publish the physical transform and locomotion sample before the default
 * priority skeletal runtime consumes them. A negative priority preserves
 * React Three Fiber's automatic render; non-negative takeover priorities do
 * not belong in the player controller.
 */
export const PLAYER_CONTROLLER_FRAME_PRIORITY = -100;

const BLOCKED_BLEND_VELOCITY_EPSILON_MPS = 0.04;
const MESH_COLLIDER_MOUNT_ATTEMPTS = 600;
const RAYCAST_BVH_IDLE_BATCH_SIZE = 32;
export const DIRECTOR_PROJECT_COLLISION_OWNER = "director-project";

export type MeshCollisionOwnerState = {
  committedVersionKey: string | null;
  degraded: boolean;
  degradedVersionKey: string | null;
  desiredVersionKey: string;
  generation: number;
  mountAttempts: number;
  pending: boolean;
};

type MeshColliderPrewarmTask = {
  generation: number;
  motor: RapierPlayerMotor;
  nextRaycastMeshIndex: number;
  ownerId: string;
  referenceRoot: Object3D;
  staticMeshes: PlayerRaycastMesh[];
  versionKey: string;
};

export function isCurrentMeshColliderBuild(
  task: { generation: number; motor: RapierPlayerMotor; versionKey: string },
  ownerState: { desiredVersionKey: string; generation: number },
  currentMotor: RapierPlayerMotor | null,
) {
  return (
    task.generation === ownerState.generation &&
    task.versionKey === ownerState.desiredVersionKey &&
    task.motor === currentMotor
  );
}

function createMeshCollisionOwnerState(): MeshCollisionOwnerState {
  return {
    committedVersionKey: null,
    degraded: false,
    degradedVersionKey: null,
    desiredVersionKey: "",
    generation: 0,
    mountAttempts: 0,
    pending: false,
  };
}

export function resetMeshCollisionOwnerForMotor(state: MeshCollisionOwnerState) {
  state.committedVersionKey = null;
  state.degraded = Boolean(state.desiredVersionKey) && state.degradedVersionKey === state.desiredVersionKey;
  state.generation += 1;
  state.mountAttempts = 0;
  state.pending = Boolean(state.desiredVersionKey) && !state.degraded;
}

export function shouldBlockForMeshColliderWarmup({
  degraded,
  hasMeshEnvironment,
  physicsAvailable,
  ready,
}: {
  degraded: boolean;
  hasMeshEnvironment: boolean;
  physicsAvailable: boolean;
  ready: boolean;
}) {
  return physicsAvailable && hasMeshEnvironment && !ready && !degraded;
}

/**
 * Suspend physical integration while an imported environment is still being
 * converted into its Rapier trimesh. Stepping an empty world here is unsafe:
 * with the optional editor ground hidden, gravity can move the actor far below
 * the authored spawn before the real Blender floor is available to snap to.
 *
 * Keyboard state remains live, but transient jump state is consumed so a tap
 * made during loading cannot fire several frames later. Camera look is handled
 * independently by the controller and therefore remains responsive.
 */
export function freezePlayerLocomotionForMeshColliderWarmup(
  state: PlayerLocomotionState,
  input: PlayerInput,
): PlayerLocomotionState {
  input.jumpPressed = false;
  return {
    ...state,
    position: [...state.position],
    velocity: [0, 0, 0],
    jumpHeld: input.jump,
    coyoteTimeRemaining: 0,
    jumpBufferTimeRemaining: 0,
  };
}

type PlayerCollisionIdleHandle = { id: number; kind: "idle" | "timeout" };
type PlayerCollisionIdleDeadline = { didTimeout: boolean; timeRemaining: () => number };

function schedulePlayerCollisionIdle(
  callback: (deadline: PlayerCollisionIdleDeadline) => void,
): PlayerCollisionIdleHandle {
  if (typeof window.requestIdleCallback === "function") {
    return { id: window.requestIdleCallback(callback, { timeout: 250 }), kind: "idle" };
  }
  return {
    id: window.setTimeout(() => callback({ didTimeout: true, timeRemaining: () => 0 }), 0),
    kind: "timeout",
  };
}

function cancelPlayerCollisionIdle(handle: PlayerCollisionIdleHandle | null) {
  if (!handle) return;
  if (handle.kind === "idle" && typeof window.cancelIdleCallback === "function") window.cancelIdleCallback(handle.id);
  else window.clearTimeout(handle.id);
}

function isTextEntryTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target.tagName);
}

function transformFromState(
  state: PlayerLocomotionState,
  source: DirectorTransform,
  rotationYaw = state.yaw,
): DirectorTransform {
  return {
    position: [state.position[0], state.position[1], state.position[2]],
    rotation: [source.rotation[0], rotationYaw, source.rotation[2]],
    scale: source.scale,
  };
}

function isTransformChanged(a: DirectorTransform | null, b: DirectorTransform) {
  if (!a) return true;
  return (
    a.position.some((value, index) => Math.abs(value - b.position[index]) > 0.0001) ||
    a.rotation.some((value, index) => Math.abs(value - b.rotation[index]) > 0.0001)
  );
}

function isAuthoredTransformChanged(a: DirectorTransform | null, b: DirectorTransform) {
  if (!a) return true;
  return isTransformChanged(a, b) || a.scale.some((value, index) => Math.abs(value - b.scale[index]) > 0.0001);
}

function cloneTransform(transform: DirectorTransform): DirectorTransform {
  return {
    position: [...transform.position] as DirectorTransform["position"],
    rotation: [...transform.rotation] as DirectorTransform["rotation"],
    scale: [...transform.scale] as DirectorTransform["scale"],
  };
}

function smoothFactor(rate: number, delta: number) {
  return 1 - Math.exp(-rate * Math.min(Math.max(delta, 0), 0.1));
}

function dampScalar(current: number, target: number, rate: number, delta: number) {
  return current + (target - current) * smoothFactor(rate, delta);
}

function dampAngle(current: number, target: number, rate: number, delta: number) {
  const difference = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return current + difference * smoothFactor(rate, delta);
}

export function PlayerController({
  collisionReferenceRoot,
  emoteRequest = null,
  enabled,
  flying,
  groundEnabled = true,
  groundHeight,
  interactionCandidates = [],
  liveEnvironment = null,
  obstacles,
  onCameraSnapshot,
  onControlActiveChange,
  onExitRequest,
  onFinished,
  onFlyingChange,
  onInteract,
  onRuntimeStatusChange,
  onTransformSample,
  onTransformCommit,
  onViewModeChange,
  player,
  rotateSensitivity = DEFAULT_VIEWPORT_ROTATE_SENSITIVITY,
  moveSpeedScale = DEFAULT_VIEWPORT_CHARACTER_MOVE_SPEED,
  viewMode,
  zoomSensitivity = DEFAULT_VIEWPORT_ZOOM_SENSITIVITY,
}: {
  collisionReferenceRoot: Object3D | null;
  /** HUD-initiated emote trigger; a new nonce starts (or restarts) the clip. */
  emoteRequest?: { clipId: string; nonce: number } | null;
  enabled: boolean;
  flying: boolean;
  groundEnabled?: boolean;
  groundHeight: number;
  interactionCandidates?: PlayerInteractionCandidate[];
  liveEnvironment?: PlayerStaticEnvironment | null;
  obstacles: PlayerObstacle[];
  onCameraSnapshot: (snapshot: CameraShotSnapshot) => void;
  onControlActiveChange?: (active: boolean) => void;
  onExitRequest: () => void;
  onFinished: () => void;
  onFlyingChange: (flying: boolean) => void;
  onInteract?: (objectId: string) => void;
  onRuntimeStatusChange?: (status: PlayerRuntimeStatus) => void;
  onTransformSample?: (id: string, transform: DirectorTransform) => void;
  onTransformCommit: (id: string, transform: DirectorTransform) => void;
  onViewModeChange: (viewMode: PlayerViewMode) => void;
  player: DirectorObject | null;
  /** Shared viewport rotate sensitivity so roam look matches editor feel. */
  rotateSensitivity?: number;
  /** Multiplier on walk/run/crouch/fly planar speed from View controls. */
  moveSpeedScale?: number;
  viewMode: PlayerViewMode;
  /** Shared viewport zoom sensitivity applied to follow-distance wheel. */
  zoomSensitivity?: number;
}) {
  const { camera, gl, scene } = useThree();
  const playerId = player?.id ?? null;
  const playerScaleX = player?.transform.scale[0] ?? 1;
  const playerScaleY = player?.transform.scale[1] ?? 1;
  const playerScaleZ = player?.transform.scale[2] ?? 1;
  const playerAssetRefId = player?.assetRefId ?? null;
  const controllerRef = useRef<PlayerLocomotionState | null>(null);
  const physicsMotorRef = useRef<RapierPlayerMotor | null>(null);
  const inputRef = useRef<PlayerInput>(createEmptyPlayerInput());
  const playerObjectRef = useRef<Object3D | null>(null);
  const playerHeadRef = useRef<Object3D | null>(null);
  const playerHeadAnchorLocalRef = useRef<Vector3 | null>(null);
  const controlledPlayerIdRef = useRef<string | null>(null);
  const lastTransformRef = useRef<DirectorTransform | null>(null);
  const observedPlayerTransformRef = useRef<DirectorTransform | null>(null);
  const observedPlayerAssetRefIdRef = useRef<string | null>(null);
  const pendingExternalTransformRef = useRef<{
    positionChanged: boolean;
    transform: DirectorTransform;
    yawChanged: boolean;
  } | null>(null);
  const activeRef = useRef(false);
  const playerRef = useRef(player);
  const obstaclesRef = useRef(obstacles);
  const flyingRef = useRef(flying);
  const viewModeRef = useRef(viewMode);
  const groundHeightRef = useRef(groundHeight);
  const onCameraSnapshotRef = useRef(onCameraSnapshot);
  const onControlActiveChangeRef = useRef(onControlActiveChange);
  const onExitRequestRef = useRef(onExitRequest);
  const onFinishedRef = useRef(onFinished);
  const onFlyingChangeRef = useRef(onFlyingChange);
  const onInteractRef = useRef(onInteract);
  const onRuntimeStatusChangeRef = useRef(onRuntimeStatusChange);
  const onTransformSampleRef = useRef(onTransformSample);
  const onTransformCommitRef = useRef(onTransformCommit);
  const onViewModeChangeRef = useRef(onViewModeChange);
  const targetRef = useRef(new Vector3());
  const smoothedTargetRef = useRef(new Vector3());
  const forwardRef = useRef(new Vector3());
  const cameraFrameForwardRef = useRef(new Vector3(0, 0, 1));
  const cameraFrameRightRef = useRef(new Vector3(1, 0, 0));
  const desiredCameraRef = useRef(new Vector3());
  const cameraCandidateRef = useRef(new Vector3());
  const cameraPivotRef = useRef(new Vector3());
  const lookTargetRef = useRef(new Vector3());
  const cameraRightRef = useRef(new Vector3(1, 0, 0));
  const cameraUpRef = useRef(new Vector3(0, 1, 0));
  const cameraAimMatrixRef = useRef(new Matrix4());
  const cameraAimQuaternionRef = useRef(new Quaternion());
  const cameraDirectionRef = useRef(new Vector3());
  const playerWorldPositionRef = useRef(new Vector3());
  const playerWorldScaleRef = useRef(new Vector3(1, 1, 1));
  const playerParentQuaternionRef = useRef(new Quaternion());
  const cameraWorldUpRef = useRef(new Vector3(0, 1, 0));
  const cameraGroundPointRef = useRef(new Vector3());
  const cameraDistanceRef = useRef<number>(PLAYER_CONTROLLER_CONFIG.cameraDistance);
  const preferredCameraDistanceRef = useRef<number>(PLAYER_CONTROLLER_CONFIG.cameraDistance);
  const cameraZoomTargetDistanceRef = useRef<number>(PLAYER_CONTROLLER_CONFIG.cameraDistance);
  const viewYawTargetRef = useRef(0);
  const viewYawRef = useRef(0);
  const viewPitchTargetRef = useRef(0);
  const cameraPitchRef = useRef(0);
  const meshColliderIdsRef = useRef<string[]>([]);
  const meshColliderBuildHandleRef = useRef<PlayerCollisionIdleHandle | null>(null);
  const meshColliderPrewarmTasksRef = useRef(new Map<string, MeshColliderPrewarmTask>());
  const meshCollisionOwnerStatesRef = useRef(
    new Map<string, MeshCollisionOwnerState>([[DIRECTOR_PROJECT_COLLISION_OWNER, createMeshCollisionOwnerState()]]),
  );
  const directorMeshSignatureRef = useRef("");
  const liveMeshSignatureRef = useRef("");
  const liveEnvironmentRef = useRef(liveEnvironment);
  const liveCollisionOwnerIdRef = useRef(liveEnvironment?.ownerId ?? "blender-live");
  const collisionReferenceRootRef = useRef(collisionReferenceRoot);
  const cameraCollisionProbeRef = useRef(new PlayerCameraCollisionProbe());
  const cameraRigInitializedRef = useRef(false);
  const previousViewModeRef = useRef<PlayerViewMode | null>(null);
  const locomotionRuntimeRef = useRef<DirectorCharacterLocomotionClock>({
    mode: "idle",
    timeS: 0,
    speedMps: 0,
    normalizedPhase: 0,
    playbackRate: 1,
  });
  const locomotionMachineRef = useRef(createDirectorCharacterLocomotionMachineState());
  const locomotionFrameRef = useRef(0);
  const locomotionTimeRef = useRef(0);
  const locomotionClipStartedFrameRef = useRef(0);
  const runtimeStatusElapsedRef = useRef(0);
  const collisionWarmupInputRef = useRef<PlayerInput>(createEmptyPlayerInput());
  const followTargetSmootherRef = useRef(new FollowTargetVerticalSmoother());
  const followPivotSpringRef = useRef(new FollowPivotSpring());
  const cameraRollRef = useRef(0);
  const cameraGroundLiftRef = useRef(0);
  const cameraRollQuatRef = useRef(new Quaternion());
  const followLeadRef = useRef(new Vector3());
  const visualYawRef = useRef(0);
  const pointerSensitivityRef = useRef(PLAYER_CONTROLLER_CONFIG.pointerSensitivity);
  const wheelZoomScaleRef = useRef(1);
  const moveSpeedScaleRef = useRef(DEFAULT_VIEWPORT_CHARACTER_MOVE_SPEED);
  const aimActiveRef = useRef(false);
  const aimWeightRef = useRef(0);
  const baseFovRef = useRef<number | null>(null);
  const fovKickRef = useRef(0);
  const landingDipOffsetRef = useRef(0);
  const landingDipVelocityRef = useRef(0);
  const dashTimerRef = useRef({ cooldownS: 0, remainingS: 0 });
  const dashRequestedRef = useRef(false);
  const doubleTapTrackerRef = useRef(createPlayerDoubleTapTracker());
  const emotePlaybackRef = useRef<PlayerEmotePlayback | null>(null);
  const pendingEmoteRef = useRef<PlayerEmoteDefinition | null>(null);
  const emoteRequestNonceRef = useRef<number | null>(null);
  const reducedMotionRef = useRef(false);
  const cameraFeelOffsetRef = useRef(new Vector3());
  const feelRightRef = useRef(new Vector3());
  const lastStatusAimingRef = useRef(false);
  const lastStatusEmoteRef = useRef<string | null>(null);
  const lastStatusCrouchingRef = useRef(false);
  const lastStatusSlowWalkingRef = useRef(false);
  const crouchWeightRef = useRef(0);
  const gamepadTrackerRef = useRef(createPlayerGamepadTracker());
  const gamepadFrameRef = useRef(createEmptyPlayerGamepadFrame());
  const gamepadMergedInputRef = useRef<PlayerInput>(createEmptyPlayerInput());
  const gamepadAimRef = useRef(false);
  const roamAudioRef = useRef<PlayerRoamAudio | null>(null);
  // Set by the input effect so the controller lifecycle can re-announce the
  // real activation state (e.g. after an in-mode actor switch) instead of
  // resetting the HUD to "inactive" while the canvas is still focused.
  const syncControlActiveRef = useRef<(() => void) | null>(null);
  // Live drivable-vehicle session state. Entries own the physics runtimes;
  // the remaining refs are per-frame interaction and chase-camera state.
  const vehicleEntriesRef = useRef<Map<string, PlayerVehicleSessionEntry>>(new Map());
  const activeVehicleIdRef = useRef<string | null>(null);
  const promptVehicleIdRef = useRef<string | null>(null);
  const vehicleDriveInputRef = useRef(createEmptyPlayerVehicleDriveInput());
  const vehicleSteerRef = useRef(0);
  const vehicleEnterRequestedRef = useRef(false);
  const vehicleExitRequestedRef = useRef(false);
  const vehicleGroupRef = useRef<Object3D | null>(null);
  const vehicleSeatScratchRef = useRef(new Vector3());
  const vehicleForwardScratchRef = useRef(new Vector3());
  const vehicleLookTargetRef = useRef(new Vector3());
  const vehicleSmoothedLookTargetRef = useRef(new Vector3());
  const vehicleDesiredCameraRef = useRef(new Vector3());
  const vehicleCameraCandidateRef = useRef(new Vector3());
  const vehicleCameraDirectionRef = useRef(new Vector3());
  const vehicleCameraRightRef = useRef(new Vector3(1, 0, 0));
  const vehicleCameraUpRef = useRef(new Vector3(0, 1, 0));
  const vehicleChaseInitializedRef = useRef(false);
  const vehicleYawEulerRef = useRef(new Euler());
  const vehicleEnterCandidatesScratchRef = useRef<PlayerVehicleEnterCandidate[]>([]);
  const lastStatusVehicleSignatureRef = useRef("");
  const interactionCandidatesRef = useRef(interactionCandidates);
  const promptInteractionRef = useRef<PlayerInteractionCandidate | null>(null);
  const lastStatusInteractionIdRef = useRef<string | null>(null);

  // Drivable vehicles are read straight from the project store: the obstacle
  // prop cannot carry vehicle profiles, and the session must know these
  // objects to pull them out of static collision and give them physics bodies.
  const projectObjects = useDirectorStore((state) => state.project.objects);
  const vehicleCandidatesRef = useRef<PlayerVehicleCandidate[]>([]);
  const collectedVehicleCandidates = useMemo(
    () => (enabled ? collectPlayerVehicleCandidates(projectObjects) : []),
    [enabled, projectObjects],
  );
  if (!areVehicleCandidateListsEquivalent(vehicleCandidatesRef.current, collectedVehicleCandidates)) {
    vehicleCandidatesRef.current = collectedVehicleCandidates;
  }
  const vehicleCandidates = vehicleCandidatesRef.current;
  const vehicleObjectIds = useMemo(
    () => new Set(vehicleCandidates.map((candidate) => candidate.id)),
    [vehicleCandidates],
  );
  // A drivable vehicle must not be baked into the static collision mesh: its
  // dynamic chassis (injected into the same Rapier world) takes over both
  // character blocking and, while driven, movement.
  const effectiveObstacles = useMemo(
    () =>
      vehicleObjectIds.size
        ? obstacles.filter((obstacle) => !obstacle.id || !vehicleObjectIds.has(obstacle.id))
        : obstacles,
    [obstacles, vehicleObjectIds],
  );

  playerRef.current = player;
  pointerSensitivityRef.current =
    PLAYER_CONTROLLER_CONFIG.pointerSensitivity *
    (normalizeViewportSensitivity(rotateSensitivity, DEFAULT_VIEWPORT_ROTATE_SENSITIVITY) /
      DEFAULT_VIEWPORT_ROTATE_SENSITIVITY);
  wheelZoomScaleRef.current =
    normalizeViewportSensitivity(zoomSensitivity, DEFAULT_VIEWPORT_ZOOM_SENSITIVITY) /
    DEFAULT_VIEWPORT_ZOOM_SENSITIVITY;
  moveSpeedScaleRef.current = normalizeViewportCharacterMoveSpeed(moveSpeedScale);
  obstaclesRef.current = effectiveObstacles;
  liveEnvironmentRef.current = liveEnvironment;
  collisionReferenceRootRef.current = collisionReferenceRoot;
  flyingRef.current = flying;
  viewModeRef.current = viewMode;
  groundHeightRef.current = groundHeight;
  onCameraSnapshotRef.current = onCameraSnapshot;
  onControlActiveChangeRef.current = onControlActiveChange;
  onExitRequestRef.current = onExitRequest;
  onFinishedRef.current = onFinished;
  onFlyingChangeRef.current = onFlyingChange;
  onInteractRef.current = onInteract;
  onRuntimeStatusChangeRef.current = onRuntimeStatusChange;
  onTransformSampleRef.current = onTransformSample;
  onTransformCommitRef.current = onTransformCommit;
  onViewModeChangeRef.current = onViewModeChange;
  interactionCandidatesRef.current = interactionCandidates;

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedMotionRef.current = query.matches;
    const handleChange = (event: MediaQueryListEvent) => {
      reducedMotionRef.current = event.matches;
    };
    query.addEventListener?.("change", handleChange);
    return () => query.removeEventListener?.("change", handleChange);
  }, []);

  useEffect(() => {
    if (!enabled || !emoteRequest || emoteRequest.nonce === emoteRequestNonceRef.current) return;
    emoteRequestNonceRef.current = emoteRequest.nonce;
    pendingEmoteRef.current = getPlayerEmoteByClipId(emoteRequest.clipId);
  }, [emoteRequest, enabled]);

  function getMeshCollisionOwnerState(ownerId: string) {
    let state = meshCollisionOwnerStatesRef.current.get(ownerId);
    if (!state) {
      state = createMeshCollisionOwnerState();
      meshCollisionOwnerStatesRef.current.set(ownerId, state);
    }
    return state;
  }

  function cancelMeshColliderPrewarm(ownerId?: string) {
    cancelPlayerCollisionIdle(meshColliderBuildHandleRef.current);
    meshColliderBuildHandleRef.current = null;
    if (ownerId) meshColliderPrewarmTasksRef.current.delete(ownerId);
    else meshColliderPrewarmTasksRef.current.clear();
    if (meshColliderPrewarmTasksRef.current.size) scheduleMeshColliderPrewarm();
  }

  function degradeMeshCollision(ownerId: string, reason: string, cause?: unknown) {
    const state = getMeshCollisionOwnerState(ownerId);
    if (!state.degraded) {
      console.warn(`[Director] Imported-scene collision degraded: ${reason}`, cause ?? "");
    }
    state.degraded = true;
    state.degradedVersionKey = state.desiredVersionKey || null;
    state.pending = false;
    meshColliderPrewarmTasksRef.current.delete(ownerId);
  }

  function scheduleMeshColliderPrewarm() {
    if (meshColliderBuildHandleRef.current || meshColliderPrewarmTasksRef.current.size === 0) return;
    meshColliderBuildHandleRef.current = schedulePlayerCollisionIdle(runMeshColliderPrewarm);
  }

  function runMeshColliderPrewarm(deadline: PlayerCollisionIdleDeadline) {
    meshColliderBuildHandleRef.current = null;
    const task = meshColliderPrewarmTasksRef.current.values().next().value as MeshColliderPrewarmTask | undefined;
    if (!task) return;
    const ownerState = getMeshCollisionOwnerState(task.ownerId);
    if (!isCurrentMeshColliderBuild(task, ownerState, physicsMotorRef.current)) {
      meshColliderPrewarmTasksRef.current.delete(task.ownerId);
      scheduleMeshColliderPrewarm();
      return;
    }

    try {
      let batchCount = 0;
      do {
        const batch = acceleratePlayerSceneRaycastBatch(
          task.staticMeshes,
          task.nextRaycastMeshIndex,
          RAYCAST_BVH_IDLE_BATCH_SIZE,
        );
        task.nextRaycastMeshIndex = batch.nextIndex;
        batchCount += 1;
      } while (task.nextRaycastMeshIndex < task.staticMeshes.length && batchCount < 4 && deadline.timeRemaining() > 2);
    } catch (error) {
      degradeMeshCollision(task.ownerId, "BVH prewarm failed", error);
      scheduleMeshColliderPrewarm();
      return;
    }

    if (task.nextRaycastMeshIndex < task.staticMeshes.length) {
      scheduleMeshColliderPrewarm();
      return;
    }

    try {
      const collisionMeshes = buildPlayerCollisionMeshesFromFlatMeshes(task.staticMeshes, task.referenceRoot);
      if (!collisionMeshes.length) throw new Error("Imported scene has no collision triangles.");
      task.motor.replaceMeshEnvironment(task.ownerId, collisionMeshes);
      const controller = controllerRef.current;
      if (controller) {
        controllerRef.current = settlePlayerLocomotionOntoGround(
          task.motor.snapStateToWalkableSurface(
            controller,
            PLAYER_CONTROLLER_CONFIG.stepHeight + PLAYER_CONTROLLER_CONFIG.groundSnapDistance,
            PLAYER_ROAM_SPAWN_SNAP_BELOW_M,
          ),
          {
            groundEnabled,
            groundHeight: groundHeightRef.current,
            obstacles: obstaclesRef.current,
          },
        );
      }
      ownerState.committedVersionKey = task.versionKey;
      ownerState.degraded = false;
      ownerState.degradedVersionKey = null;
      ownerState.pending = false;
    } catch (error) {
      // Atomic owner replacement keeps the last known-good collider active.
      degradeMeshCollision(task.ownerId, "collision mesh build failed", error);
    } finally {
      meshColliderPrewarmTasksRef.current.delete(task.ownerId);
      scheduleMeshColliderPrewarm();
    }
  }

  function getVehicleObjectGroup(vehicleId: string): Object3D | null {
    if (typeof scene.getObjectByName !== "function") return null;
    return scene.getObjectByName(`director-object-${vehicleId}`) ?? null;
  }

  function resetVehicleInteractionState() {
    activeVehicleIdRef.current = null;
    promptVehicleIdRef.current = null;
    promptInteractionRef.current = null;
    vehicleDriveInputRef.current = createEmptyPlayerVehicleDriveInput();
    vehicleSteerRef.current = 0;
    vehicleEnterRequestedRef.current = false;
    vehicleExitRequestedRef.current = false;
    vehicleGroupRef.current = null;
    vehicleChaseInitializedRef.current = false;
  }

  /**
   * Releases every vehicle physics runtime. Must run while the shared Rapier
   * world is still alive. Render groups return to their session spawn pose so
   * the untouched project document and the viewport agree again; while the
   * session runs, an exited vehicle keeps its final driven pose.
   */
  function disposeVehicleSession() {
    disposePlayerVehicleEntries(vehicleEntriesRef.current, (entry) => {
      const group = getVehicleObjectGroup(entry.candidate.id);
      if (!group) return;
      group.position.copy(entry.spawnPosition);
      group.quaternion.copy(entry.spawnQuaternion);
      group.updateWorldMatrix(true, false);
    });
    resetVehicleInteractionState();
  }

  useEffect(() => {
    if (!enabled) return;
    vehicleEntriesRef.current = createPlayerVehicleSessionEntries(vehicleCandidates);
    resetVehicleInteractionState();
    return () => {
      // The motor lifecycle also disposes vehicles before freeing its world;
      // this cleanup covers candidate-set changes while the motor survives.
      disposeVehicleSession();
      vehicleEntriesRef.current = new Map();
    };
    // The dispose helpers operate entirely on refs; candidate identity is the
    // only lifecycle boundary for the vehicle registry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, vehicleCandidates]);

  /**
   * Eager runtime creation, retried per frame: each vehicle builds its physics
   * body as soon as the shared world exists and its render meshes are mounted
   * (see playerVehicles.ts for why eager beats first-enter creation).
   */
  function ensureVehicleRuntimes() {
    const binding = physicsMotorRef.current?.getVehicleWorldBinding() ?? null;
    if (!binding) return;
    for (const entry of vehicleEntriesRef.current.values()) {
      if (entry.status !== "pending") continue;
      ensurePlayerVehicleRuntime(entry, getVehicleObjectGroup(entry.candidate.id), binding);
    }
  }

  function updateVehicleEnterPrompt(controller: PlayerLocomotionState) {
    if (controller.flying || vehicleEntriesRef.current.size === 0) {
      promptVehicleIdRef.current = null;
      return;
    }
    const candidates = vehicleEnterCandidatesScratchRef.current;
    candidates.length = 0;
    const seatScratch = vehicleSeatScratchRef.current;
    for (const entry of vehicleEntriesRef.current.values()) {
      if (entry.status !== "ready" || !entry.runtime) continue;
      const seat = getVehicleSeatWorldPosition(
        entry.pose.position,
        entry.pose.quaternion,
        entry.candidate.profile.seatOffset,
        seatScratch,
      );
      candidates.push({ id: entry.candidate.id, enterable: true, seatPosition: [seat.x, seat.y, seat.z] });
    }
    promptVehicleIdRef.current = selectNearestEnterableVehicle(controller.position, candidates);
  }

  function tryEnterPromptVehicle() {
    vehicleEnterRequestedRef.current = false;
    const motor = physicsMotorRef.current;
    const vehicleId = promptVehicleIdRef.current;
    if (!motor || !vehicleId) return;
    const entry = vehicleEntriesRef.current.get(vehicleId);
    if (!entry || entry.status !== "ready" || !entry.runtime) return;
    activeVehicleIdRef.current = vehicleId;
    promptVehicleIdRef.current = null;
    vehicleGroupRef.current = null;
    vehicleSteerRef.current = 0;
    vehicleDriveInputRef.current = createEmptyPlayerVehicleDriveInput();
    vehicleExitRequestedRef.current = false;
    vehicleChaseInitializedRef.current = false;
    inputRef.current = createEmptyPlayerInput();
    cameraFeelOffsetRef.current.set(0, 0, 0);
    // Park the character: a kinematic (infinite-mass) capsule left inside the
    // chassis would deadlock the dynamic vehicle body.
    motor.setCharacterColliderEnabled(false);
  }

  /**
   * Exits through the profile's ordered exit offsets. When every probe is
   * blocked or hangs over a drop, the character stays seated (the request is
   * simply dropped) exactly like slamming a door against a wall.
   */
  function tryExitActiveVehicle(entry: PlayerVehicleSessionEntry, motor: RapierPlayerMotor): boolean {
    const scaleY = Math.max(0.01, Math.abs(playerRef.current?.transform.scale[1] ?? 1));
    const probeRadius = getScaledPlayerConfig(PLAYER_CONTROLLER_CONFIG.playerHeight * scaleY).playerRadius;
    const exitPose = selectVehicleExitPose({
      exitOffsets: entry.candidate.profile.exitOffsets,
      vehiclePosition: entry.pose.position,
      vehicleQuaternion: entry.pose.quaternion,
      isBlocked: (probe) =>
        motor.isPointInsideStaticCollision(probe.x, probe.y + probeRadius + 0.05, probe.z, probeRadius),
      findGroundYBelow: (probe) =>
        motor.findStaticGroundYBelow(probe.x, probe.y, probe.z, VEHICLE_EXIT_MAX_GROUND_DROP_M),
    });
    if (!exitPose) return false;
    const vehicleYaw = vehicleYawEulerRef.current.setFromQuaternion(entry.pose.quaternion, "YXZ").y;
    motor.setCharacterColliderEnabled(true);
    const rebound = createPlayerLocomotionState(
      exitPose.position,
      vehicleYaw,
      groundEnabled ? groundHeightRef.current : exitPose.position[1],
    );
    rebound.flying = false;
    rebound.pitch = controllerRef.current?.pitch ?? rebound.pitch;
    controllerRef.current = settlePlayerLocomotionOntoGround(
      motor.snapStateToWalkableSurface(
        rebound,
        PLAYER_CONTROLLER_CONFIG.stepHeight + PLAYER_CONTROLLER_CONFIG.groundSnapDistance,
        PLAYER_ROAM_SPAWN_SNAP_BELOW_M,
      ),
      {
        groundEnabled,
        groundHeight: groundHeightRef.current,
        obstacles: obstaclesRef.current,
      },
    );
    visualYawRef.current = vehicleYaw;
    viewYawTargetRef.current = vehicleYaw;
    viewYawRef.current = vehicleYaw;
    followTargetSmootherRef.current.reset();
    // Hand the walking rig the chase camera's live look target so the camera
    // damps over instead of snapping; the vehicle keeps its final pose.
    smoothedTargetRef.current.copy(vehicleSmoothedLookTargetRef.current);
    activeVehicleIdRef.current = null;
    vehicleDriveInputRef.current = createEmptyPlayerVehicleDriveInput();
    vehicleSteerRef.current = 0;
    vehicleChaseInitializedRef.current = false;
    vehicleGroupRef.current = null;
    return true;
  }

  /**
   * One driving frame: controls, physics step, pose write-back, parked
   * character follow, chase camera, HUD status. Owns the whole frame while
   * active; the walking pipeline is skipped entirely.
   */
  function driveActiveVehicleFrame(currentPlayer: DirectorObject, frameDelta: number) {
    const motor = physicsMotorRef.current;
    const vehicleId = activeVehicleIdRef.current;
    if (!motor || !vehicleId) return;
    const entry = vehicleEntriesRef.current.get(vehicleId);
    if (!entry || entry.status !== "ready" || !entry.runtime) {
      // Runtime disappeared under us (motor rebuild or candidate change):
      // restore the on-foot state and let the next frame walk normally.
      motor.setCharacterColliderEnabled(true);
      resetVehicleInteractionState();
      return;
    }
    const runtime = entry.runtime;

    if (vehicleExitRequestedRef.current) {
      vehicleExitRequestedRef.current = false;
      if (tryExitActiveVehicle(entry, motor)) return;
    }

    // Drive-step ordering. The physics runtime documents its world-stepping
    // contract at the top of rapierVehicleRuntime.ts; keep these numbered
    // stages adjacent so reordering stays a local edit.
    // 1) Map held keys onto the control contract; W/S throttle-vs-brake
    //    semantics read the forward speed of the previous step.
    const driveInput = vehicleDriveInputRef.current;
    vehicleSteerRef.current = stepVehicleSteerSmoothing(
      vehicleSteerRef.current,
      getVehicleSteerDirection(driveInput),
      frameDelta,
    );
    const controls = mapVehicleDriveControls({
      input: driveInput,
      steer: vehicleSteerRef.current,
      forwardSpeedMps: runtime.readTelemetry().forwardSpeedMps,
    });
    // 2) Advance the shared world through the runtime's fixed internal substep.
    runtime.step(controls, frameDelta);
    // 3) Read the stepped pose back for rendering and interaction.
    runtime.readPose(entry.pose);

    // Fall guard: a chassis that left the world respawns at its session spawn.
    if (entry.pose.position.y < VEHICLE_FALL_RESET_Y) {
      runtime.reset(entry.spawnPosition, entry.spawnYaw);
      runtime.readPose(entry.pose);
    }

    const vehicleObjectName = `director-object-${vehicleId}`;
    const vehicleGroup =
      vehicleGroupRef.current?.name === vehicleObjectName ? vehicleGroupRef.current : getVehicleObjectGroup(vehicleId);
    vehicleGroupRef.current = vehicleGroup;
    if (vehicleGroup) {
      vehicleGroup.position.copy(entry.pose.position);
      vehicleGroup.quaternion.copy(entry.pose.quaternion);
      vehicleGroup.updateWorldMatrix(true, false);
    }

    const vehicleYaw = vehicleYawEulerRef.current.setFromQuaternion(entry.pose.quaternion, "YXZ").y;
    const seat = getVehicleSeatWorldPosition(
      entry.pose.position,
      entry.pose.quaternion,
      entry.candidate.profile.seatOffset,
      vehicleSeatScratchRef.current,
    );

    // The hidden character rides the seat so exit restores from a sane pose
    // and the session-end transform commit stays meaningful.
    const controller = controllerRef.current;
    if (controller) {
      controller.position[0] = seat.x;
      controller.position[1] = seat.y;
      controller.position[2] = seat.z;
      controller.velocity[0] = 0;
      controller.velocity[1] = 0;
      controller.velocity[2] = 0;
      controller.onGround = true;
      controller.yaw = vehicleYaw;
    }
    visualYawRef.current = vehicleYaw;
    viewYawTargetRef.current = vehicleYaw;
    viewYawRef.current = vehicleYaw;

    const playerObjectName = `director-object-${currentPlayer.id}`;
    const playerObject =
      playerObjectRef.current?.name === playerObjectName
        ? playerObjectRef.current
        : typeof scene.getObjectByName === "function"
          ? (scene.getObjectByName(playerObjectName) ?? null)
          : null;
    playerObjectRef.current = playerObject;
    if (playerObject) {
      playerObject.position.set(seat.x, seat.y, seat.z);
      playerObject.rotation.set(currentPlayer.transform.rotation[0], vehicleYaw, currentPlayer.transform.rotation[2]);
      playerObject.visible = false;
    }
    // Recording attribution: while driving, the performance belongs to the
    // vehicle object. The hidden seat-riding character must not receive a
    // baked track that would fight the car's own animation after exit; the
    // recorder takes scale/tilt from the actor's authored transform, so only
    // position and yaw matter here.
    onTransformSampleRef.current?.(vehicleId, {
      position: [entry.pose.position.x, entry.pose.position.y, entry.pose.position.z],
      rotation: [0, vehicleYaw, 0],
      scale: [1, 1, 1],
    });

    // Chase camera: boom from the vehicle profile, look lead along travel,
    // damping and obstruction handling shared with the follow rig.
    const telemetry = runtime.readTelemetry();
    const profileCamera = entry.candidate.profile.camera;
    const forward = vehicleForwardScratchRef.current.set(0, 0, 1).applyQuaternion(entry.pose.quaternion);
    forward.y = 0;
    if (forward.lengthSq() < 0.000001) forward.set(Math.sin(vehicleYaw), 0, Math.cos(vehicleYaw));
    forward.normalize();
    const lookTarget = vehicleLookTargetRef.current
      .copy(entry.pose.position)
      .addScaledVector(forward, getVehicleChaseLookLead(telemetry.forwardSpeedMps))
      .addScaledVector(WORLD_UP, profileCamera.chaseHeightM * 0.5);
    const desired = vehicleDesiredCameraRef.current
      .copy(entry.pose.position)
      .addScaledVector(forward, -profileCamera.chaseDistanceM)
      .addScaledVector(WORLD_UP, profileCamera.chaseHeightM);

    const workingCamera = camera as ThreePerspectiveCamera;
    const cameraSmoothing = Math.max(1, PLAYER_CONTROLLER_CONFIG.followSmoothing);
    const smoothedLookTarget = vehicleSmoothedLookTargetRef.current;
    const cameraCandidate = vehicleCameraCandidateRef.current;
    if (!vehicleChaseInitializedRef.current) {
      vehicleChaseInitializedRef.current = true;
      smoothedLookTarget.copy(lookTarget);
      cameraCandidate.copy(desired);
    } else {
      smoothedLookTarget.lerp(lookTarget, smoothFactor(cameraSmoothing * CAMERA_TARGET_RESPONSE_SCALE, frameDelta));
      cameraCandidate
        .copy(workingCamera.position)
        .lerp(desired, smoothFactor(cameraSmoothing * CAMERA_POSITION_RESPONSE_SCALE, frameDelta));
    }
    const cameraDirection = vehicleCameraDirectionRef.current.copy(cameraCandidate).sub(smoothedLookTarget);
    const fullCameraDistance = cameraDirection.length();
    if (fullCameraDistance > 0.0001) cameraDirection.multiplyScalar(1 / fullCameraDistance);
    else cameraDirection.set(0, 0, 1);
    const cameraRight = vehicleCameraRightRef.current.crossVectors(WORLD_UP, cameraDirection);
    if (cameraRight.lengthSq() < 0.0001) cameraRight.set(1, 0, 0);
    else cameraRight.normalize();
    const cameraUp = vehicleCameraUpRef.current.crossVectors(cameraRight, cameraDirection);
    if (cameraUp.lengthSq() < 0.0001) cameraUp.copy(WORLD_UP);
    else cameraUp.normalize();
    const safeDistance = cameraCollisionProbeRef.current.getSafeDistance({
      target: smoothedLookTarget,
      desiredPosition: cameraCandidate,
      right: cameraRight,
      up: cameraUp,
      colliders: getPlayerSceneRaycastMeshesNearSegment(
        scene,
        smoothedLookTarget,
        cameraCandidate,
        PLAYER_CONTROLLER_CONFIG.cameraClearance + 0.24,
      ),
      clearance: PLAYER_CONTROLLER_CONFIG.cameraClearance,
      minimumNearDistance: Math.max(0.01, workingCamera.near),
    });
    const cameraObstructed = safeDistance < fullCameraDistance - 0.001;
    if (cameraObstructed && fullCameraDistance > 0.0001) {
      cameraCandidate.copy(smoothedLookTarget).addScaledVector(cameraDirection, safeDistance);
    }
    workingCamera.up.copy(WORLD_UP);
    workingCamera.position.copy(cameraCandidate);
    workingCamera.quaternion.copy(
      setPlayerCameraLookQuaternion({
        matrix: cameraAimMatrixRef.current,
        position: workingCamera.position,
        quaternion: cameraAimQuaternionRef.current,
        target: smoothedLookTarget,
        up: WORLD_UP,
      }),
    );
    workingCamera.updateMatrixWorld();
    // Keep the exit-time camera handoff continuous for the walking rig.
    smoothedTargetRef.current.copy(smoothedLookTarget);
    cameraDistanceRef.current = workingCamera.position.distanceTo(smoothedLookTarget);

    runtimeStatusElapsedRef.current += frameDelta;
    const vehicleSignature = `driving:${vehicleId}`;
    const vehicleStatusChanged = vehicleSignature !== lastStatusVehicleSignatureRef.current;
    if (vehicleStatusChanged || runtimeStatusElapsedRef.current >= 0.2) {
      runtimeStatusElapsedRef.current = 0;
      lastStatusVehicleSignatureRef.current = vehicleSignature;
      onRuntimeStatusChangeRef.current?.({
        aiming: false,
        cameraDistance: cameraDistanceRef.current,
        cameraObstructed,
        cameraPosition: [workingCamera.position.x, workingCamera.position.y, workingCamera.position.z],
        emoteClipId: null,
        playerPosition: [seat.x, seat.y, seat.z],
        playerVisible: false,
        targetPosition: [smoothedLookTarget.x, smoothedLookTarget.y, smoothedLookTarget.z],
        vehicle: { phase: "driving", vehicleName: entry.candidate.name, speedKph: telemetry.speedKph },
        viewMode: "third",
      });
    }
  }

  useEffect(() => {
    if (!enabled || !player) return;
    // Bind this controller lifetime to the actor that created it. `playerRef`
    // intentionally tracks live props, so reading it during cleanup after an
    // A -> B switch would otherwise commit A's controller state to B.
    const controlledPlayer = player;
    const controlledPlayerId = player.id;
    const authoredYaw = controlledPlayer.transform.rotation[1];
    const roamGroundHeight = groundHeightRef.current;
    const spawned = createPlayerLocomotionState(
      controlledPlayer.transform.position,
      authoredYaw,
      groundEnabled ? roamGroundHeight : controlledPlayer.transform.position[1],
    );
    spawned.flying = flyingRef.current;
    const initial = settlePlayerLocomotionOntoGround(spawned, {
      groundEnabled,
      groundHeight: roamGroundHeight,
      obstacles: obstaclesRef.current,
    });
    // Continue the shot the user was already framing: derive the follow orbit
    // from the live editor camera instead of snapping behind the actor. The
    // actor keeps its authored facing until the first movement input.
    const entryPose = deriveFollowCameraEntryPose({
      actorPosition: initial.position,
      actorYaw: initial.yaw,
      cameraPosition: [camera.position.x, camera.position.y, camera.position.z],
      characterHeight:
        PLAYER_CONTROLLER_CONFIG.playerHeight * Math.max(0.01, Math.abs(controlledPlayer.transform.scale[1])),
      fallbackDistance: PLAYER_CONTROLLER_CONFIG.cameraDistance,
      fallbackPitch: initial.pitch,
      maxPitch: PLAYER_MAX_PITCH,
      minPitch: PLAYER_MIN_PITCH,
    });
    initial.yaw = entryPose.viewYaw;
    initial.pitch = entryPose.viewPitch;
    controllerRef.current = initial;
    inputRef.current = createEmptyPlayerInput();
    lastTransformRef.current = transformFromState(initial, controlledPlayer.transform, authoredYaw);
    observedPlayerTransformRef.current = cloneTransform(controlledPlayer.transform);
    observedPlayerAssetRefIdRef.current = controlledPlayer.assetRefId ?? null;
    pendingExternalTransformRef.current = null;
    playerObjectRef.current = null;
    playerHeadRef.current = null;
    playerHeadAnchorLocalRef.current = null;
    smoothedTargetRef.current.set(
      initial.position[0],
      initial.position[1] + PLAYER_CONTROLLER_CONFIG.cameraLookHeight,
      initial.position[2],
    );
    cameraDistanceRef.current = entryPose.preferredDistance;
    preferredCameraDistanceRef.current = entryPose.preferredDistance;
    cameraZoomTargetDistanceRef.current = entryPose.preferredDistance;
    viewYawTargetRef.current = initial.yaw;
    viewYawRef.current = initial.yaw;
    viewPitchTargetRef.current = initial.pitch;
    cameraPitchRef.current = initial.pitch;
    locomotionRuntimeRef.current = {
      mode: "idle",
      timeS: 0,
      speedMps: 0,
      normalizedPhase: 0,
      playbackRate: 1,
    };
    createDirectorCharacterLocomotionMachineState(0, 0, locomotionMachineRef.current);
    locomotionFrameRef.current = 0;
    locomotionTimeRef.current = 0;
    locomotionClipStartedFrameRef.current = 0;
    runtimeStatusElapsedRef.current = 0;
    visualYawRef.current = authoredYaw;
    followTargetSmootherRef.current.reset();
    cameraRigInitializedRef.current = false;
    previousViewModeRef.current = null;
    controlledPlayerIdRef.current = controlledPlayerId;
    activeRef.current = true;
    aimActiveRef.current = false;
    aimWeightRef.current = 0;
    fovKickRef.current = 0;
    landingDipOffsetRef.current = 0;
    landingDipVelocityRef.current = 0;
    dashTimerRef.current = { cooldownS: 0, remainingS: 0 };
    dashRequestedRef.current = false;
    doubleTapTrackerRef.current = createPlayerDoubleTapTracker();
    emotePlaybackRef.current = null;
    pendingEmoteRef.current = null;
    const cameraDirection = cameraDirectionRef.current;
    const perspectiveCamera = camera as ThreePerspectiveCamera;
    const originalCameraNear = perspectiveCamera.near;
    const originalCameraUp = perspectiveCamera.up.clone();
    // Roam owns the lens: sprint kick and aim zoom mutate camera.fov, so the
    // authored editor FOV is restored (and snapshotted) on the way out.
    const originalCameraFov = perspectiveCamera.fov;
    baseFovRef.current = originalCameraFov;
    // The Vector3 instance is stable for the controller lifetime and is
    // updated in place by the follow rig. Capturing that instance here lets
    // teardown read its final coordinates without depending on a mutable ref.
    const exitCameraTarget = smoothedTargetRef.current;
    perspectiveCamera.near = Math.min(perspectiveCamera.near, 0.04);
    perspectiveCamera.updateProjectionMatrix();
    // Re-announce the live activation state. Switching the controlled actor
    // re-runs this effect while the canvas keeps focus, and forcing "inactive"
    // here would desynchronize the HUD from the still-working keyboard.
    if (syncControlActiveRef.current) syncControlActiveRef.current();
    else onControlActiveChangeRef.current?.(false);

    return () => {
      const continuingWithAnotherPlayer =
        enabled && Boolean(playerRef.current && playerRef.current.id !== controlledPlayerId);
      const currentPlayer = playerRef.current?.id === controlledPlayerId ? playerRef.current : controlledPlayer;
      const controller = controllerRef.current;
      if (activeRef.current && controller) {
        const finalTransform = transformFromState(controller, currentPlayer.transform, visualYawRef.current);
        if (isTransformChanged(lastTransformRef.current, finalTransform)) {
          onTransformCommitRef.current(controlledPlayerId, finalTransform);
        }
        let target: Vector3;
        if (cameraRigInitializedRef.current) {
          // Hand the editor orbit rig the same world-space pivot that the live
          // follow camera was actually looking at. Replacing it with an
          // arbitrary point one metre in front of the camera collapses the
          // OrbitControls radius on exit, so wheel zoom-in immediately hits
          // minDistance and appears to have stopped working.
          target = exitCameraTarget;
        } else {
          perspectiveCamera.getWorldDirection(cameraDirection);
          target = cameraDirection.add(perspectiveCamera.position);
        }
        onCameraSnapshotRef.current({
          fov: originalCameraFov,
          position: [perspectiveCamera.position.x, perspectiveCamera.position.y, perspectiveCamera.position.z],
          target: [target.x, target.y, target.z],
        });
      }
      if (playerObjectRef.current) {
        playerObjectRef.current.visible = true;
        clearDirectorCharacterLocomotionRuntimeState(playerObjectRef.current);
      }
      perspectiveCamera.up.copy(originalCameraUp);
      perspectiveCamera.near = originalCameraNear;
      perspectiveCamera.fov = originalCameraFov;
      perspectiveCamera.updateProjectionMatrix();
      baseFovRef.current = null;
      if (activeRef.current && !continuingWithAnotherPlayer) onFinishedRef.current();
      activeRef.current = false;
      if (controlledPlayerIdRef.current === controlledPlayerId) controlledPlayerIdRef.current = null;
      controllerRef.current = null;
      inputRef.current = createEmptyPlayerInput();
      observedPlayerTransformRef.current = null;
      observedPlayerAssetRefIdRef.current = null;
      pendingExternalTransformRef.current = null;
      playerHeadAnchorLocalRef.current = null;
      previousViewModeRef.current = null;
      if (!continuingWithAnotherPlayer) {
        onControlActiveChangeRef.current?.(false);
      }
    };
    // Re-starting a live controller for every transform update would discard
    // player input. Its immutable id is the intentional lifecycle boundary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, enabled, gl.domElement, player?.id]);

  const playerPositionX = player?.transform.position[0];
  const playerPositionY = player?.transform.position[1];
  const playerPositionZ = player?.transform.position[2];
  const playerRotationX = player?.transform.rotation[0];
  const playerRotationY = player?.transform.rotation[1];
  const playerRotationZ = player?.transform.rotation[2];

  useEffect(() => {
    if (!enabled || !player || controlledPlayerIdRef.current !== player.id) return;
    const previous = observedPlayerTransformRef.current;
    const transform = cloneTransform(player.transform);
    observedPlayerTransformRef.current = transform;
    if (!previous || !isAuthoredTransformChanged(previous, transform)) return;
    pendingExternalTransformRef.current = {
      positionChanged: previous.position.some((value, index) => Math.abs(value - transform.position[index]) > 0.0001),
      transform,
      yawChanged: Math.abs(previous.rotation[1] - transform.rotation[1]) > 0.0001,
    };
  }, [
    enabled,
    player,
    playerPositionX,
    playerPositionY,
    playerPositionZ,
    playerRotationX,
    playerRotationY,
    playerRotationZ,
    playerScaleX,
    playerScaleY,
    playerScaleZ,
  ]);

  useEffect(() => {
    if (!enabled || !player || controlledPlayerIdRef.current !== player.id) return;
    if (observedPlayerAssetRefIdRef.current === playerAssetRefId) return;
    observedPlayerAssetRefIdRef.current = playerAssetRefId;
    playerHeadRef.current = null;
    playerHeadAnchorLocalRef.current = null;
  }, [enabled, player, playerAssetRefId]);

  useEffect(() => {
    const activePlayer = playerRef.current;
    if (!enabled || !activePlayer) {
      physicsMotorRef.current?.dispose();
      physicsMotorRef.current = null;
      return;
    }

    let cancelled = false;
    const ownerStates = meshCollisionOwnerStatesRef.current;
    const scaleY = Math.max(0.1, Math.abs(activePlayer.transform.scale[1]));
    const characterHeight = PLAYER_CONTROLLER_CONFIG.playerHeight * scaleY;
    const scaledConfig = getScaledPlayerConfig(characterHeight);
    void createRapierPlayerMotor({
      groundHeight: groundHeightRef.current,
      groundEnabled,
      height: characterHeight,
      obstacles: obstaclesRef.current,
      radius: scaledConfig.playerRadius,
    })
      .then((motor) => {
        if (cancelled) {
          motor.dispose();
          return;
        }
        cancelMeshColliderPrewarm();
        // Vehicle runtimes live inside the outgoing motor's world; release
        // them first so their disposal never touches a freed world. Entries
        // fall back to "pending" and rebuild against the new world binding.
        disposeVehicleSession();
        physicsMotorRef.current?.dispose();
        physicsMotorRef.current = motor;
        for (const state of ownerStates.values()) resetMeshCollisionOwnerForMotor(state);
        const controller = controllerRef.current;
        if (controller) {
          controllerRef.current = settlePlayerLocomotionOntoGround(
            motor.snapStateToWalkableSurface(
              controller,
              PLAYER_CONTROLLER_CONFIG.stepHeight + PLAYER_CONTROLLER_CONFIG.groundSnapDistance,
              PLAYER_ROAM_SPAWN_SNAP_BELOW_M,
            ),
            {
              groundEnabled,
              groundHeight: groundHeightRef.current,
              obstacles: obstaclesRef.current,
            },
          );
        }
      })
      .catch((error) => {
        // WASM can be blocked by an embedded host. The deterministic planar
        // controller remains available as a degraded fallback.
        for (const state of ownerStates.values()) {
          state.degraded = true;
          state.pending = false;
        }
        console.warn("[Director] Rapier unavailable; using legacy character movement.", error);
      });

    return () => {
      cancelled = true;
      for (const state of ownerStates.values()) state.generation += 1;
      cancelMeshColliderPrewarm();
      // Order matters: vehicle runtimes must detach from the shared world
      // before that world is freed with the motor.
      disposeVehicleSession();
      physicsMotorRef.current?.dispose();
      physicsMotorRef.current = null;
    };
    // The coordinator functions operate entirely on refs; their render-local
    // identity is not a lifecycle boundary for the Rapier motor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, groundEnabled, playerId, playerScaleX, playerScaleY, playerScaleZ]);

  useEffect(() => {
    const motor = physicsMotorRef.current;
    motor?.syncEnvironment(groundHeight, effectiveObstacles, groundEnabled);
    const controller = controllerRef.current;
    if (motor && controller) controllerRef.current = motor.snapStateToWalkableSurface(controller);
    let meshSignature = "";
    const nextMeshIds: string[] = [];
    for (const obstacle of effectiveObstacles) {
      if (obstacle.shape !== "mesh" || !obstacle.id) continue;
      nextMeshIds.push(obstacle.id);
      meshSignature += `${obstacle.id}:${obstacle.meshRevision ?? ""}:${obstacle.position.join(",")}:${(
        obstacle.rotation ?? [0, 0, 0]
      ).join(",")}:${(obstacle.scale ?? [1, 1, 1]).join(",")}|`;
    }
    if (directorMeshSignatureRef.current === meshSignature) return;
    directorMeshSignatureRef.current = meshSignature;
    const ownerState = getMeshCollisionOwnerState(DIRECTOR_PROJECT_COLLISION_OWNER);
    ownerState.desiredVersionKey = meshSignature;
    ownerState.degraded = false;
    ownerState.degradedVersionKey = null;
    ownerState.generation += 1;
    ownerState.mountAttempts = 0;
    ownerState.pending = nextMeshIds.length > 0;
    cancelMeshColliderPrewarm(DIRECTOR_PROJECT_COLLISION_OWNER);
    meshColliderIdsRef.current.length = 0;
    meshColliderIdsRef.current.push(...nextMeshIds);
    if (!nextMeshIds.length) {
      physicsMotorRef.current?.replaceMeshEnvironment(DIRECTOR_PROJECT_COLLISION_OWNER, []);
      ownerState.committedVersionKey = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groundEnabled, groundHeight, effectiveObstacles]);

  useEffect(() => {
    const previousOwnerId = liveCollisionOwnerIdRef.current;
    const ownerId = liveEnvironment?.ownerId ?? previousOwnerId;
    if (ownerId !== previousOwnerId) {
      physicsMotorRef.current?.replaceMeshEnvironment(previousOwnerId, []);
      meshCollisionOwnerStatesRef.current.delete(previousOwnerId);
      liveCollisionOwnerIdRef.current = ownerId;
      liveMeshSignatureRef.current = "";
    }
    const versionKey = liveEnvironment?.meshes.length ? liveEnvironment.versionKey : "";
    if (liveMeshSignatureRef.current === versionKey) return;
    liveMeshSignatureRef.current = versionKey;
    const ownerState = getMeshCollisionOwnerState(ownerId);
    ownerState.desiredVersionKey = versionKey;
    ownerState.degraded = false;
    ownerState.degradedVersionKey = null;
    ownerState.generation += 1;
    ownerState.mountAttempts = 0;
    ownerState.pending = Boolean(versionKey);
    cancelMeshColliderPrewarm(ownerId);
    if (!versionKey) {
      physicsMotorRef.current?.replaceMeshEnvironment(ownerId, []);
      ownerState.committedVersionKey = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveEnvironment]);

  useLayoutEffect(() => {
    if (!enabled) {
      return;
    }

    // Three.Scene always exposes traverse, but embedded/test renderers may
    // provide a minimal scene facade. Exploration should degrade to no camera
    // colliders instead of crashing the entire canvas in that environment.
    if (typeof scene.traverse !== "function") {
      return;
    }
    // effectiveObstacles keeps drivable vehicles out of the follow-camera
    // obstruction set as well; the chase camera must not collide with the car
    // it is following.
    const colliders = findPlayerCollisionRootsByDirectorObjectIds(
      scene,
      effectiveObstacles.flatMap((obstacle) => (obstacle.id ? [obstacle.id] : [])),
    ).filter(isPlayerCameraCollisionRoot);
    // The stage floor is a height constraint, not an occluder. Ray-testing the
    // infinite ground plane makes low-pitch shots collapse radially into the
    // actor; the follow rig applies a smooth world-up floor below instead.
    const cameraRoots = colliders;
    const unregisterRaycastOwners = cameraRoots.map((root) => {
      const mountedMeshes = collectPlayerRaycastMeshes([root]);
      return registerPlayerSceneRaycastOwner(scene, root, mountedMeshes.length ? mountedMeshes : undefined);
    });
    if (liveEnvironment) {
      unregisterRaycastOwners.push(
        registerPlayerSceneRaycastOwner(scene, liveEnvironment.root, liveEnvironment.meshes),
      );
    }
    return () => unregisterRaycastOwners.forEach((unregister) => unregister());
  }, [enabled, liveEnvironment, effectiveObstacles, scene]);

  useEffect(() => {
    if (!enabled) return;
    const element = gl.domElement;
    if (typeof element.addEventListener !== "function") return;
    const originalTabIndex = element.getAttribute("tabindex");
    const originalCursor = element.style.cursor;
    if (element.tabIndex < 0) element.tabIndex = 0;
    // Procedural foley lives for the whole roam session; playback stays
    // silent until a user gesture below unlocks the AudioContext.
    if (!roamAudioRef.current) roamAudioRef.current = new PlayerRoamAudio();
    let controlActive = false;
    let dragPointerId: number | null = null;
    let pointerX = 0;
    let pointerY = 0;
    const pointerLockSupported =
      typeof element.requestPointerLock === "function" && typeof document.exitPointerLock === "function";
    const isPointerLocked = () => pointerLockSupported && document.pointerLockElement === element;
    let pointerWasLocked = isPointerLocked();
    const requestPointerLock = () => {
      if (!pointerLockSupported || isPointerLocked()) return;
      try {
        // The options overload is rejected by some embedded Chromium builds
        // and consumes the user gesture before a retry can succeed.
        const request = element.requestPointerLock();
        if (request && typeof (request as Promise<void>).catch === "function") {
          void (request as Promise<void>).catch(() => undefined);
        }
      } catch {
        /* pointer lock unavailable; drag-look remains the fallback */
      }
    };
    const exitPointerLock = () => {
      if (isPointerLocked()) document.exitPointerLock();
    };
    const resetInput = () => {
      inputRef.current = createEmptyPlayerInput();
      // Losing control releases every held pedal; the car coasts to a stop.
      vehicleDriveInputRef.current = createEmptyPlayerVehicleDriveInput();
    };
    const hasActiveControl = () => controlActive && document.activeElement === element;
    const notifyControlActive = () => {
      onControlActiveChangeRef.current?.(hasActiveControl());
    };
    const endDrag = () => {
      if (dragPointerId !== null) {
        try {
          if (element.hasPointerCapture?.(dragPointerId)) {
            element.releasePointerCapture(dragPointerId);
          }
        } catch {
          // Detached canvases and synthetic/embedded pointer implementations
          // can reject capture bookkeeping. Releasing is cleanup, so a stale
          // browser capture must never take down the roam controller.
        }
      }
      dragPointerId = null;
      element.style.cursor = originalCursor;
    };
    const deactivateControl = () => {
      controlActive = false;
      aimActiveRef.current = false;
      endDrag();
      exitPointerLock();
      resetInput();
      notifyControlActive();
    };
    const handlePointerDown = (event: PointerEvent) => {
      // Left button locks the pointer for game-style free look (drag-look is
      // the fallback while unlocked); the right button is the aim gesture and
      // drives the same look path so aiming and turning compose.
      if (event.button !== 0 && event.button !== 2) return;
      event.preventDefault();
      element.focus?.({ preventScroll: true });
      roamAudioRef.current?.unlock();
      controlActive = true;
      if (event.button === 2) aimActiveRef.current = true;
      if (event.button === 0) requestPointerLock();
      if (!isPointerLocked()) {
        dragPointerId = event.pointerId;
        pointerX = event.clientX;
        pointerY = event.clientY;
        // Pointer capture keeps the fallback gesture routed to the canvas;
        // hiding its cursor prevents it visibly escaping into editor chrome.
        element.style.cursor = "none";
        try {
          element.setPointerCapture?.(event.pointerId);
        } catch {
          // Pointer capture is an enhancement for bounded drag-look. Safari,
          // embedded WebViews and CDP can throw InvalidStateError even for a
          // trusted pointerdown; document-level input and keyboard control
          // should remain usable when that happens.
        }
      }
      notifyControlActive();
    };
    const applyLookDelta = (movementX: number, movementY: number) => {
      if (!controllerRef.current) return;
      if (movementX === 0 && movementY === 0) return;
      // Drag-look follows screen motion: positive movement turns the view to
      // screen-right in the Y-up stage. Aiming slows the response for the
      // fine-grained framing expected from an ADS camera.
      const aimScale = 1 - (1 - AIM_LOOK_SENSITIVITY_SCALE) * aimWeightRef.current;
      const pointerSensitivity = pointerSensitivityRef.current * aimScale;
      const nextYaw = viewYawTargetRef.current - movementX * pointerSensitivity;
      viewYawTargetRef.current = Math.atan2(Math.sin(nextYaw), Math.cos(nextYaw));
      viewPitchTargetRef.current = clamp(
        viewPitchTargetRef.current - movementY * pointerSensitivity,
        PLAYER_MIN_PITCH,
        PLAYER_MAX_PITCH,
      );
      // Write the live orbit in the same event so the next rendered frame
      // matches the pointer instead of easing toward a lagged yaw/pitch.
      viewYawRef.current = viewYawTargetRef.current;
      cameraPitchRef.current = viewPitchTargetRef.current;
    };
    const handleLockedMouseMove = (event: MouseEvent) => {
      // Pointer lock delivers relative motion on `mousemove`. Some browsers
      // target the locked canvas, others the document; listening here (capture)
      // collects both without depending on canvas hit-testing.
      if (!isPointerLocked() || !controlActive) return;
      applyLookDelta(event.movementX || 0, event.movementY || 0);
    };
    const handlePointerMove = (event: PointerEvent) => {
      if (isPointerLocked()) return;
      if (!controlActive || dragPointerId !== event.pointerId || (event.buttons & 3) === 0) return;
      event.preventDefault();
      // Prefer relative deltas when the browser supplies them — `clientX` is
      // integer CSS pixels and makes slow drag-look feel stepped.
      const movementX = event.movementX || event.clientX - pointerX;
      const movementY = event.movementY || event.clientY - pointerY;
      applyLookDelta(movementX, movementY);
      pointerX = event.clientX;
      pointerY = event.clientY;
    };
    const handlePointerEnd = (event: PointerEvent) => {
      if (event.type === "pointercancel" || event.button === 2) aimActiveRef.current = false;
      if (dragPointerId !== event.pointerId) return;
      // Keep dragging while the other look button is still held.
      if (event.type !== "pointercancel" && (event.buttons & 3) !== 0) return;
      endDrag();
    };
    const handleContextMenu = (event: Event) => event.preventDefault();
    const handlePointerLockChange = () => {
      if (isPointerLocked()) {
        pointerWasLocked = true;
        // Relative look owns the pointer now; a live drag would double-apply.
        endDrag();
        // Keep keyboard focus with the canvas so WASD stays live under lock.
        element.focus?.({ preventScroll: true });
      } else if (pointerWasLocked) {
        pointerWasLocked = false;
        controlActive = false;
        aimActiveRef.current = false;
        endDrag();
        resetInput();
      }
      notifyControlActive();
    };
    const handleWheel = (event: WheelEvent) => {
      // Hovering the stage is intent enough for follow distance; requiring a
      // prior activation click made the wheel feel randomly dead in roam mode.
      if (viewModeRef.current !== "third") return;
      event.preventDefault();
      cameraZoomTargetDistanceRef.current = applyFollowCameraZoomImpulse({
        currentDistance: cameraZoomTargetDistanceRef.current,
        deltaMode: event.deltaMode,
        deltaY: event.deltaY * wheelZoomScaleRef.current,
        minDistance: PLAYER_CONTROLLER_CONFIG.cameraMinDistance,
        maxDistance: PLAYER_CONTROLLER_CONFIG.cameraMaxDistance,
      });
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        isTextEntryTarget(event.target) ||
        blocksPlayerKeyboardInput({
          altKey: event.altKey,
          code: event.code,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
        })
      )
        return;
      if (event.code === "Escape" && !event.repeat) {
        event.preventDefault();
        // Match game convention: the first Escape only releases the mouse
        // (most browsers do this natively and swallow the key); a second
        // Escape while unlocked exits roam.
        if (isPointerLocked()) {
          exitPointerLock();
          return;
        }
        onExitRequestRef.current();
        return;
      }
      if (!hasActiveControl()) return;
      if (activeVehicleIdRef.current) {
        // Driving owns the keyboard: WASD/Space become vehicle controls, the
        // toggle key requests an exit, and the remaining roam keys (view,
        // flight, emotes) are swallowed so they cannot fire from the seat.
        if (event.code === PLAYER_VEHICLE_TOGGLE_CODE && !event.repeat) {
          event.preventDefault();
          vehicleExitRequestedRef.current = true;
          return;
        }
        if (isPlayerVehicleDriveKey(event.code)) {
          event.preventDefault();
          updatePlayerVehicleDriveKey(vehicleDriveInputRef.current, event.code, true);
          return;
        }
        if (event.code === "KeyV" || event.code === "KeyF" || isPlayerMovementKey(event.code)) {
          event.preventDefault();
        }
        return;
      }
      if (
        event.code === PLAYER_VEHICLE_TOGGLE_CODE &&
        !event.repeat &&
        promptVehicleIdRef.current &&
        controllerRef.current &&
        !controllerRef.current.flying
      ) {
        // On foot near a car the toggle key boards it; while flying, KeyE
        // stays the ascend alias and the prompt is never offered.
        event.preventDefault();
        vehicleEnterRequestedRef.current = true;
        return;
      }
      if (
        event.code === "KeyE" &&
        !event.repeat &&
        promptInteractionRef.current &&
        controllerRef.current &&
        !controllerRef.current.flying
      ) {
        event.preventDefault();
        onInteractRef.current?.(promptInteractionRef.current.id);
        return;
      }
      if (event.code === "KeyV" && !event.repeat) {
        event.preventDefault();
        onViewModeChangeRef.current(viewModeRef.current === "third" ? "first" : "third");
        return;
      }
      if (event.code === "KeyF" && !event.repeat) {
        event.preventDefault();
        const controller = controllerRef.current;
        if (!controller) return;
        controller.flying = !controller.flying;
        controller.velocity[1] = 0;
        onFlyingChangeRef.current(controller.flying);
        return;
      }
      if (!event.repeat) {
        const emote = getPlayerEmoteByCode(event.code);
        if (emote) {
          event.preventDefault();
          pendingEmoteRef.current = emote;
          return;
        }
      }
      if (isPlayerLookKey(event.code)) {
        event.preventDefault();
        updatePlayerLookKey(inputRef.current, event.code, true);
        return;
      }
      if (!isPlayerMovementKey(event.code)) return;
      event.preventDefault();
      roamAudioRef.current?.unlock();
      if (!event.repeat && registerPlayerDirectionTap(doubleTapTrackerRef.current, event.code, event.timeStamp)) {
        dashRequestedRef.current = true;
      }
      updatePlayerMovementKey(inputRef.current, event.code, true);
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      // Releases always clear the drive state so keys held across an
      // enter/exit transition can never stick.
      if (isPlayerVehicleDriveKey(event.code)) {
        updatePlayerVehicleDriveKey(vehicleDriveInputRef.current, event.code, false);
      }
      if (isPlayerLookKey(event.code)) {
        updatePlayerLookKey(inputRef.current, event.code, false);
      }
      if (!isPlayerMovementKey(event.code)) return;
      updatePlayerMovementKey(inputRef.current, event.code, false);
    };
    const handleVisibilityChange = () => {
      if (!document.hidden) return;
      deactivateControl();
    };
    const handleWindowBlur = () => deactivateControl();
    const handleCanvasBlur = () => deactivateControl();
    const handleDocumentPointerDown = (event: PointerEvent) => {
      if (!controlActive || event.composedPath().includes(element)) return;
      // Roam-owned chrome (the HUD card, the emote dock, and the skill bar)
      // acts on the live session; pressing its buttons must not drop keyboard
      // control the way clicking an editor panel intentionally does.
      const withinRoamUi = event
        .composedPath()
        .some(
          (node) =>
            node instanceof HTMLElement &&
            (node.classList.contains("player-controller-hud") ||
              node.classList.contains("player-controller-emote-dock") ||
              node.classList.contains("linear-casting-hud")),
        );
      if (withinRoamUi) return;
      deactivateControl();
    };

    element.addEventListener("pointerdown", handlePointerDown);
    element.addEventListener("pointermove", handlePointerMove);
    element.addEventListener("pointerup", handlePointerEnd);
    element.addEventListener("pointercancel", handlePointerEnd);
    element.addEventListener("blur", handleCanvasBlur);
    element.addEventListener("wheel", handleWheel, { passive: false });
    element.addEventListener("contextmenu", handleContextMenu);
    document.addEventListener("mousemove", handleLockedMouseMove, true);
    document.addEventListener("pointerlockchange", handlePointerLockChange);
    document.addEventListener("pointerdown", handleDocumentPointerDown, true);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleWindowBlur);
    syncControlActiveRef.current = notifyControlActive;
    // Entering roam is an explicit mode switch: take keyboard focus right away
    // so WASD works without demanding one extra activation click first.
    element.focus?.({ preventScroll: true });
    controlActive = true;
    notifyControlActive();
    return () => {
      syncControlActiveRef.current = null;
      element.removeEventListener("pointerdown", handlePointerDown);
      element.removeEventListener("pointermove", handlePointerMove);
      element.removeEventListener("pointerup", handlePointerEnd);
      element.removeEventListener("pointercancel", handlePointerEnd);
      element.removeEventListener("blur", handleCanvasBlur);
      element.removeEventListener("wheel", handleWheel);
      element.removeEventListener("contextmenu", handleContextMenu);
      document.removeEventListener("mousemove", handleLockedMouseMove, true);
      document.removeEventListener("pointerlockchange", handlePointerLockChange);
      document.removeEventListener("pointerdown", handleDocumentPointerDown, true);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleWindowBlur);
      exitPointerLock();
      endDrag();
      resetInput();
      aimActiveRef.current = false;
      roamAudioRef.current?.dispose();
      roamAudioRef.current = null;
      element.style.cursor = originalCursor;
      if (originalTabIndex === null) element.removeAttribute("tabindex");
      else element.setAttribute("tabindex", originalTabIndex);
      onControlActiveChangeRef.current?.(false);
    };
  }, [enabled, gl.domElement]);

  useFrame((_, delta) => {
    if (!enabled) return;
    const currentPlayer = playerRef.current;
    let controller = controllerRef.current;
    // React may render the next actor before effects tear down the previous
    // controller. Never sample one actor's locomotion state into another.
    if (!currentPlayer || !controller || currentPlayer.id !== controlledPlayerIdRef.current) return;

    const frameDelta = sanitizeFollowDelta(delta);
    const pendingExternalTransform = pendingExternalTransformRef.current;
    if (pendingExternalTransform) {
      pendingExternalTransformRef.current = null;
      const externalTransform = pendingExternalTransform.transform;
      const displacement = Math.hypot(
        externalTransform.position[0] - controller.position[0],
        externalTransform.position[1] - controller.position[1],
        externalTransform.position[2] - controller.position[2],
      );
      const authoredHeight =
        PLAYER_CONTROLLER_CONFIG.playerHeight * Math.max(0.01, Math.abs(externalTransform.scale[1]));
      const shouldSnapCamera =
        pendingExternalTransform.positionChanged &&
        displacement > (EXTERNAL_CAMERA_SNAP_DISTANCE * authoredHeight) / CHARACTER_REFERENCE_HEIGHT;
      if (pendingExternalTransform.positionChanged || pendingExternalTransform.yawChanged) {
        const reboundYaw = pendingExternalTransform.yawChanged ? externalTransform.rotation[1] : controller.yaw;
        const rebound = createPlayerLocomotionState(
          externalTransform.position,
          reboundYaw,
          groundEnabled ? groundHeightRef.current : externalTransform.position[1],
        );
        rebound.flying = flyingRef.current;
        rebound.pitch = controller.pitch;
        const settled = settlePlayerLocomotionOntoGround(rebound, {
          groundEnabled,
          groundHeight: groundHeightRef.current,
          obstacles: obstaclesRef.current,
        });
        controller = settled;
        controllerRef.current = settled;
      }
      lastTransformRef.current = cloneTransform(externalTransform);
      if (pendingExternalTransform.yawChanged) {
        visualYawRef.current = externalTransform.rotation[1];
        viewYawTargetRef.current = externalTransform.rotation[1];
        viewYawRef.current = externalTransform.rotation[1];
      }
      if (shouldSnapCamera) {
        inputRef.current = createEmptyPlayerInput();
        followTargetSmootherRef.current.reset();
        cameraRigInitializedRef.current = false;
        previousViewModeRef.current = null;
      }
    }

    // Drivable vehicles: build pending runtimes as their dependencies mount,
    // then either run the drive loop (which owns pose, camera and status for
    // the whole frame) or refresh the walk-up enter prompt.
    ensureVehicleRuntimes();
    if (vehicleEnterRequestedRef.current) tryEnterPromptVehicle();
    if (activeVehicleIdRef.current) {
      driveActiveVehicleFrame(currentPlayer, frameDelta);
      return;
    }
    updateVehicleEnterPrompt(controller);

    // Sample the gamepad once per frame; the right stick integrates into the
    // same look targets as the mouse so both devices stay live together.
    const gamepadFrame = pollPlayerGamepad(gamepadTrackerRef.current, gamepadFrameRef.current);
    const keyboardLook = getPlayerLookAxes(inputRef.current);
    const gamepadLooking =
      gamepadFrame.connected && (gamepadFrame.lookRightAxis !== 0 || gamepadFrame.lookDownAxis !== 0);
    const keyboardLooking = keyboardLook.yaw !== 0 || keyboardLook.pitch !== 0;
    if (gamepadLooking || keyboardLooking) {
      const lookAimScale = 1 - (1 - AIM_LOOK_SENSITIVITY_SCALE) * aimWeightRef.current;
      let nextYaw = viewYawTargetRef.current;
      let nextPitch = viewPitchTargetRef.current;
      if (gamepadLooking) {
        nextYaw -= gamepadFrame.lookRightAxis * PLAYER_GAMEPAD_LOOK_YAW_RAD_S * lookAimScale * frameDelta;
        nextPitch -= gamepadFrame.lookDownAxis * PLAYER_GAMEPAD_LOOK_PITCH_RAD_S * lookAimScale * frameDelta;
      }
      if (keyboardLooking) {
        nextYaw -= keyboardLook.yaw * PLAYER_KEYBOARD_LOOK_YAW_RAD_S * lookAimScale * frameDelta;
        nextPitch -= keyboardLook.pitch * PLAYER_KEYBOARD_LOOK_PITCH_RAD_S * lookAimScale * frameDelta;
      }
      viewYawTargetRef.current = Math.atan2(Math.sin(nextYaw), Math.cos(nextYaw));
      viewPitchTargetRef.current = clamp(nextPitch, PLAYER_MIN_PITCH, PLAYER_MAX_PITCH);
      viewYawRef.current = viewYawTargetRef.current;
      cameraPitchRef.current = viewPitchTargetRef.current;
    }
    const viewResponse = Math.max(1, PLAYER_CONTROLLER_CONFIG.followSmoothing) * CAMERA_VIEW_RESPONSE_SCALE;
    viewYawRef.current = dampAngle(viewYawRef.current, viewYawTargetRef.current, viewResponse, frameDelta);
    cameraPitchRef.current = dampScalar(cameraPitchRef.current, viewPitchTargetRef.current, viewResponse, frameDelta);
    // Decouple free-look from the movement basis. This matches awplanet's
    // camera/view yaw -> movement-base yaw -> visual actor yaw response chain.
    controller.yaw = dampAngle(controller.yaw, viewYawRef.current, PLAYER_MOVEMENT_YAW_RESPONSE, frameDelta);
    controller.pitch = dampScalar(controller.pitch, viewPitchTargetRef.current, viewResponse, frameDelta);
    preferredCameraDistanceRef.current = dampScalar(
      preferredCameraDistanceRef.current,
      cameraZoomTargetDistanceRef.current,
      Math.max(1, PLAYER_CONTROLLER_CONFIG.followSmoothing) * CAMERA_ZOOM_RESPONSE_SCALE,
      frameDelta,
    );
    controller.flying = flyingRef.current;
    const frameInput = inputRef.current;
    // Gamepad button edges fire before the dash timer below so a pad-armed
    // dash starts on this very frame, exactly like the keyboard gesture.
    if (gamepadFrame.connected) {
      if (gamepadFrame.dashPressed) dashRequestedRef.current = true;
      if (gamepadFrame.slowWalkTogglePressed) frameInput.slowWalk = frameInput.slowWalk !== true;
      if (gamepadFrame.viewTogglePressed) {
        onViewModeChangeRef.current(viewModeRef.current === "third" ? "first" : "third");
      }
      if (gamepadFrame.flightTogglePressed) {
        controller.flying = !controller.flying;
        controller.velocity[1] = 0;
        flyingRef.current = controller.flying;
        onFlyingChangeRef.current(controller.flying);
      }
      if (gamepadFrame.emotePressedIndex !== null) {
        pendingEmoteRef.current = PLAYER_ROAM_EMOTES[gamepadFrame.emotePressedIndex] ?? null;
      }
    }
    // Dash is a controller-timed burst: the double-tap gesture arms it, the
    // timer keeps it alive across motor substeps, and a cooldown prevents
    // chaining it into a permanent speed boost.
    const dashTimer = dashTimerRef.current;
    dashTimer.remainingS = Math.max(0, dashTimer.remainingS - frameDelta);
    dashTimer.cooldownS = Math.max(0, dashTimer.cooldownS - frameDelta);
    if (dashRequestedRef.current) {
      dashRequestedRef.current = false;
      if (dashTimer.cooldownS <= 0 && !controller.flying) {
        dashTimer.remainingS = PLAYER_CONTROLLER_CONFIG.dashDurationS;
        dashTimer.cooldownS = PLAYER_CONTROLLER_CONFIG.dashCooldownS;
      }
    }
    frameInput.dash = dashTimer.remainingS > 0;
    // Merge the pad into the input the motors consume this frame. The
    // keyboard object stays authoritative and unmutated (except toggles), so
    // releasing the pad never leaves phantom held keys behind.
    let activeInput: PlayerInput = frameInput;
    if (gamepadFrame.connected) {
      const merged = gamepadMergedInputRef.current;
      Object.assign(merged, frameInput);
      merged.moveForwardAxis = gamepadFrame.moveForwardAxis;
      merged.moveRightAxis = gamepadFrame.moveRightAxis;
      merged.sprint = frameInput.sprint || gamepadFrame.sprint;
      merged.jump = frameInput.jump || gamepadFrame.jump;
      merged.jumpPressed = frameInput.jumpPressed === true || gamepadFrame.jumpPressed;
      merged.crouch = frameInput.crouch === true || gamepadFrame.crouch;
      merged.descend = frameInput.descend || gamepadFrame.descend;
      activeInput = merged;
    }
    gamepadAimRef.current = gamepadFrame.connected && gamepadFrame.aim;
    aimWeightRef.current = dampScalar(
      aimWeightRef.current,
      aimActiveRef.current || gamepadAimRef.current ? 1 : 0,
      AIM_WEIGHT_RESPONSE,
      frameDelta,
    );
    // Camera-side crouch feedback tracks the physical capsule when Rapier is
    // available: a low ceiling can force the crouch to persist after the key
    // is released. The key-based rule remains the legacy-motor fallback.
    const crouchGaitActive = physicsMotorRef.current?.crouching ?? (!controller.flying && activeInput.crouch === true);
    crouchWeightRef.current = dampScalar(
      crouchWeightRef.current,
      crouchGaitActive ? 1 : 0,
      CROUCH_WEIGHT_RESPONSE,
      frameDelta,
    );
    const physicsMotor = physicsMotorRef.current;
    const directorCollisionState = getMeshCollisionOwnerState(DIRECTOR_PROJECT_COLLISION_OWNER);
    if (
      physicsMotor &&
      directorCollisionState.pending &&
      !meshColliderPrewarmTasksRef.current.has(DIRECTOR_PROJECT_COLLISION_OWNER)
    ) {
      const referenceRoot = collisionReferenceRootRef.current;
      const staticMeshes: PlayerRaycastMesh[] = [];
      let mounted = Boolean(referenceRoot) && typeof scene.getObjectByName === "function";
      if (mounted) {
        for (const meshColliderId of meshColliderIdsRef.current) {
          const meshRoot = scene.getObjectByName(`director-object-${meshColliderId}`);
          if (!meshRoot || !hasPlayerCollisionGeometry(meshRoot)) {
            mounted = false;
            break;
          }
          staticMeshes.push(...collectPlayerRaycastMeshes([meshRoot]));
        }
      }
      if (mounted && referenceRoot && staticMeshes.length) {
        meshColliderPrewarmTasksRef.current.set(DIRECTOR_PROJECT_COLLISION_OWNER, {
          generation: directorCollisionState.generation,
          motor: physicsMotor,
          nextRaycastMeshIndex: 0,
          ownerId: DIRECTOR_PROJECT_COLLISION_OWNER,
          referenceRoot,
          staticMeshes: Array.from(new Set(staticMeshes)),
          versionKey: directorCollisionState.desiredVersionKey,
        });
        scheduleMeshColliderPrewarm();
      } else {
        directorCollisionState.mountAttempts += 1;
        if (directorCollisionState.mountAttempts >= MESH_COLLIDER_MOUNT_ATTEMPTS) {
          degradeMeshCollision(
            DIRECTOR_PROJECT_COLLISION_OWNER,
            `scene mesh did not mount after ${MESH_COLLIDER_MOUNT_ATTEMPTS} frames`,
          );
        }
      }
    }

    const liveCollisionOwnerId = liveCollisionOwnerIdRef.current;
    const liveCollisionState = getMeshCollisionOwnerState(liveCollisionOwnerId);
    if (physicsMotor && liveCollisionState.pending && !meshColliderPrewarmTasksRef.current.has(liveCollisionOwnerId)) {
      const environment = liveEnvironmentRef.current;
      const environmentIsCurrent =
        environment?.ownerId === liveCollisionOwnerId &&
        environment.versionKey === liveCollisionState.desiredVersionKey &&
        environment.meshes.length > 0;
      if (environmentIsCurrent && environment.root.parent) {
        meshColliderPrewarmTasksRef.current.set(liveCollisionOwnerId, {
          generation: liveCollisionState.generation,
          motor: physicsMotor,
          nextRaycastMeshIndex: 0,
          ownerId: liveCollisionOwnerId,
          referenceRoot: environment.referenceRoot,
          staticMeshes: Array.from(new Set(environment.meshes)),
          versionKey: liveCollisionState.desiredVersionKey,
        });
        scheduleMeshColliderPrewarm();
      } else {
        liveCollisionState.mountAttempts += 1;
        if (liveCollisionState.mountAttempts >= MESH_COLLIDER_MOUNT_ATTEMPTS) {
          degradeMeshCollision(
            liveCollisionOwnerId,
            `live scene mesh did not mount after ${MESH_COLLIDER_MOUNT_ATTEMPTS} frames`,
          );
        }
      }
    }
    const transformScaleY = Math.max(0.01, Math.abs(currentPlayer.transform.scale[1]));
    const locomotionCharacterHeight = PLAYER_CONTROLLER_CONFIG.playerHeight * transformScaleY;
    const locomotionRadius = getScaledPlayerConfig(locomotionCharacterHeight).playerRadius;
    const collisionWarmupBlocked =
      shouldBlockForMeshColliderWarmup({
        degraded: directorCollisionState.degraded,
        hasMeshEnvironment: Boolean(directorCollisionState.desiredVersionKey),
        physicsAvailable: Boolean(physicsMotor),
        ready: directorCollisionState.committedVersionKey !== null,
      }) ||
      shouldBlockForMeshColliderWarmup({
        degraded: liveCollisionState.degraded,
        hasMeshEnvironment: Boolean(liveCollisionState.desiredVersionKey),
        physicsAvailable: Boolean(physicsMotor),
        ready: liveCollisionState.committedVersionKey !== null,
      });
    // Keep locomotion animation idle while the physical state is suspended;
    // the live keyboard object remains untouched apart from its jump edge.
    const effectiveFrameInput = collisionWarmupBlocked ? collisionWarmupInputRef.current : activeInput;
    const next = collisionWarmupBlocked
      ? freezePlayerLocomotionForMeshColliderWarmup(controller, activeInput)
      : physicsMotor
        ? physicsMotor.step(controller, activeInput, frameDelta, moveSpeedScaleRef.current)
        : stepPlayerLocomotion({
            state: controller,
            input: activeInput,
            delta: frameDelta,
            groundHeight: groundHeightRef.current,
            groundEnabled,
            obstacles: obstaclesRef.current,
            playerRadius: locomotionRadius,
            speedScale: moveSpeedScaleRef.current,
          });
    frameInput.jumpPressed = false;
    if (activeInput !== frameInput) activeInput.jumpPressed = false;
    controllerRef.current = next;
    // Landing feel: measure the vertical speed the motor absorbed this frame.
    const landingImpactSpeed =
      !controller.onGround && next.onGround && !next.flying ? Math.max(0, -controller.velocity[1]) : 0;
    // Drive the animation from an accepted physical impulse, not a raw Space
    // press. A rejected mid-air press must not queue a second visual jump after
    // the motor's short jump buffer has already expired.
    const jumpStarted =
      !next.flying &&
      next.velocity[1] > 0.5 &&
      next.velocity[1] - controller.velocity[1] > PLAYER_CONTROLLER_CONFIG.jumpSpeed * 0.45;
    const planarSpeed = Math.hypot(next.velocity[0], next.velocity[2]);
    const facingYaw = getPlayerMovementFacingYaw(next.velocity, visualYawRef.current);
    const previousVisualYaw = visualYawRef.current;
    visualYawRef.current = dampAngle(visualYawRef.current, facingYaw, PLAYER_ROTATION_RESPONSE, frameDelta);
    const visualYawDelta = Math.atan2(
      Math.sin(visualYawRef.current - previousVisualYaw),
      Math.cos(visualYawRef.current - previousVisualYaw),
    );
    const angularVelocityRadS = frameDelta > 0.000001 ? visualYawDelta / frameDelta : 0;
    const sampledTransform = transformFromState(next, currentPlayer.transform, visualYawRef.current);
    onTransformSampleRef.current?.(currentPlayer.id, sampledTransform);

    const objectName = `director-object-${currentPlayer.id}`;
    const playerObject =
      playerObjectRef.current?.name === objectName
        ? playerObjectRef.current
        : typeof scene.getObjectByName === "function"
          ? scene.getObjectByName(objectName)
          : null;
    if (playerObjectRef.current !== playerObject) {
      if (playerObjectRef.current) clearDirectorCharacterLocomotionRuntimeState(playerObjectRef.current);
      playerObjectRef.current = playerObject ?? null;
      playerHeadRef.current = playerObject ? (resolveMixamoBones(playerObject).head ?? null) : null;
      playerHeadAnchorLocalRef.current = null;
      locomotionRuntimeRef.current = {
        mode: "idle",
        timeS: 0,
        speedMps: 0,
        normalizedPhase: 0,
        playbackRate: 1,
      };
    }
    // The Director object group can exist one or more frames before its GLB
    // skeleton mounts. Retry only until the Mixamo head becomes available so
    // first-person eye height upgrades deterministically after async loading.
    if (playerObject && !playerHeadRef.current) {
      playerHeadRef.current = resolveMixamoBones(playerObject).head ?? null;
    }
    let characterScale = 1;
    const playerWorldPosition = playerWorldPositionRef.current;
    const playerWorldScale = playerWorldScaleRef.current;
    const playerParentQuaternion = playerParentQuaternionRef.current.identity();
    if (playerObject) {
      playerObject.position.set(next.position[0], next.position[1], next.position[2]);
      playerObject.rotation.set(
        currentPlayer.transform.rotation[0],
        visualYawRef.current,
        currentPlayer.transform.rotation[2],
      );
      playerObject.scale.set(
        currentPlayer.transform.scale[0],
        currentPlayer.transform.scale[1],
        currentPlayer.transform.scale[2],
      );
      playerObject.updateWorldMatrix(true, false);
      playerObject.getWorldPosition(playerWorldPosition);
      playerObject.getWorldScale(playerWorldScale);
      playerObject.parent?.getWorldQuaternion(playerParentQuaternion);
      if (playerHeadRef.current && !playerHeadAnchorLocalRef.current) {
        const headAnchor = playerHeadRef.current.getWorldPosition(new Vector3());
        playerHeadAnchorLocalRef.current = playerObject.worldToLocal(headAnchor).clone();
      }
    } else {
      playerWorldPosition.set(next.position[0], next.position[1], next.position[2]);
      playerWorldScale.set(1, 1, 1);
    }

    const characterHeight = PLAYER_CONTROLLER_CONFIG.playerHeight * Math.max(0.01, Math.abs(playerWorldScale.y));
    characterScale = getCharacterScaleFactor(characterHeight);
    const locomotionConfig = getScaledPlayerConfig(characterHeight);
    const moveSpeedScale = moveSpeedScaleRef.current;
    const walkSpeedMps = locomotionConfig.walkSpeed * moveSpeedScale;
    const runSpeedMps = locomotionConfig.runSpeed * moveSpeedScale;
    const [moveForward, moveRight] = getPlayerMoveAxes(effectiveFrameInput);
    const moveLength = Math.hypot(moveForward, moveRight);
    const hasMovementInput = moveLength > 0.0001;
    // Mirror the motor's gait priority (crouch > sprint > slow walk > walk) so
    // the Blend Space intent floor matches the speed the motor will accept.
    // Crouch/slow-walk speeds scale with character height via the walk ratio.
    const intendedSpeed =
      effectiveFrameInput.crouch === true && !next.flying
        ? walkSpeedMps * (PLAYER_CONTROLLER_CONFIG.crouchSpeed / PLAYER_CONTROLLER_CONFIG.walkSpeed)
        : effectiveFrameInput.sprint
          ? runSpeedMps
          : effectiveFrameInput.slowWalk === true
            ? walkSpeedMps * (PLAYER_CONTROLLER_CONFIG.slowWalkSpeed / PLAYER_CONTROLLER_CONFIG.walkSpeed)
            : walkSpeedMps;
    // Use intent as a floor while a collider blocks displacement. Otherwise a
    // character pushing a wall flips idle/walk every physics frame.
    const gaitSpeed = hasMovementInput ? Math.max(planarSpeed, intendedSpeed * 0.72) : planarSpeed;
    const previousLocomotionRuntime = locomotionRuntimeRef.current;
    const locomotionFrame = locomotionFrameRef.current + 1;
    const locomotionTimestampS = locomotionTimeRef.current + frameDelta;
    locomotionFrameRef.current = locomotionFrame;
    locomotionTimeRef.current = locomotionTimestampS;
    const locomotionMachine = locomotionMachineRef.current;
    let locomotionMode: DirectorCharacterLocomotionMode;
    let jumpPhase: "none" | "takeoff" | "airborne" | "landing";
    let transitionDurationS: number;
    let clipStartedFrame: number;

    // An emote performs in place; any locomotion intent immediately returns
    // control to the movement clips, mirroring FPS emote conventions.
    const emoteInterrupted =
      hasMovementInput || activeInput.jump === true || jumpStarted || next.flying || !next.onGround;
    const pendingEmote = pendingEmoteRef.current;
    if (pendingEmote) {
      pendingEmoteRef.current = null;
      if (!emoteInterrupted) {
        emotePlaybackRef.current = {
          clipId: pendingEmote.clipId,
          durationS: pendingEmote.durationS,
          elapsedS: 0,
          loop: pendingEmote.loop,
          startedFrame: locomotionFrame,
        };
      }
    }
    let emotePlayback = emotePlaybackRef.current;
    if (emotePlayback) {
      if (emoteInterrupted) {
        emotePlayback = null;
        emotePlaybackRef.current = null;
      } else if (emotePlayback.startedFrame !== locomotionFrame) {
        emotePlayback.elapsedS += frameDelta;
        if (emotePlayback.loop === "once" && emotePlayback.elapsedS >= emotePlayback.durationS) {
          emotePlayback = null;
          emotePlaybackRef.current = null;
        } else if (emotePlayback.loop === "repeat") {
          emotePlayback.elapsedS %= emotePlayback.durationS;
        }
      }
    }

    if (next.flying) {
      if (previousLocomotionRuntime.mode !== "fly") {
        createDirectorCharacterLocomotionMachineState(locomotionFrame, locomotionTimestampS, locomotionMachine);
      }
      locomotionMode = "fly";
      jumpPhase = "none";
      transitionDurationS = DIRECTOR_CHARACTER_LOCOMOTION_CROSSFADE_S;
      clipStartedFrame =
        previousLocomotionRuntime.mode === "fly" ? locomotionClipStartedFrameRef.current : locomotionFrame;
    } else if (emotePlayback) {
      if (previousLocomotionRuntime.mode !== "emote") {
        createDirectorCharacterLocomotionMachineState(locomotionFrame, locomotionTimestampS, locomotionMachine);
      }
      locomotionMode = "emote";
      jumpPhase = "none";
      transitionDurationS = EMOTE_TRANSITION_S;
      clipStartedFrame = emotePlayback.startedFrame;
    } else {
      stepDirectorCharacterLocomotionMachine(
        locomotionMachine,
        {
          frame: locomotionFrame,
          timestampS: locomotionTimestampS,
          speedMps: gaitSpeed,
          walkSpeedMps,
          runSpeedMps,
          grounded: next.onGround,
          verticalSpeedMps: next.velocity[1],
          jumpRequested: jumpStarted,
        },
        locomotionMachine,
      );
      locomotionMode = locomotionMachine.mode;
      jumpPhase = locomotionMachine.jumpPhase;
      transitionDurationS = locomotionMachine.transitionDurationS;
      clipStartedFrame = locomotionMachine.clipStartedFrame;
    }

    const restartClip = locomotionMode === "jump" && clipStartedFrame !== locomotionClipStartedFrameRef.current;
    locomotionClipStartedFrameRef.current = clipStartedFrame;
    const nextLocomotionRuntime =
      locomotionMode === "emote" && emotePlayback
        ? {
            mode: "emote" as const,
            timeS: Math.min(emotePlayback.elapsedS, emotePlayback.durationS),
            speedMps: 0,
            normalizedPhase: clamp(emotePlayback.elapsedS / emotePlayback.durationS, 0, 1),
            playbackRate: 1,
          }
        : advanceDirectorCharacterLocomotionClock({
            previous: previousLocomotionRuntime,
            mode: locomotionMode,
            deltaS: frameDelta,
            speedMps: gaitSpeed,
            walkSpeedMps,
            runSpeedMps,
            restartClip,
          });
    locomotionRuntimeRef.current = nextLocomotionRuntime;
    let blendWorldVelocityX = next.velocity[0];
    let blendWorldVelocityZ = next.velocity[2];
    if (hasMovementInput && planarSpeed <= BLOCKED_BLEND_VELOCITY_EPSILON_MPS) {
      // A fully blocked motor correctly reports zero accepted velocity, but
      // the gait state intentionally remains active while the key is held.
      // Preserve that same input direction for the Blend Space only, so a
      // character pushing a side wall stays in the right/left clip instead of
      // collapsing to a forward/neutral fallback.
      if (moveLength > 0.0001) {
        const normalizedForward = moveLength > 1 ? moveForward / moveLength : moveForward;
        const normalizedRight = moveLength > 1 ? moveRight / moveLength : moveRight;
        const [movementForwardX, movementForwardZ] = getPlayerForward(next.yaw);
        const [movementRightX, movementRightZ] = getPlayerRight(next.yaw);
        const blendIntentSpeed = intendedSpeed * 0.72;
        blendWorldVelocityX =
          (movementForwardX * normalizedForward + movementRightX * normalizedRight) * blendIntentSpeed;
        blendWorldVelocityZ =
          (movementForwardZ * normalizedForward + movementRightZ * normalizedRight) * blendIntentSpeed;
      }
    }
    const cosineVisualYaw = Math.cos(visualYawRef.current);
    const sineVisualYaw = Math.sin(visualYawRef.current);
    // Director's +Z-forward character convention uses -X as the physical
    // right vector (see getPlayerRight). Reflect the inverse-Y rotation's X
    // component so the runtime semantic contract remains +X = character right.
    const signedLocalVelocityX = -(blendWorldVelocityX * cosineVisualYaw - blendWorldVelocityZ * sineVisualYaw);
    const localVelocityX = Math.abs(signedLocalVelocityX) <= Number.EPSILON ? 0 : signedLocalVelocityX;
    const localVelocityZ = blendWorldVelocityX * sineVisualYaw + blendWorldVelocityZ * cosineVisualYaw;
    if (playerObject) {
      writeDirectorCharacterLocomotionRuntimeState(playerObject, {
        ...nextLocomotionRuntime,
        weight: 1,
        localVelocityX,
        localVelocityZ,
        angularVelocityRadS,
        verticalVelocityMps: next.velocity[1],
        grounded: !next.flying && next.onGround,
        jumpPhase,
        transitionDurationS,
        clipStartedFrame,
        emoteClipId: locomotionMode === "emote" ? emotePlayback?.clipId : undefined,
        // Raw gait boolean (physical capsule truth): the skeletal runtime owns
        // its own crouch crossfade, so the damped camera weight stays out.
        crouching: crouchGaitActive,
        // Head look targets: camera view direction relative to the actor's
        // visual facing (three.js rotation.y convention, pitch up-positive).
        // The skeletal runtime applies its own clamps, smoothing and mode
        // exemptions, so these are written unconditionally.
        lookYawRad: Math.atan2(
          Math.sin(viewYawRef.current - visualYawRef.current),
          Math.cos(viewYawRef.current - visualYawRef.current),
        ),
        lookPitchRad: cameraPitchRef.current,
      });
    }
    const locomotionState =
      locomotionMode === "run" ? "runForward" : locomotionMode === "walk" ? "walkForward" : "idle";
    const aimWeight = aimWeightRef.current;
    // Aiming pulls the rig over the actor's right shoulder like an ADS camera.
    const followConfig = getScaledPlayerConfig(characterHeight, aimWeight * AIM_SHOULDER_OFFSET_M * characterScale);
    const cameraSmoothing = Math.max(1, PLAYER_CONTROLLER_CONFIG.followSmoothing);
    const cameraOcclusionResponse = cameraSmoothing * CAMERA_ZOOM_RESPONSE_SCALE;

    const cameraPitch = cameraPitchRef.current;
    const cameraYaw = viewYawRef.current;
    const cosinePitch = Math.cos(cameraPitch);
    const forward = forwardRef.current
      .set(Math.sin(cameraYaw) * cosinePitch, Math.sin(cameraPitch), Math.cos(cameraYaw) * cosinePitch)
      .normalize()
      .applyQuaternion(playerParentQuaternion);
    const cameraWorldUp = cameraWorldUpRef.current.copy(WORLD_UP).applyQuaternion(playerParentQuaternion).normalize();
    const cameraFrameForward = cameraFrameForwardRef.current
      .set(0, 0, 1)
      .applyQuaternion(playerParentQuaternion)
      .normalize();
    const cameraFrameRight = cameraFrameRightRef.current
      .set(1, 0, 0)
      .applyQuaternion(playerParentQuaternion)
      .normalize();
    const smoothedTargetY = followTargetSmootherRef.current.step({
      signature: `${currentPlayer.id}:${viewModeRef.current}`,
      rawTargetY: playerWorldPosition.y,
      delta: frameDelta,
      locomotionState,
      deadband: followConfig.verticalDeadband,
      snapDistance: followConfig.verticalSnapDistance,
      walkLambda: followConfig.verticalWalkLambda,
      idleLambda: followConfig.verticalIdleLambda,
    });
    // Crouch lowers the whole follow frame (look target and orbit pivot) so
    // the camera sinks with the character instead of staring over its head.
    const crouchThirdPersonDropY = crouchWeightRef.current * CROUCH_THIRD_PERSON_TARGET_DROP_M * characterScale;
    const crouchedTargetY = smoothedTargetY - crouchThirdPersonDropY;
    const target = targetRef.current.set(
      playerWorldPosition.x,
      crouchedTargetY + followConfig.cameraLookHeight,
      playerWorldPosition.z,
    );
    const workingCamera = camera as ThreePerspectiveCamera;
    workingCamera.up.copy(cameraWorldUp);
    // Game-feel offsets (head bob, landing dip) are re-applied fresh each
    // frame; remove last frame's contribution before the rig math runs so the
    // damped position never integrates them.
    workingCamera.position.sub(cameraFeelOffsetRef.current);
    cameraFeelOffsetRef.current.set(0, 0, 0);
    const reducedMotion = reducedMotionRef.current;
    // Lens feel: sprint widens the FOV slightly; aiming narrows it. The
    // authored editor FOV is the base and is restored on exit.
    const baseFov = baseFovRef.current ?? workingCamera.fov;
    const sprintRatio = clamp((planarSpeed - walkSpeedMps) / Math.max(0.01, runSpeedMps - walkSpeedMps), 0, 1);
    fovKickRef.current = dampScalar(
      fovKickRef.current,
      reducedMotion ? 0 : sprintRatio * baseFov * FOLLOW_SPEED_FOV_FRACTION,
      SPRINT_FOV_KICK_RESPONSE,
      frameDelta,
    );
    const targetFov = clamp(
      (baseFov + fovKickRef.current * (1 - aimWeight)) * (1 - (1 - AIM_FOV_SCALE) * aimWeight),
      15,
      130,
    );
    if (Math.abs(workingCamera.fov - targetFov) > 0.0005) {
      workingCamera.fov = targetFov;
      workingCamera.updateProjectionMatrix();
    }
    // Landing dip: an impact injects downward velocity into a small spring.
    if (landingImpactSpeed > LANDING_DIP_MIN_IMPACT_MPS * characterScale && !reducedMotion) {
      landingDipVelocityRef.current -= landingImpactSpeed * LANDING_DIP_IMPULSE_SCALE;
    }
    landingDipVelocityRef.current +=
      (-LANDING_DIP_STIFFNESS * landingDipOffsetRef.current - LANDING_DIP_DAMPING * landingDipVelocityRef.current) *
      frameDelta;
    landingDipOffsetRef.current = clamp(
      landingDipOffsetRef.current + landingDipVelocityRef.current * frameDelta,
      -LANDING_DIP_MAX_OFFSET_M * characterScale,
      LANDING_DIP_MAX_OFFSET_M * characterScale,
    );
    const currentViewMode = viewModeRef.current;
    if (currentViewMode === "first" && playerObject && playerHeadAnchorLocalRef.current) {
      target.copy(playerHeadAnchorLocalRef.current);
      playerObject.localToWorld(target);
      target.addScaledVector(cameraWorldUp, 0.055 * characterScale);
      // The head anchor is captured from the rest pose, so the crouch eye
      // drop is applied explicitly and cannot double-dip with skeletal pose.
      target.addScaledVector(cameraWorldUp, -CROUCH_FIRST_PERSON_EYE_DROP_M * characterScale * crouchWeightRef.current);
    }
    const snapCamera = !cameraRigInitializedRef.current || previousViewModeRef.current !== currentViewMode;
    if (snapCamera) {
      smoothedTargetRef.current.copy(target);
      cameraDistanceRef.current = preferredCameraDistanceRef.current * characterScale;
      cameraRigInitializedRef.current = true;
      followPivotSpringRef.current.reset();
      cameraRollRef.current = 0;
      cameraGroundLiftRef.current = 0;
    }
    const cameraGroundPoint = cameraGroundPointRef.current.set(0, groundHeightRef.current, 0);
    playerObject?.parent?.localToWorld(cameraGroundPoint);

    let showPlayer = currentViewMode !== "first";
    let cameraObstructed = false;
    if (currentViewMode === "first") {
      const firstPersonPose = computeFirstPersonCameraPose({
        targetPosition: [target.x, target.y, target.z],
        forward: [forward.x, forward.y, forward.z],
        forwardOffset: getFirstPersonForwardOffset(characterHeight),
        lookDistance: 8 * characterScale,
      });
      const idealFirstPersonPosition = desiredCameraRef.current.set(
        firstPersonPose.position[0],
        firstPersonPose.position[1],
        firstPersonPose.position[2],
      );
      lookTargetRef.current.set(firstPersonPose.lookAt[0], firstPersonPose.lookAt[1], firstPersonPose.lookAt[2]);
      workingCamera.position.copy(idealFirstPersonPosition);
      smoothedTargetRef.current.copy(lookTargetRef.current);
      const cameraAimQuaternion = setPlayerCameraLookQuaternion({
        matrix: cameraAimMatrixRef.current,
        position: workingCamera.position,
        quaternion: cameraAimQuaternionRef.current,
        target: smoothedTargetRef.current,
        up: cameraWorldUp,
      });
      workingCamera.quaternion.copy(cameraAimQuaternion);
      cameraDistanceRef.current = 0;
    } else {
      const speed01 = clamp(planarSpeed / Math.max(0.01, runSpeedMps), 0, 1);
      const leadSeconds = reducedMotion ? 0 : FOLLOW_VELOCITY_LEAD_SECONDS * Math.min(1, speed01) * 1.35;
      const leadWorld = followLeadRef.current
        .set(next.velocity[0], 0, next.velocity[2])
        .applyQuaternion(playerParentQuaternion);
      const desiredPivot: [number, number, number] = [
        playerWorldPosition.x + leadWorld.x * leadSeconds,
        crouchedTargetY,
        playerWorldPosition.z + leadWorld.z * leadSeconds,
      ];
      const sprungPivot = followPivotSpringRef.current.step({
        target: desiredPivot,
        delta: frameDelta,
        snap: snapCamera || reducedMotion,
      });
      const thirdPersonPose = computeThirdPersonCameraPose({
        targetPosition: sprungPivot,
        viewYaw: cameraYaw,
        viewPitch: cameraPitch,
        distance: preferredCameraDistanceRef.current * characterScale * (1 - (1 - AIM_DISTANCE_SCALE) * aimWeight),
        followHeight: followConfig.cameraFollowHeight,
        lookHeight: followConfig.cameraLookAtHeight,
        targetLead: followConfig.cameraTargetLead,
        lateralOffset: followConfig.cameraShoulderOffset,
        referenceFrame: {
          forward: [cameraFrameForward.x, cameraFrameForward.y, cameraFrameForward.z],
          right: [cameraFrameRight.x, cameraFrameRight.y, cameraFrameRight.z],
          up: [cameraWorldUp.x, cameraWorldUp.y, cameraWorldUp.z],
        },
      });
      const idealDesired = desiredCameraRef.current.set(
        thirdPersonPose.position[0],
        thirdPersonPose.position[1],
        thirdPersonPose.position[2],
      );
      const idealGroundHeight = cameraPivotRef.current.copy(idealDesired).sub(cameraGroundPoint).dot(cameraWorldUp);
      const safeIdealGroundHeight = smoothCameraGroundFloor(
        idealGroundHeight,
        followConfig.cameraGroundClearance,
        followConfig.cameraGroundSoftness,
      );
      idealDesired.addScaledVector(cameraWorldUp, safeIdealGroundHeight - idealGroundHeight);
      const lookAt = lookTargetRef.current.set(
        thirdPersonPose.lookAt[0],
        thirdPersonPose.lookAt[1],
        thirdPersonPose.lookAt[2],
      );
      // Keep the boom on the actor's orbit. World-space lerp of the camera
      // position trails the walk and hitches whenever dt jitters.
      const cameraCandidate = cameraCandidateRef.current.copy(idealDesired);
      const cameraDirection = cameraPivotRef.current.copy(cameraCandidate).sub(lookAt);
      const fullCameraDistance = cameraDirection.length();
      if (fullCameraDistance > 0.0001) cameraDirection.multiplyScalar(1 / fullCameraDistance);
      else cameraDirection.set(0, 0, 1);
      const cameraRight = cameraRightRef.current
        .set(thirdPersonPose.right[0], thirdPersonPose.right[1], thirdPersonPose.right[2])
        .normalize();
      const cameraUp = cameraUpRef.current.crossVectors(cameraRight, cameraDirection);
      if (cameraUp.lengthSq() < 0.0001) cameraUp.copy(cameraWorldUp);
      else cameraUp.normalize();
      const safeDistance = cameraCollisionProbeRef.current.getSafeDistance({
        target: lookAt,
        desiredPosition: cameraCandidate,
        right: cameraRight,
        up: cameraUp,
        colliders: getPlayerSceneRaycastMeshesNearSegment(
          scene,
          lookAt,
          cameraCandidate,
          followConfig.occlusionPadding + 0.24 * characterScale,
        ),
        clearance: followConfig.occlusionPadding,
        minimumNearDistance: Math.max(0.01, workingCamera.near),
        probeRadius: 0.14 * characterScale,
        verticalProbeRadius: 0.1 * characterScale,
      });
      cameraObstructed = safeDistance < fullCameraDistance - 0.001;
      const nextDistance = stepFollowCameraDistance({
        currentDistance: cameraDistanceRef.current > 0 ? cameraDistanceRef.current : fullCameraDistance,
        safeDistance: cameraObstructed ? safeDistance : fullCameraDistance,
        obstructed: cameraObstructed,
        snap: snapCamera,
        response: cameraOcclusionResponse,
        delta: frameDelta,
      });
      if (fullCameraDistance > 0.0001) {
        cameraCandidate.copy(lookAt).addScaledVector(cameraDirection, nextDistance);
      }
      const pivotAlongUp =
        (lookAt.x - cameraGroundPoint.x) * cameraWorldUp.x +
        (lookAt.y - cameraGroundPoint.y) * cameraWorldUp.y +
        (lookAt.z - cameraGroundPoint.z) * cameraWorldUp.z;
      const cameraAlongUp =
        (cameraCandidate.x - cameraGroundPoint.x) * cameraWorldUp.x +
        (cameraCandidate.y - cameraGroundPoint.y) * cameraWorldUp.y +
        (cameraCandidate.z - cameraGroundPoint.z) * cameraWorldUp.z;
      const armNeed = sampleFollowArmGroundLift({
        pivot: [0, pivotAlongUp, 0],
        camera: [0, cameraAlongUp, 0],
        groundY: 0,
        clearance: followConfig.cameraGroundClearance,
      });
      cameraGroundLiftRef.current = reducedMotion
        ? armNeed
        : stepAsymmetricExpDamp(
            cameraGroundLiftRef.current,
            armNeed,
            FOLLOW_GROUND_LIFT_RISE_RATE,
            FOLLOW_GROUND_LIFT_FALL_RATE,
            frameDelta,
          );
      cameraCandidate.addScaledVector(cameraWorldUp, cameraGroundLiftRef.current);
      workingCamera.position.copy(cameraCandidate);
      smoothedTargetRef.current.copy(lookAt);
      cameraDistanceRef.current = nextDistance;
      const cameraAimQuaternion = setPlayerCameraLookQuaternion({
        matrix: cameraAimMatrixRef.current,
        position: workingCamera.position,
        quaternion: cameraAimQuaternionRef.current,
        target: smoothedTargetRef.current,
        up: cameraWorldUp,
      });
      workingCamera.quaternion.copy(cameraAimQuaternion);
      const lean = clamp(localVelocityX / Math.max(0.01, runSpeedMps), -1, 1);
      const rollTarget = reducedMotion ? 0 : -lean * FOLLOW_BANK_MAX_RADIANS;
      cameraRollRef.current = dampScalar(cameraRollRef.current, rollTarget, FOLLOW_BANK_RESPONSE, frameDelta);
      if (Math.abs(cameraRollRef.current) > 0.0001) {
        workingCamera.quaternion.multiply(cameraRollQuatRef.current.setFromAxisAngle(forward, cameraRollRef.current));
      }
      showPlayer = cameraDistanceRef.current >= followConfig.cameraHidePlayerDistance;
    }
    // Re-apply the frame's game-feel offsets after the rig settles so damped
    // camera state stays clean while impacts and footsteps still read.
    const feelOffset = cameraFeelOffsetRef.current;
    if (!reducedMotion) {
      if (Math.abs(landingDipOffsetRef.current) > 0.000001) {
        feelOffset.addScaledVector(cameraWorldUp, landingDipOffsetRef.current);
      }
      if (currentViewMode === "first" && next.onGround && !next.flying) {
        const bobIntensity = clamp(planarSpeed / Math.max(0.01, runSpeedMps), 0, 1);
        if (bobIntensity > 0.001) {
          const bobPhase = nextLocomotionRuntime.normalizedPhase * Math.PI * 2;
          const bobRight = feelRightRef.current.crossVectors(forward, cameraWorldUp);
          if (bobRight.lengthSq() > 0.000001) bobRight.normalize();
          feelOffset
            .addScaledVector(
              cameraWorldUp,
              Math.sin(bobPhase * 2) * HEAD_BOB_VERTICAL_M * characterScale * bobIntensity,
            )
            .addScaledVector(bobRight, Math.sin(bobPhase) * HEAD_BOB_LATERAL_M * characterScale * bobIntensity);
        }
      }
      workingCamera.position.add(feelOffset);
    }
    if (playerObject) playerObject.visible = showPlayer;
    previousViewModeRef.current = currentViewMode;
    workingCamera.updateMatrixWorld();
    runtimeStatusElapsedRef.current += frameDelta;
    const statusAiming = aimActiveRef.current || gamepadAimRef.current;
    const statusEmoteClipId = emotePlaybackRef.current?.clipId ?? null;
    const statusCrouching = crouchGaitActive;
    // Reflect the gait the motor actually honours: sprint (and the dash burst)
    // temporarily override the slow-walk toggle, and crouch outranks both.
    const statusSlowWalking =
      !controller.flying &&
      activeInput.slowWalk === true &&
      !activeInput.sprint &&
      !activeInput.dash &&
      !crouchGaitActive;
    const roamAudio = roamAudioRef.current;
    if (roamAudio) {
      if (jumpStarted) roamAudio.jump();
      if (landingImpactSpeed > 2.4 * characterScale) {
        roamAudio.land(landingImpactSpeed, PLAYER_CONTROLLER_CONFIG.jumpSpeed * characterScale);
      }
      roamAudio.stepGait({
        crouching: crouchGaitActive,
        grounded: !next.flying && next.onGround,
        mode: nextLocomotionRuntime.mode,
        normalizedPhase: nextLocomotionRuntime.normalizedPhase,
        runSpeedMps,
        slowWalking: statusSlowWalking,
        speedMps: planarSpeed,
      });
    }
    // Walk-up vehicle prompt for the HUD (the driving digest is published by
    // the drive loop, which owns the frame entirely while seated).
    const statusVehiclePhase = getPlayerVehicleHudPhase({
      driving: false,
      nearestEnterableVehicleId: promptVehicleIdRef.current,
    });
    const promptVehicleEntry =
      statusVehiclePhase === "prompt" && promptVehicleIdRef.current
        ? vehicleEntriesRef.current.get(promptVehicleIdRef.current)
        : undefined;
    const statusVehicle = promptVehicleEntry
      ? { phase: "prompt" as const, vehicleName: promptVehicleEntry.candidate.name, speedKph: 0 }
      : null;
    const statusVehicleSignature = promptVehicleEntry ? `prompt:${promptVehicleEntry.candidate.id}` : "";
    const statusInteraction = next.flying
      ? null
      : selectNearestPlayerInteraction(interactionCandidatesRef.current, next.position);
    promptInteractionRef.current = statusInteraction;
    const statusStateChanged =
      statusAiming !== lastStatusAimingRef.current ||
      statusEmoteClipId !== lastStatusEmoteRef.current ||
      statusCrouching !== lastStatusCrouchingRef.current ||
      statusSlowWalking !== lastStatusSlowWalkingRef.current ||
      statusVehicleSignature !== lastStatusVehicleSignatureRef.current ||
      statusInteraction?.id !== lastStatusInteractionIdRef.current;
    if (snapCamera || statusStateChanged || runtimeStatusElapsedRef.current >= 0.2) {
      runtimeStatusElapsedRef.current = 0;
      lastStatusAimingRef.current = statusAiming;
      lastStatusEmoteRef.current = statusEmoteClipId;
      lastStatusCrouchingRef.current = statusCrouching;
      lastStatusSlowWalkingRef.current = statusSlowWalking;
      lastStatusVehicleSignatureRef.current = statusVehicleSignature;
      lastStatusInteractionIdRef.current = statusInteraction?.id ?? null;
      onRuntimeStatusChangeRef.current?.({
        aiming: statusAiming,
        cameraDistance: currentViewMode === "first" ? 0 : cameraDistanceRef.current,
        cameraObstructed,
        cameraPosition: [workingCamera.position.x, workingCamera.position.y, workingCamera.position.z],
        crouching: statusCrouching,
        emoteClipId: statusEmoteClipId,
        playerPosition: [playerWorldPosition.x, playerWorldPosition.y, playerWorldPosition.z],
        playerVisible: showPlayer,
        slowWalking: statusSlowWalking,
        targetPosition:
          currentViewMode === "first"
            ? [lookTargetRef.current.x, lookTargetRef.current.y, lookTargetRef.current.z]
            : [smoothedTargetRef.current.x, smoothedTargetRef.current.y, smoothedTargetRef.current.z],
        interaction: statusInteraction ? { objectId: statusInteraction.id, prompt: statusInteraction.prompt } : null,
        vehicle: statusVehicle,
        viewMode: currentViewMode,
      });
    }
  }, PLAYER_CONTROLLER_FRAME_PRIORITY);

  return null;
}
