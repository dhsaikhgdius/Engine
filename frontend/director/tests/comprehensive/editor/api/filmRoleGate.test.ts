import { afterEach, describe, expect, it, vi } from "vitest";

const controlPlaneMocks = vi.hoisted(() => ({
  directorControlPlaneFetch: vi.fn(),
}));

vi.mock("../../../../src/comprehensive/editor/api/directorControlPlaneClient", () => ({
  directorControlPlaneFetch: controlPlaneMocks.directorControlPlaneFetch,
}));

import {
  directorFilmRole,
  loadDirectorFilmRole,
  resetFilmRoleGateForTests,
  stageAuthoringAllowed,
  stageAuthoringAllowedForRole,
} from "../../../../src/comprehensive/editor/api/filmRoleGate";

afterEach(() => {
  resetFilmRoleGateForTests();
  vi.clearAllMocks();
});

describe("stageAuthoringAllowedForRole", () => {
  it("matches the gateway roleAllowsTool decision for director_workbench author", () => {
    // No configured role stays unrestricted — a local editor never locks itself out.
    expect(stageAuthoringAllowedForRole(null)).toBe(true);
    expect(stageAuthoringAllowedForRole(undefined)).toBe(true);

    // Stage-author roles keep their write controls.
    expect(stageAuthoringAllowedForRole("stage-director")).toBe(true);
    expect(stageAuthoringAllowedForRole("cinematographer")).toBe(true);
    expect(stageAuthoringAllowedForRole("repair-operator")).toBe(true);

    // Read-only roles lose authoring, exactly like POST /api/tools.
    expect(stageAuthoringAllowedForRole("visual-critic")).toBe(false);
    expect(stageAuthoringAllowedForRole("editor")).toBe(false);
    expect(stageAuthoringAllowedForRole("production-designer")).toBe(false);
    expect(stageAuthoringAllowedForRole("generation-operator")).toBe(false);

    // Unknown role values fail closed.
    expect(stageAuthoringAllowedForRole("gaffer")).toBe(false);
  });
});

describe("stageAuthoringAllowed gate", () => {
  it("disables authoring once the gateway reports a critic role", () => {
    resetFilmRoleGateForTests("visual-critic");
    expect(directorFilmRole()).toBe("visual-critic");
    expect(stageAuthoringAllowed()).toBe(false);
    expect(controlPlaneMocks.directorControlPlaneFetch).not.toHaveBeenCalled();
  });

  it("stays unrestricted before the gateway answers and after it reports no role", async () => {
    controlPlaneMocks.directorControlPlaneFetch.mockResolvedValue(
      new Response(JSON.stringify({ role: null }), { status: 200 }),
    );
    expect(stageAuthoringAllowed()).toBe(true);
    await loadDirectorFilmRole();
    expect(directorFilmRole()).toBeNull();
    expect(stageAuthoringAllowed()).toBe(true);
    expect(controlPlaneMocks.directorControlPlaneFetch).toHaveBeenCalledWith("/api/control-plane/film-role");
  });

  it("applies the fetched gateway role to the synchronous gate", async () => {
    controlPlaneMocks.directorControlPlaneFetch.mockResolvedValue(
      new Response(JSON.stringify({ role: "visual-critic" }), { status: 200 }),
    );
    await loadDirectorFilmRole();
    expect(directorFilmRole()).toBe("visual-critic");
    expect(stageAuthoringAllowed()).toBe(false);
  });

  it("keeps the unrestricted default when the gateway is unreachable", async () => {
    controlPlaneMocks.directorControlPlaneFetch.mockRejectedValue(new Error("gateway offline"));
    await loadDirectorFilmRole();
    expect(directorFilmRole()).toBeNull();
    expect(stageAuthoringAllowed()).toBe(true);
  });
});
