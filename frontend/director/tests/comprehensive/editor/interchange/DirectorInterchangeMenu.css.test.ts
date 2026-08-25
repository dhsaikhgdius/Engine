import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const menuCss = readFileSync(
  "frontend/director/src/comprehensive/editor/interchange/DirectorInterchangeMenu.css",
  "utf8",
);
const providerCss = readFileSync(
  "frontend/director/src/comprehensive/editor/interchange/DccProviderBrowser.css",
  "utf8",
);

it("uses the shared director popover shell for the interchange menu", () => {
  expect(menuCss).toMatch(/\.director-interchange-menu\s*\{[\s\S]*?background:\s*rgb\(var\(--panel-rgb\)\)/);
  expect(menuCss).toMatch(/\.director-interchange-menu\s*\{[\s\S]*?grid-template-rows:\s*auto minmax\(0,\s*1fr\) auto/);
  expect(menuCss).toMatch(/\.director-interchange-body\s*\{[\s\S]*?overflow:\s*auto;/);
  expect(menuCss).toMatch(/\.director-interchange-section-label\s*\{[\s\S]*?text-transform:\s*uppercase;/);
  expect(menuCss).toMatch(/\.director-interchange-footer\.has-content\s*\{[\s\S]*?display:\s*flex;/);
  expect(menuCss).not.toMatch(/linear-gradient\(110deg,\s*rgb\(var\(--accent-rgb\)/);
});

it("keeps import and export actions compact without decorative arrows", () => {
  expect(menuCss).toMatch(/\.director-interchange-import\s*\{[\s\S]*?border:\s*1px dashed rgb\(var\(--accent-rgb\)/);
  expect(menuCss).toMatch(/\.director-interchange-formats\s*\{[\s\S]*?gap:\s*4px;/);
  expect(menuCss).not.toMatch(/director-interchange-action-arrow|director-interchange-format-arrow/);
});

it("styles DCC provider cards with flat theme surfaces", () => {
  expect(providerCss).toMatch(/\.director-dcc-provider-card\s*\{[\s\S]*?background:\s*rgb\(var\(--field-rgb\)/);
  expect(providerCss).toMatch(/\.director-dcc-provider-list\s*\{[\s\S]*?gap:\s*5px;/);
  expect(providerCss).not.toMatch(/linear-gradient\(145deg/);
  expect(providerCss).not.toMatch(/grid-template-columns:\s*repeat\(2/);
});
