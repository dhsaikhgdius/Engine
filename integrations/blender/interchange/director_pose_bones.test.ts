import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Euler, Quaternion } from "three";
import { canonicalizeHumanoidBoneName } from "../../../frontend/director/src/comprehensive/editor/loaders/humanoidRig";
import { getMixamoPoseBoneRotations } from "../../../frontend/director/src/comprehensive/editor/runtime/mixamo/mixamoCharacterRig";
import mixamoBoneRoleAliases from "../../../frontend/director/src/comprehensive/editor/runtime/mixamo/mixamoBoneRoleAliases.json";

const execFileAsync = promisify(execFile);
const script = resolve(dirname(fileURLToPath(import.meta.url)), "director_pose_bones.py");

/** Run a Python snippet with director_pose_bones importable and JSON on stdin. */
async function runPython(source: string, input?: unknown) {
  const wrapped = [
    "import importlib.util, json, sys",
    'spec = importlib.util.spec_from_file_location("director_pose_bones", sys.argv[1])',
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    input === undefined ? "payload = None" : "payload = json.loads(sys.stdin.read())",
    source,
  ].join("\n");
  const child = execFileAsync("python3", ["-c", wrapped, script], { timeout: 30_000 });
  if (input !== undefined) child.child.stdin!.end(JSON.stringify(input));
  const { stdout } = await child;
  return JSON.parse(stdout.trim());
}

describe("director_pose_bones host-free mapping", () => {
  it("keeps the Python bone-role alias table synced with the frontend JSON", async () => {
    const table = await runPython("print(json.dumps({k: list(v) for k, v in module.MIXAMO_BONE_ROLE_ALIASES.items()}))");
    expect(table).toEqual(mixamoBoneRoleAliases);
  });

  it("canonicalizes bone names byte-identically to canonicalizeHumanoidBoneName", async () => {
    const names = [
      "mixamorig:LeftArm",
      "mixamorig_1:Spine2",
      "Armature|mixamorig:Head",
      "mixamorig 2 RightForeArm",
      "mixamorig9:Hips",
      "LeftUpLeg.001",
      "  mixamorig:LeftFoot  ",
      "some/path\\mixamorig:RightHand",
      "NotMixamo:Custom-Bone_42",
      "",
    ];
    const python = await runPython("print(json.dumps([module.canonical_bone_name(name) for name in payload]))", names);
    expect(python).toEqual(names.map((name) => canonicalizeHumanoidBoneName(name)));
  });

  it("resolves Director bone roles across mixamorig namespaces with first-alias priority", async () => {
    const boneNames = [
      "mixamorig:Hips",
      "mixamorig:Spine",
      "mixamorig:Spine1",
      "mixamorig:Spine2",
      "mixamorig:Head",
      "mixamorig:LeftArm",
      "mixamorig:LeftShoulder",
      "mixamorig:LeftForeArm",
      "mixamorig:LeftHand",
      "mixamorig:RightUpLeg",
      "mixamorig:RightLeg",
      "mixamorig:RightFoot",
      "mixamorig:TotallyCustomBone",
    ];
    const resolved = await runPython("print(json.dumps(module.resolve_pose_bone_roles(payload)))", boneNames);
    expect(resolved).toMatchObject({
      body: "mixamorig:Hips",
      torso: "mixamorig:Spine2",
      head: "mixamorig:Head",
      leftShoulder: "mixamorig:LeftArm",
      leftElbow: "mixamorig:LeftForeArm",
      leftHand: "mixamorig:LeftHand",
      rightHip: "mixamorig:RightUpLeg",
      rightKnee: "mixamorig:RightLeg",
      rightFoot: "mixamorig:RightFoot",
    });
    expect(resolved).not.toHaveProperty("rightShoulder");
    expect(resolved).not.toHaveProperty("leftHip");
  });

  it("recovers portable control values from bone rotation deltas built by the Director rig adapter", async () => {
    // Values chosen inside Director's control limits so the frontend clamp in
    // getMixamoPoseBoneRotations is a no-op and recovery must be exact.
    const controls: Record<string, number> = {
      "head.yaw": 25,
      "head.pitch": -10,
      "torso.roll": 8,
      "leftShoulder.pitch": -12,
      "rightShoulder.spread": 15,
      "leftElbow.bend": 30,
      "rightElbow.bend": 20,
      "leftHip.twist": -9,
      "rightHip.spread": 10,
      "leftKnee.bend": 25,
      "leftFoot.twist": -14,
    };
    // animated=true excludes the static neutral-shoulder offset, matching the
    // delta model: the Blender baseline pose already contains that offset.
    const rotations = getMixamoPoseBoneRotations(controls, undefined, true);
    const deltasByRole: Record<string, [number, number, number, number]> = {};
    for (const [role, [x, y, z]] of Object.entries(rotations)) {
      if (x === 0 && y === 0 && z === 0) continue;
      const quaternion = new Quaternion().setFromEuler(new Euler(x, y, z, "XYZ"));
      deltasByRole[role] = [quaternion.w, quaternion.x, quaternion.y, quaternion.z];
    }
    const baseline = Object.fromEntries(Object.keys(controls).map((control) => [control, 0]));
    const [recovered, warnings] = await runPython(
      "print(json.dumps(list(module.reconcile_pose_bone_deltas(payload['deltas'], payload['baseline']))))",
      { deltas: deltasByRole, baseline },
    );
    expect(warnings).toEqual([]);
    expect(Object.keys(recovered).sort()).toEqual(Object.keys(controls).sort());
    for (const [control, expected] of Object.entries(controls)) {
      expect(recovered[control]).toBeCloseTo(expected, 4);
    }
  });

  it("adds bone deltas on top of a nonzero exported control baseline", async () => {
    const rotations = getMixamoPoseBoneRotations({ "leftElbow.bend": 30 }, undefined, true);
    const [x, y, z] = rotations.leftElbow;
    const quaternion = new Quaternion().setFromEuler(new Euler(x, y, z, "XYZ"));
    const [recovered, warnings] = await runPython(
      "print(json.dumps(list(module.reconcile_pose_bone_deltas(payload['deltas'], payload['baseline']))))",
      {
        deltas: { leftElbow: [quaternion.w, quaternion.x, quaternion.y, quaternion.z] },
        baseline: { "leftElbow.bend": 15 },
      },
    );
    expect(warnings).toEqual([]);
    expect(recovered["leftElbow.bend"]).toBeCloseTo(45, 4);
  });

  it("warns and omits rotation components on axes without a portable control", async () => {
    // An elbow bent around its local X axis: Director only has leftElbow.bend (Z).
    const quaternion = new Quaternion().setFromEuler(new Euler((20 * Math.PI) / 180, 0, 0, "XYZ"));
    const [recovered, warnings] = await runPython(
      "print(json.dumps(list(module.reconcile_pose_bone_deltas(payload['deltas'], payload['baseline']))))",
      {
        deltas: { leftElbow: [quaternion.w, quaternion.x, quaternion.y, quaternion.z] },
        baseline: { "leftElbow.bend": 0 },
      },
    );
    expect(recovered).toEqual({});
    expect(warnings).toEqual([expect.stringContaining("no portable Director control")]);
  });

  it("warns and omits deltas for roles and controls outside the exported baseline", async () => {
    const quaternion = new Quaternion().setFromEuler(new Euler(0, (15 * Math.PI) / 180, 0, "XYZ"));
    const delta: [number, number, number, number] = [quaternion.w, quaternion.x, quaternion.y, quaternion.z];
    const [recovered, warnings] = await runPython(
      "print(json.dumps(list(module.reconcile_pose_bone_deltas(payload['deltas'], payload['baseline']))))",
      { deltas: { notARole: delta, head: delta }, baseline: {} },
    );
    expect(recovered).toEqual({});
    expect(warnings).toEqual([
      expect.stringContaining("not part of this character's exported control baseline"),
      expect.stringContaining("notARole"),
    ]);
  });

  it("treats sub-threshold rotation noise as no change", async () => {
    const quaternion = new Quaternion().setFromEuler(new Euler(0.0000001, 0, 0.0000002, "XYZ"));
    const [recovered, warnings] = await runPython(
      "print(json.dumps(list(module.reconcile_pose_bone_deltas(payload['deltas'], payload['baseline']))))",
      {
        deltas: { head: [quaternion.w, quaternion.x, quaternion.y, quaternion.z] },
        baseline: { "head.pitch": 0, "head.yaw": 0, "head.roll": 0 },
      },
    );
    expect(recovered).toEqual({});
    expect(warnings).toEqual([]);
  });

  it("stays import-safe without bpy and free of remote execution primitives", async () => {
    const source = await import("node:fs/promises").then(({ readFile }) => readFile(script, "utf8"));
    expect(source).not.toContain("import bpy");
    expect(source).not.toMatch(/\b(requests|urllib|eval|exec)\s*\(/);
  });
});
