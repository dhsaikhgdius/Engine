import { Box3, Euler, Matrix4, Quaternion, Vector3, type Object3D } from "three";
import type { DirectorObject, DirectorVehicleProfile } from "../schema/directorProject";
import { createDirectorVehicleRuntime } from "../vehicle/rapierVehicleRuntime";
import type { DirectorVehiclePose, DirectorVehicleRuntime } from "../vehicle/vehicleContracts";
import { collectPlayerRaycastMeshes } from "./playerRaycastAcceleration";

/**
 * Live drivable-vehicle registry for one player session.
 *
 * Runtime creation is eager-per-vehicle but gated on readiness: the session
 * retries every frame until the shared Rapier world exists and the vehicle's
 * render meshes are mounted, then builds the physics runtime immediately.
 * Eager (rather than first-enter) creation keeps the dynamic chassis collider
 * in the world while the character is still on foot, so a parked car blocks
 * walking just like any prop even though it left the static collision mesh.
 * A creation failure (e.g. the physics track's runtime is still a stub) marks
 * the vehicle not enterable, warns once, and leaves the rest of player mode
 * fully functional.
 */

/** A Director object that is both visible and has a drivable vehicle profile. */
export interface PlayerVehicleCandidate {
  id: string;
  name: string;
  profile: DirectorVehicleProfile;
}

/** Objects that participate in the drive session: drivable and visible. */
export function collectPlayerVehicleCandidates(objects: readonly DirectorObject[]): PlayerVehicleCandidate[] {
  const candidates: PlayerVehicleCandidate[] = [];
  for (const object of objects) {
    if (!object.vehicle?.drivable || !object.visible) continue;
    candidates.push({ id: object.id, name: object.name, profile: object.vehicle });
  }
  return candidates;
}

/**
 * Identity-level equivalence so unrelated store mutations (which produce new
 * object arrays) do not tear down and rebuild live vehicle physics runtimes.
 * Profiles are immutable store values, so reference equality is exact.
 */
export function areVehicleCandidateListsEquivalent(
  a: readonly PlayerVehicleCandidate[],
  b: readonly PlayerVehicleCandidate[],
) {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index]!;
    const right = b[index]!;
    if (left.id !== right.id || left.profile !== right.profile) return false;
  }
  return true;
}

const measureBox = new Box3();
const measureMatrix = new Matrix4();
const measureGroupInverse = new Matrix4();
const measureCorner = new Vector3();
const measureSize = new Vector3();
const measureWorldScale = new Vector3();

/**
 * Rendered-bounds half extents of a mounted vehicle group in object space,
 * scaled to world metres. Uses geometry bounding boxes transformed into the
 * group's local frame (the same static-mesh filter as player collision), so
 * labels and viewport helpers never inflate the chassis.
 */
export function measureVehicleChassisHalfExtents(group: Object3D, out: Vector3): Vector3 | null {
  const meshes = collectPlayerRaycastMeshes([group]);
  if (!meshes.length) return null;
  group.updateWorldMatrix(true, true);
  measureGroupInverse.copy(group.matrixWorld).invert();
  measureBox.makeEmpty();
  for (const mesh of meshes) {
    const geometry = mesh.geometry;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const bounds = geometry.boundingBox;
    if (!bounds || bounds.isEmpty()) continue;
    measureMatrix.multiplyMatrices(measureGroupInverse, mesh.matrixWorld);
    for (let cornerIndex = 0; cornerIndex < 8; cornerIndex += 1) {
      measureCorner.set(
        (cornerIndex & 1) === 0 ? bounds.min.x : bounds.max.x,
        (cornerIndex & 2) === 0 ? bounds.min.y : bounds.max.y,
        (cornerIndex & 4) === 0 ? bounds.min.z : bounds.max.z,
      );
      measureBox.expandByPoint(measureCorner.applyMatrix4(measureMatrix));
    }
  }
  if (measureBox.isEmpty()) return null;
  measureBox.getSize(measureSize);
  group.getWorldScale(measureWorldScale);
  out.set(
    Math.max(0.05, (measureSize.x * Math.abs(measureWorldScale.x)) / 2),
    Math.max(0.05, (measureSize.y * Math.abs(measureWorldScale.y)) / 2),
    Math.max(0.05, (measureSize.z * Math.abs(measureWorldScale.z)) / 2),
  );
  return out;
}

/** Lifecycle status of a single vehicle's physics runtime. */
export type PlayerVehicleRuntimeStatus = "pending" | "ready" | "failed";

/** Per-vehicle session state including the physics runtime and mutable pose scratch. */
export interface PlayerVehicleSessionEntry {
  /** The Director object backing this vehicle. */
  candidate: PlayerVehicleCandidate;
  /** Created physics runtime, or null while pending or after disposal. */
  runtime: DirectorVehicleRuntime | null;
  /** Current lifecycle status of the physics runtime. */
  status: PlayerVehicleRuntimeStatus;
  /** Session spawn pose used by the fall guard's respawn and group restore. */
  spawnPosition: Vector3;
  spawnQuaternion: Quaternion;
  spawnYaw: number;
  /** Mutable pose scratch refreshed from the runtime after each step. */
  pose: DirectorVehiclePose;
  /** True after the first creation failure warning has been emitted. */
  warned: boolean;
}

function createVehiclePoseScratch(): DirectorVehiclePose {
  return {
    position: new Vector3(),
    quaternion: new Quaternion(),
    wheelPositions: [new Vector3(), new Vector3(), new Vector3(), new Vector3()],
    wheelQuaternions: [new Quaternion(), new Quaternion(), new Quaternion(), new Quaternion()],
  };
}

/**
 * Creates initial session entries for every candidate vehicle. All entries start
 * in "pending" status; the caller must call `ensurePlayerVehicleRuntime` each
 * frame until the physics world and render meshes are ready.
 *
 * @param candidates - Drivable vehicle candidates from the project.
 * @returns A map from vehicle id to its session entry.
 */
export function createPlayerVehicleSessionEntries(
  candidates: readonly PlayerVehicleCandidate[],
): Map<string, PlayerVehicleSessionEntry> {
  const entries = new Map<string, PlayerVehicleSessionEntry>();
  for (const candidate of candidates) {
    entries.set(candidate.id, {
      candidate,
      runtime: null,
      status: "pending",
      spawnPosition: new Vector3(),
      spawnQuaternion: new Quaternion(),
      spawnYaw: 0,
      pose: createVehiclePoseScratch(),
      warned: false,
    });
  }
  return entries;
}

const ensureWorldQuaternion = new Quaternion();
const ensureWorldEuler = new Euler();
const ensureHalfExtents = new Vector3();

/**
 * Attempts to build the physics runtime for one vehicle. Returns the entry
 * status afterwards; "pending" means a dependency (world or mounted meshes)
 * is not ready yet and the caller should retry on a later frame.
 */
export function ensurePlayerVehicleRuntime(
  entry: PlayerVehicleSessionEntry,
  group: Object3D | null,
  binding: { rapier: unknown; world: unknown } | null,
): PlayerVehicleRuntimeStatus {
  if (entry.status !== "pending") return entry.status;
  if (!group || !binding) return "pending";
  const halfExtents = measureVehicleChassisHalfExtents(group, ensureHalfExtents);
  if (!halfExtents) return "pending";
  group.getWorldPosition(entry.spawnPosition);
  group.getWorldQuaternion(ensureWorldQuaternion);
  entry.spawnQuaternion.copy(ensureWorldQuaternion);
  entry.spawnYaw = ensureWorldEuler.setFromQuaternion(ensureWorldQuaternion, "YXZ").y;
  try {
    entry.runtime = createDirectorVehicleRuntime({
      profile: entry.candidate.profile,
      chassis: {
        halfExtents: halfExtents.clone(),
        position: entry.spawnPosition.clone(),
        yawRadians: entry.spawnYaw,
      },
      rapierWorld: binding.world,
      rapier: binding.rapier,
    });
    entry.status = "ready";
    entry.pose.position.copy(entry.spawnPosition);
    entry.pose.quaternion.copy(ensureWorldQuaternion);
  } catch (error) {
    entry.status = "failed";
    if (!entry.warned) {
      entry.warned = true;
      console.warn(
        `[Director] Vehicle "${entry.candidate.name}" is not enterable: physics runtime unavailable.`,
        error,
      );
    }
  }
  return entry.status;
}

/**
 * Disposes every created runtime. Must run before the shared Rapier world is
 * freed; the optional callback lets the caller restore render-group transforms
 * for vehicles that were driven during the session.
 */
export function disposePlayerVehicleEntries(
  entries: Map<string, PlayerVehicleSessionEntry>,
  onDisposedEntry?: (entry: PlayerVehicleSessionEntry) => void,
) {
  for (const entry of entries.values()) {
    if (entry.runtime) {
      try {
        entry.runtime.dispose();
      } catch (error) {
        console.warn(`[Director] Vehicle runtime dispose failed for "${entry.candidate.name}".`, error);
      }
      entry.runtime = null;
      onDisposedEntry?.(entry);
    }
    entry.status = "pending";
  }
}
