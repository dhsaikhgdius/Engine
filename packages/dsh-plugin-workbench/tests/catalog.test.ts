// @vitest-environment node

import { describe, expect, it } from "vitest";
import { directorWorkbenchOperationSchema } from "@director/agent-engine";
import {
  DIRECTOR_AGENT_WIRE_SCHEMAS,
  DIRECTOR_WORKBENCH_PLUGIN_TOOLS,
  isDirectorWorkbenchPluginTool,
} from "../src/catalog";

function pluginTool(name: (typeof DIRECTOR_WORKBENCH_PLUGIN_TOOLS)[number]["name"]) {
  const tool = DIRECTOR_WORKBENCH_PLUGIN_TOOLS.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing Director plugin tool ${name}`);
  return tool;
}

describe("Director DSH workbench plugin catalog", () => {
  it("owns Stage, Canvas/Video, generation, Blender, and game-slice tools", () => {
    expect(DIRECTOR_WORKBENCH_PLUGIN_TOOLS.map((tool) => tool.name)).toEqual([
      "director_creative",
      "director_workbench",
      "stage_video",
      "blender_native",
      "director_game",
    ]);
    expect(isDirectorWorkbenchPluginTool("read")).toBe(false);
    expect(isDirectorWorkbenchPluginTool("director_workbench")).toBe(true);
  });

  it("keeps compact discoverable envelopes for each domain tool", () => {
    const schema = pluginTool("director_workbench").inputSchema as {
      properties?: { op?: { enum?: unknown[] } };
      additionalProperties?: unknown;
    };
    expect(schema.properties?.op?.enum).toEqual(expect.arrayContaining(["describe", "observe", "author", "capture"]));
    expect(schema.additionalProperties).not.toBe(false);
    expect(
      DIRECTOR_AGENT_WIRE_SCHEMAS.director_workbench.safeParse({ op: "observe", misspelled_field: true }).success,
    ).toBe(true);
    expect(directorWorkbenchOperationSchema.safeParse({ op: "observe", misspelled_field: true }).success).toBe(false);
  });

  it("projects the compact contract into the JSON Schema subset enforced by DSH", () => {
    const schema = pluginTool("director_workbench").dshParameters as {
      properties?: { op?: { enum?: unknown[] }; catalog?: { enum?: unknown[] }; spatial?: unknown };
      required?: string[];
      additionalProperties?: unknown;
    };
    expect(schema.properties?.op?.enum).toContain("catalog");
    expect(schema.properties?.catalog?.enum).toEqual([
      "assets",
      "character_assets",
      "character_motions",
      "project_assets",
    ]);
    expect(schema.properties?.spatial).toBeDefined();
    expect(schema.required).toContain("op");
    expect(schema.additionalProperties).toBe(true);
    expect(JSON.stringify(schema)).not.toMatch(/\"\$schema\"|\"minLength\"|\"maximum\"|\"prefixItems\"/);
  });

  it("keeps the white-box blockout path discoverable on the blender_native envelope", () => {
    const blender = pluginTool("blender_native");
    expect(blender.description).toContain("create_blockout");
    expect(blender.description).toContain("create_opening");
    expect(blender.description).toContain("floor/wall/room/corridor/stairs");
    const operations = (blender.dshParameters as { properties?: { operations?: { description?: string } } }).properties
      ?.operations;
    expect(operations?.description).toContain("create_blockout");
    expect(operations?.description).toContain("create_opening");
    expect(pluginTool("director_workbench").description).toContain("geometry_type");
  });

  it("keeps every tool description a short routing envelope, not a parameter reference", () => {
    // Channel 3 of the canonical source order: descriptions route to the right
    // tool and name entry operations. Exact parameter vocabulary stays in
    // capabilities/describe; a description that outgrows this budget is
    // becoming a second vocabulary.
    for (const tool of DIRECTOR_WORKBENCH_PLUGIN_TOOLS) {
      expect(tool.description.length).toBeLessThan(1200);
    }
  });

  it("rejects catalog calls that omit the catalog id before dispatch", () => {
    expect(DIRECTOR_AGENT_WIRE_SCHEMAS.director_workbench.safeParse({ op: "catalog" }).success).toBe(false);
    expect(DIRECTOR_AGENT_WIRE_SCHEMAS.director_workbench.safeParse({ op: "catalog", catalog: "assets" }).success).toBe(
      true,
    );
  });

  it("exposes creative describe and requires its target before dispatch", () => {
    const schema = pluginTool("director_creative").dshParameters as {
      properties?: { op?: { enum?: unknown[] }; target?: unknown };
    };
    expect(schema.properties?.op?.enum).toContain("describe");
    expect(schema.properties?.target).toBeDefined();
    expect(DIRECTOR_AGENT_WIRE_SCHEMAS.director_creative.safeParse({ op: "describe" }).success).toBe(false);
    expect(
      DIRECTOR_AGENT_WIRE_SCHEMAS.director_creative.safeParse({ op: "describe", target: "interchange" }).success,
    ).toBe(true);
  });

  it("exposes the read-path fields agents actually send on the workbench envelope", () => {
    const schema = pluginTool("director_workbench").dshParameters as {
      properties?: Record<string, { type?: string; enum?: unknown[]; description?: string }>;
    };
    for (const field of [
      "target",
      "query",
      "name_pattern",
      "kind",
      "entity",
      "since_revision",
      "object_mode",
      "max_objects",
      "max_changes",
      "evidence",
    ]) {
      expect(schema.properties?.[field], `dshParameters must expose ${field}`).toBeDefined();
      expect(schema.properties?.[field]?.description, `${field} must carry a description`).toBeTruthy();
    }
    expect(schema.properties?.entity?.enum).toEqual(
      expect.arrayContaining(["object", "light", "camera", "asset", "catalog_asset"]),
    );
    expect(schema.properties?.kind?.enum).toEqual(["character", "scene", "prop", "camera", "panorama"]);
    expect(schema.properties?.object_mode?.enum).toEqual(["flat", "hierarchy"]);
    expect(schema.properties?.evidence?.type).toBe("object");
  });

  it("accepts the documented read and describe example payloads", () => {
    const wire = DIRECTOR_AGENT_WIRE_SCHEMAS.director_workbench;
    const examples = [
      { op: "describe", target: "capture" },
      { op: "describe", target: "author.add_object" },
      { op: "describe", target: "author.evidence" },
      { op: "query_objects", name_pattern: "door", kind: "prop" },
      { op: "query_objects", name_pattern: "门" },
      { op: "inspect", entity: "object", id: "door-1" },
      { op: "inspect", entity: "camera", id: "cam-main" },
      { op: "observe", fields: ["objects"], object_mode: "hierarchy", max_objects: 200 },
      {
        op: "observe",
        fields: ["objects", "cameras", "lights"],
        since_revision: "REVISION_FROM_PREVIOUS_RESPONSE",
        max_changes: 100,
      },
      { op: "catalog", catalog: "assets", query: "wood chair", limit: 12 },
    ];
    for (const example of examples) {
      const parsed = wire.safeParse(example);
      expect(parsed.success, `wire schema must accept ${JSON.stringify(example)}`).toBe(true);
    }
    // pilot reuses target as an [x,y,z] look-at point; typing target must not break it.
    expect(wire.safeParse({ op: "pilot", action: "set_view", target: [0, 1, 0] }).success).toBe(true);
    expect(directorWorkbenchOperationSchema.safeParse({ op: "inspect", entity: "object", id: "door-1" }).success).toBe(
      true,
    );
    expect(
      directorWorkbenchOperationSchema.safeParse({ op: "query_objects", name_pattern: "door", kind: "prop" }).success,
    ).toBe(true);
  });

  it("accepts author evidence as an object and rejects the boolean shorthand", () => {
    const wire = DIRECTOR_AGENT_WIRE_SCHEMAS.director_workbench;
    const addChair = {
      action: "add_object",
      id: "catalog-instance-flick:furniture:chair.glb",
      name: "Chair",
      kind: "prop",
      asset_id: "flick:furniture:chair.glb",
      placement_mode: "grounded",
    };
    expect(wire.safeParse({ op: "author", actions: [addChair], evidence: {} }).success).toBe(true);
    expect(wire.safeParse({ op: "author", actions: [addChair], evidence: { camera_id: "camera-main" } }).success).toBe(
      true,
    );
    expect(wire.safeParse({ op: "author", actions: [addChair], evidence: true }).success).toBe(false);
  });

  it("exposes the creative request envelope for interchange, collaboration, and pipeline", () => {
    const schema = pluginTool("director_creative").dshParameters as {
      properties?: Record<string, { description?: string }>;
    };
    expect(schema.properties?.request).toBeDefined();
    expect(schema.properties?.request?.description).toBeTruthy();
    expect(
      DIRECTOR_AGENT_WIRE_SCHEMAS.director_creative.safeParse({
        op: "interchange",
        request: { action: "capabilities" },
      }).success,
    ).toBe(true);
    expect(DIRECTOR_AGENT_WIRE_SCHEMAS.director_creative.safeParse({ op: "interchange", request: {} }).success).toBe(
      false,
    );
  });

  it("exposes the video job and provider fields agents need across the job lifecycle", () => {
    const schema = pluginTool("stage_video").dshParameters as {
      properties?: Record<string, { enum?: unknown[]; description?: string }>;
    };
    for (const field of ["prompt", "job_id", "provider", "duration_s", "width", "height"]) {
      expect(schema.properties?.[field], `dshParameters must expose ${field}`).toBeDefined();
    }
    expect(schema.properties?.provider?.enum).toEqual(["ltx-2.3", "comfyui", "minimax-h3"]);
    expect(
      DIRECTOR_AGENT_WIRE_SCHEMAS.stage_video.safeParse({ op: "status", job_id: "video-0123456789" }).success,
    ).toBe(true);
    expect(
      DIRECTOR_AGENT_WIRE_SCHEMAS.stage_video.safeParse({
        op: "prepare",
        prompt: "rainy rooftop chase",
        provider: "ltx-2.3",
        duration_s: 5,
        width: 768,
        height: 512,
      }).success,
    ).toBe(true);
  });

  it("exposes common author and Blender apply fields on the compact envelope", () => {
    const workbench = pluginTool("director_workbench").dshParameters as {
      properties?: { actions?: unknown; fields?: unknown; object_id?: unknown };
    };
    const blender = pluginTool("blender_native").dshParameters as {
      properties?: { operations?: unknown; query?: unknown; name_pattern?: unknown; assetType?: unknown };
    };
    expect(workbench.properties?.actions).toBeDefined();
    expect(workbench.properties?.fields).toBeDefined();
    expect(workbench.properties?.object_id).toBeDefined();
    expect(blender.properties?.operations).toBeDefined();
    expect(blender.properties?.query).toBeDefined();
    expect(blender.properties?.name_pattern).toBeDefined();
    expect(blender.properties?.assetType).toBeDefined();
    expect(
      DIRECTOR_AGENT_WIRE_SCHEMAS.blender_native.safeParse({ op: "polyhaven_search", query: "chair" }).success,
    ).toBe(true);
    expect(
      DIRECTOR_AGENT_WIRE_SCHEMAS.blender_native.safeParse({
        op: "capture_render",
        cameraId: "camera_front",
        width: 1280,
        height: 720,
      }).success,
    ).toBe(true);
    expect(
      DIRECTOR_AGENT_WIRE_SCHEMAS.blender_native.safeParse({
        op: "query",
        query: "清华",
      }).success,
    ).toBe(true);
    expect(
      DIRECTOR_AGENT_WIRE_SCHEMAS.blender_native.safeParse({
        op: "query",
        name_pattern: "清华",
      }).success,
    ).toBe(true);
    expect(
      DIRECTOR_AGENT_WIRE_SCHEMAS.blender_native.safeParse({
        op: "apply",
        operations: [{ op: "polyhaven_import", assetId: "chair" }],
      }).success,
    ).toBe(true);
    expect(
      DIRECTOR_AGENT_WIRE_SCHEMAS.director_workbench.safeParse({
        op: "query_objects",
        name_pattern: "门",
        kind: "prop",
        max_results: 20,
      }).success,
    ).toBe(true);
    expect(
      DIRECTOR_AGENT_WIRE_SCHEMAS.director_workbench.safeParse({
        op: "inspect",
        entity: "object",
        id: "door-1",
      }).success,
    ).toBe(true);
    expect(
      DIRECTOR_AGENT_WIRE_SCHEMAS.director_workbench.safeParse({
        op: "observe",
        fields: ["objects"],
        since_revision: "rev-1",
        object_mode: "hierarchy",
        max_objects: 200,
      }).success,
    ).toBe(true);
    expect(
      DIRECTOR_AGENT_WIRE_SCHEMAS.director_workbench.safeParse({
        op: "author",
        actions: [{ action: "update_object", object_id: "hero", patch: { name: "Hero" } }],
        evidence: {},
      }).success,
    ).toBe(true);
    expect(DIRECTOR_AGENT_WIRE_SCHEMAS.stage_video.safeParse({ op: "status", job_id: "job-1" }).success).toBe(true);
  });

  it("exposes describe/query_objects/inspect fields on the DSH compact envelope", () => {
    const schema = pluginTool("director_workbench").dshParameters as {
      properties?: {
        target?: unknown;
        name_pattern?: unknown;
        entity?: unknown;
        since_revision?: unknown;
        evidence?: unknown;
      };
    };
    expect(schema.properties?.target).toBeDefined();
    expect(schema.properties?.name_pattern).toBeDefined();
    expect(schema.properties?.entity).toBeDefined();
    expect(schema.properties?.since_revision).toBeDefined();
    expect(schema.properties?.evidence).toBeDefined();
  });

  it("routes director_game through a compact envelope and keeps the description short", () => {
    const game = pluginTool("director_game");
    expect(game.description).toContain("capabilities");
    expect(game.description).toContain("describe");
    expect(game.description).toContain("director_dcc");
    expect(game.description.length).toBeLessThan(1200);
    const schema = game.dshParameters as { properties?: { op?: { enum?: unknown[] }; slice_id?: unknown } };
    expect(schema.properties?.op?.enum).toEqual(
      expect.arrayContaining(["capabilities", "describe", "plan", "bind", "playtest", "evaluate", "export_slice"]),
    );
    expect(schema.properties?.slice_id).toBeDefined();
    expect(DIRECTOR_AGENT_WIRE_SCHEMAS.director_game.safeParse({ op: "capabilities" }).success).toBe(true);
    expect(
      DIRECTOR_AGENT_WIRE_SCHEMAS.director_game.safeParse({
        op: "plan",
        brief: { requirement: "walk to a stele", genre: "exploration" },
      }).success,
    ).toBe(true);
  });
});
