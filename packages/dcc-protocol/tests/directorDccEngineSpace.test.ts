import { describe, expect, it } from "vitest";
import { Euler, Quaternion, Vector3 } from "three";
import {
  DIRECTOR_DCC_ENGINE_SPACES,
  canonicalDccTransformToDirector,
  directorDccConnectorProviderIdSchema,
  directorDccEngineIdSchema,
  directorDirectionToEngine,
  directorPointToEngine,
  directorTransformToCanonicalDcc,
  directorTransformToEngine,
  directorWorldPointToCanonical,
  directorWorldPointToEngine,
  engineCameraForward,
  engineCameraForwardAxis,
  engineDirectionToDirector,
  enginePointToDirector,
  engineTransformToDirector,
  type DirectorDccEngineId,
} from "../src/directorDccEngineSpace";
import type { DirectorTransform } from "../../../frontend/director/src/comprehensive/editor/schema/directorProject";

const ENGINES: DirectorDccEngineId[] = ["unreal", "unity", "godot"];

function expectVectorClose(actual: readonly number[], expected: readonly number[], precision = 10) {
  expect(actual.length).toBe(expected.length);
  actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index]!, precision));
}

describe("Director DCC engine space contract", () => {
  it("declares provider vocabularies for engine and connector providers", () => {
    expect(directorDccEngineIdSchema.options).toEqual(["unreal", "unity", "godot"]);
    expect(directorDccConnectorProviderIdSchema.options).toEqual(["blender", "unreal", "unity", "godot"]);
    expect(directorDccEngineIdSchema.safeParse("blender").success).toBe(false);
    expect(directorDccEngineIdSchema.safeParse("maya").success).toBe(false);
  });

  it("publishes the documented engine bases", () => {
    expect(DIRECTOR_DCC_ENGINE_SPACES.unreal).toEqual({
      handedness: "left",
      upAxis: "Z",
      forwardAxis: "+X",
      unitsPerMeter: 100,
      linearMap: "(x,y,z)->(-z*100,x*100,y*100)",
    });
    expect(DIRECTOR_DCC_ENGINE_SPACES.unity).toEqual({
      handedness: "left",
      upAxis: "Y",
      forwardAxis: "+Z",
      unitsPerMeter: 1,
      linearMap: "(x,y,z)->(x,y,-z)",
    });
    expect(DIRECTOR_DCC_ENGINE_SPACES.godot).toEqual({
      handedness: "right",
      upAxis: "Y",
      forwardAxis: "-Z",
      unitsPerMeter: 1,
      linearMap: "(x,y,z)->(x,y,z)",
    });
  });

  it("maps golden points into each engine space with the documented linear map", () => {
    // Director point: 1m right, 2m up, 3m backward (+Z is behind the camera).
    const point: [number, number, number] = [1, 2, 3];
    expectVectorClose(directorPointToEngine("unreal", point), [-300, 100, 200]);
    expectVectorClose(directorPointToEngine("unity", point), [1, 2, -3]);
    expectVectorClose(directorPointToEngine("godot", point), [1, 2, 3]);
  });

  it("round-trips points and directions through every engine basis", () => {
    const point: [number, number, number] = [-4.25, 1.5, 9.75];
    const direction: [number, number, number] = [0.36, -0.48, 0.8];
    for (const engine of ENGINES) {
      expectVectorClose(enginePointToDirector(engine, directorPointToEngine(engine, point)), point);
      expectVectorClose(engineDirectionToDirector(engine, directorDirectionToEngine(engine, direction)), direction);
    }
  });

  it("maps Director's up and forward onto each engine's up and forward", () => {
    const directorUp: [number, number, number] = [0, 1, 0];
    const directorForward: [number, number, number] = [0, 0, -1];
    // Unreal: up +Z, forward +X.
    expectVectorClose(directorDirectionToEngine("unreal", directorUp), [0, 0, 1]);
    expectVectorClose(directorDirectionToEngine("unreal", directorForward), [1, 0, 0]);
    // Unity: up +Y, forward +Z.
    expectVectorClose(directorDirectionToEngine("unity", directorUp), [0, 1, 0]);
    expectVectorClose(directorDirectionToEngine("unity", directorForward), [0, 0, 1]);
    // Godot: identical basis to Director.
    expectVectorClose(directorDirectionToEngine("godot", directorUp), [0, 1, 0]);
    expectVectorClose(directorDirectionToEngine("godot", directorForward), [0, 0, -1]);
  });

  it("round-trips rotated, scaled transforms through every engine basis", () => {
    const transform: DirectorTransform = {
      position: [2.5, 1.25, -6],
      rotation: [0.3, -1.1, 2.4],
      scale: [1.5, 0.75, 2],
    };
    for (const engine of ENGINES) {
      const engineTransform = directorTransformToEngine(engine, transform);
      const quaternionLength = Math.hypot(...engineTransform.rotationQuaternion);
      expect(quaternionLength).toBeCloseTo(1, 10);
      const roundTripped = engineTransformToDirector(engine, engineTransform);
      expectVectorClose(roundTripped.position, transform.position, 8);
      expectVectorClose(roundTripped.scale, transform.scale, 8);
      const original = new Quaternion().setFromEuler(new Euler(...transform.rotation, "XYZ"));
      const recovered = new Quaternion().setFromEuler(new Euler(...roundTripped.rotation, "XYZ"));
      expect(Math.abs(original.dot(recovered))).toBeCloseTo(1, 8);
    }
  });

  it("keeps mirrored (negative-scale) hierarchies representable in every engine basis", () => {
    const mirrored: DirectorTransform = {
      position: [1, 2, 3],
      rotation: [0, Math.PI / 4, 0],
      scale: [-1, 1, 2],
    };
    for (const engine of ENGINES) {
      const engineTransform = directorTransformToEngine(engine, mirrored);
      const engineDeterminantSign = Math.sign(engineTransform.scale[0] * engineTransform.scale[1] * engineTransform.scale[2]);
      expect(engineDeterminantSign).toBe(-1);
      const roundTripped = engineTransformToDirector(engine, engineTransform);
      const recoveredDeterminantSign = Math.sign(roundTripped.scale[0] * roundTripped.scale[1] * roundTripped.scale[2]);
      expect(recoveredDeterminantSign).toBe(-1);
      // A mirrored transform must keep mapping points identically after the round trip.
      const probe: [number, number, number] = [0.5, -1.5, 2.5];
      const applyTransform = (candidate: DirectorTransform, value: [number, number, number]) => {
        const rotated = new Vector3(value[0] * candidate.scale[0], value[1] * candidate.scale[1], value[2] * candidate.scale[2])
          .applyQuaternion(new Quaternion().setFromEuler(new Euler(...candidate.rotation, "XYZ")))
          .add(new Vector3(...candidate.position));
        return [rotated.x, rotated.y, rotated.z] as [number, number, number];
      };
      expectVectorClose(applyTransform(roundTripped, probe), applyTransform(mirrored, probe), 8);
    }
  });

  it("translates positions in engine units while keeping scale factors unitless", () => {
    const transform: DirectorTransform = { position: [1, 2, 3], rotation: [0, 0, 0], scale: [2, 2, 2] };
    const unreal = directorTransformToEngine("unreal", transform);
    expectVectorClose(unreal.location, [-300, 100, 200]);
    expectVectorClose(unreal.scale, [2, 2, 2]);
  });

  it("carries Director's camera forward onto each engine's camera convention", () => {
    expect(engineCameraForwardAxis("unreal")).toEqual([1, 0, 0]);
    expect(engineCameraForwardAxis("unity")).toEqual([0, 0, 1]);
    expect(engineCameraForwardAxis("godot")).toEqual([0, 0, -1]);

    // A Director camera yawed 90° to the left looks along -X in Director space.
    const camera: DirectorTransform = { position: [0, 1.7, 4], rotation: [0, Math.PI / 2, 0], scale: [1, 1, 1] };
    const directorForward = new Vector3(0, 0, -1)
      .applyQuaternion(new Quaternion().setFromEuler(new Euler(...camera.rotation, "XYZ")))
      .normalize();
    for (const engine of ENGINES) {
      const engineTransform = directorTransformToEngine(engine, camera);
      const forward = engineCameraForward(engine, engineTransform);
      const expected = directorDirectionToEngine(engine, [directorForward.x, directorForward.y, directorForward.z]);
      expectVectorClose(forward, expected, 8);
    }
  });

  it("applies the Director scene transform for world-space conversion", () => {
    const sceneTransform: DirectorTransform = { position: [10, 0, 0], rotation: [0, 0, 0], scale: [2, 2, 2] };
    expectVectorClose(directorWorldPointToEngine("unity", [1, 1, 1], sceneTransform), [12, 2, -2]);
    expectVectorClose(directorWorldPointToEngine("unreal", [1, 1, 1], sceneTransform), [-200, 1200, 200]);
    const local: DirectorTransform = { position: [1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
    const world = directorTransformToEngine("godot", local, sceneTransform);
    expectVectorClose(world.location, [12, 0, 0]);
    const recovered = engineTransformToDirector("godot", world, sceneTransform);
    expectVectorClose(recovered.position, local.position, 8);
  });

  it("round-trips canonical wire transforms used by engine return packages", () => {
    const sceneTransform: DirectorTransform = { position: [3, 0, -2], rotation: [0, Math.PI / 6, 0], scale: [2, 2, 2] };
    const transform: DirectorTransform = {
      position: [1, 2, 3],
      rotation: [0.4, -0.7, 1.2],
      scale: [1, 1.5, 0.5],
    };
    const wire = directorTransformToCanonicalDcc(transform, sceneTransform);
    expect(Math.hypot(...wire.rotationQuaternion)).toBeCloseTo(1, 10);
    const recovered = canonicalDccTransformToDirector(wire, sceneTransform);
    expectVectorClose(recovered.position, transform.position, 8);
    expectVectorClose(recovered.scale, transform.scale, 8);
    const original = new Quaternion().setFromEuler(new Euler(...transform.rotation, "XYZ"));
    const roundTripped = new Quaternion().setFromEuler(new Euler(...recovered.rotation, "XYZ"));
    expect(Math.abs(original.dot(roundTripped))).toBeCloseTo(1, 8);

    expectVectorClose(directorWorldPointToCanonical([0, 0, 0], sceneTransform), [3, 0, -2]);
  });
});
