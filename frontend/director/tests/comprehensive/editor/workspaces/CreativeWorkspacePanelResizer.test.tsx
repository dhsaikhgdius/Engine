import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CreativeWorkspacePanelResizer,
  useCreativeWorkspacePanelLayout,
} from "../../../../src/comprehensive/editor/workspaces/CreativeWorkspacePanelResizer";

const STORAGE_KEY = "director.creative-panel-widths.v1";

function PanelLayoutProbe() {
  const layout = useCreativeWorkspacePanelLayout();
  return (
    <div>
      <output data-testid="panel-widths">{JSON.stringify(layout.widths)}</output>
      <CreativeWorkspacePanelResizer
        label="调整素材栏宽度"
        onKeyDown={(event) => layout.resizeFromKeyboard("media", event)}
        onPointerDown={(event) => layout.beginResize("media", event)}
        panel="media"
      />
    </div>
  );
}

function currentWidths(): Record<string, number> {
  return JSON.parse(screen.getByTestId("panel-widths").textContent ?? "{}") as Record<string, number>;
}

function storedWidths(): Record<string, number> {
  return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, number>;
}

describe("useCreativeWorkspacePanelLayout", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("restores stored widths, clamping to bounds and ignoring invalid fields", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ media: 300, inspector: 9999, agent: "wide" }));

    render(<PanelLayoutProbe />);

    expect(currentWidths()).toEqual({ media: 300, inspector: 420 });
  });

  it("falls back to defaults when the stored payload is not valid JSON", () => {
    localStorage.setItem(STORAGE_KEY, "{not json");

    render(<PanelLayoutProbe />);

    expect(currentWidths()).toEqual({ media: 248, inspector: 286 });
  });

  it("persists width changes to localStorage", () => {
    render(<PanelLayoutProbe />);

    fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowRight" });

    expect(currentWidths().media).toBe(264);
    expect(storedWidths()).toEqual({ media: 264, inspector: 286 });
  });

  it("resets the panel to its default width on double-click pointerdown", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ media: 360 }));
    render(<PanelLayoutProbe />);
    expect(currentWidths().media).toBe(360);

    fireEvent.pointerDown(screen.getByRole("separator"), { button: 0, detail: 2 });

    expect(currentWidths().media).toBe(248);
    expect(storedWidths().media).toBe(248);
  });

  it("does not reset the width on a single pointerdown", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ media: 360 }));
    render(<PanelLayoutProbe />);

    fireEvent.pointerDown(screen.getByRole("separator"), { button: 0, detail: 1 });
    expect(currentWidths().media).toBe(360);

    fireEvent.pointerUp(window);
  });
});
