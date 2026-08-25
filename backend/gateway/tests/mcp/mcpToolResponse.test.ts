import { describe, expect, it } from "vitest";
import { createDefaultScene } from "@director/stage-protocol";
import {
  createMcpToolResponse,
  mcpToolStructuredOutputSchema,
  stripEncodedMediaFromSerializedView,
} from "../../mcpToolResponse";

function sceneObjects(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `prop-${index}`,
    name: `道具${index}`,
    kind: "prop",
    transform: { position: [index, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  }));
}

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

  it("leaves a small observe result untouched", () => {
    const result = {
      project_revision: "rev-small",
      counts: { objects: 2, cameras: 1 },
      objects: sceneObjects(2),
      active_camera_id: "camera-1",
    };
    const response = createMcpToolResponse({ scene: createDefaultScene(), success: true, result });

    expect(mcpToolStructuredOutputSchema.safeParse(response.structuredContent).success).toBe(true);
    expect(response.structuredContent.result).toEqual(result);
    expect(response.structuredContent.result).not.toHaveProperty("observe_mode");
    expect(response.structuredContent.result).not.toHaveProperty("retrieval_hint");
  });

  it("summarizes an oversized observe into counts, id samples, and a retrieval hint", () => {
    const response = createMcpToolResponse({
      scene: createDefaultScene(),
      success: true,
      result: {
        project_revision: "rev-large",
        active_camera_id: "camera-main",
        counts: { objects: 80, cameras: 2 },
        objects: sceneObjects(80),
      },
    });

    expect(mcpToolStructuredOutputSchema.safeParse(response.structuredContent).success).toBe(true);
    expect(response.structuredContent.result).toMatchObject({
      observe_mode: "summary",
      projection_reason: "heavy_collection",
      project_revision: "rev-large",
      active_camera_id: "camera-main",
      counts: { objects: 80, cameras: 2 },
      objects: {
        count: 80,
        ids: expect.arrayContaining(["prop-0", "prop-23"]),
        omitted: 56,
      },
      retrieval_hint: expect.stringContaining("inspect"),
    });
    const textBlock = response.content[0] as { type: "text"; text: string };
    expect(textBlock.text).toContain("rev-large");
    expect(textBlock.text).not.toContain("prop-59");
  });

  it("summarizes an oversized Creative observe into snapshot counts and bounded ids", () => {
    const nodes = Array.from({ length: 80 }, (_, index) => ({
      id: `node-${index}`,
      kind: "shot",
      title: `Shot ${index}`,
      body: "x".repeat(300),
    }));
    const response = createMcpToolResponse(
      {
        scene: createDefaultScene(),
        success: true,
        result: {
          op: "observe",
          snapshot: {
            version: 1,
            workspace: { mode: "canvas", can_undo: true, can_redo: false },
            board: {
              nodes,
              edges: [],
              pipeline_runs: [],
              dag: { valid: true, roots: ["node-0"], leaves: ["node-79"], issues: [] },
              viewport: { x: 0, y: 0, zoom: 1 },
            },
            edit: { tracks: [], settings: { fps: 24 }, playhead_sec: 0, timeline_zoom: 1 },
            media: { status: "ready", storage_mode: "local", assets: [] },
            gallery: { media: [], folders: [], preferences: { view_mode: "grid" } },
            selection: { board_node_id: "node-0", clip_id: null },
            counts: {
              board_nodes: 80,
              board_edges: 0,
              pipeline_runs: 0,
              tracks: 0,
              clips: 0,
              media_assets: 0,
              gallery_media: 0,
              gallery_folders: 0,
            },
          },
        },
      },
      "director_creative",
    );

    expect(mcpToolStructuredOutputSchema.safeParse(response.structuredContent).success).toBe(true);
    expect(response.structuredContent.result).toMatchObject({
      op: "observe",
      observe_mode: "summary",
      retrieval_hint: expect.stringContaining('observe accepts only {"op":"observe"}'),
      snapshot: {
        counts: { board_nodes: 80, tracks: 0 },
        board: {
          nodes: { count: 80, omitted: 56, items: expect.any(Array) },
          dag: { valid: true, root_ids: ["node-0"], leaf_ids: ["node-79"], issue_count: 0 },
        },
      },
    });
    const textBlock = response.content[0] as { type: "text"; text: string };
    expect(textBlock.text).not.toContain("Shot 79");
    expect(textBlock.text).not.toContain("x".repeat(300));
  });

  it("keeps capture bytes out of the serialized text and structured JSON", () => {
    const base64 = "QkFTRTY0QllURVM=";
    const response = createMcpToolResponse({
      scene: createDefaultScene(),
      success: true,
      result: {
        capture_requested: true,
        capture: { mimeType: "image/png", width: 1280, height: 720, data: base64 },
      },
      capture: { mimeType: "image/png", data: base64 },
    });

    expect(mcpToolStructuredOutputSchema.safeParse(response.structuredContent).success).toBe(true);
    expect(response.structuredContent.result).toEqual({
      capture_requested: true,
      capture: { mimeType: "image/png", width: 1280, height: 720 },
    });
    const textBlock = response.content[0] as { type: "text"; text: string };
    expect(textBlock.text).not.toContain(base64);
    expect(response.content[1]).toEqual({
      type: "image",
      data: base64,
      mimeType: "image/png",
      annotations: { audience: ["assistant"], priority: 1 },
    });
  });

  it("strips data and dataBase64 from capture-shaped records at any depth", () => {
    const sanitized = stripEncodedMediaFromSerializedView({
      success: true,
      capture: { mimeType: "image/png", dataBase64: "QkFTRTY0", width: 64 },
      result: {
        capture: { mimeType: "image/jpeg", data: "SlBFRw==" },
        attachments: [{ mimeType: "image/webp", dataBase64: "V0VCUA==", name: "frame" }],
        data: "plain result data stays",
      },
    });

    expect(sanitized).toEqual({
      success: true,
      capture: { mimeType: "image/png", width: 64 },
      result: {
        capture: { mimeType: "image/jpeg" },
        attachments: [{ mimeType: "image/webp", name: "frame" }],
        data: "plain result data stays",
      },
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
