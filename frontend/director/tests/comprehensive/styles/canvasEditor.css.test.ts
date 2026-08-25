import { readFileSync } from "node:fs";

const css = readFileSync("frontend/director/src/comprehensive/styles/canvasEditor.css", "utf8");

it("keeps Canvas board on a Flick-inspired production scale", () => {
  expect(css).toMatch(/\.creative-board-toolbar-secondary\s*\{[^}]*border-radius:\s*999px;/);
  expect(css).toMatch(/\.creative-canvas-workspace \.creative-board-section-lane\s*\{[^}]*border-radius:\s*20px;/);
  expect(css).toMatch(/\.creative-canvas-workspace \.creative-node-media\s*\{[^}]*--canvas-card-radius/);
  expect(css).toMatch(/\.creative-board-toolbar-secondary \.creative-add-node-control > button/);
  expect(css).toMatch(
    /\.creative-canvas-workspace \.creative-board-toolbar-secondary \.creative-add-node-control > button\s*\{[\s\S]*?min-width:\s*32px;[\s\S]*?background:\s*transparent;/,
  );
  expect(css).not.toMatch(/\.creative-board-toolbar-dock\s*\{/);
});

it("keeps section lanes as quiet washes instead of colored slabs", () => {
  expect(css).toMatch(
    /\.creative-canvas-workspace \.creative-board-section-lane\s*\{[^}]*color-mix\(in srgb, var\(--section-accent, #45b3d6\) 3%,/,
  );
  expect(css).toMatch(/\.creative-canvas-workspace \.creative-node-type\s*\{[^}]*color-mix/);
});

it("selects nodes with a neutral frame and keeps ports quiet at rest", () => {
  expect(css).toMatch(
    /\.creative-canvas-workspace \.creative-board-node\.is-selected \.creative-node-media\s*\{[^}]*rgb\(var\(--text-rgb\) \/ 0\.62\)/,
  );
  expect(css).toMatch(/\.creative-board-node\.is-note\.is-selected/);
  expect(css).toMatch(/\.creative-canvas-workspace \.creative-node-port\s*\{[^}]*box-shadow:\s*none;/);
  expect(css).toMatch(/\.creative-canvas-workspace \.creative-node-job-status\.is-succeeded\s*\{[^}]*#4da58c/);
});
