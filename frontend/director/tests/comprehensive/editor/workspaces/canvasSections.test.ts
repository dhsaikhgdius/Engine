import { describe, expect, it } from "vitest";
import {
  CANVAS_WORKFLOW_PRESETS,
  createPresetBoardSections,
  nodeCenterInsideSection,
  resolveSectionForNode,
} from "../../../../src/comprehensive/editor/workspaces/canvasSections";

describe("canvasSections", () => {
  it("creates preset workflow sections with unique ids", () => {
    const sections = createPresetBoardSections();
    expect(sections).toHaveLength(CANVAS_WORKFLOW_PRESETS.length);
    expect(new Set(sections.map((section) => section.id)).size).toBe(sections.length);
    expect(sections[0]).toMatchObject({ kind: "character", title: "角色设计" });
  });

  it("detects when a node center lies inside a section", () => {
    const section = createPresetBoardSections()[0]!;
    const inside = { x: section.x + 40, y: section.y + 40, width: 120, height: 80 };
    const outside = { x: section.x - 200, y: section.y - 200, width: 120, height: 80 };
    expect(nodeCenterInsideSection(inside, section)).toBe(true);
    expect(nodeCenterInsideSection(outside, section)).toBe(false);
  });

  it("keeps a valid sectionId and otherwise resolves by geometry", () => {
    const sections = createPresetBoardSections();
    const section = sections[1]!;
    const node = {
      x: section.x + 60,
      y: section.y + 60,
      width: 200,
      height: 120,
      sectionId: section.id,
    };
    expect(resolveSectionForNode(node, sections)).toBe(section.id);
    expect(resolveSectionForNode({ ...node, sectionId: "missing" }, sections)).toBe(section.id);
    expect(resolveSectionForNode({ ...node, x: -500, y: -500, sectionId: null }, sections)).toBeNull();
  });
});
