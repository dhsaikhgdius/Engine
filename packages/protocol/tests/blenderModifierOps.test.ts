import { describe, expect, it } from "vitest";
import { BLENDER_KERNEL_TYPED_OPERATION_NAMES } from "../src/blenderKernel";
import { blenderAgentOperationSchema } from "../src/blenderLiveProtocol";

const MODIFIER_OPERATION_NAMES = [
  "add_modifier",
  "set_modifier",
  "remove_modifier",
  "reorder_modifier",
  "apply_modifier",
] as const;

describe("Blender modifier-stack operations", () => {
  it("accepts each typed modifier operation", () => {
    expect(
      blenderAgentOperationSchema.parse({
        op: "add_modifier",
        id: "cube-a",
        modifierName: "Agent Solidify",
        modifierType: "SOLIDIFY",
        properties: { thickness: 0.12, use_rim: true },
      }),
    ).toMatchObject({ op: "add_modifier", modifierType: "SOLIDIFY" });
    expect(
      blenderAgentOperationSchema.parse({
        op: "add_modifier",
        id: "cube-a",
        modifierName: "Agent Bevel",
        modifierType: "BEVEL",
      }),
    ).toMatchObject({ op: "add_modifier", properties: {} });
    expect(
      blenderAgentOperationSchema.parse({
        op: "set_modifier",
        id: "cube-a",
        modifierName: "Agent Solidify",
        properties: { thickness: 0.2 },
      }),
    ).toMatchObject({ op: "set_modifier", properties: { thickness: 0.2 } });
    expect(
      blenderAgentOperationSchema.parse({
        op: "remove_modifier",
        id: "cube-a",
        modifierName: "Agent Solidify",
      }),
    ).toMatchObject({ op: "remove_modifier" });
    expect(
      blenderAgentOperationSchema.parse({
        op: "reorder_modifier",
        id: "cube-a",
        modifierName: "Agent Bevel",
        index: 0,
      }),
    ).toMatchObject({ op: "reorder_modifier", index: 0 });
    expect(
      blenderAgentOperationSchema.parse({
        op: "apply_modifier",
        id: "cube-a",
        modifierName: "Agent Solidify",
      }),
    ).toMatchObject({ op: "apply_modifier" });
  });

  it("rejects malformed modifier operations", () => {
    expect(() =>
      blenderAgentOperationSchema.parse({
        op: "add_modifier",
        id: "cube-a",
        modifierName: "Agent Cloth",
        modifierType: "CLOTH",
      }),
    ).toThrow();
    expect(() =>
      blenderAgentOperationSchema.parse({
        op: "add_modifier",
        id: "cube-a",
        modifierName: "Agent Nodes",
        modifierType: "NODES",
      }),
    ).toThrow();
    expect(() =>
      blenderAgentOperationSchema.parse({
        op: "reorder_modifier",
        id: "cube-a",
        modifierName: "Agent Bevel",
        index: -1,
      }),
    ).toThrow();
    expect(() =>
      blenderAgentOperationSchema.parse({
        op: "reorder_modifier",
        id: "cube-a",
        modifierName: "Agent Bevel",
        index: 128,
      }),
    ).toThrow();
    expect(() =>
      blenderAgentOperationSchema.parse({
        op: "set_modifier",
        id: "cube-a",
        modifierName: "Agent Solidify",
        properties: {},
      }),
    ).toThrow(/at least one property/);
    expect(() =>
      blenderAgentOperationSchema.parse({
        op: "remove_modifier",
        modifierName: "Agent Solidify",
      }),
    ).toThrow();
    expect(() =>
      blenderAgentOperationSchema.parse({
        op: "apply_modifier",
        id: "cube-a",
        modifierName: "",
      }),
    ).toThrow();
  });

  it("registers the modifier operations as typed kernel names", () => {
    for (const name of MODIFIER_OPERATION_NAMES) {
      expect(BLENDER_KERNEL_TYPED_OPERATION_NAMES).toContain(name);
    }
  });
});
