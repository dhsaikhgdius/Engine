import { describe, expect, it } from "vitest";
import {
  BLENDER_AGENT_OPERATION_NAMES,
  BLENDER_FRAME_OPERATION_NAMES,
  BLENDER_HISTORY_OPERATION_NAMES,
  BLENDER_LONGTAIL_OPERATION_NAMES,
  BLENDER_OPERATION_NAMES,
  BLENDER_PROJECT_OPERATION_NAMES,
  BLENDER_READ_OPERATION_NAMES,
  BLENDER_SELECTION_OPERATION_NAMES,
  BLENDER_TRANSFORM_OPERATION_NAMES,
  BLENDER_TYPED_OPERATION_NAMES,
  blenderOperationManifest,
  blenderOperationRequiresSceneGuard,
} from "../src/blenderOperationManifest";

describe("blender operation manifest", () => {
  it("owns every operation identity and exposure surface", () => {
    expect(blenderOperationManifest.contract).toBe("worldengine-blender-live-v1");
    expect(BLENDER_OPERATION_NAMES).toHaveLength(74);
    expect(new Set(BLENDER_OPERATION_NAMES).size).toBe(74);
    expect(BLENDER_AGENT_OPERATION_NAMES).toHaveLength(72);
    expect(BLENDER_TYPED_OPERATION_NAMES).not.toContain("invoke_operator");
    expect(BLENDER_LONGTAIL_OPERATION_NAMES).toEqual(["invoke_operator", "set_rna_property", "execute_code"]);
  });

  it("declares transaction behavior used by both gateway and Blender", () => {
    expect(BLENDER_READ_OPERATION_NAMES).toContain("inspect_object");
    expect(BLENDER_READ_OPERATION_NAMES).toEqual(
      expect.arrayContaining(["polyhaven_search", "sketchfab_search"]),
    );
    expect(blenderOperationRequiresSceneGuard("polyhaven_search")).toBe(false);
    expect(blenderOperationRequiresSceneGuard("polyhaven_import")).toBe(true);
    expect(BLENDER_SELECTION_OPERATION_NAMES).toContain("set_selection");
    expect(BLENDER_FRAME_OPERATION_NAMES).toEqual(["set_scene_frame"]);
    expect(BLENDER_TRANSFORM_OPERATION_NAMES).toEqual(["update_transform"]);
    expect(BLENDER_HISTORY_OPERATION_NAMES).toEqual(["undo_scene", "redo_scene"]);
    expect(BLENDER_PROJECT_OPERATION_NAMES).toEqual(["bind_director_project"]);
    expect(blenderOperationRequiresSceneGuard("capture_render")).toBe(false);
    expect(blenderOperationRequiresSceneGuard("bind_director_project")).toBe(false);
    expect(blenderOperationRequiresSceneGuard("update_transform")).toBe(true);
  });
});
