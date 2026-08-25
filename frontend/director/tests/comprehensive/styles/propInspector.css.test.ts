import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const css = readFileSync("frontend/director/src/comprehensive/styles/propInspector.css", "utf8");

it("gives prop transforms a single channel box with compact XYZ rows", () => {
  expect(css).toMatch(
    /\.right-sidebar \.prop-inspector \.prop-transform-group\s*\{[\s\S]*?--prop-transform-field-height:\s*32px;[\s\S]*?border-radius:\s*0;/,
  );
  expect(css).toMatch(
    /\.right-sidebar \.prop-inspector \.prop-transform-group \.inspector-axis-row\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\);[\s\S]*?gap:\s*4px;/,
  );
  expect(css).toMatch(
    /\.right-sidebar \.prop-inspector \.prop-transform-group \.inspector-axis-value\s*\{[\s\S]*?text-align:\s*right;[\s\S]*?font-variant-numeric:\s*tabular-nums;/,
  );
});

it("uses an outline with a right/down chevron and colored transform axes", () => {
  expect(css).toMatch(/\.right-sidebar \.prop-inspector \.inspector-section-toggle\s*\{[\s\S]*?min-height:\s*36px;/);
  expect(css).toMatch(
    /\.right-sidebar \.prop-inspector \.inspector-section-chevron\s*\{[\s\S]*?transform:\s*rotate\(-90deg\);/,
  );
  expect(css).toMatch(
    /\.right-sidebar \.prop-inspector \.inspector-section-chevron\.is-open\s*\{[\s\S]*?transform:\s*rotate\(0deg\);/,
  );
  expect(css).not.toMatch(/\.right-sidebar \.prop-inspector \.right-inspector-tabs\s*\{/);
  expect(css).toMatch(
    /\.right-sidebar \.prop-inspector \.prop-transform-group \.inspector-axis-prefix\[data-axis="X"\]\s*\{[\s\S]*?#e06b6b;/,
  );
  expect(css).toMatch(
    /\.right-sidebar \.prop-inspector \.prop-transform-group \.inspector-axis-prefix\[data-axis="Y"\]\s*\{[\s\S]*?#6fbe7d;/,
  );
  expect(css).toMatch(
    /\.right-sidebar \.prop-inspector \.prop-transform-group \.inspector-axis-prefix\[data-axis="Z"\]\s*\{[\s\S]*?#6f9fe0;/,
  );
});

it("overrides the shared inspector dropdown trigger sizing for prop texture fields", () => {
  expect(css).toMatch(
    /\.right-sidebar \.prop-inspector button\.inspector-dropdown-trigger\s*\{[\s\S]*?height:\s*var\(--prop-field-height\);[\s\S]*?padding:\s*0 8px;/,
  );
});

it("keeps the selected prop name as a standard inspector field", () => {
  expect(css).toMatch(
    /\.right-sidebar \.prop-inspector \.right-inspector-content > \.inspector-field\s*\{[\s\S]*?padding:\s*8px 0 12px;/,
  );
  expect(css).not.toMatch(/\.prop-selection-summary/);
});
