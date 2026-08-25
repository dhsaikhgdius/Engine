import { expect, it } from "vitest";
import type { DirectorObject } from "../../../../src/comprehensive/editor/schema/directorProject";
import {
  getDirectorMeasurementDistance,
  resolveDirectorSceneAnchor,
} from "../../../../src/comprehensive/editor/canvas/sceneOverlays";

it("resolves object-local annotation and measurement anchors through scale, rotation, and translation", () => {
  const object = {
    id: "prop-1",
    name: "Prop",
    kind: "prop",
    visible: true,
    locked: false,
    transform: { position: [2, 1, 0], rotation: [0, Math.PI / 2, 0], scale: [2, 2, 2] },
  } satisfies DirectorObject;
  const resolved = resolveDirectorSceneAnchor(
    { objectId: object.id, position: [1, 0, 0] },
    new Map([[object.id, object]]),
  );
  expect(resolved?.[0]).toBeCloseTo(2);
  expect(resolved?.[1]).toBeCloseTo(1);
  expect(resolved?.[2]).toBeCloseTo(-2);
  expect(getDirectorMeasurementDistance([0, 0, 0], [3, 4, 0])).toBe(5);
});
