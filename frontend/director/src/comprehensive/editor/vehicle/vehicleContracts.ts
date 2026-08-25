import type { Quaternion, Vector3 } from "three";
import type { DirectorVehicleProfile } from "../schema/directorProject";

/**
 * Live drivable-vehicle runtime contract.
 *
 * The physics track owns the implementation (rapierVehicleRuntime.ts); the
 * player track consumes this interface for enter/exit/drive integration.
 * Vehicles exist only inside a live player session: nothing here touches the
 * project document, and none of it participates in deterministic export.
 */

export interface DirectorVehicleControls {
  /** -1..1; positive drives forward. */
  throttle: number;
  /** -1..1; positive steers left (three.js +Y yaw convention). */
  steer: number;
  /** 0..1 service brake. */
  brake: number;
  /** Handbrake locks the rear axle for arcade slides. */
  handbrake: boolean;
}

export interface DirectorVehiclePose {
  position: Vector3;
  quaternion: Quaternion;
  /** Per-wheel travel/rotation for visual wheel meshes (index order: FL, FR, RL, RR). */
  wheelPositions: Vector3[];
  wheelQuaternions: Quaternion[];
}

export interface DirectorVehicleTelemetry {
  speedKph: number;
  forwardSpeedMps: number;
  onGroundWheelCount: number;
}

export interface DirectorVehicleRuntime {
  /** Advances physics with a fixed internal substep and writes the latest pose. */
  step(controls: DirectorVehicleControls, deltaSeconds: number): void;
  readPose(out: DirectorVehiclePose): void;
  readTelemetry(): DirectorVehicleTelemetry;
  /** Teleports the chassis (enter alignment, respawn after falls). */
  reset(position: Vector3, yawRadians: number): void;
  dispose(): void;
}

export interface DirectorVehicleChassisSpec {
  /** Rendered-bounds half extents of the vehicle object, metres, object space. */
  halfExtents: Vector3;
  /** World transform at session start. */
  position: Vector3;
  yawRadians: number;
}

export interface CreateDirectorVehicleRuntimeInput {
  profile: DirectorVehicleProfile;
  chassis: DirectorVehicleChassisSpec;
  /**
   * The live player session's Rapier world (same instance the player motor
   * collides in). Typed as unknown at the contract boundary: the physics
   * track narrows it to RAPIER.World internally so this file stays free of
   * physics imports for the player track's tests.
   */
  rapierWorld: unknown;
  /** The rapier-compat module namespace already initialized by the player session. */
  rapier: unknown;
}
