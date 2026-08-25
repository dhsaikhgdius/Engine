// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  directorToolPolicyRejection,
  filmRoleFromEnvironment,
  filmRoleRequiresToolLoop,
  filmRoleToolPolicyPrompt,
  filmRoleToolPolicyRejection,
  roleAllowsTool,
  roleCanSeeTool,
} from "../../agents/filmRoleToolPolicy";

const sceneEpoch = "82a6f8c1-7cb8-4d6f-a5f2-a4f5654a0420";

describe("film role tool policy", () => {
  it("keeps Stage authors on Stage/Blender and critics on evidence", () => {
    const nativeEdit = {
      op: "apply",
      expectedSceneEpoch: sceneEpoch,
      expectedRevision: 3,
      operations: [{ op: "create_primitive", primitive: "cube", id: "wall-a" }],
    };
    const nativeRigEdit = {
      op: "apply",
      expectedSceneEpoch: sceneEpoch,
      expectedRevision: 3,
      operations: [
        {
          op: "set_pose_bone_transform",
          id: "rig-a",
          boneRef: "Head",
          local: { rotationQuaternion: [1, 0, 0, 0] },
        },
      ],
    };

    expect(roleAllowsTool("production-designer", "blender_native", nativeEdit)).toBe(true);
    expect(roleAllowsTool("production-designer", "stage_scene", { op: "reset" })).toBe(false);
    expect(roleAllowsTool("visual-critic", "director_workbench", { op: "capture" })).toBe(true);
    expect(roleAllowsTool("visual-critic", "director_workbench", { op: "author" })).toBe(false);
    expect(roleAllowsTool("visual-critic", "blender_native", nativeEdit)).toBe(false);
    expect(roleAllowsTool("visual-critic", "blender_native", { op: "polyhaven_search", query: "chair" })).toBe(true);
    expect(roleAllowsTool("visual-critic", "blender_native", nativeRigEdit)).toBe(false);
    expect(roleAllowsTool("repair-operator", "blender_native", nativeEdit)).toBe(true);
    expect(roleAllowsTool("production-designer", "blender_native", nativeRigEdit)).toBe(true);
    expect(filmRoleToolPolicyPrompt("visual-critic")).toContain("capture/inspect");
  });

  it("keeps MCP visibility and execution on the shared role policy", () => {
    const nativeEdit = {
      op: "apply",
      expectedSceneEpoch: sceneEpoch,
      expectedRevision: 7,
      operations: [{ op: "create_primitive", primitive: "cube", id: "wall-b" }],
    };

    expect(roleCanSeeTool("visual-critic", "blender_native")).toBe(true);
    expect(roleCanSeeTool("visual-critic", "stage_object")).toBe(false);
    expect(roleCanSeeTool("visual-critic", "read")).toBe(false);
    expect(roleCanSeeTool("visual-critic", "web_search")).toBe(false);
    expect(roleCanSeeTool(null, "read")).toBe(true);
    expect(roleCanSeeTool(null, "web_search")).toBe(true);
    expect(roleAllowsTool("stage-director", "write", { file_path: "src/a.ts", content: "" })).toBe(false);
    expect(filmRoleToolPolicyRejection("visual-critic", "blender_native", nativeEdit)).toMatchObject({
      code: "tool_policy_rejected",
    });
    expect(filmRoleToolPolicyRejection("production-designer", "blender_native", nativeEdit)).toBeNull();
    expect(directorToolPolicyRejection(null, true, "director_workbench", { op: "author" })).toMatchObject({
      code: "plan_mode_blocked",
    });
    expect(directorToolPolicyRejection(null, true, "director_workbench", { op: "observe" })).toBeNull();
    expect(filmRoleFromEnvironment(" production-designer ")).toBe("production-designer");
  });

  it("marks mutating and visual-evidence roles as requiring a tool loop", () => {
    expect(filmRoleRequiresToolLoop("showrunner")).toBe(false);
    expect(filmRoleRequiresToolLoop("screenwriter")).toBe(false);
    expect(filmRoleRequiresToolLoop("continuity-supervisor")).toBe(false);
    expect(filmRoleRequiresToolLoop("shot-planner")).toBe(false);
    expect(filmRoleRequiresToolLoop("sound-designer")).toBe(false);
    expect(filmRoleRequiresToolLoop("stage-director")).toBe(true);
    expect(filmRoleRequiresToolLoop("cinematographer")).toBe(true);
    expect(filmRoleRequiresToolLoop("production-designer")).toBe(true);
    expect(filmRoleRequiresToolLoop("repair-operator")).toBe(true);
    expect(filmRoleRequiresToolLoop("generation-operator")).toBe(true);
    expect(filmRoleRequiresToolLoop("visual-critic")).toBe(true);
    expect(filmRoleRequiresToolLoop("editor")).toBe(true);
  });
});
