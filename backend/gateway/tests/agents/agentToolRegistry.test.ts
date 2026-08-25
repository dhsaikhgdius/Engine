// @vitest-environment node

import { describe, expect, it } from "vitest";
import { directorWorkbenchOperationSchema } from "@director/agent-engine";
import {
  DIRECTOR_AGENT_WIRE_SCHEMAS,
  DIRECTOR_DYNAMIC_TOOLS,
  directorAgentToolExecutionMode,
  dynamicToolTimeoutMs,
} from "../../agents/agentToolRegistry";

const DOMAIN_TOOLS = ["director_creative", "director_workbench", "stage_video", "blender_native"] as const;

function domainTool(name: (typeof DOMAIN_TOOLS)[number]) {
  const tool = DIRECTOR_DYNAMIC_TOOLS.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing Director domain tool ${name}`);
  return tool;
}

describe("Director Agent tool registry", () => {
  it.each([
    ["director_workbench", ["describe", "observe", "author", "capture"]],
    ["director_creative", ["capabilities", "observe", "execute", "execute_batch"]],
    ["stage_video", ["capabilities", "prepare", "submit", "status"]],
    ["blender_native", ["status", "scene", "apply", "capture", "capture_render", "polyhaven_search"]],
  ] as const)("advertises %s through a compact discoverable operation envelope", (name, expectedOperations) => {
    const schema = domainTool(name).inputSchema as {
      properties?: {
        op?: { enum?: unknown[] };
        catalog?: { enum?: unknown[] };
        spatial?: unknown;
        max_results?: unknown;
      };
      additionalProperties?: unknown;
    };

    expect(schema.properties?.op?.enum).toEqual(expect.arrayContaining([...expectedOperations]));
    expect(schema.additionalProperties).not.toBe(false);
    expect(Buffer.byteLength(JSON.stringify(schema), "utf8")).toBeLessThan(10_000);
  });

  it("puts high-frequency bounded-read rules in the model-visible tool descriptions", () => {
    const workbench = domainTool("director_workbench");
    const schema = workbench.inputSchema as {
      properties?: { catalog?: { enum?: unknown[] }; spatial?: unknown; max_results?: unknown };
    };

    expect(schema.properties?.catalog?.enum).toEqual([
      "assets",
      "character_assets",
      "character_motions",
      "project_assets",
    ]);
    expect(schema.properties?.spatial).toBeTruthy();
    expect(schema.properties?.max_results).toBeTruthy();
    expect(workbench.description).toContain('{"op":"catalog","catalog":"assets"}');
    expect(workbench.description).toContain("never uses target");
    expect(workbench.description).toContain("update_object");
    expect(workbench.description).toContain("patch");
    expect(workbench.description).toContain("spacing_m is 0.9-8");
    expect(domainTool("director_workbench").description).toContain("max_results");
    expect(domainTool("director_workbench").description).toContain('"mode":"frustum"');
    expect(domainTool("director_workbench").description).toContain("copy result.counts verbatim");
    expect(domainTool("director_workbench").description).toContain(
      "call describe when an action's exact fields are unknown",
    );
    expect(domainTool("director_workbench").description).toContain("describe author.evidence");
    expect(domainTool("director_creative").description).toContain('exactly {"op":"observe"}');
    expect(domainTool("director_creative").description).toContain("does not accept fields");
  });

  it("marks inspect, audit, and snapshot as parallel reads", () => {
    expect(directorAgentToolExecutionMode("director_workbench", { op: "describe", target: "capture" })).toBe(
      "parallel",
    );
    expect(
      directorAgentToolExecutionMode("director_workbench", { op: "generated_3d", command: { action: "get" } }),
    ).toBe("parallel");
    expect(directorAgentToolExecutionMode("director_workbench", { op: "audit" })).toBe("parallel");
    expect(directorAgentToolExecutionMode("director_workbench", { op: "snapshot" })).toBe("parallel");
    expect(directorAgentToolExecutionMode("director_workbench", { op: "diff" })).toBe("parallel");
    expect(directorAgentToolExecutionMode("director_creative", { op: "audit" })).toBe("parallel");
    expect(directorAgentToolExecutionMode("director_workbench", { op: "author" })).toBe("exclusive");
    expect(directorAgentToolExecutionMode("director_workbench", { op: "select" })).toBe("exclusive");
    expect(directorAgentToolExecutionMode("blender_native", { op: "polyhaven_search" })).toBe("parallel");
    expect(directorAgentToolExecutionMode("blender_native", { op: "capture_render" })).toBe("parallel");
    expect(directorAgentToolExecutionMode("blender_native", { op: "apply" })).toBe("exclusive");
  });

  it("gives blender_native a 5-minute tool budget", () => {
    expect(dynamicToolTimeoutMs("blender_native", { op: "apply" })).toBe(300_000);
    expect(dynamicToolTimeoutMs("director_workbench", { op: "observe" })).toBe(70_000);
  });

  it("keeps exact field validation in the full Gateway contract", () => {
    const modelPayload = { op: "observe", fields: ["counts"], misspelled_field: true };

    expect(DIRECTOR_AGENT_WIRE_SCHEMAS.director_workbench.safeParse(modelPayload).success).toBe(true);
    expect(directorWorkbenchOperationSchema.safeParse(modelPayload).success).toBe(false);
  });
});
