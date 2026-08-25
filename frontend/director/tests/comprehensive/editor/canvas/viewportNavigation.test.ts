import { MOUSE } from "three";
import { describe, expect, it } from "vitest";

import {
  getViewportNavigationMouseButtons,
  hasViewportMovementKey,
} from "../../../../src/comprehensive/editor/canvas/viewportNavigation";

describe("viewport navigation contract", () => {
  it("keeps the Flick-compatible orbit/pan/dolly contract in Pan view", () => {
    expect(getViewportNavigationMouseButtons("hand")).toEqual({
      LEFT: MOUSE.ROTATE,
      MIDDLE: MOUSE.DOLLY,
      RIGHT: MOUSE.PAN,
    });
  });

  it("keeps the base pointer contract stable in Cursor view", () => {
    expect(getViewportNavigationMouseButtons("cursor")).toEqual({
      LEFT: MOUSE.ROTATE,
      MIDDLE: MOUSE.DOLLY,
      RIGHT: MOUSE.PAN,
    });
  });

  it("does not treat Shift by itself as a movement intent", () => {
    expect(hasViewportMovementKey(new Set(["ShiftLeft"]))).toBe(false);
    expect(hasViewportMovementKey(new Set(["KeyE"]))).toBe(true);
    expect(hasViewportMovementKey(new Set(["KeyQ"]))).toBe(true);
  });
});
