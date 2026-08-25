import { describe, expect, it } from "vitest";
import { createDefaultDirectorProject } from "../src/directorDefaultProject";
import { buildDirectorRevisionDiff } from "../src/directorRevisionDiff";

describe("buildDirectorRevisionDiff", () => {
  it("returns only requested changes and bounds each changed collection", () => {
    const before = createDefaultDirectorProject();
    const after = structuredClone(before);
    const template = structuredClone(before.objects[0]!);
    after.objects.push(
      { ...structuredClone(template), id: "delta-a", name: "Delta A" },
      { ...structuredClone(template), id: "delta-b", name: "Delta B" },
      { ...structuredClone(template), id: "delta-c", name: "Delta C" },
    );

    const diff = buildDirectorRevisionDiff(before, after, ["objects"], 2);
    expect(diff).toMatchObject({
      changed: true,
      objects: {
        added: [{ id: "delta-a" }, { id: "delta-b" }],
        total_changes: 3,
        truncated: true,
      },
    });
    expect(diff).not.toHaveProperty("cameras");
    expect(diff).not.toHaveProperty("scene");
  });

  it("reports no selected change when only an unrequested field changed", () => {
    const before = createDefaultDirectorProject();
    const after = structuredClone(before);
    after.scene.backgroundColor = "#112233";

    expect(buildDirectorRevisionDiff(before, after, ["objects"], 20)).toMatchObject({
      changed: false,
      objects: { total_changes: 0, truncated: false },
    });
  });
});
