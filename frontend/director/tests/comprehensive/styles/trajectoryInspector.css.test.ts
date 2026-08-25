import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const css = readFileSync("frontend/director/src/comprehensive/styles/trajectoryInspector.css", "utf8");
const appTsx = readFileSync("frontend/director/src/comprehensive/App.tsx", "utf8");

it("loads the trajectory inspector sheet after the premium theme it overrides", () => {
  const premiumIndex = appTsx.indexOf('import "./styles/premiumDirectorTheme.css";');
  const trajectoryIndex = appTsx.indexOf('import "./styles/trajectoryInspector.css";');

  expect(premiumIndex).toBeGreaterThanOrEqual(0);
  expect(trajectoryIndex).toBeGreaterThan(premiumIndex);
});

it("uses the same control scale as the other right-sidebar inspectors", () => {
  expect(css).toMatch(/--trajectory-gutter:\s*16px;/);
  expect(css).toMatch(/--trajectory-field-height:\s*32px;/);
  expect(css).toMatch(
    /\.right-sidebar \.trajectory-inspector \.right-inspector-content > \.inspector-section\s*\{[\s\S]*?padding:\s*4px 0 12px;/,
  );
});

it("uses segmented header tabs instead of pill chips", () => {
  expect(css).toMatch(
    /\.right-sidebar \.trajectory-inspector \.right-inspector-tabs\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);[\s\S]*?border-radius:\s*10px;/,
  );
  expect(css).toMatch(
    /\.right-sidebar \.trajectory-inspector \.right-inspector-tabs button\s*\{[\s\S]*?white-space:\s*normal;/,
  );
  expect(css).toMatch(
    /\.right-sidebar \.trajectory-inspector \.right-inspector-tabs button\[aria-pressed="true"\]::after\s*\{[\s\S]*?display:\s*none;/,
  );
  expect(css).not.toMatch(
    /\.right-sidebar \.trajectory-inspector \.right-inspector-tabs\s*\{[^}]*border-radius:\s*999px;/,
  );
});

it("treats trajectory sections as an outline with a right/down chevron", () => {
  expect(css).toMatch(
    /\.right-sidebar \.trajectory-inspector \.inspector-section-toggle\s*\{[\s\S]*?min-height:\s*36px;/,
  );
  expect(css).toMatch(
    /\.right-sidebar \.trajectory-inspector \.inspector-section-chevron\s*\{[\s\S]*?transform:\s*rotate\(-90deg\);/,
  );
  expect(css).toMatch(
    /\.right-sidebar \.trajectory-inspector \.inspector-section-chevron\.is-open\s*\{[\s\S]*?transform:\s*rotate\(0deg\);/,
  );
});

it("keeps trajectory transforms in one channel box with three-across XYZ", () => {
  expect(css).toMatch(
    /\.right-sidebar \.trajectory-inspector \.trajectory-transform-group\s*\{[\s\S]*?--trajectory-transform-field-height:\s*32px;[\s\S]*?border-radius:\s*12px;/,
  );
  expect(css).toMatch(
    /\.right-sidebar \.trajectory-inspector \.inspector-axis-row\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\);/,
  );
  expect(css).toMatch(/@container inspector-axis-group \(max-width: 168px\)/);
  expect(css).toMatch(
    /\.right-sidebar \.trajectory-inspector \.inspector-axis-prefix\[data-axis="X"\]\s*\{[\s\S]*?#e06b6b;/,
  );
  expect(css).toMatch(
    /\.right-sidebar \.trajectory-inspector \.inspector-axis-prefix\[data-axis="Y"\]\s*\{[\s\S]*?#6fbe7d;/,
  );
  expect(css).toMatch(
    /\.right-sidebar \.trajectory-inspector \.inspector-axis-prefix\[data-axis="Z"\]\s*\{[\s\S]*?#6f9fe0;/,
  );
});
