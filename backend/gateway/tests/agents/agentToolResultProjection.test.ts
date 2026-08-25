// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  DIRECTOR_AGENT_HEAVY_COLLECTION_LIMIT,
  directorAgentModelEnvelope,
  directorAgentToolResultNeedsProjection,
  finalizeDirectorAgentToolEnvelope,
  projectDirectorAgentToolEnvelope,
  slimDirectorAgentToolResult,
} from "../../agents/agentToolResultProjection";

function sceneObjects(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `prop-${index}`,
    name: `道具${index}`,
    kind: "prop",
    transform: { position: [index, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  }));
}

describe("director agent tool result projection", () => {
  it("leaves a small observe result untouched", async () => {
    const envelope = {
      success: true,
      result: {
        project_revision: "rev-small",
        counts: { objects: 2, cameras: 1 },
        objects: sceneObjects(2),
        active_camera_id: "camera-1",
      },
    };

    expect(directorAgentToolResultNeedsProjection(envelope).needed).toBe(false);
    const finalized = await finalizeDirectorAgentToolEnvelope({
      envelope,
      tool: "director_workbench",
      input: { op: "observe" },
    });
    expect(finalized).toEqual({ envelope, spilled: false, reason: null });
  });

  it("uses authoritative workbench counts when feedback carries an older scene hint", () => {
    const envelope = directorAgentModelEnvelope({
      success: true,
      result: { counts: { objects: 120, cameras: 4, tracks: 7 } },
      feedback: {
        scene_hint: {
          object_count: 125,
          camera_ids: ["camera-a", "camera-b"],
          track_count: 6,
          suggested_camera_id: "camera-a",
        },
      },
    });

    expect(envelope.feedback).toEqual({
      scene_hint: {
        object_count: 120,
        track_count: 7,
        suggested_camera_id: "camera-a",
      },
    });
  });

  it("summarizes a large unscoped observe and keeps revision, counts, and a retrieval hint", () => {
    const inner = {
      project_revision: "rev-large",
      project_revision_before: "rev-before",
      turn_id: "turn-1",
      active_camera_id: "camera-main",
      counts: { objects: 80, cameras: 2, lights: 4 },
      objects: sceneObjects(80),
      cameras: [
        { id: "camera-main", name: "主镜头" },
        { id: "camera-b", name: "侧镜头" },
      ],
      ui: { selectedObjectIds: ["prop-3"] },
      graph_issues: [{ id: "issue-1" }],
      scene: { name: "片场" },
    };
    const slim = slimDirectorAgentToolResult(inner, "heavy_collection", {
      locator: "spill_aaaaaaaaaaaaaaaa",
      bytes: 99,
    });

    expect(slim).toMatchObject({
      observe_mode: "summary",
      projection_reason: "heavy_collection",
      project_revision: "rev-large",
      project_revision_before: "rev-before",
      turn_id: "turn-1",
      active_camera_id: "camera-main",
      counts: { objects: 80, cameras: 2, lights: 4 },
      selected_object_ids: ["prop-3"],
      graph_issue_count: 1,
      objects: {
        count: 80,
        ids: expect.arrayContaining(["prop-0", "prop-23"]),
        omitted: 56,
      },
      spill: { locator: "spill_aaaaaaaaaaaaaaaa", bytes: 99 },
    });
    expect(slim.objects).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: "prop-59" })]));
    expect(JSON.stringify(slim)).not.toContain("prop-59");
    expect(slim).not.toHaveProperty("scene");
    expect(slim).not.toHaveProperty("ui");
    expect(String(slim.retrieval_hint)).toContain("inspect");
  });

  it("projects over-budget results that are not a large object list", () => {
    const envelope = {
      success: true,
      result: {
        project_revision: "rev-catalog",
        notes: "x".repeat(20_000),
      },
    };
    expect(directorAgentToolResultNeedsProjection(envelope)).toEqual({ needed: true, reason: "over_budget" });
    const projected = projectDirectorAgentToolEnvelope(envelope, "over_budget");
    expect(projected.result).toMatchObject({
      observe_mode: "summary",
      projection_reason: "over_budget",
      project_revision: "rev-catalog",
      notes: expect.stringMatching(/^x+…\[truncated \d+ chars\]$/),
    });
    expect(String((projected.result as { notes: string }).notes).length).toBeLessThan(2_200);
  });

  it("keeps actionable audit findings when a large spatial audit is projected", () => {
    const issues = Array.from({ length: 80 }, (_, index) => ({
      severity: index === 0 ? "error" : "warning",
      code: `audit-${index}`,
      message: `Issue ${index}`,
      entity_ids: [`object-${index}`],
      suggested_fix: { kind: "author_actions", actions: [{ action: "delete_object", object_id: `object-${index}` }] },
    }));
    const projected = projectDirectorAgentToolEnvelope(
      {
        success: true,
        result: {
          ready: false,
          summary: "1 error and 79 warnings need attention.",
          issue_count: 80,
          error_count: 1,
          warning_count: 79,
          issues,
          spatial: {
            counts: { grounded: 10, unresolved: 70 },
            placements: sceneObjects(80),
          },
          framing: {
            camera_id: "camera-main",
            evaluated_object_count: 80,
            visible_object_count: 12,
            issues: [{ code: "objects_clipped", message: "Objects are clipped." }],
            objects: sceneObjects(80),
          },
        },
      },
      "heavy_collection",
      undefined,
      "director_workbench",
    );

    expect(projected.result).toMatchObject({
      ready: false,
      issue_count: 80,
      error_count: 1,
      warning_count: 79,
      issues: expect.any(Array),
      issues_omitted: 68,
      spatial: { counts: { grounded: 10, unresolved: 70 }, placement_count: 80 },
      framing: {
        camera_id: "camera-main",
        evaluated_object_count: 80,
        visible_object_count: 12,
        issues: [{ code: "objects_clipped", message: "Objects are clipped." }],
      },
    });
    expect((projected.result as { issues: unknown[] }).issues).toHaveLength(12);
    expect((projected.result as { issues: unknown[] }).issues[0]).toMatchObject({
      code: "audit-0",
      suggested_fix: expect.any(Object),
    });
    expect(JSON.stringify(projected.result)).not.toContain("object-79");
  });

  it("keeps bounded spatial facts instead of reducing query results to ids", () => {
    const objects = Array.from({ length: 30 }, (_, index) => ({
      id: `near-${index}`,
      name: `Nearby ${index}`,
      kind: "prop",
      distance_m: index + 0.5,
      bounds: { min: [index, 0, 0], max: [index + 1, 1, 1], center: [index + 0.5, 0.5, 0.5] },
    }));
    const projected = projectDirectorAgentToolEnvelope(
      {
        success: true,
        result: {
          mode: "radius",
          match_count: 30,
          returned_count: 30,
          truncated: false,
          reference_point: [0, 0, 0],
          objects,
        },
      },
      "over_budget",
      undefined,
      "director_workbench",
    );

    expect(projected.result).toMatchObject({
      mode: "radius",
      match_count: 30,
      returned_count: 30,
      objects_omitted: 18,
      objects: expect.any(Array),
    });
    expect((projected.result as { objects: unknown[] }).objects).toHaveLength(12);
    expect((projected.result as { objects: unknown[] }).objects[0]).toMatchObject({
      id: "near-0",
      distance_m: 0.5,
      bounds: expect.any(Object),
    });
    expect(JSON.stringify(projected.result)).not.toContain("near-29");
  });

  it("keeps Bash exit facts and a command-specific recovery hint when output is projected", async () => {
    const finalized = await finalizeDirectorAgentToolEnvelope({
      envelope: {
        success: true,
        result: {
          stdout: "x".repeat(20_000),
          stderr: "warning",
          content: "x".repeat(20_000),
          exitCode: 7,
          signal: null,
          timedOut: false,
          timeoutMs: 5_000,
          truncated: false,
          sandboxDenied: false,
          sandboxBackend: "seatbelt",
          workdir: "src",
        },
      },
      tool: "bash",
      input: { command: "fixture", description: "Exercise projection" },
    });

    expect(finalized.reason).toBe("over_budget");
    expect(finalized.envelope.result).toMatchObject({
      exitCode: 7,
      timedOut: false,
      timeoutMs: 5_000,
      truncated: false,
      sandboxDenied: false,
      sandboxBackend: "seatbelt",
      workdir: "src",
      retrieval_hint: expect.stringContaining("narrower command"),
    });
    expect(String((finalized.envelope.result as { stdout: string }).stdout)).toContain("[truncated");
  });

  it("keeps Creative workspace counts and bounded ids in-band without exposing an unreadable spill", async () => {
    const nodes = Array.from({ length: 80 }, (_, index) => ({
      id: `node-${index}`,
      kind: "shot",
      title: `Shot ${index}`,
      body: "x".repeat(300),
    }));
    const saved: unknown[] = [];
    const finalized = await finalizeDirectorAgentToolEnvelope({
      envelope: {
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
        feedback: {
          changed: { object_ids: [], track_ids: [], scene_settings: false },
          scene_hint: { object_count: 2_000, camera_ids: Array.from({ length: 30 }, (_, index) => `cam-${index}`) },
          available_refs: {},
        },
      },
      tool: "director_creative",
      input: { op: "observe" },
      saveSpill: async (payload) => {
        saved.push(payload);
        return { locator: "spill_cccccccccccccccc", bytes: 50_000 };
      },
    });

    expect(finalized.spilled).toBe(true);
    expect(finalized.envelope.result).toMatchObject({
      op: "observe",
      observe_mode: "summary",
      retrieval_hint: expect.stringContaining('observe accepts only {"op":"observe"}'),
      snapshot: {
        workspace: { mode: "canvas", can_undo: true, can_redo: false },
        counts: { board_nodes: 80, tracks: 0, clips: 0 },
        board: {
          nodes: { count: 80, omitted: 56, items: expect.any(Array) },
          dag: { valid: true, root_ids: ["node-0"], leaf_ids: ["node-79"], issue_count: 0 },
        },
      },
    });
    expect(
      (finalized.envelope.result as { snapshot: { board: { nodes: { items: unknown[] } } } }).snapshot.board.nodes
        .items,
    ).toHaveLength(24);
    expect(finalized.envelope.result).not.toHaveProperty("spill");
    expect(finalized.envelope.feedback).not.toHaveProperty("scene_hint");
    expect(JSON.stringify(saved[0])).toContain("node-79");
  });

  it("keeps error codes visible when a failure payload is oversized", () => {
    const envelope = {
      success: false,
      code: "stale_project_revision",
      error: "Observe again",
      result: { code: "stale_project_revision", objects: sceneObjects(DIRECTOR_AGENT_HEAVY_COLLECTION_LIMIT + 1) },
    };
    const projected = projectDirectorAgentToolEnvelope(envelope, "heavy_collection");
    expect(projected).toMatchObject({
      success: false,
      code: "stale_project_revision",
      error: "Observe again",
      result: {
        code: "stale_project_revision",
        objects: { count: DIRECTOR_AGENT_HEAVY_COLLECTION_LIMIT + 1 },
      },
    });
    expect(projected.result).not.toHaveProperty("project_revision");
  });

  it("spills the full envelope without the target token and still returns a slim model view", async () => {
    const envelope = directorAgentModelEnvelope({
      success: true,
      result: {
        project_revision: "rev-spill",
        counts: { objects: 60 },
        objects: sceneObjects(60),
      },
      target: { token: "target-secret-token", scene_id: "scene-1" },
    });
    const saved: unknown[] = [];
    const finalized = await finalizeDirectorAgentToolEnvelope({
      envelope,
      tool: "director_workbench",
      input: { op: "observe" },
      saveSpill: async (payload) => {
        saved.push(payload);
        return { locator: "spill_bbbbbbbbbbbbbbbb", bytes: 12 };
      },
    });

    expect(finalized.spilled).toBe(true);
    expect(finalized.reason).toBe("heavy_collection");
    expect(finalized.envelope.result).toMatchObject({
      observe_mode: "summary",
      project_revision: "rev-spill",
      spill: { locator: "spill_bbbbbbbbbbbbbbbb", bytes: 12 },
    });
    expect(JSON.stringify(finalized.envelope.result)).not.toContain("prop-59");
    expect(JSON.stringify(saved[0])).toContain("prop-59");
    expect(JSON.stringify(saved[0])).not.toContain("target-secret-token");
  });

  it("still summarizes when spill write fails", async () => {
    const envelope = {
      success: true,
      result: { project_revision: "rev-1", objects: sceneObjects(60) },
    };
    const finalized = await finalizeDirectorAgentToolEnvelope({
      envelope,
      tool: "director_workbench",
      input: { op: "observe" },
      saveSpill: async () => {
        throw new Error("disk full");
      },
    });
    expect(finalized.spilled).toBe(false);
    expect(finalized.envelope.result).toMatchObject({
      observe_mode: "summary",
      project_revision: "rev-1",
    });
    expect(finalized.envelope.result).not.toHaveProperty("spill");
  });
});
