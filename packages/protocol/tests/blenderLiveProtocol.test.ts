import { describe, expect, it } from "vitest";
import {
  BLENDER_LIVE_CONTRACT,
  blenderEffectReceiptSchema,
  blenderLiveCommandBatchSchema,
  blenderLiveReadOperationNames,
  blenderLiveSceneSnapshotSchema,
  blenderObjectInspectionSchema,
  blenderNativeReadOperationNames,
  blenderNativeToolRequestSchema,
  blenderScenePreviewSchema,
} from "../src/blenderLiveProtocol";

const sceneEpoch = "82a6f8c1-7cb8-4d6f-a5f2-a4f5654a0420";

describe("Blender live contract", () => {
  it("normalizes a bounded blockout command", () => {
    const parsed = blenderLiveCommandBatchSchema.parse({
      requestId: "63a521f0-7fe3-4fd7-8e06-8457e806c6b3",
      expectedSceneEpoch: sceneEpoch,
      operations: [{ op: "create_blockout", preset: "room", idPrefix: "room-a" }],
    });
    expect(parsed.contract).toBe(BLENDER_LIVE_CONTRACT);
    expect(parsed.operations[0]).toMatchObject({
      op: "create_blockout",
      origin: [0, 0, 0],
      width: 8,
      depth: 6,
      height: 3,
    });
  });

  it("requires a scene epoch for scene-bound commands but not read-only operations", () => {
    expect(() =>
      blenderLiveCommandBatchSchema.parse({
        requestId: "63a521f0-7fe3-4fd7-8e06-8457e806c6b3",
        operations: [{ op: "create_primitive", id: "cube-a", primitive: "cube" }],
      }),
    ).toThrow(/expectedSceneEpoch/);
    expect(
      blenderLiveCommandBatchSchema.parse({
        requestId: "63a521f0-7fe3-4fd7-8e06-8457e806c6b3",
        operations: [{ op: "inspect_object", id: "cube-a" }],
      }).expectedSceneEpoch,
    ).toBeUndefined();
  });

  it("sets the Blender world through a typed operation and accepts scene RNA roots", () => {
    const parsed = blenderLiveCommandBatchSchema.parse({
      requestId: "73a521f0-7fe3-4fd7-8e06-8457e806c6b4",
      expectedSceneEpoch: sceneEpoch,
      operations: [{ op: "set_world_environment", color: [0.12, 0.18, 0.3], strength: 0.8 }],
    });

    expect(parsed.operations[0]).toEqual({
      op: "set_world_environment",
      color: [0.12, 0.18, 0.3],
      strength: 0.8,
    });
    expect(
      blenderLiveCommandBatchSchema.parse({
        requestId: "83a521f0-7fe3-4fd7-8e06-8457e806c6b4",
        expectedSceneEpoch: sceneEpoch,
        operations: [
          { op: "set_rna_property", target: { kind: "scene" }, path: ["eevee", "use_gtao"], value: true },
        ],
      }).operations[0],
    ).toEqual({
      op: "set_rna_property",
      target: { kind: "scene" },
      path: ["eevee", "use_gtao"],
      value: true,
    });
    expect(() =>
      blenderLiveCommandBatchSchema.parse({
        requestId: "93a521f0-7fe3-4fd7-8e06-8457e806c6b4",
        expectedSceneEpoch: sceneEpoch,
        operations: [
          { op: "set_rna_property", target: { kind: "data_block", name: "World" }, path: ["color"], value: [0, 0, 0] },
        ],
      }),
    ).toThrow();
  });

  it("binds a Director project independently, then accepts Director-owned object properties", () => {
    const binding = blenderLiveCommandBatchSchema.parse({
      requestId: "63a521f0-7fe3-4fd7-8e06-8457e806c6b3",
      operations: [{ op: "bind_director_project", projectId: "director-project-a" }],
    });
    expect(binding.expectedSceneEpoch).toBeUndefined();
    expect(binding.operations).toEqual([{ op: "bind_director_project", projectId: "director-project-a" }]);

    const update = blenderLiveCommandBatchSchema.parse({
      requestId: "73a521f0-7fe3-4fd7-8e06-8457e806c6b4",
      expectedSceneEpoch: sceneEpoch,
      operations: [
        { op: "set_object_name", id: "asset-root", name: "Lobby set" },
        { op: "set_object_visibility", id: "asset-root", visible: false },
      ],
    });
    expect(update.operations).toEqual([
      { op: "set_object_name", id: "asset-root", name: "Lobby set" },
      { op: "set_object_visibility", id: "asset-root", visible: false },
    ]);
  });

  it("imports a Director model as one native asset root", () => {
    const parsed = blenderLiveCommandBatchSchema.parse({
      requestId: "63a521f0-7fe3-4fd7-8e06-8457e806c6b3",
      expectedSceneEpoch: sceneEpoch,
      operations: [
        {
          op: "import_asset",
          id: "prop-chair-a",
          directorId: "prop-chair-a",
          assetId: "asset-chair",
          sourceUrl: "http://127.0.0.1:8787/native-models/model/chair.glb",
          fileName: "chair.glb",
          name: "Hero chair",
          kind: "prop",
          transform: {
            position: [2, 0, -1],
            rotation: [0, 0.5, 0],
            scale: [1.2, 1.2, 1.2],
          },
        },
      ],
    });

    expect(parsed.operations).toEqual([
      expect.objectContaining({
        op: "import_asset",
        id: "prop-chair-a",
        directorId: "prop-chair-a",
        normalization: "auto",
        grounded: false,
      }),
    ]);

    expect(() =>
      blenderLiveCommandBatchSchema.parse({
        requestId: "93a521f0-7fe3-4fd7-8e06-8457e806c6b4",
        expectedSceneEpoch: sceneEpoch,
        operations: [
          {
            op: "create_primitive",
            id: "ambiguous-wall",
            primitive: "cube",
            dimensions: [4, 3, 0.2],
            transform: { position: [0, 0, 0], scale: [4, 3, 0.2] },
          },
        ],
      }),
    ).toThrow();
  });

  it("creates a grounded Blender primitive linked to one Director object", () => {
    const parsed = blenderLiveCommandBatchSchema.parse({
      requestId: "73a521f0-7fe3-4fd7-8e06-8457e806c6b4",
      expectedSceneEpoch: sceneEpoch,
      operations: [
        {
          op: "create_primitive",
          id: "native-wall-a",
          directorId: "director-wall-a",
          primitive: "cube",
          grounded: true,
        },
      ],
    });

    expect(parsed.operations).toEqual([
      expect.objectContaining({
        op: "create_primitive",
        id: "native-wall-a",
        directorId: "director-wall-a",
        grounded: true,
      }),
    ]);
  });

  it("rejects unbounded or non-finite scene edits", () => {
    expect(() =>
      blenderLiveCommandBatchSchema.parse({
        requestId: "63a521f0-7fe3-4fd7-8e06-8457e806c6b3",
        expectedSceneEpoch: sceneEpoch,
        operations: [
          {
            op: "create_primitive",
            id: "cube-a",
            primitive: "cube",
            dimensions: [Number.POSITIVE_INFINITY, 1, 1],
          },
        ],
      }),
    ).toThrow();
  });

  it("requires Director coordinates in snapshots", () => {
    const parsed = blenderLiveSceneSnapshotSchema.parse({
      contract: BLENDER_LIVE_CONTRACT,
      sceneEpoch,
      revision: 4,
      sceneName: "Scene",
      frame: 1,
      unit: "meter",
      coordinateSystem: "right-handed-y-up-negative-z-forward",
      objects: [],
      cameras: [],
    });
    expect(parsed.revision).toBe(4);
    expect(parsed.lights).toEqual([]);
    expect(parsed.selectedObjectIds).toEqual([]);
  });

  it("models native Blender lights, Boolean openings, and collections", () => {
    const parsed = blenderLiveCommandBatchSchema.parse({
      requestId: "63a521f0-7fe3-4fd7-8e06-8457e806c6b3",
      expectedSceneEpoch: sceneEpoch,
      operations: [
        { op: "create_light", id: "light-a", position: [4, 6, 4] },
        {
          op: "set_light_data",
          id: "light-a",
          kind: "spot",
          color: [0.8, 0.6, 0.4],
          energy: 1_500,
          size: 0.25,
        },
        {
          op: "create_opening",
          id: "opening-a",
          targetId: "wall-a",
          kind: "window",
        },
        {
          op: "move_to_collection",
          ids: ["opening-a"],
          collection: "Architecture",
        },
      ],
    });
    expect(parsed.operations).toMatchObject([
      { op: "create_light", kind: "area", energy: 1_000 },
      { op: "set_light_data", kind: "spot", energy: 1_500, size: 0.25 },
      { op: "create_opening", kind: "window", width: 0.9, height: 2.1 },
      { op: "move_to_collection", collection: "Architecture" },
    ]);
  });

  it("validates complete native camera data before applying it", () => {
    const operation = {
      op: "set_camera_data" as const,
      id: "camera-a",
      projectionType: "ORTHOGRAPHIC" as const,
      focalLengthMm: 50,
      sensorFit: "HORIZONTAL" as const,
      sensorWidthMm: 36,
      sensorHeightMm: 24,
      shiftX: 0.1,
      shiftY: -0.05,
      clipStart: 0.1,
      clipEnd: 2_000,
      orthographicScale: 12,
    };
    expect(
      blenderLiveCommandBatchSchema.parse({
        requestId: "73a521f0-7fe3-4fd7-8e06-8457e806c6b4",
        expectedSceneEpoch: sceneEpoch,
        operations: [operation],
      }).operations[0],
    ).toEqual(operation);
    expect(() =>
      blenderLiveCommandBatchSchema.parse({
        requestId: "83a521f0-7fe3-4fd7-8e06-8457e806c6b4",
        expectedSceneEpoch: sceneEpoch,
        operations: [{ ...operation, clipEnd: 0.05 }],
      }),
    ).toThrow(/clipEnd/);
  });

  it("models native hierarchy and constraints without losing local transforms", () => {
    const batch = blenderLiveCommandBatchSchema.parse({
      requestId: "63a521f0-7fe3-4fd7-8e06-8457e806c6b3",
      expectedSceneEpoch: sceneEpoch,
      operations: [
        {
          op: "set_parent",
          id: "chair-a",
          parentId: "room-a",
          keepWorldTransform: true,
        },
        {
          op: "add_constraint",
          id: "camera-a",
          targetId: "actor-a",
          kind: "track_to",
          influence: 0.8,
        },
        {
          op: "remove_constraint",
          id: "camera-a",
          constraintName: "WorldEngine Track To",
        },
      ],
    });
    expect(batch.operations).toMatchObject([
      { op: "set_parent", keepWorldTransform: true },
      { op: "add_constraint", kind: "track_to", influence: 0.8 },
      { op: "remove_constraint", constraintName: "WorldEngine Track To" },
    ]);

    const snapshot = blenderLiveSceneSnapshotSchema.parse({
      contract: BLENDER_LIVE_CONTRACT,
      sceneEpoch,
      revision: 5,
      sceneName: "Scene",
      frame: 1,
      unit: "meter",
      coordinateSystem: "right-handed-y-up-negative-z-forward",
      objects: [
        {
          id: "chair-a",
          directorId: "director-chair-a",
          name: "Chair",
          type: "MESH",
          kind: "prop",
          position: [4, 0, 2],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
          localTransform: {
            position: [1, 0, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
          },
          dimensions: [1, 1, 1],
          localBounds: { min: [-0.5, 0, -0.25], max: [0.5, 1.2, 0.25] },
          visible: true,
          collections: ["Set"],
          parentId: "room-a",
          modifierCount: 0,
          constraints: [
            {
              name: "WorldEngine Copy Rotation",
              kind: "copy_rotation",
              targetId: "room-a",
              influence: 0.75,
              enabled: true,
            },
          ],
        },
      ],
      cameras: [],
    });
    expect(snapshot.objects[0]).toMatchObject({
      directorId: "director-chair-a",
      parentId: "room-a",
      position: [4, 0, 2],
      localTransform: { position: [1, 0, 0] },
      localBounds: { min: [-0.5, 0, -0.25], max: [0.5, 1.2, 0.25] },
      constraints: [{ targetId: "room-a", kind: "copy_rotation" }],
    });
  });

  it("preserves the authoritative Blender camera projection and filmback", () => {
    const snapshot = blenderLiveSceneSnapshotSchema.parse({
      contract: BLENDER_LIVE_CONTRACT,
      sceneEpoch,
      revision: 6,
      sceneName: "Scene",
      frame: 1,
      unit: "meter",
      coordinateSystem: "right-handed-y-up-negative-z-forward",
      objects: [],
      cameras: [
        {
          id: "camera-a",
          name: "Camera",
          position: [1, 2, 3],
          rotation: [0.1, 0.2, 0.3],
          projectionType: "ORTHOGRAPHIC",
          focalLengthMm: 52,
          sensorFit: "VERTICAL",
          sensorWidthMm: 36,
          sensorHeightMm: 24,
          shiftX: 0.12,
          shiftY: -0.08,
          clipStart: 0.05,
          clipEnd: 750,
          orthographicScale: 6,
          active: true,
        },
      ],
    });

    expect(snapshot.cameras[0]).toEqual({
      id: "camera-a",
      name: "Camera",
      position: [1, 2, 3],
      rotation: [0.1, 0.2, 0.3],
      projectionType: "ORTHOGRAPHIC",
      focalLengthMm: 52,
      sensorFit: "VERTICAL",
      sensorWidthMm: 36,
      sensorHeightMm: 24,
      shiftX: 0.12,
      shiftY: -0.08,
      clipStart: 0.05,
      clipEnd: 750,
      orthographicScale: 6,
      active: true,
    });
  });

  it("models the Blender operator, mesh selection, RNA, history, and capture surface", () => {
    const batch = blenderLiveCommandBatchSchema.parse({
      requestId: "63a521f0-7fe3-4fd7-8e06-8457e806c6b3",
      expectedSceneEpoch: sceneEpoch,
      operations: [
        { op: "discover_operators", query: "bevel" },
        { op: "describe_operator", operator: "mesh.bevel" },
        { op: "inspect_object", id: "wall-a" },
        { op: "set_selection", selectedIds: ["wall-a"], activeId: "wall-a" },
        {
          op: "select_mesh_elements",
          id: "wall-a",
          indices: [0, 2],
          action: "SUBTRACT",
        },
        {
          op: "assign_material",
          id: "wall-a",
          materialName: "Blockout Clay",
          parameters: {
            baseColor: [0.42, 0.5, 0.62],
            roughness: 0.72,
            metallic: 0.08,
            alpha: 0.9,
          },
        },
        {
          op: "project_uv",
          id: "wall-a",
          method: "CUBE",
          uvLayerName: "BlockoutUV",
        },
        {
          op: "create_material_node",
          id: "wall-a",
          materialName: "Blockout Clay",
          nodeRef: "mix-color",
          nodeType: "MIX_COLOR",
          location: [-240, 80],
          label: "Wall tint",
        },
        {
          op: "set_material_node_input",
          id: "wall-a",
          materialName: "Blockout Clay",
          nodeRef: "mix-color",
          inputSocketRef: "Color1",
          value: [0.2, 0.3, 0.4, 1],
        },
        {
          op: "connect_material_nodes",
          id: "wall-a",
          materialName: "Blockout Clay",
          from: { nodeRef: "principled", socketRef: "BSDF" },
          to: { nodeRef: "material-output", socketRef: "Surface" },
        },
        {
          op: "disconnect_material_node_input",
          id: "wall-a",
          materialName: "Blockout Clay",
          nodeRef: "material-output",
          inputSocketRef: "Surface",
        },
        {
          op: "delete_material_node",
          id: "wall-a",
          materialName: "Blockout Clay",
          nodeRef: "mix-color",
        },
        {
          op: "invoke_operator",
          operator: "mesh.bevel",
          properties: { offset: 0.1, segments: 3 },
          context: {
            selectedIds: ["wall-a"],
            activeId: "wall-a",
            mode: "EDIT",
          },
        },
        {
          op: "set_rna_property",
          target: { kind: "modifier", objectId: "wall-a", name: "Bevel" },
          path: ["width"],
          value: 0.25,
        },
        {
          op: "execute_code",
          code: "import bpy\nprint(len(bpy.data.objects))\n",
        },
        { op: "undo_scene" },
        { op: "redo_scene" },
        { op: "capture_render", cameraId: "camera-a" },
      ],
    });

    expect(batch.operations).toMatchObject([
      {
        op: "discover_operators",
        scope: "modeling",
        availableOnly: false,
        limit: 80,
      },
      { op: "describe_operator", operator: "mesh.bevel" },
      { op: "inspect_object", id: "wall-a" },
      { op: "set_selection", mode: "OBJECT" },
      { op: "select_mesh_elements", domain: "FACE", action: "SUBTRACT" },
      {
        op: "assign_material",
        createIfMissing: true,
        faceScope: "ALL",
        parameters: {
          baseColor: [0.42, 0.5, 0.62],
          roughness: 0.72,
          metallic: 0.08,
          alpha: 0.9,
        },
      },
      {
        op: "project_uv",
        method: "CUBE",
        uvLayerName: "BlockoutUV",
        replaceExisting: false,
      },
      {
        op: "create_material_node",
        nodeType: "MIX_COLOR",
        location: [-240, 80],
      },
      {
        op: "set_material_node_input",
        inputSocketRef: "Color1",
        value: [0.2, 0.3, 0.4, 1],
      },
      {
        op: "connect_material_nodes",
        from: { nodeRef: "principled", socketRef: "BSDF" },
      },
      { op: "disconnect_material_node_input", inputSocketRef: "Surface" },
      { op: "delete_material_node", nodeRef: "mix-color" },
      { op: "invoke_operator", properties: { offset: 0.1, segments: 3 } },
      { op: "set_rna_property", path: ["width"] },
      { op: "execute_code", code: "import bpy\nprint(len(bpy.data.objects))\n" },
      { op: "undo_scene" },
      { op: "redo_scene" },
      { op: "capture_render", width: 640, height: 360, transparent: false },
    ]);

    expect(() =>
      blenderLiveCommandBatchSchema.parse({
        requestId: "63a521f0-7fe3-4fd7-8e06-8457e806c6b3",
        expectedSceneEpoch: sceneEpoch,
        operations: [
          {
            op: "assign_material",
            id: "wall-a",
            materialName: "Invalid",
            parameters: { baseColor: [1, 1, 1, 1] },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      blenderLiveCommandBatchSchema.parse({
        requestId: "63a521f0-7fe3-4fd7-8e06-8457e806c6b3",
        expectedSceneEpoch: sceneEpoch,
        operations: [
          {
            op: "create_material_node",
            id: "wall-a",
            materialName: "Blockout Clay",
            nodeRef: "script",
            nodeType: "SCRIPT",
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      blenderLiveCommandBatchSchema.parse({
        requestId: "63a521f0-7fe3-4fd7-8e06-8457e806c6b3",
        expectedSceneEpoch: sceneEpoch,
        operations: [
          {
            op: "set_material_node_input",
            id: "wall-a",
            materialName: "Blockout Clay",
            nodeRef: "principled",
            inputSocketRef: "Base Color",
            value: "not-a-socket-value",
          },
        ],
      }),
    ).toThrow();
  });

  it("models typed Curve, Text, Geometry Nodes, and procedural texture operations", () => {
    const batch = blenderLiveCommandBatchSchema.parse({
      requestId: "63a521f0-7fe3-4fd7-8e06-8457e806c6b3",
      expectedSceneEpoch: sceneEpoch,
      operations: [
        {
          op: "create_curve",
          id: "path-a",
          points: [
            [0, 0, 0],
            [2, 0, -1],
          ],
        },
        {
          op: "set_curve_data",
          id: "path-a",
          points: [
            [0, 0, 0],
            [3, 1, -2],
          ],
          cyclic: true,
          bevelDepth: 0.08,
        },
        { op: "create_text", id: "title-a", text: "Warehouse" },
        {
          op: "set_text_data",
          id: "title-a",
          text: "Warehouse 12",
          alignX: "CENTER",
          extrude: 0.04,
        },
        { op: "ensure_geometry_nodes", id: "path-a" },
        {
          op: "create_geometry_node",
          id: "path-a",
          modifierName: "WorldEngine Geometry",
          nodeRef: "transform",
          nodeType: "TRANSFORM_GEOMETRY",
        },
        {
          op: "set_geometry_node_input",
          id: "path-a",
          modifierName: "WorldEngine Geometry",
          nodeRef: "transform",
          inputSocketRef: "Translation",
          value: [0, 0, 1],
        },
        {
          op: "connect_geometry_nodes",
          id: "path-a",
          modifierName: "WorldEngine Geometry",
          from: { nodeRef: "group-input", socketRef: "Socket_0" },
          to: { nodeRef: "transform", socketRef: "Geometry" },
        },
        {
          op: "disconnect_geometry_node_input",
          id: "path-a",
          modifierName: "WorldEngine Geometry",
          nodeRef: "group-output",
          inputSocketRef: "Socket_1",
        },
        {
          op: "delete_geometry_node",
          id: "path-a",
          modifierName: "WorldEngine Geometry",
          nodeRef: "transform",
        },
        {
          op: "create_material_node",
          id: "path-a",
          materialName: "Clay",
          nodeRef: "noise",
          nodeType: "NOISE_TEXTURE",
        },
      ],
    });

    expect(batch.operations).toMatchObject([
      { op: "create_curve", curveType: "POLY", cyclic: false, bevelDepth: 0 },
      { op: "set_curve_data", cyclic: true, bevelDepth: 0.08 },
      { op: "create_text", size: 1, extrude: 0, alignX: "LEFT" },
      { op: "set_text_data", text: "Warehouse 12", alignX: "CENTER" },
      { op: "ensure_geometry_nodes", modifierName: "WorldEngine Geometry" },
      { op: "create_geometry_node", nodeType: "TRANSFORM_GEOMETRY" },
      { op: "set_geometry_node_input", inputSocketRef: "Translation" },
      { op: "connect_geometry_nodes", from: { nodeRef: "group-input" } },
      { op: "disconnect_geometry_node_input", inputSocketRef: "Socket_1" },
      { op: "delete_geometry_node", nodeRef: "transform" },
      { op: "create_material_node", nodeType: "NOISE_TEXTURE" },
    ]);

    const inspection = blenderObjectInspectionSchema.parse({
      id: "path-a",
      name: "Path",
      type: "CURVE",
      mode: "OBJECT",
      dimensions: [4, 1, 2],
      evaluatedBounds: { min: [0, 0, -2], max: [4, 1, 0], center: [2, 0.5, -1], size: [4, 1, 2] },
      selection: { selected: true, active: true },
      curve: {
        bevelDepth: 0.08,
        bevelResolution: 0,
        splines: [
          {
            type: "POLY",
            cyclic: false,
            points: [
              [0, 0, 0],
              [4, 1, -2],
            ],
          },
        ],
      },
      geometryGraphs: [
        {
          objectId: "path-a",
          modifierName: "WorldEngine Geometry",
          nodeGroupName: "Path Geometry",
          nodes: [
            {
              nodeRef: "transform",
              name: "transform",
              label: "",
              nodeType: "TRANSFORM_GEOMETRY",
              blenderType: "GeometryNodeTransform",
              location: [0, 0],
              inputs: [],
              outputs: [],
            },
          ],
          links: [],
        },
      ],
      animation: {
        action: null,
        activeAction: null,
        actions: [],
        fCurveCount: 0,
        keyframeCount: 0,
        driverCount: 0,
        nlaTrackCount: 1,
        nlaStripCount: 1,
      },
      warnings: [],
    });
    expect(inspection).toMatchObject({
      curve: { bevelDepth: 0.08 },
      geometryGraphs: [{ modifierName: "WorldEngine Geometry" }],
    });
  });

  it("exposes compact read-only Agent entry points and bounds clean captures", () => {
    expect(
      blenderNativeToolRequestSchema.parse({
        op: "catalog",
        query: "extrude",
      }),
    ).toMatchObject({
      op: "catalog",
      scope: "modeling",
      availableOnly: false,
      limit: 80,
    });
    expect(
      blenderNativeToolRequestSchema.parse({
        op: "describe",
        operator: "mesh.extrude_region_move",
      }),
    ).toEqual({ op: "describe", operator: "mesh.extrude_region_move" });
    expect(
      blenderNativeToolRequestSchema.parse({
        op: "describe",
        target: "create_primitive",
      }),
    ).toEqual({ op: "describe", target: "create_primitive" });
    expect(() => blenderNativeToolRequestSchema.parse({ op: "describe" })).toThrow(/exactly one of operator/);
    expect(() =>
      blenderNativeToolRequestSchema.parse({
        op: "describe",
        operator: "mesh.bevel",
        target: "create_primitive",
      }),
    ).toThrow(/exactly one of operator/);
    expect(
      blenderNativeToolRequestSchema.parse({
        op: "inspect",
        id: "mesh-a",
        expectedSceneEpoch: sceneEpoch,
        expectedRevision: 3,
      }),
    ).toEqual({
      op: "inspect",
      id: "mesh-a",
      expectedSceneEpoch: sceneEpoch,
      expectedRevision: 3,
    });
    expect(blenderNativeToolRequestSchema.parse({ op: "inspect", id: "mesh-a" })).toEqual({
      op: "inspect",
      id: "mesh-a",
    });
    expect(blenderNativeToolRequestSchema.parse({ op: "capture" })).toEqual({
      op: "capture",
      width: 640,
      height: 360,
      transparent: false,
    });
    expect(
      blenderNativeToolRequestSchema.parse({
        op: "capture_render",
        cameraId: "camera_front",
        width: 1280,
        height: 720,
      }),
    ).toEqual({
      op: "capture_render",
      cameraId: "camera_front",
      width: 1280,
      height: 720,
      transparent: false,
    });
    expect(blenderNativeReadOperationNames).toEqual([
      "status",
      "scene",
      "catalog",
      "describe",
      "inspect",
      "capture",
      "capture_render",
      "query",
      "polyhaven_search",
      "sketchfab_search",
    ]);
    expect(blenderLiveReadOperationNames).toContain("export_scene_preview");
    expect(blenderLiveReadOperationNames).toEqual(
      expect.arrayContaining(["polyhaven_search", "sketchfab_search"]),
    );
    expect(() =>
      blenderNativeToolRequestSchema.parse({
        op: "capture",
        width: 4_096,
        height: 360,
      }),
    ).toThrow();
    expect(
      blenderNativeToolRequestSchema.parse({
        op: "apply",
        operations: [{ op: "create_primitive", id: "cube-a", primitive: "cube" }],
      }),
    ).toMatchObject({ op: "apply", operations: [{ op: "create_primitive", id: "cube-a" }] });
    expect(
      blenderNativeToolRequestSchema.parse({
        op: "apply",
        expectedSceneEpoch: sceneEpoch,
        expectedRevision: 3,
        intentId: "b4b2ed3d-b25b-4ad0-8db9-f04bcb229fb6",
        operations: [{ op: "create_primitive", id: "cube-a", primitive: "cube" }],
      }),
    ).toMatchObject({
      expectedSceneEpoch: sceneEpoch,
      expectedRevision: 3,
      intentId: "b4b2ed3d-b25b-4ad0-8db9-f04bcb229fb6",
    });
    expect(
      blenderNativeToolRequestSchema.parse({
        op: "apply",
        operations: [{ op: "execute_code", code: "import bpy\nbpy.ops.mesh.primitive_cube_add()\n" }],
      }),
    ).toMatchObject({
      op: "apply",
      operations: [{ op: "execute_code", code: "import bpy\nbpy.ops.mesh.primitive_cube_add()\n" }],
    });
    expect(() =>
      blenderLiveCommandBatchSchema.parse({
        requestId: "63a521f0-7fe3-4fd7-8e06-8457e806c6b3",
        operations: [{ op: "execute_code", code: "print(1)" }],
      }),
    ).toThrow(/expectedSceneEpoch/);
    expect(
      blenderLiveCommandBatchSchema.parse({
        requestId: "73a521f0-7fe3-4fd7-8e06-8457e806c6b4",
        operations: [{ op: "polyhaven_search", query: "chair", assetType: "models" }],
      }).operations[0],
    ).toMatchObject({ op: "polyhaven_search", query: "chair", limit: 20 });
    expect(
      blenderNativeToolRequestSchema.parse({
        op: "polyhaven_search",
        query: "studio",
        assetType: "hdris",
      }),
    ).toMatchObject({ op: "polyhaven_search", assetType: "hdris", query: "studio", limit: 20 });
    const applied = blenderNativeToolRequestSchema.parse({
      op: "apply",
      operations: [
        { op: "polyhaven_import", assetId: "modern_chair", assetType: "models" },
        { op: "sketchfab_import", uid: "abcdef12ghijkl34mnop56qrstuv78wx" },
      ],
    });
    expect(applied.op).toBe("apply");
    if (applied.op !== "apply") return;
    expect(applied.operations).toMatchObject([
      { op: "polyhaven_import", resolution: "1k" },
      { op: "sketchfab_import", targetSizeM: 1 },
    ]);
  });

  it("models a native GLB scene preview without weakening the live operation contract", () => {
    expect(
      blenderLiveCommandBatchSchema.parse({
        requestId: "63a521f0-7fe3-4fd7-8e06-8457e806c6b3",
        operations: [{ op: "export_scene_preview" }],
      }).operations,
    ).toEqual([{ op: "export_scene_preview" }]);

    expect(
      blenderScenePreviewSchema.parse({
        contract: BLENDER_LIVE_CONTRACT,
        sceneEpoch,
        revision: 8,
        mimeType: "model/gltf-binary",
        dataBase64: "Z2xURg==",
        byteLength: 4,
      }),
    ).toMatchObject({
      sceneEpoch,
      revision: 8,
      mimeType: "model/gltf-binary",
      byteLength: 4,
    });
    // Job records polled without consume carry detached metadata only.
    expect(
      blenderScenePreviewSchema.parse({
        contract: BLENDER_LIVE_CONTRACT,
        sceneEpoch,
        revision: 8,
        mimeType: "model/gltf-binary",
        byteLength: 4,
      }).dataBase64,
    ).toBeUndefined();
    expect(() =>
      blenderNativeToolRequestSchema.parse({
        op: "apply",
        expectedSceneEpoch: sceneEpoch,
        expectedRevision: 8,
        operations: [{ op: "export_scene_preview" }],
      }),
    ).toThrow();
  });

  it("models typed native pose, action, and frame operations", () => {
    const batch = blenderLiveCommandBatchSchema.parse({
      requestId: "63a521f0-7fe3-4fd7-8e06-8457e806c6b3",
      expectedSceneEpoch: sceneEpoch,
      expectedRevision: 9,
      operations: [
        {
          op: "select_pose_bones",
          id: "rig-a",
          boneRefs: ["hips", "spine"],
          activeBoneRef: "hips",
        },
        {
          op: "set_pose_bone_transform",
          id: "rig-a",
          boneRef: "hips",
          local: {
            location: [0, 0.1, 0],
            rotationQuaternion: [1, 0, 0, 0],
          },
        },
        {
          op: "apply_pose_offsets",
          id: "rig-a",
          stateToken: "director-state-1",
          bones: [{ boneRef: "Head", rotationOffsetQuaternion: [1, 0, 0, 0] }],
        },
        { op: "create_action", id: "rig-a", actionName: "Confrontation" },
        { op: "set_active_action", id: "rig-a", actionName: "Confrontation" },
        { op: "set_scene_frame", frame: 24 },
        {
          op: "insert_pose_keyframes",
          id: "rig-a",
          actionName: "Confrontation",
          frame: 24,
          boneRefs: ["hips", "spine"],
          channels: ["LOCATION", "ROTATION"],
        },
        {
          op: "delete_pose_keyframes",
          id: "rig-a",
          actionName: "Confrontation",
          frame: 12,
          boneRefs: ["hips"],
          channels: ["ROTATION"],
        },
        {
          op: "import_mixamo_action",
          id: "rig-a",
          motionId: "walk",
        },
        { op: "create_nla_track", id: "rig-a", trackName: "Locomotion" },
        {
          op: "add_nla_strip",
          id: "rig-a",
          trackName: "Locomotion",
          stripName: "Walk Base",
          actionName: "Mixamo Walk Forward",
          startFrame: 1,
        },
        {
          op: "update_nla_strip",
          id: "rig-a",
          trackName: "Locomotion",
          stripName: "Walk Base",
          blendMode: "ADD",
          influence: 0.5,
        },
        {
          op: "remove_nla_strip",
          id: "rig-a",
          trackName: "Locomotion",
          stripName: "Walk Base",
        },
      ],
    });

    expect(batch.operations).toMatchObject([
      { op: "select_pose_bones", action: "SET" },
      { op: "set_pose_bone_transform", boneRef: "hips" },
      { op: "apply_pose_offsets", stateToken: "director-state-1", resetPose: false },
      { op: "create_action", actionName: "Confrontation" },
      { op: "set_active_action", actionName: "Confrontation" },
      { op: "set_scene_frame", frame: 24 },
      { op: "insert_pose_keyframes", interpolation: "BEZIER" },
      { op: "delete_pose_keyframes", channels: ["ROTATION"] },
      { op: "import_mixamo_action", motionId: "walk", rootMotion: "IN_PLACE", replaceExisting: false },
      { op: "create_nla_track", trackName: "Locomotion" },
      { op: "add_nla_strip", blendMode: "REPLACE", influence: 1, repeat: 1, scale: 1 },
      { op: "update_nla_strip", blendMode: "ADD", influence: 0.5 },
      { op: "remove_nla_strip", stripName: "Walk Base" },
    ]);
    expect(() =>
      blenderLiveCommandBatchSchema.parse({
        requestId: "63a521f0-7fe3-4fd7-8e06-8457e806c6b3",
        expectedSceneEpoch: sceneEpoch,
        operations: [
          {
            op: "set_pose_bone_transform",
            id: "rig-a",
            boneRef: "hips",
            local: {},
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      blenderLiveCommandBatchSchema.parse({
        requestId: "63a521f0-7fe3-4fd7-8e06-8457e806c6b3",
        expectedSceneEpoch: sceneEpoch,
        operations: [
          {
            op: "insert_pose_keyframes",
            id: "rig-a",
            actionName: "Confrontation",
            frame: 1,
            boneRefs: ["hips"],
            channels: ["CUSTOM"],
          },
        ],
      }),
    ).toThrow();

    const inspection = blenderObjectInspectionSchema.parse({
      id: "rig-a",
      name: "Rig A",
      type: "ARMATURE",
      mode: "POSE",
      dimensions: [1, 2, 1],
      evaluatedBounds: {
        min: [-0.5, 0, -0.5],
        max: [0.5, 2, 0.5],
        center: [0, 1, 0],
        size: [1, 2, 1],
      },
      selection: { selected: true, active: true },
      rig: {
        boneCount: 2,
        poseBoneCount: 2,
        deformBoneCount: 2,
        constraintCount: 0,
        activeBoneRef: "hips",
        selectedBoneRefs: ["hips"],
        bones: [
          {
            boneRef: "hips",
            parentRef: null,
            deform: true,
            selected: true,
            local: {
              location: [0, 0.1, 0],
              rotationQuaternion: [1, 0, 0, 0],
              scale: [1, 1, 1],
            },
            restLocal: {
              location: [0, 0, 0],
              rotationQuaternion: [1, 0, 0, 0],
              scale: [1, 1, 1],
            },
          },
        ],
        mixamoCompatibility: {
          compatible: true,
          missingBoneRoles: [],
          mappedBoneCount: 65,
        },
      },
      animation: {
        action: "Confrontation",
        activeAction: {
          actionName: "Confrontation",
          active: true,
          frameRange: [1, 24],
          fCurveCount: 7,
          keyframeCount: 14,
          keyedFrames: [1, 24],
        },
        actions: [
          {
            actionName: "Confrontation",
            active: true,
            frameRange: [1, 24],
            fCurveCount: 7,
            keyframeCount: 14,
            keyedFrames: [1, 24],
          },
        ],
        fCurveCount: 7,
        keyframeCount: 14,
        driverCount: 0,
        nlaTrackCount: 0,
        nlaStripCount: 0,
        nlaTracks: [
          {
            name: "Locomotion",
            mute: false,
            solo: false,
            strips: [
              {
                name: "Walk Base",
                actionName: "Mixamo Walk Forward",
                frameStart: 1,
                frameEnd: 34,
                actionFrameStart: 1,
                actionFrameEnd: 34,
                blendMode: "REPLACE",
                influence: 1,
                repeat: 1,
                scale: 1,
              },
            ],
          },
        ],
      },
      warnings: [],
    });
    expect(inspection.rig?.bones[0]).toMatchObject({
      boneRef: "hips",
      parentRef: null,
    });
    expect(inspection.animation.activeAction?.keyedFrames).toEqual([1, 24]);
    expect(inspection.rig?.mixamoCompatibility?.compatible).toBe(true);
    expect(inspection.animation.nlaTracks[0]?.strips[0]?.actionName).toBe("Mixamo Walk Forward");
  });

  it("models compact inspection evidence and a typed native effect receipt", () => {
    const inspection = blenderObjectInspectionSchema.parse({
      id: "mesh-a",
      name: "Mesh A",
      type: "MESH",
      mode: "OBJECT",
      dimensions: [2, 1, 3],
      evaluatedBounds: {
        min: [-1, 0, -1.5],
        max: [1, 1, 1.5],
        center: [0, 0.5, 0],
        size: [2, 1, 3],
      },
      selection: { selected: true, active: true },
      mesh: {
        vertices: 8,
        edges: 12,
        faces: 6,
        triangles: 12,
        looseVertices: 0,
        boundaryEdges: 0,
        nonManifoldEdges: 0,
        materialSlots: 1,
        uvLayers: ["UVMap"],
        uvLayerDetails: [
          {
            name: "UVMap",
            active: true,
            activeRender: true,
            loopCount: 24,
            coordinateBounds: { min: [0, 0], max: [1, 1] },
          },
        ],
        colorAttributes: [],
        shapeKeys: [],
      },
      materialNodes: [
        {
          material: "Clay",
          useNodes: true,
          nodeCount: 2,
          linkCount: 1,
          nodeTypes: { BSDF_PRINCIPLED: 1, OUTPUT_MATERIAL: 1 },
          principled: {
            baseColor: [0.42, 0.5, 0.62],
            roughness: 0.72,
            metallic: 0.08,
            alpha: 0.9,
          },
        },
      ],
      materialGraphs: [
        {
          materialName: "Clay",
          objectIds: ["mesh-a"],
          activeOutputNodeRef: "material-output",
          nodes: [
            {
              nodeRef: "principled",
              name: "principled",
              label: "",
              nodeType: "PRINCIPLED_BSDF",
              blenderType: "ShaderNodeBsdfPrincipled",
              activeOutput: false,
              location: [0, 0],
              inputs: [
                {
                  socketRef: "Base Color",
                  name: "Base Color",
                  type: "RGBA",
                  linked: false,
                  enabled: true,
                  multiInput: false,
                  defaultValue: [0.42, 0.5, 0.62, 1],
                },
              ],
              outputs: [
                {
                  socketRef: "BSDF",
                  name: "BSDF",
                  type: "SHADER",
                  linked: true,
                  enabled: true,
                  multiInput: false,
                },
              ],
            },
            {
              nodeRef: "material-output",
              name: "material-output",
              label: "",
              nodeType: "MATERIAL_OUTPUT",
              blenderType: "ShaderNodeOutputMaterial",
              activeOutput: true,
              location: [300, 0],
              inputs: [
                {
                  socketRef: "Surface",
                  name: "Surface",
                  type: "SHADER",
                  linked: true,
                  enabled: true,
                  multiInput: false,
                },
              ],
              outputs: [],
            },
          ],
          links: [
            {
              from: { nodeRef: "principled", socketRef: "BSDF" },
              to: { nodeRef: "material-output", socketRef: "Surface" },
            },
          ],
        },
      ],
      animation: {
        action: null,
        fCurveCount: 0,
        keyframeCount: 0,
        driverCount: 0,
        nlaTrackCount: 0,
        nlaStripCount: 0,
      },
      warnings: [],
    });
    expect(inspection.mesh).toMatchObject({
      triangles: 12,
      nonManifoldEdges: 0,
      uvLayerDetails: [{ name: "UVMap", active: true, loopCount: 24 }],
    });
    expect(inspection.materialNodes[0]?.principled).toMatchObject({
      baseColor: [0.42, 0.5, 0.62],
      alpha: 0.9,
    });
    expect(inspection.materialGraphs[0]).toMatchObject({
      activeOutputNodeRef: "material-output",
      links: [
        {
          from: { nodeRef: "principled", socketRef: "BSDF" },
          to: { nodeRef: "material-output", socketRef: "Surface" },
        },
      ],
    });
    expect(inspection.animation).toMatchObject({
      activeAction: null,
      actions: [],
    });

    const receipt = blenderEffectReceiptSchema.parse({
      contract: BLENDER_LIVE_CONTRACT,
      sceneEpoch,
      requestId: "b4b2ed3d-b25b-4ad0-8db9-f04bcb229fb6",
      revisionBefore: 3,
      revisionAfter: 4,
      createdObjectIds: ["mesh-a"],
      changedObjectIds: [],
      deletedObjectIds: [],
      dirtyObjectIds: ["mesh-a"],
      selection: {
        mode: "OBJECT",
        activeObjectId: "mesh-a",
        selectedObjectIds: ["mesh-a"],
      },
      metrics: {
        before: { entities: 0, objects: 0, cameras: 0, lights: 0 },
        after: { entities: 1, objects: 1, cameras: 0, lights: 0 },
      },
      operations: [
        {
          index: 0,
          op: "create_primitive",
          createdObjectIds: ["mesh-a"],
          changedObjectIds: [],
          deletedObjectIds: [],
          dirtyObjectIds: ["mesh-a"],
          mode: "OBJECT",
          activeObjectId: "mesh-a",
          selectedObjectIds: ["mesh-a"],
          metrics: { created: 1, changed: 0, deleted: 0, dirty: 1 },
          warnings: [],
        },
      ],
      warnings: [],
    });
    expect(receipt).toMatchObject({
      sceneEpoch,
      revisionBefore: 3,
      revisionAfter: 4,
      dirtyObjectIds: ["mesh-a"],
    });
  });
});
