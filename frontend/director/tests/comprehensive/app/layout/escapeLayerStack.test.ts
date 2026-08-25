import { expect, it } from "vitest";
import { getEscapeLayerDepth, registerEscapeLayer } from "../../../../src/comprehensive/app/layout/escapeLayerStack";

function pressEscape() {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}

it("routes Escape to the top layer only and unwinds layer by layer", () => {
  const closed: string[] = [];
  const releaseDialog = registerEscapeLayer(() => closed.push("dialog"));
  const releaseDropdown = registerEscapeLayer(() => closed.push("dropdown"));
  expect(getEscapeLayerDepth()).toBe(2);

  pressEscape();
  expect(closed).toEqual(["dropdown"]);

  releaseDropdown();
  pressEscape();
  expect(closed).toEqual(["dropdown", "dialog"]);

  releaseDialog();
  pressEscape();
  expect(closed).toEqual(["dropdown", "dialog"]);
  expect(getEscapeLayerDepth()).toBe(0);
});

it("ignores non-Escape keys", () => {
  const onEscape = [] as KeyboardEvent[];
  const release = registerEscapeLayer((event) => onEscape.push(event));

  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(onEscape).toHaveLength(0);

  release();
});

it("supports releasing a lower layer without disturbing the top layer", () => {
  const closed: string[] = [];
  const releaseBottom = registerEscapeLayer(() => closed.push("bottom"));
  const releaseTop = registerEscapeLayer(() => closed.push("top"));

  releaseBottom();
  pressEscape();
  expect(closed).toEqual(["top"]);

  releaseTop();
  expect(getEscapeLayerDepth()).toBe(0);
});

it("keeps release idempotent so double cleanup cannot pop someone else's layer", () => {
  const closed: string[] = [];
  const releaseFirst = registerEscapeLayer(() => closed.push("first"));
  releaseFirst();
  const releaseSecond = registerEscapeLayer(() => closed.push("second"));
  // A stale second call must not remove the newly registered layer.
  releaseFirst();

  pressEscape();
  expect(closed).toEqual(["second"]);

  releaseSecond();
  expect(getEscapeLayerDepth()).toBe(0);
});
