import { readFileSync } from "node:fs";

const css = readFileSync("frontend/director/src/agent/terminalAssistant.css", "utf8");

it("keeps embedded terminal chrome on a compact production scale", () => {
  expect(css).toMatch(/\.director-agent-terminal-embedded\s*\{[^}]*--terminal-gutter:\s*8px;/);
  expect(css).toMatch(/\.director-agent-terminal-toolbar-leading\s*\{/);
  expect(css).toMatch(/\.director-agent-terminal-tab\s*\{[^}]*border-radius:\s*999px;/);
  expect(css).toMatch(/\.director-agent-terminal-tab-actions\s*\{[^}]*border-radius:\s*999px;/);
  expect(css).toMatch(
    /\.director-agent-terminal-toolbar\.is-embedded \.director-agent-terminal-process-state\.is-compact\s*\{/,
  );
  expect(css).toMatch(/\.director-agent-terminal\.is-embedded-surface\s*\{[^}]*flex:\s*1 1 auto;/);
  expect(css).toMatch(/\.director-agent-terminal-banner-icon\s*\{/);
});
