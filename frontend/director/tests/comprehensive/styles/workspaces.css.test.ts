import { readFileSync } from "node:fs";

const css = readFileSync("frontend/director/src/comprehensive/styles/workspaces.css", "utf8");

it("pins workspace tabs to the header center so Stage inspector collapse cannot shift them", () => {
  expect(css).toMatch(
    /\.top-workspace-tabs\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?left:\s*50%;[\s\S]*?width:\s*max-content;[\s\S]*?transform:\s*translateX\(-50%\);/,
  );
});

it("defers video editor styles to videoEditor.css", () => {
  expect(css).toMatch(/Video editor styles live in videoEditor\.css/);
  expect(css).not.toMatch(/\.creative-video-main\s*\{/);
});

it("gives the Canvas workspace restrained frame-first chrome", () => {
  expect(css).toMatch(/\.creative-board-stage\s*\{[\s\S]*?isolation:\s*isolate;[\s\S]*?rgb\(var\(--field-rgb\)\)/);
  expect(css).toMatch(
    /\.creative-board-toolbar\s*\{[\s\S]*?border-radius:\s*10px;[\s\S]*?background:\s*rgb\(var\(--panel-rgb\) \/ 0\.96\);[\s\S]*?backdrop-filter:\s*blur\(14px\) saturate\(1\.04\)/,
  );
  expect(css).toMatch(
    /\.creative-board-node\s*\{[\s\S]*?border:\s*0;[\s\S]*?background:\s*transparent;[\s\S]*?box-shadow:\s*none;/,
  );
  expect(css).toMatch(/\.creative-board-node\.is-selected \.creative-node-media\s*\{[\s\S]*?box-shadow:\s*0 0 0 2px/);
  expect(css).toMatch(
    /\.creative-board-toolbar-brand\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?top:\s*12px;[\s\S]*?left:\s*12px;/,
  );
  expect(css).toMatch(
    /\.creative-board-viewport-controls\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?bottom:\s*16px;[\s\S]*?left:\s*16px;/,
  );
  expect(css).toMatch(/\.creative-node-job-status\s*\{[^}]*justify-self:\s*start;/);
  expect(css).toMatch(/\.creative-board-section-lane\s*\{[\s\S]*?color-mix\(in srgb, var\(--section-accent/);
  expect(css).toContain(".creative-board-surface::after");
  expect(css).not.toContain("background: #0b1017;");
});

it("keeps asset drag feedback compact instead of showing a large light card", () => {
  expect(css).toMatch(
    /\.creative-asset-drop-preview\s*\{[\s\S]*?grid-template-columns:\s*34px\s+minmax\(0,\s*max-content\);[\s\S]*?min-height:\s*34px;[\s\S]*?background:\s*rgb\(var\(--overlay-rgb\) \/ 0\.78\);/,
  );
  expect(css).toMatch(/\.creative-asset-drop-preview-media\s*\{[\s\S]*?width:\s*34px;[\s\S]*?height:\s*34px;/);
});

it("keeps media cards at their content height when a long library scrolls", () => {
  expect(css).toMatch(/\.creative-media-list\s*\{[^}]*grid-auto-rows:\s*max-content;/);
  expect(css).toMatch(
    /\.creative-media-cover img,\s*\.creative-media-cover video\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*object-fit:\s*cover;/,
  );
  expect(css).toMatch(
    /\.creative-media-stars button,\s*\.creative-media-tag-toggle,\s*\.creative-media-assembly-toggle\s*\{[^}]*width:\s*14px;/,
  );
  expect(css).toMatch(/\.creative-media-tag-toggle\s*\{[^}]*flex:\s*0 0 20px;[^}]*width:\s*20px;/);
});

it("keeps media categories horizontally scrollable without a visible scrollbar", () => {
  expect(css).toMatch(/\.creative-media-tabs\s*\{[^}]*overflow-x:\s*auto;[^}]*scrollbar-width:\s*none;/);
  expect(css).toMatch(/\.creative-media-tabs::\-webkit-scrollbar\s*\{[^}]*display:\s*none;/);
});

it("keeps Canvas media previews complete instead of cropping camera frames", () => {
  expect(css).toMatch(
    /\.creative-node-media img,\s*\.creative-node-media video\s*\{[^}]*object-fit:\s*contain;[^}]*background:\s*rgb\(var\(--overlay-rgb\) \/ 0\.18\);/,
  );
});

it("keeps the empty inspector on a solid theme surface", () => {
  expect(css).toMatch(/\.creative-inspector-empty\s*\{[^}]*background:\s*rgb\(var\(--panel-rgb\)\);/);
  expect(css).not.toMatch(/\.creative-inspector-empty\s*\{[^}]*(?:linear|radial)-gradient/);
});

it("gives the Canvas node inspector clear sections and aligned compact controls", () => {
  expect(css).toMatch(
    /\.creative-canvas-workspace \.creative-inspector-section\s*\{[^}]*display:\s*grid;[^}]*border-bottom:/,
  );
  expect(css).toMatch(/\.creative-inspector-section-heading\s*\{[^}]*letter-spacing:/);
  expect(css).toMatch(
    /\.creative-canvas-workspace \.creative-checkbox-row\s*\{[^}]*display:\s*flex;[^}]*grid-template-columns:\s*none;/,
  );
  expect(css).toMatch(/\.creative-inspector-danger-zone\s*\{[^}]*border-top:/);
});

it("keeps the Canvas node inspector as a compact bounded popover", () => {
  expect(css).toMatch(
    /\.creative-canvas-node-inspector\s*\{[\s\S]*?grid-template-rows:\s*auto minmax\(0,\s*1fr\);[\s\S]*?width:\s*min\(280px,/,
  );
  expect(css).toMatch(/\.creative-canvas-node-inspector \.creative-inspector-form\s*\{[\s\S]*?min-height:\s*0;/);
  expect(css).toMatch(
    /\.creative-canvas-workspace \.creative-inspector-section\s*\{[\s\S]*?gap:\s*7px;[\s\S]*?padding:\s*10px 0;/,
  );
});
