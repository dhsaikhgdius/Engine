import { describe, expect, it } from "vitest";
import { blitFlippedRgba } from "../../../../src/comprehensive/editor/canvas/cameraPictureInPictureFreeze";

describe("blitFlippedRgba", () => {
  it("flips WebGL readPixels rows into canvas ImageData order", () => {
    const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const destination = new Uint8ClampedArray(8);
    blitFlippedRgba(source, 1, 2, destination);
    expect([...destination]).toEqual([5, 6, 7, 8, 1, 2, 3, 4]);
  });
});
