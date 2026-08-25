import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  BLENDER_INVOKE_OPERATOR_CATEGORY_DENYLIST,
  BLENDER_INVOKE_OPERATOR_ID_DENYLIST,
  BLENDER_KERNEL_TYPED_OPERATION_NAMES,
  assertBlenderKernelPolicy,
  isAllowedBlenderOperator,
  isAllowedBlenderRnaWrite,
} from "../src/blenderKernel";

it("freezes typed kernel operations separately from the operator long tail", () => {
  expect(BLENDER_KERNEL_TYPED_OPERATION_NAMES).toContain("create_blockout");
  expect(BLENDER_KERNEL_TYPED_OPERATION_NAMES).toContain("set_world_environment");
  expect(BLENDER_KERNEL_TYPED_OPERATION_NAMES).toContain("select_mesh_elements");
  expect(BLENDER_KERNEL_TYPED_OPERATION_NAMES).not.toContain("invoke_operator");
  expect(BLENDER_KERNEL_TYPED_OPERATION_NAMES).not.toContain("set_rna_property");
  expect(BLENDER_KERNEL_TYPED_OPERATION_NAMES).not.toContain("execute_code");
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
  const kernelPolicySource = readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../integrations/blender/live/addons/worldengine_studio/kernel_policy.py",
    ),
    "utf8",
  );
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
