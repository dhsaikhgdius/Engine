import { OrthographicCamera, PerspectiveCamera } from "three";
import { describe, expect, it } from "vitest";
import type { DirectorObject } from "../../../../src/comprehensive/editor/schema/directorProject";
import {
  configureDirectorOrthographicCamera,
  configureDirectorPerspectivePane,
  getDirectorQuadViewFraming,
  getDirectorQuadViewportRects,
  getDirectorQuadViewportRenderRects,
  getNextDirectorQuadViewportZoom,
} from "../../../../src/comprehensive/editor/canvas/quadViewport";

function object(id: string, position: [number, number, number], scale: [number, number, number]): DirectorObject {
  return {
    id,
    name: id,
    kind: "prop",
    visible: true,
    locked: false,
    geometryType: "box",
    transform: { position, rotation: [0, 0, 0], scale },
  };
}

describe("quad viewport", () => {
  it("covers odd-sized canvases exactly without gaps", () => {
    expect(getDirectorQuadViewportRects(1001, 701)).toEqual([
      {
        id: "perspective",
        label: "透视",
        x: 0,
        y: 350,
        width: 500,
        height: 351,
      },
      { id: "top", label: "顶视", x: 500, y: 350, width: 501, height: 351 },
      { id: "front", label: "前视", x: 0, y: 0, width: 500, height: 350 },
      { id: "right", label: "右视", x: 500, y: 0, width: 501, height: 350 },
    ]);
  });

  it("expands one pane across the complete canvas without changing the persisted layout", () => {
    expect(getDirectorQuadViewportRects(1001, 701, "front")).toEqual([
      { id: "front", label: "前视", x: 0, y: 0, width: 1001, height: 701 },
    ]);
  });

  it("keeps viewport rectangles in CSS pixels because WebGLRenderer applies DPR", () => {
    expect(getDirectorQuadViewportRenderRects(1001, 701, 1.25)).toEqual([
      { id: "perspective", label: "透视", x: 0, y: 350, width: 500, height: 351 },
      { id: "top", label: "顶视", x: 500, y: 350, width: 501, height: 351 },
      { id: "front", label: "前视", x: 0, y: 0, width: 500, height: 350 },
      { id: "right", label: "右视", x: 500, y: 0, width: 501, height: 350 },
    ]);
  });

  it("frames the whole visible stage independently from selection", () => {
    const objects = [object("a", [0, 1, 0], [2, 2, 2]), object("b", [30, 1, 0], [2, 2, 2])];
    expect(getDirectorQuadViewFraming(objects).center[0]).toBe(15);
  });

  it("frames scene-transformed objects in world space", () => {
    const framing = getDirectorQuadViewFraming([object("actor", [16, 1, -6], [1, 2, 1])], 0, {
      position: [2, 0, 3],
      rotation: [0, Math.PI / 2, 0],
      scale: 0.5,
    });

    expect(framing.center[0]).toBeCloseTo(-1);
    expect(framing.center[1]).toBeCloseTo(0.5);
    expect(framing.center[2]).toBeCloseTo(-5);
    expect(framing.radius).toBeGreaterThanOrEqual(2);
  });

  it("configures stable top/front/right cameras and perspective aspect", () => {
    const framing = {
      center: [1, 2, 3] as [number, number, number],
      halfSize: [4, 3, 2] as [number, number, number],
      radius: 5,
    };
    const top = configureDirectorOrthographicCamera(new OrthographicCamera(), "top", framing, 2, 2);
    const front = configureDirectorOrthographicCamera(new OrthographicCamera(), "front", framing, 1);
    const right = configureDirectorOrthographicCamera(new OrthographicCamera(), "right", framing, 1);
    const perspectiveCamera = new PerspectiveCamera();
    perspectiveCamera.position.set(0, 0, 10);
    perspectiveCamera.lookAt(0, 0, 0);
    const perspective = configureDirectorPerspectivePane(perspectiveCamera, framing, 16 / 9, 1.5);

    expect(top.position.y).toBeGreaterThan(2);
    expect(top.up.toArray()).toEqual([0, 0, -1]);
    expect(front.position.z).toBeGreaterThan(3);
    expect(right.position.x).toBeGreaterThan(1);
    expect(top.right - top.left).toBeCloseTo((top.top - top.bottom) * 2);
    expect(top.top - top.bottom).toBeCloseTo(2.2);
    expect(perspective.aspect).toBeCloseTo(16 / 9);
    expect(perspective.zoom).toBeCloseTo(1.5);
    expect(perspective.position.x).toBeCloseTo(1);
    expect(perspective.position.y).toBeCloseTo(2);
    expect(perspective.position.z).toBeGreaterThan(3);
  });

  it("turns wheel input into bounded pane-local zoom", () => {
    expect(getNextDirectorQuadViewportZoom(1, -120)).toBeGreaterThan(1);
    expect(getNextDirectorQuadViewportZoom(1, 120)).toBeLessThan(1);
    expect(getNextDirectorQuadViewportZoom(8, -320)).toBe(8);
    expect(getNextDirectorQuadViewportZoom(0.5, 320)).toBe(0.5);
    expect(getNextDirectorQuadViewportZoom(1, 120)).toBeGreaterThan(0.8);
  });
});
