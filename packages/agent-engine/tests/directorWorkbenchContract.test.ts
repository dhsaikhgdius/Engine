import { describe, expect, it } from "vitest";
import { createDefaultDirectorProject } from "../src/directorDefaultProject";
import { parseDirectorWorkbenchExecutableInput, parseDirectorWorkbenchInput } from "../src/directorWorkbenchContract";

describe("director workbench contract", () => {
  const projectRevision = `director-project-revision:v1:sha256:${"a".repeat(64)}`;

  it("accepts complete-workbench reads and atomic patches", () => {
    expect(
      parseDirectorWorkbenchInput({ op: "catalog", catalog: "character_assets", query: "Abe", limit: 12 }),
    ).toMatchObject({ success: true, operation: { offset: 0, limit: 12 } });
    expect(parseDirectorWorkbenchInput({ op: "observe" })).toMatchObject({ success: true });
    expect(
      parseDirectorWorkbenchInput({
        op: "patch",
        patches: [{ op: "replace", path: "/project/scene/backgroundColor", value: "#112233" }],
      }),
    ).toMatchObject({ success: true });
    expect(
      parseDirectorWorkbenchInput({
        op: "author",
        camera_id: "cam-main",
        subject_id: "agent-hero",
        delivery: {
          quality_profile: "video-gen",
          width: 1280,
          height: 720,
          render_passes: ["clean", "depth", "normal", "object-id", "mask"],
        },
        actions: [
          { action: "start_scene" },
          {
            action: "add_object",
            id: "agent-hero",
            name: "Agent Hero",
            kind: "character",
            placement_mode: "grounded",
          },
        ],
      }),
    ).toMatchObject({ success: true });
    expect(parseDirectorWorkbenchInput({ op: "audit", subject_id: "agent-hero" })).toMatchObject({ success: true });
    expect(
      parseDirectorWorkbenchInput({
        op: "shot_ir",
        camera_id: "cam-main",
        take_id: "take-main",
        coverage_shot_id: "coverage-main",
        frame: 24,
      }),
    ).toMatchObject({ success: true });
    expect(
      parseDirectorWorkbenchInput({
        op: "correct",
        audit_issues: [{ code: "character_below_ground", entity_ids: ["agent-box"] }],
      }),
    ).toMatchObject({ success: true });
    expect(
      parseDirectorWorkbenchInput({
        op: "observe",
        fields: ["cameras", "characters", "timeline"],
        since_audit: "workbench-audit-1",
      }),
    ).toMatchObject({ success: true });
    expect(parseDirectorWorkbenchInput({ op: "diff", since_turn: "workbench-turn-1" })).toMatchObject({
      success: true,
    });
    expect(parseDirectorWorkbenchInput({ op: "trace", limit: 10 })).toMatchObject({ success: true });
    expect(
      parseDirectorWorkbenchInput({
        op: "author",
        actions: [
          {
            action: "compose_blocking",
            layout: "facing",
            characters: [
              { id: "actor-a", name: "A", pose_preset_id: "stand", facing: "toward" },
              { id: "actor-b", name: "B", pose_preset_id: "hands-on-hips", facing: "toward" },
            ],
            camera: { id: "cam-blocking", object_id: "cam-blocking-rig", name: "Blocking Camera" },
          },
        ],
      }),
    ).toMatchObject({ success: true });
  });

  it("accepts explicit summary and full response detail", () => {
    expect(parseDirectorWorkbenchInput({ op: "observe", detail: "summary" })).toMatchObject({
      success: true,
      operation: { detail: "summary" },
    });
    expect(parseDirectorWorkbenchInput({ op: "audit", detail: "full" })).toMatchObject({
      success: true,
      operation: { detail: "full" },
    });
    expect(parseDirectorWorkbenchInput({ op: "observe", detail: "compact" })).toMatchObject({ success: false });
  });

  it("rejects native Blender apply payloads with a blender_native routing hint", () => {
    const apply = parseDirectorWorkbenchInput({
      op: "apply",
      operations: [{ op: "create_primitive", id: "hero-plinth", primitive: "cube" }],
    });
    expect(apply).toMatchObject({ success: false });
    if (!apply.success) {
      expect(apply.error).toContain("blender_native");
      expect(apply.error).toContain("create_blockout");
      expect(apply.error).not.toContain("Invalid discriminator");
    }
    const primitive = parseDirectorWorkbenchInput({ op: "create_primitive", id: "hero-plinth", primitive: "cube" });
    expect(primitive).toMatchObject({ success: false });
    if (!primitive.success) expect(primitive.error).toContain("blender_native");
  });

  it("rejects Stage primitive assembly on the public agent wire", () => {
    const assembled = parseDirectorWorkbenchInput({
      op: "author",
      actions: [
        {
          action: "add_object",
          id: "campus-box",
          name: "Campus box",
          kind: "prop",
          geometry_type: "box",
          placement_mode: "grounded",
        },
      ],
    });
    expect(assembled).toMatchObject({ success: false });
    if (!assembled.success) {
      expect(assembled.error).toContain("geometry_type");
      expect(assembled.error).toContain("blender_native");
      expect(assembled.error).toContain("generated_3d");
      expect(assembled.error).toContain("create_blockout");
      expect(assembled.error).toContain("create_opening");
    }
    const patched = parseDirectorWorkbenchInput({
      op: "author",
      actions: [
        {
          action: "update_object",
          object_id: "campus-box",
          patch: { geometry_type: "cylinder" },
        },
      ],
    });
    expect(patched).toMatchObject({ success: false });
    if (!patched.success) expect(patched.error).toContain("geometry_type");
    expect(
      parseDirectorWorkbenchInput({
        op: "author",
        actions: [
          {
            action: "add_object",
            id: "catalog-chair",
            name: "Chair",
            kind: "prop",
            asset_id: "flick:furniture:chair.glb",
            placement_mode: "grounded",
          },
        ],
      }),
    ).toMatchObject({ success: true });
  });

  it("accepts living world authoring and rejects malformed world payloads", () => {
    expect(
      parseDirectorWorkbenchInput({
        op: "author",
        actions: [
          {
            action: "set_world_settings",
            settings: { wind: { direction_degrees: 210, speed_mps: 8 }, weather: { preset: "storm" } },
          },
          { action: "add_world_effect", kind: "fire", anchor: { object_id: "campfire-logs" }, intensity: 1.6 },
          { action: "update_world_effect", effect_id: "fx_fire_1", patch: { wind_influence: 0.5 } },
          { action: "remove_world_effects", effect_ids: ["fx_fire_1"] },
          { action: "add_world_water_body", surface: { center: [0, 0, 0], size_x: 30, size_z: 12 } },
          { action: "update_world_water_body", body_id: "water_1", patch: { foam_intensity: 0.7 } },
          { action: "remove_world_water_bodies", body_ids: ["water_1"] },
          { action: "add_world_wildlife_group", species: "birds", altitude: { min_m: 10, max_m: 30 } },
          { action: "update_world_wildlife_group", group_id: "wildlife_birds_1", patch: { count: 32 } },
          { action: "remove_world_wildlife_groups", group_ids: ["wildlife_birds_1"] },
          {
            action: "add_world_road",
            points: [
              [-20, 0, -10],
              [0, 0, 12],
              [20, 0, -10],
            ],
            vehicle_count: 8,
            speed_kph: 50,
          },
          { action: "update_world_road", road_id: "road_1", patch: { loop: true, show_surface: false } },
          { action: "remove_world_roads", road_ids: ["road_1"] },
        ],
      }),
    ).toMatchObject({ success: true });
    expect(
      parseDirectorWorkbenchInput({
        op: "author",
        actions: [{ action: "remove_world_water_bodies", water_body_ids: ["pond_shuimu"] }],
      }),
    ).toMatchObject({
      success: true,
      operation: { actions: [{ action: "remove_world_water_bodies", body_ids: ["pond_shuimu"] }] },
    });
    expect(
      parseDirectorWorkbenchInput({
        op: "author",
        actions: [
          { action: "remove_object", id: "tree-left-1" },
          { action: "remove_object", id: "tree-left-2" },
          { action: "delete_object", object_id: "tree-right-1" },
          { action: "remove_objects", ids: ["tree-right-2"] },
        ],
      }),
    ).toMatchObject({
      success: true,
      operation: {
        actions: [
          { action: "delete_objects", object_ids: ["tree-left-1"] },
          { action: "delete_objects", object_ids: ["tree-left-2"] },
          { action: "delete_objects", object_ids: ["tree-right-1"] },
          { action: "delete_objects", object_ids: ["tree-right-2"] },
        ],
      },
    });
    expect(
      parseDirectorWorkbenchInput({
        op: "author",
        actions: [{ action: "delete_objects", object_ids: "obsolete" }],
      }),
    ).toMatchObject({
      success: true,
      operation: { actions: [{ action: "delete_objects", object_ids: ["obsolete"] }] },
    });
    expect(
      parseDirectorWorkbenchInput({
        op: "author",
        actions: [{ action: "remove_light", id: "key-light" }],
      }),
    ).toMatchObject({
      success: true,
      operation: { actions: [{ action: "delete_lights", light_ids: ["key-light"] }] },
    });
    expect(
      parseDirectorWorkbenchInput({
        op: "author",
        actions: [{ action: "remove_camera", id: "cam-hero" }],
      }),
    ).toMatchObject({
      success: true,
      operation: { actions: [{ action: "delete_cameras", camera_ids: ["cam-hero"] }] },
    });
    expect(
      parseDirectorWorkbenchInput({
        op: "author",
        actions: [{ action: "yeet_object", id: "tree-left-1" }],
      }),
    ).toMatchObject({
      success: false,
      error: expect.stringContaining("not a valid author action"),
    });
    expect(
      parseDirectorWorkbenchInput({
        op: "author",
        actions: [{ action: "update_world_water_body", water_body_id: "water_1", patch: { foam_intensity: 0.8 } }],
      }),
    ).toMatchObject({
      success: true,
      operation: { actions: [{ action: "update_world_water_body", body_id: "water_1" }] },
    });
    expect(
      parseDirectorWorkbenchInput({
        op: "author",
        actions: [{ action: "add_world_effect", kind: "lava" }],
      }),
    ).toMatchObject({ success: false });
    expect(
      parseDirectorWorkbenchInput({
        op: "author",
        actions: [{ action: "set_world_settings", settings: {} }],
      }),
    ).toMatchObject({ success: false });
    expect(
      parseDirectorWorkbenchInput({
        op: "author",
        actions: [{ action: "update_world_water_body", body_id: "water_1", patch: {} }],
      }),
    ).toMatchObject({ success: false });
    expect(
      parseDirectorWorkbenchInput({
        op: "author",
        actions: [{ action: "add_world_road", points: [[0, 0, 0]] }],
      }),
    ).toMatchObject({ success: false });
  });

  it("validates reusable macros and explicit memory operations", () => {
    expect(
      parseDirectorWorkbenchInput({
        op: "macro",
        command: {
          action: "save",
          macro: {
            id: "rename-object",
            name: "Rename object",
            description: "",
            parameters: [
              { name: "object_id", label: "Object", type: "string", default: "object-id" },
              { name: "name", label: "Name", type: "string", default: "Hero" },
            ],
            actions: [
              {
                action: "update_object",
                object_id: { $param: "object_id" },
                patch: { name: { $param: "name" } },
              },
            ],
          },
        },
      }),
    ).toMatchObject({ success: true });
    expect(
      parseDirectorWorkbenchInput({
        op: "run_macro",
        macro_id: "rename-object",
        parameters: { object_id: "hero", name: "Lead" },
        expected_revision: projectRevision,
        idempotency_key: "macro-run-001",
      }),
    ).toMatchObject({ success: true });
    expect(
      parseDirectorWorkbenchExecutableInput({
        op: "run_macro",
        macro_id: "rename-object",
        parameters: {},
      }),
    ).toMatchObject({ success: false });
    expect(
      parseDirectorWorkbenchInput({
        op: "memory",
        command: {
          action: "pin",
          memory_id: "continuity-hero",
          text: "Hero enters from camera left.",
          scope: "scene",
          scene_id: "scene-a",
        },
      }),
    ).toMatchObject({ success: true });
    expect(
      parseDirectorWorkbenchInput({
        op: "memory",
        command: { action: "pin", memory_id: "bad", text: "Missing scene", scope: "scene" },
      }),
    ).toMatchObject({ success: false });
    expect(
      parseDirectorWorkbenchExecutableInput({
        op: "production",
        command: { action: "rename_scene", scene_id: "scene-a", title: "Opening" },
      }),
    ).toMatchObject({ success: false });
    expect(
      parseDirectorWorkbenchExecutableInput({
        op: "generation",
        command: {
          action: "submit",
          kind: "image.generate",
          workflow_id: "workflow-a",
          prompt: "A city",
        },
      }),
    ).toMatchObject({ success: false });
  });

  it("validates the practical shape of an optional author delivery profile", () => {
    const base = {
      op: "author",
      actions: [{ action: "delete_objects", object_ids: ["obsolete"] }],
    };

    expect(
      parseDirectorWorkbenchInput({
        ...base,
        delivery: { quality_profile: "blocking", width: 960, height: 540, render_passes: ["clean"] },
      }),
    ).toMatchObject({ success: true });
    expect(parseDirectorWorkbenchInput({ ...base, delivery: { width: 960 } })).toMatchObject({
      success: false,
      error: expect.stringContaining("supplied together"),
    });
    expect(
      parseDirectorWorkbenchInput({
        ...base,
        delivery: { quality_profile: "video-gen", render_passes: ["clean", "depth"] },
      }),
    ).toMatchObject({ success: true });
    expect(parseDirectorWorkbenchInput({ ...base, delivery: { render_passes: ["depth"] } })).toMatchObject({
      success: true,
    });
    expect(
      parseDirectorWorkbenchInput({ ...base, delivery: { quality_profile: "cinematic", format: "png" } }),
    ).toMatchObject({ success: false, error: expect.stringContaining("unsupported fields") });
  });

  it("validates lightweight author evidence and bounded spatial queries", () => {
    const authored = parseDirectorWorkbenchInput({
      op: "author",
      actions: [{ action: "delete_objects", object_ids: ["obsolete"] }],
      evidence: {},
    });
    expect(authored).toMatchObject({
      success: true,
      operation: { evidence: { kind: "camera_frame", width: 640, height: 360 } },
    });
    expect(
      parseDirectorWorkbenchInput({
        op: "author",
        actions: [{ action: "delete_objects", object_ids: ["obsolete"] }],
        evidence: { width: 4096, height: 4096 },
      }),
    ).toMatchObject({ success: false, error: expect.stringContaining("cannot exceed") });

    expect(parseDirectorWorkbenchInput({ op: "query_objects", spatial: { mode: "frustum" } })).toMatchObject({
      success: true,
      operation: { include_hidden: false, max_results: 50 },
    });
    expect(
      parseDirectorWorkbenchInput({
        op: "query_objects",
        spatial: { mode: "aabb", min: [1, 0, 0], max: [0, 1, 1] },
      }),
    ).toMatchObject({ success: false, error: expect.stringContaining("min must not exceed max") });
    expect(parseDirectorWorkbenchInput({ op: "query_objects", name_pattern: "door" })).toMatchObject({
      success: true,
      operation: { name_pattern: "door", include_hidden: false, max_results: 50 },
    });
    expect(parseDirectorWorkbenchInput({ op: "query_objects", filter: { name_pattern: "门" } })).toMatchObject({
      success: true,
      operation: { name_pattern: "门" },
    });
    expect(parseDirectorWorkbenchInput({ op: "query_objects", kind: "prop" })).toMatchObject({
      success: true,
      operation: { kind: "prop" },
    });
    expect(parseDirectorWorkbenchInput({ op: "query_objects", object_list_id: "object_list_1" })).toMatchObject({
      success: true,
      operation: { object_list_id: "object_list_1", include_hidden: false, max_results: 50 },
    });
    expect(
      parseDirectorWorkbenchInput({ op: "query_objects", filter: { object_list_id: "object_list_2" } }),
    ).toMatchObject({
      success: true,
      operation: { object_list_id: "object_list_2" },
    });
    expect(parseDirectorWorkbenchInput({ op: "query_objects" })).toMatchObject({
      success: false,
      error: expect.stringMatching(/name_pattern.*"door".*object_list_id/s),
    });
    expect(parseDirectorWorkbenchInput({ op: "query_objects", spatial: "frustum" })).toMatchObject({
      success: false,
      error: expect.stringContaining("spatial must be"),
    });
    expect(parseDirectorWorkbenchInput({ op: "diff" })).toMatchObject({
      success: false,
      error: expect.stringContaining('{"op":"diff","since_turn":"<turn-id>"}'),
    });
    expect(
      parseDirectorWorkbenchInput({ op: "inspect", entity: "spill_4fac470df0bcf747", id: "cam-axis" }),
    ).toMatchObject({
      success: false,
      error: expect.stringContaining('{"op":"inspect","entity":"object","id":"door-1"}'),
    });
    expect(parseDirectorWorkbenchInput({ op: "inspect", id: "door-1" })).toMatchObject({
      success: false,
      error: expect.stringContaining('{"op":"inspect","entity":"camera","id":"cam-main"}'),
    });
    expect(parseDirectorWorkbenchInput({ op: "inspect", object_id: "hero-id" })).toMatchObject({
      success: true,
      operation: { op: "inspect", entity: "object", id: "hero-id" },
    });
    expect(parseDirectorWorkbenchInput({ op: "inspect", camera_id: "cam-main" })).toMatchObject({
      success: true,
      operation: { op: "inspect", entity: "camera", id: "cam-main" },
    });
  });

  it("strictly validates Agent-native catalog discovery", () => {
    expect(
      parseDirectorWorkbenchInput({
        op: "catalog",
        catalog: "assets",
        query: "bear",
        category: "animals",
        kind: "prop",
        preview_status: "runtime",
      }),
    ).toMatchObject({ success: true, operation: { offset: 0, limit: 25 } });
    expect(
      parseDirectorWorkbenchInput({ op: "inspect", entity: "catalog_asset", id: "flick:animals:cat.glb" }),
    ).toMatchObject({ success: true });
    expect(parseDirectorWorkbenchInput({ op: "catalog", catalog: "character_motions" })).toMatchObject({
      success: true,
      operation: { offset: 0, limit: 25 },
    });
    expect(parseDirectorWorkbenchInput({ op: "catalog", catalog: "characters" })).toMatchObject({ success: false });
    expect(parseDirectorWorkbenchInput({ op: "catalog", catalog: "character_assets", limit: 101 })).toMatchObject({
      success: false,
    });
    expect(parseDirectorWorkbenchInput({ op: "catalog", catalog: "character_assets", offset: -1 })).toMatchObject({
      success: false,
    });
    expect(
      parseDirectorWorkbenchInput({ op: "catalog", catalog: "character_assets", query: "Abe", url: "/guessed.glb" }),
    ).toMatchObject({ success: false });
    expect(
      parseDirectorWorkbenchInput({ op: "catalog", catalog: "character_motions", category: "characters" }),
    ).toMatchObject({ success: false });
    expect(parseDirectorWorkbenchInput({ op: "catalog", catalog: "character_assets", kind: "prop" })).toMatchObject({
      success: false,
    });
  });

  it("normalizes the catalog aliases emitted by hosted models", () => {
    expect(parseDirectorWorkbenchInput({ op: "catalog" })).toMatchObject({
      success: true,
      operation: { catalog: "assets" },
    });
    for (const input of [
      { op: "catalog", target: "character_assets" },
      { op: "catalog", catalog_type: "character_motions" },
      { op: "catalog", source: "assets", query: "door" },
      { op: "catalog", collection: "project_assets" },
    ]) {
      expect(parseDirectorWorkbenchInput(input)).toMatchObject({ success: true });
    }
  });

  it("normalizes legacy bounded object-query shapes", () => {
    expect(parseDirectorWorkbenchInput({ op: "query_objects", camera_id: "cam-main", max_objects: 12 })).toMatchObject({
      success: true,
      operation: {
        spatial: { mode: "frustum", camera_id: "cam-main" },
        max_results: 12,
      },
    });
    expect(
      parseDirectorWorkbenchInput({
        op: "query_objects",
        spatial: { frustum: { camera_id: "cam-main" } },
        limit: 8,
      }),
    ).toMatchObject({
      success: true,
      operation: { spatial: { mode: "frustum", camera_id: "cam-main" }, max_results: 8 },
    });
    expect(
      parseDirectorWorkbenchInput({
        op: "query_objects",
        mode: "radius",
        center: [0, 1, 0],
        radius: 10,
      }),
    ).toMatchObject({
      success: true,
      operation: { spatial: { mode: "radius", center: [0, 1, 0], radius_m: 10 } },
    });
    expect(
      parseDirectorWorkbenchInput({
        op: "query_objects",
        mode: "aabb",
        min: [-5, -0.5, -5],
        max: [5, 5, 5],
      }),
    ).toMatchObject({
      success: true,
      operation: { spatial: { mode: "aabb", min: [-5, -0.5, -5], max: [5, 5, 5] } },
    });
    expect(parseDirectorWorkbenchInput({ op: "query_objects", mode: "name", name_pattern: "door" })).toMatchObject({
      success: true,
      operation: { name_pattern: "door" },
    });
  });

  it("strictly validates live project_assets discovery", () => {
    expect(
      parseDirectorWorkbenchInput({
        op: "catalog",
        catalog: "project_assets",
        query: "机器人",
        kind: "prop",
        asset_source: "generated",
      }),
    ).toMatchObject({ success: true, operation: { offset: 0, limit: 25 } });
    expect(parseDirectorWorkbenchInput({ op: "catalog", catalog: "project_assets" })).toMatchObject({ success: true });
    expect(
      parseDirectorWorkbenchInput({ op: "catalog", catalog: "project_assets", asset_source: "remote" }),
    ).toMatchObject({ success: false });
    expect(parseDirectorWorkbenchInput({ op: "catalog", catalog: "assets", asset_source: "generated" })).toMatchObject({
      success: false,
      error: expect.stringContaining("project_assets"),
    });
    expect(
      parseDirectorWorkbenchInput({ op: "catalog", catalog: "project_assets", category: "animals" }),
    ).toMatchObject({ success: false });
    expect(
      parseDirectorWorkbenchInput({ op: "catalog", catalog: "project_assets", preview_status: "ready" }),
    ).toMatchObject({ success: false });
    expect(parseDirectorWorkbenchInput({ op: "catalog", catalog: "project_assets", asset_id: "a" })).toMatchObject({
      success: false,
    });
  });

  it("rejects ambiguous history references", () => {
    expect(
      parseDirectorWorkbenchInput({
        op: "correct",
        audit_token: "workbench-audit-1",
        audit_issues: [{ code: "collapsed_scale", entity_ids: ["box"] }],
      }),
    ).toMatchObject({ success: false });
    expect(
      parseDirectorWorkbenchInput({
        op: "diff",
        since_turn: "workbench-turn-1",
        since_audit: "workbench-audit-1",
      }),
    ).toMatchObject({ success: false });
    expect(
      parseDirectorWorkbenchInput({
        op: "observe",
        since_revision: projectRevision,
        since_turn: "workbench-turn-1",
      }),
    ).toMatchObject({ success: false });
  });

  it("accepts bounded revision deltas and object hierarchy observations", () => {
    expect(
      parseDirectorWorkbenchInput({
        op: "observe",
        fields: ["objects"],
        since_revision: projectRevision,
        max_changes: 40,
      }),
    ).toMatchObject({ success: true });
    expect(
      parseDirectorWorkbenchInput({
        op: "observe",
        fields: ["objects"],
        object_mode: "hierarchy",
        max_objects: 120,
      }),
    ).toMatchObject({ success: true });
    expect(
      parseDirectorWorkbenchInput({
        op: "observe",
        fields: ["ui"],
        since_revision: projectRevision,
      }),
    ).toMatchObject({ success: false });
    expect(
      parseDirectorWorkbenchInput({
        op: "observe",
        fields: ["cameras"],
        object_mode: "hierarchy",
      }),
    ).toMatchObject({ success: false });
  });

  it("lets the public boundary parse naive mutations before it injects a guard", () => {
    const guardedOperations = [
      {
        op: "patch",
        patches: [{ op: "replace", path: "/project/scene/backgroundColor", value: "#112233" }],
        expected_revision: projectRevision,
        idempotency_key: "scene-color-001",
      },
      {
        op: "author",
        actions: [{ action: "set_scene", patch: { backgroundColor: "#112233" } }],
        expected_revision: projectRevision,
      },
      { op: "correct", audit_token: "workbench-audit-1", expected_revision: projectRevision },
      { op: "replace_project", project: createDefaultDirectorProject(), expected_revision: projectRevision },
      { op: "undo", expected_revision: projectRevision },
    ];

    guardedOperations.forEach((operation) => {
      expect(parseDirectorWorkbenchInput(operation)).toMatchObject({ success: true });
    });
    expect(parseDirectorWorkbenchInput({ op: "undo", unconditional: true })).toMatchObject({ success: true });
    expect(parseDirectorWorkbenchInput({ op: "undo" })).toMatchObject({ success: true });
  });

  it("requires a revision guard at the remote browser execution boundary", () => {
    expect(parseDirectorWorkbenchExecutableInput({ op: "undo" })).toMatchObject({ success: false });
    expect(parseDirectorWorkbenchExecutableInput({ op: "undo", expected_revision: projectRevision })).toMatchObject({
      success: true,
    });
    expect(parseDirectorWorkbenchExecutableInput({ op: "undo", unconditional: true })).toMatchObject({
      success: true,
    });
    expect(parseDirectorWorkbenchExecutableInput({ op: "undo", unconditional: false })).toMatchObject({
      success: false,
      error: expect.stringContaining("expected_revision"),
    });
    expect(
      parseDirectorWorkbenchExecutableInput({ op: "undo", expected_revision: projectRevision, unconditional: false }),
    ).toMatchObject({ success: true });
    expect(parseDirectorWorkbenchExecutableInput({ op: "capture", camera_id: "cam_1", frame: 0 })).toMatchObject({
      success: true,
    });
    expect(parseDirectorWorkbenchExecutableInput({ op: "shot_package", camera_id: "cam_1" })).toMatchObject({
      success: true,
    });
    expect(parseDirectorWorkbenchExecutableInput({ op: "deliver", camera_id: "cam_1" })).toMatchObject({
      success: true,
    });
    expect(
      parseDirectorWorkbenchExecutableInput({
        op: "capture",
        camera_id: "cam_1",
        frame: 0,
        expected_revision: projectRevision,
      }),
    ).toMatchObject({ success: true });
    expect(
      parseDirectorWorkbenchExecutableInput({
        op: "generated_3d",
        command: { action: "promote", job_id: "generated-job-1" },
      }),
    ).toMatchObject({ success: false });
    expect(
      parseDirectorWorkbenchExecutableInput({
        op: "generated_3d",
        command: {
          action: "promote",
          job_id: "generated-job-1",
          expected_revision: projectRevision,
          idempotency_key: "generated-promote-browser-v1",
        },
      }),
    ).toMatchObject({ success: true });
    expect(
      parseDirectorWorkbenchExecutableInput({
        op: "storyboard_artifact",
        command: { action: "capture_missing", expected_revision: projectRevision },
      }),
    ).toMatchObject({ success: false });
  });

  it("parses general compare operations with typed sources and a default stage candidate", () => {
    const compared = parseDirectorWorkbenchInput({
      op: "compare",
      reference: { kind: "media", media_id: "gallery-still-1" },
    });
    expect(compared).toMatchObject({
      success: true,
      operation: {
        op: "compare",
        reference: { kind: "media", media_id: "gallery-still-1" },
        candidate: { kind: "stage", frame: 0, width: 640, height: 360 },
      },
    });
    expect(
      parseDirectorWorkbenchInput({
        op: "compare",
        reference: { kind: "reconstruction_keyframe", job_id: "job-1", view_id: "view-01" },
        candidate: { kind: "stage", camera_id: "capture-view-camera-01", frame: 12 },
        grid: { rows: 4, cols: 6 },
      }),
    ).toMatchObject({
      success: true,
      operation: { candidate: { camera_id: "capture-view-camera-01", width: 640, height: 360 } },
    });
    // compare is read-only: it needs no revision guard at the browser boundary.
    expect(
      parseDirectorWorkbenchExecutableInput({ op: "compare", reference: { kind: "media", media_id: "still-1" } }),
    ).toMatchObject({ success: true });
  });

  it("rejects malformed compare sources and oversized compare rasters", () => {
    expect(parseDirectorWorkbenchInput({ op: "compare" })).toMatchObject({ success: false });
    expect(
      parseDirectorWorkbenchInput({ op: "compare", reference: { kind: "media" } }),
    ).toMatchObject({ success: false });
    expect(
      parseDirectorWorkbenchInput({
        op: "compare",
        reference: { kind: "stage", width: 2048, height: 2048 },
      }),
    ).toMatchObject({ success: false, error: expect.stringContaining("2073600") });
    expect(
      parseDirectorWorkbenchInput({
        op: "compare",
        reference: { kind: "media", media_id: "still-1" },
        grid: { rows: 32 },
      }),
    ).toMatchObject({ success: false });
    expect(
      parseDirectorWorkbenchInput({
        op: "compare",
        reference: { kind: "media", media_id: "still-1" },
        threshold: 0.8,
      }),
    ).toMatchObject({ success: false, error: expect.stringContaining('"threshold"') });
  });

  it("names the offending fields when the input carries unrecognized keys", () => {
    expect(parseDirectorWorkbenchInput({ op: "deliver", camera_id: "cam_1", quality_gate: "strict" })).toMatchObject({
      success: false,
      error: expect.stringContaining('contains unsupported fields "quality_gate"'),
    });
    expect(parseDirectorWorkbenchInput({ op: "audit", scope: "scene" })).toMatchObject({
      success: false,
      error: expect.stringContaining('contains unsupported fields "scope"'),
    });
    expect(
      parseDirectorWorkbenchExecutableInput({ op: "capture", camera_id: "cam_1", frame: 0, quality_gate: true }),
    ).toMatchObject({
      success: false,
      error: expect.stringContaining('"quality_gate"'),
    });
  });

  it("validates replace_project with the DirectorProject runtime schema", () => {
    expect(
      parseDirectorWorkbenchInput({
        op: "replace_project",
        project: createDefaultDirectorProject(),
        expected_revision: projectRevision,
      }),
    ).toMatchObject({ success: true });
    expect(
      parseDirectorWorkbenchInput({ op: "replace_project", project: {}, expected_revision: projectRevision }),
    ).toMatchObject({ success: false, error: expect.stringContaining("project") });
  });

  it("rejects empty or ambiguous revision guards", () => {
    expect(parseDirectorWorkbenchInput({ op: "undo", expected_revision: "" })).toMatchObject({
      success: false,
      error: expect.stringContaining("expected_revision"),
    });
    expect(parseDirectorWorkbenchInput({ op: "undo", unconditional: false })).toMatchObject({ success: true });
    expect(
      parseDirectorWorkbenchInput({ op: "undo", expected_revision: projectRevision, unconditional: false }),
    ).toMatchObject({ success: true });
    expect(
      parseDirectorWorkbenchInput({ op: "undo", expected_revision: projectRevision, unconditional: true }),
    ).toMatchObject({
      success: false,
      error: expect.stringContaining("cannot be used together"),
    });
    expect(parseDirectorWorkbenchInput({ op: "observe", expected_revision: projectRevision })).toMatchObject({
      success: false,
    });
  });

  it("accepts short natural idempotency keys and rejects malformed ones", () => {
    ["fix-1", "retry_2", "a"].forEach((key) => {
      expect(parseDirectorWorkbenchInput({ op: "undo", idempotency_key: key })).toMatchObject({ success: true });
    });
    expect(parseDirectorWorkbenchInput({ op: "undo", idempotency_key: "" })).toMatchObject({
      success: false,
      error: expect.stringContaining("idempotency_key"),
    });
    expect(parseDirectorWorkbenchInput({ op: "undo", idempotency_key: "-leading-dash" })).toMatchObject({
      success: false,
      error: expect.stringContaining("idempotency_key"),
    });
    expect(parseDirectorWorkbenchInput({ op: "undo", idempotency_key: "has space" })).toMatchObject({
      success: false,
      error: expect.stringContaining("idempotency_key"),
    });
  });

  it("strictly validates the portable Shot IR request", () => {
    expect(parseDirectorWorkbenchInput({ op: "shot_ir", frame: -1 })).toMatchObject({ success: false });
    expect(parseDirectorWorkbenchInput({ op: "shot_ir", frame: 1.5 })).toMatchObject({ success: false });
    expect(parseDirectorWorkbenchInput({ op: "shot_ir", format: "prompt" })).toMatchObject({ success: false });
  });

  it("validates film-language framing actions and the camera move read", () => {
    expect(
      parseDirectorWorkbenchInput({
        op: "author",
        actions: [
          {
            action: "frame_shot",
            camera_id: "cam-main",
            subject_object_id: "hero",
            size: "medium-close-up",
            view: "profile",
            side: "left",
            level: "knee",
            activate: true,
          },
          { action: "mark_camera_move", camera_id: "cam-main", frame: 0 },
        ],
      }),
    ).toMatchObject({ success: true });
    expect(
      parseDirectorWorkbenchInput({
        op: "author",
        actions: [{ action: "frame_shot", camera_id: "cam-main", subject_object_id: "hero", size: "huge" }],
      }),
    ).toMatchObject({ success: false });
    expect(
      parseDirectorWorkbenchInput({
        op: "author",
        actions: [{ action: "mark_camera_move", camera_id: "cam-main", frame: -1 }],
      }),
    ).toMatchObject({ success: false });
    expect(
      parseDirectorWorkbenchInput({
        op: "describe_camera_move",
        camera_id: "cam-main",
        subject_object_id: "hero",
        from_frame: 0,
        to_frame: 48,
      }),
    ).toMatchObject({ success: true });
    expect(parseDirectorWorkbenchInput({ op: "describe_camera_move", camera_id: "cam-main" })).toMatchObject({
      success: false,
    });
    expect(
      parseDirectorWorkbenchInput({
        op: "describe_camera_move",
        camera_id: "cam-main",
        subject_object_id: "hero",
        from_frame: 48,
        to_frame: 0,
      }),
    ).toMatchObject({ success: false, error: expect.stringContaining("from_frame must be before to_frame") });
  });

  it("validates exact-frame clean and auxiliary capture requests", () => {
    expect(
      parseDirectorWorkbenchInput({
        op: "capture",
        camera_id: "cam-main",
        frame: 48,
        render_pass: "normal",
        clean_plate: true,
        expected_revision: projectRevision,
        width: 1920,
        height: 1080,
      }),
    ).toMatchObject({ success: true });
    expect(
      parseDirectorWorkbenchInput({
        op: "capture",
        camera_id: "cam-main",
        frame: 48,
        render_pass: "clay",
      }),
    ).toMatchObject({ success: true });
    expect(
      parseDirectorWorkbenchInput({
        op: "capture",
        camera_id: "cam-main",
        frame: 48,
        expected_revision: projectRevision,
        render_pass: "wireframe",
      }),
    ).toMatchObject({
      success: false,
    });
    expect(
      parseDirectorWorkbenchInput({
        op: "capture",
        camera_id: "cam-main",
        frame: 48,
        expected_revision: projectRevision,
        width: 1920,
      }),
    ).toMatchObject({
      success: false,
      error: expect.stringContaining("supplied together"),
    });
    expect(
      parseDirectorWorkbenchInput({
        op: "capture",
        camera_id: "cam-main",
        frame: 48,
        expected_revision: projectRevision,
        width: 4096,
        height: 4096,
      }),
    ).toMatchObject({
      success: false,
      error: expect.stringContaining("Agent wire"),
    });
    expect(parseDirectorWorkbenchInput({ op: "capture" })).toMatchObject({
      success: false,
    });
  });

  it("normalizes a multi-pass shot package request", () => {
    expect(
      parseDirectorWorkbenchInput({
        op: "shot_package",
        take_id: "take-main",
        coverage_shot_id: "coverage-main",
        frame: 24,
        render_passes: [
          "clean",
          "albedo",
          "roughness",
          "metalness",
          "emissive",
          "ao",
          "shadow",
          "depth",
          "normal",
          "object-id",
          "mask",
        ],
      }),
    ).toMatchObject({ success: true, operation: { width: 1280, height: 720 } });
  });

  it("validates direct storyboard capture and print artifacts", () => {
    expect(
      parseDirectorWorkbenchInput({
        op: "storyboard_artifact",
        command: {
          action: "capture_thumbnail",
          shot_id: "shot-main",
        },
      }),
    ).toMatchObject({ success: true });
    expect(
      parseDirectorWorkbenchInput({
        op: "storyboard_artifact",
        command: {
          action: "export_pdf",
          scope: "selected",
          shot_ids: ["shot-main"],
          paper_size: "letter",
          orientation: "portrait",
          columns: 4,
          artifact: "verification-package",
        },
      }),
    ).toMatchObject({
      success: true,
      operation: {
        command: {
          include_metadata: true,
          include_action: true,
          download: true,
        },
      },
    });
    expect(
      parseDirectorWorkbenchInput({
        op: "storyboard_artifact",
        command: {
          action: "export_pdf",
          scope: "selected",
        },
      }),
    ).toMatchObject({ success: false, error: expect.stringContaining("shot_id") });
    expect(
      parseDirectorWorkbenchInput({
        op: "storyboard_artifact",
        command: { action: "capture_missing" },
      }),
    ).toMatchObject({ success: true });
  });

  it("normalizes one-call delivery requests", () => {
    expect(
      parseDirectorWorkbenchInput({
        op: "deliver",
        camera_id: "cam-main",
        subject_id: "actor-main",
        frame: 48,
        quality_profile: "video-gen",
        render_passes: ["clean", "depth", "normal", "object-id", "mask"],
      }),
    ).toMatchObject({
      success: true,
      operation: { width: 1280, height: 720, quality_profile: "video-gen" },
    });
    expect(
      parseDirectorWorkbenchInput({
        op: "deliver",
        render_passes: ["depth"],
      }),
    ).toMatchObject({ success: true });
    expect(
      parseDirectorWorkbenchInput({
        op: "deliver",
        expected_revision: projectRevision,
        width: 4096,
        height: 4096,
      }),
    ).toMatchObject({ success: false, error: expect.stringContaining("Agent wire") });
  });

  it("accepts production observation and exact production entity inspection", () => {
    expect(parseDirectorWorkbenchInput({ op: "observe", fields: ["production"] })).toMatchObject({ success: true });
    ["performance_take", "coverage_sequence", "coverage_shot"].forEach((entity) => {
      expect(parseDirectorWorkbenchInput({ op: "inspect", entity, id: "production-id" })).toMatchObject({
        success: true,
      });
    });
  });

  it("accepts production CRUD and rejects ambiguous scene duplication", () => {
    expect(
      parseDirectorWorkbenchInput({
        op: "production",
        command: {
          action: "duplicate_scene",
          source_scene_id: "scene-source",
          scene_id: "scene-copy",
          expected_revision: 7,
        },
      }),
    ).toMatchObject({
      success: true,
      operation: {
        command: { activate: true, expected_revision: 7 },
      },
    });
    expect(
      parseDirectorWorkbenchInput({
        op: "production",
        command: {
          action: "duplicate_scene",
          source_scene_id: "scene-same",
          scene_id: "scene-same",
        },
      }),
    ).toMatchObject({ success: false, error: expect.stringContaining("must be different") });
    expect(
      parseDirectorWorkbenchInput({
        op: "production",
        command: {
          action: "delete_scene",
          scene_id: "scene-last",
          replacement: { scene_id: "scene-last", title: "X" },
        },
      }),
    ).toMatchObject({ success: false, error: expect.stringContaining("must differ") });
  });

  it("accepts schema-owned performance take and coverage author actions", () => {
    expect(
      parseDirectorWorkbenchInput({
        op: "author",
        actions: [
          {
            action: "add_performance_take",
            take: {
              id: "take-agent",
              name: "Agent Take",
              frameStart: 0,
              frameEnd: 48,
              objectIds: ["actor-agent"],
              entityTracks: [],
            },
          },
          {
            action: "add_coverage_sequence",
            sequence: { id: "coverage-agent", name: "Agent Coverage", shots: [] },
          },
          {
            action: "add_coverage_shot",
            sequence_id: "coverage-agent",
            shot: {
              id: "coverage-agent-wide",
              name: "Wide",
              takeId: "take-agent",
              cameraId: "cam-agent",
              frameStart: 0,
              frameEnd: 48,
            },
          },
        ],
      }),
    ).toMatchObject({ success: true });
  });

  it("accepts bounded character IK set and clear author actions", () => {
    expect(
      parseDirectorWorkbenchInput({
        op: "author",
        actions: [
          {
            action: "set_character_ik",
            object_id: "hero",
            effector: "leftHand",
            target: [-0.8, 1.4, 0.25],
            pole: [-0.65, 1.1, 0.9],
            weight: 0.8,
            reach_clamp: 0.95,
          },
          { action: "clear_character_ik", object_id: "hero", effector: "rightFoot" },
        ],
      }),
    ).toMatchObject({ success: true });

    expect(
      parseDirectorWorkbenchInput({
        op: "author",
        actions: [
          {
            action: "set_character_ik",
            object_id: "hero",
            effector: "tail",
            target: [0, 1, 0],
            pole: [0, 0, 1],
          },
        ],
      }),
    ).toMatchObject({ success: false });
  });

  it("accepts only canonical Agent-authored humanoid pose controls", () => {
    expect(
      parseDirectorWorkbenchInput({
        op: "author",
        actions: [
          {
            action: "set_character_pose_controls",
            object_id: "hero",
            mode: "merge",
            controls: [
              { control: "head.yaw", value: 25 },
              { control: "leftShoulder.pitch", value: -40 },
            ],
          },
          { action: "clear_character_pose_controls", object_id: "background-extra" },
        ],
      }),
    ).toMatchObject({ success: true });

    expect(
      parseDirectorWorkbenchInput({
        op: "author",
        actions: [
          {
            action: "set_character_pose_controls",
            object_id: "hero",
            controls: [{ control: "head.rotate", value: 25 }],
          },
        ],
      }),
    ).toMatchObject({ success: false });
  });

  it("rejects paths outside the validated project and UI roots", () => {
    expect(
      parseDirectorWorkbenchInput({
        op: "patch",
        patches: [{ op: "replace", path: "/undoStack/0", value: {} }],
      }),
    ).toMatchObject({ success: false });
  });

  it("explains how to repair a set_scene action with no patch", () => {
    const result = parseDirectorWorkbenchInput({
      op: "author",
      actions: [{ action: "set_scene" }],
    });

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("set_scene must include at least one global scene field"),
    });
    if (result.success) return;
    expect(result.error).toContain("delete this set_scene action");
    expect(result.error).not.toContain("expected object");
  });

  it("names a missing update_camera identity field", () => {
    const result = parseDirectorWorkbenchInput({
      op: "author",
      actions: [{ action: "update_camera", patch: { focal_length_mm: 50 } }],
    });

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("camera_id is missing"),
    });
    if (result.success) return;
    expect(result.error).toContain("created in the same batch");
    expect(result.error).not.toContain("expected string");
  });

  it("normalizes concise camera action modes at the tool boundary", () => {
    const result = parseDirectorWorkbenchInput({
      op: "author",
      actions: [
        {
          action: "add_camera",
          id: "camera-short",
          object_id: "camera-short-rig",
          name: "Camera Short",
          position: [0, 2, 8],
          target: [0, 1, 0],
          action_mode: "still",
        },
      ],
    });

    expect(result).toMatchObject({
      success: true,
      operation: { actions: [{ action_mode: "still" }] },
    });
  });
});
