import type RAPIER from "@dimforge/rapier3d-compat";
import { clamp } from "../../../../../../packages/protocol/src/primitives";
import { Euler, Quaternion } from "three";
import {
  PLAYER_CONTROLLER_CONFIG,
  resolvePlayerMotorIntent,
  type PlayerInput,
  type PlayerLocomotionState,
  type PlayerObstacle,
} from "./playerLocomotion";
import type { PlayerCollisionMesh } from "./playerCollisionMesh";

const MAX_SIMULATION_DELTA = 0.1;
const FIXED_SIMULATION_STEP = 1 / 60;
const CHARACTER_OFFSET = 0.018;
const GROUND_HALF_THICKNESS = 0.08;
// Very large single-precision colliders make Rapier shape casts lose contact
// detail around the origin. A 200 m stage is ample and remains numerically stable.
const GROUND_HALF_SIZE = 100;
// Translate the pad only after the actor has walked a substantial fraction of
// it. Recentering under the capsule every physics step recomputes contacts and
// makes the third-person follow hitch.
const GROUND_RECENTER_DISTANCE = 32;
const GROUND_STICK_SPEED = 1.2;
const WALKABLE_UP_DOT = Math.cos(PLAYER_CONTROLLER_CONFIG.maxSlopeClimbAngle);
const STEP_SURFACE_EPSILON = 0.025;
const STEP_SUPPORT_EPSILON = 0.055;
const CHARACTER_AVOIDANCE_CLEARANCE = 0.14;
const CHARACTER_AVOIDANCE_MIN_LOOK_AHEAD = 0.8;
const CHARACTER_AVOIDANCE_RESPONSE = 0.95;
// While crouch is held the collision capsule keeps its radius and drops the
// head to 60% of standing height — low enough to clear desks and crawl spaces
// that block the standing capsule, while preserving a valid cylinder section
// at every authored character scale. Feet stay planted: only the top moves.
const CROUCH_HEIGHT_RATIO = 0.6;
// The stand-up headroom cast slims the capsule slightly so grazing wall
// contacts (which the character controller keeps at CHARACTER_OFFSET) cannot
// veto standing. The shrink is added back onto the cast distance so a flat
// ceiling is still measured against the full standing height plus one
// character-offset skin gap.
const HEADROOM_CAST_RADIUS_SHRINK = CHARACTER_OFFSET;
const HEADROOM_CAST_UP = { x: 0, y: 1, z: 0 };
const HEADROOM_CAST_ROTATION = { x: 0, y: 0, z: 0, w: 1 };

type RapierNamespace = typeof RAPIER;

let rapierNamespacePromise: Promise<RapierNamespace> | null = null;
let loadedRapierNamespace: RapierNamespace | null = null;

/**
 * The compat package inlines its WASM as base64 (a ~2 MB vendor-physics
 * chunk), so it must never sit on the Stage workspace's static import graph.
 * The namespace is fetched and initialized exactly once, on first motor
 * creation; concurrent callers share the same promise, and a failed load
 * stays rejected so callers keep their legacy-locomotion fallback.
 */
function loadRapierNamespace() {
  rapierNamespacePromise ??= import("@dimforge/rapier3d-compat").then(async (module) => {
    const rapier = module.default;
    await rapier.init();
    loadedRapierNamespace = rapier;
    return rapier;
  });
  return rapierNamespacePromise;
}

function requireLoadedRapierNamespace(): RapierNamespace {
  if (!loadedRapierNamespace) {
    throw new Error("Rapier is not loaded; create motors through createRapierPlayerMotor().");
  }
  return loadedRapierNamespace;
}

function obstacleRotation(obstacle: PlayerObstacle) {
  const [x, y, z] = obstacle.rotation ?? [0, obstacle.yaw ?? 0, 0];
  const quaternion = new Quaternion().setFromEuler(new Euler(x, y, z, "XYZ"));
  return { x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w };
}

/** Configuration for creating a Rapier-based character motor. */
export interface RapierPlayerMotorOptions {
  /** Whether the ground pad collider is enabled. Defaults to true. */
  groundEnabled?: boolean;
  /** Y coordinate of the fallback ground plane. */
  groundHeight: number;
  /** Character standing height in metres. Defaults to the Director character height. */
  height?: number;
  /** Initial obstacle list for non-mesh colliders. */
  obstacles: PlayerObstacle[];
  /** Capsule radius in metres. Defaults to the Director character radius. */
  radius?: number;
}

/**
 * Renderer-independent character motor. It owns only collision/query state;
 * the R3F bridge remains responsible for applying the returned transform.
 */
export class RapierPlayerMotor {
  /** Declared first: later field initializers (groundRay) already need it. */
  private readonly rapier = requireLoadedRapierNamespace();
  private readonly world: RAPIER.World;
  private readonly body: RAPIER.RigidBody;
  private readonly collider: RAPIER.Collider;
  private readonly controller: RAPIER.KinematicCharacterController;
  /** Foot-to-capsule-center distance for the currently active capsule. */
  private centerOffset: number;
  private readonly groundRay = new this.rapier.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  private readonly radius: number;
  private readonly standingHalfHeight: number;
  private readonly crouchedHalfHeight: number;
  private readonly headroomCastShape: RAPIER.Capsule;
  private readonly headroomCastPosition = { x: 0, y: 0, z: 0 };
  private crouchActive = false;
  private highestWalkableY = Number.NEGATIVE_INFINITY;
  private environmentColliders: RAPIER.Collider[] = [];
  private groundCollider: RAPIER.Collider | null = null;
  private lastFootX = 0;
  private lastFootZ = 0;
  private padCenterX = 0;
  private padCenterZ = 0;
  private meshEnvironmentColliders = new Map<string, RAPIER.Collider[]>();
  private nonWalkableColliderHandles = new Set<number>();
  private readonly characterAvoidanceObstacles: PlayerObstacle[] = [];
  private avoidanceVelocityX = 0;
  private avoidanceVelocityZ = 0;
  private groundEnabled: boolean;
  private groundHeight: number;
  private disposed = false;

  private readonly collectWalkableRayHit = (intersection: RAPIER.RayColliderIntersection) => {
    if (this.nonWalkableColliderHandles.has(intersection.collider.handle)) return true;
    if (intersection.normal.y >= WALKABLE_UP_DOT) {
      this.highestWalkableY = Math.max(this.highestWalkableY, this.groundRay.origin.y - intersection.toi);
    }
    return true;
  };

  constructor({
    groundEnabled = true,
    groundHeight,
    height = PLAYER_CONTROLLER_CONFIG.playerHeight,
    obstacles,
    radius = PLAYER_CONTROLLER_CONFIG.playerRadius,
  }: RapierPlayerMotorOptions) {
    const safeRadius = Math.max(0.08, radius);
    const safeHeight = Math.max(safeRadius * 2 + 0.02, height);
    const capsuleHalfHeight = Math.max(0.01, (safeHeight - safeRadius * 2) / 2);
    // Crouch target height; the clamps mirror the standing ones so very squat
    // characters degenerate to "crouch equals standing" instead of inverting.
    const crouchedHeight = Math.max(safeRadius * 2 + 0.02, safeHeight * CROUCH_HEIGHT_RATIO);
    this.radius = safeRadius;
    this.standingHalfHeight = capsuleHalfHeight;
    this.crouchedHalfHeight = Math.min(capsuleHalfHeight, Math.max(0.01, (crouchedHeight - safeRadius * 2) / 2));
    this.headroomCastShape = new this.rapier.Capsule(
      this.crouchedHalfHeight,
      Math.max(0.02, safeRadius - HEADROOM_CAST_RADIUS_SHRINK),
    );
    this.centerOffset = capsuleHalfHeight + safeRadius;
    this.world = new this.rapier.World({ x: 0, y: 0, z: 0 });
    this.body = this.world.createRigidBody(this.rapier.RigidBodyDesc.kinematicPositionBased());
    this.collider = this.world.createCollider(
      this.rapier.ColliderDesc.capsule(capsuleHalfHeight, safeRadius),
      this.body,
    );
    this.controller = this.world.createCharacterController(CHARACTER_OFFSET);
    this.controller.setSlideEnabled(true);
    this.controller.enableAutostep(PLAYER_CONTROLLER_CONFIG.stepHeight, PLAYER_CONTROLLER_CONFIG.stepMinWidth, false);
    this.controller.enableSnapToGround(PLAYER_CONTROLLER_CONFIG.groundSnapDistance);
    this.controller.setMaxSlopeClimbAngle(PLAYER_CONTROLLER_CONFIG.maxSlopeClimbAngle);
    this.controller.setMinSlopeSlideAngle(PLAYER_CONTROLLER_CONFIG.minSlopeSlideAngle);
    this.groundEnabled = groundEnabled;
    this.groundHeight = groundHeight;
    this.syncEnvironment(groundHeight, obstacles, groundEnabled);
  }

  /**
   * Rebuilds all non-mesh colliders in the private Rapier world. Called when
   * the ground plane, obstacle list, or ground-enabled flag changes.
   *
   * @param groundHeight - Current ground plane Y coordinate.
   * @param obstacles - Current obstacle list for non-mesh colliders.
   * @param groundEnabled - Whether the ground pad should be present.
   */
  syncEnvironment(groundHeight: number, obstacles: PlayerObstacle[], groundEnabled = this.groundEnabled) {
    if (this.disposed) return;
    this.groundEnabled = groundEnabled;
    this.groundHeight = groundHeight;
    this.environmentColliders.forEach((collider) => this.world.removeCollider(collider, false));
    this.environmentColliders = [];
    this.groundCollider = null;
    this.nonWalkableColliderHandles.clear();
    this.characterAvoidanceObstacles.length = 0;

    if (groundEnabled) {
      // Keep a finite pad under the capsule. A kilometre-scale cuboid loses
      // contact precision, so the pad recentres when the actor walks near its
      // edge rather than translating underfoot every step.
      this.padCenterX = this.lastFootX;
      this.padCenterZ = this.lastFootZ;
      const ground = this.world.createCollider(
        this.rapier.ColliderDesc.cuboid(GROUND_HALF_SIZE, GROUND_HALF_THICKNESS, GROUND_HALF_SIZE).setTranslation(
          this.padCenterX,
          groundHeight - GROUND_HALF_THICKNESS,
          this.padCenterZ,
        ),
      );
      this.groundCollider = ground;
      this.environmentColliders.push(ground);
    }

    for (const obstacle of obstacles) {
      // Imported Blender environments are represented by their actual mounted
      // triangle meshes. A synthetic cylinder at the scene origin caused both
      // false blocking and unrestricted movement through the real geometry.
      if (obstacle.shape === "mesh") continue;
      const halfHeight = Math.max(0.025, obstacle.halfHeight ?? obstacle.radius);
      const centerY = obstacle.position[1] + halfHeight;
      const descriptor =
        obstacle.shape === "box"
          ? this.rapier.ColliderDesc.cuboid(
              Math.max(0.025, obstacle.halfExtents?.[0] ?? obstacle.radius),
              halfHeight,
              Math.max(0.025, obstacle.halfExtents?.[1] ?? obstacle.radius),
            )
          : this.rapier.ColliderDesc.cylinder(halfHeight, Math.max(0.025, obstacle.radius));
      descriptor.setTranslation(obstacle.position[0], centerY, obstacle.position[2]);
      descriptor.setRotation(obstacleRotation(obstacle));
      const collider = this.world.createCollider(descriptor);
      this.environmentColliders.push(collider);
      if (obstacle.walkableSurface === false) {
        this.nonWalkableColliderHandles.add(collider.handle);
        if (obstacle.shape === "circle") this.characterAvoidanceObstacles.push(obstacle);
      }
    }

    this.world.updateSceneQueries();
  }

  private recenterGroundPad(x: number, z: number) {
    this.lastFootX = x;
    this.lastFootZ = z;
    if (!this.groundEnabled || !this.groundCollider) return;
    const offsetX = x - this.padCenterX;
    const offsetZ = z - this.padCenterZ;
    if (offsetX * offsetX + offsetZ * offsetZ < GROUND_RECENTER_DISTANCE * GROUND_RECENTER_DISTANCE) return;
    this.padCenterX = x;
    this.padCenterZ = z;
    this.groundCollider.setTranslation({
      x,
      y: this.groundHeight - GROUND_HALF_THICKNESS,
      z,
    });
    this.world.updateSceneQueries();
  }

  /**
   * Adds a small deterministic side preference before actor contact. Rapier
   * remains authoritative for the final capsule response; this only avoids the
   * deadlock where two centred character capsules push straight into each
   * other. Scratch scalars and the environment-owned obstacle list keep the
   * fixed-step path allocation-free.
   */
  private steerAroundCharacters(state: PlayerLocomotionState, velocityX: number, velocityZ: number) {
    this.avoidanceVelocityX = velocityX;
    this.avoidanceVelocityZ = velocityZ;
    const speed = Math.hypot(velocityX, velocityZ);
    if (state.flying || speed < 0.05 || !this.characterAvoidanceObstacles.length) return;

    const directionX = velocityX / speed;
    const directionZ = velocityZ / speed;
    const rightX = -directionZ;
    const rightZ = directionX;
    let steeringX = 0;
    let steeringZ = 0;

    for (let index = 0; index < this.characterAvoidanceObstacles.length; index += 1) {
      const obstacle = this.characterAvoidanceObstacles[index]!;
      const offsetX = obstacle.position[0] - state.position[0];
      const offsetZ = obstacle.position[2] - state.position[2];
      const ahead = offsetX * directionX + offsetZ * directionZ;
      if (ahead <= 0) continue;

      const combinedRadius = this.radius + Math.max(0, obstacle.radius);
      const corridorRadius = combinedRadius + CHARACTER_AVOIDANCE_CLEARANCE;
      const lateralOffset = offsetX * rightX + offsetZ * rightZ;
      if (Math.abs(lateralOffset) >= corridorRadius) continue;

      const lookAhead = combinedRadius + Math.max(CHARACTER_AVOIDANCE_MIN_LOOK_AHEAD, speed * 0.35);
      if (ahead >= lookAhead) continue;

      const side = lateralOffset > 0.04 ? -1 : 1;
      const forwardWeight = 1 - Math.max(0, ahead - combinedRadius) / (lookAhead - combinedRadius);
      const corridorWeight = 1 - Math.abs(lateralOffset) / corridorRadius;
      const weight = CHARACTER_AVOIDANCE_RESPONSE * forwardWeight * corridorWeight;
      steeringX += rightX * side * weight;
      steeringZ += rightZ * side * weight;
    }

    const steeredX = directionX + steeringX;
    const steeredZ = directionZ + steeringZ;
    const steeredLength = Math.hypot(steeredX, steeredZ);
    if (steeredLength <= 0.0001) return;
    this.avoidanceVelocityX = (steeredX / steeredLength) * speed;
    this.avoidanceVelocityZ = (steeredZ / steeredLength) * speed;
  }

  private findHighestWalkableSurfaceY(x: number, z: number, referenceY: number, maxAbove: number, maxBelow: number) {
    const safeAbove = Math.max(0.01, maxAbove);
    const safeBelow = Math.max(0.01, maxBelow);
    this.groundRay.origin.x = x;
    this.groundRay.origin.y = referenceY + safeAbove;
    this.groundRay.origin.z = z;
    this.highestWalkableY = Number.NEGATIVE_INFINITY;
    this.world.intersectionsWithRay(
      this.groundRay,
      safeAbove + safeBelow,
      false,
      this.collectWalkableRayHit,
      undefined,
      undefined,
      this.collider,
    );
    return Number.isFinite(this.highestWalkableY) ? this.highestWalkableY : null;
  }

  /**
   * Exposes the shared world plus the initialized rapier namespace for the
   * drivable-vehicle runtime, which injects its dynamic chassis into the same
   * world the character collides in. Typed as unknown to match the vehicle
   * contract boundary (vehicleContracts.ts stays free of physics imports).
   */
  getVehicleWorldBinding(): { rapier: unknown; world: unknown } | null {
    if (this.disposed) return null;
    return { rapier: this.rapier, world: this.world };
  }

  /**
   * Parks or restores the character capsule. While driving, the hidden
   * character must not leave a kinematic (infinite-mass) collider inside the
   * vehicle chassis, which would deadlock the dynamic vehicle body.
   */
  setCharacterColliderEnabled(enabled: boolean) {
    if (this.disposed) return;
    this.collider.setEnabled(enabled);
    this.world.updateSceneQueries();
  }

  /** True for colliders owned by static scene geometry (never bodies that move). */
  private isStaticCollider(collider: RAPIER.Collider) {
    const parent = collider.parent();
    return parent === null || parent.bodyType() === this.rapier.RigidBodyType.Fixed;
  }

  /**
   * Whether a ball at the given point overlaps static collision. Used by the
   * vehicle exit probes; dynamic bodies (the vehicle itself) and the character
   * capsule are intentionally not treated as blockers.
   */
  isPointInsideStaticCollision(x: number, y: number, z: number, radius: number) {
    if (this.disposed) return false;
    let blocked = false;
    this.world.intersectionsWithShape(
      { x, y, z },
      { x: 0, y: 0, z: 0, w: 1 },
      new this.rapier.Ball(Math.max(0.01, radius)),
      (collider) => {
        if (this.isStaticCollider(collider)) {
          blocked = true;
          return false;
        }
        return true;
      },
      undefined,
      undefined,
      this.collider,
    );
    return blocked;
  }

  /**
   * Highest static surface directly below a point, or null when nothing is in
   * reach. Unlike the walkable-surface probe this ignores dynamic bodies so an
   * exit probe brushing the vehicle chassis cannot report the car roof as
   * ground.
   */
  findStaticGroundYBelow(x: number, y: number, z: number, maxBelow: number, maxAbove = 0.5) {
    if (this.disposed) return null;
    const safeBelow = Math.max(0.01, maxBelow);
    const safeAbove = Math.max(0, maxAbove);
    this.groundRay.origin.x = x;
    this.groundRay.origin.y = y + safeAbove;
    this.groundRay.origin.z = z;
    const hit = this.world.castRay(
      this.groundRay,
      safeAbove + safeBelow,
      true,
      undefined,
      undefined,
      this.collider,
      undefined,
      (collider) => this.isStaticCollider(collider),
    );
    return hit ? this.groundRay.origin.y - hit.toi : null;
  }

  /**
   * Replaces only the expensive static render-mesh colliders. This is called
   * when an imported GLB mounts or its authored transform changes, never from
   * the locomotion hot path.
   */
  replaceMeshEnvironment(ownerId: string, meshes: readonly PlayerCollisionMesh[]) {
    if (this.disposed) return;
    const nextColliders: RAPIER.Collider[] = [];
    try {
      for (const mesh of meshes) {
        if (mesh.vertices.length < 9 || mesh.indices.length < 3) continue;
        const descriptor = this.rapier.ColliderDesc.trimesh(mesh.vertices, mesh.indices);
        nextColliders.push(this.world.createCollider(descriptor));
      }
    } catch (error) {
      nextColliders.forEach((collider) => this.world.removeCollider(collider, false));
      this.world.updateSceneQueries();
      throw error;
    }

    const previousColliders = this.meshEnvironmentColliders.get(ownerId) ?? [];
    if (nextColliders.length) this.meshEnvironmentColliders.set(ownerId, nextColliders);
    else this.meshEnvironmentColliders.delete(ownerId);
    previousColliders.forEach((collider) => this.world.removeCollider(collider, false));
    this.world.updateSceneQueries();
  }

  /**
   * Resolves an authored spawn that is slightly above or below an imported
   * floor. The highest walkable hit wins over Director's fallback ground so a
   * coplanar/thick Blender floor cannot leave the capsule interpenetrating.
   */
  snapStateToWalkableSurface(
    state: PlayerLocomotionState,
    maxAbove = PLAYER_CONTROLLER_CONFIG.stepHeight + PLAYER_CONTROLLER_CONFIG.groundSnapDistance,
    // Keep this short on the live path so an environment resync cannot cancel a jump.
    // Roam spawn sites pass PLAYER_ROAM_SPAWN_SNAP_BELOW_M explicitly.
    maxBelow = 0.85,
  ): PlayerLocomotionState {
    if (this.disposed || state.flying) return state;
    this.recenterGroundPad(state.position[0], state.position[2]);
    const highestWalkableY = this.findHighestWalkableSurfaceY(
      state.position[0],
      state.position[2],
      state.position[1],
      maxAbove,
      maxBelow,
    );
    const groundDelta = this.groundHeight - state.position[1];
    const floorY =
      highestWalkableY ??
      (this.groundEnabled &&
      ((groundDelta >= 0 && groundDelta <= maxAbove) || (groundDelta < 0 && -groundDelta <= maxBelow))
        ? this.groundHeight
        : null);
    if (floorY === null) return state;
    return {
      ...state,
      position: [state.position[0], floorY, state.position[2]],
      velocity: [state.velocity[0], 0, state.velocity[2]],
      onGround: true,
      coyoteTimeRemaining: PLAYER_CONTROLLER_CONFIG.coyoteTime,
    };
  }

  /** True while the collision capsule is at crouch height (held crouch or ceiling-forced). */
  get crouching(): boolean {
    return this.crouchActive;
  }

  /**
   * Casts the crouched capsule straight up by the standing/crouched height
   * difference. That swept volume equals the standing capsule exactly (same
   * feet, same radius), so a clear cast guarantees the restored capsule
   * cannot re-appear inside a ceiling. Environment colliders are current
   * here: sync/replace update scene queries, and the player collider itself
   * is excluded from the cast.
   */
  private hasStandingHeadroom(state: PlayerLocomotionState) {
    const extraHeight = (this.standingHalfHeight - this.crouchedHalfHeight) * 2;
    if (extraHeight <= 1e-6) return true;
    this.headroomCastPosition.x = state.position[0];
    this.headroomCastPosition.y = state.position[1] + this.crouchedHalfHeight + this.radius + CHARACTER_OFFSET;
    this.headroomCastPosition.z = state.position[2];
    const hit = this.world.castShape(
      this.headroomCastPosition,
      HEADROOM_CAST_ROTATION,
      HEADROOM_CAST_UP,
      this.headroomCastShape,
      extraHeight + HEADROOM_CAST_RADIUS_SHRINK + CHARACTER_OFFSET,
      true,
      undefined,
      undefined,
      this.collider,
    );
    return hit === null;
  }

  /**
   * Applies the crouch/stand capsule exactly once per transition; the hot
   * path never rebuilds the collider. Feet stay planted: the capsule shrinks
   * and grows at the head only because `centerOffset` is re-derived from the
   * active half-height, so rapid crouch taps cannot accumulate positional
   * error, pop the character upward, or press it into the ground.
   */
  private setCapsuleCrouched(crouched: boolean) {
    if (this.crouchActive === crouched) return;
    this.crouchActive = crouched;
    const halfHeight = crouched ? this.crouchedHalfHeight : this.standingHalfHeight;
    this.collider.setHalfHeight(halfHeight);
    this.centerOffset = halfHeight + this.radius;
  }

  /**
   * Crouching is a physical capability, not just a speed cap: holding crouch
   * lowers the capsule, and standing back up first requires overhead
   * clearance. While a ceiling forces the capsule to stay crouched, the
   * returned effective input keeps `crouch` asserted so the shared intent
   * resolver caps planar speed in agreement with the actual collision shape
   * (releasing KeyC under a desk must not restore walking speed).
   */
  private resolveCrouch(state: PlayerLocomotionState, input: PlayerInput): PlayerInput {
    const wantsCrouch = !state.flying && input.crouch === true;
    if (wantsCrouch !== this.crouchActive) {
      if (wantsCrouch) this.setCapsuleCrouched(true);
      else if (this.hasStandingHeadroom(state)) this.setCapsuleCrouched(false);
    }
    return this.crouchActive && input.crouch !== true ? { ...input, crouch: true } : input;
  }

  private stepFixed(
    state: PlayerLocomotionState,
    input: PlayerInput,
    delta: number,
    speedScale: number,
  ): PlayerLocomotionState {
    const effectiveInput = this.resolveCrouch(state, input);
    let { velocityX, velocityY, velocityZ, coyoteTimeRemaining, jumpBufferTimeRemaining } = resolvePlayerMotorIntent(
      state,
      effectiveInput,
      delta,
      GROUND_STICK_SPEED,
      speedScale,
    );
    this.steerAroundCharacters(state, velocityX, velocityZ);
    velocityX = this.avoidanceVelocityX;
    velocityZ = this.avoidanceVelocityZ;

    this.recenterGroundPad(state.position[0], state.position[2]);

    const currentCenter = {
      x: state.position[0],
      // The authored transform is foot-height. Keep Rapier's character offset
      // outside that public coordinate so visuals still sit exactly on floors.
      y: state.position[1] + this.centerOffset + CHARACTER_OFFSET,
      z: state.position[2],
    };
    this.body.setTranslation(currentCenter, false);
    this.world.propagateModifiedBodyPositionsToColliders();
    this.world.updateSceneQueries();

    const desiredMovementX = velocityX * delta;
    let desiredMovementY = velocityY * delta;
    const desiredMovementZ = velocityZ * delta;
    const desiredPlanarDistance = Math.hypot(desiredMovementX, desiredMovementZ);
    const directionX = desiredPlanarDistance > 1e-6 ? desiredMovementX / desiredPlanarDistance : 0;
    const directionZ = desiredPlanarDistance > 1e-6 ? desiredMovementZ / desiredPlanarDistance : 0;
    const probeDistance = this.radius + desiredPlanarDistance + STEP_SURFACE_EPSILON;
    const probeX = state.position[0] + directionX * probeDistance;
    const probeZ = state.position[2] + directionZ * probeDistance;

    // Once the front of a capsule has started climbing a step, its centre is
    // still briefly above the lower floor. Keep that lifted foot height while
    // the surface immediately ahead supports it; otherwise snap-to-ground
    // repeatedly drops and re-lifts the actor, which appears as severe jitter.
    let preserveElevatedStepSupport = false;
    if (
      !state.flying &&
      state.onGround &&
      velocityY <= 0 &&
      desiredPlanarDistance > 1e-6 &&
      state.position[1] > this.groundHeight + STEP_SURFACE_EPSILON
    ) {
      const supportY = this.findHighestWalkableSurfaceY(
        probeX,
        probeZ,
        state.position[1],
        STEP_SUPPORT_EPSILON,
        STEP_SUPPORT_EPSILON,
      );
      preserveElevatedStepSupport = supportY !== null && Math.abs(supportY - state.position[1]) <= STEP_SUPPORT_EPSILON;
      if (preserveElevatedStepSupport) desiredMovementY = 0;
    }

    this.controller.computeColliderMovement(this.collider, {
      x: desiredMovementX,
      y: desiredMovementY,
      z: desiredMovementZ,
    });
    const initialMovement = this.controller.computedMovement();
    let movementX = initialMovement.x;
    let movementY = initialMovement.y;
    let movementZ = initialMovement.z;
    let onGround = !state.flying && (this.controller.computedGrounded() || preserveElevatedStepSupport);

    // Rapier's built-in autostep is deliberately conservative on triangle
    // meshes and can reject a valid Blender stair at an internal triangle
    // edge. Only when planar progress is blocked, probe the real surface just
    // beyond the capsule, verify that it is walkable and within the authored
    // step height, then validate both the vertical lift and horizontal move
    // through the same character controller. Full-height walls never pass the
    // height probe, while ceilings can still reject the lift.
    const initialPlanarProgress =
      desiredPlanarDistance > 1e-6
        ? (movementX * desiredMovementX + movementZ * desiredMovementZ) / desiredPlanarDistance
        : 0;
    if (
      !state.flying &&
      state.onGround &&
      velocityY <= 0 &&
      desiredPlanarDistance > 1e-6 &&
      initialPlanarProgress < desiredPlanarDistance * 0.45
    ) {
      const stepSurfaceY = this.findHighestWalkableSurfaceY(
        probeX,
        probeZ,
        state.position[1],
        PLAYER_CONTROLLER_CONFIG.stepHeight + STEP_SURFACE_EPSILON,
        STEP_SURFACE_EPSILON,
      );
      const stepRise = stepSurfaceY === null ? 0 : stepSurfaceY - state.position[1];
      if (stepRise > STEP_SURFACE_EPSILON && stepRise <= PLAYER_CONTROLLER_CONFIG.stepHeight + STEP_SURFACE_EPSILON) {
        this.controller.disableSnapToGround();
        this.controller.computeColliderMovement(this.collider, { x: 0, y: stepRise, z: 0 });
        const lift = this.controller.computedMovement();
        if (lift.y >= stepRise - CHARACTER_OFFSET * 2) {
          this.body.setTranslation({ x: currentCenter.x, y: currentCenter.y + lift.y, z: currentCenter.z }, false);
          this.world.propagateModifiedBodyPositionsToColliders();
          this.world.updateSceneQueries();
          this.controller.computeColliderMovement(this.collider, {
            x: desiredMovementX,
            y: 0,
            z: desiredMovementZ,
          });
          const steppedMovement = this.controller.computedMovement();
          const steppedPlanarProgress =
            (steppedMovement.x * desiredMovementX + steppedMovement.z * desiredMovementZ) / desiredPlanarDistance;
          if (steppedPlanarProgress > initialPlanarProgress + 1e-5) {
            movementX = steppedMovement.x;
            movementY = lift.y + steppedMovement.y;
            movementZ = steppedMovement.z;
            onGround = true;
          } else {
            this.body.setTranslation(currentCenter, false);
            this.world.propagateModifiedBodyPositionsToColliders();
          }
        }
        this.controller.enableSnapToGround(PLAYER_CONTROLLER_CONFIG.groundSnapDistance);
      }
    }

    const nextCenter = {
      x: currentCenter.x + movementX,
      y: currentCenter.y + movementY,
      z: currentCenter.z + movementZ,
    };
    let nextFootY = nextCenter.y - this.centerOffset - CHARACTER_OFFSET;
    if (!state.flying && this.groundEnabled && nextFootY < this.groundHeight) {
      nextFootY = this.groundHeight;
      nextCenter.y = nextFootY + this.centerOffset + CHARACTER_OFFSET;
      onGround = true;
    }
    this.body.setTranslation(nextCenter, false);
    this.world.propagateModifiedBodyPositionsToColliders();
    this.lastFootX = nextCenter.x;
    this.lastFootZ = nextCenter.z;

    if (delta > 0) {
      velocityX = movementX / delta;
      velocityZ = movementZ / delta;
    }
    // A head bump must not leave the capsule hovering: when an upward move is
    // mostly rejected (ceiling contact), the remaining jump velocity would
    // otherwise keep pressing into the ceiling for the rest of the arc.
    if (velocityY > 0 && desiredMovementY > 1e-6 && movementY < desiredMovementY * 0.5) velocityY = 0;
    if (onGround && velocityY < 0) velocityY = 0;
    if (onGround) coyoteTimeRemaining = PLAYER_CONTROLLER_CONFIG.coyoteTime;

    return {
      ...state,
      position: [nextCenter.x, nextFootY, nextCenter.z],
      velocity: [velocityX, velocityY, velocityZ],
      onGround,
      jumpHeld: input.jump,
      coyoteTimeRemaining,
      jumpBufferTimeRemaining,
    };
  }

  /**
   * Advances the character controller by one render-frame delta, subdividing
   * into fixed 1/60 s steps for deterministic collision response.
   *
   * @param state - Current locomotion state (foot-height position).
   * @param input - Per-frame input intent.
   * @param delta - Render-frame delta in seconds.
   * @param speedScale - Optional speed multiplier (e.g. for world scale).
   * @returns The new locomotion state after this step.
   */
  step(state: PlayerLocomotionState, input: PlayerInput, delta: number, speedScale = 1) {
    if (this.disposed) return state;
    const totalDelta = clamp(Number.isFinite(delta) ? delta : 0, 0, MAX_SIMULATION_DELTA);
    const stepCount = Math.max(1, Math.ceil(totalDelta / FIXED_SIMULATION_STEP));
    const stepDelta = totalDelta / stepCount;
    let next = state;
    for (let index = 0; index < stepCount; index += 1) {
      next = this.stepFixed(next, input, stepDelta, speedScale);
    }
    return next;
  }

  /** Frees the private Rapier world and marks the motor as disposed. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.world.free();
  }
}

/**
 * Creates a Rapier-based character motor, loading and initializing the WASM
 * physics module on first call. Subsequent calls reuse the cached namespace.
 *
 * @param options - Motor configuration: ground plane, capsule dimensions, and initial obstacles.
 * @returns A promise resolving to the ready motor instance.
 */
export async function createRapierPlayerMotor(options: RapierPlayerMotorOptions) {
  await loadRapierNamespace();
  return new RapierPlayerMotor(options);
}
