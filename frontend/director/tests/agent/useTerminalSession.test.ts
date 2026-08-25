import { expect, it } from "vitest";
import {
  applyTerminalSemanticColors,
  applyTerminalSemanticColorsToSpans,
  collectTerminalSemanticColorTargets,
  getTerminalSemanticStyle,
  TERMINAL_THEME,
} from "../../src/agent/useTerminalSession";

it("assigns restrained semantic colors to otherwise monochrome agent UI text", () => {
  expect(getTerminalSemanticStyle("OpenAI Codex")).toEqual({
    color: TERMINAL_THEME.cursor,
    fontWeight: "700",
  });
  expect(getTerminalSemanticStyle("gpt-5.6-terra medium")).toEqual({
    color: TERMINAL_THEME.brightBlue,
  });
  expect(getTerminalSemanticStyle("~/Documents/Director")).toEqual({ color: TERMINAL_THEME.cyan });
  expect(getTerminalSemanticStyle("/model to change")).toEqual({ color: TERMINAL_THEME.magenta });
  expect(getTerminalSemanticStyle("Tip:")).toEqual({
    color: TERMINAL_THEME.yellow,
    fontWeight: "700",
  });
  expect(getTerminalSemanticStyle("›")).toEqual({
    color: TERMINAL_THEME.green,
    fontWeight: "700",
  });
});

it("never overrides explicit ANSI foreground colors", () => {
  expect(getTerminalSemanticStyle("ready", "xterm-bold xterm-fg-2")).toBeNull();
  expect(getTerminalSemanticStyle("OpenAI Codex", "xterm-bold", true)).toBeNull();
});

it("updates reused xterm spans and removes stale semantic styles", () => {
  const root = document.createElement("div");
  root.innerHTML = `
    <div class="xterm-rows">
      <span class="xterm-bold">OpenAI Codex</span>
      <span class="xterm-fg-2">ready</span>
    </div>
  `;

  applyTerminalSemanticColors(root);
  const [brand, ansi] = Array.from(root.querySelectorAll<HTMLSpanElement>("span"));
  expect(brand).toHaveClass("director-terminal-semantic-color");
  expect(brand.style.getPropertyValue("--director-terminal-semantic-color")).toBe(TERMINAL_THEME.cursor);
  expect(ansi).not.toHaveClass("director-terminal-semantic-color");

  brand.textContent = "plain output";
  applyTerminalSemanticColors(root);
  expect(brand).not.toHaveClass("director-terminal-semantic-color");
  expect(brand.style.getPropertyValue("--director-terminal-semantic-color")).toBe("");
});

it("collects only spans added to or dirtied inside xterm rows", () => {
  const root = document.createElement("div");
  root.innerHTML = `
    <div class="xterm-rows">
      <div><span id="stable">stable output</span></div>
      <div><span id="dirty">plain output</span></div>
    </div>
  `;
  const stable = root.querySelector<HTMLSpanElement>("#stable")!;
  const dirty = root.querySelector<HTMLSpanElement>("#dirty")!;
  const addedRow = document.createElement("div");
  addedRow.innerHTML = `<span id="added">OpenAI Codex</span><span class="xterm-fg-2">ready</span>`;
  root.querySelector(".xterm-rows")!.append(addedRow);
  const added = addedRow.querySelector<HTMLSpanElement>("#added")!;

  const targets = collectTerminalSemanticColorTargets(
    [
      {
        type: "characterData",
        target: dirty.firstChild!,
      } as unknown as MutationRecord,
      {
        type: "childList",
        target: root.querySelector(".xterm-rows")!,
        addedNodes: [addedRow] as unknown as NodeList,
      } as unknown as MutationRecord,
    ],
    root,
  );

  expect(Array.from(targets)).toEqual([dirty, added, addedRow.lastElementChild]);
  expect(targets).not.toContain(stable);
});

it("can recolor a dirty span batch without rescanning or touching stable rows", () => {
  const root = document.createElement("div");
  root.innerHTML = `
    <div class="xterm-rows">
      <span id="stable" class="director-terminal-semantic-color"
        style="--director-terminal-semantic-color: red">plain output</span>
      <span id="dirty">OpenAI Codex</span>
      <span id="ansi" class="xterm-fg-2">ready</span>
    </div>
  `;
  const stable = root.querySelector<HTMLSpanElement>("#stable")!;
  const dirty = root.querySelector<HTMLSpanElement>("#dirty")!;
  const ansi = root.querySelector<HTMLSpanElement>("#ansi")!;

  applyTerminalSemanticColorsToSpans([dirty, ansi]);

  expect(dirty).toHaveClass("director-terminal-semantic-color");
  expect(dirty.style.getPropertyValue("--director-terminal-semantic-color")).toBe(TERMINAL_THEME.cursor);
  expect(ansi).not.toHaveClass("director-terminal-semantic-color");
  expect(stable).toHaveClass("director-terminal-semantic-color");
  expect(stable.style.getPropertyValue("--director-terminal-semantic-color")).toBe("red");
});
