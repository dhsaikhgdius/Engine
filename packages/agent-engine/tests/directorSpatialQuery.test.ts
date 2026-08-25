import { describe, expect, it } from "vitest";
import { createDefaultDirectorProject } from "../src/directorDefaultProject";
import { applyDirectorAuthoringActions } from "../src/directorAuthoring";
import { getDirectorObjectLocalBounds } from "../src/directorSpatialGeometry";
import { queryDirectorObjects } from "../src/directorSpatialQuery";

function queryProject() {
  return applyDirectorAuthoringActions(createDefaultDirectorProject(), [
    { action: "start_scene" },
    {
      action: "add_object",
      id: "near-object",
      name: "Near object",
      kind: "prop",
      geometry_type: "box",
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [2, 2, 2] },
    },
    {
      action: "add_object",
      id: "front-object",
      name: "Front object",
      kind: "prop",
      geometry_type: "box",
      transform: { position: [0, 0, -20], rotation: [0, 0, 0], scale: [2, 2, 2] },
    },
    {
      action: "add_object",
      id: "side-object",
      name: "Side object",
      kind: "prop",
      geometry_type: "box",
      transform: { position: [20, 0, 0], rotation: [0, 0, 0], scale: [2, 2, 2] },
    },
    {
      action: "add_object",
      id: "wood-door",
      name: "木门",
      kind: "prop",
      geometry_type: "box",
      transform: { position: [80, 0, 80], rotation: [0, 0, 0], scale: [1, 2, 0.2] },
    },
    {
      action: "add_object",
      id: "hero-actor",
      name: "Hero",
      kind: "character",
      transform: { position: [90, 0, 90], rotation: [0, 0, 0], scale: [1, 1, 1] },
    },
    {
      action: "add_camera",
      id: "query-camera",
      name: "Query camera",
      position: [0, 2, 10],
      target: [0, 1, 0],
      activate: true,
    },
  ]).project;
}

describe("Director spatial object query", () => {
  it("filters the canonical object bounds by radius, AABB, and nearby object", () => {
    const project = queryProject();
    expect(
      queryDirectorObjects(
        project,
        { spatial: { mode: "radius", center: [0, 1, 0], radius_m: 3 } },
        {
          includeHidden: false,
          maxResults: 50,
        },
      ),
    ).toMatchObject({
      mode: "radius",
      match_count: 1,
      objects: [{ id: "near-object", distance_m: 0, bounds: { min: [-1, 0, -1], max: [1, 2, 1] } }],
    });
    expect(
      queryDirectorObjects(
        project,
        { spatial: { mode: "aabb", min: [-2, -1, -2], max: [2, 3, 2] } },
        {
          includeHidden: false,
          maxResults: 50,
        },
      ),
    ).toMatchObject({ match_count: 1, objects: [{ id: "near-object" }] });
    expect(
      queryDirectorObjects(
        project,
        { spatial: { mode: "nearby", object_id: "near-object", radius_m: 21 } },
        {
          includeHidden: false,
          maxResults: 50,
        },
      ),
    ).toMatchObject({ match_count: 2, objects: [{ id: "front-object" }, { id: "side-object" }] });
  });

  it("returns only objects intersecting the selected camera frustum", () => {
    expect(
      queryDirectorObjects(
        queryProject(),
        { spatial: { mode: "frustum", camera_id: "query-camera" } },
        {
          includeHidden: false,
          maxResults: 50,
        },
      ),
    ).toMatchObject({
      camera_id: "query-camera",
      match_count: 2,
      objects: [{ id: "near-object" }, { id: "front-object" }],
    });
  });

  it("filters by name_pattern and kind without a spatial bound", () => {
    const project = queryProject();
    expect(
      queryDirectorObjects(project, { namePattern: "门" }, { includeHidden: false, maxResults: 50 }),
    ).toMatchObject({
      mode: "all",
      name_pattern: "门",
      match_count: 1,
      objects: [{ id: "wood-door", name: "木门" }],
    });
    expect(
      queryDirectorObjects(project, { namePattern: "door" }, { includeHidden: false, maxResults: 50 }),
    ).toMatchObject({
      match_count: 1,
      objects: [{ id: "wood-door" }],
    });
    expect(
      queryDirectorObjects(project, { kind: "character" }, { includeHidden: false, maxResults: 50 }),
    ).toMatchObject({
      kind: "character",
      match_count: 1,
      objects: [{ id: "hero-actor", kind: "character" }],
    });
  });

  it("uses measured character bounds before body-shape estimates", () => {
    const project = queryProject();
    const character = project.objects.find((object) => object.id === "hero-actor")!;
    character.localBoundsM = { min: [-0.31, -0.04, -0.22], max: [0.36, 1.73, 0.27] };

    expect(getDirectorObjectLocalBounds(character, project)).toEqual(character.localBoundsM);
  });

  it("uses measured asymmetric model bounds and never invents a preserve-mode cube", () => {
    const project = queryProject();
    project.assets.push(
      {
        id: "measured-building-asset",
        kind: "prop",
        sourceType: "model",
        fileName: "measured-building.glb",
        url: "/models/measured-building.glb",
        modelNormalization: "preserve",
        localBoundsM: { min: [-2, 0, -1], max: [3, 4, 1] },
      },
      {
        id: "unknown-building-asset",
        kind: "prop",
        sourceType: "model",
        fileName: "unknown-building.glb",
        url: "/models/unknown-building.glb",
        realWorldSizeM: 12,
        sizeSource: "estimated",
      },
    );
    project.objects.push(
      {
        id: "measured-building",
        name: "Measured building",
        kind: "prop",
        visible: true,
        locked: false,
        assetRefId: "measured-building-asset",
        transform: { position: [10, 0, 0], rotation: [0, 0, 0], scale: [2, 1, 1] },
      },
      {
        id: "unknown-building",
        name: "Unknown building",
        kind: "prop",
        visible: true,
        locked: false,
        assetRefId: "unknown-building-asset",
        transform: { position: [30, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      },
    );

    const result = queryDirectorObjects(
      project,
      { spatial: { mode: "aabb", min: [0, -1, -2], max: [40, 10, 2] } },
      { includeHidden: false, maxResults: 50 },
    );

    expect(result.objects).toContainEqual(
      expect.objectContaining({
        id: "measured-building",
        bounds: { min: [6, 0, -1], max: [16, 4, 1], center: [11, 2, 0], size: [10, 4, 2] },
      }),
    );
    expect(result.objects.some((object) => object.id === "unknown-building")).toBe(false);
  });
});
