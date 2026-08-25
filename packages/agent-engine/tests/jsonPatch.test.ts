import { describe, expect, it } from "vitest";
import { applyDirectorJsonPatches } from "../src/jsonPatch";

describe("safe Director JSON patch", () => {
  it("applies add, replace, and remove without mutating the source", () => {
    const source = { project: { objects: [{ id: "a", name: "A" }], title: "Old" }, ui: { selected: null } };
    const result = applyDirectorJsonPatches(source, [
      { op: "replace", path: "/project/title", value: "New" },
      { op: "add", path: "/project/objects/-", value: { id: "b", name: "B" } },
      { op: "remove", path: "/project/objects/0" },
    ]);
    expect(result).toEqual({ project: { objects: [{ id: "b", name: "B" }], title: "New" }, ui: { selected: null } });
    expect(source.project.title).toBe("Old");
  });

  it("blocks prototype traversal and missing replacement targets", () => {
    expect(() =>
      applyDirectorJsonPatches({ project: {}, ui: {} }, [
        { op: "add", path: "/project/__proto__/polluted", value: true },
      ]),
    ).toThrow(/Unsafe/);
    expect(() =>
      applyDirectorJsonPatches({ project: {}, ui: {} }, [{ op: "replace", path: "/project/missing", value: true }]),
    ).toThrow(/does not exist/);
  });
});
