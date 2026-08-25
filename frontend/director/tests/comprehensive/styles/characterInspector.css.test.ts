import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const css = readFileSync("frontend/director/src/comprehensive/styles/characterInspector.css", "utf8");
const sceneCss = readFileSync("frontend/director/src/comprehensive/styles/sceneInspector.css", "utf8");
const appTsx = readFileSync("frontend/director/src/comprehensive/App.tsx", "utf8");

it("loads the character inspector sheet after the premium theme it overrides", () => {
  const premiumIndex = appTsx.indexOf('import "./styles/premiumDirectorTheme.css";');
  const characterIndex = appTsx.indexOf('import "./styles/characterInspector.css";');

  expect(premiumIndex).toBeGreaterThanOrEqual(0);
  expect(characterIndex).toBeGreaterThan(premiumIndex);
});

it("matches the readable control scale used by the other inspectors", () => {
  expect(css).toMatch(/\.right-sidebar \.character-inspector\s*\{[\s\S]*?--character-field-height:\s*36px;/);
  expect(css).toMatch(/\.right-sidebar \.character-inspector \.inspector-field-label\s*\{[\s\S]*?font-size:\s*12px;/);
  expect(css).toMatch(/\.right-sidebar \.character-inspector \.inspector-section h3\s*\{[\s\S]*?font-size:\s*13px;/);
  expect(css).toMatch(
    /\.right-sidebar \.character-inspector \.right-inspector-tabs button\s*\{[\s\S]*?height:\s*32px;[\s\S]*?font-size:\s*12px;/,
  );
  expect(css).toMatch(
    /\.right-sidebar \.character-inspector \.character-selection-copy strong\s*\{[\s\S]*?font-size:\s*13px;/,
  );
});

it("stacks character fields so axis values keep usable width", () => {
  expect(css).toMatch(
    /\.right-sidebar \.character-inspector \.inspector-field,[\s\S]*?\.right-sidebar \.character-inspector \.inspector-axis-group,[\s\S]*?\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\);/,
  );
  expect(css).toMatch(
    /\.right-sidebar \.character-inspector \.inspector-axis-row\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\);/,
  );
  expect(css).toMatch(
    /\.right-sidebar \.character-inspector \.inspector-axis-value\s*\{[\s\S]*?font-variant-numeric:\s*tabular-nums;[\s\S]*?text-align:\s*right;/,
  );
});

it("uses the shared axis colour coding", () => {
  expect(css).toMatch(
    /\.right-sidebar \.character-inspector \.inspector-axis-prefix\[data-axis="X"\]\s*\{[\s\S]*?#e06b6b;/,
  );
  expect(css).toMatch(
    /\.right-sidebar \.character-inspector \.inspector-axis-prefix\[data-axis="Y"\]\s*\{[\s\S]*?#6fbe7d;/,
  );
  expect(css).toMatch(
    /\.right-sidebar \.character-inspector \.inspector-axis-prefix\[data-axis="Z"\]\s*\{[\s\S]*?#6f9fe0;/,
  );
});

it("keeps scene transform axis groups stacked so values are not collapsed", () => {
  expect(sceneCss).toMatch(
    /\.right-sidebar \.scene-inspector \.scene-transform-section \.inspector-axis-group\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\);/,
  );
});
