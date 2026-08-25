import { describe, expect, it } from "vitest";
import { buildDirectorObjectHierarchy } from "../src/directorObjectHierarchy";

describe("buildDirectorObjectHierarchy", () => {
  const objects = [
    { id: "root-a", name: "Root A" },
    { id: "child-a", name: "Child A", parent_id: "root-a" },
    { id: "grandchild-a", name: "Grandchild A", parent_id: "child-a" },
    { id: "root-b", name: "Root B" },
  ];

  it("preserves source order while nesting parent-child relationships", () => {
    expect(buildDirectorObjectHierarchy(objects, 10)).toEqual({
      mode: "hierarchy",
      roots: [
        {
          id: "root-a",
          name: "Root A",
          children: [
            {
              id: "child-a",
              name: "Child A",
              parent_id: "root-a",
              children: [
                {
                  id: "grandchild-a",
                  name: "Grandchild A",
                  parent_id: "child-a",
                  children: [],
                },
              ],
            },
          ],
        },
        { id: "root-b", name: "Root B", children: [] },
      ],
      total_count: 4,
      returned_count: 4,
      truncated: false,
    });
  });

  it("stops traversal at the requested object limit", () => {
    expect(buildDirectorObjectHierarchy(objects, 2)).toMatchObject({
      total_count: 4,
      returned_count: 2,
      truncated: true,
      roots: [
        {
          id: "root-a",
          children: [{ id: "child-a", children: [] }],
        },
      ],
    });
  });
});
