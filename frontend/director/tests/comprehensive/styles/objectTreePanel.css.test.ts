import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const css = readFileSync("frontend/director/src/comprehensive/styles/objectTreePanel.css", "utf8");

it("reveals outliner row actions on hover, focus and selection only", () => {
  expect(css).toMatch(/\.left-sidebar \.object-row \.object-icon-flag-button\s*\{[\s\S]*?opacity:\s*0;/);
  expect(css).toMatch(
    /\.left-sidebar \.object-row:hover \.object-icon-flag-button,\s*[\r\n]+\s*\.left-sidebar \.object-row:focus-within \.object-icon-flag-button,\s*[\r\n]+\s*\.left-sidebar \.object-row\[aria-selected="true"\] \.object-icon-flag-button,[\s\S]*?opacity:\s*1;/,
  );
  expect(css).toMatch(/@media \(hover: none\)\s*\{[\s\S]*?\.object-icon-flag-button\s*\{[\s\S]*?opacity:\s*1;/);
});
