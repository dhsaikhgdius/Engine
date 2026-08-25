import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyViewportChromeDragTransform,
  clampViewportChromeOffset,
  commitViewportChromeDragTransform,
  DEFAULT_CAMERA_PIP_OFFSET,
  getCameraPictureInPictureRenderRect,
  getCameraPictureInPictureRenderRectFromLayout,
  getCameraPictureInPictureRenderTargetSize,
  getCameraPictureInPictureFreezeLayer,
  resetCameraViewportChromeOffsets,
  resolveCameraPictureInPictureLayout,
  resolveViewportChromeOffsetFromPointer,
  setCameraPictureInPictureOverlayElement,
} from "../../../../src/comprehensive/editor/canvas/viewportChromeDrag";

afterEach(() => {
  resetCameraViewportChromeOffsets();
  setCameraPictureInPictureOverlayElement(null);
});

describe("resolveCameraPictureInPictureLayout", () => {
  it("keeps a stable monitor size independent of its horizontal offset", () => {
    expect(resolveCameraPictureInPictureLayout(1_200, 16 / 9)).toEqual({
      width: 320,
      height: 180,
    });
    expect(resolveCameraPictureInPictureLayout(500, 16 / 9)).toEqual({
      width: 320,
      height: 180,
    });
  });
});

describe("camera picture-in-picture raster quality", () => {
  it("matches the full physical-pixel size instead of rendering a half-resolution cache", () => {
    expect(getCameraPictureInPictureRenderTargetSize(320, 180, 1)).toEqual({ width: 320, height: 180 });
    expect(getCameraPictureInPictureRenderTargetSize(320, 180, 2)).toEqual({ width: 640, height: 360 });
    expect(getCameraPictureInPictureRenderTargetSize(320, 180, 0.75)).toEqual({ width: 240, height: 135 });
    expect(getCameraPictureInPictureRenderTargetSize(320, 180, Number.NaN)).toEqual({ width: 320, height: 180 });
  });
});

describe("viewport chrome pointer placement", () => {
  const bounds = {
    left: 100,
    top: 50,
    width: 500,
    height: 360,
  } as DOMRect;

  it("clamps a stored narrow-viewport offset without changing the panel width", () => {
    expect(clampViewportChromeOffset(DEFAULT_CAMERA_PIP_OFFSET, 320, 180, bounds)).toEqual({ x: 172, y: 18 });
  });

  it("preserves the point grabbed inside the panel on the first one-pixel move", () => {
    expect(
      resolveViewportChromeOffsetFromPointer(
        { clientX: 251, clientY: 139 },
        { x: 50, y: 70 },
        { width: 320, height: 180 },
        bounds,
      ),
    ).toEqual({ x: 101, y: 19 });
  });

  it("accounts for a moving viewport container instead of detaching from the pointer", () => {
    expect(
      resolveViewportChromeOffsetFromPointer(
        { clientX: 251, clientY: 139 },
        { x: 50, y: 70 },
        { width: 320, height: 180 },
        { ...bounds, left: 80 },
      ),
    ).toEqual({ x: 121, y: 19 });
  });
});

describe("getCameraPictureInPictureRenderRect", () => {
  it("resolves the hot render-loop path without consulting DOM geometry", () => {
    const canvas = document.createElement("canvas");
    const overlay = document.createElement("aside");
    canvas.getBoundingClientRect = vi.fn(() => {
      throw new Error("render-loop layout read");
    });
    overlay.getBoundingClientRect = vi.fn(() => {
      throw new Error("render-loop layout read");
    });
    setCameraPictureInPictureOverlayElement(overlay);

    expect(
      getCameraPictureInPictureRenderRectFromLayout({
        viewportWidth: 800,
        viewportHeight: 450,
        offset: DEFAULT_CAMERA_PIP_OFFSET,
        aspect: 16 / 9,
      }),
    ).toEqual({
      x: 274,
      y: 252,
      width: 320,
      height: 180,
    });
    expect(canvas.getBoundingClientRect).not.toHaveBeenCalled();
    expect(overlay.getBoundingClientRect).not.toHaveBeenCalled();
  });

  it("maps the painted overlay bounds onto the renderer's logical viewport", () => {
    const canvas = document.createElement("canvas");
    canvas.width = 1_600;
    canvas.height = 900;
    canvas.getBoundingClientRect = () =>
      ({
        left: 100,
        top: 50,
        right: 900,
        bottom: 500,
        width: 800,
        height: 450,
        x: 100,
        y: 50,
        toJSON: () => ({}),
      }) as DOMRect;

    const overlay = document.createElement("aside");
    overlay.className = "camera-picture-in-picture";
    overlay.getBoundingClientRect = () =>
      ({
        left: 374,
        top: 68,
        right: 694,
        bottom: 248,
        width: 320,
        height: 180,
        x: 374,
        y: 68,
        toJSON: () => ({}),
      }) as DOMRect;
    setCameraPictureInPictureOverlayElement(overlay);

    expect(
      getCameraPictureInPictureRenderRect(canvas, {
        viewportWidth: 800,
        viewportHeight: 450,
        offset: DEFAULT_CAMERA_PIP_OFFSET,
        aspect: 16 / 9,
      }),
    ).toEqual({
      x: 274,
      y: 252,
      width: 320,
      height: 180,
    });
  });

  it("falls back to offset math when the overlay is not mounted", () => {
    const canvas = document.createElement("canvas");
    canvas.width = 800;
    canvas.height = 450;

    expect(
      getCameraPictureInPictureRenderRect(canvas, {
        viewportWidth: 800,
        viewportHeight: 450,
        offset: DEFAULT_CAMERA_PIP_OFFSET,
        aspect: 16 / 9,
      }),
    ).toEqual({
      x: 274,
      y: 252,
      width: 320,
      height: 180,
    });
  });
});

describe("viewport chrome drag transforms", () => {
  it("follows the pointer with translate3d and bakes left/top only on commit", () => {
    const root = document.createElement("div");
    const panel = document.createElement("aside");
    panel.setAttribute("data-viewport-chrome", "pip");
    panel.style.left = "10px";
    panel.style.top = "20px";
    const modes = document.createElement("div");
    modes.setAttribute("data-viewport-chrome-satellite", "pip");
    modes.style.left = "10px";
    modes.style.top = "206px";
    root.append(panel, modes);

    applyViewportChromeDragTransform(panel, { x: 10, y: 20 }, { x: 40, y: 50 });

    expect(panel.style.transform).toBe("translate3d(30px, 30px, 0)");
    expect(modes.style.transform).toBe("translate3d(30px, 30px, 0)");
    expect(panel.style.left).toBe("10px");
    expect(panel.style.top).toBe("20px");

    commitViewportChromeDragTransform(panel, { x: 10, y: 20 }, { x: 40, y: 50 });

    expect(panel.style.transform).toBe("");
    expect(modes.style.transform).toBe("");
    expect(panel.style.left).toBe("40px");
    expect(panel.style.top).toBe("50px");
    expect(modes.style.left).toBe("40px");
    expect(modes.style.top).toBe("236px");
  });
});

describe("camera picture-in-picture freeze canvas", () => {
  it("reads the freeze layer from the registered overlay", () => {
    expect(getCameraPictureInPictureFreezeLayer()).toBeNull();

    const overlay = document.createElement("aside");
    const layer = document.createElement("div");
    layer.className = "camera-picture-in-picture__freeze";
    overlay.append(layer);
    setCameraPictureInPictureOverlayElement(overlay);

    expect(getCameraPictureInPictureFreezeLayer()).toBe(layer);
  });
});
