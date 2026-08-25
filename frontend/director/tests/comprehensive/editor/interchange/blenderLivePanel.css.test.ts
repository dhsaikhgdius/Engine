import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const css = readFileSync("frontend/director/src/comprehensive/editor/interchange/blenderLivePanel.css", "utf8");

it("uses the same control scale as the other right-sidebar inspectors", () => {
  expect(css).toMatch(/\.blender-live-panel\.is-sidebar\s*\{[\s\S]*?--blender-gutter:\s*16px;/);
  expect(css).toMatch(/\.blender-live-panel\.is-sidebar\s*\{[\s\S]*?--blender-field-height:\s*32px;/);
  expect(css).toMatch(/\.blender-live-panel\.is-sidebar\s*\{[\s\S]*?font-synthesis:\s*none;/);
  expect(css).toMatch(/\.blender-live-tool-tabs button\[aria-selected="true"\]/);
  expect(css).toMatch(/\.blender-live-empty-icon\s*\{/);
  expect(css).toMatch(/\.blender-live-notice\s*\{/);
});

it("owns its own grid layout instead of depending on missing interchange rules", () => {
  expect(css).toMatch(
    /\.blender-live-panel\.is-sidebar \.blender-live-fields,\s*\n\.blender-live-panel\.is-sidebar \.blender-live-presets\s*\{[\s\S]*?display:\s*grid;/,
  );
  expect(css).toMatch(/\.blender-live-panel\.is-sidebar \.blender-mesh-editor\s*\{[\s\S]*?display:\s*grid;/);
  expect(css).toMatch(
    /\.blender-live-panel\.is-sidebar \.blender-mesh-facts\s*\{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/,
  );
});

it("uses segmented tabs instead of overflowing pill chips", () => {
  expect(css).toMatch(
    /\.blender-live-panel\.is-sidebar \.blender-live-tool-tabs,\s*\n\.blender-live-panel\.is-sidebar \.blender-mesh-tabs,\s*\n\.blender-live-panel\.is-sidebar \.blender-mesh-segments\s*\{[\s\S]*?display:\s*grid;[\s\S]*?border-radius:\s*10px;/,
  );
  expect(css).not.toMatch(/\.blender-live-panel\.is-sidebar \.blender-live-tool-tabs[\s\S]*?border-radius:\s*999px;/);
});

it("embeds mesh editing into the properties inspector without a standalone heading row", () => {
  expect(css).toMatch(/\.blender-live-panel\.is-sidebar\.is-object-inspector\s*\{[\s\S]*?border-top:/);
});

it("keeps sidebar chrome typographic instead of decorative cards", () => {
  expect(css).not.toMatch(/blender-live-heading-icon/);
  expect(css).not.toMatch(/blender-tool-section-icon/);
  expect(css).toMatch(
    /\.blender-live-panel\.is-sidebar \.blender-live-status\s*\{[\s\S]*?display:\s*flex;[\s\S]*?overflow:\s*visible;/,
  );
  expect(css).toMatch(/\.blender-live-panel\.is-sidebar \.blender-live-status-copy\s*\{[\s\S]*?display:\s*flex;/);
});
