import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultDirectorProject, useDirectorStore } from "../../src/comprehensive/editor/store/directorStore";
import { getCameraViewSnapshotFromShot, getDirectorProjectRevision } from "@director/project-schema";
import { getDirectorAgentCatalogAsset } from "@director/agent-engine/asset-catalog";
import { directorAuthoringActionSchema } from "@director/agent-engine/authoring";
import {
  executeDirectorWorkbenchAgentOperation,
  executeDirectorWorkbenchOperation,
  resetDirectorWorkbenchRuntimeForTests,
} from "../../src/agent/directorWorkbenchExecutor";
import {
  setDirectorPagePlaybackHandler,
  setDirectorPageViewportHandler,
} from "../../src/comprehensive/editor/assistant/pageStateBridge";
import { useTimelineRuntimeStore } from "../../src/comprehensive/editor/runtime/timelineRuntimeStore";

const FLICK_PROP_ASSET_ID = "flick:animals:cat.glb";

function flickPropCatalogAsset() {
  const catalog = getDirectorAgentCatalogAsset(FLICK_PROP_ASSET_ID);
  if (!catalog) throw new Error(`Missing packaged catalog asset ${FLICK_PROP_ASSET_ID}`);
  return catalog.asset;
}

function catalogPropActions(id: string, name: string, extra: Record<string, unknown> = {}) {
  return [
    { action: "upsert_asset" as const, asset: flickPropCatalogAsset() },
    {
      action: "add_object" as const,
      id,
      name,
      kind: "prop" as const,
      asset_id: FLICK_PROP_ASSET_ID,
      ...extra,
    },
  ];
}

describe("Director workbench executor", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      get length() {
        return values.size;
      },
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => Array.from(values.keys())[index] ?? null,
      removeItem: (key: string) => {
        values.delete(key);
      },
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    } satisfies Storage);
    localStorage.clear();
    resetDirectorWorkbenchRuntimeForTests();
    useTimelineRuntimeStore.getState().reset();
    useDirectorStore.getState().replaceProject(createDefaultDirectorProject());
  });

  it("round-trips authored world systems through observe", () => {
    const authored = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "author",
      actions: [
        {
          action: "add_world_effect",
          kind: "fire",
          anchor: { position: [1, 0, 2] },
          intensity: 1.5,
        },
      ],
    });
    expect(authored).toMatchObject({ success: true });

    const observed = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), { op: "observe" });
    expect(observed.result).toMatchObject({
      world: expect.objectContaining({
        settings: expect.objectContaining({ enabled: true }),
        effects: [expect.objectContaining({ kind: "fire", intensity: 1.5 })],
      }),
    });

    const selected = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "observe",
      fields: ["world"],
    });
    expect(selected.result).toMatchObject({
      world: expect.objectContaining({ effects: [expect.objectContaining({ kind: "fire" })] }),
      requested_fields: ["world"],
    });
  });

  it("routes bounded spatial queries through the workbench executor", () => {
    const queried = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "query_objects",
      spatial: { mode: "radius", center: [0, 0, 0], radius_m: 100 },
      include_hidden: false,
      max_results: 50,
    });
    expect(queried).toMatchObject({
      success: true,
      result: {
        mode: "radius",
        project_revision: expect.any(String),
        objects: expect.arrayContaining([
          expect.objectContaining({ id: "char_default_a", bounds: expect.any(Object) }),
        ]),
      },
    });
  });

  it("queries objects by name_pattern without a spatial bound", () => {
    executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "author",
      actions: catalogPropActions("wood-door", "木门"),
    });
    const queried = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "query_objects",
      name_pattern: "门",
      include_hidden: false,
      max_results: 50,
    });
    expect(queried).toMatchObject({
      success: true,
      result: {
        mode: "all",
        name_pattern: "门",
        objects: [expect.objectContaining({ id: "wood-door", name: "木门" })],
      },
    });
  });

  it("returns a bounded nested object hierarchy", () => {
    executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "author",
      actions: [
        { action: "upsert_asset", asset: flickPropCatalogAsset() },
        {
          action: "add_object",
          id: "hierarchy-root",
          name: "Hierarchy Root",
          kind: "prop",
          asset_id: FLICK_PROP_ASSET_ID,
        },
        {
          action: "add_object",
          id: "hierarchy-child",
          name: "Hierarchy Child",
          kind: "prop",
          asset_id: FLICK_PROP_ASSET_ID,
          parent_id: "hierarchy-root",
        },
      ],
    });

    const observed = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "observe",
      fields: ["objects"],
      object_mode: "hierarchy",
      max_objects: 100,
    });
    expect(observed).toMatchObject({
      success: true,
      result: {
        object_mode: "hierarchy",
        objects: {
          mode: "hierarchy",
          truncated: false,
        },
      },
    });
    const roots = (observed.result as { objects: { roots: Array<{ id: string; children: unknown[] }> } }).objects.roots;
    expect(roots.find((object) => object.id === "hierarchy-root")?.children).toEqual([
      expect.objectContaining({ id: "hierarchy-child" }),
    ]);
  });

  it("returns bounded object changes since a project revision without the full scene", () => {
    const sinceRevision = getDirectorProjectRevision(useDirectorStore.getState().project);
    executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "author",
      actions: [
        { action: "upsert_asset" as const, asset: flickPropCatalogAsset() },
        ...["a", "b", "c"].map((suffix) => ({
          action: "add_object" as const,
          id: `revision-${suffix}`,
          name: `Revision ${suffix}`,
          kind: "prop" as const,
          asset_id: FLICK_PROP_ASSET_ID,
        })),
      ],
    });

    const observed = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "observe",
      fields: ["objects"],
      since_revision: sinceRevision,
      max_changes: 2,
    });
    expect(observed).toMatchObject({
      success: true,
      result: {
        mode: "revision_delta",
        revision_scope: "project",
        since_revision: sinceRevision,
        diff: {
          changed: true,
          objects: {
            added: [{ id: "revision-a" }, { id: "revision-b" }],
            total_changes: 3,
            truncated: true,
          },
        },
      },
    });
    expect(observed.result).not.toHaveProperty("objects");

    const summaryDelta = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "observe",
      detail: "summary",
      since_revision: sinceRevision,
      max_changes: 1,
    });
    expect(summaryDelta).toMatchObject({
      success: true,
      result: {
        detail: "summary",
        requested_fields: null,
        diff: { objects: { added: [{ id: "revision-a" }], total_changes: 3, truncated: true } },
      },
    });

    const currentRevision = (observed.result as { project_revision: string }).project_revision;
    expect(
      executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
        op: "observe",
        fields: ["objects"],
        since_revision: currentRevision,
      }),
    ).toMatchObject({ success: true, result: { diff: { changed: false, objects: { total_changes: 0 } } } });
  });

  it("keeps full observations compatible and provides a bounded summary response", () => {
    const full = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), { op: "observe" });
    const summary = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "observe",
      detail: "summary",
    });

    expect(full.result).toHaveProperty("objects");
    expect(full.result).not.toHaveProperty("detail");
    expect(summary).toMatchObject({
      success: true,
      result: {
        detail: "summary",
        requested_fields: ["counts", "ui", "cameras", "characters", "graph_issues"],
        counts: expect.any(Object),
        ui: expect.any(Object),
        cameras: expect.any(Array),
        characters: expect.any(Array),
        graph_issues: expect.any(Array),
      },
    });
    expect(summary.result).not.toHaveProperty("objects");
    expect(summary.result).not.toHaveProperty("assets");
    expect(
      executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
        op: "observe",
        detail: "summary",
        fields: ["objects"],
      }).result,
    ).toHaveProperty("objects");
    expect(
      executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
        op: "observe",
        detail: "summary",
        object_mode: "hierarchy",
      }).result,
    ).toMatchObject({ requested_fields: ["objects"], object_mode: "hierarchy", objects: expect.any(Object) });
  });

  it("observes the complete project and advertises every workbench surface", () => {
    const capabilities = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), { op: "capabilities" });
    const observed = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), { op: "observe" });
    expect(capabilities.result).toMatchObject({
      operations: expect.arrayContaining([
        "production",
        "generation",
        "transcription",
        "storyboard_artifact",
        "query_objects",
        "deliver",
      ]),
      controls: expect.arrayContaining([
        "assets",
        "searchable local asset, character, and motion catalogs",
        "characters",
        "cameras",
        "timeline animations",
        "storyboard",
        "storyboard thumbnails and PDF export",
        "undo",
        "capture",
      ]),
      author_actions: expect.arrayContaining([
        "set_character_pose_controls",
        "set_character_motion",
        "set_character_ik",
        "place_relative",
        "arrange_group",
        "orient_toward",
        "set_world_settings",
        "add_world_effect",
        "add_world_water_body",
        "add_world_wildlife_group",
        "set_vehicle_profile",
        "clear_vehicle_profile",
      ]),
      recommended_loop: [
        "catalog when an asset or motion id is unknown",
        "observe for a compact scene summary",
        "observe with since_revision when only persisted changes are needed",
        "query_objects when a name, kind, camera frustum, or local area is needed",
        "author one complete user intent",
        "check the changed entities or frame once",
      ],
      production_contract: {
        actions: expect.arrayContaining([
          "observe",
          "create_scene",
          "duplicate_scene",
          "activate_scene",
          "delete_scene",
        ]),
        concurrency: expect.stringContaining("expected_revision"),
        duplication: expect.stringContaining("independent"),
      },
      storyboard_artifact_contract: {
        actions: ["capture_thumbnail", "capture_missing", "export_pdf"],
        capture: expect.stringContaining("selected camera"),
        concurrency: expect.stringContaining("public Agent boundary"),
        export: expect.stringContaining("A4/Letter"),
        download: expect.stringContaining("browser"),
      },
      transcription_contract: {
        actions: ["capabilities", "list", "get", "submit", "cancel", "retry", "read", "search", "promote"],
        artifacts: expect.stringContaining("WebVTT"),
        promotion: expect.stringContaining("Video Editor"),
        retrieval: expect.stringContaining("time window"),
      },
      character_pose_contract: {
        controls: expect.arrayContaining(["head.yaw", "leftShoulder.pitch", "rightFoot.roll"]),
        write_actions: ["set_character_pose_controls", "clear_character_pose_controls"],
        ik_actions: ["set_character_ik", "clear_character_ik"],
      },
      character_motion_contract: {
        clips: expect.arrayContaining([
          expect.objectContaining({ id: "idle", category: "idle" }),
          expect.objectContaining({ id: "walk", category: "locomotion" }),
          expect.objectContaining({ id: "wave", category: "gesture" }),
        ]),
        loop_modes: ["once", "repeat", "ping-pong"],
        root_motion_modes: ["in-place"],
        timeline_blocks: expect.stringContaining("motionBlocks"),
        write_actions: ["set_character_motion", "clear_character_motion", "set_animation"],
      },
      catalog_contract: {
        catalogs: ["assets", "character_assets", "character_motions", "project_assets"],
        asset_count: 1540,
        asset_authoring: expect.stringContaining("upsert_asset"),
        project_asset_filters: ["query", "kind", "asset_source"],
        project_asset_sources: ["uploaded", "generated", "library"],
        project_asset_authoring: expect.stringContaining("add_object"),
      },
      spatial_contract: {
        placement_modes: ["auto", "grounded", "supported", "attached", "suspended", "floating"],
        composable_relations: {
          actions: ["place_relative", "arrange_group", "arrange_facing_pair", "orient_toward"],
          reference_frames: ["world", "target", "camera"],
          group_layouts: ["line", "grid", "circle", "arc"],
          facing_modes: ["center", "outward", "same_direction", "next", "target", "none"],
        },
      },
      world_contract: {
        author_actions: [
          "set_world_settings",
          "add_world_effect",
          "update_world_effect",
          "remove_world_effects",
          "add_world_water_body",
          "update_world_water_body",
          "remove_world_water_bodies",
          "add_world_wildlife_group",
          "update_world_wildlife_group",
          "remove_world_wildlife_groups",
          "add_world_road",
          "update_world_road",
          "remove_world_roads",
        ],
        effect_kinds: ["fire", "smoke", "steam", "sparks", "fireflies", "dust", "rain", "snow"],
        wildlife_species: ["birds", "butterflies", "fish", "deer", "rabbits", "wolves", "sheep"],
        weather_presets: ["clear", "overcast", "rain", "snow", "storm"],
        limits: {
          effects: 64,
          water_bodies: 8,
          wildlife_groups: 16,
          wildlife_count_per_group: 256,
          roads: 16,
          road_vehicles_per_road: 24,
        },
        creation: expect.stringContaining("enabled: true"),
        roads: expect.stringContaining("add_world_road"),
        locking: expect.stringContaining("locked"),
      },
      vehicle_contract: {
        author_actions: ["set_vehicle_profile", "clear_vehicle_profile"],
        kinds: ["car"],
        object_kinds: ["prop", "scene"],
        defaults: expect.objectContaining({ version: 1, kind: "car", drivable: true, massKg: 1400 }),
        chassis_frame: expect.stringContaining("forward +Z"),
        merge: expect.stringContaining("default car profile"),
        clearing: expect.stringContaining("informative note"),
        locking: expect.stringContaining('{"drivable": false}'),
        runtime: expect.stringContaining("player-session"),
      },
      revision_guard: {
        recommended: expect.stringContaining("when stale-edit detection matters"),
        unconditional: expect.stringContaining("skips an optional stale-edit check"),
      },
      execution: expect.stringContaining("undoable"),
      project_revision_before: expect.any(String),
      project_revision: expect.any(String),
    });
    expect(observed.result).toMatchObject({
      counts: { objects: 2, cameras: 1 },
      cameras: [
        expect.objectContaining({
          aperture_f_stop: 2.8,
          focus_distance_m: 5,
          shutter_angle: 180,
          iso: 800,
          near_clip_m: 0.1,
          far_clip_m: 2_000,
          anamorphic_squeeze: 1,
        }),
      ],
      project_revision_before: expect.any(String),
      project_revision: expect.any(String),
    });
    expect((observed.result as { project_revision_before: string }).project_revision_before).toBe(
      (observed.result as { project_revision: string }).project_revision,
    );
    // A project without an enabled world reports the block as null instead of omitting it.
    expect(observed.result).toMatchObject({ world: null });
    expect((observed.result as { objects: unknown[] }).objects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "char_default_a",
          kind: "character",
          character_source: "asset",
          asset_id: "mixamo:x-bot",
          character_rig: expect.objectContaining({ type: expect.any(String), controls: {}, ik: {}, motion: null }),
        }),
      ]),
    );
  });

  it("searches packaged characters and returns an asset ready for atomic Agent authoring", () => {
    const catalog = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "catalog",
      catalog: "character_assets",
      query: "x-bot",
      offset: 0,
      limit: 1,
    });
    expect(catalog).toMatchObject({
      success: true,
      result: {
        catalog: "character_assets",
        total: 1,
        returned: 1,
        next_offset: null,
        items: [
          {
            id: "mixamo:x-bot",
            aliases: expect.arrayContaining(["XBot", "Human", "人物"]),
            thumbnail_url: "/mixamo-characters/thumbnails/x-bot.webp",
            asset: {
              id: "mixamo:x-bot",
              kind: "character",
              sourceType: "model",
              url: "/mixamo-characters/models/x-bot.glb",
              assetSource: "library",
              characterMetadata: { rig: { type: "mixamo", boneCount: 65 } },
            },
            source: { provider: "Adobe Mixamo", provenance: "local-user-supplied" },
          },
        ],
      },
    });

    const catalogItem = (catalog.result as { items: Array<{ authoring: { object_id: string; actions: unknown[] } }> })
      .items[0]!;
    const actions = catalogItem.authoring.actions.map((action) => directorAuthoringActionSchema.parse(action));
    const authored = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "author",
      actions,
    });
    expect(authored).toMatchObject({
      success: true,
      result: {
        created: { asset_ids: [], object_ids: [catalogItem.authoring.object_id] },
      },
    });
    expect(useDirectorStore.getState().project.objects).toContainEqual(
      expect.objectContaining({
        id: catalogItem.authoring.object_id,
        kind: "character",
        characterSource: "asset",
        assetRefId: "mixamo:x-bot",
      }),
    );
  });

  it.each(["human", "人物", "x bot", "x-bot"])("ranks the canonical X Bot first for the %s alias", (query) => {
    const catalog = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "catalog",
      catalog: "character_assets",
      query,
      offset: 0,
      limit: 5,
    });
    expect(catalog).toMatchObject({
      success: true,
      result: {
        returned: expect.any(Number),
        items: [expect.objectContaining({ id: "mixamo:x-bot" })],
      },
    });
  });

  it("persists macros, runs them as revision-guarded atomic authoring, and recalls explicit memory safely", () => {
    const objectId = useDirectorStore.getState().project.objects[0]!.id;
    const saved = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "macro",
      command: {
        action: "save",
        overwrite: false,
        macro: {
          id: "rename-object",
          name: "Rename object",
          description: "",
          parameters: [
            { name: "object_id", label: "Object", description: "", type: "string", default: objectId },
            { name: "name", label: "Name", description: "", type: "string", default: "Hero" },
          ],
          actions: [
            { action: "update_object", object_id: { $param: "object_id" }, patch: { name: { $param: "name" } } },
          ],
        },
      },
    });
    expect(saved).toMatchObject({ success: true, result: { saved: true } });
    expect(
      executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
        op: "macro",
        command: {
          action: "save",
          overwrite: false,
          macro: {
            id: "rename-object",
            name: "Rename object",
            description: "",
            parameters: [
              { name: "object_id", label: "Object", description: "", type: "string", default: objectId },
              { name: "name", label: "Name", description: "", type: "string", default: "Hero" },
            ],
            actions: [
              { action: "update_object", object_id: { $param: "object_id" }, patch: { name: { $param: "name" } } },
            ],
          },
        },
      }),
    ).toMatchObject({ success: true, result: { saved: true } });

    const revision = getDirectorProjectRevision(useDirectorStore.getState().project);
    const run = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "run_macro",
      macro_id: "rename-object",
      parameters: { object_id: objectId, name: "Lead" },
      expected_revision: revision,
      idempotency_key: "run-macro-rename-001",
    });
    expect(run).toMatchObject({
      success: true,
      result: { macro: { id: "rename-object", action_count: 1 }, action_count: 1 },
    });
    expect(useDirectorStore.getState().project.objects.find((object) => object.id === objectId)?.name).toBe("Lead");

    expect(
      executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
        op: "memory",
        command: {
          action: "pin",
          memory_id: "continuity-hero",
          text: "Hero enters from camera left.",
          category: "continuity",
          tags: ["hero"],
          scope: "scene",
          scene_id: "scene-a",
          overwrite: false,
        },
      }),
    ).toMatchObject({ success: true, result: { trust: "untrusted_user_memory", auto_injected: false } });
    expect(
      executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
        op: "memory",
        command: {
          action: "pin",
          memory_id: "continuity-hero",
          text: "Hero enters from camera left.",
          category: "continuity",
          tags: ["hero"],
          scope: "scene",
          scene_id: "scene-a",
          overwrite: false,
        },
      }),
    ).toMatchObject({ success: true, result: { pinned: true } });
    expect(
      executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
        op: "memory",
        command: { action: "recall", query: "camera", scope: "scene", scene_id: "scene-a", limit: 50 },
      }),
    ).toMatchObject({
      success: true,
      result: {
        trust: "untrusted_user_memory",
        auto_injected: false,
        memories: [expect.objectContaining({ id: "continuity-hero" })],
      },
    });
    expect(
      executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
        op: "macro",
        command: { action: "remove", macro_id: "rename-object" },
      }),
    ).toMatchObject({ success: true, result: { removed: true } });
    expect(
      executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
        op: "macro",
        command: { action: "remove", macro_id: "rename-object" },
      }),
    ).toMatchObject({ success: true, result: { removed: false } });
    expect(
      executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
        op: "memory",
        command: { action: "forget", memory_id: "continuity-hero" },
      }),
    ).toMatchObject({ success: true, result: { forgotten: true } });
    expect(
      executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
        op: "memory",
        command: { action: "forget", memory_id: "continuity-hero" },
      }),
    ).toMatchObject({ success: true, result: { forgotten: false } });
  });

  it("discovers every packaged model through one filtered, author-ready asset catalog", () => {
    const catalog = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "catalog",
      catalog: "assets",
      query: "brown bear",
      category: "animals",
      kind: "prop",
      preview_status: "ready",
      offset: 0,
      limit: 10,
    });
    expect(catalog).toMatchObject({
      success: true,
      result: {
        catalog: "assets",
        total: 1,
        returned: 1,
        next_offset: null,
        items: [
          {
            id: "flick:animals:brown_bear.glb",
            category: "animals",
            source_category: "animals",
            model_url: "/flick-stage-props/animals/brown_bear.glb",
            thumbnail_url: "/flick-stage-props/thumbnails/animals/brown_bear.webp",
            preview: {
              status: "ready",
              kind: "image",
              url: "/flick-stage-props/thumbnails/animals/brown_bear.webp",
              source_model_url: "/flick-stage-props/animals/brown_bear.glb",
            },
            asset: {
              id: "flick:animals:brown_bear.glb",
              kind: "prop",
              sourceType: "model",
              assetSource: "library",
            },
            authoring: {
              object_id: "catalog-instance-flick:animals:brown_bear.glb",
              actions: [
                { action: "upsert_asset", asset: { id: "flick:animals:brown_bear.glb" } },
                {
                  action: "add_object",
                  id: "catalog-instance-flick:animals:brown_bear.glb",
                  asset_id: "flick:animals:brown_bear.glb",
                  placement_mode: "grounded",
                },
              ],
            },
          },
        ],
      },
    });
    const item = (catalog.result as { items: Array<{ authoring: { actions: unknown[] } }> }).items[0]!;
    expect(item.authoring.actions.map((action) => directorAuthoringActionSchema.safeParse(action).success)).toEqual([
      true,
      true,
    ]);

    const inspected = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "inspect",
      entity: "catalog_asset",
      id: "flick:animals:brown_bear.glb",
    });
    expect(inspected).toMatchObject({
      success: true,
      result: {
        entity: "catalog_asset",
        value: {
          id: "flick:animals:brown_bear.glb",
          preview: {
            status: "ready",
            url: "/flick-stage-props/thumbnails/animals/brown_bear.webp",
          },
        },
      },
    });
  });

  it("searches packaged motions with bilingual tags and deterministic pagination", () => {
    const catalog = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "catalog",
      catalog: "character_motions",
      query: "挥手",
      offset: 0,
      limit: 1,
    });
    expect(catalog).toMatchObject({
      success: true,
      result: {
        catalog: "character_motions",
        total: 1,
        returned: 1,
        items: [{ id: "wave", name_zh: "挥手", default_loop: "once" }],
      },
    });
  });

  function seedProjectAssetsFixture() {
    const project = createDefaultDirectorProject();
    const packagedCat = getDirectorAgentCatalogAsset("flick:animals:cat.glb")!;
    project.assets.push(
      {
        id: "upload-hero-prop",
        kind: "prop",
        sourceType: "model",
        fileName: "hero-prop.glb",
        name: "Hero Prop",
        url: "/media/uploads/hero-prop.glb",
        assetSource: "local",
        thumbnailUrl: "/media/uploads/hero-prop.webp",
      },
      {
        id: "generated-robot",
        kind: "prop",
        sourceType: "model",
        fileName: "robot.glb",
        name: "Generated Robot",
        url: "/media/generated/robot.glb",
        assetSource: "generated",
        modelNormalization: "preserve",
        generation: {
          contract: "director-generated-3d-v1",
          jobId: "generated-3d-job-1",
          providerId: "meshy",
          externalId: "external-1",
          modelSha256: "0".repeat(64),
          thumbnailSha256: "1".repeat(64),
          receiptArtifactId: "receipt-artifact-1",
          prompt: "a friendly robot",
          createdAt: "2026-08-13T00:00:00.000Z",
        },
      },
      structuredClone(packagedCat.asset),
      {
        id: "upload-texture",
        kind: "prop",
        sourceType: "image",
        fileName: "texture.png",
        name: "Texture",
        url: "/media/uploads/texture.png",
        assetSource: "local",
      },
    );
    useDirectorStore.getState().replaceProject(project);
  }

  it("lists live project model assets with one prepared add_object action each", () => {
    seedProjectAssetsFixture();
    const listed = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "catalog",
      catalog: "project_assets",
      offset: 0,
      limit: 25,
    });
    expect(listed).toMatchObject({
      success: true,
      result: {
        catalog: "project_assets",
        query: null,
        filters: { kind: null, asset_source: null },
        total: 4,
        returned: 4,
        next_offset: null,
        usage: expect.stringContaining("no upsert_asset is needed"),
      },
    });

    const items = (
      listed.result as {
        items: Array<{
          id: string;
          asset_source: string;
          authoring: { object_id: string; actions: unknown[] };
        }>;
      }
    ).items;
    expect(items.map((item) => item.id).sort()).toEqual([
      "flick:animals:cat.glb",
      "generated-robot",
      "mixamo:x-bot",
      "upload-hero-prop",
    ]);
    expect(items.every((item) => item.authoring.actions.length === 1)).toBe(true);

    const uploaded = items.find((item) => item.id === "upload-hero-prop")!;
    expect(uploaded).toMatchObject({
      id: "upload-hero-prop",
      name: "Hero Prop",
      kind: "prop",
      file_name: "hero-prop.glb",
      url: "/media/uploads/hero-prop.glb",
      thumbnail_url: "/media/uploads/hero-prop.webp",
      asset_source: "uploaded",
      authoring: {
        object_id: "project-asset-instance-upload-hero-prop",
        actions: [
          {
            action: "add_object",
            id: "project-asset-instance-upload-hero-prop",
            name: "Hero Prop",
            kind: "prop",
            asset_id: "upload-hero-prop",
            placement_mode: "grounded",
          },
        ],
      },
    });
    expect(items.find((item) => item.id === "generated-robot")).toMatchObject({
      asset_source: "generated",
      thumbnail_url: null,
    });
    expect(items.find((item) => item.id === "mixamo:x-bot")).toMatchObject({
      asset_source: "library",
      kind: "character",
      authoring: {
        actions: [expect.objectContaining({ action: "add_object", character_source: "asset" })],
      },
    });

    const actions = uploaded.authoring.actions.map((action) => directorAuthoringActionSchema.parse(action));
    const authored = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "author",
      actions,
    });
    expect(authored).toMatchObject({
      success: true,
      result: { created: { asset_ids: [], object_ids: ["project-asset-instance-upload-hero-prop"] } },
    });
    expect(useDirectorStore.getState().project.objects).toContainEqual(
      expect.objectContaining({
        id: "project-asset-instance-upload-hero-prop",
        kind: "prop",
        assetRefId: "upload-hero-prop",
      }),
    );
  });

  it("filters and paginates project assets by query, kind, and asset_source", () => {
    seedProjectAssetsFixture();
    const run = (input: Record<string, unknown>) =>
      executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
        op: "catalog",
        catalog: "project_assets",
        offset: 0,
        limit: 25,
        ...input,
      } as Parameters<typeof executeDirectorWorkbenchOperation>[1]);

    expect(run({ query: "hero prop" })).toMatchObject({
      success: true,
      result: { total: 1, items: [expect.objectContaining({ id: "upload-hero-prop" })] },
    });
    expect(run({ kind: "character" })).toMatchObject({
      success: true,
      result: { total: 1, items: [expect.objectContaining({ id: "mixamo:x-bot" })] },
    });
    expect(run({ asset_source: "generated" })).toMatchObject({
      success: true,
      result: {
        filters: { kind: null, asset_source: "generated" },
        total: 1,
        items: [expect.objectContaining({ id: "generated-robot" })],
      },
    });
    expect(run({ asset_source: "uploaded" })).toMatchObject({
      success: true,
      result: { total: 1, items: [expect.objectContaining({ id: "upload-hero-prop" })] },
    });
    expect(run({ limit: 1, offset: 1 })).toMatchObject({
      success: true,
      result: { total: 4, returned: 1, next_offset: 2 },
    });
  });

  it("authors and re-observes semantic character controls through the Agent workbench", () => {
    const authored = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "author",
      actions: [
        {
          action: "set_character_pose_controls",
          object_id: "char_default_a",
          controls: [
            { control: "head.yaw", value: 30 },
            { control: "leftElbow.bend", value: 55 },
          ],
        },
      ],
    });
    expect(authored).toMatchObject({ success: true, result: { changed: true, object_ids: ["char_default_a"] } });

    const observed = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "observe",
      fields: ["characters"],
    });
    expect(observed).toMatchObject({
      success: true,
      result: {
        characters: [
          expect.objectContaining({
            id: "char_default_a",
            character_rig: {
              type: expect.any(String),
              pose_preset_id: null,
              controls: { "head.yaw": 30, "leftElbow.bend": 55 },
              ik: {},
              motion: null,
            },
          }),
        ],
      },
    });
  });

  it("authors and observes a packaged skeletal motion through the Agent workbench", () => {
    const authored = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "author",
      actions: [
        {
          action: "set_character_motion",
          object_id: "char_default_a",
          clip_id: "run",
          loop: "repeat",
          speed: 1.2,
          start_frame: 8,
        },
      ],
    });
    expect(authored).toMatchObject({ success: true, result: { changed: true, object_ids: ["char_default_a"] } });

    const observed = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "observe",
      fields: ["characters"],
    });
    expect(observed).toMatchObject({
      success: true,
      result: {
        characters: [
          expect.objectContaining({
            id: "char_default_a",
            character_rig: expect.objectContaining({
              motion: expect.objectContaining({ clipId: "run", speed: 1.2, startFrame: 8 }),
            }),
          }),
        ],
      },
    });
  });

  it("selectively observes the reusable performance and coverage projection", () => {
    const observed = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "observe",
      fields: ["production", "counts"],
    });

    expect(observed).toMatchObject({
      success: true,
      result: {
        requested_fields: ["production", "counts"],
        production: {
          active_take_id: "take_default",
          active_sequence_id: "coverage_default",
          takes: [
            {
              id: "take_default",
              name: "默认表演",
              frame_start: 0,
              frame_end: 240,
              object_ids: ["char_default_a"],
              entity_track_count: 0,
            },
          ],
          sequences: [
            {
              id: "coverage_default",
              name: "默认镜头组",
              shots: [
                expect.objectContaining({
                  id: "coverage_shot_1",
                  take_id: "take_default",
                  camera_id: "cam_1",
                  frame_start: 0,
                  frame_end: 240,
                  storyboard_shot_id: null,
                }),
              ],
            },
          ],
        },
        counts: {
          performance_takes: 1,
          coverage_sequences: 1,
          coverage_shots: 1,
        },
      },
    });
    expect(observed.result).not.toHaveProperty("objects");
    expect(observed.result).not.toHaveProperty("cameras");
  });

  it("inspects performance takes, coverage sequences, and coverage shots by stable ID", () => {
    const cases = [
      ["performance_take", "take_default", { id: "take_default", objectIds: ["char_default_a"] }],
      ["coverage_sequence", "coverage_default", { id: "coverage_default", name: "默认镜头组" }],
      ["coverage_shot", "coverage_shot_1", { id: "coverage_shot_1", takeId: "take_default", cameraId: "cam_1" }],
    ] as const;

    cases.forEach(([entity, id, value]) => {
      expect(
        executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), { op: "inspect", entity, id }),
      ).toMatchObject({ success: true, result: { entity, value } });
    });

    expect(
      executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
        op: "inspect",
        entity: "coverage_shot",
        id: "missing-shot",
      }),
    ).toMatchObject({
      success: false,
      error: expect.stringContaining('No coverage_shot with id "missing-shot" exists.'),
    });
  });

  it("authors production entities atomically and rejects an invalid take edit", () => {
    const authored = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "author",
      actions: [
        {
          action: "add_performance_take",
          take: {
            id: "take-agent",
            name: "Agent Take",
            frameStart: 0,
            frameEnd: 96,
            objectIds: ["char_default_a"],
            entityTracks: [],
          },
        },
        {
          action: "add_coverage_sequence",
          sequence: {
            id: "coverage-agent",
            name: "Agent Coverage",
            shots: [
              {
                id: "coverage-agent-wide",
                name: "Agent Wide",
                takeId: "take-agent",
                cameraId: "cam_1",
                frameStart: 0,
                frameEnd: 96,
              },
            ],
          },
        },
      ],
    });
    expect(authored).toMatchObject({
      success: true,
      result: {
        created: {
          performance_take_ids: ["take-agent"],
          coverage_sequence_ids: ["coverage-agent"],
          coverage_shot_ids: ["coverage-agent-wide"],
        },
      },
    });

    const before = structuredClone(useDirectorStore.getState().project);
    const rejected = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "author",
      actions: [
        {
          action: "update_performance_take",
          take_id: "take-agent",
          patch: { frameEnd: 24 },
        },
      ],
    });
    expect(rejected).toMatchObject({
      success: false,
      error: expect.stringContaining("Production semantics are invalid"),
    });
    expect(useDirectorStore.getState().project).toEqual(before);
  });

  it("applies matching revision guards and atomically rejects stale writes", () => {
    const observed = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), { op: "observe" });
    const initialRevision = (observed.result as { project_revision: string }).project_revision;

    const matching = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "author",
      expected_revision: initialRevision,
      actions: [{ action: "set_scene", patch: { backgroundColor: "#203040" } }],
    });
    const changedRevision = (matching.result as { project_revision: string }).project_revision;

    expect(matching).toMatchObject({
      success: true,
      result: {
        changed: true,
        project_revision_before: initialRevision,
        project_revision: expect.stringMatching(/^director-project-revision:v1:sha256:[0-9a-f]{64}$/),
      },
    });
    expect(changedRevision).not.toBe(initialRevision);
    expect(changedRevision).toBe(getDirectorProjectRevision(useDirectorStore.getState().project));
    expect(useDirectorStore.getState().project.scene.backgroundColor).toBe("#203040");

    const beforeStaleWrite = structuredClone(useDirectorStore.getState().project);
    const stale = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "patch",
      expected_revision: initialRevision,
      patches: [{ op: "replace", path: "/project/scene/backgroundColor", value: "#ff0000" }],
    });

    expect(stale).toMatchObject({
      success: false,
      error: expect.stringContaining("Stale project revision"),
      result: {
        code: "stale_project_revision",
        expected_revision: initialRevision,
        actual_revision: changedRevision,
        project_revision_before: changedRevision,
        project_revision: changedRevision,
      },
    });
    expect(useDirectorStore.getState().project).toEqual(beforeStaleWrite);

    const unconditional = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "author",
      unconditional: true,
      actions: [{ action: "set_scene", patch: { backgroundColor: "#405060" } }],
    });
    expect(unconditional).toMatchObject({ success: true, result: { project_revision_before: changedRevision } });
    expect((unconditional.result as { project_revision: string }).project_revision).not.toBe(changedRevision);
  });

  it("executes a valid mutation directly without a preflight guard", () => {
    const object = useDirectorStore.getState().project.objects[0]!;
    const execution = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "author",
      actions: [{ action: "update_object", object_id: object.id, patch: { name: "Direct Rename" } }],
    });

    expect(execution.success).toBe(true);
    expect(useDirectorStore.getState().project.objects[0]?.name).toBe("Direct Rename");
  });

  it("replays an exact remote mutation once and rejects changed key reuse", () => {
    const object = useDirectorStore.getState().project.objects[0]!;
    const expectedRevision = getDirectorProjectRevision(useDirectorStore.getState().project);
    const request = {
      op: "author" as const,
      expected_revision: expectedRevision,
      idempotency_key: "workbench-replay-001",
      actions: [{ action: "update_object" as const, object_id: object.id, patch: { name: "Replay Safe" } }],
    };

    const first = executeDirectorWorkbenchAgentOperation(() => useDirectorStore.getState(), request, {
      scope: "replay-scene",
    });
    const revisionAfter = getDirectorProjectRevision(useDirectorStore.getState().project);
    const second = executeDirectorWorkbenchAgentOperation(() => useDirectorStore.getState(), request, {
      scope: "replay-scene",
    });
    const conflicting = executeDirectorWorkbenchAgentOperation(
      () => useDirectorStore.getState(),
      {
        ...request,
        actions: [{ action: "update_object", object_id: object.id, patch: { name: "Different Intent" } }],
      },
      { scope: "replay-scene" },
    );

    expect(first).toMatchObject({ success: true, result: { idempotency_replayed: false } });
    expect(second).toMatchObject({
      success: true,
      result: { idempotency_replayed: true, project_revision: revisionAfter },
    });
    expect(conflicting).toMatchObject({ success: false, result: { code: "idempotency_key_conflict" } });
    expect(useDirectorStore.getState().project.objects[0]?.name).toBe("Replay Safe");
  });

  it("replays a stale-but-successful mutation instead of failing the retry", () => {
    const object = useDirectorStore.getState().project.objects[0]!;
    const expectedRevision = getDirectorProjectRevision(useDirectorStore.getState().project);
    const request = {
      op: "author" as const,
      expected_revision: expectedRevision,
      idempotency_key: "fix-1",
      actions: [{ action: "update_object" as const, object_id: object.id, patch: { name: "Replay Original" } }],
    };

    const first = executeDirectorWorkbenchAgentOperation(() => useDirectorStore.getState(), request, {
      scope: "replay-scene",
    });
    expect(first).toMatchObject({ success: true, result: { idempotency_replayed: false } });
    const revisionAfterFirst = getDirectorProjectRevision(useDirectorStore.getState().project);

    const drift = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "author",
      unconditional: true,
      actions: [{ action: "update_object", object_id: object.id, patch: { name: "Drifted Elsewhere" } }],
    });
    expect(drift.success).toBe(true);
    const currentRevision = getDirectorProjectRevision(useDirectorStore.getState().project);
    expect(currentRevision).not.toBe(revisionAfterFirst);

    const replayed = executeDirectorWorkbenchAgentOperation(() => useDirectorStore.getState(), request, {
      scope: "replay-scene",
    });
    expect(replayed).toMatchObject({
      success: true,
      result: {
        idempotency_replayed: true,
        replay_stale: true,
        project_revision: revisionAfterFirst,
        original_project_revision: revisionAfterFirst,
        current_project_revision: currentRevision,
        message: expect.stringContaining("already succeeded"),
      },
    });
    expect(useDirectorStore.getState().project.objects[0]?.name).toBe("Drifted Elsewhere");
  });

  it("treats unconditional:false as an omitted flag and keeps the conditional guard", () => {
    const revision = getDirectorProjectRevision(useDirectorStore.getState().project);
    const guarded = executeDirectorWorkbenchAgentOperation(() => useDirectorStore.getState(), {
      op: "author",
      unconditional: false,
      expected_revision: revision,
      actions: [{ action: "set_scene", patch: { backgroundColor: "#123123" } }],
    });
    expect(guarded).toMatchObject({ success: true });
    expect(useDirectorStore.getState().project.scene.backgroundColor).toBe("#123123");

    const staleGuarded = executeDirectorWorkbenchAgentOperation(() => useDirectorStore.getState(), {
      op: "author",
      unconditional: false,
      expected_revision: revision,
      actions: [{ action: "set_scene", patch: { backgroundColor: "#321321" } }],
    });
    expect(staleGuarded).toMatchObject({ success: false, result: { code: "stale_project_revision" } });

    const unguarded = executeDirectorWorkbenchAgentOperation(() => useDirectorStore.getState(), {
      op: "author",
      unconditional: false,
      actions: [{ action: "set_scene", patch: { backgroundColor: "#456456" } }],
    });
    expect(unguarded).toMatchObject({ success: false, error: expect.stringContaining("expected_revision") });
  });

  it("builds a delivery preflight before the browser captures evidence", () => {
    const expectedRevision = getDirectorProjectRevision(useDirectorStore.getState().project);
    const delivered = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "deliver",
      expected_revision: expectedRevision,
      quality_profile: "blocking",
      width: 1280,
      height: 720,
    });

    expect(delivered).toMatchObject({
      success: true,
      result: {
        ready: true,
        status: "preflight-ready",
        quality_profile: "blocking",
        capture_required: true,
        audit: { ready: true },
        shot_ir: { revisionFingerprint: expect.any(String) },
        requested_artifacts: {
          render_passes: ["clean", "depth", "normal", "object-id", "mask"],
        },
      },
    });
  });

  it("applies a validated project patch as an undoable edit", () => {
    const execution = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "patch",
      patches: [
        {
          op: "add",
          path: "/project/assets/-",
          value: flickPropCatalogAsset(),
        },
        {
          op: "add",
          path: "/project/objects/-",
          value: {
            id: "agent-box",
            name: "Agent Box",
            kind: "prop",
            visible: true,
            locked: false,
            assetRefId: FLICK_PROP_ASSET_ID,
            color: "#ffaa00",
            transform: { position: [1, 0, 2], rotation: [0, 0, 0], scale: [1, 1, 1] },
          },
        },
      ],
    });
    expect(execution).toMatchObject({ success: true, result: { changed: true, object_ids: ["agent-box"] } });
    expect(useDirectorStore.getState().project.objects.some((object) => object.id === "agent-box")).toBe(true);

    executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), { op: "undo" });
    expect(useDirectorStore.getState().project.objects.some((object) => object.id === "agent-box")).toBe(false);
  });

  it("authors semantic scene changes atomically and audits the result", () => {
    const execution = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "author",
      actions: [
        ...catalogPropActions("agent-sphere", "Agent Sphere", {
          placement_mode: "grounded",
          transform: { position: [2, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        }),
        { action: "set_scene", patch: { backgroundColor: "#172033", groundOpacity: 0.6 } },
      ],
    });
    expect(execution).toMatchObject({
      success: true,
      result: { changed: true, created: { object_ids: ["agent-sphere"] }, action_count: 3 },
    });
    const audit = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "audit",
      subject_id: "agent-sphere",
    });
    expect(audit).toMatchObject({
      success: true,
      result: { issue_count: expect.any(Number), framing: expect.anything() },
    });
  });

  it("keeps full audits compatible and removes heavy diagnostic tables from summaries", () => {
    const full = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "audit",
      detail: "full",
      include_spatial: true,
    });
    const summary = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "audit",
      detail: "summary",
      include_spatial: true,
    });
    const fullResult = full.result as {
      issue_count: number;
      error_count: number;
      warning_count: number;
      spatial: { placements: unknown[] };
      framing: { objects: unknown[] };
    };
    const summaryResult = summary.result as {
      detail: string;
      issue_count: number;
      error_count: number;
      warning_count: number;
      issues: unknown[];
      issues_omitted: number;
      spatial: { placement_count: number };
      framing: Record<string, unknown>;
    };

    expect(full.result).not.toHaveProperty("detail");
    expect(fullResult.spatial.placements).toBeInstanceOf(Array);
    expect(fullResult.framing.objects).toBeInstanceOf(Array);
    expect(summaryResult).toMatchObject({
      detail: "summary",
      issue_count: fullResult.issue_count,
      error_count: fullResult.error_count,
      warning_count: fullResult.warning_count,
      spatial: { placement_count: fullResult.spatial.placements.length },
    });
    expect(summaryResult.issues.length).toBeLessThanOrEqual(12);
    expect(summaryResult.issues_omitted).toBe(Math.max(0, summaryResult.issue_count - summaryResult.issues.length));
    expect(summaryResult.spatial).not.toHaveProperty("placements");
    expect(summaryResult.framing).not.toHaveProperty("objects");
  });

  it("applies ordinary author edits without an extra review result", () => {
    const execution = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "author",
      actions: [{ action: "set_scene", patch: { backgroundColor: "#223344" } }],
    });

    expect(execution).toMatchObject({ success: true, result: { changed: true, action_count: 1 } });
    expect(execution.result).not.toHaveProperty("quality_gate");
  });

  it("authors the living world atomically and reports the on-demand world block", () => {
    const execution = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "author",
      actions: [
        { action: "set_world_settings", settings: { wind: { speed_mps: 7 }, weather: { preset: "rain" } } },
        { action: "add_world_effect", kind: "rain", shape: { type: "box", size: [30, 1, 30] } },
        { action: "add_world_effect", kind: "fire", anchor: { object_id: "char_default_a" } },
        { action: "add_world_water_body", surface: { size_x: 24 } },
        { action: "add_world_wildlife_group", species: "birds" },
        {
          action: "add_world_road",
          points: [
            [-15, 0, 0],
            [15, 0, 0],
          ],
        },
      ],
    });
    expect(execution).toMatchObject({
      success: true,
      result: {
        changed: true,
        action_count: 6,
        created: {
          world_effect_ids: ["fx_rain_1", "fx_fire_1"],
          world_water_body_ids: ["water_1"],
          world_wildlife_group_ids: ["wildlife_birds_1"],
          world_road_ids: ["road_1"],
        },
        notes: [expect.stringContaining("created project.world")],
      },
    });
    const world = useDirectorStore.getState().project.world;
    expect(world?.settings).toMatchObject({ enabled: true, wind: { speedMps: 7 }, weather: { preset: "rain" } });
    expect(world?.effects.map((effect) => effect.kind)).toEqual(["rain", "fire"]);
    expect(world?.effects[1]?.anchor.objectId).toBe("char_default_a");
    expect(world?.waterBodies[0]?.surface.sizeX).toBe(24);
    expect(world?.wildlife[0]).toMatchObject({ species: "birds", count: 24, altitude: { minM: 8, maxM: 25 } });
    expect(world?.roads?.[0]).toMatchObject({ name: "道路01", widthM: 8, loop: false, vehicleCount: 6, speedKph: 40 });

    const followUp = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "author",
      actions: [{ action: "update_world_effect", effect_id: "fx_fire_1", patch: { intensity: 2 } }],
    });
    expect(followUp).toMatchObject({
      success: true,
      result: { updated: { world_effect_ids: ["fx_fire_1"] } },
    });
    expect(followUp.result).not.toHaveProperty("notes");
  });

  it("rejects world authoring against missing anchors without mutating the project", () => {
    const before = structuredClone(useDirectorStore.getState().project);
    const execution = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "author",
      actions: [
        { action: "add_world_water_body" },
        { action: "add_world_effect", kind: "smoke", anchor: { object_id: "missing-anchor" } },
      ],
    });
    expect(execution).toMatchObject({
      success: false,
      error: expect.stringContaining('No object with id "missing-anchor" exists'),
    });
    expect(useDirectorStore.getState().project).toEqual(before);
    expect(useDirectorStore.getState().project.world).toBeUndefined();
  });

  it("frames exact objects in the live viewport when authoring requests focus", () => {
    const viewport = vi.fn();
    const clearViewport = setDirectorPageViewportHandler(viewport);
    const execution = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "author",
      actions: [{ action: "focus_objects", object_ids: ["char_default_a"] }],
    });
    expect(execution.success).toBe(true);
    expect(useDirectorStore.getState().selectedObjectIds).toEqual(["char_default_a"]);
    expect(viewport).toHaveBeenCalledWith(
      expect.objectContaining({
        fov: expect.any(Number),
        position: [expect.any(Number), expect.any(Number), expect.any(Number)],
        target: [expect.any(Number), expect.any(Number), expect.any(Number)],
      }),
    );
    clearViewport();
  });

  it("snaps the live director orbit to the active camera shot", () => {
    const viewport = vi.fn();
    const clearViewport = setDirectorPageViewportHandler(viewport);
    const camera = useDirectorStore.getState().project.cameras[0];
    expect(camera).toBeDefined();
    const execution = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "author",
      actions: [{ action: "set_active_camera", camera_id: camera!.id }],
    });
    expect(execution.success).toBe(true);
    expect(viewport).toHaveBeenCalledWith(getCameraViewSnapshotFromShot(camera!));
    clearViewport();
  });

  it("compiles a multi-character blocking intent directly", () => {
    const viewport = vi.fn();
    const clearViewport = setDirectorPageViewportHandler(viewport);
    const execution = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "author",
      camera_id: "standoff-camera",
      subject_id: "standoff-a",
      actions: [
        { action: "start_scene" },
        {
          action: "compose_blocking",
          layout: "facing",
          characters: [
            { id: "standoff-a", name: "角色 A", pose_preset_id: "hands-on-hips", facing: "toward" },
            { id: "standoff-b", name: "角色 B", pose_preset_id: "stand", facing: "toward" },
          ],
          camera: {
            id: "standoff-camera",
            object_id: "standoff-camera-rig",
            name: "对峙机位",
            angle: "three-quarter",
            height: "eye",
            shot: "full",
          },
        },
      ],
    });
    clearViewport();

    expect(execution).toMatchObject({
      success: true,
      result: {
        created: {
          object_ids: expect.arrayContaining(["standoff-a", "standoff-b", "standoff-camera-rig"]),
          camera_ids: ["standoff-camera"],
        },
      },
    });
    expect(useDirectorStore.getState().project.objects.find((object) => object.id === "standoff-a")).toMatchObject({
      lookTargetObjectId: "standoff-b",
      placementMode: "grounded",
    });
    expect(viewport).toHaveBeenCalledWith({
      fov: expect.any(Number),
      position: expect.any(Array),
      target: expect.any(Array),
    });
  });

  it("routes composable spatial relations through the workbench transaction", () => {
    const beforeRevision = getDirectorProjectRevision(useDirectorStore.getState().project);
    const execution = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "author",
      expected_revision: beforeRevision,
      idempotency_key: "spatial-facing-pair-v1",
      actions: [
        {
          action: "add_object",
          id: "spatial-pair-b",
          name: "Spatial pair B",
          kind: "character",
          placement_mode: "grounded",
        },
        {
          action: "arrange_facing_pair",
          object_ids: ["char_default_a", "spatial-pair-b"],
          center: [0, 0, 0],
          axis: [1, 0],
          distance_m: 2,
        },
      ],
    });

    expect(execution).toMatchObject({
      success: true,
      result: {
        action_count: 2,
        created: { object_ids: ["spatial-pair-b"] },
        updated: { object_ids: ["char_default_a", "spatial-pair-b"] },
        project_revision_before: beforeRevision,
        project_revision: expect.not.stringMatching(beforeRevision),
      },
    });
    const project = useDirectorStore.getState().project;
    const left = project.objects.find((object) => object.id === "char_default_a")!;
    const right = project.objects.find((object) => object.id === "spatial-pair-b")!;
    expect(left).toMatchObject({ lookTargetObjectId: right.id, transform: { position: [-1, 0, 0] } });
    expect(right).toMatchObject({ lookTargetObjectId: left.id, transform: { position: [1, 0, 0] } });
  });

  it("does not block authoring on optional spatial diagnostics", () => {
    const execution = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "author",
      actions: [
        ...catalogPropActions("floating-building", "Floating Building", {
          transform: { position: [0, 3.1, 0], rotation: [0, 0, 0], scale: [4, 3.1, 6] },
        }),
      ],
    });
    expect(execution).toMatchObject({
      success: true,
      result: { changed: true, created: { object_ids: ["floating-building"] } },
    });
    expect(useDirectorStore.getState().project.objects).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "floating-building" })]),
    );
  });

  it("inspects cameras using the same optical position accepted by camera authoring", () => {
    executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "author",
      actions: [
        {
          action: "add_camera",
          id: "agent-optical-camera",
          object_id: "agent-optical-camera-rig",
          name: "Agent Optical Camera",
          position: [0, 2.5, 18],
          target: [0, 0.5, 3],
          focal_length_mm: 85,
          sensor_format: "super35",
          aspect_ratio: "2.39:1",
        },
      ],
    });

    const inspected = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "inspect",
      entity: "camera",
      id: "agent-optical-camera",
    });
    expect(inspected).toMatchObject({
      success: true,
      result: {
        value: {
          position: [0, 2.5, 18],
          transform: { position: [0, 2.5, 18] },
          rigTransform: { position: expect.not.arrayContaining([18]) },
          rigObjectId: "agent-optical-camera-rig",
          sensorFormat: "super35",
        },
      },
    });

    const updated = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "author",
      actions: [
        {
          action: "update_camera",
          camera_id: "agent-optical-camera",
          patch: { sensor_format: "imax65" },
        },
      ],
    });
    expect(updated.success).toBe(true);
    expect(
      useDirectorStore.getState().project.cameras.find((camera) => camera.id === "agent-optical-camera"),
    ).toMatchObject({ sensorFormat: "imax65", focalLengthMm: 85 });
  });

  it("exports an evaluated, deterministic Shot IR for agents", () => {
    const first = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "shot_ir",
      camera_id: "cam_1",
      frame: 0,
    });
    const second = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "shot_ir",
      camera_id: "cam_1",
      frame: 0,
    });

    expect(first).toMatchObject({
      success: true,
      result: {
        schemaVersion: 1,
        id: "director-shot:cam_1:frame:0",
        revisionFingerprint: expect.stringMatching(/^fnv1a32:[0-9a-f]{8}$/),
        frame: 0,
        camera: {
          id: "cam_1",
          sensor: { format: "fullFrame" },
        },
        objects: [expect.objectContaining({ id: "char_default_a", kind: "character" })],
        turn_id: "workbench-turn-1",
      },
    });
    expect(second).toMatchObject({
      success: true,
      result: {
        revisionFingerprint: (first.result as { revisionFingerprint: string }).revisionFingerprint,
        turn_id: "workbench-turn-2",
      },
    });
  });

  it("accepts the camera-rig object id exposed by the Stage projection for Agent evidence", () => {
    const project = useDirectorStore.getState().project;
    const camera = project.cameras[0]!;
    const rig = project.objects.find((object) => object.kind === "camera" && object.linkedCameraId === camera.id)!;

    const execution = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "shot_ir",
      camera_id: rig.id,
      frame: 0,
    });

    expect(execution).toMatchObject({
      success: true,
      result: {
        id: `director-shot:${camera.id}:frame:0`,
        camera: { id: camera.id },
      },
    });
  });

  it("exports production-aware Shot IR from the same validated Agent operation", () => {
    const project = useDirectorStore.getState().project;
    const takeId = project.production!.activeTakeId!;
    const coverageShotId = project.production!.sequences[0]!.shots[0]!.id;

    const execution = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "shot_ir",
      take_id: takeId,
      coverage_shot_id: coverageShotId,
      frame: 0,
    });

    expect(execution).toMatchObject({
      success: true,
      result: {
        production: {
          takeId,
          coverageShotId,
        },
      },
    });
  });

  it("reports invalid Shot IR camera and frame requests without mutating the project", () => {
    const before = structuredClone(useDirectorStore.getState().project);
    const missingCamera = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "shot_ir",
      camera_id: "missing-camera",
    });
    const outOfRangeFrame = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "shot_ir",
      frame: 1_000_000,
    });

    expect(missingCamera).toMatchObject({ success: false, error: expect.stringContaining("does not exist") });
    expect(outOfRangeFrame).toMatchObject({ success: false, error: expect.stringContaining("outside the timeline") });
    expect(useDirectorStore.getState().project).toEqual(before);
  });

  it("rejects dangling project references atomically", () => {
    const before = structuredClone(useDirectorStore.getState().project);
    const execution = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "patch",
      patches: [{ op: "replace", path: "/project/activeCameraId", value: "missing-camera" }],
    });
    expect(execution).toMatchObject({ success: false, error: expect.stringContaining("does not exist") });
    expect(useDirectorStore.getState().project).toEqual(before);
  });

  it("cannot bypass a human lock through the generic patch escape hatch", () => {
    const project = createDefaultDirectorProject();
    const character = project.objects.find((object) => object.kind === "character")!;
    character.locked = true;
    useDirectorStore.getState().replaceProject(project);
    const execution = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "patch",
      patches: [
        {
          op: "replace",
          path: `/project/objects/${project.objects.indexOf(character)}/transform/position`,
          value: [9, 0, 0],
        },
      ],
    });
    expect(execution).toMatchObject({ success: false, error: expect.stringContaining("Locked object") });
    expect(
      useDirectorStore.getState().project.objects.find((object) => object.id === character.id)?.transform.position,
    ).toEqual(character.transform.position);
  });

  it("controls selection and viewport state", () => {
    expect(
      executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
        op: "select",
        object_ids: ["char_default_a"],
      }).success,
    ).toBe(true);
    expect(
      executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
        op: "viewport",
        transform_mode: "rotate",
        aspect_ratio: "2.39:1",
        layout: "quad",
        rule_of_thirds: true,
      }).success,
    ).toBe(true);
    expect(useDirectorStore.getState()).toMatchObject({
      selectedObjectIds: ["char_default_a"],
      transformMode: "rotate",
      viewportAspectRatio: "2.39:1",
      viewportLayout: "quad",
      viewportRuleOfThirdsEnabled: true,
    });
  });

  it("observes selection, camera, viewport, and exact timeline state together", () => {
    const store = useDirectorStore.getState();
    store.selectObjects(["char_default_a"]);
    store.setTransformMode("rotate");
    store.setViewportLayout("quad");
    useTimelineRuntimeStore.getState().setPlayheadFrame(37);
    useTimelineRuntimeStore.getState().selectTrack("char_default_a:transform", 2);

    const observed = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "observe",
      fields: ["ui"],
    });

    expect(observed.result).toMatchObject({
      ui: {
        selectedObjectId: "char_default_a",
        selectedObjectIds: ["char_default_a"],
        activeCameraId: store.project.activeCameraId,
        transformMode: "rotate",
        viewportLayout: "quad",
        currentFrame: 37,
        selectedTrackKey: "char_default_a:transform",
        selectedKeyframeIndex: 2,
      },
    });
  });

  it("controls the live timeline transport", () => {
    let received: { playing?: boolean; currentFrame?: number } = {};
    const cleanup = setDirectorPagePlaybackHandler((state) => {
      received = state;
    });
    const execution = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "playback",
      playing: true,
      current_frame: 48,
      active_panel: "timeline",
    });
    cleanup();
    expect(execution.success).toBe(true);
    expect(received).toEqual({ playing: true, currentFrame: 48 });
  });

  it("corrects deterministic audit issues directly from an audit token", () => {
    const project = createDefaultDirectorProject();
    const character = project.objects.find((object) => object.kind === "character")!;
    character.transform.position = [0, -2.3, 0];
    character.transform.scale = [1, 0, 1];
    useDirectorStore.getState().replaceProject(project);

    const audited = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "audit",
      detail: "summary",
      include_spatial: true,
    });
    const auditToken = (audited.result as { audit_token: string }).audit_token;
    const corrected = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "correct",
      audit_token: auditToken,
    });

    expect(corrected).toMatchObject({
      success: true,
      result: {
        corrected_action_count: 2,
        corrected: expect.arrayContaining([
          expect.objectContaining({ code: "character_below_ground", entity_ids: [character.id] }),
          expect.objectContaining({ code: "collapsed_scale", entity_ids: [character.id] }),
        ]),
        audit_token: expect.stringMatching(/^workbench-audit-/),
      },
    });
    expect(useDirectorStore.getState().project.objects.find((object) => object.id === character.id)?.transform).toEqual(
      {
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
    );
  });

  it("never lowers an intent-unknown elevated object through correct", () => {
    const project = createDefaultDirectorProject();
    project.objects.push({
      id: "unknown-elevated-prop",
      name: "Unknown elevated prop",
      kind: "prop",
      visible: true,
      locked: false,
      geometryType: "box",
      transform: { position: [0, 2.5, 0], rotation: [0, 0, 0], scale: [0.5, 0.5, 0.5] },
    });
    useDirectorStore.getState().replaceProject(project);

    const audited = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "audit",
      include_spatial: true,
    });
    const auditToken = (audited.result as { audit_token: string }).audit_token;
    const corrected = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "correct",
      audit_token: auditToken,
    });

    expect(corrected).toMatchObject({
      success: true,
      result: {
        corrected_action_count: 0,
        requires_agent: expect.arrayContaining([
          expect.objectContaining({ code: "unsupported_object", entity_ids: ["unknown-elevated-prop"] }),
        ]),
      },
    });
    expect(
      useDirectorStore.getState().project.objects.find((object) => object.id === "unknown-elevated-prop")?.transform
        .position,
    ).toEqual([0, 2.5, 0]);
  });

  it("recomputes suggested fixes and never executes a forged client fix", () => {
    const project = createDefaultDirectorProject();
    const character = project.objects.find((object) => object.kind === "character")!;
    character.transform.position = [2, -1.5, 4];
    useDirectorStore.getState().replaceProject(project);

    const corrected = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "correct",
      audit_issues: [
        {
          code: "character_below_ground",
          entity_ids: [character.id],
          suggested_fix: {
            kind: "author_actions",
            actions: [
              {
                action: "update_object",
                object_id: character.id,
                patch: { transform: { position: [999, 999, 999] } },
              },
            ],
          },
        },
      ],
    });

    expect(corrected).toMatchObject({ success: true, result: { corrected_action_count: 1 } });
    expect(
      useDirectorStore.getState().project.objects.find((object) => object.id === character.id)?.transform.position,
    ).toEqual([2, 0, 4]);
  });

  it("returns selective observations and diffs from a prior workbench turn", () => {
    const baseline = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), { op: "observe" });
    const turnId = (baseline.result as { turn_id: string }).turn_id;
    executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "author",
      actions: [...catalogPropActions("diff-box", "Diff Box", { placement_mode: "grounded" })],
    });

    const observed = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "observe",
      fields: ["characters", "cameras", "timeline"],
      since_turn: turnId,
    });
    expect(observed).toMatchObject({
      success: true,
      result: {
        requested_fields: ["characters", "cameras", "timeline"],
        characters: [expect.objectContaining({ id: "char_default_a" })],
        cameras: [expect.objectContaining({ id: "cam_1" })],
        diff: { objects: { added: [expect.objectContaining({ id: "diff-box" })] } },
      },
    });
    expect(observed.result).not.toHaveProperty("assets");
    expect(observed.result).not.toHaveProperty("objects");

    const authorTurnId = (
      executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
        op: "author",
        actions: [{ action: "set_scene", patch: { backgroundColor: "#223344" } }],
      }).result as { turn_id: string }
    ).turn_id;
    const immediateDiff = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "diff",
      since_turn: authorTurnId,
    });
    expect(immediateDiff).toMatchObject({
      success: true,
      result: {
        changed: false,
        turn_effect: { changed: true, scene: { after: { backgroundColor: "#223344" } } },
        changes_since: { changed: false },
      },
    });
  });

  it("surfaces generic production patches in diff and trace summaries", () => {
    const baseline = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), { op: "observe" });
    const baselineTurnId = (baseline.result as { turn_id: string }).turn_id;
    const patched = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "patch",
      patches: [{ op: "replace", path: "/project/production/takes/0/name", value: "第二遍表演" }],
    });
    const patchTurnId = (patched.result as { turn_id: string }).turn_id;

    const diff = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "diff",
      since_turn: baselineTurnId,
    });
    expect(diff).toMatchObject({
      success: true,
      result: {
        changed: true,
        production: {
          before: { takes: [expect.objectContaining({ id: "take_default", name: "默认表演" })] },
          after: { takes: [expect.objectContaining({ id: "take_default", name: "第二遍表演" })] },
        },
      },
    });

    const trace = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "trace",
      turn_id: patchTurnId,
    });
    expect(trace).toMatchObject({
      success: true,
      result: {
        trace_count: 1,
        traces: [
          {
            turn_id: patchTurnId,
            operation: { op: "patch" },
            changed: { changed: true, production_changed: true },
          },
        ],
      },
    });
  });

  it("records concise operation traces with their actual changes", () => {
    executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "author",
      actions: [{ action: "set_scene", patch: { backgroundColor: "#112233" } }],
    });
    const traced = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), { op: "trace", limit: 5 });

    expect(traced).toMatchObject({
      success: true,
      result: {
        trace_count: 1,
        traces: [
          {
            turn_id: "workbench-turn-1",
            operation: { op: "author" },
            success: true,
            changed: { changed: true, scene_changed: true },
            result_summary: { changed: true, action_count: 1 },
          },
        ],
      },
    });
  });
});
