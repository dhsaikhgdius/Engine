import { describe, expect, it } from "vitest";
import { createDefaultDirectorProject } from "../src/directorDefaultProject";
import { getDirectorProjectGraphIssues } from "../src/directorProjectGraph";

describe("Director project graph", () => {
  it("includes semantic take and coverage references in the shared graph gate", () => {
    const project = createDefaultDirectorProject();
    const shot = project.production!.sequences[0]!.shots[0]!;
    shot.takeId = "missing-take";
    shot.cameraId = "missing-camera";

    const issues = getDirectorProjectGraphIssues(project);

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/production .*takeId.*missing-take.*不存在/),
        expect.stringMatching(/production .*cameraId.*missing-camera.*不存在/),
      ]),
    );
  });

  it("keeps a valid migrated default production graph clean", () => {
    expect(getDirectorProjectGraphIssues(createDefaultDirectorProject())).toEqual([]);
  });
});
