// @vitest-environment node

import { describe, expect, it } from "vitest";
import { httpToolPolicyRejection, resolveHttpToolPolicyContext } from "../../agents/httpToolPolicy";
import { filmRoleToolPolicyRejection } from "../../agents/filmRoleToolPolicy";

const sceneEpoch = "82a6f8c1-7cb8-4d6f-a5f2-a4f5654a0420";

describe("http tool policy", () => {
  it("resolves the role and plan mode from the same environment variables as MCP", () => {
    expect(resolveHttpToolPolicyContext({})).toEqual({ role: null, planMode: false });
    expect(resolveHttpToolPolicyContext({ DIRECTOR_FILM_ROLE: " visual-critic " })).toEqual({
      role: "visual-critic",
      planMode: false,
    });
    expect(resolveHttpToolPolicyContext({ DIRECTOR_PLAN_MODE: "1" })).toEqual({ role: null, planMode: true });
    expect(resolveHttpToolPolicyContext({ DIRECTOR_FILM_ROLE: "gaffer" })).toEqual({
      role: null,
      planMode: false,
      invalidRole: "gaffer",
    });
  });

  it("rejects with the exact MCP rejection body for the same role and operation", () => {
    const input = { op: "author", action: "add_object" };
    const rejection = httpToolPolicyRejection("director_workbench", input, {
      DIRECTOR_FILM_ROLE: "visual-critic",
    });
    expect(rejection?.status).toBe(403);
    expect(rejection?.body).toEqual(filmRoleToolPolicyRejection("visual-critic", "director_workbench", input));
  });

  it("rejects Blender writes for the generation operator but allows read-only operations", () => {
    const nativeEdit = {
      op: "apply",
      expectedSceneEpoch: sceneEpoch,
      expectedRevision: 3,
      operations: [{ op: "create_primitive", primitive: "cube", id: "wall-a" }],
    };
    const environment = { DIRECTOR_FILM_ROLE: "generation-operator" };
    expect(httpToolPolicyRejection("blender_native", nativeEdit, environment)?.body).toEqual(
      filmRoleToolPolicyRejection("generation-operator", "blender_native", nativeEdit),
    );
    expect(httpToolPolicyRejection("blender_native", { op: "status" }, environment)).toBeNull();
    expect(httpToolPolicyRejection("stage_video", { op: "capabilities" }, environment)).toBeNull();
  });

  it("rejects tools the role cannot see on MCP", () => {
    expect(
      httpToolPolicyRejection("director_dcc", { op: "status" }, { DIRECTOR_FILM_ROLE: "stage-director" })?.body,
    ).toMatchObject({ success: false, code: "tool_policy_rejected" });
    expect(
      httpToolPolicyRejection("blender_native", { op: "status" }, { DIRECTOR_FILM_ROLE: "editor" })?.body,
    ).toMatchObject({ success: false, code: "tool_policy_rejected" });
  });

  it("allows everything without a role unless plan mode forbids the operation", () => {
    expect(httpToolPolicyRejection("director_workbench", { op: "author", action: "add_object" }, {})).toBeNull();
    expect(httpToolPolicyRejection("generate_scene", { prompt: "a loft" }, {})).toBeNull();
    const planMode = { DIRECTOR_PLAN_MODE: "1" };
    expect(
      httpToolPolicyRejection("director_workbench", { op: "author", action: "add_object" }, planMode)?.body,
    ).toMatchObject({ code: "plan_mode_blocked" });
    expect(httpToolPolicyRejection("director_workbench", { op: "observe" }, planMode)).toBeNull();
  });

  it("fails closed when DIRECTOR_FILM_ROLE is not a known role", () => {
    const rejection = httpToolPolicyRejection(
      "director_workbench",
      { op: "observe" },
      { DIRECTOR_FILM_ROLE: "gaffer" },
    );
    expect(rejection?.status).toBe(403);
    expect(rejection?.body).toMatchObject({ success: false, code: "tool_policy_rejected" });
    expect(rejection?.body.error).toContain("gaffer");
  });
});
