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
  it("owns only Stage, Canvas/Video, generation, and Blender tools", () => {
    expect(DIRECTOR_WORKBENCH_PLUGIN_TOOLS.map((tool) => tool.name)).toEqual([
      "director_creative",
      "director_workbench",
      "stage_video",
      "blender_native",
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

  it("exposes common author and Blender apply fields on the compact envelope", () => {
    const workbench = pluginTool("director_workbench").dshParameters as {
      properties?: { actions?: unknown; fields?: unknown; object_id?: unknown };
    };
    const blender = pluginTool("blender_native").dshParameters as {
      properties?: { operations?: unknown; query?: unknown; assetType?: unknown };
    };
    expect(workbench.properties?.actions).toBeDefined();
    expect(workbench.properties?.fields).toBeDefined();
    expect(workbench.properties?.object_id).toBeDefined();
    expect(blender.properties?.operations).toBeDefined();
    expect(blender.properties?.query).toBeDefined();
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
        op: "apply",
        operations: [{ op: "polyhaven_import", assetId: "chair" }],
      }).success,
    ).toBe(true);
  });
});
