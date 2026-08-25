import { Euler, Matrix4, Quaternion, Vector3 } from "three";
import { z } from "zod";
import type { DirectorTransform } from "../../../frontend/director/src/comprehensive/editor/schema/directorProject";
import { directorDccTransformSchema, type DirectorDccTransform } from "./directorDccSharedContract";

/**
 * Real-time engine providers with a Director-authored connector.
 * These are the only providers accepted by the engine handoff operations.
 */
export const directorDccEngineIdSchema = z.enum(["unreal", "unity", "godot"]);

/** Identifier of a real-time engine provider with a Director-authored connector. */
export type DirectorDccEngineId = z.infer<typeof directorDccEngineIdSchema>;

/**
 * Providers whose Director-authored connector can produce a
 * `director-dcc-return-v1` package (Blender plus the engine connectors).
 */
export const directorDccConnectorProviderIdSchema = z.enum(["blender", "unreal", "unity", "godot"]);

/** Identifier of a provider with a Director-authored return-package connector. */
export type DirectorDccConnectorProviderId = z.infer<typeof directorDccConnectorProviderIdSchema>;

/**
 * The static description of one engine's native space relative to Director's
 * canonical right-handed, Y-up, metre, camera-forward `-Z` space.
 */
export interface DirectorDccEngineSpace {
  /** Handedness of the engine's world space. */
  handedness: "left" | "right";
  /** World up axis of the engine. */
  upAxis: "Y" | "Z";
  /** The engine's conventional camera/actor forward axis in local space. */
  forwardAxis: "+X" | "+Z" | "-Z";
  /** Engine linear units per Director metre (Unreal uses centimetres). */
  unitsPerMeter: number;
  /** Human-readable point map from Director space to engine space. */
  linearMap: string;
}

/**
 * Canonical Director-to-engine basis facts for every supported engine.
 *
 * - Unreal Engine: left-handed, Z-up, `+X` forward, centimetres.
 * - Unity: left-handed, Y-up, `+Z` forward, metres.
 * - Godot 4: right-handed, Y-up, `-Z` forward, metres (matches Director).
 */
export const DIRECTOR_DCC_ENGINE_SPACES: Readonly<Record<DirectorDccEngineId, DirectorDccEngineSpace>> = Object.freeze({
  unreal: {
    handedness: "left",
    upAxis: "Z",
    forwardAxis: "+X",
    unitsPerMeter: 100,
    linearMap: "(x,y,z)->(-z*100,x*100,y*100)",
  },
  unity: {
    handedness: "left",
    upAxis: "Y",
    forwardAxis: "+Z",
    unitsPerMeter: 1,
    linearMap: "(x,y,z)->(x,y,-z)",
  },
  godot: {
    handedness: "right",
    upAxis: "Y",
    forwardAxis: "-Z",
    unitsPerMeter: 1,
    linearMap: "(x,y,z)->(x,y,z)",
  },
});

// Signed-permutation part of each Director→engine basis change (no unit scale).
// Chosen so Director right/up/forward map onto the engine's right/up/forward,
// which also carries Director's camera-forward -Z onto each engine's own
// camera-forward convention without an extra camera-local rotation.
const ENGINE_PERMUTATIONS: Record<DirectorDccEngineId, Matrix4> = {
  unreal: new Matrix4().set(0, 0, -1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1),
  unity: new Matrix4().set(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1),
  godot: new Matrix4().identity(),
};

function enginePermutation(engine: DirectorDccEngineId): Matrix4 {
  return ENGINE_PERMUTATIONS[engine].clone();
}

function engineBasis(engine: DirectorDccEngineId): Matrix4 {
  const scale = DIRECTOR_DCC_ENGINE_SPACES[engine].unitsPerMeter;
  return enginePermutation(engine).multiply(new Matrix4().makeScale(scale, scale, scale));
}

function matrixFromTransform(transform: DirectorTransform): Matrix4 {
  return new Matrix4().compose(
    new Vector3(...transform.position),
    new Quaternion().setFromEuler(new Euler(...transform.rotation, "XYZ")),
    new Vector3(...transform.scale),
  );
}

function tuple3(vector: Vector3): [number, number, number] {
  return [vector.x, vector.y, vector.z];
}

function tuple4(value: Quaternion): [number, number, number, number] {
  return [value.x, value.y, value.z, value.w];
}

/**
 * Convert a point from Director's canonical space to an engine's native space,
 * applying both the axis permutation and the engine's linear unit scale.
 *
 * @param engine - The target engine.
 * @param point - A point in Director space (metres).
 * @returns The point in the engine's native space and units.
 */
export function directorPointToEngine(
  engine: DirectorDccEngineId,
  point: [number, number, number],
): [number, number, number] {
  return tuple3(new Vector3(...point).applyMatrix4(engineBasis(engine)));
}

/**
 * Convert a point from an engine's native space back to Director's canonical space.
 *
 * @param engine - The source engine.
 * @param point - A point in the engine's native space and units.
 * @returns The point in Director space (metres).
 */
export function enginePointToDirector(
  engine: DirectorDccEngineId,
  point: [number, number, number],
): [number, number, number] {
  return tuple3(new Vector3(...point).applyMatrix4(engineBasis(engine).invert()));
}

/**
 * Convert a direction (unit-independent vector) from Director space to engine
 * space. Directions ignore the engine's linear unit scale.
 *
 * @param engine - The target engine.
 * @param direction - A direction in Director space.
 * @returns The direction in engine space.
 */
export function directorDirectionToEngine(
  engine: DirectorDccEngineId,
  direction: [number, number, number],
): [number, number, number] {
  return tuple3(new Vector3(...direction).applyMatrix4(enginePermutation(engine)));
}

/**
 * Convert a direction from engine space back to Director space.
 *
 * @param engine - The source engine.
 * @param direction - A direction in engine space.
 * @returns The direction in Director space.
 */
export function engineDirectionToDirector(
  engine: DirectorDccEngineId,
  direction: [number, number, number],
): [number, number, number] {
  return tuple3(new Vector3(...direction).applyMatrix4(enginePermutation(engine).invert()));
}

/**
 * Convert a Director transform (Euler rotation, arbitrary scale) into an
 * engine-native transform (location in engine units, normalized quaternion,
 * unitless scale factors). Optionally composes the Director scene transform
 * first so the result is an engine world transform.
 *
 * @param engine - The target engine.
 * @param transform - The Director transform to convert.
 * @param sceneTransform - Optional Director scene-level transform to apply first.
 * @returns The equivalent transform in engine space.
 */
export function directorTransformToEngine(
  engine: DirectorDccEngineId,
  transform: DirectorTransform,
  sceneTransform?: DirectorTransform,
): DirectorDccTransform {
  const directorMatrix = sceneTransform
    ? matrixFromTransform(sceneTransform).multiply(matrixFromTransform(transform))
    : matrixFromTransform(transform);
  const engineMatrix = engineBasis(engine).multiply(directorMatrix).multiply(engineBasis(engine).invert());
  const location = new Vector3();
  const rotation = new Quaternion();
  const scale = new Vector3();
  engineMatrix.decompose(location, rotation, scale);
  return { location: tuple3(location), rotationQuaternion: tuple4(rotation.normalize()), scale: tuple3(scale) };
}

/**
 * Convert an engine-native transform back to a Director transform with Euler
 * rotation. Optionally inverts the Director scene transform so the result is a
 * Director local transform.
 *
 * @param engine - The source engine.
 * @param transform - The engine-native transform.
 * @param sceneTransform - Optional Director scene-level transform to invert.
 * @returns The equivalent Director transform.
 */
export function engineTransformToDirector(
  engine: DirectorDccEngineId,
  transform: DirectorDccTransform,
  sceneTransform?: DirectorTransform,
): DirectorTransform {
  const parsed = directorDccTransformSchema.parse(transform);
  const engineMatrix = new Matrix4().compose(
    new Vector3(...parsed.location),
    new Quaternion(...parsed.rotationQuaternion).normalize(),
    new Vector3(...parsed.scale),
  );
  const directorWorldMatrix = engineBasis(engine).invert().multiply(engineMatrix).multiply(engineBasis(engine));
  const directorMatrix = sceneTransform
    ? matrixFromTransform(sceneTransform).invert().multiply(directorWorldMatrix)
    : directorWorldMatrix;
  const position = new Vector3();
  const rotation = new Quaternion();
  const scale = new Vector3();
  directorMatrix.decompose(position, rotation, scale);
  const euler = new Euler().setFromQuaternion(rotation.normalize(), "XYZ");
  return {
    position: tuple3(position),
    rotation: [euler.x, euler.y, euler.z],
    scale: tuple3(scale),
  };
}

/**
 * Convert a Director world-space point to engine space, applying the scene
 * transform first.
 *
 * @param engine - The target engine.
 * @param point - A world-space point in Director coordinates.
 * @param sceneTransform - The Director scene transform to apply.
 * @returns The point in engine space and units.
 */
export function directorWorldPointToEngine(
  engine: DirectorDccEngineId,
  point: [number, number, number],
  sceneTransform: DirectorTransform,
): [number, number, number] {
  const directorWorld = new Vector3(...point).applyMatrix4(matrixFromTransform(sceneTransform));
  return tuple3(directorWorld.applyMatrix4(engineBasis(engine)));
}

/**
 * The engine's conventional local camera-forward axis as a unit vector.
 *
 * @param engine - The engine to look up.
 * @returns The local forward axis (Unreal `+X`, Unity `+Z`, Godot `-Z`).
 */
export function engineCameraForwardAxis(engine: DirectorDccEngineId): [number, number, number] {
  switch (DIRECTOR_DCC_ENGINE_SPACES[engine].forwardAxis) {
    case "+X":
      return [1, 0, 0];
    case "+Z":
      return [0, 0, 1];
    case "-Z":
      return [0, 0, -1];
  }
}

/**
 * The world-space camera-forward ray of an engine-native camera transform,
 * following the engine's own forward-axis convention.
 *
 * @param engine - The engine whose convention applies.
 * @param transform - The engine-native camera transform.
 * @returns The unit forward direction in engine world space.
 */
export function engineCameraForward(
  engine: DirectorDccEngineId,
  transform: DirectorDccTransform,
): [number, number, number] {
  const parsed = directorDccTransformSchema.parse(transform);
  const rotation = new Quaternion(...parsed.rotationQuaternion).normalize();
  return tuple3(new Vector3(...engineCameraForwardAxis(engine)).applyQuaternion(rotation).normalize());
}

/**
 * Convert a Director transform into the canonical wire transform used by
 * engine return packages: location/quaternion/scale in Director's own
 * right-handed, Y-up, metre space (no basis change). Optionally composes the
 * scene transform so the result is a world transform.
 *
 * @param transform - The Director transform to convert.
 * @param sceneTransform - Optional Director scene-level transform to apply first.
 * @returns A canonical-space DCC transform.
 */
export function directorTransformToCanonicalDcc(
  transform: DirectorTransform,
  sceneTransform?: DirectorTransform,
): DirectorDccTransform {
  const directorMatrix = sceneTransform
    ? matrixFromTransform(sceneTransform).multiply(matrixFromTransform(transform))
    : matrixFromTransform(transform);
  const location = new Vector3();
  const rotation = new Quaternion();
  const scale = new Vector3();
  directorMatrix.decompose(location, rotation, scale);
  return { location: tuple3(location), rotationQuaternion: tuple4(rotation.normalize()), scale: tuple3(scale) };
}

/**
 * Convert a canonical wire transform (Director space, quaternion rotation)
 * back to a Director transform with Euler rotation. Optionally inverts the
 * scene transform so the result is a Director local transform.
 *
 * @param transform - The canonical-space DCC transform.
 * @param sceneTransform - Optional Director scene-level transform to invert.
 * @returns The equivalent Director transform.
 */
export function canonicalDccTransformToDirector(
  transform: DirectorDccTransform,
  sceneTransform?: DirectorTransform,
): DirectorTransform {
  const parsed = directorDccTransformSchema.parse(transform);
  const worldMatrix = new Matrix4().compose(
    new Vector3(...parsed.location),
    new Quaternion(...parsed.rotationQuaternion).normalize(),
    new Vector3(...parsed.scale),
  );
  const directorMatrix = sceneTransform
    ? matrixFromTransform(sceneTransform).invert().multiply(worldMatrix)
    : worldMatrix;
  const position = new Vector3();
  const rotation = new Quaternion();
  const scale = new Vector3();
  directorMatrix.decompose(position, rotation, scale);
  const euler = new Euler().setFromQuaternion(rotation.normalize(), "XYZ");
  return {
    position: tuple3(position),
    rotation: [euler.x, euler.y, euler.z],
    scale: tuple3(scale),
  };
}

/**
 * Convert a Director world-space point into the canonical wire space used by
 * engine return packages (identity basis, scene transform applied).
 *
 * @param point - A world-space point in Director coordinates.
 * @param sceneTransform - The Director scene transform to apply.
 * @returns The point in canonical wire space.
 */
export function directorWorldPointToCanonical(
  point: [number, number, number],
  sceneTransform: DirectorTransform,
): [number, number, number] {
  return tuple3(new Vector3(...point).applyMatrix4(matrixFromTransform(sceneTransform)));
}
