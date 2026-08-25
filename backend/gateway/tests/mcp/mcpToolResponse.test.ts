import { describe, expect, it } from "vitest";
import { createDefaultScene } from "@director/stage-protocol";
import { createMcpToolResponse, mcpToolStructuredOutputSchema } from "../../mcpToolResponse";

describe("MCP tool response", () => {
  it("keeps action results and useful scene feedback in structuredContent", () => {
    const response = createMcpToolResponse({
      scene: createDefaultScene(),
      success: true,
      result: { object_id: "cube-1" },
      target: {
        token: "target-1",
        client_id: "browser-1",
        instance_id: "scene-1",
        scene_id: "scene-1",
        creative_scope_id: "scene-1",
        contract_version: 2,
      },
      feedback: {
        changed: { object_ids: ["cube-1"], track_ids: [], scene_settings: false },
        scene_hint: {
          scene_name: "场景 1",
          aspect: "16:9",
          object_count: 4,
          renderable_object_count: 2,
          camera_ids: ["camera-1"],
          suggested_camera_id: "camera-1",
          track_count: 1,
          validation: { ready: true, video_ready: true, error_count: 0, warning_count: 0 },
        },
        context: { objects: [{ id: "cube-1", kind: "cube", name: "Cube" }], tracks: [] },
        available_refs: { block: "cube-1" },
      },
    });

    expect(mcpToolStructuredOutputSchema.safeParse(response.structuredContent).success).toBe(true);
    expect(response.structuredContent).toMatchObject({
      ok: true,
      code: null,
      result: { object_id: "cube-1" },
      suggested_next: null,
      changed: { object_ids: ["cube-1"] },
      scene_hint: { validation: { ready: true, error_count: 0 } },
      available_refs: { block: "cube-1" },
      target: { token: "target-1", scene_id: "scene-1" },
    });
    expect(response.structuredContent).not.toHaveProperty("readiness");
  });

  it("returns a captured frame as an actual MCP image content block", () => {
    const response = createMcpToolResponse({
      scene: createDefaultScene(),
      success: true,
      result: { capture_requested: true },
      capture: { mimeType: "image/png", data: "AAAA" },
    });
    expect(response.content[1]).toEqual({
      type: "image",
      data: "AAAA",
      mimeType: "image/png",
      annotations: { audience: ["assistant"], priority: 1 },
    });
  });

  it("preserves recoverable error context on failure", () => {
    const response = createMcpToolResponse({
      scene: createDefaultScene(),
      success: false,
      code: "target_unavailable",
      error: "The bound Director target is gone",
    });
    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({
      ok: false,
      code: "target_unavailable",
      error: "The bound Director target is gone",
      suggested_next: expect.stringContaining("observe again"),
      scene_hint: { suggested_camera_id: "camera-1" },
    });
  });

  it("lifts nested executor recovery details into the top-level Agent receipt", () => {
    const response = createMcpToolResponse({
      scene: createDefaultScene(),
      success: false,
      error: "Creative workspace changed",
      result: {
        execution: {
          code: "conflict",
          suggested_next: "Observe the current creative workspace, then rebuild the batch.",
        },
      },
    });

    expect(response.structuredContent).toMatchObject({
      code: "conflict",
      suggested_next: "Observe the current creative workspace, then rebuild the batch.",
    });
  });

  it("guides an Agent back to a capture-ready 3D Stage target", () => {
    const response = createMcpToolResponse({
      scene: createDefaultScene(),
      success: false,
      error: "Viewport capture handler is not registered",
      result: { code: "capture_unavailable" },
    });

    expect(response.structuredContent).toMatchObject({
      ok: false,
      code: "capture_unavailable",
      suggested_next: expect.stringContaining("3D Stage"),
    });
  });
});
