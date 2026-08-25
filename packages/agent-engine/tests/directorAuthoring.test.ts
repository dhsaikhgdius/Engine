import { describe, expect, it } from "vitest";
import { createDefaultDirectorProject } from "../src/directorDefaultProject";
import { getCameraViewSnapshotFromShot } from "@director/project-schema";
import { getDirectorAgentCatalogAsset } from "../src/directorAgentAssetCatalog";
import { safeParseDirectorProject } from "@director/project-schema";
import { getMannequinPosePreset } from "@director/project-schema";
import { createDefaultDirectorCarProfile } from "@director/protocol/vehicleProtocol";
import { applyDirectorAuthoringActions, directorAuthoringActionSchema } from "../src/directorAuthoring";
import { observeDirectorProject } from "../src/directorWorkbenchObserve";

describe("semantic Director authoring", () => {
  it("keeps unsupported native mesh edits explicit while authoring native camera and light state", () => {
    const project = createDefaultDirectorProject();
    const nativeObject = project.objects.find((object) => object.nativeSource?.engine === "blender")!;
    nativeObject.nativeSource = { ...nativeObject.nativeSource!, provisioned: true };
    project.lights![0].nativeSource = { engine: "blender", objectId: "native-light-a", provisioned: true };
    project.cameras[0].nativeSource = { engine: "blender", objectId: "native-camera-a", provisioned: true };

    expect(() =>
      applyDirectorAuthoringActions(project, [
        { action: "update_object", object_id: nativeObject.id, patch: { material: { roughness: 0.4 } } },
      ]),
    ).toThrow(/blender_native/);
    expect(() =>
      applyDirectorAuthoringActions(project, [
        { action: "update_light", light_id: project.lights![0].id, patch: { intensity: 2 } },
      ]),
    ).not.toThrow();
    project.objects = project.objects.filter((object) => object.linkedCameraId !== project.cameras[0].id);
    const cameraUpdate = applyDirectorAuthoringActions(project, [
      { action: "update_camera", camera_id: project.cameras[0].id, patch: { focal_length_mm: 50 } },
    ]);
    expect(cameraUpdate.project.cameras[0].focalLengthMm).toBe(50);
    expect(() =>
      applyDirectorAuthoringActions(project, [
        {
          action: "update_object",
          object_id: nativeObject.id,
          patch: { transform: { position: [2, 0, -1] } },
        },
      ]),
    ).not.toThrow();
  });

  it("marks authored cameras and supported lights for Blender provisioning in a bound project", () => {
    const project = createDefaultDirectorProject();
    project.nativeScene = { engine: "blender", projectId: "project-a" };
    const result = applyDirectorAuthoringActions(project, [
      {
        action: "add_camera",
        id: "native-camera-new",
        name: "New camera",
        position: [0, 2, 8],
        target: [0, 1, 0],
      },
      {
        action: "add_light",
        light: {
          id: "native-light-new",
          name: "New light",
          type: "spot",
          color: "#ffffff",
          intensity: 2,
          position: [4, 6, 4],
          target: [0, 1, 0],
        },
      },
    ]);

    expect(result.project.cameras.find((camera) => camera.id === "native-camera-new")?.nativeSource).toEqual({
      engine: "blender",
      objectId: "native-camera-new",
      provisioned: false,
    });
    expect(result.project.lights?.find((light) => light.id === "native-light-new")?.nativeSource).toEqual({
      engine: "blender",
      objectId: "native-light-new",
      provisioned: false,
    });
  });

  it("authors and clears a reusable toggle-transform proximity interaction", () => {
    const closedTransform = { position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [2, 3, 0.2] as [number, number, number] };
    const openTransform = { position: [-1, 0, 1] as [number, number, number], rotation: [0, -Math.PI / 2, 0] as [number, number, number], scale: [2, 3, 0.2] as [number, number, number] };
    const authored = applyDirectorAuthoringActions(createDefaultDirectorProject(), [
      {
        action: "add_object",
        id: "interactive-door",
        name: "宫门",
        kind: "prop",
        geometry_type: "box",
        transform: closedTransform,
        interaction: { radius_m: 3, open_transform: openTransform },
      },
    ]);

    expect(authored.project.objects.find((object) => object.id === "interactive-door")?.interaction).toEqual({
      kind: "toggle-transform",
      prompt: "宫门",
      radiusM: 3,
      closedTransform,
      openTransform,
    });

    const cleared = applyDirectorAuthoringActions(authored.project, [
      { action: "clear_object_interaction", object_id: "interactive-door" },
    ]);
    expect(cleared.project.objects.find((object) => object.id === "interactive-door")?.interaction).toBeUndefined();
  });

  it("keeps bounded reference provenance on authored and updated objects", () => {
    const binding = {
      id: "reference-binding-1",
      kind: "image" as const,
      label: "courtyard-sketch.jpg",
      ref: "reference-image-abc123",
      showInViewport: false,
    };
    const added = applyDirectorAuthoringActions(createDefaultDirectorProject(), [
      {
        action: "add_object",
        id: "reference-block",
        name: "Reference block",
        kind: "prop",
        geometry_type: "box",
        reference_bindings: [binding],
      },
    ]);
    expect(added.project.objects.find((object) => object.id === "reference-block")?.referenceBindings).toEqual([
      binding,
    ]);

    const updated = applyDirectorAuthoringActions(added.project, [
      {
        action: "update_object",
        object_id: "reference-block",
        patch: { reference_bindings: null },
      },
    ]);
    expect(
      updated.project.objects.find((object) => object.id === "reference-block")?.referenceBindings,
    ).toBeUndefined();
  });

  it("authors a character, camera, and timeline animation in one deterministic batch", () => {
    const source = createDefaultDirectorProject();
    const result = applyDirectorAuthoringActions(source, [
      {
        action: "add_object",
        id: "agent-hero",
        name: "主角",
        kind: "character",
        color: "#d19a3a",
        transform: { position: [2, 0, 0], rotation: [0, 0.4, 0], scale: [1, 1, 1] },
      },
      {
        action: "add_camera",
        id: "agent-camera",
        object_id: "agent-camera-rig",
        name: "主角中景",
        position: [2, 1.4, 5],
        target: [2, 0.9, 0],
        target_object_id: "agent-hero",
        focal_length_mm: 50,
        aspect_ratio: "16:9",
      },
      {
        action: "set_animation",
        target_type: "object",
        target_id: "agent-hero",
        animation: {
          version: 1,
          enabled: true,
          preset: "line",
          motion: "walk",
          source: "mcp",
          keyframes: [
            { frame: 0, transform: { position: [2, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
            { frame: 48, transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
          ],
        },
      },
    ]);

    expect(source.objects.some((object) => object.id === "agent-hero")).toBe(false);
    expect(result.created).toEqual({
      asset_ids: [],
      object_ids: ["agent-hero", "agent-camera-rig"],
      camera_ids: ["agent-camera"],
      light_ids: [],
      performance_take_ids: [],
      coverage_sequence_ids: [],
      coverage_shot_ids: [],
      annotation_ids: [],
      measurement_ids: [],
      layer_ids: [],
      world_effect_ids: [],
      world_water_body_ids: [],
      world_wildlife_group_ids: [],
      world_road_ids: [],
    });
    expect(result.project.activeCameraId).toBe("agent-camera");
    expect(result.project.objects.find((object) => object.id === "agent-hero")?.animation?.motion).toBe("walk");
    const authoredCamera = result.project.cameras.find((camera) => camera.id === "agent-camera")!;
    expect(authoredCamera).toMatchObject({
      focalLengthMm: 50,
      targetObjectId: "agent-hero",
    });
    expect(getCameraViewSnapshotFromShot(authoredCamera)).toMatchObject({
      position: [2, 1.4, 5],
      target: [2, 0.9, 0],
    });
  });

  it("authors catalog-backed character motion blocks through the existing set_animation action", () => {
    const authored = applyDirectorAuthoringActions(createDefaultDirectorProject(), [
      {
        action: "set_animation",
        target_type: "object",
        target_id: "char_default_a",
        animation: {
          version: 1,
          keyframes: [],
          motionBlocks: [
            {
              id: "motion-talk",
              clipId: "talk",
              enabled: true,
              frameStart: 12,
              frameEnd: 47,
              loop: "repeat",
              speed: 1,
              weight: 1,
              blendInS: 0.12,
              blendOutS: 0.12,
              rootMotion: "in-place",
            },
          ],
        },
      },
    ]);

    expect(authored.project.objects.find((object) => object.id === "char_default_a")?.animation?.motionBlocks).toEqual([
      expect.objectContaining({ id: "motion-talk", clipId: "talk", frameStart: 12, frameEnd: 47 }),
    ]);
    expect(
      directorAuthoringActionSchema.safeParse({
        action: "set_animation",
        target_type: "object",
        target_id: "char_default_a",
        animation: {
          version: 1,
          keyframes: [],
          motionBlocks: [
            {
              id: "motion-unknown",
              clipId: "invented-motion",
              enabled: true,
              frameStart: 0,
              frameEnd: 23,
              loop: "repeat",
              speed: 1,
              weight: 1,
              blendInS: 0,
              blendOutS: 0,
              rootMotion: "in-place",
            },
          ],
        },
      }).success,
    ).toBe(false);
  });

  it("authors persistent pivots, overlays, ordered layers, focus intent, and reversible groups", () => {
    const source = createDefaultDirectorProject();
    const createdAt = "2026-08-07T00:00:00.000Z";
    const authored = applyDirectorAuthoringActions(source, [
      {
        action: "add_object",
        id: "overlay-a",
        name: "A",
        kind: "prop",
        geometry_type: "box",
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        layer: "foreground",
      },
      {
        action: "add_object",
        id: "overlay-b",
        name: "B",
        kind: "prop",
        geometry_type: "sphere",
        transform: { position: [3, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        layer: "foreground",
      },
      {
        action: "group_objects",
        group_id: "overlay-group",
        name: "Overlay group",
        object_ids: ["overlay-a", "overlay-b"],
      },
      { action: "set_object_pivot", object_id: "overlay-group", pivot: [0.5, 0, 0] },
      {
        action: "add_annotation",
        annotation: {
          id: "annotation-agent",
          text: "Keep silhouette",
          anchor: { objectId: "overlay-a", position: [0, 1, 0] },
          color: "#f6c453",
          visible: true,
          createdAt,
        },
      },
      {
        action: "add_measurement",
        measurement: {
          id: "measurement-agent",
          label: "spacing",
          start: { objectId: "overlay-a", position: [0, 0, 0] },
          end: { objectId: "overlay-b", position: [0, 0, 0] },
          color: "#6ed6ff",
          visible: true,
          createdAt,
        },
      },
      { action: "set_object_layer_state", layer_id: "foreground", visible: false, locked: true },
      { action: "reorder_object_layer", layer_id: "foreground", before_layer_id: "default" },
      { action: "focus_objects", object_ids: ["overlay-a", "overlay-b"] },
    ]);

    expect(authored.project.objects.find((object) => object.id === "overlay-group")).toMatchObject({
      isCompositeParent: true,
      pivot: [0.5, 0, 0],
      transform: { position: [1.5, 0, 0] },
    });
    expect(authored.project.objects.filter((object) => object.parentObjectId === "overlay-group")).toHaveLength(2);
    expect(authored.project.scene.annotations?.[0]?.id).toBe("annotation-agent");
    expect(authored.project.scene.measurements?.[0]?.id).toBe("measurement-agent");
    expect(authored.project.scene.objectLayers?.[0]).toMatchObject({
      id: "foreground",
      visible: false,
      locked: true,
    });
    expect(authored.created).toMatchObject({
      annotation_ids: ["annotation-agent"],
      measurement_ids: ["measurement-agent"],
      layer_ids: ["foreground"],
    });

    const cleaned = applyDirectorAuthoringActions(authored.project, [
      { action: "ungroup_objects", group_id: "overlay-group", force: true, delete_group: true },
      { action: "remove_annotations", annotation_ids: ["annotation-agent"] },
      { action: "remove_measurements", measurement_ids: ["measurement-agent"] },
    ]);
    expect(cleaned.project.objects.some((object) => object.id === "overlay-group")).toBe(false);
    expect(cleaned.project.objects.filter((object) => object.parentObjectId === "overlay-group")).toHaveLength(0);
    expect(cleaned.project.scene.annotations).toEqual([]);
    expect(cleaned.project.scene.measurements).toEqual([]);
  });

  it("never mutates the source when a later semantic action fails", () => {
    const source = createDefaultDirectorProject();
    const before = structuredClone(source);
    expect(() =>
      applyDirectorAuthoringActions(source, [
        { action: "add_object", id: "temporary", name: "临时物体", kind: "prop", geometry_type: "box" },
        { action: "add_object", id: "char_default_a", name: "冲突", kind: "character" },
      ]),
    ).toThrow(/already exists/);
    expect(source).toEqual(before);
  });

  it("executes a catalog character payload unchanged and preserves its concrete identity", () => {
    const source = createDefaultDirectorProject();
    const xBot = getDirectorAgentCatalogAsset("mixamo:x-bot")!;
    const actions = xBot.authoring.actions.map((action) => directorAuthoringActionSchema.parse(action));

    const result = applyDirectorAuthoringActions(source, actions);
    const created = result.project.objects.find((object) => object.id === xBot.authoring.object_id);

    expect(result.updated.asset_ids).toContain("mixamo:x-bot");
    expect(created).toMatchObject({
      name: "X Bot",
      kind: "character",
      characterSource: "asset",
      assetRefId: "mixamo:x-bot",
      placementMode: "grounded",
    });
  });

  it("rejects invented library identities while preserving explicit local imports", () => {
    const source = createDefaultDirectorProject();
    const xBot = getDirectorAgentCatalogAsset("mixamo:x-bot")!;
    const forgedAction = {
      action: "upsert_asset" as const,
      asset: { ...xBot.asset, url: "/mixamo-characters/models/invented-x-bot.glb" },
    };

    expect(directorAuthoringActionSchema.safeParse(forgedAction).success).toBe(false);
    expect(() => applyDirectorAuthoringActions(source, [forgedAction])).toThrow(/does not exactly match/);

    const localResult = applyDirectorAuthoringActions(source, [
      {
        action: "upsert_asset",
        asset: {
          id: "local:user-chair",
          kind: "prop",
          sourceType: "model",
          fileName: "chair.glb",
          name: "User chair",
          url: "blob:director-user-chair",
          assetSource: "local",
        },
      },
    ]);
    expect(localResult.created.asset_ids).toEqual(["local:user-chair"]);
  });

  it("allows customizing a library asset display name while locking load-bearing fields", () => {
    const source = createDefaultDirectorProject();
    const xBot = getDirectorAgentCatalogAsset("mixamo:x-bot")!;
    const renamed = { action: "upsert_asset" as const, asset: { ...xBot.asset, name: "主角" } };

    expect(directorAuthoringActionSchema.safeParse(renamed).success).toBe(true);
    const result = applyDirectorAuthoringActions(source, [renamed]);
    expect(result.project.assets.find((asset) => asset.id === "mixamo:x-bot")?.name).toBe("主角");

    const forgedFileName = {
      action: "upsert_asset" as const,
      asset: { ...xBot.asset, fileName: "invented-x-bot.glb" },
    };
    expect(() => applyDirectorAuthoringActions(source, [forgedFileName])).toThrow(/does not exactly match/);
  });

  it("rejects cross-kind asset bindings atomically", () => {
    const source = createDefaultDirectorProject();
    const before = structuredClone(source);

    expect(() =>
      applyDirectorAuthoringActions(source, [
        {
          action: "upsert_asset",
          asset: {
            id: "local:chair",
            kind: "prop",
            sourceType: "model",
            fileName: "chair.glb",
            name: "Chair",
            url: "blob:chair",
            assetSource: "local",
          },
        },
        {
          action: "add_object",
          id: "wrong-character",
          name: "Wrong character",
          kind: "character",
          character_source: "asset",
          asset_id: "local:chair",
        },
      ]),
    ).toThrow(/cannot be bound to a "character" object/);
    expect(source).toEqual(before);
  });

  it("rejects generic characters and resolves an exact catalog identity automatically", () => {
    expect(
      directorAuthoringActionSchema.safeParse({
        action: "add_object",
        id: "unbound-x-bot",
        name: "X Bot",
        kind: "character",
        character_source: "generic",
      }).success,
    ).toBe(false);

    const result = applyDirectorAuthoringActions(createDefaultDirectorProject(), [
      directorAuthoringActionSchema.parse({
        action: "add_object",
        id: "resolved-x-bot",
        name: "X Bot",
        kind: "character",
      }),
    ]);
    expect(result.project.objects.find((object) => object.id === "resolved-x-bot")).toMatchObject({
      characterSource: "asset",
      assetRefId: "mixamo:x-bot",
    });
  });

  it("persists explicit placement semantics for render preflight", () => {
    const source = createDefaultDirectorProject();
    const result = applyDirectorAuthoringActions(source, [
      {
        action: "add_object",
        id: "airborne-fx",
        name: "空中特效",
        kind: "prop",
        geometry_type: "sphere",
        placement_mode: "floating",
        transform: { position: [0, 3, 0], rotation: [0, 0, 0], scale: [0.2, 0.2, 0.2] },
      },
    ]);
    expect(result.project.objects.find((object) => object.id === "airborne-fx")?.placementMode).toBe("floating");
  });

  it("keeps physical support and semantic parent attachment as distinct authoring relationships", () => {
    const source = createDefaultDirectorProject();
    const result = applyDirectorAuthoringActions(source, [
      {
        action: "add_object",
        id: "wall-anchor",
        name: "Wall anchor",
        kind: "scene",
        geometry_type: "box",
        placement_mode: "grounded",
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [4, 3, 0.2] },
      },
      {
        action: "add_object",
        id: "table-cup",
        name: "Supported cup",
        kind: "prop",
        geometry_type: "cylinder",
        placement_mode: "supported",
        transform: { position: [0, 0.8, 1], rotation: [0, 0, 0], scale: [0.1, 0.18, 0.1] },
      },
      {
        action: "add_object",
        id: "wall-lamp",
        name: "Attached wall lamp",
        kind: "prop",
        geometry_type: "box",
        placement_mode: "attached",
        parent_id: "wall-anchor",
        transform: { position: [0, 1.8, 0.2], rotation: [0, 0, 0], scale: [0.3, 0.4, 0.2] },
      },
      {
        action: "add_object",
        id: "ceiling-beam",
        name: "Attached ceiling beam",
        kind: "scene",
        geometry_type: "box",
        placement_mode: "attached",
        parent_id: "wall-anchor",
        transform: { position: [0, 3, 0], rotation: [0, 0, 0], scale: [3, 0.2, 0.3] },
      },
      {
        action: "add_object",
        id: "chandelier",
        name: "Suspended chandelier",
        kind: "prop",
        geometry_type: "sphere",
        placement_mode: "suspended",
        parent_id: "ceiling-beam",
        transform: { position: [0, 2.1, 0], rotation: [0, 0, 0], scale: [0.4, 0.4, 0.4] },
      },
    ]);

    const supported = result.project.objects.find((object) => object.id === "table-cup");
    expect(supported).toMatchObject({ placementMode: "supported" });
    expect(supported?.parentObjectId).toBeUndefined();
    expect(result.project.objects.find((object) => object.id === "wall-lamp")).toMatchObject({
      placementMode: "attached",
      parentObjectId: "wall-anchor",
    });
    expect(result.project.objects.find((object) => object.id === "chandelier")).toMatchObject({
      placementMode: "suspended",
      parentObjectId: "ceiling-beam",
    });
  });

  it("rejects indirect object parent cycles atomically", () => {
    const source = createDefaultDirectorProject();
    const before = structuredClone(source);
    expect(() =>
      applyDirectorAuthoringActions(source, [
        { action: "add_object", id: "parent-a", name: "Parent A", kind: "prop", geometry_type: "box" },
        {
          action: "add_object",
          id: "parent-b",
          name: "Parent B",
          kind: "prop",
          geometry_type: "box",
          parent_id: "parent-a",
        },
        { action: "update_object", object_id: "parent-a", patch: { parent_id: "parent-b" } },
      ]),
    ).toThrow(/parent cycle/);
    expect(source).toEqual(before);
  });

  it("treats human-locked objects as write protected until explicitly unlocked", () => {
    const source = createDefaultDirectorProject();
    const character = source.objects.find((object) => object.kind === "character")!;
    character.locked = true;

    expect(() =>
      applyDirectorAuthoringActions(source, [
        {
          action: "update_object",
          object_id: character.id,
          patch: { transform: { position: [3, 0, 0] } },
        },
      ]),
    ).toThrow(/locked/);

    const unlocked = applyDirectorAuthoringActions(source, [
      { action: "update_object", object_id: character.id, patch: { locked: false } },
      {
        action: "update_object",
        object_id: character.id,
        patch: { transform: { position: [3, 0, 0] } },
      },
    ]);
    expect(unlocked.project.objects.find((object) => object.id === character.id)).toMatchObject({
      locked: false,
      transform: { position: [3, 0, 0] },
    });
  });

  it("starts a replacement scene without leaking objects from the previous case", () => {
    const source = createDefaultDirectorProject();
    source.assets.push({
      id: "shared-asset",
      kind: "prop",
      sourceType: "model",
      fileName: "shared.glb",
      url: "/shared.glb",
    });
    const result = applyDirectorAuthoringActions(source, [
      { action: "start_scene" },
      { action: "add_object", id: "new-stage", name: "新地台", kind: "prop", geometry_type: "box" },
    ]);
    expect(result.project.objects.map((object) => object.id)).toEqual(["new-stage"]);
    expect(result.project.cameras).toEqual([]);
    expect(result.project.assets.map((asset) => asset.id)).toEqual(["mixamo:x-bot", "shared-asset"]);
    expect(result.project.production?.takes[0]?.objectIds).toEqual(["new-stage"]);
    expect(result.project.production?.sequences[0]?.shots).toEqual([]);
    expect(result.deleted.object_ids).toEqual(expect.arrayContaining(["char_default_a", "cam_object_1"]));
    expect(() =>
      applyDirectorAuthoringActions(source, [
        { action: "set_scene", patch: { backgroundColor: "#000000" } },
        { action: "start_scene" },
      ]),
    ).toThrow(/must be the first action/);
  });

  it("accepts concise still and transform camera action shorthands", () => {
    const source = createDefaultDirectorProject();
    const createAction = directorAuthoringActionSchema.parse({
      action: "add_camera",
      id: "still-camera",
      object_id: "still-camera-rig",
      name: "Still Camera",
      position: [0, 2, 8],
      target: [0, 1, 0],
      action_mode: "still",
    });
    const updateAction = directorAuthoringActionSchema.parse({
      action: "update_camera",
      camera_id: "still-camera",
      patch: { action: "transform" },
    });
    const created = applyDirectorAuthoringActions(source, [createAction]);
    const updated = applyDirectorAuthoringActions(created.project, [updateAction]);

    expect(createAction.action === "add_camera" ? createAction.action_mode : null).toBe("still");
    expect(created.project.cameras.find((camera) => camera.id === "still-camera")?.action).toEqual({ mode: "still" });
    expect(updated.project.cameras.find((camera) => camera.id === "still-camera")?.action).toEqual({
      mode: "transform",
    });
  });

  it("authors and updates portable physical camera optics through snake_case fields", () => {
    const source = createDefaultDirectorProject();
    const created = applyDirectorAuthoringActions(source, [
      {
        action: "add_camera",
        id: "optics-camera",
        object_id: "optics-camera-rig",
        name: "Optics Camera",
        position: [0, 2, 8],
        target: [0, 1, 0],
        aperture_f_stop: 1.4,
        focus_distance_m: 3.2,
        shutter_angle: 144,
        iso: 1_600,
        near_clip_m: 0.02,
        far_clip_m: 8_000,
        anamorphic_squeeze: 1.8,
      },
    ]);
    expect(created.project.cameras.find((camera) => camera.id === "optics-camera")).toMatchObject({
      apertureFStop: 1.4,
      focusDistanceM: 3.2,
      shutterAngle: 144,
      iso: 1_600,
      nearClipM: 0.02,
      farClipM: 8_000,
      anamorphicSqueeze: 1.8,
    });

    const updated = applyDirectorAuthoringActions(created.project, [
      {
        action: "update_camera",
        camera_id: "optics-camera",
        patch: { aperture_f_stop: 2, focus_distance_m: 5.5, shutter_angle: 180, iso: 800 },
      },
    ]);
    expect(updated.project.cameras.find((camera) => camera.id === "optics-camera")).toMatchObject({
      apertureFStop: 2,
      focusDistanceM: 5.5,
      shutterAngle: 180,
      iso: 800,
    });

    expect(() =>
      applyDirectorAuthoringActions(updated.project, [
        {
          action: "update_camera",
          camera_id: "optics-camera",
          patch: { near_clip_m: 50, far_clip_m: 10 },
        },
      ]),
    ).toThrow(/far_clip_m must be greater than near_clip_m/);
  });

  it("rejects unknown pose tokens instead of silently rendering a default stance", () => {
    expect(() =>
      directorAuthoringActionSchema.parse({
        action: "add_object",
        id: "bad-pose-character",
        name: "无效姿势",
        kind: "character",
        pose_preset_id: "kneeling-ish",
      }),
    ).toThrow();
  });

  it("materializes Agent-authored pose presets into the controls consumed by the character runtime", () => {
    const source = createDefaultDirectorProject();
    const created = applyDirectorAuthoringActions(source, [
      {
        action: "add_object",
        id: "agent-posed-character",
        name: "挥手角色",
        kind: "character",
        pose_preset_id: "wave",
      },
    ]);
    const wave = getMannequinPosePreset("wave")!;
    const createdCharacter = created.project.objects.find((object) => object.id === "agent-posed-character");

    expect(createdCharacter?.characterRig).toEqual({
      rigType: "mixamo",
      posePresetId: "wave",
      controls: wave.controls,
    });
    expect(createdCharacter?.characterRig?.controls["rightShoulder.pitch"]).toBeDefined();

    const updated = applyDirectorAuthoringActions(created.project, [
      {
        action: "update_object",
        object_id: "agent-posed-character",
        patch: { pose_preset_id: "sit" },
      },
    ]);
    const sit = getMannequinPosePreset("sit")!;

    expect(updated.project.objects.find((object) => object.id === "agent-posed-character")?.characterRig).toEqual({
      rigType: "mixamo",
      posePresetId: "sit",
      controls: sit.controls,
    });
    expect(
      updated.project.objects.find((object) => object.id === "agent-posed-character")?.characterRig?.controls,
    ).not.toEqual(wave.controls);
  });

  it("sets and clears character IK effectors through semantic authoring", () => {
    const source = createDefaultDirectorProject();
    const setResult = applyDirectorAuthoringActions(source, [
      {
        action: "set_character_ik",
        object_id: "char_default_a",
        effector: "rightHand",
        target: [0.8, 1.45, 0.3],
        pole: [0.65, 1.1, 0.9],
        weight: 0.7,
        reach_clamp: 0.88,
      },
    ]);

    expect(setResult.updated.object_ids).toEqual(["char_default_a"]);
    expect(setResult.project.objects.find((object) => object.id === "char_default_a")?.characterRig?.ik).toEqual({
      rightHand: {
        target: [0.8, 1.45, 0.3],
        pole: [0.65, 1.1, 0.9],
        weight: 0.7,
        reachClamp: 0.88,
      },
    });
    expect(source.objects.find((object) => object.id === "char_default_a")?.characterRig?.ik).toBeUndefined();

    const cleared = applyDirectorAuthoringActions(setResult.project, [
      { action: "clear_character_ik", object_id: "char_default_a", effector: "rightHand" },
    ]);
    expect(cleared.project.objects.find((object) => object.id === "char_default_a")?.characterRig?.ik).toBeUndefined();
  });

  it("authors bounded semantic joint controls without arbitrary rig keys", () => {
    const source = createDefaultDirectorProject();
    const setResult = applyDirectorAuthoringActions(source, [
      {
        action: "set_character_pose_controls",
        object_id: "char_default_a",
        controls: [
          { control: "head.yaw", value: 28 },
          { control: "rightElbow.bend", value: 74 },
        ],
      },
    ]);
    const character = setResult.project.objects.find((object) => object.id === "char_default_a");
    expect(character?.characterRig).toMatchObject({
      posePresetId: null,
      controls: { "head.yaw": 28, "rightElbow.bend": 74 },
    });

    const replaced = applyDirectorAuthoringActions(setResult.project, [
      {
        action: "set_character_pose_controls",
        object_id: "char_default_a",
        mode: "replace",
        controls: [{ control: "body.offsetY", value: -0.2 }],
      },
    ]);
    expect(replaced.project.objects.find((object) => object.id === "char_default_a")?.characterRig?.controls).toEqual({
      "body.offsetY": -0.2,
    });

    const cleared = applyDirectorAuthoringActions(replaced.project, [
      { action: "clear_character_pose_controls", object_id: "char_default_a" },
    ]);
    expect(cleared.project.objects.find((object) => object.id === "char_default_a")?.characterRig?.controls).toEqual(
      {},
    );
  });

  it("rejects unknown, duplicate, and out-of-range Agent pose controls", () => {
    expect(
      directorAuthoringActionSchema.safeParse({
        action: "set_character_pose_controls",
        object_id: "char_default_a",
        controls: [{ control: "tail.wag", value: 20 }],
      }).success,
    ).toBe(false);
    expect(
      directorAuthoringActionSchema.safeParse({
        action: "set_character_pose_controls",
        object_id: "char_default_a",
        controls: [{ control: "leftKnee.bend", value: 126 }],
      }).success,
    ).toBe(true);
    expect(
      directorAuthoringActionSchema.safeParse({
        action: "set_character_pose_controls",
        object_id: "char_default_a",
        controls: [{ control: "head.yaw", value: 120 }],
      }).success,
    ).toBe(false);
    expect(
      directorAuthoringActionSchema.safeParse({
        action: "set_character_pose_controls",
        object_id: "char_default_a",
        controls: [
          { control: "head.yaw", value: 20 },
          { control: "head.yaw", value: -20 },
        ],
      }).success,
    ).toBe(false);
    expect(
      directorAuthoringActionSchema.safeParse({
        action: "set_character_pose_controls",
        object_id: "char_default_a",
        controls: [{ control: "body.offsetY", value: -2 }],
      }).success,
    ).toBe(false);
  });

  it("authors packaged skeletal motion with deterministic timeline defaults", () => {
    const source = createDefaultDirectorProject();
    source.scene.timeline!.currentFrame = 36;
    const setResult = applyDirectorAuthoringActions(source, [
      {
        action: "set_character_motion",
        object_id: "char_default_a",
        clip_id: "wave",
        speed: 1.25,
        root_motion: "in-place",
      },
    ]);
    expect(setResult.project.objects.find((object) => object.id === "char_default_a")?.characterRig?.motion).toEqual({
      clipId: "wave",
      enabled: true,
      loop: "once",
      speed: 1.25,
      weight: 1,
      startFrame: 36,
      blendInS: 0.12,
      blendOutS: 0.15,
      rootMotion: "in-place",
    });
    expect(source.objects.find((object) => object.id === "char_default_a")?.characterRig?.motion).toBeUndefined();

    const cleared = applyDirectorAuthoringActions(setResult.project, [
      { action: "clear_character_motion", object_id: "char_default_a" },
    ]);
    expect(
      cleared.project.objects.find((object) => object.id === "char_default_a")?.characterRig?.motion,
    ).toBeUndefined();
    expect(
      directorAuthoringActionSchema.safeParse({
        action: "set_character_motion",
        object_id: "char_default_a",
        clip_id: "invented-motion",
      }).success,
    ).toBe(false);
    expect(
      directorAuthoringActionSchema.safeParse({
        action: "set_character_motion",
        object_id: "char_default_a",
        clip_id: "walk",
        root_motion: "authored",
      }).success,
    ).toBe(false);
  });

  it("validates IK bounds and preserves locked character ownership", () => {
    expect(() =>
      directorAuthoringActionSchema.parse({
        action: "set_character_ik",
        object_id: "char_default_a",
        effector: "leftHand",
        target: [0, 1, 0],
        pole: [0, 0, 1],
        weight: 1.5,
        reach_clamp: 0,
      }),
    ).toThrow();

    const source = createDefaultDirectorProject();
    source.objects.find((object) => object.id === "char_default_a")!.locked = true;
    expect(() =>
      applyDirectorAuthoringActions(source, [
        {
          action: "set_character_ik",
          object_id: "char_default_a",
          effector: "leftFoot",
          target: [-0.2, 0, 0.2],
          pole: [-0.2, 0.4, 0.8],
        },
      ]),
    ).toThrow(/locked/);
  });

  it("requires explicit cascading before deleting referenced assets", () => {
    const source = createDefaultDirectorProject();
    source.assets.push({ id: "asset-1", kind: "prop", sourceType: "model", fileName: "chair.glb", url: "/chair.glb" });
    source.objects.push({
      id: "chair-1",
      name: "椅子",
      kind: "prop",
      visible: true,
      locked: false,
      assetRefId: "asset-1",
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    });
    expect(() => applyDirectorAuthoringActions(source, [{ action: "remove_assets", asset_ids: ["asset-1"] }])).toThrow(
      /cascade:true/,
    );

    const result = applyDirectorAuthoringActions(source, [
      { action: "remove_assets", asset_ids: ["asset-1"], cascade: true },
    ]);
    expect(result.project.assets.some((asset) => asset.id === "asset-1")).toBe(false);
    expect(result.project.objects.some((object) => object.id === "chair-1")).toBe(false);
  });

  it("removes deleted object and camera references from the production projection", () => {
    const source = createDefaultDirectorProject();
    const characterId = source.production!.takes[0]!.objectIds[0]!;
    const cameraId = source.production!.sequences[0]!.shots[0]!.cameraId;

    const result = applyDirectorAuthoringActions(source, [
      { action: "delete_objects", object_ids: [characterId], cascade: true },
      { action: "delete_cameras", camera_ids: [cameraId] },
    ]);

    expect(result.project.production?.takes[0]?.objectIds).not.toContain(characterId);
    expect(result.project.production?.takes[0]?.entityTracks.some((track) => track.objectId === characterId)).toBe(
      false,
    );
    expect(result.project.production?.sequences[0]?.shots).toEqual([]);
  });

  it("adds, updates, activates, and deletes reusable performance takes", () => {
    const source = createDefaultDirectorProject();
    const added = applyDirectorAuthoringActions(source, [
      {
        action: "add_performance_take",
        take: {
          id: "take-rehearsal",
          name: "排练二",
          frameStart: 0,
          frameEnd: 120,
          objectIds: ["char_default_a"],
          entityTracks: [],
        },
      },
    ]);

    expect(added.project.production?.activeTakeId).toBe("take-rehearsal");
    expect(added.created.performance_take_ids).toEqual(["take-rehearsal"]);

    const updated = applyDirectorAuthoringActions(added.project, [
      {
        action: "update_performance_take",
        take_id: "take-rehearsal",
        patch: { name: "排练二 · 精选", frameEnd: 180 },
        activate: true,
      },
    ]);
    expect(updated.project.production?.takes.find((take) => take.id === "take-rehearsal")).toMatchObject({
      name: "排练二 · 精选",
      frameEnd: 180,
    });
    expect(updated.updated.performance_take_ids).toEqual(["take-rehearsal"]);

    const removed = applyDirectorAuthoringActions(updated.project, [
      { action: "delete_performance_takes", take_ids: ["take-rehearsal"] },
    ]);
    expect(removed.project.production?.takes.map((take) => take.id)).toEqual(["take_default"]);
    expect(removed.project.production?.activeTakeId).toBe("take_default");
    expect(removed.deleted.performance_take_ids).toEqual(["take-rehearsal"]);
  });

  it("requires explicit cascade when deleting a take used by coverage", () => {
    const source = createDefaultDirectorProject();
    const before = structuredClone(source);

    expect(() =>
      applyDirectorAuthoringActions(source, [{ action: "delete_performance_takes", take_ids: ["take_default"] }]),
    ).toThrow(/cascade:true/);
    expect(source).toEqual(before);

    const removed = applyDirectorAuthoringActions(source, [
      { action: "delete_performance_takes", take_ids: ["take_default"], cascade: true },
    ]);
    expect(removed.project.production?.takes).toEqual([]);
    expect(removed.project.production?.activeTakeId).toBeNull();
    expect(removed.project.production?.sequences[0]?.shots).toEqual([]);
    expect(removed.deleted.coverage_shot_ids).toEqual(["coverage_shot_1"]);
  });

  it("adds, updates, activates, and deletes coverage sequences", () => {
    const source = createDefaultDirectorProject();
    const added = applyDirectorAuthoringActions(source, [
      {
        action: "add_coverage_sequence",
        sequence: {
          id: "coverage-dialogue",
          name: "对白覆盖",
          shots: [
            {
              id: "coverage-dialogue-wide",
              name: "对白全景",
              takeId: "take_default",
              cameraId: "cam_1",
              frameStart: 0,
              frameEnd: 48,
            },
          ],
        },
      },
    ]);

    expect(added.project.production?.activeSequenceId).toBe("coverage-dialogue");
    expect(added.created.coverage_sequence_ids).toEqual(["coverage-dialogue"]);
    expect(added.created.coverage_shot_ids).toEqual(["coverage-dialogue-wide"]);

    const updated = applyDirectorAuthoringActions(added.project, [
      {
        action: "update_coverage_sequence",
        sequence_id: "coverage-dialogue",
        patch: {
          name: "对白覆盖 · 精选",
          shots: [
            {
              id: "coverage-dialogue-wide",
              name: "对白全景 · 精选",
              takeId: "take_default",
              cameraId: "cam_1",
              frameStart: 12,
              frameEnd: 60,
            },
          ],
        },
      },
    ]);
    expect(updated.project.production?.sequences.find((sequence) => sequence.id === "coverage-dialogue")).toMatchObject(
      {
        name: "对白覆盖 · 精选",
        shots: [expect.objectContaining({ id: "coverage-dialogue-wide", frameStart: 12, frameEnd: 60 })],
      },
    );
    expect(updated.updated.coverage_sequence_ids).toEqual(["coverage-dialogue"]);
    expect(updated.updated.coverage_shot_ids).toEqual(["coverage-dialogue-wide"]);

    const removed = applyDirectorAuthoringActions(updated.project, [
      { action: "delete_coverage_sequences", sequence_ids: ["coverage-dialogue"] },
    ]);
    expect(removed.project.production?.activeSequenceId).toBe("coverage_default");
    expect(removed.deleted.coverage_sequence_ids).toEqual(["coverage-dialogue"]);
    expect(removed.deleted.coverage_shot_ids).toEqual(["coverage-dialogue-wide"]);
  });

  it("adds, updates, activates, and deletes individual coverage shots", () => {
    const source = createDefaultDirectorProject();
    const added = applyDirectorAuthoringActions(source, [
      {
        action: "add_coverage_shot",
        sequence_id: "coverage_default",
        shot: {
          id: "coverage-close",
          name: "近景覆盖",
          takeId: "take_default",
          cameraId: "cam_1",
          frameStart: 24,
          frameEnd: 72,
        },
      },
    ]);
    expect(added.created.coverage_shot_ids).toEqual(["coverage-close"]);
    expect(added.project.production).toMatchObject({
      activeTakeId: "take_default",
      activeSequenceId: "coverage_default",
    });

    const updated = applyDirectorAuthoringActions(added.project, [
      {
        action: "update_coverage_shot",
        shot_id: "coverage-close",
        patch: { name: "近景覆盖 · 推进", frameStart: 30, frameEnd: 84 },
        activate: true,
      },
    ]);
    expect(updated.project.production?.sequences[0]?.shots.find((shot) => shot.id === "coverage-close")).toMatchObject({
      name: "近景覆盖 · 推进",
      frameStart: 30,
      frameEnd: 84,
    });
    expect(updated.updated.coverage_shot_ids).toEqual(["coverage-close"]);

    const removed = applyDirectorAuthoringActions(updated.project, [
      { action: "delete_coverage_shots", shot_ids: ["coverage-close"] },
    ]);
    expect(removed.project.production?.sequences[0]?.shots.map((shot) => shot.id)).toEqual(["coverage_shot_1"]);
    expect(removed.deleted.coverage_shot_ids).toEqual(["coverage-close"]);
  });

  it("rejects semantically invalid production edits atomically", () => {
    const source = createDefaultDirectorProject();
    const before = structuredClone(source);

    expect(() =>
      applyDirectorAuthoringActions(source, [
        {
          action: "update_performance_take",
          take_id: "take_default",
          patch: { frameEnd: 10 },
        },
      ]),
    ).toThrow(/Production semantics are invalid/);
    expect(source).toEqual(before);
  });

  it("derives production author payloads from the persisted Zod structures", () => {
    expect(
      directorAuthoringActionSchema.safeParse({
        action: "add_performance_take",
        take: {
          id: "take-valid",
          name: "Valid",
          frameStart: 0,
          frameEnd: 24,
          objectIds: [],
          entityTracks: [],
        },
      }).success,
    ).toBe(true);
    expect(
      directorAuthoringActionSchema.safeParse({
        action: "add_coverage_shot",
        sequence_id: "coverage_default",
        shot: {
          id: "bad-shot",
          name: "Bad",
          takeId: "take_default",
          cameraId: "cam_1",
          frameStart: 0,
          frameEnd: 24,
          unknownField: true,
        },
      }).success,
    ).toBe(false);
  });

  it("authors PBR materials, fog, environment lighting, and editable lights atomically", () => {
    const source = createDefaultDirectorProject();
    source.assets.push({
      id: "texture-agent",
      kind: "prop",
      sourceType: "image",
      assetSource: "local",
      fileName: "agent-paint.png",
      url: "data:image/png;base64,agent",
    });
    const result = applyDirectorAuthoringActions(source, [
      {
        action: "set_scene",
        patch: {
          fog: { enabled: true, mode: "linear", color: "#223344", near: 5, far: 120, density: 0.02 },
          environment: { enabled: true, usePanorama: true, intensity: 0.8, rotation: [0, 0.4, 0] },
        },
      },
      {
        action: "add_object",
        id: "material-cube",
        name: "材质立方体",
        kind: "prop",
        geometry_type: "box",
        material: {
          baseColor: "#8899aa",
          metalness: 0.75,
          roughness: 0.2,
          textures: { baseColorMapAssetId: "texture-agent" },
        },
      },
      {
        action: "add_light",
        light: {
          id: "light-agent-key",
          name: "Agent 主光",
          type: "spot",
          visible: true,
          locked: false,
          color: "#ffe8cc",
          intensity: 4,
          position: [3, 5, 2],
          target: [0, 1, 0],
          angle: 0.6,
          penumbra: 0.2,
          castShadow: true,
        },
      },
    ]);

    expect(result.created.light_ids).toEqual(["light-agent-key"]);
    expect(result.project.scene).toMatchObject({
      fog: { enabled: true, near: 5, far: 120 },
      environment: { enabled: true, intensity: 0.8 },
    });
    expect(result.project.objects.find((object) => object.id === "material-cube")?.material).toMatchObject({
      metalness: 0.75,
      textures: { baseColorMapAssetId: "texture-agent" },
    });

    const edited = applyDirectorAuthoringActions(result.project, [
      { action: "update_light", light_id: "light-agent-key", patch: { intensity: 2.5, locked: true } },
    ]);
    expect(edited.updated.light_ids).toEqual(["light-agent-key"]);
    expect(() =>
      applyDirectorAuthoringActions(edited.project, [{ action: "delete_lights", light_ids: ["light-agent-key"] }]),
    ).toThrow(/locked/);
    const removed = applyDirectorAuthoringActions(edited.project, [
      { action: "delete_lights", light_ids: ["light-agent-key"], force: true },
    ]);
    expect(removed.deleted.light_ids).toEqual(["light-agent-key"]);
  });

  it("defaults add_light visible and locked so agents can omit them", () => {
    const parsed = directorAuthoringActionSchema.parse({
      action: "add_light",
      light: {
        id: "light-minimal",
        name: "Minimal key",
        type: "directional",
        color: "#ffffff",
        intensity: 1.2,
        position: [4, 6, 4],
        target: [0, 1, 0],
      },
    });
    expect(parsed).toMatchObject({
      action: "add_light",
      light: { id: "light-minimal", visible: true, locked: false },
    });

    const result = applyDirectorAuthoringActions(createDefaultDirectorProject(), [parsed]);
    expect(result.created.light_ids).toEqual(["light-minimal"]);
    expect(result.project.lights.find((light) => light.id === "light-minimal")).toMatchObject({
      visible: true,
      locked: false,
    });
  });

  it("performs batch layers, materials, alignment, distribution, isolation, reset, and clipping atomically", () => {
    const seeded = applyDirectorAuthoringActions(createDefaultDirectorProject(), [
      {
        action: "add_object",
        id: "advanced-a",
        name: "A",
        kind: "prop",
        geometry_type: "box",
        transform: { position: [0, 0, -2], rotation: [0.1, 0.2, 0.3], scale: [2, 2, 2] },
      },
      {
        action: "add_object",
        id: "advanced-b",
        name: "B",
        kind: "prop",
        geometry_type: "box",
        transform: { position: [2, 0, 4], rotation: [0, 0, 0], scale: [1, 1, 1] },
      },
      {
        action: "add_object",
        id: "advanced-c",
        name: "C",
        kind: "prop",
        geometry_type: "box",
        transform: { position: [10, 0, 8], rotation: [0, 0, 0], scale: [1, 1, 1] },
      },
    ]).project;
    const result = applyDirectorAuthoringActions(seeded, [
      {
        action: "batch_update_objects",
        object_ids: ["advanced-a", "advanced-b", "advanced-c"],
        patch: { layer: "hero-set", material: { baseColor: "#445566", metalness: 0.4, roughness: 0.3 } },
      },
      { action: "distribute_objects", object_ids: ["advanced-a", "advanced-b", "advanced-c"], axis: "x" },
      {
        action: "align_objects",
        object_ids: ["advanced-a", "advanced-b", "advanced-c"],
        axis: "z",
        mode: "center",
      },
      { action: "reset_transforms", object_ids: ["advanced-a"], components: ["rotation", "scale"] },
      { action: "isolate_objects", object_ids: ["advanced-a", "advanced-b"], force: true },
      {
        action: "set_scene",
        patch: {
          clippingPlanes: [{ id: "clip-hero", name: "Hero cut", enabled: true, normal: [1, 0, 0], constant: -1 }],
        },
      },
    ]);

    const byId = new Map(result.project.objects.map((object) => [object.id, object]));
    expect(["advanced-a", "advanced-b", "advanced-c"].map((id) => byId.get(id)?.transform.position[0])).toEqual([
      0, 5, 10,
    ]);
    expect(
      new Set(["advanced-a", "advanced-b", "advanced-c"].map((id) => byId.get(id)?.transform.position[2])),
    ).toEqual(new Set([10 / 3]));
    expect(byId.get("advanced-a")).toMatchObject({
      layer: "hero-set",
      visible: true,
      transform: { rotation: [0, 0, 0], scale: [1, 1, 1] },
      material: { baseColor: "#445566", metalness: 0.4, roughness: 0.3 },
    });
    expect(byId.get("advanced-c")?.visible).toBe(false);
    expect(result.project.scene.clippingPlanes).toEqual([
      { id: "clip-hero", name: "Hero cut", enabled: true, normal: [1, 0, 0], constant: -1 },
    ]);
  });

  it("compiles strict Agent animation recipes into ordinary editable timeline keyframes", () => {
    const source = createDefaultDirectorProject();
    const objectId = source.objects.find((object) => object.kind !== "camera")!.id;
    const result = applyDirectorAuthoringActions(source, [
      {
        action: "apply_animation_recipe",
        target_type: "object",
        target_id: objectId,
        frame_start: 0,
        frame_end: 48,
        recipe: { type: "bounce", height: 2, bounces: 2, squash: true },
      },
    ]);
    const animation = result.project.objects.find((object) => object.id === objectId)?.animation;
    expect(animation).toMatchObject({
      enabled: true,
      preset: "custom",
      source: "assistant",
      recipe: { type: "bounce", height: 2, bounces: 2, squash: true },
    });
    expect(animation?.keyframes[0]?.frame).toBe(0);
    expect(animation?.keyframes.at(-1)?.frame).toBe(48);
    expect(result.updated.object_ids).toEqual([objectId]);

    expect(() =>
      applyDirectorAuthoringActions(source, [
        {
          action: "apply_animation_recipe",
          target_type: "object",
          target_id: objectId,
          frame_start: 0,
          frame_end: 10_000,
          recipe: { type: "wave", axis: "y", amplitude: 1, cycles: 2, phase_degrees: 0 },
        },
      ]),
    ).toThrow(/Animation recipe frames/);
    expect(
      directorAuthoringActionSchema.safeParse({
        action: "apply_animation_recipe",
        target_type: "object",
        target_id: objectId,
        frame_start: 0,
        frame_end: 48,
        recipe: { type: "wave", unknown: true },
      }).success,
    ).toBe(false);
  });
});

describe("living world authoring", () => {
  it("creates the world block on demand and fills per-kind effect defaults", () => {
    const source = createDefaultDirectorProject();
    expect(source.world).toBeUndefined();

    const result = applyDirectorAuthoringActions(source, [
      { action: "add_world_effect", kind: "fire" },
      { action: "add_world_effect", kind: "smoke" },
      { action: "add_world_effect", kind: "fire" },
    ]);

    expect(source.world).toBeUndefined();
    expect(result.notes).toEqual([
      "The project had no world block; created project.world with default settings (enabled: true).",
    ]);
    expect(result.project.world?.settings.enabled).toBe(true);
    expect(result.created.world_effect_ids).toEqual(["fx_fire_1", "fx_smoke_1", "fx_fire_2"]);

    const fire = result.project.world?.effects.find((effect) => effect.id === "fx_fire_1");
    expect(fire).toMatchObject({
      name: "火焰01",
      kind: "fire",
      anchor: { objectId: null, position: [0, 0, 0] },
      shape: { type: "point" },
      intensity: 1,
      sizeScale: 1,
      speedScale: 1,
      windInfluence: 0.35,
      seedOffset: 0,
      visible: true,
      locked: false,
    });
    expect(fire?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.project.world?.effects.map((effect) => effect.windInfluence)).toEqual([0.35, 0.8, 0.35]);
    expect(result.project.world?.effects.map((effect) => effect.seedOffset)).toEqual([0, 1, 2]);
    expect(result.project.world?.effects.map((effect) => effect.name)).toEqual(["火焰01", "烟雾01", "火焰02"]);
  });

  it("merges partial world settings without clobbering sibling fields", () => {
    const seeded = applyDirectorAuthoringActions(createDefaultDirectorProject(), [
      { action: "set_world_settings", settings: { wind: { speed_mps: 9 } } },
    ]);
    expect(seeded.project.world?.settings.wind).toEqual({
      directionDegrees: 45,
      speedMps: 9,
      gustiness: 0.35,
      turbulence: 0.3,
    });

    const patched = applyDirectorAuthoringActions(seeded.project, [
      {
        action: "set_world_settings",
        settings: {
          enabled: false,
          weather: { preset: "storm", intensity: 0.9 },
          time_of_day: { mode: "cycle", cycle_minutes: 6 },
        },
      },
    ]);
    const settings = patched.project.world?.settings;
    expect(settings?.enabled).toBe(false);
    expect(settings?.wind.speedMps).toBe(9);
    expect(settings?.weather).toMatchObject({ preset: "storm", intensity: 0.9, wetness: 0 });
    expect(settings?.timeOfDay).toMatchObject({ mode: "cycle", cycleMinutes: 6, hours: 14 });
    expect(patched.notes).toEqual([]);
  });

  it("authors water bodies and wildlife groups with the documented defaults", () => {
    const result = applyDirectorAuthoringActions(createDefaultDirectorProject(), [
      { action: "add_world_water_body" },
      { action: "add_world_wildlife_group", species: "birds" },
      { action: "add_world_wildlife_group", species: "fish" },
    ]);

    expect(result.created.world_water_body_ids).toEqual(["water_1"]);
    expect(result.project.world?.waterBodies[0]).toEqual({
      id: "water_1",
      name: "水体01",
      surface: { center: [0, 0, 0], sizeX: 20, sizeZ: 20, rotationDegrees: 0 },
      waveAmplitude: 0.12,
      waveLengthM: 8,
      flowDirectionDegrees: 90,
      flowSpeedMps: 0.4,
      colorShallow: "#4fa8c7",
      colorDeep: "#0b2e4f",
      opacity: 0.92,
      foamIntensity: 0.5,
      visible: true,
      locked: false,
    });

    expect(result.created.world_wildlife_group_ids).toEqual(["wildlife_birds_1", "wildlife_fish_1"]);
    const birds = result.project.world?.wildlife.find((group) => group.id === "wildlife_birds_1");
    expect(birds).toMatchObject({
      name: "鸟群01",
      species: "birds",
      count: 24,
      area: { center: [0, 0, 0], radius: 15 },
      altitude: { minM: 8, maxM: 25 },
      speedScale: 1,
      sizeScale: 1,
      visible: true,
      locked: false,
    });
    const fish = result.project.world?.wildlife.find((group) => group.id === "wildlife_fish_1");
    expect(fish?.count).toBe(40);
    expect(fish?.altitude).toBeUndefined();
    expect(fish?.assetId).toBeUndefined();
  });

  it("authors, replaces, and clears spline river geometry", () => {
    const addedAction = directorAuthoringActionSchema.parse({
      action: "add_world_water_body",
      id: "river_north",
      name: "北河",
      river: {
        points: [
          [-12, 1, -8],
          [-2, 0.5, 0],
          [10, 0, 9],
        ],
        width_m: 5,
        width_profile: [0.7, 1, 1.4],
      },
      flow_speed_mps: 1.6,
    });
    const added = applyDirectorAuthoringActions(createDefaultDirectorProject(), [addedAction]);
    expect(added.project.world?.waterBodies[0]).toMatchObject({
      id: "river_north",
      river: {
        points: [
          [-12, 1, -8],
          [-2, 0.5, 0],
          [10, 0, 9],
        ],
        widthM: 5,
        widthProfile: [0.7, 1, 1.4],
      },
      flowSpeedMps: 1.6,
    });

    const replaced = applyDirectorAuthoringActions(added.project, [
      {
        action: "update_world_water_body",
        body_id: "river_north",
        patch: {
          river: {
            points: [
              [-12, 1, -8],
              [0, 0.25, 2],
              [14, 0, 12],
            ],
            width_m: 8,
          },
        },
      },
    ]);
    expect(replaced.project.world?.waterBodies[0]?.river).toMatchObject({ widthM: 8 });

    const cleared = applyDirectorAuthoringActions(replaced.project, [
      { action: "update_world_water_body", body_id: "river_north", patch: { river: null } },
    ]);
    expect(cleared.project.world?.waterBodies[0]?.river).toBeUndefined();
    expect(() =>
      directorAuthoringActionSchema.parse({
        action: "add_world_water_body",
        river: { points: [[0, 0, 0]], width_m: 4 },
      }),
    ).toThrow();
  });

  it("updates world entries with partial patches and validates references", () => {
    const project = createDefaultDirectorProject();
    const anchorObjectId = project.objects.find((object) => object.kind !== "camera")!.id;
    const seeded = applyDirectorAuthoringActions(project, [
      { action: "add_world_effect", kind: "steam", id: "fx_kettle" },
      { action: "add_world_water_body", id: "water_pond" },
      { action: "add_world_wildlife_group", species: "deer", id: "herd_east" },
    ]);

    const updated = applyDirectorAuthoringActions(seeded.project, [
      {
        action: "update_world_effect",
        effect_id: "fx_kettle",
        patch: { anchor: { object_id: anchorObjectId }, intensity: 2.5, color_tint: "#ffaa33" },
      },
      {
        action: "update_world_water_body",
        body_id: "water_pond",
        patch: { surface: { size_x: 42 }, foam_intensity: 0.8 },
      },
      {
        action: "update_world_wildlife_group",
        group_id: "herd_east",
        patch: { count: 12, area: { radius: 30 }, altitude: { min_m: 1, max_m: 2 } },
      },
    ]);

    const effect = updated.project.world?.effects.find((entry) => entry.id === "fx_kettle");
    expect(effect).toMatchObject({ anchor: { objectId: anchorObjectId }, intensity: 2.5, colorTint: "#ffaa33" });
    expect(effect?.speedScale).toBe(1);
    const body = updated.project.world?.waterBodies.find((entry) => entry.id === "water_pond");
    expect(body?.surface).toMatchObject({ sizeX: 42, sizeZ: 20 });
    expect(body?.foamIntensity).toBe(0.8);
    const herd = updated.project.world?.wildlife.find((entry) => entry.id === "herd_east");
    expect(herd).toMatchObject({ count: 12, area: { radius: 30 }, altitude: { minM: 1, maxM: 2 } });
    expect(updated.updated).toMatchObject({
      world_effect_ids: ["fx_kettle"],
      world_water_body_ids: ["water_pond"],
      world_wildlife_group_ids: ["herd_east"],
    });

    const cleared = applyDirectorAuthoringActions(updated.project, [
      {
        action: "update_world_effect",
        effect_id: "fx_kettle",
        patch: { color_tint: null, anchor: { object_id: null } },
      },
      { action: "update_world_wildlife_group", group_id: "herd_east", patch: { altitude: null } },
    ]);
    const clearedEffect = cleared.project.world?.effects.find((entry) => entry.id === "fx_kettle");
    expect(clearedEffect?.colorTint).toBeUndefined();
    expect(clearedEffect?.anchor.objectId).toBeNull();
    expect(cleared.project.world?.wildlife.find((entry) => entry.id === "herd_east")?.altitude).toBeUndefined();

    expect(() =>
      applyDirectorAuthoringActions(seeded.project, [
        { action: "update_world_effect", effect_id: "fx_kettle", patch: { anchor: { object_id: "missing-object" } } },
      ]),
    ).toThrow(/No object with id "missing-object" exists/);
    expect(() =>
      applyDirectorAuthoringActions(seeded.project, [
        { action: "update_world_wildlife_group", group_id: "herd_east", patch: { asset_id: "missing-asset" } },
      ]),
    ).toThrow(/No asset with id "missing-asset" exists/);
    expect(() =>
      applyDirectorAuthoringActions(seeded.project, [
        { action: "update_world_effect", effect_id: "fx_gone", patch: { intensity: 2 } },
      ]),
    ).toThrow(/No world effect with id "fx_gone" exists/);
  });

  it("rejects malformed world payloads at the schema boundary", () => {
    expect(directorAuthoringActionSchema.safeParse({ action: "add_world_effect", kind: "lava" }).success).toBe(false);
    expect(
      directorAuthoringActionSchema.safeParse({ action: "add_world_wildlife_group", species: "dragons" }).success,
    ).toBe(false);
    expect(
      directorAuthoringActionSchema.safeParse({ action: "update_world_effect", effect_id: "fx_1", patch: {} }).success,
    ).toBe(false);
    expect(
      directorAuthoringActionSchema.safeParse({ action: "update_world_water_body", body_id: "w1", patch: {} }).success,
    ).toBe(false);
    expect(
      directorAuthoringActionSchema.safeParse({ action: "update_world_wildlife_group", group_id: "g1", patch: {} })
        .success,
    ).toBe(false);
    expect(directorAuthoringActionSchema.safeParse({ action: "set_world_settings", settings: {} }).success).toBe(false);
    expect(
      directorAuthoringActionSchema.safeParse({ action: "set_world_settings", settings: { wind: {} } }).success,
    ).toBe(false);
    expect(
      directorAuthoringActionSchema.safeParse({
        action: "add_world_wildlife_group",
        species: "birds",
        altitude: { min_m: 30, max_m: 2 },
      }).success,
    ).toBe(false);
    expect(directorAuthoringActionSchema.safeParse({ action: "remove_world_effects", effect_ids: [] }).success).toBe(
      false,
    );
  });

  it("enforces world collection capacity limits with actionable errors", () => {
    const maxedEffects = applyDirectorAuthoringActions(
      createDefaultDirectorProject(),
      Array.from({ length: 64 }, () => ({ action: "add_world_effect" as const, kind: "dust" as const })),
    );
    expect(maxedEffects.project.world?.effects).toHaveLength(64);
    expect(() =>
      applyDirectorAuthoringActions(maxedEffects.project, [{ action: "add_world_effect", kind: "fire" }]),
    ).toThrow(/maximum of 64 effects.*remove_world_effects/);

    const maxedWater = applyDirectorAuthoringActions(
      createDefaultDirectorProject(),
      Array.from({ length: 8 }, () => ({ action: "add_world_water_body" as const })),
    );
    expect(() => applyDirectorAuthoringActions(maxedWater.project, [{ action: "add_world_water_body" }])).toThrow(
      /maximum of 8 water bodies.*remove_world_water_bodies/,
    );

    const maxedWildlife = applyDirectorAuthoringActions(
      createDefaultDirectorProject(),
      Array.from({ length: 16 }, () => ({ action: "add_world_wildlife_group" as const, species: "sheep" as const })),
    );
    expect(() =>
      applyDirectorAuthoringActions(maxedWildlife.project, [{ action: "add_world_wildlife_group", species: "wolves" }]),
    ).toThrow(/maximum of 16 wildlife groups.*remove_world_wildlife_groups/);
  });

  it("treats locked world entries as write-protected until explicitly unlocked", () => {
    const seeded = applyDirectorAuthoringActions(createDefaultDirectorProject(), [
      { action: "add_world_effect", kind: "sparks", id: "fx_forge" },
      { action: "update_world_effect", effect_id: "fx_forge", patch: { locked: true } },
    ]);
    expect(seeded.project.world?.effects[0]?.locked).toBe(true);

    expect(() =>
      applyDirectorAuthoringActions(seeded.project, [
        { action: "update_world_effect", effect_id: "fx_forge", patch: { intensity: 3 } },
      ]),
    ).toThrow(/locked/);
    expect(() =>
      applyDirectorAuthoringActions(seeded.project, [{ action: "remove_world_effects", effect_ids: ["fx_forge"] }]),
    ).toThrow(/Locked world effect/);

    const unlocked = applyDirectorAuthoringActions(seeded.project, [
      { action: "update_world_effect", effect_id: "fx_forge", patch: { locked: false } },
      { action: "update_world_effect", effect_id: "fx_forge", patch: { intensity: 3 } },
      { action: "remove_world_effects", effect_ids: ["fx_forge"] },
    ]);
    expect(unlocked.project.world?.effects).toHaveLength(0);
    expect(unlocked.deleted.world_effect_ids).toEqual(["fx_forge"]);
  });

  it("removes world entries atomically and reports missing ids", () => {
    const seeded = applyDirectorAuthoringActions(createDefaultDirectorProject(), [
      { action: "add_world_effect", kind: "rain", id: "fx_rain" },
      { action: "add_world_water_body", id: "water_lake" },
      { action: "add_world_wildlife_group", species: "rabbits", id: "rabbits_meadow" },
    ]);

    const removed = applyDirectorAuthoringActions(seeded.project, [
      { action: "remove_world_effects", effect_ids: ["fx_rain"] },
      { action: "remove_world_water_bodies", body_ids: ["water_lake"] },
      { action: "remove_world_wildlife_groups", group_ids: ["rabbits_meadow"] },
    ]);
    expect(removed.project.world?.effects).toHaveLength(0);
    expect(removed.project.world?.waterBodies).toHaveLength(0);
    expect(removed.project.world?.wildlife).toHaveLength(0);
    expect(removed.deleted).toMatchObject({
      world_effect_ids: ["fx_rain"],
      world_water_body_ids: ["water_lake"],
      world_wildlife_group_ids: ["rabbits_meadow"],
    });

    expect(() =>
      applyDirectorAuthoringActions(seeded.project, [
        { action: "remove_world_water_bodies", body_ids: ["water_lake", "water_ghost"] },
      ]),
    ).toThrow(/No world water body with id "water_ghost" exists/);
    expect(() =>
      applyDirectorAuthoringActions(createDefaultDirectorProject(), [
        { action: "remove_world_wildlife_groups", group_ids: ["rabbits_meadow"] },
      ]),
    ).toThrow(/No world wildlife group with id "rabbits_meadow" exists/);

    expect(() =>
      applyDirectorAuthoringActions(seeded.project, [{ action: "add_world_effect", kind: "fire", id: "water_lake" }]),
    ).toThrow(/id "water_lake" already exists/);
  });

  it("round-trips wire payloads end to end into a valid persisted project", () => {
    const project = createDefaultDirectorProject();
    const anchorObjectId = project.objects.find((object) => object.kind !== "camera")!.id;
    const actions = [
      {
        action: "set_world_settings",
        settings: {
          seed: 1234,
          wind: { direction_degrees: 180, speed_mps: 6 },
          weather: { preset: "rain", intensity: 0.7, wetness: 0.4 },
          time_of_day: { mode: "fixed", hours: 19.5 },
        },
      },
      {
        action: "add_world_effect",
        kind: "rain",
        anchor: { position: [0, 12, 0] },
        shape: { type: "box", size: [40, 1, 40] },
        intensity: 1.4,
      },
      {
        action: "add_world_effect",
        kind: "fire",
        id: "fx_campfire",
        name: "营地篝火",
        anchor: { object_id: anchorObjectId, position: [0, 0.4, 0] },
        color_tint: "#ff7733",
      },
      {
        action: "add_world_water_body",
        surface: { center: [10, 0, -6], size_x: 30, size_z: 18, rotation_degrees: 15 },
        flow_direction_degrees: 45,
      },
      {
        action: "add_world_wildlife_group",
        species: "butterflies",
        area: { center: [4, 0, 4], radius: 6 },
        count: 12,
      },
    ].map((payload) => directorAuthoringActionSchema.parse(payload));

    const result = applyDirectorAuthoringActions(project, actions);
    const world = result.project.world;
    expect(world?.settings).toMatchObject({
      seed: 1234,
      wind: { directionDegrees: 180, speedMps: 6 },
      weather: { preset: "rain", intensity: 0.7, wetness: 0.4 },
      timeOfDay: { mode: "fixed", hours: 19.5 },
    });
    expect(world?.effects.map((effect) => effect.id)).toEqual(["fx_rain_1", "fx_campfire"]);
    expect(world?.effects[1]).toMatchObject({
      name: "营地篝火",
      anchor: { objectId: anchorObjectId, position: [0, 0.4, 0] },
      colorTint: "#ff7733",
      windInfluence: 0.35,
    });
    expect(world?.waterBodies[0]?.surface).toEqual({
      center: [10, 0, -6],
      sizeX: 30,
      sizeZ: 18,
      rotationDegrees: 15,
    });
    expect(world?.wildlife[0]).toMatchObject({ species: "butterflies", count: 12, altitude: { minM: 0.5, maxM: 3 } });

    const parsed = safeParseDirectorProject(result.project);
    expect(parsed.success).toBe(true);

    expect(() =>
      applyDirectorAuthoringActions(result.project, [
        { action: "add_world_effect", kind: "smoke", anchor: { object_id: "missing-anchor" } },
        { action: "add_world_water_body" },
      ]),
    ).toThrow(/No object with id "missing-anchor" exists/);
  });

  it("authors ambient traffic roads with the documented defaults and loop inference", () => {
    const openPoints: [number, number, number][] = [
      [-20, 0, 0],
      [0, 0, 4],
      [20, 0, 0],
    ];
    const result = applyDirectorAuthoringActions(createDefaultDirectorProject(), [
      { action: "add_world_road", points: openPoints },
      {
        action: "add_world_road",
        id: "road_ring",
        name: "环路",
        points: [
          [12, 0.05, 8],
          [-12, 0.05, 8],
          [-12, 0.05, -8],
          [12, 0.05, -8],
          [12, 0.05, 8],
        ],
        vehicle_count: 10,
        speed_kph: 60,
        show_surface: false,
      },
    ]);

    expect(result.created.world_road_ids).toEqual(["road_1", "road_ring"]);
    expect(result.project.world?.roads?.[0]).toEqual({
      id: "road_1",
      name: "道路01",
      points: openPoints,
      widthM: 8,
      loop: false,
      vehicleCount: 6,
      speedKph: 40,
      showSurface: true,
      seedOffset: 0,
      visible: true,
      locked: false,
    });
    // A closed control polygon (first == last point) infers loop: true.
    expect(result.project.world?.roads?.[1]).toMatchObject({
      name: "环路",
      loop: true,
      vehicleCount: 10,
      speedKph: 60,
      showSurface: false,
      seedOffset: 1,
    });
    expect(safeParseDirectorProject(result.project).success).toBe(true);

    const patched = applyDirectorAuthoringActions(result.project, [
      { action: "update_world_road", road_id: "road_ring", patch: { vehicle_count: 3, width_m: 12, visible: false } },
    ]);
    expect(patched.updated.world_road_ids).toEqual(["road_ring"]);
    expect(patched.project.world?.roads?.[1]).toMatchObject({
      vehicleCount: 3,
      widthM: 12,
      visible: false,
      speedKph: 60,
    });
    expect(safeParseDirectorProject(patched.project).success).toBe(true);

    expect(
      directorAuthoringActionSchema.safeParse({ action: "update_world_road", road_id: "road_ring", patch: {} })
        .success,
    ).toBe(false);
    expect(directorAuthoringActionSchema.safeParse({ action: "add_world_road", points: [[0, 0, 0]] }).success).toBe(
      false,
    );
    expect(
      directorAuthoringActionSchema.safeParse({ action: "add_world_road", points: openPoints, vehicle_count: 25 })
        .success,
    ).toBe(false);
  });

  it("guards road capacity, locking, and removal like the other world collections", () => {
    const line: [number, number, number][] = [
      [0, 0, 0],
      [10, 0, 0],
    ];
    const maxedRoads = applyDirectorAuthoringActions(
      createDefaultDirectorProject(),
      Array.from({ length: 16 }, () => ({ action: "add_world_road" as const, points: line })),
    );
    expect(maxedRoads.project.world?.roads).toHaveLength(16);
    expect(() =>
      applyDirectorAuthoringActions(maxedRoads.project, [{ action: "add_world_road", points: line }]),
    ).toThrow(/maximum of 16 roads.*remove_world_roads/);

    const seeded = applyDirectorAuthoringActions(createDefaultDirectorProject(), [
      { action: "add_world_road", id: "road_main", points: line },
      { action: "update_world_road", road_id: "road_main", patch: { locked: true } },
    ]);
    expect(() =>
      applyDirectorAuthoringActions(seeded.project, [
        { action: "update_world_road", road_id: "road_main", patch: { speed_kph: 80 } },
      ]),
    ).toThrow(/locked/);
    expect(() =>
      applyDirectorAuthoringActions(seeded.project, [{ action: "remove_world_roads", road_ids: ["road_main"] }]),
    ).toThrow(/Locked world road/);

    const removed = applyDirectorAuthoringActions(seeded.project, [
      { action: "update_world_road", road_id: "road_main", patch: { locked: false } },
      { action: "remove_world_roads", road_ids: ["road_main"] },
    ]);
    expect(removed.project.world?.roads).toHaveLength(0);
    expect(removed.deleted.world_road_ids).toEqual(["road_main"]);

    expect(() =>
      applyDirectorAuthoringActions(createDefaultDirectorProject(), [
        { action: "remove_world_roads", road_ids: ["road_ghost"] },
      ]),
    ).toThrow(/No world road with id "road_ghost" exists/);
    expect(() =>
      applyDirectorAuthoringActions(seeded.project, [
        { action: "update_world_road", road_id: "road_ghost", patch: { loop: true } },
      ]),
    ).toThrow(/No world road with id "road_ghost" exists/);
  });
});

describe("drivable vehicle authoring", () => {
  const addCarAction = {
    action: "add_object" as const,
    id: "hero-car",
    name: "英雄座驾",
    kind: "prop" as const,
    geometry_type: "box" as const,
  };

  it("attaches the pure default car profile when the patch is omitted", () => {
    const source = createDefaultDirectorProject();
    const result = applyDirectorAuthoringActions(source, [
      addCarAction,
      { action: "set_vehicle_profile", object_id: "hero-car" },
    ]);

    expect(source.objects.some((object) => object.id === "hero-car")).toBe(false);
    const car = result.project.objects.find((object) => object.id === "hero-car");
    expect(car?.vehicle).toEqual(createDefaultDirectorCarProfile());
    expect(result.notes).toEqual(['Object "hero-car" had no vehicle profile; attached the default car profile.']);
    expect(result.updated.object_ids).toEqual(["hero-car"]);
    expect(safeParseDirectorProject(result.project).success).toBe(true);
  });

  it("merges a partial patch without clobbering sibling profile fields", () => {
    const seeded = applyDirectorAuthoringActions(createDefaultDirectorProject(), [
      addCarAction,
      { action: "set_vehicle_profile", object_id: "hero-car", profile: { camera: { chase_distance_m: 9 } } },
    ]);
    expect(seeded.notes).toEqual([
      'Object "hero-car" had no vehicle profile; attached the default car profile and applied the patch.',
    ]);

    const patched = applyDirectorAuthoringActions(seeded.project, [
      { action: "set_vehicle_profile", object_id: "hero-car", profile: { mass_kg: 1800 } },
    ]);
    const profile = patched.project.objects.find((object) => object.id === "hero-car")?.vehicle;
    expect(profile).toEqual({
      ...createDefaultDirectorCarProfile(),
      massKg: 1800,
      camera: { chaseDistanceM: 9, chaseHeightM: 2.6 },
    });
    expect(patched.notes).toEqual(['Patched the existing vehicle profile on object "hero-car".']);
    expect(safeParseDirectorProject(patched.project).success).toBe(true);
  });

  it("rejects vehicle profiles on unknown, camera, and character objects", () => {
    expect(() =>
      applyDirectorAuthoringActions(createDefaultDirectorProject(), [
        { action: "set_vehicle_profile", object_id: "missing-car" },
      ]),
    ).toThrow(/No object with id "missing-car" exists/);
    expect(() =>
      applyDirectorAuthoringActions(createDefaultDirectorProject(), [
        { action: "set_vehicle_profile", object_id: "cam_object_1" },
      ]),
    ).toThrow(/Only prop and scene objects can carry a drivable vehicle profile; "cam_object_1" is a camera object/);
    expect(() =>
      applyDirectorAuthoringActions(createDefaultDirectorProject(), [
        { action: "set_vehicle_profile", object_id: "char_default_a" },
      ]),
    ).toThrow(/Only prop and scene objects/);
  });

  it("treats locked objects as write-protected except the standalone drivable:false safety patch", () => {
    const seeded = applyDirectorAuthoringActions(createDefaultDirectorProject(), [
      addCarAction,
      { action: "set_vehicle_profile", object_id: "hero-car" },
      { action: "update_object", object_id: "hero-car", patch: { locked: true } },
    ]);

    expect(() =>
      applyDirectorAuthoringActions(seeded.project, [
        { action: "set_vehicle_profile", object_id: "hero-car", profile: { mass_kg: 2000 } },
      ]),
    ).toThrow(/Object "hero-car" is locked/);
    expect(() =>
      applyDirectorAuthoringActions(seeded.project, [
        { action: "set_vehicle_profile", object_id: "hero-car", profile: { drivable: false, mass_kg: 2000 } },
      ]),
    ).toThrow(/Object "hero-car" is locked/);
    expect(() =>
      applyDirectorAuthoringActions(seeded.project, [{ action: "clear_vehicle_profile", object_id: "hero-car" }]),
    ).toThrow(/Locked object "hero-car" cannot have its vehicle profile cleared/);

    const disabled = applyDirectorAuthoringActions(seeded.project, [
      { action: "set_vehicle_profile", object_id: "hero-car", profile: { drivable: false } },
    ]);
    expect(disabled.project.objects.find((object) => object.id === "hero-car")?.vehicle).toEqual({
      ...createDefaultDirectorCarProfile(),
      drivable: false,
    });

    // The safety patch cannot author a brand-new profile onto a locked object.
    const lockedBare = applyDirectorAuthoringActions(createDefaultDirectorProject(), [
      { ...addCarAction, locked: true },
    ]);
    expect(() =>
      applyDirectorAuthoringActions(lockedBare.project, [
        { action: "set_vehicle_profile", object_id: "hero-car", profile: { drivable: false } },
      ]),
    ).toThrow(/Object "hero-car" is locked/);
  });

  it("clears idempotently with an informative note when no profile exists", () => {
    const seeded = applyDirectorAuthoringActions(createDefaultDirectorProject(), [addCarAction]);

    const cleared = applyDirectorAuthoringActions(seeded.project, [
      { action: "clear_vehicle_profile", object_id: "hero-car" },
    ]);
    expect(cleared.notes).toEqual([
      'Object "hero-car" had no vehicle profile; clear_vehicle_profile left it unchanged.',
    ]);
    expect(cleared.updated.object_ids).toEqual([]);

    const removed = applyDirectorAuthoringActions(seeded.project, [
      { action: "set_vehicle_profile", object_id: "hero-car" },
      { action: "clear_vehicle_profile", object_id: "hero-car" },
    ]);
    expect(removed.project.objects.find((object) => object.id === "hero-car")?.vehicle).toBeUndefined();
    expect(removed.updated.object_ids).toEqual(["hero-car"]);
    expect(safeParseDirectorProject(removed.project).success).toBe(true);

    expect(() =>
      applyDirectorAuthoringActions(seeded.project, [{ action: "clear_vehicle_profile", object_id: "ghost-car" }]),
    ).toThrow(/No object with id "ghost-car" exists/);
  });

  it("rejects malformed vehicle payloads at the schema boundary", () => {
    expect(
      directorAuthoringActionSchema.safeParse({
        action: "set_vehicle_profile",
        object_id: "hero-car",
        profile: { mass_kg: 50 },
      }).success,
    ).toBe(false);
    expect(
      directorAuthoringActionSchema.safeParse({
        action: "set_vehicle_profile",
        object_id: "hero-car",
        profile: { massKg: 1400 },
      }).success,
    ).toBe(false);
    expect(
      directorAuthoringActionSchema.safeParse({
        action: "set_vehicle_profile",
        object_id: "hero-car",
        profile: { kind: "boat" },
      }).success,
    ).toBe(false);
    expect(
      directorAuthoringActionSchema.safeParse({
        action: "set_vehicle_profile",
        object_id: "hero-car",
        profile: { camera: {} },
      }).success,
    ).toBe(false);
    expect(
      directorAuthoringActionSchema.safeParse({
        action: "set_vehicle_profile",
        object_id: "hero-car",
        profile: { exit_offsets: [] },
      }).success,
    ).toBe(false);
    expect(directorAuthoringActionSchema.safeParse({ action: "clear_vehicle_profile" }).success).toBe(false);
    expect(
      directorAuthoringActionSchema.safeParse({
        action: "set_vehicle_profile",
        object_id: "hero-car",
        profile: {},
      }).success,
    ).toBe(true);
  });
});

describe("character agent binding authoring", () => {
  it("binds, rebinds, and unbinds a character agent through semantic authoring", () => {
    const project = createDefaultDirectorProject();

    const bound = applyDirectorAuthoringActions(project, [
      {
        action: "bind_character_agent",
        object_id: "char_default_a",
        session_id: "dsh-session-1",
        role_id: "role-hero",
      },
    ]);
    expect(bound.updated.object_ids).toContain("char_default_a");
    expect(bound.project.objects.find((object) => object.id === "char_default_a")?.agentBinding).toEqual({
      mode: "possess",
      sessionId: "dsh-session-1",
      roleId: "role-hero",
    });

    const rebound = applyDirectorAuthoringActions(bound.project, [
      { action: "bind_character_agent", object_id: "char_default_a", profile_id: "profile-a" },
    ]);
    expect(rebound.project.objects.find((object) => object.id === "char_default_a")?.agentBinding).toEqual({
      mode: "possess",
      profileId: "profile-a",
    });
    expect(rebound.notes.join(" ")).toContain("rebound");

    const unbound = applyDirectorAuthoringActions(rebound.project, [
      { action: "unbind_character_agent", object_id: "char_default_a" },
    ]);
    expect(unbound.project.objects.find((object) => object.id === "char_default_a")?.agentBinding).toBeUndefined();
    expect(unbound.updated.object_ids).toContain("char_default_a");

    const repeat = applyDirectorAuthoringActions(unbound.project, [
      { action: "unbind_character_agent", object_id: "char_default_a" },
    ]);
    expect(repeat.updated.object_ids).toHaveLength(0);
    expect(repeat.notes.join(" ")).toContain("had no agent binding");
  });

  it("echoes the binding through the observe character summary", () => {
    const project = createDefaultDirectorProject();
    const bound = applyDirectorAuthoringActions(project, [
      { action: "bind_character_agent", object_id: "char_default_a", session_id: "dsh-session-1" },
    ]);
    const observation = observeDirectorProject(bound.project, ["characters"]) as {
      characters: Array<Record<string, unknown>>;
    };
    expect(observation.characters.find((entry) => entry.id === "char_default_a")?.agent_binding).toEqual({
      session_id: "dsh-session-1",
      profile_id: null,
      role_id: null,
      mode: "possess",
    });
  });

  it("requires at least one agent identity and rejects non-character targets", () => {
    const missingIdentity = directorAuthoringActionSchema.safeParse({
      action: "bind_character_agent",
      object_id: "char_default_a",
    });
    expect(missingIdentity.success).toBe(false);
    if (!missingIdentity.success) {
      expect(missingIdentity.error.issues.map((issue) => issue.message).join(" ")).toContain(
        "session_id or profile_id",
      );
    }

    const project = createDefaultDirectorProject();
    expect(() =>
      applyDirectorAuthoringActions(project, [
        { action: "bind_character_agent", object_id: "cam_object_1", session_id: "dsh-session-1" },
      ]),
    ).toThrow(/Only characters can have an agent binding/);
  });

  it("treats locked characters as write protected unless force is explicit", () => {
    const project = createDefaultDirectorProject();
    project.objects.find((object) => object.id === "char_default_a")!.locked = true;

    expect(() =>
      applyDirectorAuthoringActions(project, [
        { action: "bind_character_agent", object_id: "char_default_a", session_id: "dsh-session-1" },
      ]),
    ).toThrow(/locked/);

    const forced = applyDirectorAuthoringActions(project, [
      { action: "bind_character_agent", object_id: "char_default_a", session_id: "dsh-session-1", force: true },
    ]);
    expect(forced.project.objects.find((object) => object.id === "char_default_a")?.agentBinding).toMatchObject({
      sessionId: "dsh-session-1",
    });

    expect(() =>
      applyDirectorAuthoringActions(forced.project, [
        { action: "unbind_character_agent", object_id: "char_default_a" },
      ]),
    ).toThrow(/locked/);
    const releasedByForce = applyDirectorAuthoringActions(forced.project, [
      { action: "unbind_character_agent", object_id: "char_default_a", force: true },
    ]);
    expect(
      releasedByForce.project.objects.find((object) => object.id === "char_default_a")?.agentBinding,
    ).toBeUndefined();
  });

  it("keeps a failed batch atomic and blocks bindings through update_object patches", () => {
    const source = createDefaultDirectorProject();
    const before = structuredClone(source);
    expect(() =>
      applyDirectorAuthoringActions(source, [
        { action: "bind_character_agent", object_id: "char_default_a", session_id: "dsh-session-1" },
        { action: "unbind_character_agent", object_id: "missing-character" },
      ]),
    ).toThrow(/missing-character/);
    expect(source).toEqual(before);

    const smuggled = directorAuthoringActionSchema.safeParse({
      action: "update_object",
      object_id: "char_default_a",
      patch: { agent_binding: { session_id: "dsh-session-1", mode: "possess" } },
    });
    expect(smuggled.success).toBe(false);
  });
});
