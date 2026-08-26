import { describe, expect, it } from "vitest";
import {
  CANVAS_BOARD_FIT_MAX_ZOOM,
  clampCanvasBoardZoom,
  computeCanvasBoardFitViewport,
  normalizeCanvasBoardViewport,
} from "../../../../src/comprehensive/editor/workspaces/canvasBoardViewport";

describe("canvasBoardViewport", () => {
  it("clamps zoom into the shared board range", () => {
    expect(clampCanvasBoardZoom(0.01)).toBe(0.1);
    expect(clampCanvasBoardZoom(9)).toBe(2.5);
    expect(clampCanvasBoardZoom(Number.NaN)).toBe(1);
  });

  it("normalizes non-finite pan to zero", () => {
    expect(normalizeCanvasBoardViewport({ x: Number.NaN, y: 12, zoom: 3 })).toEqual({
      x: 0,
      y: 12,
      zoom: 2.5,
    });
  });

  it("resets to identity when the board is empty", () => {
    expect(computeCanvasBoardFitViewport([], { width: 1_000, height: 800 })).toEqual({
      x: 0,
      y: 0,
      zoom: 1,
    });
  });

  it("frames node bounds into the surface with padding and a max zoom cap", () => {
    const viewport = computeCanvasBoardFitViewport(
      [{ x: 0, y: 0, width: 200, height: 100 }],
      { width: 1_000, height: 800 },
      { padding: 100 },
    );
    expect(viewport.zoom).toBe(CANVAS_BOARD_FIT_MAX_ZOOM);
    expect(viewport.x).toBeCloseTo((1_000 - 200 * CANVAS_BOARD_FIT_MAX_ZOOM) / 2);
    expect(viewport.y).toBeCloseTo((800 - 100 * CANVAS_BOARD_FIT_MAX_ZOOM) / 2);
  });
});
