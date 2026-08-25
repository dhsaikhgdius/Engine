import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const css = readFileSync("frontend/director/src/comprehensive/editor/panels/assetLibrary.css", "utf8");

it("scrolls asset library category tabs horizontally without a visible scrollbar", () => {
  expect(css).toMatch(/\.asset-library-tabs\s*\{[\s\S]*?flex-wrap:\s*nowrap;/);
  expect(css).toMatch(/\.asset-library-tabs\s*\{[\s\S]*?overflow-x:\s*auto;/);
  expect(css).toMatch(/\.asset-library-tabs\s*\{[\s\S]*?scrollbar-width:\s*none;/);
  expect(css).toMatch(/\.asset-library-tabs::\-webkit-scrollbar\s*\{[\s\S]*?display:\s*none;/);
  expect(css).toMatch(/\.asset-library-tabs \.model-library-tab\s*\{[\s\S]*?flex-shrink:\s*0;/);
  expect(css).toMatch(/\.asset-library-tabs \.model-library-tab\s*\{[\s\S]*?min-width:\s*max-content;/);
  expect(css).not.toMatch(/\.asset-library-tabs\s*\{[\s\S]*?flex-wrap:\s*wrap;/);
});

it("groups import and generate actions into labeled three-column clusters", () => {
  expect(css).toMatch(/\.asset-library-tool-group h3\s*\{[\s\S]*?font-size:\s*11px;/);
  expect(css).toMatch(/\.asset-library-action-cluster\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3,/);
  expect(css).toMatch(/\.asset-library-import-action\s*\{[\s\S]*?font-size:\s*11px;/);
  expect(css).toMatch(/\.asset-library-grid \.model-library-name\s*\{[\s\S]*?font-size:\s*11px;/);
});

it("lets the virtualized asset grid fill the panel width instead of size-containing it", () => {
  expect(css).toMatch(/\.asset-library-grid-virtualized\s*\{[\s\S]*?width:\s*100%;[\s\S]*?min-width:\s*0;/);
  expect(css).toMatch(/\.asset-library-grid-virtualized\s*\{[\s\S]*?contain:\s*layout paint style;/);
  expect(css).not.toContain("contain: strict");
});
