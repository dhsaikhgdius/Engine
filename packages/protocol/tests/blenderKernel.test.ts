import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import {
  BLENDER_INVOKE_OPERATOR_CATEGORY_DENYLIST,
  BLENDER_INVOKE_OPERATOR_ID_DENYLIST,
  BLENDER_KERNEL_TYPED_OPERATION_NAMES,
  assertBlenderKernelPolicy,
  isAllowedBlenderOperator,
  isAllowedBlenderRnaWrite,
  isAllowedBlenderTypedPropertyName,
} from "../src/blenderKernel";

const execFileAsync = promisify(execFile);
const kernelPolicyPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../integrations/blender/live/addons/worldengine_studio/kernel_policy.py",
);
const kernelPolicyTestPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../integrations/blender/live/addons/worldengine_studio/tests/test_kernel_policy.py",
);

it("freezes typed kernel operations separately from the operator long tail", () => {
  expect(BLENDER_KERNEL_TYPED_OPERATION_NAMES).toContain("create_blockout");
  expect(BLENDER_KERNEL_TYPED_OPERATION_NAMES).toContain("set_world_environment");
  expect(BLENDER_KERNEL_TYPED_OPERATION_NAMES).toContain("select_mesh_elements");
  expect(BLENDER_KERNEL_TYPED_OPERATION_NAMES).not.toContain("invoke_operator");
  expect(BLENDER_KERNEL_TYPED_OPERATION_NAMES).not.toContain("set_rna_property");
  expect(BLENDER_KERNEL_TYPED_OPERATION_NAMES).not.toContain("execute_code");
});

it("denies session-destroying mainfile loads on the same grounds as quitting", () => {
  for (const operator of [
    "wm.open_mainfile",
    "wm.revert_mainfile",
    "wm.read_homefile",
    "wm.read_factory_settings",
    "wm.recover_last_session",
    "wm.recover_auto_save",
  ]) {
    expect(isAllowedBlenderOperator(operator), operator).toBe(false);
    expect(() => assertBlenderKernelPolicy([{ op: "invoke_operator", operator }])).toThrow(
      /outside the Director modeling kernel/,
    );
  }
  // Saving never invalidates the live session and must stay allowed.
  expect(isAllowedBlenderOperator("wm.save_as_mainfile")).toBe(true);
  expect(isAllowedBlenderOperator("wm.save_mainfile")).toBe(true);
});

it("denies path-like typed modifier and geometry-node property names at the gateway boundary", () => {
  for (const name of ["filepath", "FILEPATH", "filename", "directory", "library", "script", "expression"]) {
    expect(isAllowedBlenderTypedPropertyName(name), name).toBe(false);
  }
  for (const name of ["width", "segments", "use_clamp_overlap", "filepath_extra", "my_filename"]) {
    expect(isAllowedBlenderTypedPropertyName(name), name).toBe(true);
  }
  expect(() =>
    assertBlenderKernelPolicy([
      {
        op: "add_modifier",
        id: "cube-a",
        modifierName: "Bevel",
        modifierType: "BEVEL",
        properties: { filepath: "/etc/passwd" },
      },
    ]),
  ).toThrow(/outside the Director modeling kernel/);
  expect(() =>
    assertBlenderKernelPolicy([
      { op: "set_modifier", id: "cube-a", modifierName: "Bevel", properties: { directory: "../.." } },
    ]),
  ).toThrow(/outside the Director modeling kernel/);
  expect(() =>
    assertBlenderKernelPolicy([
      {
        op: "create_geometry_node",
        id: "cube-a",
        nodeRef: "node-a",
        nodeType: "MATH",
        nodeProperties: { filename: "evil.py" },
      },
    ]),
  ).toThrow(/outside the Director modeling kernel/);
  expect(() =>
    assertBlenderKernelPolicy([
      {
        op: "add_modifier",
        id: "cube-a",
        modifierName: "Bevel",
        modifierType: "BEVEL",
        properties: { width: 0.1, segments: 3 },
      },
    ]),
  ).not.toThrow();
  // invoke_operator properties stay open for import/export operators.
  expect(() =>
    assertBlenderKernelPolicy([
      { op: "invoke_operator", operator: "import_scene.gltf", properties: { filepath: "/tmp/model.glb" } },
    ]),
  ).not.toThrow();
});

it("allows import, render, and save, and denies quitting Blender", () => {
  expect(isAllowedBlenderOperator("mesh.subdivide")).toBe(true);
  expect(isAllowedBlenderOperator("mesh.extrude_region_shrink_fatten")).toBe(true);
  expect(isAllowedBlenderOperator("object.modifier_add")).toBe(true);
  expect(isAllowedBlenderOperator("worldengine.cancelled_smoke")).toBe(true);
  expect(isAllowedBlenderOperator("import_scene.gltf")).toBe(true);
  expect(isAllowedBlenderOperator("wm.save_as_mainfile")).toBe(true);
  expect(isAllowedBlenderOperator("script.python_file_run")).toBe(true);
  expect(isAllowedBlenderOperator("render.render")).toBe(true);
  expect(isAllowedBlenderOperator("sculpt.brush_stroke")).toBe(true);
  expect(isAllowedBlenderOperator("wm.quit_blender")).toBe(false);
  expect(isAllowedBlenderOperator("wm.window_close")).toBe(false);
  expect(isAllowedBlenderOperator("console.do_console")).toBe(false);
  expect(isAllowedBlenderOperator("not-an-operator")).toBe(false);
});

it("allows scene and world RNA writes, including render filepaths", () => {
  expect(
    isAllowedBlenderRnaWrite({
      target: { kind: "modifier" },
      path: ["width"],
    }),
  ).toBe(true);
  expect(
    isAllowedBlenderRnaWrite({
      target: { kind: "scene" },
      path: ["eevee", "use_gtao"],
    }),
  ).toBe(true);
  expect(
    isAllowedBlenderRnaWrite({
      target: { kind: "scene" },
      path: ["render", "filepath"],
    }),
  ).toBe(true);
  expect(
    isAllowedBlenderRnaWrite({
      target: { kind: "world" },
      path: ["color"],
    }),
  ).toBe(true);
  expect(
    isAllowedBlenderRnaWrite({
      target: { kind: "object" },
      path: ["library"],
    }),
  ).toBe(false);
});

it("rejects only denylisted long-tail operators before they reach Blender", () => {
  expect(() => assertBlenderKernelPolicy([{ op: "invoke_operator", operator: "wm.quit_blender" }])).toThrow(
    /outside the Director modeling kernel/,
  );
  expect(() =>
    assertBlenderKernelPolicy([{ op: "set_rna_property", target: { kind: "data_block" }, path: ["name"] }]),
  ).toThrow(/RNA writes are limited/);
  expect(() => assertBlenderKernelPolicy([{ op: "invoke_operator", operator: "wm.save_as_mainfile" }])).not.toThrow();
  expect(() => assertBlenderKernelPolicy([{ op: "invoke_operator", operator: "mesh.bevel" }])).not.toThrow();
  expect(() =>
    assertBlenderKernelPolicy([{ op: "execute_code", code: "import bpy\nprint(len(bpy.data.objects))\n" }]),
  ).not.toThrow();
});

it("allows clipboard and import operators that previously required a closed allowlist", () => {
  expect(isAllowedBlenderOperator("view3d.copybuffer")).toBe(true);
  expect(isAllowedBlenderOperator("view3d.pastebuffer")).toBe(true);
  expect(isAllowedBlenderOperator("view3d.snap_selected_to_cursor")).toBe(true);
  expect(() => assertBlenderKernelPolicy([{ op: "invoke_operator", operator: "view3d.copybuffer" }])).not.toThrow();
});

it("allows file-path operator properties used for import and export", () => {
  expect(() =>
    assertBlenderKernelPolicy([
      {
        op: "invoke_operator",
        operator: "object.volume_import",
        properties: { filepath: "/tmp/agent.vdb", align: "WORLD" },
      },
    ]),
  ).not.toThrow();
  expect(() =>
    assertBlenderKernelPolicy([
      {
        op: "invoke_operator",
        operator: "mesh.extrude_region_shrink_fatten",
        properties: {
          MESH_OT_extrude_region: { use_normal_flip: false },
          TRANSFORM_OT_shrink_fatten: { filepath: "/tmp/escape.blend" },
        },
      },
    ]),
  ).not.toThrow();
  expect(() =>
    assertBlenderKernelPolicy([{ op: "invoke_operator", operator: "mesh.subdivide", properties: { number_cuts: 2 } }]),
  ).not.toThrow();
});

it("keeps the Python kernel policy sets in sync with the TS constants", () => {
  const kernelPolicySource = readFileSync(kernelPolicyPath, "utf8");
  const pythonSetMembers = (name: string): string[] => {
    const literal = kernelPolicySource.match(new RegExp(`^${name} = \\{([^}]*)\\}`, "m"));
    if (!literal) {
      throw new Error(`Python set literal not found: ${name}`);
    }
    return [...literal[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]).sort();
  };
  expect(pythonSetMembers("OPERATOR_CATEGORY_DENYLIST")).toEqual([...BLENDER_INVOKE_OPERATOR_CATEGORY_DENYLIST].sort());
  expect(pythonSetMembers("OPERATOR_ID_DENYLIST")).toEqual([...BLENDER_INVOKE_OPERATOR_ID_DENYLIST].sort());
});

it("keeps the Python typed-property denylist behaviorally in sync with the TS predicate", () => {
  const kernelPolicySource = readFileSync(kernelPolicyPath, "utf8");
  const literal = kernelPolicySource.match(/_TYPED_PROPERTY_DENY = re\.compile\(\s*r"([^"]+)"/);
  if (!literal) throw new Error("Python typed-property deny regex not found");
  const pythonPattern = new RegExp(literal[1], "i");
  for (const name of [
    "filepath",
    "FILEPATH",
    "filename",
    "directory",
    "library",
    "script",
    "expression",
    "width",
    "segments",
    "use_clamp_overlap",
    "filepath_extra",
    "my_filename",
  ]) {
    expect(isAllowedBlenderTypedPropertyName(name), name).toBe(!pythonPattern.test(name));
  }
});

it("passes the host-free Python kernel policy unittest suite without Blender installed", async () => {
  const { stderr } = await execFileAsync("python3", [kernelPolicyTestPath]);
  expect(stderr).toContain("OK");
}, 30_000);
