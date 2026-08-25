import { describe, expect, it } from "vitest";
import { BLENDER_KERNEL_TYPED_OPERATION_NAMES } from "../src/blenderKernel";
import {
  blenderLiveCommandBatchSchema,
  blenderLiveReadOperationNames,
  blenderNativeReadOperationNames,
  blenderNativeToolRequestInputSchema,
  blenderNativeToolRequestSchema,
} from "../src/blenderLiveProtocol";

const requestId = "63a521f0-7fe3-4fd7-8e06-8457e806c6b3";

function queryBatch(queries: unknown) {
  return {
    requestId,
    operations: [{ op: "query_spatial", queries }],
  };
}

describe("Blender spatial queries", () => {
  it("accepts all four query kinds and applies raycast defaults", () => {
    const parsed = blenderLiveCommandBatchSchema.parse(
      queryBatch([
        { kind: "RAYCAST", origin: [0, 2, 0], direction: [0, -1, 0] },
        {
          kind: "RAYCAST",
          origin: [1, 1, 1],
          direction: [0.4, -1, 0],
          maxDistance: 25,
          excludeIds: ["chair-a"],
        },
        { kind: "CLOSEST_POINT", point: [1, 1, 1], targetId: "sofa-a" },
        { kind: "OVERLAP", idA: "sofa-a", idB: "table-a" },
        { kind: "GROUND", id: "chair-a", excludeIds: ["gizmo-a"] },
      ]),
    );
    expect(parsed.operations[0]).toMatchObject({
      op: "query_spatial",
      queries: [
        { kind: "RAYCAST", maxDistance: 1_000 },
        { kind: "RAYCAST", maxDistance: 25, excludeIds: ["chair-a"] },
        { kind: "CLOSEST_POINT", targetId: "sofa-a" },
        { kind: "OVERLAP", idA: "sofa-a", idB: "table-a" },
        { kind: "GROUND", id: "chair-a", excludeIds: ["gizmo-a"] },
      ],
    });
  });

  it("accepts NAME object-search queries", () => {
    const parsed = blenderLiveCommandBatchSchema.parse(
      queryBatch([{ kind: "NAME", namePattern: "清华" }]),
    );
    expect(parsed.operations[0]).toMatchObject({
      op: "query_spatial",
      queries: [{ kind: "NAME", namePattern: "清华", maxResults: 50 }],
    });
  });

  it("does not require a scene epoch for a pure spatial-query batch", () => {
    expect(
      blenderLiveCommandBatchSchema.parse(
        queryBatch([{ kind: "GROUND", id: "chair-a" }]),
      ).expectedSceneEpoch,
    ).toBeUndefined();
  });

  it("accepts the 32-query ceiling", () => {
    const parsed = blenderLiveCommandBatchSchema.parse(
      queryBatch(Array.from({ length: 32 }, () => ({ kind: "OVERLAP", idA: "a-1", idB: "b-1" }))),
    );
    expect(parsed.operations[0]).toMatchObject({ op: "query_spatial" });
  });

  it("rejects malformed spatial queries", () => {
    expect(() =>
      blenderLiveCommandBatchSchema.parse(
        queryBatch([{ kind: "RAYCAST", origin: [0, 0, 0], direction: [0, 0, 0] }]),
      ),
    ).toThrow(/non-zero/);
    expect(() => blenderLiveCommandBatchSchema.parse(queryBatch([]))).toThrow();
    expect(() =>
      blenderLiveCommandBatchSchema.parse(
        queryBatch(Array.from({ length: 33 }, () => ({ kind: "OVERLAP", idA: "a-1", idB: "b-1" }))),
      ),
    ).toThrow();
    expect(() =>
      blenderLiveCommandBatchSchema.parse(queryBatch([{ kind: "TELEPORT", id: "chair-a" }])),
    ).toThrow();
    expect(() =>
      blenderLiveCommandBatchSchema.parse(
        queryBatch([{ kind: "RAYCAST", origin: [0, 0, 0], direction: [0, -1, 0], maxDistance: -5 }]),
      ),
    ).toThrow();
    expect(() =>
      blenderLiveCommandBatchSchema.parse(
        queryBatch([
          {
            kind: "GROUND",
            id: "chair-a",
            excludeIds: Array.from({ length: 65 }, (_value, index) => `exclude-${index}`),
          },
        ]),
      ),
    ).toThrow();
  });

  it("parses the first-class read-only query tool request", () => {
    expect(
      blenderNativeToolRequestSchema.parse({
        op: "query",
        queries: [
          { kind: "RAYCAST", origin: [0, 2, 0], direction: [0, -1, 0] },
          { kind: "GROUND", id: "chair-a" },
        ],
      }),
    ).toMatchObject({
      op: "query",
      queries: [
        { kind: "RAYCAST", maxDistance: 1_000 },
        { kind: "GROUND", id: "chair-a" },
      ],
    });
    expect(() =>
      blenderNativeToolRequestSchema.parse({ op: "query", queries: [] }),
    ).toThrow();
    expect(blenderNativeReadOperationNames).toContain("query");
  });

  it("lifts a string query into a NAME object search", () => {
    expect(blenderNativeToolRequestInputSchema.parse({ op: "query", query: "清华" })).toMatchObject({
      op: "query",
      queries: [{ kind: "NAME", namePattern: "清华", maxResults: 50 }],
    });
    expect(
      blenderNativeToolRequestInputSchema.parse({ op: "query", name_pattern: "gate" }),
    ).toMatchObject({
      queries: [{ kind: "NAME", namePattern: "gate" }],
    });
  });

  it("classifies query_spatial as a typed read operation", () => {
    expect(blenderLiveReadOperationNames).toContain("query_spatial");
    expect(BLENDER_KERNEL_TYPED_OPERATION_NAMES).toContain("query_spatial");
  });
});
