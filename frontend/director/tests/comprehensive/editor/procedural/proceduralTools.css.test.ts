import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const css = readFileSync("frontend/director/src/comprehensive/editor/procedural/proceduralTools.css", "utf8");

it("uses the shared director theme tokens instead of navy HUD chrome", () => {
  expect(css).toMatch(/\.procedural-dialog\s*\{[\s\S]*?background:\s*rgb\(var\(--panel-rgb\)\)/);
  expect(css).toMatch(
    /\.procedural-header\s*\{[\s\S]*?min-height:\s*52px;[\s\S]*?background:\s*rgb\(var\(--field-rgb\)/,
  );
  expect(css).toMatch(/\.procedural-header strong\s*\{[\s\S]*?font-size:\s*15px;[\s\S]*?font-weight:\s*600;/);
  expect(css).toMatch(/\.procedural-primary\s*\{[\s\S]*?background:\s*rgb\(var\(--accent-rgb\) \/ 0\.14\)/);
  expect(css).not.toMatch(/#0b1019|#2d6fca|#4b8de7|#5f9df3/);
});

it("keeps transform axes on the Stage inspector colors", () => {
  expect(css).toMatch(/\[data-axis="X"\]\s*\{[\s\S]*?#e06b6b;/);
  expect(css).toMatch(/\[data-axis="Y"\]\s*\{[\s\S]*?#6fbe7d;/);
  expect(css).toMatch(/\[data-axis="Z"\]\s*\{[\s\S]*?#6f9fe0;/);
});
