import { describe, expect, it } from "vitest";
import { parseDirectorWorkbenchInput } from "../src/directorWorkbenchContract";
import { describeDirectorWorkbenchTarget, directorAuthoringActionNames } from "../src/directorWorkbenchDescribe";

function describedResult(target: string) {
  const described = describeDirectorWorkbenchTarget(target);
  if (!described.success) throw new Error(described.error);
  return described.result;
}

describe("director workbench describe", () => {
  it("is a valid contract operation that needs no other fields", () => {
    expect(parseDirectorWorkbenchInput({ op: "describe", target: "capture" })).toMatchObject({
      success: true,
      operation: { op: "describe", target: "capture" },
    });
    expect(parseDirectorWorkbenchInput({ op: "describe" })).toMatchObject({ success: false });
  });

  it("returns a complete JSON Schema for a compact operation", () => {
    const result = describedResult("capture");
    expect(result.kind).toBe("operation");
    expect(result.json_schema).toBeDefined();
    const serialized = JSON.stringify(result.json_schema);
    expect(serialized).toContain("render_pass");
    expect(serialized).toContain("camera_id");
    expect(result.fields).toBeUndefined();
  });

  it("degrades author to a field summary plus the action name index", () => {
    const result = describedResult("author");
    expect(result.json_schema).toBeUndefined();
    expect(result.fields).toContain("actions");
    expect(result.fields).toContain("expected_revision");
    expect(result.author_actions).toEqual(directorAuthoringActionNames);
    expect(result.author_actions).toContain("add_object");
    expect(result.note).toContain("author.<action>");
  });

  it("degrades other over-budget operations to a field summary", () => {
    const result = describedResult("replace_project");
    expect(result.json_schema).toBeUndefined();
    expect(result.fields).toContain("project");
    expect(result.author_actions).toBeUndefined();
  });

  it("embeds the kernel-ownership result vocabulary on the inspect operation", () => {
    const result = describedResult("inspect");
    expect(result.json_schema).toBeDefined();
    expect(JSON.stringify(result.json_schema)).toContain("kernel_ownership");
    const ownership = result.result_schemas?.kernel_ownership;
    expect(ownership).toBeDefined();
    const serialized = JSON.stringify(ownership);
    expect(serialized).toContain("blender_native");
    expect(serialized).toContain("generated_3d");
    expect(serialized).toContain("stage_catalog");
    expect(serialized).toContain("stage_patchable_fields");
    expect(serialized).toContain("rejected_stage_patches");
    expect(serialized).toContain("deletes_with_blender");
    expect(describedResult("capture").result_schemas).toBeUndefined();
  });

  it("returns one author action schema on demand", () => {
    const result = describedResult("author.add_object");
    expect(result.kind).toBe("author_action");
    expect(result.json_schema).toBeDefined();
    const serialized = JSON.stringify(result.json_schema);
    expect(serialized).toContain("geometry_type");
    expect(serialized).toContain("placement_mode");
    expect(JSON.stringify(result.json_schema).length).toBeLessThanOrEqual(20_000);
  });

  it("describes remove_object as the delete_objects alias", () => {
    const result = describedResult("author.remove_object");
    expect(result.target).toBe("author.delete_objects");
    expect(result.note).toContain("alias");
    expect(JSON.stringify(result.json_schema)).toContain("object_ids");
  });

  it("defaults add_light visible and locked in the described create schema", () => {
    const result = describedResult("author.add_light");
    const schema = result.json_schema as {
      properties?: { light?: { required?: string[]; properties?: Record<string, { default?: unknown }> } };
    };
    const light = schema.properties?.light;
    expect(light?.required).not.toContain("locked");
    expect(light?.required).not.toContain("visible");
    expect(light?.properties?.locked?.default).toBe(false);
    expect(light?.properties?.visible?.default).toBe(true);
  });

  it("describes the author evidence profile independently from author actions", () => {
    const result = describedResult("author.evidence");
    expect(result.kind).toBe("author_profile");
    expect(result.note).toContain("empty object");
    expect(result.json_schema).toMatchObject({
      properties: {
        kind: { const: "camera_frame", default: "camera_frame" },
        width: { default: 640 },
        height: { default: 360 },
      },
    });
  });

  it("keeps every advertised author action describable within the budget", () => {
    for (const action of directorAuthoringActionNames) {
      const result = describedResult(`author.${action}`);
      expect(result.json_schema, `author.${action} should embed its schema`).toBeDefined();
    }
  });

  it("rejects unknown targets with actionable guidance", () => {
    const unknownOperation = describeDirectorWorkbenchTarget("teleport");
    expect(unknownOperation).toMatchObject({ success: false });
    if (!unknownOperation.success) {
      expect(unknownOperation.error).toContain("observe");
      expect(unknownOperation.error).toContain("author.<action>");
    }
    const unknownAction = describeDirectorWorkbenchTarget("author.build_castle");
    expect(unknownAction).toMatchObject({ success: false });
    if (!unknownAction.success) {
      expect(unknownAction.error).toContain('{"op":"describe","target":"author"}');
    }
  });

  it("routes native Blender apply targets to blender_native instead of a bare 400", () => {
    const apply = describeDirectorWorkbenchTarget("apply");
    expect(apply).toMatchObject({ success: false });
    if (!apply.success) {
      expect(apply.error).toContain("blender_native");
      expect(apply.error).toContain('"target":"apply"');
    }
    const primitive = describeDirectorWorkbenchTarget("create_primitive");
    expect(primitive).toMatchObject({ success: false });
    if (!primitive.success) {
      expect(primitive.error).toContain("blender_native");
      expect(primitive.error).toContain("create_primitive");
    }
  });
});
