import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const css = readFileSync("frontend/director/src/comprehensive/styles/sceneInspector.css", "utf8");

it("uses the same control scale as the other right-sidebar inspectors", () => {
  expect(css).toMatch(/--scene-gutter:\s*16px;/);
  expect(css).toMatch(/--scene-field-height:\s*32px;/);
  expect(css).toMatch(
    /\.right-sidebar \.scene-inspector \.right-inspector-content > \.inspector-section\s*\{[\s\S]*?padding:\s*4px 0 12px;/,
  );
});

it("treats scene sections as an outline with a right/down chevron", () => {
  expect(css).toMatch(/\.right-sidebar \.scene-inspector \.inspector-section-toggle\s*\{[\s\S]*?min-height:\s*36px;/);
  expect(css).toMatch(
    /\.right-sidebar \.scene-inspector \.inspector-section-chevron\s*\{[\s\S]*?transform:\s*rotate\(-90deg\);/,
  );
  expect(css).toMatch(
    /\.right-sidebar \.scene-inspector \.inspector-section-chevron\.is-open\s*\{[\s\S]*?transform:\s*rotate\(0deg\);/,
  );
  expect(css).toMatch(
    /\.right-sidebar \.scene-inspector \.right-inspector-content > \.inspector-section\.is-collapsed\s*\{[\s\S]*?padding:\s*0;/,
  );
});

it("keeps scene transforms compact with a side label and three-across XYZ", () => {
  expect(css).toMatch(
    /\.right-sidebar \.scene-inspector \.scene-transform-group\s*\{[\s\S]*?--scene-transform-field-height:\s*26px;/,
  );
  expect(css).toMatch(
    /\.right-sidebar \.scene-inspector \.scene-transform-group > \.inspector-axis-group\s*\{[\s\S]*?grid-template-columns:\s*52px minmax\(0,\s*1fr\);/,
  );
  expect(css).toMatch(
    /\.right-sidebar \.scene-inspector \.inspector-axis-row\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\);/,
  );
  expect(css).toMatch(/@container inspector-axis-group \(max-width: 168px\)/);
  expect(css).not.toMatch(/@container inspector-axis-group \(max-width: 240px\)/);
});

it("stacks scene switches in a single column to avoid overlap in narrow sidebars", () => {
  expect(css).toMatch(/\.right-sidebar \.scene-inspector \.scene-switch-row\s*\{[\s\S]*?grid-template-columns:\s*1fr;/);
  expect(css).toMatch(
    /\.right-sidebar \.scene-inspector \.scene-switch-row \.inspector-toggle-row\s*\{[\s\S]*?min-height:\s*34px;/,
  );
  expect(css).not.toMatch(
    /\.right-sidebar \.scene-inspector \.scene-switch-row\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3,/,
  );
});

it("overrides the shared inspector dropdown trigger sizing for scene fields", () => {
  expect(css).toMatch(
    /\.right-sidebar \.scene-inspector button\.inspector-dropdown-trigger\s*\{[\s\S]*?height:\s*var\(--scene-field-height\);[\s\S]*?padding:\s*0 8px;/,
  );
});

it("keeps ground controls nested under the display section", () => {
  expect(css).toMatch(
    /\.right-sidebar \.scene-inspector \.scene-display-section \.scene-ground-controls\s*\{[\s\S]*?border-top:/,
  );
});

it("keeps world systems on the same flat inspector surface as other scene sections", () => {
  expect(css).toMatch(/\.right-sidebar \.scene-inspector \.scene-world-tabs\s*\{[\s\S]*?flex-wrap:\s*wrap;/);
  expect(css).toMatch(
    /\.right-sidebar \.scene-inspector \.scene-world-tabs button\s*\{[\s\S]*?overflow:\s*hidden;[\s\S]*?white-space:\s*nowrap;/,
  );
  expect(css).not.toContain("repeat(5, minmax(0, 1fr))");
  expect(css).not.toMatch(/scene-world-summary/);
  expect(css).not.toMatch(/scene-world-disabled-hint/);
  expect(css).not.toMatch(/radial-gradient/);
});
