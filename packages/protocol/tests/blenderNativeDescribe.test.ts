import { describe, expect, it } from "vitest";
import { describeBlenderNativeTarget } from "../src/blenderNativeDescribe";

describe("blender native typed describe", () => {
  it("lists typed apply operations for target apply", () => {
    const described = describeBlenderNativeTarget("apply");
    expect(described.success).toBe(true);
    if (!described.success) return;
    expect(described.result.kind).toBe("operation");
    expect(described.result.operations).toContain("create_primitive");
    expect(described.result.operations).toContain("create_blockout");
    expect(described.result.operations).toContain("execute_code");
    expect(described.result.operations).toContain("polyhaven_import");
    expect(described.result.operations).toContain("sketchfab_import");
    expect(JSON.stringify(described.result.json_schema)).toContain("operations");
    expect(described.result.note).toContain("blender_native");
  });

  it("redirects query describe to query_spatial and documents the name-search alias", () => {
    const described = describeBlenderNativeTarget("query");
    expect(described.success).toBe(true);
    if (!described.success) return;
    expect(described.result.target).toBe("apply.query_spatial");
    expect(described.result.note).toContain('{"op":"query","query":"<name>"}');
    expect(JSON.stringify(described.result.json_schema)).toContain("NAME");
  });

  it("returns a create_primitive schema without a live kernel", () => {
    const described = describeBlenderNativeTarget("create_primitive");
    expect(described.success).toBe(true);
    if (!described.success) return;
    expect(described.result.target).toBe("apply.create_primitive");
    expect(described.result.kind).toBe("apply_operation");
    const serialized = JSON.stringify(described.result.json_schema);
    expect(serialized).toContain("primitive");
    expect(serialized).toContain("create_primitive");
    expect(described.result.note).toContain("grounded");
    expect(described.result.note).toContain("create_blockout");
  });

  it("documents the white-box blockout contract on create_blockout describe", () => {
    const described = describeBlenderNativeTarget("create_blockout");
    expect(described.success).toBe(true);
    if (!described.success) return;
    expect(described.result.target).toBe("apply.create_blockout");
    expect(described.result.note).toContain("room = floor + 4 walls");
    expect(described.result.note).toContain("create_opening");
    const serialized = JSON.stringify(described.result.json_schema);
    expect(serialized).toContain("idPrefix");
    expect(serialized).toContain("wallThickness");
    expect(serialized).toContain("north/south/east/west");
  });

  it("documents metric opening semantics on create_opening describe", () => {
    const described = describeBlenderNativeTarget("create_opening");
    expect(described.success).toBe(true);
    if (!described.success) return;
    expect(described.result.target).toBe("apply.create_opening");
    expect(described.result.note).toContain("BOOLEAN");
    expect(described.result.note).toContain("darker box");
    const serialized = JSON.stringify(described.result.json_schema);
    expect(serialized).toContain("sillHeight");
    expect(serialized).toContain("<idPrefix>:2..5");
  });

  it("redirects common blockout and opening guesses to the canonical typed ops", () => {
    for (const guess of ["blockout", "create_room", "create-stairs", "create_wall"]) {
      const described = describeBlenderNativeTarget(guess);
      expect(described.success, guess).toBe(true);
      if (!described.success) continue;
      expect(described.result.target).toBe("apply.create_blockout");
      expect(described.result.note).toContain(`"${guess}" is not a typed op`);
      expect(described.result.note).toContain("create_opening");
    }
    for (const guess of ["opening", "add_opening", "create_door", "create_window"]) {
      const described = describeBlenderNativeTarget(guess);
      expect(described.success, guess).toBe(true);
      if (!described.success) continue;
      expect(described.result.target).toBe("apply.create_opening");
      expect(described.result.note).toContain("create_opening");
    }
  });

  it("accepts the apply. prefix and rejects unknown targets", () => {
    const prefixed = describeBlenderNativeTarget("apply.assign_material");
    expect(prefixed.success).toBe(true);
    if (prefixed.success) {
      expect(prefixed.result.target).toBe("apply.assign_material");
      expect(prefixed.result.note).toContain("createIfMissing");
      expect(prefixed.result.note).toContain("sceneMaterials");
    }

    const unknown = describeBlenderNativeTarget("teleport");
    expect(unknown).toMatchObject({ success: false });
    if (!unknown.success) {
      expect(unknown.error).toContain("operator");
      expect(unknown.error).toContain("create_primitive");
    }
  });

  it("redirects the common add_camera name to the canonical Blender operation", () => {
    const described = describeBlenderNativeTarget("add_camera");
    expect(described.success).toBe(true);
    if (!described.success) return;
    expect(described.result.target).toBe("apply.create_camera");
    expect(described.result.note).toContain('canonical Blender operation "create_camera"');
  });

  it("redirects boolean_difference to add_modifier instead of failing", () => {
    const described = describeBlenderNativeTarget("boolean_difference");
    expect(described.success).toBe(true);
    if (!described.success) return;
    expect(described.result.target).toBe("apply.add_modifier");
    expect(described.result.note).toContain("create_opening");
    expect(described.result.note).toContain("BOOLEAN");
    expect(described.result.note).toContain("set_modifier");
    expect(JSON.stringify(described.result.json_schema)).toContain("BOOLEAN");

    const union = describeBlenderNativeTarget("boolean_union");
    expect(union.success).toBe(true);
    if (union.success) expect(union.result.target).toBe("apply.add_modifier");
  });

  it("returns an execute_code schema without a live kernel", () => {
    const described = describeBlenderNativeTarget("execute_code");
    expect(described.success).toBe(true);
    if (!described.success) return;
    expect(described.result.target).toBe("apply.execute_code");
    const serialized = JSON.stringify(described.result.json_schema);
    expect(serialized).toContain("execute_code");
    expect(serialized).toContain("code");
  });

  it("returns Poly Haven and Sketchfab import schemas without a live kernel", () => {
    const polyhaven = describeBlenderNativeTarget("polyhaven_import");
    expect(polyhaven.success).toBe(true);
    if (!polyhaven.success) return;
    expect(polyhaven.result.target).toBe("apply.polyhaven_import");
    expect(JSON.stringify(polyhaven.result.json_schema)).toContain("assetId");

    const sketchfab = describeBlenderNativeTarget("sketchfab_import");
    expect(sketchfab.success).toBe(true);
    if (!sketchfab.success) return;
    expect(JSON.stringify(sketchfab.result.json_schema)).toContain("uid");
  });
});
