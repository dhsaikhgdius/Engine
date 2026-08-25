import { expect, it } from "vitest";
import {
  DEFAULT_DIRECTOR_WORKSPACE_LAYOUT,
  getMaximumRightPanelWidth,
  getVisibleRightSidebarWidth,
  MAX_RIGHT_PANEL_WIDTH,
  MIN_DIRECTOR_VIEWPORT_WIDTH,
  MIN_RIGHT_PANEL_WIDTH,
  normalizeRightPanelMode,
} from "../../../../src/comprehensive/app/layout/workspaceLayout";

it("preserves supported right panel modes", () => {
  expect(normalizeRightPanelMode("properties")).toBe("properties");
  expect(normalizeRightPanelMode("modeling")).toBe("modeling");
  expect(normalizeRightPanelMode("assets")).toBe("assets");
  expect(normalizeRightPanelMode("agent")).toBe("properties");
  expect(normalizeRightPanelMode("terminal")).toBe("properties");
});

it("hides the right sidebar width while the inspector column is collapsed", () => {
  expect(DEFAULT_DIRECTOR_WORKSPACE_LAYOUT.rightPanelCollapsed).toBe(true);
  expect(DEFAULT_DIRECTOR_WORKSPACE_LAYOUT.timelineCollapsed).toBe(true);
  expect(getVisibleRightSidebarWidth(DEFAULT_DIRECTOR_WORKSPACE_LAYOUT)).toBe(0);
  expect(
    getVisibleRightSidebarWidth({
      ...DEFAULT_DIRECTOR_WORKSPACE_LAYOUT,
      rightPanelCollapsed: false,
      rightPanelWidth: 440,
    }),
  ).toBe(440);
});

it("caps the restored right inspector width to the remaining viewport", () => {
  expect(getMaximumRightPanelWidth(1600, 220)).toBe(MAX_RIGHT_PANEL_WIDTH);
  expect(getMaximumRightPanelWidth(800, 220)).toBe(800 - 220 - MIN_DIRECTOR_VIEWPORT_WIDTH);
  expect(getMaximumRightPanelWidth(400, 220)).toBe(MIN_RIGHT_PANEL_WIDTH);
});
