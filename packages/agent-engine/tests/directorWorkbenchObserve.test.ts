import { describe, expect, it } from "vitest";
import { createDefaultDirectorProject } from "../src/directorDefaultProject";
import { observeDirectorProject } from "../src/directorWorkbenchObserve";

describe("observeDirectorProject", () => {
  it("reports collection counts from a persisted project without UI", () => {
    const project = createDefaultDirectorProject();
    const observation = observeDirectorProject(project, ["counts", "ui"]);
    expect(observation).toMatchObject({
      requested_fields: ["counts", "ui"],
      counts: {
        objects: project.objects.length,
        cameras: project.cameras.length,
      },
      ui: null,
    });
  });

  it("passes through a supplied UI snapshot", () => {
    const project = createDefaultDirectorProject();
    const observation = observeDirectorProject(project, ["ui"], {
      ui: { selectedObjectIds: ["char_default_a"], activeCameraId: project.activeCameraId },
    });
    expect(observation.ui).toMatchObject({ selectedObjectIds: ["char_default_a"] });
  });

  it("projects a bounded ProductionGraph on the opt-in observe field", () => {
    const project = createDefaultDirectorProject();
    const observation = observeDirectorProject(project, ["production_graph"]);
    expect(observation.requested_fields).toEqual(["production_graph"]);
    expect(observation.production_graph).toMatchObject({
      contract: "director-production-graph-observe-v1",
      integrity: { valid: true },
    });
    expect(observation.production_graph).not.toHaveProperty("nodes");
    const full = observeDirectorProject(project, ["production_graph"], { detail: "full" });
    expect(full.production_graph).toMatchObject({
      contract: "director-production-graph-observe-v1",
    });
    expect(Array.isArray((full.production_graph as { nodes?: unknown }).nodes)).toBe(true);
    expect(
      (full.production_graph as { identities?: { entry_count?: number } }).identities?.entry_count,
    ).toBeGreaterThan(0);
  });
});
