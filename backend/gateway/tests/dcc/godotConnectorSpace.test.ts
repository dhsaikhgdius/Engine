import { Matrix4, Quaternion, Vector3 } from "three";
import type { DirectorTransform } from "@director/project-schema";
import {
  directorTransformToCanonicalDcc,
  engineCameraForward,
  engineCameraForwardAxis,
  type DirectorDccTransform,
} from "@director/dcc-protocol";
import { directorCameraLookEuler } from "@director/dcc-interchange";

/**
 * TypeScript mirrors of the GDScript closed forms in
 * integrations/godot/addons/director_bridge/director_space.gd, validated
 * against the protocol reference (`directorDccEngineSpace.ts`). Godot's basis
 * is identical to Director canonical space, so every check here must hold as
 * a strict identity — including under negative scale and mirrored transforms,
 * where matrix-level equality is the contract because TRS decomposition of a
 * negative-determinant basis is ambiguous.
 */

/** Mirror of director_space.gd quat_from_euler_xyz (Director's intrinsic XYZ order). */
function gdQuatFromEulerXyz(rx: number, ry: number, rz: number): Quaternion {
  const qx = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), rx);
  const qy = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), ry);
  const qz = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), rz);
  return qx.multiply(qy).multiply(qz).normalize();
}

/** Mirror of director_space.gd compose_world_transform (uniform scene scale). */
function gdComposeWorldTransform(
  scene: { position: [number, number, number]; rotation: [number, number, number]; scale: number },
  transform: DirectorTransform,
): DirectorDccTransform {
  const sceneQuat = gdQuatFromEulerXyz(...scene.rotation);
  const localQuat = gdQuatFromEulerXyz(...transform.rotation);
  const rotated = new Vector3(...transform.position).multiplyScalar(scene.scale).applyQuaternion(sceneQuat);
  const worldPosition = rotated.add(new Vector3(...scene.position));
  const worldQuat = sceneQuat.clone().multiply(localQuat).normalize();
  return {
    location: [worldPosition.x, worldPosition.y, worldPosition.z],
    rotationQuaternion: [worldQuat.x, worldQuat.y, worldQuat.z, worldQuat.w],
    scale: [transform.scale[0] * scene.scale, transform.scale[1] * scene.scale, transform.scale[2] * scene.scale],
  };
}

/** Mirror of director_space.gd godot_transform_from_canonical: basis = R(q) * S(scale). */
function gdMatrixFromCanonical(canonical: DirectorDccTransform): Matrix4 {
  return new Matrix4().compose(
    new Vector3(...canonical.location),
    new Quaternion(...canonical.rotationQuaternion).normalize(),
    new Vector3(...canonical.scale),
  );
}

function matrixOfDirector(transform: DirectorTransform): Matrix4 {
  return new Matrix4().compose(
    new Vector3(...transform.position),
    gdQuatFromEulerXyz(...transform.rotation),
    new Vector3(...transform.scale),
  );
}

function expectMatrixClose(actual: Matrix4, expected: Matrix4, tolerance = 1e-9) {
  actual.elements.forEach((element, index) => {
    expect(Math.abs(element - expected.elements[index]!)).toBeLessThanOrEqual(tolerance);
  });
}

const SCENE = { position: [1, 0, -2] as [number, number, number], rotation: [0, Math.PI / 6, 0.4] as [number, number, number], scale: 2 };

const SAMPLE_TRANSFORMS: DirectorTransform[] = [
  { position: [1.5, 2, -3], rotation: [0.2, -0.7, 1.1], scale: [1, 2, 0.5] },
  { position: [0, 0, 0], rotation: [0, Math.PI / 2, 0], scale: [1, 1, 1] },
  { position: [-4, 0.25, 9], rotation: [Math.PI, 0, -Math.PI / 3], scale: [2, 2, 2] },
];

const MIRRORED_TRANSFORMS: DirectorTransform[] = [
  { position: [1.5, 0.5, -2], rotation: [0.3, 0.5, -0.2], scale: [-1, 1, 1] },
  { position: [0, 3, 4], rotation: [-0.4, 1.2, 0.7], scale: [1, -2, 1] },
  { position: [-2, 1, 0.5], rotation: [0.1, -0.9, 2.4], scale: [-1, -1, 2] },
];

describe("Godot connector world composition matches the protocol reference", () => {
  it("compose_world_transform equals the matrix reference for positive scales", () => {
    for (const sample of SAMPLE_TRANSFORMS) {
      const reference = directorTransformToCanonicalDcc(sample, {
        position: SCENE.position,
        rotation: SCENE.rotation,
        scale: [SCENE.scale, SCENE.scale, SCENE.scale],
      });
      const closedForm = gdComposeWorldTransform(SCENE, sample);
      for (let index = 0; index < 3; index += 1) {
        expect(closedForm.location[index]).toBeCloseTo(reference.location[index]!, 9);
        expect(closedForm.scale[index]).toBeCloseTo(reference.scale[index]!, 9);
      }
      const dot = closedForm.rotationQuaternion.reduce(
        (sum, value, index) => sum + value * reference.rotationQuaternion[index]!,
        0,
      );
      expect(Math.abs(dot)).toBeCloseTo(1, 9);
    }
  });

  it("compose_world_transform equals the matrix reference for mirrored transforms at matrix level", () => {
    // Negative-determinant decompositions spread the sign across scale axes
    // differently, so the contract for mirrored transforms is equality of the
    // composed matrix, exactly as the connector's export drift check applies.
    const sceneMatrix = matrixOfDirector({
      position: SCENE.position,
      rotation: SCENE.rotation,
      scale: [SCENE.scale, SCENE.scale, SCENE.scale],
    });
    for (const sample of MIRRORED_TRANSFORMS) {
      const referenceMatrix = sceneMatrix.clone().multiply(matrixOfDirector(sample));
      const closedFormMatrix = gdMatrixFromCanonical(gdComposeWorldTransform(SCENE, sample));
      expectMatrixClose(closedFormMatrix, referenceMatrix, 1e-9);
    }
  });

  it("hierarchy restoration (local = parent_world^-1 * child_world) is exact under mirrored parents", () => {
    // The connector captures world transforms before reparenting and rebuilds
    // locals against the restored Director parents. This invariant must hold
    // for deep chains through negative-scale parents.
    const parentWorld = gdMatrixFromCanonical(gdComposeWorldTransform(SCENE, MIRRORED_TRANSFORMS[0]!));
    const childWorld = gdMatrixFromCanonical(gdComposeWorldTransform(SCENE, SAMPLE_TRANSFORMS[0]!));
    const local = parentWorld.clone().invert().multiply(childWorld);
    expectMatrixClose(parentWorld.clone().multiply(local), childWorld, 1e-8);

    const grandChildWorld = gdMatrixFromCanonical(gdComposeWorldTransform(SCENE, MIRRORED_TRANSFORMS[2]!));
    const grandChildLocal = childWorld.clone().invert().multiply(grandChildWorld);
    expectMatrixClose(childWorld.clone().multiply(grandChildLocal), grandChildWorld, 1e-8);
  });

  it("canonical -> Godot -> canonical roundtrip preserves mirrored world matrices", () => {
    for (const sample of MIRRORED_TRANSFORMS) {
      const canonical = gdComposeWorldTransform(SCENE, sample);
      // godot_transform_from_canonical then canonical_from_godot_transform.
      const godotMatrix = gdMatrixFromCanonical(canonical);
      const location = new Vector3();
      const rotation = new Quaternion();
      const scale = new Vector3();
      godotMatrix.decompose(location, rotation, scale);
      const echoed: DirectorDccTransform = {
        location: [location.x, location.y, location.z],
        rotationQuaternion: [rotation.x, rotation.y, rotation.z, rotation.w],
        scale: [scale.x, scale.y, scale.z],
      };
      expectMatrixClose(gdMatrixFromCanonical(echoed), godotMatrix, 1e-9);
    }
  });
});

describe("Godot camera forward-ray goldens match directorDccEngineSpace", () => {
  it("keeps the Godot camera forward axis at Director's own -Z", () => {
    expect(engineCameraForwardAxis("godot")).toEqual([0, 0, -1]);
  });

  it("aims the forward ray from the camera position to its look target", () => {
    const cameras = [
      { position: [0, 2, 8] as [number, number, number], target: [0, 1, 0] as [number, number, number] },
      { position: [5, 1, -4] as [number, number, number], target: [-2, 3, 6] as [number, number, number] },
      { position: [-3, 10, 0] as [number, number, number], target: [0, 0, 0] as [number, number, number] },
    ];
    for (const camera of cameras) {
      const rotation = directorCameraLookEuler({
        transform: { position: camera.position, rotation: [0, 0, 0], scale: [1, 1, 1] },
        target: camera.target,
      });
      const canonical = directorTransformToCanonicalDcc({
        position: camera.position,
        rotation,
        scale: [1, 1, 1],
      });
      const forward = engineCameraForward("godot", canonical);
      const expected = new Vector3(...camera.target).sub(new Vector3(...camera.position)).normalize();
      expect(forward[0]).toBeCloseTo(expected.x, 6);
      expect(forward[1]).toBeCloseTo(expected.y, 6);
      expect(forward[2]).toBeCloseTo(expected.z, 6);
    }
  });

  it("forward rays survive the identity provider map on rotated canonical transforms", () => {
    for (const sample of SAMPLE_TRANSFORMS) {
      const canonical = directorTransformToCanonicalDcc(sample);
      const forward = engineCameraForward("godot", canonical);
      const reference = new Vector3(0, 0, -1)
        .applyQuaternion(new Quaternion(...canonical.rotationQuaternion).normalize())
        .normalize();
      expect(forward[0]).toBeCloseTo(reference.x, 9);
      expect(forward[1]).toBeCloseTo(reference.y, 9);
      expect(forward[2]).toBeCloseTo(reference.z, 9);
    }
  });
});
