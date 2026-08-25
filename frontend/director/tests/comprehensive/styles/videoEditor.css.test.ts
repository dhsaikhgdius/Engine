import { readFileSync } from "node:fs";

const workspacesCss = readFileSync("frontend/director/src/comprehensive/styles/workspaces.css", "utf8");
const videoCss = readFileSync("frontend/director/src/comprehensive/styles/videoEditor.css", "utf8");

it("defers video editor styles to videoEditor.css", () => {
  expect(workspacesCss).toMatch(/Video editor styles live in videoEditor\.css/);
  expect(workspacesCss).not.toMatch(/\.creative-video-main\s*\{/);
});

it("lets the video editor timeline follow the selected application theme", () => {
  expect(videoCss).not.toMatch(/\.creative-video-main\s*\{[\s\S]*?--surface-rgb:/);
  expect(videoCss).toMatch(/\.creative-edit-timeline\s*\{[\s\S]*?background:[\s\S]*?rgb\(var\(--field-rgb\)/);
  expect(videoCss).toMatch(/\.creative-timeline-ruler\s*\{[\s\S]*?position:\s*sticky;/);
  expect(videoCss).toMatch(/\.creative-timeline-track\s*\{[\s\S]*?var\(--timeline-grid-size\)/);
  expect(videoCss).toMatch(/\.creative-preview-stack \.creative-preview-media\s*\{[^}]*width:\s*100%;/);
  expect(videoCss).toMatch(/\.creative-preview-title-overlay span\s*\{[^}]*text-rendering:\s*geometricPrecision;/);
});

it("styles polished track labels and timeline lanes", () => {
  expect(videoCss).toMatch(/\.creative-track-label\.is-video::before\s*\{[\s\S]*?var\(--video-kind-video, #d96d83\)/);
  expect(videoCss).toMatch(/\.creative-track-label\s*\{[^}]*padding:\s*0 8px 0 10px;/);
  expect(videoCss).toMatch(/\.creative-track-kind-badge\s*\{[^}]*width:\s*24px;/);
  expect(videoCss).not.toMatch(/\.creative-track-kind-badge\s*\{[^}]*margin-left:/);
  expect(videoCss).toMatch(/\.creative-transport-dropdown-menu\.is-portaled\s*\{[\s\S]*?position:\s*fixed;/);
  expect(videoCss).toMatch(/\.creative-transport-dropdown-menu\s*\{[\s\S]*?min-width:\s*120px;/);
  expect(videoCss).toMatch(/\.creative-transport-dropdown-menu \.creative-transport-dropdown-option\s*\{/);
  // Empty lanes stay clean; only an active drop target draws a ring.
  expect(videoCss).not.toMatch(/\.creative-timeline-track::after/);
  expect(videoCss).toMatch(/\.creative-timeline-track\.is-drop-target\s*\{[^}]*box-shadow:\s*inset 0 0 0 1px/);
});

it("keeps timecode and duration readouts on the instrumentation mono font", () => {
  expect(videoCss).toMatch(/--video-mono-font:/);
  expect(videoCss).toMatch(/\.creative-transport-bar time\s*\{[^}]*font-family:\s*var\(--video-mono-font\)/);
  expect(videoCss).toMatch(/\.creative-timeline-ruler span\s*\{[^}]*font-family:\s*var\(--video-mono-font\)/);
  expect(videoCss).toMatch(/\.creative-preview-meta time\s*\{[^}]*font-family:\s*var\(--video-mono-font\)/);
});

it("selects clips with a neutral frame instead of colored glows", () => {
  expect(videoCss).toMatch(/\.creative-timeline-clip\.is-selected\s*\{[^}]*rgb\(var\(--text-rgb\) \/ 0\.78\)/);
  expect(videoCss).not.toMatch(/box-shadow:[^;}]*0 0 16px rgb\(var\(--accent-rgb\)/);
  expect(videoCss).not.toMatch(/\.creative-timeline-clip\.is-selected\s*\{[^}]*transform:\s*translateY/);
});

it("sizes the video inspector tab row from its segmented control content", () => {
  expect(videoCss).toMatch(/\.creative-video-inspector\s*\{[\s\S]*?grid-template-rows:\s*auto minmax\(0,\s*1fr\)/);
  expect(videoCss).toMatch(/\.creative-inspector-tabs button\s*\{[\s\S]*?height:\s*32px;/);
});

it("uses Apple-style segmented controls and grouped transport for the video workspace", () => {
  expect(videoCss).toMatch(/\.creative-video-workspace\s*\{[\s\S]*?--video-control-height:\s*36px;/);
  expect(videoCss).toMatch(/\.creative-inspector-tabs\s*\{[\s\S]*?border-radius:\s*10px;/);
  expect(videoCss).toMatch(/\.creative-transport-group\s*\{/);
  expect(videoCss).toMatch(/\.creative-transport-bar \.creative-play-button\s*\{[\s\S]*?border-radius:\s*999px;/);
  expect(videoCss).toMatch(/\.creative-video-export-actions button\.is-primary\s*\{[\s\S]*?border-radius:\s*999px;/);
});

it("styles the preview empty state with a centered icon shell", () => {
  expect(videoCss).toMatch(/\.creative-preview-empty-icon\s*\{[\s\S]*?border-radius:\s*16px;/);
  expect(videoCss).toMatch(/\.creative-preview-empty-copy strong\s*\{[\s\S]*?font-size:\s*15px;/);
});
