import { readFileSync } from "node:fs";

const css = readFileSync("frontend/director/src/comprehensive/styles/premiumDirectorTheme.css", "utf8");

it("defines distinct premium light and dark production palettes", () => {
  expect(css).toMatch(
    /:root,[\s\S]*?:root\[data-theme="dark"\],[\s\S]*?color-scheme:\s*dark;[\s\S]*?--panel-rgb:\s*19 22 27;/,
  );
  expect(css).toMatch(
    /:root\[data-theme="light"\]\s*\{[\s\S]*?color-scheme:\s*light;[\s\S]*?--panel-rgb:\s*247 248 250;[\s\S]*?--text-rgb:\s*28 33 41;/,
  );
});

it("keeps the 3D stage on a studio field so the ground grid stays visible", () => {
  expect(css).toContain("--director-viewport-rgb: 201 205 211;");
  expect(css).toMatch(
    /\.director-shell-fullbleed,[\s\S]*?\.director-canvas\s*\{[\s\S]*?background:\s*rgb\(var\(--director-viewport-rgb\)\);/,
  );
  expect(css).toContain("--director-topbar-start-rgb: 252 252 253;");
});

it("defines unified top bar settings cluster controls", () => {
  expect(css).toContain(".top-bar-settings-cluster");
  expect(css).toContain(".top-bar-settings-trigger");
  expect(css).toContain(".language-switcher");
});

it("keeps the live camera PiP overlay transparent so the WebGL inset is visible", () => {
  expect(css).toMatch(
    /\.camera-picture-in-picture\s*\{[\s\S]*?background:\s*transparent;[\s\S]*?backdrop-filter:\s*none;/,
  );
  expect(css).toMatch(
    /\.camera-viewport-properties\s*\{[\s\S]*?background:\s*rgb\(var\(--director-camera-panel-rgb\)\s*\/\s*0\.9\);/,
  );
});

it("drops the camera mode-strip blur while the inset is dragged", () => {
  expect(css).toMatch(
    /\.camera-picture-in-picture__modes\.is-dragging\s*\{[\s\S]*?backdrop-filter:\s*none;[\s\S]*?-webkit-backdrop-filter:\s*none;/,
  );
});

it("themes camera viewport property controls with the premium palette", () => {
  expect(css).toMatch(
    /\.camera-viewport-properties input,[\s\S]*?\.camera-viewport-properties select\s*\{[\s\S]*?color:\s*rgb\(var\(--text-rgb\)\);[\s\S]*?background:\s*rgb\(var\(--field-rgb\)\);/,
  );
  expect(css).toMatch(
    /\.camera-viewport-properties-shake button\[aria-pressed="true"\]\s*\{[\s\S]*?color:\s*rgb\(var\(--accent-rgb\)\);[\s\S]*?background:\s*rgb\(var\(--accent-rgb\)\s*\/\s*0\.12\);/,
  );
  expect(css).toMatch(
    /\.camera-viewport-properties-move:hover,[\s\S]*?\.camera-viewport-properties-move:focus-visible\s*\{[\s\S]*?background:\s*rgb\(var\(--accent-rgb\)\);/,
  );
});

it("keeps timeline toolbar labels at a real UI size instead of faux-small type", () => {
  expect(css).toMatch(/\.animation-timeline-toolbar button,[\s\S]*?font-size:\s*11px;[\s\S]*?font-weight:\s*600;/);
  expect(css).not.toMatch(
    /\.animation-timeline-toolbar button,[\s\S]*?font-size:\s*9\.5px;[\s\S]*?font-weight:\s*540;/,
  );
  expect(css).toMatch(
    /\.animation-timeline-label strong,[\s\S]*?\.animation-timeline-label\.is-ruler\s*\{[\s\S]*?font-size:\s*11px;[\s\S]*?font-weight:\s*600;/,
  );
  expect(css).not.toMatch(/\.animation-timeline-label strong\s*\{[\s\S]*?font-weight:\s*580;/);
});

it("defers prop inspector styles to propInspector.css", () => {
  expect(css).toMatch(/Prop \/ geometry inspector styles live in propInspector\.css/);
  expect(css).not.toMatch(/\.right-sidebar \.prop-inspector \.prop-transform-section\s*\{/);
});
