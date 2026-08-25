import { describe, expect, it } from "vitest";
import { flattenDirectorToolResult } from "../src/flattenToolResult";

describe("flattenDirectorToolResult", () => {
  it("lifts observe counts onto the envelope", () => {
    const flattened = flattenDirectorToolResult({
      success: true,
      result: { counts: { objects: 73 }, project_revision: "rev-1" },
    });
    expect(flattened.counts).toEqual({ objects: 73 });
    expect((flattened.result as { counts?: unknown }).counts).toEqual({ objects: 73 });
  });

  it("unwraps blender inspect job envelopes so dimensions are defined", () => {
    const flattened = flattenDirectorToolResult({
      success: true,
      result: {
        job: { status: "succeeded" },
        result: {
          id: "we-object-roof",
          name: "gate_roof",
          dimensions: [32, 2.26, 12.8],
          position: [0, 8.05, 0],
        },
        inspection: { id: "we-object-roof", dimensions: [32, 2.26, 12.8] },
      },
    });
    expect(flattened.dimensions).toEqual([32, 2.26, 12.8]);
    expect(flattened.position).toEqual([0, 8.05, 0]);
    expect(flattened.id).toBe("we-object-roof");
    expect((flattened.result as { dimensions?: unknown }).dimensions).toEqual([32, 2.26, 12.8]);
    expect(JSON.parse(JSON.stringify(flattened))).toEqual(flattened);
  });

  it("lifts audit ready onto the envelope", () => {
    const flattened = flattenDirectorToolResult({
      success: true,
      result: { ready: true, error_count: 0, warning_count: 2, summary: "ok" },
    });
    expect(flattened.ready).toBe(true);
    expect(flattened.error_count).toBe(0);
    expect(flattened.summary).toBe("ok");
  });

  it("lifts blender apply receipt warnings onto the envelope", () => {
    const flattened = flattenDirectorToolResult({
      success: true,
      result: {
        receipt: {
          warnings: ["Unknown Blender material: gold_plaque. This object was skipped; other operations in the batch still applied."],
        },
        evidence: { objects: [] },
      },
    });
    expect(flattened.warnings).toEqual([
      "Unknown Blender material: gold_plaque. This object was skipped; other operations in the batch still applied.",
    ]);
  });

  it("lifts blender apply receipt and metrics so DSH code can return lossless JSON", () => {
    const flattened = flattenDirectorToolResult({
      success: true,
      result: {
        sceneEpoch: 12,
        job: { status: "succeeded" },
        receipt: {
          metrics: { before: { objects: 8 }, after: { objects: 0 } },
        },
        evidence: { objects: [] },
      },
    });
    expect(flattened.receipt).toEqual({
      metrics: { before: { objects: 8 }, after: { objects: 0 } },
    });
    expect(flattened.metrics).toEqual({ before: { objects: 8 }, after: { objects: 0 } });
    expect(flattened.sceneEpoch).toBe(12);
    expect(JSON.parse(JSON.stringify(flattened))).toEqual(flattened);
    expect(
      JSON.parse(JSON.stringify({ blender: (flattened.receipt as { metrics?: unknown } | undefined)?.metrics })),
    ).toEqual({
      blender: { before: { objects: 8 }, after: { objects: 0 } },
    });
  });

  it("lifts blender name-query objects onto the envelope", () => {
    const flattened = flattenDirectorToolResult({
      success: true,
      result: {
        job: { status: "succeeded" },
        result: {
          queries: [{ kind: "NAME", namePattern: "清华" }],
          objects: [{ id: "gate-a", name: "清华二校门" }],
        },
      },
    });
    expect(flattened.objects).toEqual([{ id: "gate-a", name: "清华二校门" }]);
  });
});
