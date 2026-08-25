import { Quaternion, Vector3 } from "three";
import type { Collider, DynamicRayCastVehicleController, RigidBody, World } from "@dimforge/rapier3d-compat";
import { clamp } from "../../../../../../packages/protocol/src/primitives";
import type { DirectorVehicleProfile } from "../schema/directorProject";
import type {
  CreateDirectorVehicleRuntimeInput,
  DirectorVehicleControls,
  DirectorVehiclePose,
  DirectorVehicleRuntime,
  DirectorVehicleTelemetry,
} from "./vehicleContracts";
import {
  computeVehicleWheelLayout,
  cuboidPrincipalAngularInertia,
  effectiveSteerRad,
  mpsToKph,
  resolveVehicleDriveCommand,
  suspensionDampingCoefficient,
  VEHICLE_TUNING,
  type VehicleWheelSpec,
} from "./vehicleTuning";

/**
 * Rapier raycast-vehicle runtime for live player sessions.
 *
 * World-stepping ordering contract (player track, read this first):
 * RapierPlayerMotor never calls world.step() — it is a kinematic character
 * controller that only uses computeColliderMovement + updateSceneQueries on a
 * world it creates with zero gravity. Dynamic integration therefore has no
 * owner until a vehicle exists, and THIS runtime owns it: the session must
 * call DirectorVehicleRuntime.step(controls, renderDelta) exactly once per
 * render frame while a vehicle is live, and must never call world.step()
 * itself. Each step() accumulates the clamped render delta into fixed 120 Hz
 * substeps; every substep writes the controls-derived steering/engine/brake
 * values, calls vehicleController.updateVehicle(substepDt) (which writes
 * chassis velocities from suspension/tire impulses), then world.step() with
 * world.timestep set to the same substepDt. The player capsule is a
 * kinematic-position-based body, so these dynamic steps never move it; both
 * controllers cooperate on the one shared world. If several vehicles ever run
 * simultaneously, world stepping must be hoisted to the session and this loop
 * reduced to forces + updateVehicle only.
 *
 * Because the motor builds its world with zero gravity (its locomotion
 * integrates falls itself), this runtime installs standard gravity on the
 * shared world when it finds none; kinematic bodies ignore world gravity, so
 * the motor's capsule is unaffected.
 *
 * Drivetrain decision: RWD (engine on RL/RR, steering on FL/FR). With the
 * profile's lowered center of mass this proved stable in the integration
 * tests (straight-line, braking, 0.6-steer cornering), so AWD was not needed.
 *
 * Live-session only: no timeline determinism requirement, but no Math.random
 * either — identical input sequences reproduce identical trajectories.
 */

const UP_AXIS = new Vector3(0, 1, 0);
/** Wheel spin axis in wheel-local space; +spin rolls the tread toward +Z. */
const SPIN_AXIS = new Vector3(1, 0, 0);
const SUSPENSION_DIRECTION_CS = { x: 0, y: -1, z: 0 };
/** Bullet-convention axle pointing left-to-right seen from +X = left. */
const AXLE_CS = { x: -1, y: 0, z: 0 };
const IDENTITY_ROTATION = { x: 0, y: 0, z: 0, w: 1 };
/** Chassis-local +Z is forward, +Y is up (see vehicleTuning frame notes). */
const FORWARD_AXIS_INDEX = 2;
const UP_AXIS_INDEX = 1;

type RapierNamespace = Pick<typeof import("@dimforge/rapier3d-compat"), "ColliderDesc" | "RigidBodyDesc">;

/**
 * The contract passes the rapier module and world as unknown so the player
 * track's modules stay free of physics imports. Narrowing is a duck check +
 * cast: wasm-backed classes cannot be validated structurally any deeper.
 */
function narrowRapierNamespace(rapier: unknown): RapierNamespace {
  const candidate = rapier as Partial<RapierNamespace> | null | undefined;
  if (typeof candidate?.RigidBodyDesc?.dynamic !== "function" || typeof candidate.ColliderDesc?.cuboid !== "function") {
    throw new Error("createDirectorVehicleRuntime needs the initialized @dimforge/rapier3d-compat namespace");
  }
  return candidate as RapierNamespace;
}

function narrowRapierWorld(world: unknown): World {
  const candidate = world as Partial<World> | null | undefined;
  if (typeof candidate?.createVehicleController !== "function" || typeof candidate.step !== "function") {
    throw new Error("createDirectorVehicleRuntime needs the live session's RAPIER.World instance");
  }
  return candidate as World;
}

class RapierVehicleRuntime implements DirectorVehicleRuntime {
  private readonly world: World;
  private readonly body: RigidBody;
  private readonly collider: Collider;
  private readonly controller: DynamicRayCastVehicleController;
  private readonly profile: DirectorVehicleProfile;
  private readonly wheels: readonly VehicleWheelSpec[];
  private readonly maxSuspensionTravelM: number;
  private accumulatorSeconds = 0;
  private disposed = false;
  private readonly scratchQuaternion = new Quaternion();
  private readonly scratchForward = new Vector3();
  private readonly scratchSteerQuaternion = new Quaternion();
  private readonly scratchSpinQuaternion = new Quaternion();

  constructor({ profile, chassis, rapierWorld, rapier }: CreateDirectorVehicleRuntimeInput) {
    const rapierModule = narrowRapierNamespace(rapier);
    this.world = narrowRapierWorld(rapierWorld);
    this.profile = profile;
    this.wheels = computeVehicleWheelLayout(profile, chassis.halfExtents);
    this.maxSuspensionTravelM = profile.suspensionRestM * VEHICLE_TUNING.suspensionMaxTravelRatio;

    // The motor's session world is created with zero gravity (kinematic
    // characters integrate their own falls); a dynamic chassis needs real
    // gravity. Kinematic bodies ignore world gravity, so this is safe.
    const gravity = this.world.gravity;
    if (Math.hypot(gravity.x, gravity.y, gravity.z) < 1e-6) {
      this.world.gravity = { x: 0, y: -VEHICLE_TUNING.gravityMps2, z: 0 };
    }

    this.scratchQuaternion.setFromAxisAngle(UP_AXIS, chassis.yawRadians);
    this.body = this.world.createRigidBody(
      rapierModule.RigidBodyDesc.dynamic()
        .setTranslation(chassis.position.x, chassis.position.y, chassis.position.z)
        .setRotation(this.scratchQuaternion)
        // A parked vehicle must answer throttle immediately; a sleeping body
        // would swallow the first updateVehicle impulses.
        .setCanSleep(false),
    );
    this.collider = this.world.createCollider(
      rapierModule.ColliderDesc.cuboid(chassis.halfExtents.x, chassis.halfExtents.y, chassis.halfExtents.z)
        // Explicit mass properties: the profile's mass with the center of
        // mass lowered to resist rollovers, solid-cuboid principal inertia.
        .setMassProperties(
          profile.massKg,
          { x: 0, y: profile.centerOfMassYOffsetM, z: 0 },
          cuboidPrincipalAngularInertia(profile.massKg, chassis.halfExtents),
          IDENTITY_ROTATION,
        ),
      this.body,
    );

    this.controller = this.world.createVehicleController(this.body);
    this.controller.indexUpAxis = UP_AXIS_INDEX;
    // Compat quirk: the forward-axis setter is a property accessor literally
    // named `setIndexForwardAxis` (see the package .d.ts), hence the assignment.
    this.controller.setIndexForwardAxis = FORWARD_AXIS_INDEX;

    const dampingCoefficient = suspensionDampingCoefficient(profile.suspensionStiffness);
    // One wheel may momentarily carry the whole car (kerb hits, landings).
    const maxSuspensionForceN = profile.massKg * VEHICLE_TUNING.gravityMps2;
    for (let index = 0; index < this.wheels.length; index += 1) {
      const wheel = this.wheels[index];
      this.controller.addWheel(
        wheel.connectionCs,
        SUSPENSION_DIRECTION_CS,
        AXLE_CS,
        wheel.suspensionRestM,
        wheel.radiusM,
      );
      this.controller.setWheelSuspensionStiffness(index, profile.suspensionStiffness);
      this.controller.setWheelSuspensionCompression(index, dampingCoefficient);
      this.controller.setWheelSuspensionRelaxation(index, dampingCoefficient);
      this.controller.setWheelMaxSuspensionTravel(index, this.maxSuspensionTravelM);
      this.controller.setWheelMaxSuspensionForce(index, maxSuspensionForceN);
      this.controller.setWheelFrictionSlip(index, VEHICLE_TUNING.wheelFrictionSlip);
      this.controller.setWheelSideFrictionStiffness(index, VEHICLE_TUNING.normalSideFrictionStiffness);
    }

    // Make the freshly inserted chassis collider visible to the very first
    // substep's wheel ray-casts.
    this.world.updateSceneQueries();
  }

  step(controls: DirectorVehicleControls, deltaSeconds: number) {
    if (this.disposed) return;
    const delta = clamp(Number.isFinite(deltaSeconds) ? deltaSeconds : 0, 0, VEHICLE_TUNING.maxStepSeconds);
    this.accumulatorSeconds += delta;
    while (this.accumulatorSeconds >= VEHICLE_TUNING.substepSeconds) {
      this.accumulatorSeconds -= VEHICLE_TUNING.substepSeconds;
      this.substep(controls);
    }
  }

  private substep(controls: DirectorVehicleControls) {
    const forwardSpeedMps = this.signedForwardSpeedMps();
    const steerRad = effectiveSteerRad(this.profile, forwardSpeedMps) * clamp(controls.steer, -1, 1);
    const command = resolveVehicleDriveCommand(this.profile, controls, forwardSpeedMps);
    for (let index = 0; index < this.wheels.length; index += 1) {
      const wheel = this.wheels[index];
      this.controller.setWheelSteering(index, wheel.steered ? steerRad : 0);
      this.controller.setWheelEngineForce(index, wheel.driven ? command.engineForcePerDrivenWheelN : 0);
      this.controller.setWheelBrake(index, wheel.steered ? command.frontBrakePerWheelN : command.rearBrakePerWheelN);
      // Handbrake slides: only the rear axle's side grip is modulated.
      if (wheel.driven) this.controller.setWheelSideFrictionStiffness(index, command.rearSideFrictionStiffness);
    }
    // updateVehicle writes suspension/tire impulses into the chassis
    // velocities; the world step that follows integrates them with the same
    // dt (see the file-top ordering contract).
    this.world.timestep = VEHICLE_TUNING.substepSeconds;
    this.controller.updateVehicle(VEHICLE_TUNING.substepSeconds);
    this.world.step();
  }

  private signedForwardSpeedMps() {
    const rotation = this.body.rotation();
    this.scratchQuaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
    this.scratchForward.set(0, 0, 1).applyQuaternion(this.scratchQuaternion);
    const linvel = this.body.linvel();
    return this.scratchForward.x * linvel.x + this.scratchForward.y * linvel.y + this.scratchForward.z * linvel.z;
  }

  readPose(out: DirectorVehiclePose) {
    if (this.disposed) return;
    const translation = this.body.translation();
    const rotation = this.body.rotation();
    out.position.set(translation.x, translation.y, translation.z);
    out.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
    for (let index = 0; index < this.wheels.length; index += 1) {
      const wheel = this.wheels[index];
      // Wheel center = hard point + suspension travel along the (downward)
      // suspension direction; clamped to the physical travel range so a
      // missed ray-cast can never stretch a wheel visually.
      const suspensionLength = clamp(
        this.controller.wheelSuspensionLength(index) ?? wheel.suspensionRestM,
        0,
        wheel.suspensionRestM + this.maxSuspensionTravelM,
      );
      out.wheelPositions[index]
        .set(wheel.connectionCs.x, wheel.connectionCs.y - suspensionLength, wheel.connectionCs.z)
        .applyQuaternion(out.quaternion)
        .add(out.position);
      // Wheel visual pose = chassis orientation * steer yaw * axle spin.
      // wheelRotation() grows at +forwardSpeed/radius (Bullet lineage), and a
      // positive rotation about local +X rolls the tread toward +Z, so the
      // readout maps onto the spin axis with no sign flip.
      this.scratchSteerQuaternion.setFromAxisAngle(UP_AXIS, this.controller.wheelSteering(index) ?? 0);
      this.scratchSpinQuaternion.setFromAxisAngle(SPIN_AXIS, this.controller.wheelRotation(index) ?? 0);
      out.wheelQuaternions[index]
        .copy(out.quaternion)
        .multiply(this.scratchSteerQuaternion)
        .multiply(this.scratchSpinQuaternion);
    }
  }

  readTelemetry(): DirectorVehicleTelemetry {
    if (this.disposed) return { speedKph: 0, forwardSpeedMps: 0, onGroundWheelCount: 0 };
    const linvel = this.body.linvel();
    let onGroundWheelCount = 0;
    for (let index = 0; index < this.wheels.length; index += 1) {
      if (this.controller.wheelIsInContact(index)) onGroundWheelCount += 1;
    }
    return {
      speedKph: mpsToKph(Math.hypot(linvel.x, linvel.y, linvel.z)),
      forwardSpeedMps: this.signedForwardSpeedMps(),
      onGroundWheelCount,
    };
  }

  reset(position: Vector3, yawRadians: number) {
    if (this.disposed) return;
    this.scratchQuaternion.setFromAxisAngle(UP_AXIS, yawRadians);
    this.body.setTranslation({ x: position.x, y: position.y, z: position.z }, true);
    this.body.setRotation(this.scratchQuaternion, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.accumulatorSeconds = 0;
    // Teleports bypass the step pipeline; refresh queries so the next wheel
    // ray-casts see the new pose instead of the stale one.
    this.world.propagateModifiedBodyPositionsToColliders();
    this.world.updateSceneQueries();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    // The session world outlives vehicles: remove exactly what we added.
    this.world.removeVehicleController(this.controller);
    this.world.removeCollider(this.collider, false);
    this.world.removeRigidBody(this.body);
    this.world.updateSceneQueries();
  }
}

/**
 * Creates a live Rapier raycast-vehicle runtime from a vehicle profile and chassis spec.
 *
 * The runtime owns the dynamic stepping loop on the shared session world. It installs
 * gravity if the world was created with zero gravity (as the player motor does) and
 * configures all four wheels with suspension, friction, and drive-train parameters.
 *
 * @param input - The profile, chassis dimensions, and the live Rapier world/module.
 * @returns A DirectorVehicleRuntime ready for per-frame stepping.
 */
export function createDirectorVehicleRuntime(input: CreateDirectorVehicleRuntimeInput): DirectorVehicleRuntime {
  return new RapierVehicleRuntime(input);
}
