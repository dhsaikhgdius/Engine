import { describe, expect, it } from "vitest";
import { createDefaultDirectorProject } from "../src/directorDefaultProject";
import { auditDirectorProject } from "../src/directorAudit";

describe("Director project audit", () => {
  it("returns structured validation and framing feedback", () => {
    const audit = auditDirectorProject(createDefaultDirectorProject());
    expect(audit).toMatchObject({
      visual_judgment: false,
      scope: ["structure", "spatial", "timeline", "storyboard", "camera_framing"],
      issue_count: expect.any(Number),
      error_count: expect.any(Number),
      warning_count: expect.any(Number),
      spatial: {
        contract_version: 1,
        placements: expect.any(Array),
        counts: expect.any(Object),
      },
      validation: expect.anything(),
      framing: expect.anything(),
      suggested_actions: expect.any(Array),
    });
    expect(audit.issues.some((issue) => issue.code === "implicit_generic_character")).toBe(false);
    expect(audit.note).toMatch(/not a visual-quality/i);
    expect(audit.summary).toMatch(/not a visual-quality judgment/i);
  });

  it("detects a catalog-named character that would silently fall back to X Bot", () => {
    const project = createDefaultDirectorProject();
    const character = project.objects.find((object) => object.kind === "character")!;
    character.name = "X Bot";
    delete character.characterSource;
    delete character.assetRefId;

    const audit = auditDirectorProject(project);
    const issue = audit.issues.find((candidate) => candidate.code === "catalog_character_binding_missing");

    expect(issue).toMatchObject({
      severity: "error",
      entity_ids: [character.id, "mixamo:x-bot"],
      suggested_fix: {
        kind: "author_actions",
        actions: [
          { action: "upsert_asset", asset: { id: "mixamo:x-bot" } },
          {
            action: "update_object",
            object_id: character.id,
            patch: { asset_id: "mixamo:x-bot", character_source: "asset" },
          },
        ],
      },
    });
  });

  it("flags visible model assets without a real-world size and suggests the catalog fix", () => {
    const project = createDefaultDirectorProject();
    project.assets.push({
      id: "flick:animals:cat.glb",
      kind: "prop",
      sourceType: "model",
      fileName: "cat.glb",
      name: "Cat",
      url: "/flick-stage-props/animals/cat.glb",
      assetSource: "library",
    });
    project.objects.push({
      id: "prop-cat",
      name: "Cat",
      kind: "prop",
      visible: true,
      locked: false,
      assetRefId: "flick:animals:cat.glb",
      placementMode: "grounded",
      transform: { position: [1, 0, 1], rotation: [0, 0, 0], scale: [1, 1, 1] },
    });

    const audit = auditDirectorProject(project);
    const issue = audit.issues.find((candidate) => candidate.code === "asset_missing_real_world_size");
    expect(issue).toMatchObject({
      severity: "warning",
      entity_ids: ["flick:animals:cat.glb", "prop-cat"],
      suggested_fix: {
        kind: "author_actions",
        actions: [
          {
            action: "upsert_asset",
            asset: { id: "flick:animals:cat.glb", realWorldSizeM: 0.6, sizeSource: "catalog" },
          },
        ],
      },
    });
  });

  it("does not flag metric-sized or server-normalized model assets", () => {
    const project = createDefaultDirectorProject();
    project.assets.push({
      id: "local:sized",
      kind: "prop",
      sourceType: "model",
      fileName: "sized.glb",
      name: "Sized",
      url: "blob:sized",
      assetSource: "local",
      realWorldSizeM: 1.4,
      sizeSource: "user",
    });
    project.objects.push({
      id: "prop-sized",
      name: "Sized",
      kind: "prop",
      visible: true,
      locked: false,
      assetRefId: "local:sized",
      placementMode: "grounded",
      transform: { position: [2, 0, 2], rotation: [0, 0, 0], scale: [1, 1, 1] },
    });

    const audit = auditDirectorProject(project);
    expect(audit.issues.some((candidate) => candidate.code === "asset_missing_real_world_size")).toBe(false);
    expect(audit.issues).toContainEqual(
      expect.objectContaining({
        severity: "warning",
        code: "asset_missing_measured_bounds",
        entity_ids: ["local:sized", "prop-sized"],
      }),
    );

    project.objects.at(-1)!.localBoundsM = { min: [-0.7, 0, -0.4], max: [0.7, 1.4, 0.4] };
    expect(
      auditDirectorProject(project).issues.some((candidate) => candidate.code === "asset_missing_measured_bounds"),
    ).toBe(false);
  });

  it("reports an object whose asset kind does not match its render kind", () => {
    const project = createDefaultDirectorProject();
    const character = project.objects.find((object) => object.kind === "character")!;
    project.assets.push({
      id: "local:chair",
      kind: "prop",
      sourceType: "model",
      fileName: "chair.glb",
      name: "Chair",
      url: "blob:chair",
      assetSource: "local",
    });
    character.characterSource = "asset";
    character.assetRefId = "local:chair";

    const audit = auditDirectorProject(project);
    expect(audit.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "error",
          code: "asset_kind_mismatch",
          entity_ids: [character.id, "local:chair"],
        }),
      ]),
    );
  });

  it("detects below-ground characters, collapsed geometry, and overlap", () => {
    const project = createDefaultDirectorProject();
    const character = project.objects.find((object) => object.kind === "character")!;
    character.transform.position = [0, -0.5, 0];
    character.transform.scale = [1, 0, 1];
    project.objects.push({
      id: "character-overlap",
      name: "重叠角色",
      kind: "character",
      visible: true,
      locked: false,
      transform: { position: [0, -0.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      characterRig: { rigType: "ue4-mannequin", posePresetId: "stand", controls: {} },
    });
    const audit = auditDirectorProject(project);
    expect(audit.ready).toBe(false);
    expect(audit.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["collapsed_scale", "character_below_ground", "overlapping_objects"]),
    );
    expect(audit.issues.find((issue) => issue.code === "character_below_ground")?.suggested_fix).toEqual({
      kind: "author_actions",
      actions: [
        {
          action: "update_object",
          object_id: character.id,
          patch: { transform: { position: [0, project.scene.groundHeight, 0] } },
        },
      ],
    });
    expect(audit.issues.find((issue) => issue.code === "collapsed_scale")?.suggested_fix).toEqual({
      kind: "author_actions",
      actions: [
        {
          action: "update_object",
          object_id: character.id,
          patch: { transform: { scale: [1, 1, 1] } },
        },
      ],
    });
  });

  it("suggests a complete clamped animation instead of asking the agent to calculate frames", () => {
    const project = createDefaultDirectorProject();
    project.scene.timeline = {
      version: 1,
      fps: 24,
      frameStart: 0,
      frameEnd: 24,
      currentFrame: 30,
      loop: true,
    };
    const character = project.objects.find((object) => object.kind === "character")!;
    character.animation = {
      version: 1,
      keyframes: [
        { frame: -5, transform: structuredClone(character.transform) },
        { frame: 30, transform: { ...structuredClone(character.transform), position: [2, 0, 0] } },
      ],
    };

    const audit = auditDirectorProject(project, { include_spatial: false });
    const issue = audit.issues.find((entry) => entry.code === "keyframe_outside_range");
    expect(issue?.suggested_fix).toMatchObject({
      kind: "author_actions",
      actions: [
        {
          action: "set_animation",
          target_type: "object",
          target_id: character.id,
          animation: { keyframes: [{ frame: 0 }, { frame: 24 }] },
        },
      ],
    });
    expect(audit.issues.find((entry) => entry.code === "playhead_outside_range")?.suggested_fix).toMatchObject({
      actions: [{ action: "set_scene", patch: { timeline: { currentFrame: 24 } } }],
    });
  });

  it("accepts either a Director camera id or its linked object id", () => {
    const project = createDefaultDirectorProject();
    const byCamera = auditDirectorProject(project, { camera_id: "cam_1", subject_id: "char_default_a" });
    const byObject = auditDirectorProject(project, { camera_id: "cam_object_1", subject_id: "char_default_a" });
    expect(byCamera.framing).toMatchObject({ camera_id: "cam_object_1" });
    expect(byObject.framing).toMatchObject({ camera_id: "cam_object_1" });
  });

  it("rejects floating floor-pivot geometry and spatial test outliers", () => {
    const project = createDefaultDirectorProject();
    project.objects.push(
      {
        id: "floating-building",
        name: "悬空建筑",
        kind: "prop",
        visible: true,
        locked: false,
        geometryType: "box",
        transform: { position: [0, 3.1, -2], rotation: [0, 0, 0], scale: [4, 3.1, 6] },
      },
      {
        id: "stray-case-object",
        name: "其他 Case 遗留物",
        kind: "prop",
        visible: true,
        locked: false,
        geometryType: "box",
        transform: { position: [60, 0, -60], rotation: [0, 0, 0], scale: [1, 1, 1] },
      },
    );
    const audit = auditDirectorProject(project);
    expect(audit.ready).toBe(false);
    expect(audit.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "unsupported_object", entity_ids: ["floating-building"] }),
        expect.objectContaining({ code: "scene_spatial_outlier", entity_ids: ["stray-case-object"] }),
      ]),
    );
    expect(audit.issues.find((issue) => issue.code === "unsupported_object")?.suggested_fix).toBeUndefined();
    expect(audit.spatial).toMatchObject({
      placements: expect.arrayContaining([
        {
          object_id: "floating-building",
          declared_mode: "auto",
          resolved_mode: "unresolved",
          valid: false,
        },
      ]),
    });
  });

  it("keeps deliberate airborne characters out of grounding corrections", () => {
    const project = createDefaultDirectorProject();
    const character = project.objects.find((object) => object.kind === "character")!;
    character.transform.position = [0, 3, 0];
    character.placementMode = "floating";

    const audit = auditDirectorProject(project);
    expect(
      audit.issues.filter(
        (issue) =>
          issue.entity_ids?.includes(character.id) &&
          ["character_below_ground", "character_not_grounded", "unsupported_object"].includes(issue.code),
      ),
    ).toEqual([]);
    expect(audit.spatial).toMatchObject({
      placements: expect.arrayContaining([
        expect.objectContaining({ object_id: character.id, resolved_mode: "floating", valid: true }),
      ]),
    });
  });

  it("distinguishes an overhead suspension anchor from a side attachment", () => {
    const project = createDefaultDirectorProject();
    project.objects.push(
      {
        id: "overhead-truss",
        name: "Overhead truss",
        kind: "prop",
        visible: true,
        locked: false,
        geometryType: "box",
        placementMode: "floating",
        transform: { position: [0, 3.1, 0], rotation: [0, 0, 0], scale: [2, 0.2, 2] },
      },
      {
        id: "hanging-light",
        name: "Hanging light",
        kind: "prop",
        visible: true,
        locked: false,
        geometryType: "cylinder",
        placementMode: "suspended",
        parentObjectId: "overhead-truss",
        transform: { position: [0, 2.4, 0], rotation: [0, 0, 0], scale: [0.3, 0.5, 0.3] },
      },
    );

    const valid = auditDirectorProject(project);
    expect(valid.issues.some((issue) => issue.code.startsWith("suspended_object_"))).toBe(false);
    expect(valid.spatial).toMatchObject({
      placements: expect.arrayContaining([
        expect.objectContaining({
          object_id: "hanging-light",
          resolved_mode: "suspended",
          anchor_object_id: "overhead-truss",
          valid: true,
        }),
      ]),
    });

    project.objects.find((object) => object.id === "overhead-truss")!.transform.position = [3, 3.1, 0];
    const invalid = auditDirectorProject(project);
    expect(invalid.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "suspended_object_anchor_not_overhead",
          entity_ids: ["hanging-light", "overhead-truss"],
        }),
      ]),
    );
  });

  it("rejects cyclic imported parent graphs before spatial resolution", () => {
    const project = createDefaultDirectorProject();
    const first = project.objects.find((object) => object.kind === "character")!;
    const second = structuredClone(first);
    second.id = "cycle-second";
    second.name = "Cycle second";
    first.parentObjectId = second.id;
    second.parentObjectId = first.id;
    project.objects.push(second);

    const audit = auditDirectorProject(project);
    expect(audit.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "invalid_reference",
          message: expect.stringContaining("object parent cycle detected"),
        }),
      ]),
    );
  });

  it("rejects an active camera that does not belong to the storyboard", () => {
    const project = createDefaultDirectorProject();
    project.storyboard = {
      version: 1,
      title: "分镜",
      logline: "测试",
      shots: [
        {
          id: "shot-without-active-camera",
          title: "空镜",
          cameraId: null,
          frameStart: 0,
          frameEnd: 120,
          shotSize: "wide",
          movement: "static",
          action: "测试",
        },
      ],
    };
    const audit = auditDirectorProject(project);
    expect(audit.ready).toBe(false);
    expect(audit.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "active_camera_outside_storyboard" })]),
    );
  });

  it("verifies persistent character facing relationships and supplies a deterministic correction", () => {
    const project = createDefaultDirectorProject();
    const source = project.objects.find((object) => object.kind === "character")!;
    project.objects.push({
      ...structuredClone(source),
      id: "facing-target",
      name: "对手",
      transform: { ...structuredClone(source.transform), position: [2, 0, 0] },
    });
    source.lookTargetObjectId = "facing-target";
    source.transform.rotation = [0, 0, 0];

    const audit = auditDirectorProject(project);
    const issue = audit.issues.find((entry) => entry.code === "character_facing_mismatch");
    expect(issue).toMatchObject({
      severity: "error",
      entity_ids: [source.id, "facing-target"],
      suggested_fix: {
        kind: "author_actions",
        actions: [
          {
            action: "update_object",
            object_id: source.id,
            patch: { transform: { rotation: [0, 1.570796, 0] } },
          },
        ],
      },
    });
  });
});
