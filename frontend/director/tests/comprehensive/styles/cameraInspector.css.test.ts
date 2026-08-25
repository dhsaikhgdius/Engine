import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const css = readFileSync("frontend/director/src/comprehensive/styles/cameraInspector.css", "utf8");

it("uses the same control scale as the other right-sidebar inspectors", () => {
  expect(css).toMatch(/--camera-gutter:\s*16px;/);
  expect(css).toMatch(/--camera-field-height:\s*32px;/);
  expect(css).toMatch(
    /\.right-sidebar \.camera-inspector \.right-inspector-content > \.inspector-section\s*\{[\s\S]*?padding:\s*4px 0 12px;/,
  );
});

it("uses segmented header tabs instead of pill chips", () => {
  expect(css).toMatch(
    /\.right-sidebar \.camera-inspector \.right-inspector-tabs\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\);[\s\S]*?border-radius:\s*0;/,
  );
  expect(css).toMatch(
    /\.right-sidebar \.camera-inspector \.right-inspector-tabs button\s*\{[\s\S]*?white-space:\s*normal;/,
  );
  expect(css).toMatch(
    /\.right-sidebar \.camera-inspector \.right-inspector-tabs button\[aria-pressed="true"\]::after\s*\{[\s\S]*?display:\s*none;/,
  );
  expect(css).not.toMatch(/\.right-sidebar \.camera-inspector \.right-inspector-tabs\s*\{[^}]*border-radius:\s*999px;/);
});

it("treats camera sections as an outline with a right/down chevron", () => {
  expect(css).toMatch(/\.right-sidebar \.camera-inspector \.inspector-section-toggle\s*\{[\s\S]*?min-height:\s*36px;/);
  expect(css).toMatch(
    /\.right-sidebar \.camera-inspector \.inspector-section-chevron\s*\{[\s\S]*?transform:\s*rotate\(-90deg\);/,
  );
  expect(css).toMatch(
    /\.right-sidebar \.camera-inspector \.inspector-section-chevron\.is-open\s*\{[\s\S]*?transform:\s*rotate\(0deg\);/,
  );
});

it("keeps camera transforms in one channel box with three-across XYZ", () => {
  expect(css).toMatch(
    /\.right-sidebar \.camera-inspector \.camera-transform-group\s*\{[\s\S]*?--camera-transform-field-height:\s*32px;[\s\S]*?border-radius:\s*0;/,
  );
  expect(css).toMatch(
    /\.right-sidebar \.camera-inspector \.inspector-axis-row\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\);/,
  );
  expect(css).toMatch(/@container inspector-axis-group \(max-width: 168px\)/);
  expect(css).not.toMatch(/@container inspector-axis-group \(max-width: 240px\)/);
  expect(css).toMatch(
    /\.right-sidebar \.camera-inspector \.inspector-axis-prefix\[data-axis="X"\]\s*\{[\s\S]*?#e06b6b;/,
  );
  expect(css).toMatch(
    /\.right-sidebar \.camera-inspector \.inspector-axis-prefix\[data-axis="Y"\]\s*\{[\s\S]*?#6fbe7d;/,
  );
  expect(css).toMatch(
    /\.right-sidebar \.camera-inspector \.inspector-axis-prefix\[data-axis="Z"\]\s*\{[\s\S]*?#6f9fe0;/,
  );
});

it("keeps cinematography apply as a quiet accent action", () => {
  expect(css).toMatch(/\.right-sidebar\s*\.camera-inspector\s*\.camera-action-path-button\.is-primary\s*\{/);
  expect(css).toMatch(
    /\.right-sidebar \.camera-inspector \.camera-action-path-button\.is-primary\s*\{[\s\S]*?background:\s*rgb\(var\(--accent-rgb\) \/ 0\.14\);/,
  );
  expect(css).toMatch(/\.right-sidebar\s*\.camera-inspector\s*\.cinematography-preset-preview\s*\{/);
});
