import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const css = readFileSync("frontend/director/src/comprehensive/editor/generated3d/generated3d.css", "utf8");

it("uses the shared director theme tokens instead of bespoke purple chrome", () => {
  expect(css).toMatch(/background:\s*rgb\(var\(--panel-rgb\)\)/);
  expect(css).toMatch(/border:\s*1px solid rgb\(var\(--border-rgb\) /);
  expect(css).toMatch(/background:\s*rgb\(var\(--accent-rgb\)\)/);
  expect(css).not.toMatch(/#7458ef|#8b7cff|linear-gradient\(135deg,\s*#7458ef/);
});

it("matches the modal shell used by other asset-library workflows", () => {
  expect(css).toMatch(/\.generated3d-backdrop\s*\{[\s\S]*?z-index:\s*1200;/);
  expect(css).toMatch(/\.generated3d-surface\s*\{[\s\S]*?border-radius:\s*14px;/);
  expect(css).toMatch(/\.generated3d-header\s*\{[\s\S]*?background:\s*rgb\(var\(--field-rgb\) /);
});

it("uses compact inspector-scale controls", () => {
  expect(css).toMatch(/min-height:\s*28px;/);
  expect(css).toMatch(/\.generated3d-mode-toggle \.ui-segmented-item\s*\{[\s\S]*?height:\s*28px;/);
});

it("centers compact header icon buttons instead of inheriting padded ui-icon-button chrome", () => {
  expect(css).toMatch(
    /\.generated3d-header > \.ui-icon-button,\s*\n\.generated3d-queue > header > \.ui-icon-button\s*\{[\s\S]*?place-items:\s*center;[\s\S]*?padding:\s*0;/,
  );
  expect(css).toMatch(
    /\.generated3d-queue > header > \.ui-icon-button\s*\{[\s\S]*?width:\s*28px;[\s\S]*?height:\s*28px;/,
  );
});
