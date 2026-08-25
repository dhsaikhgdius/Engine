import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { DirectorTransform } from "@director/project-schema";
import {
  directorPointToEngine,
  directorTransformToCanonicalDcc,
  directorTransformToEngine,
  type DirectorDccTransform,
} from "@director/dcc-protocol";

const execFileAsync = promisify(execFile);

const repositoryRoot = resolve(__dirname, "..", "..", "..", "..");
const unrealPythonDirectory = resolve(
  repositoryRoot,
  "integrations",
  "unreal",
  "plugins",
  "DirectorBridge",
  "Content",
  "Python",
);

async function python3Available(): Promise<boolean> {
  try {
    await execFileAsync("python3", ["--version"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

const hasPython3 = await python3Available();

const SAMPLE_TRANSFORMS: DirectorTransform[] = [
  { position: [1.5, 2, -3], rotation: [0.2, -0.7, 1.1], scale: [1, 2, 0.5] },
  { position: [0, 0, 0], rotation: [0, Math.PI / 2, 0], scale: [1, 1, 1] },
  { position: [-4, 0.25, 9], rotation: [Math.PI, 0, -Math.PI / 3], scale: [2, 2, 2] },
];

const SCENE: DirectorTransform = { position: [1, 0, -2], rotation: [0, Math.PI / 6, 0], scale: [2, 2, 2] };

function expectTransformsClose(actual: DirectorDccTransform, expected: DirectorDccTransform) {
  for (let index = 0; index < 3; index += 1) {
    expect(actual.location[index]).toBeCloseTo(expected.location[index]!, 6);
    expect(actual.scale[index]).toBeCloseTo(expected.scale[index]!, 6);
  }
  const dot = actual.rotationQuaternion.reduce(
    (sum, value, index) => sum + value * expected.rotationQuaternion[index]!,
    0,
  );
  expect(Math.abs(dot)).toBeCloseTo(1, 6);
}

/**
 * Closed-form Unity conversion mirrored from
 * integrations/unity/com.director.bridge/Editor/DirectorSpace.cs. The basis
 * is the signed permutation (x,y,z)->(x,y,-z); quaternion vector parts
 * transform as v -> -Pv = (-x,-y,z).
 */
function unityClosedForm(transform: DirectorDccTransform): DirectorDccTransform {
  return {
    location: [transform.location[0], transform.location[1], -transform.location[2]],
    rotationQuaternion: [
      -transform.rotationQuaternion[0],
      -transform.rotationQuaternion[1],
      transform.rotationQuaternion[2],
      transform.rotationQuaternion[3],
    ],
    scale: [...transform.scale] as [number, number, number],
  };
}

/**
 * Closed-form Godot conversion mirrored from
 * integrations/godot/addons/director_bridge/director_space.gd: identity.
 */
function godotClosedForm(transform: DirectorDccTransform): DirectorDccTransform {
  return structuredClone(transform);
}

describe("engine connector coordinate math matches the protocol reference", () => {
  it("Unity connector closed form equals the matrix-conjugation reference", () => {
    for (const sample of SAMPLE_TRANSFORMS) {
      const canonical = directorTransformToCanonicalDcc(sample, SCENE);
      expectTransformsClose(unityClosedForm(canonical), directorTransformToEngine("unity", sample, SCENE));
    }
  });

  it("Godot connector closed form equals the matrix-conjugation reference", () => {
    for (const sample of SAMPLE_TRANSFORMS) {
      const canonical = directorTransformToCanonicalDcc(sample, SCENE);
      expectTransformsClose(godotClosedForm(canonical), directorTransformToEngine("godot", sample, SCENE));
    }
  });

  it.skipIf(!hasPython3)("Unreal connector pure-Python module passes its self-test", async () => {
    const { stdout } = await execFileAsync("python3", ["director_space.py", "--self-test"], {
      cwd: unrealPythonDirectory,
      timeout: 30_000,
    });
    expect(JSON.parse(stdout.trim())).toMatchObject({ ok: true });
  });

  it.skipIf(!hasPython3)("Unreal connector Python conversion matches the matrix-conjugation reference", async () => {
    const canonicalInputs = SAMPLE_TRANSFORMS.map((sample) => directorTransformToCanonicalDcc(sample, SCENE));
    const script = [
      "import json, sys",
      "sys.path.insert(0, '.')",
      "import director_space",
      "inputs = json.loads(sys.stdin.read())",
      "print(json.dumps([director_space.director_transform_to_unreal(t) for t in inputs]))",
    ].join("\n");
    const child = execFileAsync("python3", ["-c", script], { cwd: unrealPythonDirectory, timeout: 30_000 });
    child.child.stdin!.end(JSON.stringify(canonicalInputs));
    const { stdout } = await child;
    const converted = JSON.parse(stdout.trim()) as DirectorDccTransform[];
    converted.forEach((pythonTransform, index) => {
      expectTransformsClose(pythonTransform, directorTransformToEngine("unreal", SAMPLE_TRANSFORMS[index]!, SCENE));
    });
  });

  it.skipIf(!hasPython3)("Unreal connector world composition matches directorTransformToCanonicalDcc", async () => {
    const script = [
      "import json, sys",
      "sys.path.insert(0, '.')",
      "import director_space",
      "payload = json.loads(sys.stdin.read())",
      "scene = payload['scene']",
      "results = []",
      "for t in payload['transforms']:",
      "    quaternion = director_space.quat_from_euler_xyz(*t['rotation'])",
      "    results.append(director_space.compose_world_transform(",
      "        scene['position'], scene['rotation'], scene['scale'][0],",
      "        t['position'], quaternion, t['scale']))",
      "print(json.dumps(results))",
    ].join("\n");
    const child = execFileAsync("python3", ["-c", script], { cwd: unrealPythonDirectory, timeout: 30_000 });
    child.child.stdin!.end(JSON.stringify({ scene: SCENE, transforms: SAMPLE_TRANSFORMS }));
    const { stdout } = await child;
    const composed = JSON.parse(stdout.trim()) as DirectorDccTransform[];
    composed.forEach((pythonTransform, index) => {
      expectTransformsClose(pythonTransform, directorTransformToCanonicalDcc(SAMPLE_TRANSFORMS[index]!, SCENE));
    });
  });

  it("camera forward stays convention-correct per engine", () => {
    // Director camera forward is local -Z; the pinned permutations carry it
    // onto each engine's own forward axis without a camera-local rotation.
    expect(directorPointToEngine("unreal", [0, 0, -1])).toEqual([100, 0, 0]);
    expect(directorPointToEngine("unity", [0, 0, -1])).toEqual([0, 0, 1]);
    expect(directorPointToEngine("godot", [0, 0, -1])).toEqual([0, 0, -1]);
  });
});
