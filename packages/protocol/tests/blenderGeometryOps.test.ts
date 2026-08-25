import { describe, expect, it } from "vitest";
import {
  blenderGeometryGraphSchema,
  blenderGeometryNodeTypeSchema,
  blenderLiveCommandBatchSchema,
} from "../src/blenderLiveProtocol";
import { BLENDER_KERNEL_TYPED_OPERATION_NAMES } from "../src/blenderKernel";

const sceneEpoch = "82a6f8c1-7cb8-4d6f-a5f2-a4f5654a0420";

function parseOperation(operation: Record<string, unknown>) {
  return blenderLiveCommandBatchSchema.parse({
    requestId: "63a521f0-7fe3-4fd7-8e06-8457e806c6b3",
    expectedSceneEpoch: sceneEpoch,
    operations: [operation],
  }).operations[0];
}

describe("Blender geometry node vocabulary", () => {
  it("accepts every expanded node type in create_geometry_node", () => {
    expect(blenderGeometryNodeTypeSchema.options).toHaveLength(36);
    for (const nodeType of blenderGeometryNodeTypeSchema.options) {
      expect(
        parseOperation({
          op: "create_geometry_node",
          id: "geo-cube",
          nodeRef: "node-a",
          nodeType,
        }),
      ).toMatchObject({ nodeType, modifierName: "WorldEngine Geometry" });
    }
  });

  it("covers the new node families", () => {
    for (const nodeType of [
      "MESH_UV_SPHERE",
      "CURVE_TO_MESH",
      "INSTANCE_ON_POINTS",
      "SET_MATERIAL",
      "MATH",
      "RANDOM_VALUE",
    ]) {
      expect(blenderGeometryNodeTypeSchema.options).toContain(nodeType);
    }
    expect(() => blenderGeometryNodeTypeSchema.parse("MESH_TORUS")).toThrow();
  });

  it("accepts scalar nodeProperties and rejects invalid shapes", () => {
    expect(
      parseOperation({
        op: "create_geometry_node",
        id: "geo-cube",
        nodeRef: "math",
        nodeType: "MATH",
        nodeProperties: { operation: "MULTIPLY", use_clamp: true, extra: 0.5 },
      }),
    ).toMatchObject({
      nodeProperties: { operation: "MULTIPLY", use_clamp: true, extra: 0.5 },
    });
    for (const nodeProperties of [
      { operation: ["MULTIPLY"] },
      { operation: { value: "MULTIPLY" } },
      { operation: Number.POSITIVE_INFINITY },
      { operation: null },
    ]) {
      expect(() =>
        parseOperation({
          op: "create_geometry_node",
          id: "geo-cube",
          nodeRef: "math",
          nodeType: "MATH",
          nodeProperties,
        }),
      ).toThrow();
    }
  });
});

describe("Blender geometry modifier input ops", () => {
  it("parses set_geometry_modifier_input with number and boolean values", () => {
    expect(
      parseOperation({
        op: "set_geometry_modifier_input",
        id: "geo-cube",
        inputRef: "Level",
        value: 2,
      }),
    ).toEqual({
      op: "set_geometry_modifier_input",
      id: "geo-cube",
      modifierName: "WorldEngine Geometry",
      inputRef: "Level",
      value: 2,
    });
    expect(
      parseOperation({
        op: "set_geometry_modifier_input",
        id: "geo-cube",
        modifierName: "Custom Geometry",
        inputRef: "Socket_2",
        value: true,
      }),
    ).toMatchObject({ modifierName: "Custom Geometry", value: true });
    expect(() =>
      parseOperation({
        op: "set_geometry_modifier_input",
        id: "geo-cube",
        inputRef: "Level",
        value: "two",
      }),
    ).toThrow();
    expect(() =>
      parseOperation({
        op: "set_geometry_modifier_input",
        id: "geo-cube",
        inputRef: "",
        value: 1,
      }),
    ).toThrow();
  });

  it("parses assign_geometry_node_group and requires a node group name", () => {
    expect(
      parseOperation({
        op: "assign_geometry_node_group",
        id: "geo-cube",
        nodeGroupName: "Agent Shared Cone",
      }),
    ).toEqual({
      op: "assign_geometry_node_group",
      id: "geo-cube",
      modifierName: "WorldEngine Geometry",
      nodeGroupName: "Agent Shared Cone",
    });
    expect(() => parseOperation({ op: "assign_geometry_node_group", id: "geo-cube", nodeGroupName: "  " })).toThrow();
  });

  it("registers both ops as typed kernel operations", () => {
    expect(BLENDER_KERNEL_TYPED_OPERATION_NAMES).toContain("set_geometry_modifier_input");
    expect(BLENDER_KERNEL_TYPED_OPERATION_NAMES).toContain("assign_geometry_node_group");
  });

  it("parses graph inspections with modifierInputs and node properties", () => {
    const graph = blenderGeometryGraphSchema.parse({
      objectId: "geo-cube",
      modifierName: "WorldEngine Geometry",
      nodeGroupName: "Cube Geometry",
      modifierInputs: [{ identifier: "Socket_2", name: "Level", socketType: "NodeSocketInt", value: 2 }],
      nodes: [
        {
          nodeRef: "math",
          name: "math",
          label: "",
          nodeType: "MATH",
          blenderType: "ShaderNodeMath",
          location: [0, 0],
          inputs: [],
          outputs: [],
          properties: { operation: "MULTIPLY", use_clamp: false },
        },
      ],
      links: [],
    });
    expect(graph.modifierInputs[0]).toMatchObject({ identifier: "Socket_2", value: 2 });
    expect(graph.nodes[0].properties).toEqual({ operation: "MULTIPLY", use_clamp: false });
  });
});

describe("Blender parameterized primitives", () => {
  it("accepts segments and rings within bounds", () => {
    expect(
      parseOperation({
        op: "create_primitive",
        id: "sphere-a",
        primitive: "uv_sphere",
        segments: 12,
        rings: 6,
      }),
    ).toMatchObject({ segments: 12, rings: 6 });
    expect(
      parseOperation({
        op: "create_primitive",
        id: "cyl-a",
        primitive: "cylinder",
        segments: 256,
      }),
    ).toMatchObject({ segments: 256 });
  });

  it("rejects out-of-bounds and non-integer values", () => {
    for (const extras of [{ segments: 2 }, { segments: 257 }, { segments: 12.5 }, { rings: 2 }, { rings: 129 }]) {
      expect(() =>
        parseOperation({
          op: "create_primitive",
          id: "sphere-a",
          primitive: "uv_sphere",
          ...extras,
        }),
      ).toThrow();
    }
  });

  it("accepts the uv_sphere and ico_sphere primitive names", () => {
    for (const primitive of ["uv_sphere", "ico_sphere"]) {
      expect(parseOperation({ op: "create_primitive", id: "p-a", primitive })).toMatchObject({ primitive });
    }
  });
});
