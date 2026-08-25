import { Euler, Quaternion } from "three";
import {
  DIRECTOR_DCC_ENGINE_SPACES,
  canonicalDccTransformToDirector,
  directorDccConnectorProviderIdSchema,
  directorDccEngineIdSchema,
  directorDirectionToEngine,
  directorPointToEngine,
  directorTransformToCanonicalDcc,
  directorTransformToEngine,
  engineCameraForwardAxis,
  enginePointToDirector,
  engineTransformToDirector,
  type DirectorDccEngineId,
} from "../../src/dcc/directorDccEngineSpace";
import type { DirectorTransform } from "../../src/comprehensive/editor/schema/directorProject";

const ENGINES: DirectorDccEngineId[] = ["unreal", "unity", "godot"];

function expectVectorClose(actual: readonly number[], expected: readonly number[], precision = 8) {
  expect(actual.length).toBe(expected.length);
  actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index]!, precision));
}

describe("Director DCC engine space (editor copy)", () => {
  it("declares the same provider vocabularies as the protocol package", () => {
    expect(directorDccEngineIdSchema.options).toEqual(["unreal", "unity", "godot"]);
    expect(directorDccConnectorProviderIdSchema.options).toEqual(["blender", "unreal", "unity", "godot"]);
    expect(directorDccEngineIdSchema.safeParse("blender").success).toBe(false);
  });

  it("publishes the documented engine bases and camera forward axes", () => {
    expect(DIRECTOR_DCC_ENGINE_SPACES.unreal.linearMap).toBe("(x,y,z)->(-z*100,x*100,y*100)");
    expect(DIRECTOR_DCC_ENGINE_SPACES.unity.linearMap).toBe("(x,y,z)->(x,y,-z)");
    expect(DIRECTOR_DCC_ENGINE_SPACES.godot.linearMap).toBe("(x,y,z)->(x,y,z)");
    expect(engineCameraForwardAxis("unreal")).toEqual([1, 0, 0]);
    expect(engineCameraForwardAxis("unity")).toEqual([0, 0, 1]);
    expect(engineCameraForwardAxis("godot")).toEqual([0, 0, -1]);
  });

  it("maps golden points into each engine space with the documented linear map", () => {
    const point: [number, number, number] = [1, 2, 3];
    expectVectorClose(directorPointToEngine("unreal", point), [-300, 100, 200]);
    expectVectorClose(directorPointToEngine("unity", point), [1, 2, -3]);
    expectVectorClose(directorPointToEngine("godot", point), [1, 2, 3]);
    expectVectorClose(directorDirectionToEngine("unreal", [0, 0, -1]), [1, 0, 0]);
    expectVectorClose(directorDirectionToEngine("unity", [0, 0, -1]), [0, 0, 1]);
    for (const engine of ENGINES) {
      expectVectorClose(enginePointToDirector(engine, directorPointToEngine(engine, point)), point);
    }
  });

  it("round-trips rotated, scaled transforms through every engine basis", () => {
    const transform: DirectorTransform = {
      position: [2.5, 1.25, -6],
      rotation: [0.3, -1.1, 2.4],
      scale: [1.5, 0.75, 2],
    };
    for (const engine of ENGINES) {
      const engineTransform = directorTransformToEngine(engine, transform);
      expect(Math.hypot(...engineTransform.rotationQuaternion)).toBeCloseTo(1, 8);
      const roundTripped = engineTransformToDirector(engine, engineTransform);
      expectVectorClose(roundTripped.position, transform.position, 6);
      expectVectorClose(roundTripped.scale, transform.scale, 6);
      const original = new Quaternion().setFromEuler(new Euler(...transform.rotation, "XYZ"));
      const recovered = new Quaternion().setFromEuler(new Euler(...roundTripped.rotation, "XYZ"));
      expect(Math.abs(original.dot(recovered))).toBeCloseTo(1, 6);
    }
  });

  it("round-trips canonical wire transforms used by engine return packages", () => {
    const sceneTransform: DirectorTransform = { position: [3, 0, -2], rotation: [0, Math.PI / 6, 0], scale: [2, 2, 2] };
    const transform: DirectorTransform = { position: [1, 2, 3], rotation: [0.4, -0.7, 1.2], scale: [1, 1.5, 0.5] };
    const wire = directorTransformToCanonicalDcc(transform, sceneTransform);
    const recovered = canonicalDccTransformToDirector(wire, sceneTransform);
    expectVectorClose(recovered.position, transform.position, 6);
    expectVectorClose(recovered.scale, transform.scale, 6);
  });
});
