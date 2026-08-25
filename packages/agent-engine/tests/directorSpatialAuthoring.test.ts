import { describe, expect, it } from "vitest";
import { getCameraViewSnapshotFromShot } from "@director/project-schema";
import { createDefaultDirectorProject } from "../src/directorDefaultProject";
import { applyDirectorAuthoringActions, directorAuthoringActionSchema } from "../src/directorAuthoring";

function planarAlignment(position: [number, number, number], yaw: number, target: [number, number, number]) {
  const dx = target[0] - position[0];
  const dz = target[2] - position[2];
  const distance = Math.hypot(dx, dz);
  return Math.sin(yaw) * (dx / distance) + Math.cos(yaw) * (dz / distance);
}

describe("composable semantic spatial authoring", () => {
  it("rejects ambiguous or degenerate spatial requests at the contract boundary", () => {
    expect(
      directorAuthoringActionSchema.safeParse({
        action: "place_relative",
        object_id: "actor-a",
        anchor_id: "actor-b",
        relation: "foreground",
        reference: "world",
      }).success,
    ).toBe(false);
    expect(
      directorAuthoringActionSchema.safeParse({
        action: "place_relative",
        object_id: "actor-a",
        anchor_id: "actor-b",
        relation: "right",
        distance_m: 2,
        clearance_m: 0.5,
      }).success,
    ).toBe(false);
    expect(
      directorAuthoringActionSchema.safeParse({
        action: "arrange_group",
        object_ids: ["actor-a", "actor-b"],
        layout: "line",
        spacing_m: 2,
        clearance_m: 0.5,
      }).success,
    ).toBe(false);
    expect(
      directorAuthoringActionSchema.safeParse({
        action: "arrange_group",
        object_ids: ["actor-a", "actor-a"],
        layout: "line",
        axis: [0, 0],
      }).success,
    ).toBe(false);
    expect(
      directorAuthoringActionSchema.safeParse({
        action: "arrange_facing_pair",
        object_ids: ["actor-a", "actor-a"],
      }).success,
    ).toBe(false);
    expect(
      directorAuthoringActionSchema.safeParse({
        action: "orient_toward",
        object_id: "actor-a",
        target_id: "actor-b",
        target_position: [0, 0, 0],
      }).success,
    ).toBe(false);
  });

  it("places an object in an anchor-local direction and can orient it toward the anchor", () => {
    const result = applyDirectorAuthoringActions(createDefaultDirectorProject(), [
      {
        action: "update_object",
        object_id: "char_default_a",
        patch: { transform: { position: [4, 0, 2], rotation: [0, Math.PI / 2, 0] } },
      },
      {
        action: "add_object",
        id: "char-relative",
        name: "Relative character",
        kind: "character",
        placement_mode: "grounded",
      },
      {
        action: "place_relative",
        object_id: "char-relative",
        anchor_id: "char_default_a",
        relation: "front",
        reference: "target",
        distance_m: 2,
        offset_m: [0.5, 0, 0],
        orient: "target",
      },
    ]);

    const anchor = result.project.objects.find((object) => object.id === "char_default_a")!;
    const placed = result.project.objects.find((object) => object.id === "char-relative")!;
    expect(placed.transform.position).toEqual([6, 0, 1.5]);
    expect(placed.lookTargetObjectId).toBe(anchor.id);
    expect(
      planarAlignment(placed.transform.position, placed.transform.rotation[1], anchor.transform.position),
    ).toBeCloseTo(1, 6);
  });

  it("derives default edge clearance from rotated object bounds", () => {
    const result = applyDirectorAuthoringActions(createDefaultDirectorProject(), [
      {
        action: "add_object",
        id: "wide-anchor",
        name: "Wide anchor",
        kind: "prop",
        geometry_type: "box",
        placement_mode: "grounded",
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [4, 1, 1] },
      },
      {
        action: "add_object",
        id: "rotated-prop",
        name: "Rotated prop",
        kind: "prop",
        geometry_type: "box",
        placement_mode: "grounded",
        transform: { position: [0, 0, 0], rotation: [0, Math.PI / 2, 0], scale: [2, 1, 1] },
      },
      {
        action: "place_relative",
        object_id: "rotated-prop",
        anchor_id: "wide-anchor",
        relation: "right",
        clearance_m: 0.6,
      },
    ]);

    const placed = result.project.objects.find((object) => object.id === "rotated-prop")!;
    // Anchor support is 2 m and the rotated prop projects 0.5 m on world X.
    expect(placed.transform.position).toEqual([3.1, 0, 0]);
  });

  it("uses conservative footprint radii when default group spacing also changes facing", () => {
    const result = applyDirectorAuthoringActions(createDefaultDirectorProject(), [
      ...["wide-a", "wide-b"].map((id) => ({
        action: "add_object" as const,
        id,
        name: id,
        kind: "prop" as const,
        geometry_type: "box" as const,
        placement_mode: "grounded" as const,
        transform: {
          position: [0, 0, 0] as [number, number, number],
          rotation: [0, 0, 0] as [number, number, number],
          scale: [4, 1, 1] as [number, number, number],
        },
      })),
      {
        action: "arrange_group",
        object_ids: ["wide-a", "wide-b"],
        layout: "line",
        axis: [1, 0],
        center: [0, 0, 0],
        clearance_m: 0.5,
        facing: "same_direction",
      },
    ]);
    const [left, right] = ["wide-a", "wide-b"].map((id) => result.project.objects.find((object) => object.id === id)!);
    expect(Math.abs(right.transform.position[0] - left.transform.position[0])).toBeGreaterThan(4.6);
  });

  it("arranges deterministic line, grid, circle, and arc formations", () => {
    const layouts = ["line", "grid", "circle", "arc"] as const;
    layouts.forEach((layout) => {
      const result = applyDirectorAuthoringActions(createDefaultDirectorProject(), [
        ...Array.from({ length: 4 }, (_, index) => ({
          action: "add_object" as const,
          id: `${layout}-${index}`,
          name: `${layout} ${index}`,
          kind: "character" as const,
          placement_mode: "grounded" as const,
        })),
        {
          action: "arrange_group",
          object_ids: Array.from({ length: 4 }, (_, index) => `${layout}-${index}`),
          layout,
          center: [3, 0, -2],
          spacing_m: 1.5,
          radius_m: 2,
          columns: 2,
          arc_degrees: 120,
          facing: layout === "line" || layout === "grid" ? "same_direction" : "center",
        },
      ]);
      const arranged = result.project.objects.filter((object) => object.id.startsWith(`${layout}-`));
      expect(arranged).toHaveLength(4);
      expect(new Set(arranged.map((object) => object.transform.position.join(","))).size).toBe(4);
      expect(arranged.every((object) => object.transform.position[1] === 0)).toBe(true);
      if (layout === "circle" || layout === "arc") {
        arranged.forEach((object) => {
          expect(Math.hypot(object.transform.position[0] - 3, object.transform.position[2] + 2)).toBeCloseTo(2, 5);
          expect(planarAlignment(object.transform.position, object.transform.rotation[1], [3, 0, -2])).toBeCloseTo(
            1,
            5,
          );
        });
      }
    });
  });

  it("creates a verified facing pair and supports direct target orientation", () => {
    const result = applyDirectorAuthoringActions(createDefaultDirectorProject(), [
      {
        action: "add_object",
        id: "pair-b",
        name: "Pair B",
        kind: "character",
        placement_mode: "grounded",
      },
      {
        action: "arrange_facing_pair",
        object_ids: ["char_default_a", "pair-b"],
        center: [1, 0, 3],
        axis: [0, 1],
        distance_m: 2.4,
      },
      {
        action: "add_object",
        id: "observer",
        name: "Observer",
        kind: "character",
        placement_mode: "grounded",
        transform: { position: [5, 0, 5], rotation: [0, 0, 0], scale: [1, 1, 1] },
      },
      { action: "orient_toward", object_id: "observer", target_id: "char_default_a" },
    ]);

    const left = result.project.objects.find((object) => object.id === "char_default_a")!;
    const right = result.project.objects.find((object) => object.id === "pair-b")!;
    const observer = result.project.objects.find((object) => object.id === "observer")!;
    expect(
      Math.hypot(
        left.transform.position[0] - right.transform.position[0],
        left.transform.position[2] - right.transform.position[2],
      ),
    ).toBeCloseTo(2.4, 6);
    expect(left.lookTargetObjectId).toBe(right.id);
    expect(right.lookTargetObjectId).toBe(left.id);
    expect(planarAlignment(left.transform.position, left.transform.rotation[1], right.transform.position)).toBeCloseTo(
      1,
      6,
    );
    expect(planarAlignment(right.transform.position, right.transform.rotation[1], left.transform.position)).toBeCloseTo(
      1,
      6,
    );
    expect(observer.lookTargetObjectId).toBe(left.id);
    expect(
      planarAlignment(observer.transform.position, observer.transform.rotation[1], left.transform.position),
    ).toBeCloseTo(1, 6);
  });

  it("uses screen-depth semantics for camera-relative foreground/background placement", () => {
    const source = createDefaultDirectorProject();
    const camera = source.cameras[0]!;
    const view = getCameraViewSnapshotFromShot(camera);
    const forwardX = view.target[0] - view.position[0];
    const forwardZ = view.target[2] - view.position[2];
    const forwardLength = Math.hypot(forwardX, forwardZ);
    const result = applyDirectorAuthoringActions(source, [
      {
        action: "add_object",
        id: "depth-prop",
        name: "Depth prop",
        kind: "prop",
        geometry_type: "box",
        placement_mode: "grounded",
      },
      {
        action: "place_relative",
        object_id: "depth-prop",
        anchor_id: "char_default_a",
        relation: "foreground",
        reference: "camera",
        camera_id: camera.id,
        distance_m: 2,
      },
    ]);
    const prop = result.project.objects.find((object) => object.id === "depth-prop")!;
    const deltaX = prop.transform.position[0] - source.objects[0]!.transform.position[0];
    const deltaZ = prop.transform.position[2] - source.objects[0]!.transform.position[2];
    const projectedDepth = deltaX * (forwardX / forwardLength) + deltaZ * (forwardZ / forwardLength);
    expect(projectedDepth).toBeCloseTo(-2, 5);
  });

  it("keeps spatial edits atomic when a selected object is locked", () => {
    const source = createDefaultDirectorProject();
    source.objects[0]!.locked = true;
    const before = structuredClone(source);
    const parsed = directorAuthoringActionSchema.parse({
      action: "orient_toward",
      object_id: "char_default_a",
      target_position: [2, 0, 2],
    });
    expect(() => applyDirectorAuthoringActions(source, [parsed])).toThrow(/locked/i);
    expect(source).toEqual(before);
  });
});
