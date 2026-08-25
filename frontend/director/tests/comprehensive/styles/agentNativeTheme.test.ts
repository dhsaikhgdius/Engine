import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const css = readFileSync("frontend/director/src/comprehensive/styles/agentNativeTheme.css", "utf8");
const premiumCss = readFileSync("frontend/director/src/comprehensive/styles/premiumDirectorTheme.css", "utf8");

it("keeps agent-native refinements token-driven across the light and dark production themes", () => {
  expect(css).not.toMatch(/color-scheme\s*:/);
  expect(css).toContain("background: rgb(var(--bg-rgb))");
  expect(css).toContain("background: rgb(var(--panel-rgb))");
  expect(css).toContain("color: rgb(var(--text-rgb))");
  expect(css).toContain("background: rgb(var(--accent-rgb))");
  expect(premiumCss).toMatch(/:root\[data-theme="dark"\],[\s\S]*?color-scheme:\s*dark/);
  expect(premiumCss).toMatch(/:root\[data-theme="light"\]\s*\{[\s\S]*?color-scheme:\s*light/);
  // Panels keep a rounded, shadowed treatment instead of being flattened.
  expect(css).toMatch(/\.ui-panel,[\s\S]*?border-radius:\s*12px/);
  expect(css).toMatch(/\.ui-panel,[\s\S]*?box-shadow:\s*0 1px 2px/);
});

it("treats outliner rows as list rows rather than elevated cards", () => {
  const cardGroup = css.match(/\.ui-panel,[\s\S]*?box-shadow:\s*0 1px 2px rgba\(34, 24, 19, 0\.05\);/)?.[0] ?? "";

  expect(cardGroup).toContain(".camera-preview-card");
  expect(cardGroup).not.toContain(".object-row");
});

it("keeps the studio stage field and the light production timeline", () => {
  expect(css).toMatch(/\.director-canvas,[\s\S]*?background:\s*#c9cdd3/);
  expect(premiumCss).toMatch(/\.animation-timeline-panel\s*\{[\s\S]*?background:\s*rgb\(var\(--panel-rgb\)\)/);
});

it("restores comfortable field sizing and readable type in the agent-native theme", () => {
  expect(css).toMatch(/\.ui-field,[\s\S]*?min-height:\s*32px/);
  expect(css).toMatch(/\.ui-field,[\s\S]*?border-radius:\s*7px/);
  expect(css).toMatch(/\.ui-field,[\s\S]*?font-size:\s*12px/);
  expect(css).toMatch(/\.panel-card p,[\s\S]*?font-size:\s*11px/);
});

it("keeps the player exploration as a compact, elevated overlay", () => {
  expect(css).toMatch(/\.player-controller-hud\s*\{[\s\S]*?border-radius:\s*12px/);
  expect(css).toMatch(/\.player-controller-hud\s*\{[\s\S]*?box-shadow:\s*0 6px 18px/);
  expect(css).toMatch(/\.player-controller-hud\s*\{[\s\S]*?pointer-events:\s*none/);
  expect(css).toMatch(/\.player-controller-hud button[^{]*\{[\s\S]*?pointer-events:\s*auto/);
  expect(css).toContain('.player-controller-hud-actions button[aria-pressed="true"]');
  expect(css).toMatch(
    /\.player-controller-hud-actions\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/,
  );
});

it("keeps the player ability bar as a compact overlay that does not steal stray clicks", () => {
  expect(css).toMatch(/\.linear-casting-hud\s*\{[\s\S]*?border-radius:\s*12px/);
  expect(css).toMatch(/\.linear-casting-hud\s*\{[\s\S]*?pointer-events:\s*none/);
  expect(css).toMatch(/\.linear-casting-hud button,[\s\S]*?pointer-events:\s*auto/);
  expect(css).toContain(".linear-casting-hud__cool");
  expect(css).toMatch(/\.linear-casting-flash\s*\{[\s\S]*?pointer-events:\s*none/);
});

it("preserves frosted glass on floating viewport controls and the agent drawer", () => {
  expect(css).toMatch(/\.viewport-toolbar\s*\{[\s\S]*?backdrop-filter:\s*blur\(18px\)/);
  expect(css).toMatch(/\.viewport-toolbar-menu,[\s\S]*?backdrop-filter:\s*blur\(24px\)/);
  expect(css).toMatch(/\.director-agent-drawer\s*\{[\s\S]*?backdrop-filter:\s*blur\(24px\)/);
});

it("gives the lower workbench a readable two-row desktop hierarchy", () => {
  expect(css).toMatch(
    /\/\* ── lower workbench[\s\S]*?\.animation-timeline-toolbar\s*\{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-rows:\s*28px 28px;[\s\S]*?height:\s*76px;/,
  );
  expect(css).toMatch(/\.animation-timeline-toolbar\s*\{[\s\S]*?padding:\s*6px 12px;/);
  expect(css).toContain('grid-template-areas:\n    "primary actions"\n    "utility utility"');
  expect(css).toContain(".animation-timeline-recording-actions");
  expect(css).toContain(".animation-timeline-scene-browser .production-scene-list.is-thumbnail-browser");
  expect(css).toContain(".animation-timeline-scene-browser .production-status");
});

it("keeps recording and export controls stable while progress labels update", () => {
  expect(css).toMatch(
    /\.animation-timeline-toolbar \.animation-timeline-flick-record\s*\{[\s\S]*?width:\s*112px;[\s\S]*?flex:\s*0 0 112px;/,
  );
  expect(css).toMatch(
    /\.animation-timeline-recording-actions \.animation-timeline-record-control\.is-primary\s*\{[\s\S]*?width:\s*126px;[\s\S]*?flex:\s*0 0 126px;/,
  );
  expect(css).toContain("--timeline-export-control-width: 164px;");
  expect(css).toMatch(
    /\.animation-timeline-recording-actions \.animation-timeline-export\.is-automatic,[\s\S]*?\.animation-timeline-recording-actions \.animation-timeline-dataset-options\s*\{[\s\S]*?width:\s*var\(--timeline-export-control-width\);[\s\S]*?flex:\s*0 0 var\(--timeline-export-control-width\);/,
  );
  expect(css).toContain("font-variant-numeric: tabular-nums;");
  // Export tools stay neutral at rest and light up with the shared accent
  // (full opacity) only while a job is actually running.
  expect(premiumCss).toMatch(
    /\.animation-timeline-export\.is-automatic,[\s\S]*?\.animation-timeline-export\.is-dataset,[\s\S]*?color:\s*rgb\(var\(--text-muted-rgb\)\) !important;/,
  );
  expect(premiumCss).toMatch(
    /\.animation-timeline-export\[aria-busy="true"\]:disabled\s*\{[\s\S]*?color:\s*rgb\(var\(--accent-rgb\)\) !important;[\s\S]*?opacity:\s*1;/,
  );
});
