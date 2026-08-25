import { describe, expect, it } from "vitest";
import type { DirectorObject } from "../../../../src/comprehensive/editor/schema/directorProject";
import { getDirectorSupportContact, resolveDirectorPhysicalPlacements } from "../../../../src/comprehensive/editor/geometry/physicalPlacement";

function object(input: Partial<DirectorObject> & Pick<DirectorObject, "id" | "kind">): DirectorObject {
  const { id, kind, ...overrides } = input;
  return {
    id,
    kind,
    name: id,
    visible: true,
    locked: false,
    transform: {
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    },
    ...overrides,
  };
}

describe("physical Director placement", () => {
  it("raises a grounded character from a thick floor pivot to the walkable top", () => {
    const floor = object({
      id: "floor",
      kind: "prop",
      geometryType: "box",
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [14, 0.18, 9] },
    });
    const character = object({ id: "actor", kind: "character", placementMode: "grounded" });

    const resolved = resolveDirectorPhysicalPlacements([floor, character], 0);

    expect(resolved.find((item) => item.id === "actor")?.transform.position).toEqual([0, 0.18, 0]);
    expect(character.transform.position).toEqual([0, 0, 0]);
    expect(getDirectorSupportContact(character, [floor, character], 0)?.supportObjectId).toBe("floor");
  });

  it("keeps airborne and explicitly floating characters out of automatic grounding", () => {
    const floor = object({
      id: "floor",
      kind: "prop",
      geometryType: "box",
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [10, 0.18, 10] },
    });
    const airborne = object({
      id: "airborne",
      kind: "character",
      placementMode: "grounded",
      transform: { position: [0, 0.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    });
    const floating = object({ id: "floating", kind: "character", placementMode: "floating" });

    const resolved = resolveDirectorPhysicalPlacements([floor, airborne, floating], 0);

    expect(resolved.find((item) => item.id === "airborne")?.transform.position[1]).toBe(0.5);
    expect(resolved.find((item) => item.id === "floating")?.transform.position[1]).toBe(0);
  });

  it("allows an explicitly supported character to stand on a raised platform", () => {
    const platform = object({
      id: "platform",
      kind: "prop",
      geometryType: "cylinder",
      transform: { position: [0, 0.2, 0], rotation: [0, 0, 0], scale: [3.8, 0.55, 3.8] },
    });
    const character = object({ id: "hero", kind: "character", placementMode: "supported" });

    expect(resolveDirectorPhysicalPlacements([platform, character], 0)[1]?.transform.position[1]).toBeCloseTo(0.75);
  });
});
