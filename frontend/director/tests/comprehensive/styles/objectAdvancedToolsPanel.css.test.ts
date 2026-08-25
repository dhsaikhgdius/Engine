import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const css = readFileSync("frontend/director/src/comprehensive/styles/objectAdvancedToolsPanel.css", "utf8");

it("uses compact grouped sections and 32px controls in the right sidebar", () => {
  expect(css).toMatch(
    /\.right-sidebar \.object-advanced-tools-panel\s*\{[\s\S]*?--object-advanced-field-height:\s*32px;/,
  );
  expect(css).toMatch(
    /\.right-sidebar \.object-advanced-tools-panel \.object-advanced-group-toggle\s*\{[\s\S]*?min-height:\s*36px;/,
  );
  expect(css).toMatch(
    /\.object-advanced-tool-body[\s\S]*?button:not\(\.object-advanced-group-toggle\)[\s\S]*?min-height:\s*var\(--object-advanced-field-height\);/,
  );
});

it("treats multi-select sections as an outline with a right/down chevron", () => {
  expect(css).toMatch(
    /\.right-sidebar \.object-advanced-tools-panel \.object-advanced-group-chevron\s*\{[\s\S]*?transform:\s*rotate\(-90deg\);/,
  );
  expect(css).toMatch(
    /\.right-sidebar \.object-advanced-tools-panel \.object-advanced-group-chevron\.is-open\s*\{[\s\S]*?transform:\s*rotate\(0deg\);/,
  );
  expect(css).toMatch(/@container \(max-width: 168px\)/);
  expect(css).not.toMatch(/@container \(max-width: 220px\)/);
});

it("colors pivot axis labels like the prop inspector", () => {
  expect(css).toMatch(
    /\.right-sidebar \.object-advanced-tools-panel \.inspector-axis-prefix\[data-axis="X"\][\s\S]*?#e06b6b;/,
  );
  expect(css).toMatch(
    /\.right-sidebar \.object-advanced-tools-panel \.inspector-axis-prefix\[data-axis="Y"\][\s\S]*?#6fbe7d;/,
  );
  expect(css).toMatch(
    /\.right-sidebar \.object-advanced-tools-panel \.inspector-axis-prefix\[data-axis="Z"\][\s\S]*?#6f9fe0;/,
  );
  expect(css).toMatch(
    /\.right-sidebar \.object-advanced-tools-panel \.inspector-axis-row\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\);/,
  );
});

it("styles layer and overlay rows as flat list rows", () => {
  expect(css).toMatch(
    /\.right-sidebar \.object-advanced-tools-panel \.object-advanced-layer-row,\s*[\r\n]+\s*\.right-sidebar \.object-advanced-tools-panel \.object-advanced-overlay-list > div\s*\{[\s\S]*?min-height:\s*34px;[\s\S]*?border-bottom:\s*1px solid rgb\(var\(--border-rgb\) \/ 0\.07\);/,
  );
});
