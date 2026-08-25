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
});
