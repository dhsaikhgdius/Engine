import { describe, expect, it } from "vitest";
import { createDefaultDirectorProject } from "../../../../src/comprehensive/editor/store/directorStore";
import {
  getDirectorObjectLayers,
  isDirectorObjectEffectivelyLocked,
  isDirectorObjectEffectivelyVisible,
} from "../../../../src/comprehensive/editor/schema/objectLayers";

describe("object layers", () => {
  it("merges configured ordering with legacy layer names and applies effective state", () => {
    const project = createDefaultDirectorProject();
    project.scene.objectLayers = [
      { id: "fx", visible: false, locked: true },
      { id: "default", visible: true, locked: false },
    ];
    const hero = project.objects[0]!;
    hero.layer = "fx";
    project.objects[1]!.layer = "legacy";

    expect(getDirectorObjectLayers(project.scene, project.objects).map((layer) => layer.id)).toEqual([
      "fx",
      "default",
      "legacy",
    ]);
    expect(isDirectorObjectEffectivelyVisible(project.scene, hero)).toBe(false);
    expect(isDirectorObjectEffectivelyLocked(project.scene, hero)).toBe(true);
  });
});
