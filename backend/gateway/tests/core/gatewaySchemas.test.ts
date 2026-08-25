import { describe, expect, it } from "vitest";
import { productionRecordSchema, productionUpdateRequestSchema, terminalMessageSchema } from "../../gatewaySchemas";

describe("gateway runtime schemas", () => {
  it("rejects a corrupt production manifest instead of accepting a type assertion", () => {
    const result = productionRecordSchema.safeParse({
      productionId: "main",
      revision: 0,
      updatedAt: null,
      updatedBy: null,
      production: { version: 1, title: "制作", activeSceneId: null, scenes: "not-an-array", editorialTimeline: [] },
    });

    expect(result.success).toBe(false);
  });

  it("accepts only known production operations", () => {
    expect(
      productionUpdateRequestSchema.safeParse({
        expectedRevision: 0,
        idempotencyKey: "agent-production-0001",
        operations: [{ op: "rename_production", title: "新制作" }],
      }).success,
    ).toBe(true);
    expect(
      productionUpdateRequestSchema.safeParse({
        expectedRevision: 0,
        operations: [{ op: "write_file", path: "/tmp/unsafe" }],
      }).success,
    ).toBe(false);
    expect(
      productionUpdateRequestSchema.safeParse({
        expectedRevision: 0,
        idempotencyKey: "",
        operations: [{ op: "rename_production", title: "新制作" }],
      }).success,
    ).toBe(false);
  });

  it("rejects malformed terminal messages before a PTY can receive them", () => {
    expect(terminalMessageSchema.safeParse({ type: "term.open", agent: "codex", cols: 80, rows: 24 }).success).toBe(
      true,
    );
    expect(terminalMessageSchema.safeParse({ type: "term.input", data: 42 }).success).toBe(false);
    expect(
      terminalMessageSchema.safeParse({
        type: "capture-response",
        requestId: "capture-1",
        dataUrl: "x".repeat(16_800_001),
      }).success,
    ).toBe(false);
    expect(terminalMessageSchema.safeParse({ type: "hello", role: "director-ui", visible: true }).success).toBe(false);
    expect(
      terminalMessageSchema.safeParse({
        type: "hello",
        role: "director-ui",
        visible: true,
        client_id: "browser-1",
        instance_id: "instance-1",
        scene_id: "scene-1",
        creative_scope_id: "scene-1",
        contract_version: 2,
        workspace: "stage",
        capture_ready: true,
      }).success,
    ).toBe(true);
    expect(
      terminalMessageSchema.safeParse({
        type: "hello",
        role: "director-ui",
        client_id: "browser-1",
        instance_id: "instance-1",
        scene_id: "scene-1",
        creative_scope_id: "scene-1",
        contract_version: 2,
        workspace: "stage",
        capture_ready: "yes",
      }).success,
    ).toBe(false);
  });
});
