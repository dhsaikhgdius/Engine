import { beforeEach, describe, expect, it } from "vitest";
import {
  useDirectorCreativeWorkspaceStore,
  type DirectorCreativeWorkspaceState,
} from "../../src/comprehensive/editor/workspaces/directorWorkspaceStore";
import type {
  CreativeMediaAsset,
  PersistentCreativeMediaState,
} from "../../src/comprehensive/editor/media/persistentCreativeMediaStore";
import {
  creativeWorkspaceAgentRequestSchema,
  executeCreativeWorkspaceAgentRequest,
  executeCreativeWorkspaceAgentOperation,
  observeCreativeWorkspaceAgentSnapshot,
  parseCreativeWorkspaceAgentOperation,
  type CreativeWorkspaceAgentContext,
  type CreativeWorkspaceAgentExecutionResult,
} from "../../src/agent/creativeWorkspaceAgentContract";

const MEDIA_ASSETS: CreativeMediaAsset[] = [
  {
    id: "media:image:poster",
    kind: "image",
    name: "Poster",
    fileName: "poster.png",
    mimeType: "image/png",
    size: 1_024,
    createdAt: "2026-07-31T08:00:00.000Z",
    lastModified: null,
    durationSec: null,
    width: 1_920,
    height: 1_080,
    source: "test",
    objectUrl: "blob:poster-preview",
  },
  {
    id: "media:video:take",
    kind: "video",
    name: "Take",
    fileName: "take.webm",
    mimeType: "video/webm",
    size: 4_096,
    createdAt: "2026-07-31T08:01:00.000Z",
    lastModified: null,
    durationSec: 12,
    width: 1_920,
    height: 1_080,
    source: "test",
    objectUrl: "blob:take-preview",
  },
  {
    id: "media:audio:dialogue",
    kind: "audio",
    name: "Dialogue",
    fileName: "dialogue.wav",
    mimeType: "audio/wav",
    size: 2_048,
    createdAt: "2026-07-31T08:02:00.000Z",
    lastModified: null,
    durationSec: 20,
    width: null,
    height: null,
    source: "test",
    objectUrl: "blob:dialogue-preview",
  },
];

const VIDEO_PROXY_ASSET: CreativeMediaAsset = {
  id: "media:video:take-proxy",
  kind: "video",
  name: "Take Proxy",
  fileName: "take-proxy.mp4",
  mimeType: "video/mp4",
  size: 1_024,
  createdAt: "2026-07-31T08:03:00.000Z",
  lastModified: null,
  durationSec: 12,
  width: 1_280,
  height: 720,
  source: "test",
  objectUrl: "blob:take-proxy-preview",
};

/** Two scene headings (→ two shots) plus one dialogue block the importer omits. */
const FOUNTAIN_SCRIPT = [
  "Title: 剧组黎明",
  "",
  "INT. STUDIO - DAY",
  "",
  "The director frames the opening shot.",
  "",
  "ANNA",
  "We roll at dawn.",
  "",
  "EXT. RIVER - DUSK",
  "",
  "The crew moves to the river bank.",
].join("\n");

function mediaState(assets: readonly CreativeMediaAsset[] = MEDIA_ASSETS): PersistentCreativeMediaState {
  return {
    status: "ready",
    storageMode: "memory",
    warning: null,
    error: null,
    assets,
  };
}

function context(assets: readonly CreativeMediaAsset[] = MEDIA_ASSETS): CreativeWorkspaceAgentContext {
  let currentAssets = assets.map((asset) => ({ ...asset }));
  const media: CreativeWorkspaceAgentContext["media"] = {
    getState: () => mediaState(currentAssets),
    attachExistingProxy(originalId, proxyId) {
      const original = currentAssets.find((asset) => asset.id === originalId);
      const proxy = currentAssets.find((asset) => asset.id === proxyId);
      if (!original || !proxy) return null;
      const updated = { ...proxy, proxyOf: original.id };
      currentAssets = currentAssets.map((asset) => (asset.id === proxy.id ? updated : asset));
      return updated;
    },
    updatePlaybackPreference(id, preference) {
      const asset = currentAssets.find((entry) => entry.id === id);
      if (!asset) return null;
      const updated = { ...asset, playbackPreference: preference };
      currentAssets = currentAssets.map((entry) => (entry.id === id ? updated : entry));
      return updated;
    },
  };
  return {
    workspace: { getState: () => useDirectorCreativeWorkspaceStore.getState() },
    media,
  };
}

function expectSuccess(result: CreativeWorkspaceAgentExecutionResult) {
  expect(result).toMatchObject({ success: true });
  if (!result.success) throw new Error(result.error);
  return result;
}

function expectFailure(result: CreativeWorkspaceAgentExecutionResult, code: string) {
  expect(result).toMatchObject({ success: false, code });
  if (result.success) throw new Error("Expected operation to fail");
  return result;
}

function addVideoClip(runtime = context()) {
  const result = expectSuccess(
    executeCreativeWorkspaceAgentOperation(
      {
        op: "edit.clip.add",
        track_id: "video-1",
        media_id: "media:video:take",
        name: "Agent Take",
        start_sec: 1,
        duration_sec: 6,
        source_duration_sec: 12,
      },
      runtime,
    ),
  );
  return (result.result.clip as { id: string }).id;
}

function addTimelineClip(
  runtime: CreativeWorkspaceAgentContext,
  trackId: string,
  name: string,
  startSec: number,
  durationSec: number,
) {
  const result = expectSuccess(
    executeCreativeWorkspaceAgentOperation(
      {
        op: "edit.clip.add",
        track_id: trackId,
        media_id: trackId.startsWith("audio") ? "media:audio:dialogue" : "media:video:take",
        name,
        start_sec: startSec,
        duration_sec: durationSec,
        source_duration_sec: 12,
      },
      runtime,
    ),
  );
  return (result.result.clip as { id: string }).id;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
  useDirectorCreativeWorkspaceStore.getState().resetCreativeWorkspaces();
});

describe("creative workspace agent operation contract", () => {
  it("uses one strict Zod contract for valid and invalid operation structures", () => {
    expect(
      parseCreativeWorkspaceAgentOperation({
        op: "canvas.node.add",
        kind: "note",
        title: "Beat",
        x: 100,
        y: 200,
      }),
    ).toMatchObject({ success: true });
    expect(parseCreativeWorkspaceAgentOperation({ op: "canvas.node.add", title: "Missing kind" })).toMatchObject({
      success: false,
      code: "invalid_input",
    });
    expect(
      parseCreativeWorkspaceAgentOperation({
        op: "canvas.node.update",
        node_id: "node-1",
        patch: {},
      }),
    ).toMatchObject({ success: false, error: expect.stringContaining("at least one field") });
    expect(
      parseCreativeWorkspaceAgentOperation({
        op: "canvas.edge.add",
        source_node_id: "same-node",
        target_node_id: "same-node",
      }),
    ).toMatchObject({ success: false, error: expect.stringContaining("must be different") });
    expect(
      parseCreativeWorkspaceAgentOperation({
        op: "edit.clip.add",
        track_id: "video-1",
        media_id: "media:video:take",
        name: "Bad fade",
        start_sec: 0,
        duration_sec: 2,
        fade_in_sec: 1.5,
        fade_out_sec: 1,
      }),
    ).toMatchObject({ success: false, error: expect.stringContaining("cannot exceed duration_sec") });
    expect(parseCreativeWorkspaceAgentOperation({ op: "workspace.switch", workspace: "paint" })).toMatchObject({
      success: false,
    });
    expect(parseCreativeWorkspaceAgentOperation({ op: "edit.seek", seconds: 1, unexpected: true })).toMatchObject({
      success: false,
      error: expect.stringContaining('unrecognized key(s) "unexpected"'),
    });
    expect(
      parseCreativeWorkspaceAgentOperation({
        op: "media.playback.update",
        media_id: "media:video:take",
        preference: "proxy",
      }),
    ).toMatchObject({ success: true });
    expect(
      parseCreativeWorkspaceAgentOperation({
        op: "media.playback.update",
        media_id: "media:video:take",
        preference: "optimized",
      }),
    ).toMatchObject({ success: false });
    expect(
      parseCreativeWorkspaceAgentOperation({
        op: "media.proxy.attach",
        original_media_id: "same-media",
        proxy_media_id: "same-media",
      }),
    ).toMatchObject({ success: false, error: expect.stringContaining("must be different") });
    expect(
      parseCreativeWorkspaceAgentOperation({
        op: "gallery.media.update",
        media_id: "media:image:poster",
        patch: { rating: 6 },
      }),
    ).toMatchObject({ success: false });
    expect(
      parseCreativeWorkspaceAgentOperation({
        op: "gallery.media.rename_many",
        renames: [
          { media_id: "media:image:poster", custom_name: "A" },
          { media_id: "media:image:poster", custom_name: "B" },
        ],
      }),
    ).toMatchObject({ success: false, error: expect.stringContaining("must be unique") });
  });

  it("organizes, reviews, renames, trashes, and restores Gallery media through the Agent contract", () => {
    const runtime = context();
    const addedFolder = expectSuccess(
      executeCreativeWorkspaceAgentOperation({ op: "gallery.folder.add", name: "Selects" }, runtime),
    );
    const folderId = (addedFolder.result.folder as { id: string }).id;

    const reviewed = expectSuccess(
      executeCreativeWorkspaceAgentOperation(
        {
          op: "gallery.media.update",
          media_id: "media:image:poster",
          patch: {
            rating: 5,
            tags: ["hero", "approved"],
            color: "green",
            custom_name: "Hero Select",
            notes: "Use in key art",
            folder_id: folderId,
            added_at: "2026-08-07T00:00:00.000Z",
          },
        },
        runtime,
      ),
    );
    expect(reviewed.result.record).toMatchObject({
      media_id: "media:image:poster",
      rating: 5,
      tags: ["hero", "approved"],
      folder_id: folderId,
    });

    const renamed = expectSuccess(
      executeCreativeWorkspaceAgentOperation(
        {
          op: "gallery.media.rename_many",
          renames: [
            { media_id: "media:image:poster", custom_name: "shot_001_Hero" },
            { media_id: "media:video:take", custom_name: "shot_002_Take" },
          ],
        },
        runtime,
      ),
    );
    expect(renamed.result.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ media_id: "media:image:poster", custom_name: "shot_001_Hero" }),
        expect.objectContaining({ media_id: "media:video:take", custom_name: "shot_002_Take" }),
      ]),
    );

    expectSuccess(
      executeCreativeWorkspaceAgentOperation(
        {
          op: "gallery.media.move",
          media_ids: ["media:image:poster", "media:video:take"],
          folder_id: folderId,
        },
        runtime,
      ),
    );
    expectSuccess(
      executeCreativeWorkspaceAgentOperation(
        {
          op: "gallery.preferences.update",
          patch: { view_mode: "list", sort_by: "rating", active_folder_id: folderId },
        },
        runtime,
      ),
    );
    expectSuccess(
      executeCreativeWorkspaceAgentOperation(
        {
          op: "gallery.media.trash",
          media_ids: ["media:image:poster", "media:video:take"],
        },
        runtime,
      ),
    );
    expect(useDirectorCreativeWorkspaceStore.getState().galleryMedia.every((record) => record.trashedAt)).toBe(true);
    expectSuccess(
      executeCreativeWorkspaceAgentOperation(
        {
          op: "gallery.media.restore",
          media_ids: ["media:image:poster", "media:video:take"],
        },
        runtime,
      ),
    );

    const child = expectSuccess(
      executeCreativeWorkspaceAgentOperation({ op: "gallery.folder.add", name: "Hero", parent_id: folderId }, runtime),
    );
    const childId = (child.result.folder as { id: string }).id;
    expectFailure(
      executeCreativeWorkspaceAgentOperation(
        { op: "gallery.folder.move", folder_id: folderId, parent_id: childId },
        runtime,
      ),
      "conflict",
    );
    expectFailure(
      executeCreativeWorkspaceAgentOperation(
        { op: "gallery.media.update", media_id: "missing-media", patch: { rating: 1 } },
        runtime,
      ),
      "not_found",
    );

    const snapshot = observeCreativeWorkspaceAgentSnapshot(runtime);
    expect(snapshot.gallery).toMatchObject({
      media: expect.arrayContaining([
        expect.objectContaining({ media_id: "media:image:poster", rating: 5, trashed_at: null }),
        expect.objectContaining({ media_id: "media:video:take", folder_id: folderId, trashed_at: null }),
      ]),
      folders: expect.arrayContaining([
        expect.objectContaining({ id: folderId, name: "Selects", parent_id: null }),
        expect.objectContaining({ id: childId, name: "Hero", parent_id: folderId }),
      ]),
      preferences: expect.objectContaining({ view_mode: "list", sort_by: "rating", active_folder_id: folderId }),
    });
    expect(snapshot.counts).toMatchObject({ gallery_media: 2, gallery_folders: 2 });
  });

  it("adds, updates, connects, and removes canvas nodes with readable results", () => {
    const runtime = context();
    const imageAdded = expectSuccess(
      executeCreativeWorkspaceAgentOperation(
        {
          op: "canvas.node.add",
          kind: "image",
          title: "Reference",
          media_id: "media:image:poster",
          x: 320,
          y: 180,
        },
        runtime,
      ),
    );
    const noteAdded = expectSuccess(
      executeCreativeWorkspaceAgentOperation(
        { op: "canvas.node.add", kind: "note", title: "Intent", body: "Hero framing", x: 720, y: 220 },
        runtime,
      ),
    );
    const imageId = (imageAdded.result.node as { id: string }).id;
    const noteId = (noteAdded.result.node as { id: string }).id;

    const updated = expectSuccess(
      executeCreativeWorkspaceAgentOperation(
        { op: "canvas.node.update", node_id: noteId, patch: { title: "Updated intent", x: 760 } },
        runtime,
      ),
    );
    expect(updated.result.node).toMatchObject({ title: "Updated intent", x: 760 });

    const connected = expectSuccess(
      executeCreativeWorkspaceAgentOperation(
        { op: "canvas.edge.add", source_node_id: imageId, target_node_id: noteId },
        runtime,
      ),
    );
    const edgeId = (connected.result.edge as { id: string }).id;
    expect(connected.snapshot.counts.board_edges).toBe(1);
    expect(connected.snapshot.board.dag).toMatchObject({
      valid: true,
      roots: [imageId],
      leaves: [noteId],
      parallel_levels: [[imageId], [noteId]],
    });
    expectFailure(
      executeCreativeWorkspaceAgentOperation(
        { op: "canvas.edge.add", source_node_id: noteId, target_node_id: imageId },
        runtime,
      ),
      "conflict",
    );
    const laidOut = expectSuccess(
      executeCreativeWorkspaceAgentOperation(
        { op: "canvas.dag.layout", direction: "horizontal", origin_x: 50, origin_y: 60 },
        runtime,
      ),
    );
    expect(laidOut.result.dag).toMatchObject({ valid: true, topological_order: [imageId, noteId] });
    expect(laidOut.snapshot.board.nodes.find((node) => node.id === imageId)).toMatchObject({ x: 50, y: 60 });

    expectSuccess(executeCreativeWorkspaceAgentOperation({ op: "canvas.edge.remove", edge_id: edgeId }, runtime));
    const broughtFront = expectSuccess(
      executeCreativeWorkspaceAgentOperation({ op: "canvas.node.bring_to_front", node_id: imageId }, runtime),
    );
    expect(broughtFront.result).toMatchObject({ already_front: false, z_index: 1 });
    expect(useDirectorCreativeWorkspaceStore.getState().boardNodes.map((node) => node.id)).toEqual([noteId, imageId]);
    const alreadyFront = expectSuccess(
      executeCreativeWorkspaceAgentOperation({ op: "canvas.node.bring_to_front", node_id: imageId }, runtime),
    );
    expect(alreadyFront.result).toMatchObject({ already_front: true, z_index: 1 });
    expectFailure(
      executeCreativeWorkspaceAgentOperation({ op: "canvas.node.bring_to_front", node_id: "missing-node" }, runtime),
      "not_found",
    );

    const sectionAdded = expectSuccess(
      executeCreativeWorkspaceAgentOperation(
        { op: "canvas.section.add", title: "角色区", kind: "character", x: 40, y: 40 },
        runtime,
      ),
    );
    const sectionId = (sectionAdded.result.section as { id: string }).id;
    expect(sectionAdded.snapshot.counts.board_sections).toBe(1);
    expect(sectionAdded.snapshot.board.sections).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: sectionId, title: "角色区", kind: "character" })]),
    );
    const assigned = expectSuccess(
      executeCreativeWorkspaceAgentOperation(
        { op: "canvas.node.assign_section", node_id: noteId, section_id: sectionId },
        runtime,
      ),
    );
    expect(assigned.result).toMatchObject({ section_id: sectionId, unchanged: false });
    expect(assigned.snapshot.board.nodes.find((node) => node.id === noteId)).toMatchObject({
      section_id: sectionId,
    });
    expectSuccess(
      executeCreativeWorkspaceAgentOperation(
        { op: "canvas.section.update", section_id: sectionId, patch: { title: "人物区", collapsed: true } },
        runtime,
      ),
    );
    const removedSection = expectSuccess(
      executeCreativeWorkspaceAgentOperation({ op: "canvas.section.remove", section_id: sectionId }, runtime),
    );
    expect(removedSection.result).toEqual({ removed_id: sectionId });
    expect(removedSection.snapshot.board.nodes.find((node) => node.id === noteId)).toMatchObject({
      section_id: null,
    });

    const setViewport = expectSuccess(
      executeCreativeWorkspaceAgentOperation({ op: "canvas.board.set_viewport", x: 40, y: -20, zoom: 1.25 }, runtime),
    );
    expect(setViewport.result).toMatchObject({
      viewport: { x: 40, y: -20, zoom: 1.25 },
      unchanged: false,
    });
    expect(setViewport.snapshot.board.viewport).toEqual({ x: 40, y: -20, zoom: 1.25 });
    const alreadyViewport = expectSuccess(
      executeCreativeWorkspaceAgentOperation({ op: "canvas.board.set_viewport", x: 40, y: -20, zoom: 1.25 }, runtime),
    );
    expect(alreadyViewport.result).toMatchObject({ unchanged: true });
    const fitted = expectSuccess(
      executeCreativeWorkspaceAgentOperation(
        { op: "canvas.board.fit_content", surface_width: 1_000, surface_height: 700, padding: 100 },
        runtime,
      ),
    );
    expect(fitted.result).toMatchObject({
      node_count: 2,
      reset_to_identity: false,
      surface: { width: 1_000, height: 700 },
      padding: 100,
    });
    expect(fitted.snapshot.board.viewport.zoom).toBeGreaterThan(0);
    expect(fitted.snapshot.board.viewport.zoom).toBeLessThanOrEqual(1.35);

    const removed = expectSuccess(
      executeCreativeWorkspaceAgentOperation({ op: "canvas.node.remove", node_id: imageId }, runtime),
    );
    expect(removed.result).toEqual({ removed_id: imageId });
    expect(useDirectorCreativeWorkspaceStore.getState().boardNodes.some((node) => node.id === imageId)).toBe(false);
  });

  it("applies a Fountain script plan with replaced sections and typed importer omissions", () => {
    const runtime = context();
    const legacyNode = expectSuccess(
      executeCreativeWorkspaceAgentOperation(
        { op: "canvas.node.add", kind: "note", title: "旧节点", x: 0, y: 0 },
        runtime,
      ),
    );
    const legacyNodeId = (legacyNode.result.node as { id: string }).id;
    const legacySection = expectSuccess(
      executeCreativeWorkspaceAgentOperation({ op: "canvas.section.add", title: "旧分区", x: 20, y: 20 }, runtime),
    );
    const legacySectionId = (legacySection.result.section as { id: string }).id;

    const applied = expectSuccess(
      executeCreativeWorkspaceAgentOperation(
        { op: "canvas.script.apply_plan", fountain_text: FOUNTAIN_SCRIPT },
        runtime,
      ),
    );
    expect(applied.result).toMatchObject({
      storyboard_shots: 2,
      nodes_added: 2,
      replaced_section_ids: [legacySectionId],
    });
    const sections = applied.result.sections as Array<{ id: string; kind: string }>;
    expect(sections.map((section) => section.kind)).toEqual(["character", "scene", "generation", "final"]);
    expect(sections.some((section) => section.id === legacySectionId)).toBe(false);
    const addedNodes = applied.result.nodes as Array<{ id: string; title: string; section_id: string | null }>;
    expect(addedNodes).toHaveLength(2);
    expect(addedNodes.map((node) => node.title)).toEqual(["INT. STUDIO - DAY", "EXT. RIVER - DUSK"]);
    // The Fountain importer's typed omissions surface on the receipt.
    expect(applied.result.omitted).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "character_dialogue", subject: "ANNA" })]),
    );
    // Node append semantics: the pre-existing node survives the import.
    expect(applied.snapshot.counts).toMatchObject({ board_nodes: 3, board_sections: 4 });
    expect(applied.snapshot.board.nodes.some((node) => node.id === legacyNodeId)).toBe(true);

    // One atomic undo entry restores the replaced section list.
    expectSuccess(executeCreativeWorkspaceAgentOperation({ op: "workspace.undo" }, runtime));
    const restored = useDirectorCreativeWorkspaceStore.getState();
    expect(restored.boardSections.map((section) => section.id)).toEqual([legacySectionId]);
    expect(restored.boardNodes.map((node) => node.id)).toEqual([legacyNodeId]);
  });

  it("reports board-capacity truncation as typed omitted instead of silently dropping shots", () => {
    const runtime = context();
    for (let index = 0; index < 239; index += 1) {
      const added = useDirectorCreativeWorkspaceStore
        .getState()
        .addBoardNode({ kind: "note", title: `filler-${index}`, x: index, y: 0 });
      expect(added).not.toBeNull();
    }

    const truncated = expectSuccess(
      executeCreativeWorkspaceAgentOperation(
        { op: "canvas.script.apply_plan", fountain_text: FOUNTAIN_SCRIPT },
        runtime,
      ),
    );
    expect(truncated.result).toMatchObject({ storyboard_shots: 2, nodes_added: 1 });
    expect(truncated.result.omitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "board_capacity", subject: expect.stringMatching(/^node:/) }),
      ]),
    );
    expect(truncated.message).toContain("omitted");
    expect(truncated.snapshot.counts.board_nodes).toBe(240);

    // A full board rejects before any mutation: sections stay untouched.
    const sectionIdsBefore = useDirectorCreativeWorkspaceStore.getState().boardSections.map((section) => section.id);
    const rejected = expectFailure(
      executeCreativeWorkspaceAgentOperation(
        { op: "canvas.script.apply_plan", fountain_text: FOUNTAIN_SCRIPT },
        runtime,
      ),
      "capacity",
    );
    expect(rejected.error).toContain("240");
    expect(useDirectorCreativeWorkspaceStore.getState().boardSections.map((section) => section.id)).toEqual(
      sectionIdsBefore,
    );
  });

  it("rejects empty Fountain text for canvas.script.apply_plan as invalid input", () => {
    expect(parseCreativeWorkspaceAgentOperation({ op: "canvas.script.apply_plan", fountain_text: "  " })).toMatchObject(
      { success: false, code: "invalid_input" },
    );
  });

  it("adds, edits, moves, splits, seeks, and removes timeline clips", () => {
    const runtime = context();
    const clipId = addVideoClip(runtime);

    const updated = expectSuccess(
      executeCreativeWorkspaceAgentOperation(
        {
          op: "edit.clip.update",
          clip_id: clipId,
          patch: { in_sec: 1, duration_sec: 4, opacity: 0.65, scale: 1.2, fit: "cover" },
        },
        runtime,
      ),
    );
    expect(updated.result.clip).toMatchObject({ in_sec: 1, duration_sec: 4, opacity: 0.65, scale: 1.2, fit: "cover" });

    const moved = expectSuccess(
      executeCreativeWorkspaceAgentOperation(
        { op: "edit.clip.move", clip_id: clipId, track_id: "video-2", start_sec: 5 },
        runtime,
      ),
    );
    expect(moved.result).toMatchObject({ track_id: "video-2", clip: { id: clipId, start_sec: 5 } });

    const split = expectSuccess(
      executeCreativeWorkspaceAgentOperation({ op: "edit.clip.split", clip_id: clipId, at_sec: 6.5 }, runtime),
    );
    const secondId = (split.result.second as { id: string }).id;
    expect(split.result).toMatchObject({ first: { duration_sec: 1.5 }, second: { start_sec: 6.5, in_sec: 2.5 } });

    const seek = expectSuccess(executeCreativeWorkspaceAgentOperation({ op: "edit.seek", seconds: 6.5 }, runtime));
    expect(seek.snapshot.edit.playhead_sec).toBe(6.5);
    expectSuccess(executeCreativeWorkspaceAgentOperation({ op: "edit.clip.remove", clip_id: secondId }, runtime));
    expect(useDirectorCreativeWorkspaceStore.getState().selectedClipId).toBeNull();
  });

  it("ripple-removes a timeline range with deletions, boundary trims, and exact shifts", () => {
    const runtime = context();
    const before = addTimelineClip(runtime, "video-1", "Before", 0, 2);
    const inside = addTimelineClip(runtime, "video-1", "Inside", 2, 2);
    const rightOverlap = addTimelineClip(runtime, "video-1", "Right overlap", 4, 2);
    const after = addTimelineClip(runtime, "video-1", "After", 7, 2);
    const leftOverlap = addTimelineClip(runtime, "video-2", "Left overlap", 1, 3);
    const afterOther = addTimelineClip(runtime, "video-2", "After other", 6, 3);

    const removed = expectSuccess(
      executeCreativeWorkspaceAgentOperation({ op: "edit.range.remove", from_sec: 2, to_sec: 5 }, runtime),
    );
    expect(removed.result).toMatchObject({
      ripple_shift_sec: 3,
      removed_clip_ids: [inside],
      created_clip_ids: [],
      skipped_locked_track_ids: [],
    });
    expect(removed.result.trimmed_clip_ids).toEqual(expect.arrayContaining([rightOverlap, leftOverlap]));
    expect(removed.result.shifted_clip_ids).toEqual(expect.arrayContaining([rightOverlap, after, afterOther]));

    const timing = (clip: { id: string; startSec: number; durationSec: number; inSec: number }) => ({
      id: clip.id,
      startSec: clip.startSec,
      durationSec: clip.durationSec,
      inSec: clip.inSec,
    });
    const tracks = useDirectorCreativeWorkspaceStore.getState().editTracks;
    expect(tracks.find((track) => track.id === "video-1")!.clips.map(timing)).toEqual([
      { id: before, startSec: 0, durationSec: 2, inSec: 0 },
      { id: rightOverlap, startSec: 2, durationSec: 1, inSec: 1 },
      { id: after, startSec: 4, durationSec: 2, inSec: 0 },
    ]);
    expect(tracks.find((track) => track.id === "video-2")!.clips.map(timing)).toEqual([
      { id: leftOverlap, startSec: 1, durationSec: 1, inSec: 0 },
      { id: afterOther, startSec: 3, durationSec: 3, inSec: 0 },
    ]);

    useDirectorCreativeWorkspaceStore.getState().undo();
    const restored = useDirectorCreativeWorkspaceStore.getState().editTracks.find((track) => track.id === "video-1")!;
    expect(restored.clips.map((clip) => clip.startSec)).toEqual([0, 2, 4, 7]);
  });

  it("splits a clip spanning the removed range and keeps untouched ranges idempotent", () => {
    const runtime = context();
    const spanning = addTimelineClip(runtime, "video-1", "Spanning", 0, 10);

    const removed = expectSuccess(
      executeCreativeWorkspaceAgentOperation({ op: "edit.range.remove", from_sec: 4, to_sec: 6 }, runtime),
    );
    expect(removed.result).toMatchObject({ removed_clip_ids: [], trimmed_clip_ids: [spanning] });
    const createdIds = removed.result.created_clip_ids as string[];
    expect(createdIds).toHaveLength(1);
    const clips = useDirectorCreativeWorkspaceStore
      .getState()
      .editTracks.find((track) => track.id === "video-1")!.clips;
    expect(clips).toMatchObject([
      { id: spanning, startSec: 0, durationSec: 4, inSec: 0 },
      { id: createdIds[0], startSec: 4, durationSec: 4, inSec: 6 },
    ]);

    const untouched = expectSuccess(
      executeCreativeWorkspaceAgentOperation({ op: "edit.range.remove", from_sec: 30, to_sec: 31 }, runtime),
    );
    expect(untouched.result).toMatchObject({
      removed_clip_ids: [],
      trimmed_clip_ids: [],
      shifted_clip_ids: [],
      created_clip_ids: [],
    });
  });

  it("limits range removal to the requested track_ids", () => {
    const runtime = context();
    const kept = addTimelineClip(runtime, "video-1", "Kept", 0, 2);
    const trimmed = addTimelineClip(runtime, "video-2", "Trimmed", 0, 2);

    const removed = expectSuccess(
      executeCreativeWorkspaceAgentOperation(
        { op: "edit.range.remove", from_sec: 0, to_sec: 1, track_ids: ["video-2"] },
        runtime,
      ),
    );
    expect(removed.result).toMatchObject({ track_ids: ["video-2"], trimmed_clip_ids: [trimmed] });

    const tracks = useDirectorCreativeWorkspaceStore.getState().editTracks;
    expect(tracks.find((track) => track.id === "video-1")!.clips).toMatchObject([
      { id: kept, startSec: 0, durationSec: 2, inSec: 0 },
    ]);
    expect(tracks.find((track) => track.id === "video-2")!.clips).toMatchObject([
      { id: trimmed, startSec: 0, durationSec: 1, inSec: 1 },
    ]);
  });

  it("insert_gap splits straddling clips and ripple-shifts later clips by the gap duration", () => {
    const runtime = context();
    const straddler = addTimelineClip(runtime, "video-1", "Straddler", 0, 4);
    const follower = addTimelineClip(runtime, "video-1", "Follower", 5, 2);
    const atPoint = addTimelineClip(runtime, "audio-1", "At point", 2, 3);

    const inserted = expectSuccess(
      executeCreativeWorkspaceAgentOperation({ op: "edit.range.insert_gap", at_sec: 2, duration_sec: 3 }, runtime),
    );
    expect(inserted.result).toMatchObject({ split_clip_ids: [straddler] });
    const createdIds = inserted.result.created_clip_ids as string[];
    expect(createdIds).toHaveLength(1);
    expect(inserted.result.shifted_clip_ids).toEqual(expect.arrayContaining([createdIds[0], follower, atPoint]));

    const tracks = useDirectorCreativeWorkspaceStore.getState().editTracks;
    expect(tracks.find((track) => track.id === "video-1")!.clips).toMatchObject([
      { id: straddler, startSec: 0, durationSec: 2, inSec: 0 },
      { id: createdIds[0], startSec: 5, durationSec: 2, inSec: 2 },
      { id: follower, startSec: 8, durationSec: 2, inSec: 0 },
    ]);
    expect(tracks.find((track) => track.id === "audio-1")!.clips).toMatchObject([
      { id: atPoint, startSec: 5, durationSec: 3, inSec: 0 },
    ]);
  });

  it("guards range operations against unknown and locked tracks and reports skipped locked tracks", () => {
    const runtime = context();
    const lockedClip = addTimelineClip(runtime, "video-2", "Locked clip", 0, 2);
    const movingClip = addTimelineClip(runtime, "video-1", "Moving clip", 2, 2);
    useDirectorCreativeWorkspaceStore.getState().toggleTrackLock("video-2");

    expectFailure(
      executeCreativeWorkspaceAgentOperation(
        { op: "edit.range.remove", from_sec: 0, to_sec: 1, track_ids: ["video-404"] },
        runtime,
      ),
      "not_found",
    );
    expectFailure(
      executeCreativeWorkspaceAgentOperation(
        { op: "edit.range.insert_gap", at_sec: 0, duration_sec: 1, track_ids: ["video-404"] },
        runtime,
      ),
      "not_found",
    );
    expectFailure(
      executeCreativeWorkspaceAgentOperation(
        { op: "edit.range.remove", from_sec: 0, to_sec: 1, track_ids: ["video-2"] },
        runtime,
      ),
      "locked",
    );

    const removed = expectSuccess(
      executeCreativeWorkspaceAgentOperation({ op: "edit.range.remove", from_sec: 0, to_sec: 1 }, runtime),
    );
    expect(removed.result).toMatchObject({
      skipped_locked_track_ids: ["video-2"],
      shifted_clip_ids: [movingClip],
    });
    const tracks = useDirectorCreativeWorkspaceStore.getState().editTracks;
    expect(tracks.find((track) => track.id === "video-2")!.clips).toMatchObject([
      { id: lockedClip, startSec: 0, durationSec: 2 },
    ]);
    expect(tracks.find((track) => track.id === "video-1")!.clips).toMatchObject([{ id: movingClip, startSec: 1 }]);
  });

  it("rejects malformed range operations as invalid_input", () => {
    const runtime = context();
    const tooClose = expectFailure(
      executeCreativeWorkspaceAgentOperation({ op: "edit.range.remove", from_sec: 2, to_sec: 2.05 }, runtime),
      "invalid_input",
    );
    expect(tooClose.error).toContain("at least 0.1 seconds");
    const duplicateTracks = expectFailure(
      executeCreativeWorkspaceAgentOperation(
        { op: "edit.range.insert_gap", at_sec: 0, duration_sec: 1, track_ids: ["video-1", "video-1"] },
        runtime,
      ),
      "invalid_input",
    );
    expect(duplicateTracks.error).toContain("unique");
  });

  it("adds, atomically updates, and removes tracks and switches workspaces", () => {
    const runtime = context();
    const added = expectSuccess(
      executeCreativeWorkspaceAgentOperation({ op: "edit.track.add", kind: "audio", name: "Dialogue" }, runtime),
    );
    const trackId = (added.result.track as { id: string }).id;
    const updated = expectSuccess(
      executeCreativeWorkspaceAgentOperation(
        {
          op: "edit.track.update",
          track_id: trackId,
          patch: { name: "Dialogue clean", muted: true, visible: false, locked: true },
        },
        runtime,
      ),
    );
    expect(updated.result.track).toMatchObject({
      name: "Dialogue clean",
      muted: true,
      visible: false,
      locked: true,
    });

    useDirectorCreativeWorkspaceStore.getState().undo();
    expect(useDirectorCreativeWorkspaceStore.getState().editTracks.find((track) => track.id === trackId)).toMatchObject(
      {
        name: "Dialogue",
        muted: false,
        visible: true,
        locked: false,
      },
    );
    useDirectorCreativeWorkspaceStore.getState().redo();
    expect(useDirectorCreativeWorkspaceStore.getState().editTracks.find((track) => track.id === trackId)).toMatchObject(
      {
        name: "Dialogue clean",
        muted: true,
        visible: false,
        locked: true,
      },
    );

    expectSuccess(
      executeCreativeWorkspaceAgentOperation(
        { op: "edit.track.update", track_id: trackId, patch: { locked: false } },
        runtime,
      ),
    );
    expectSuccess(executeCreativeWorkspaceAgentOperation({ op: "edit.track.remove", track_id: trackId }, runtime));
    const switched = expectSuccess(
      executeCreativeWorkspaceAgentOperation({ op: "workspace.switch", workspace: "canvas" }, runtime),
    );
    expect(switched.snapshot.workspace.mode).toBe("canvas");
  });

  it("lets an agent set an exact rational SMPTE timebase and rejects invalid drop-frame rates", () => {
    const runtime = context();
    const updated = expectSuccess(
      executeCreativeWorkspaceAgentOperation(
        {
          op: "edit.settings.update",
          patch: {
            frame_rate: { numerator: 30_000, denominator: 1_001 },
            drop_frame: true,
            start_timecode: "01:00:00;00",
            export_quality: "full",
          },
        },
        runtime,
      ),
    );
    expect(updated.result.settings).toMatchObject({
      fps: 30_000 / 1_001,
      timebase: {
        rate: "30000/1001",
        drop_frame: true,
        start_timecode: "01:00:00;00",
      },
      export_quality: "full",
    });
    expect(useDirectorCreativeWorkspaceStore.getState().editSettings.timebase).toMatchObject({
      rate: { numerator: 30_000, denominator: 1_001 },
      dropFrame: true,
      startTimecode: "01:00:00;00",
    });

    expectFailure(
      executeCreativeWorkspaceAgentOperation(
        {
          op: "edit.settings.update",
          patch: { frame_rate: { numerator: 24, denominator: 1 }, drop_frame: true },
        },
        runtime,
      ),
      "conflict",
    );
  });

  it("attaches an existing proxy and returns verifiable playback snapshots for every preference", () => {
    const runtime = context([...MEDIA_ASSETS, VIDEO_PROXY_ASSET]);
    const before = observeCreativeWorkspaceAgentSnapshot(runtime);
    const attached = expectSuccess(
      executeCreativeWorkspaceAgentOperation(
        {
          op: "media.proxy.attach",
          original_media_id: "media:video:take",
          proxy_media_id: VIDEO_PROXY_ASSET.id,
        },
        runtime,
      ),
    );
    expect(attached.result).toMatchObject({
      original: { id: "media:video:take", proxy_of: null },
      proxy: { id: VIDEO_PROXY_ASSET.id, proxy_of: "media:video:take" },
      previous_proxy_of: null,
      changed: true,
    });
    expect(attached.snapshot.snapshot_fingerprint).not.toBe(before.snapshot_fingerprint);
    expect(attached.snapshot.media.assets.find((asset) => asset.id === VIDEO_PROXY_ASSET.id)).toMatchObject({
      proxy_of: "media:video:take",
      available: true,
    });

    let priorFingerprint = attached.snapshot.snapshot_fingerprint;
    for (const preference of ["proxy", "original", "auto"] as const) {
      const updated = expectSuccess(
        executeCreativeWorkspaceAgentOperation(
          { op: "media.playback.update", media_id: "media:video:take", preference },
          runtime,
        ),
      );
      expect(updated.result).toMatchObject({
        media: { id: "media:video:take", playback_preference: preference },
        changed: true,
      });
      expect(updated.snapshot.media.assets.find((asset) => asset.id === "media:video:take")).toMatchObject({
        playback_preference: preference,
      });
      expect(updated.snapshot.snapshot_fingerprint).not.toBe(priorFingerprint);
      priorFingerprint = updated.snapshot.snapshot_fingerprint;
    }
  });

  it("rejects unusable playback choices and unsafe or unverifiable proxy relationships", () => {
    expectFailure(
      executeCreativeWorkspaceAgentOperation(
        { op: "media.playback.update", media_id: "media:video:take", preference: "proxy" },
        context(),
      ),
      "conflict",
    );

    const attachedProxy = { ...VIDEO_PROXY_ASSET, proxyOf: "media:video:take" };
    expectFailure(
      executeCreativeWorkspaceAgentOperation(
        { op: "media.playback.update", media_id: attachedProxy.id, preference: "original" },
        context([...MEDIA_ASSETS, attachedProxy]),
      ),
      "conflict",
    );
    expectFailure(
      executeCreativeWorkspaceAgentOperation(
        {
          op: "media.proxy.attach",
          original_media_id: "missing-original",
          proxy_media_id: VIDEO_PROXY_ASSET.id,
        },
        context([...MEDIA_ASSETS, VIDEO_PROXY_ASSET]),
      ),
      "not_found",
    );
    expectFailure(
      executeCreativeWorkspaceAgentOperation(
        {
          op: "media.proxy.attach",
          original_media_id: "media:video:take",
          proxy_media_id: "media:audio:dialogue",
        },
        context(),
      ),
      "conflict",
    );

    const otherOriginal = {
      ...MEDIA_ASSETS[1],
      id: "media:video:other-original",
      name: "Other Original",
    };
    const claimedProxy = { ...VIDEO_PROXY_ASSET, proxyOf: otherOriginal.id };
    expectFailure(
      executeCreativeWorkspaceAgentOperation(
        {
          op: "media.proxy.attach",
          original_media_id: "media:video:take",
          proxy_media_id: claimedProxy.id,
        },
        context([...MEDIA_ASSETS, otherOriginal, claimedProxy]),
      ),
      "conflict",
    );

    const referencedRuntime = context([...MEDIA_ASSETS, VIDEO_PROXY_ASSET]);
    expectSuccess(
      executeCreativeWorkspaceAgentOperation(
        {
          op: "canvas.node.add",
          kind: "video",
          title: "Direct proxy reference",
          media_id: VIDEO_PROXY_ASSET.id,
          x: 0,
          y: 0,
        },
        referencedRuntime,
      ),
    );
    expectFailure(
      executeCreativeWorkspaceAgentOperation(
        {
          op: "media.proxy.attach",
          original_media_id: "media:video:take",
          proxy_media_id: VIDEO_PROXY_ASSET.id,
        },
        referencedRuntime,
      ),
      "conflict",
    );

    const staleRuntime = context([...MEDIA_ASSETS, VIDEO_PROXY_ASSET]);
    const unverifiableRuntime: CreativeWorkspaceAgentContext = {
      ...staleRuntime,
      media: {
        ...staleRuntime.media,
        updatePlaybackPreference: (id) => staleRuntime.media.getState().assets.find((asset) => asset.id === id) ?? null,
      },
    };
    expectFailure(
      executeCreativeWorkspaceAgentOperation(
        { op: "media.playback.update", media_id: "media:video:take", preference: "original" },
        unverifiableRuntime,
      ),
      "operation_rejected",
    );
  });

  it("rejects missing objects and every clip mutation on a locked track", () => {
    const runtime = context();
    expectFailure(
      executeCreativeWorkspaceAgentOperation(
        { op: "canvas.node.update", node_id: "missing-node", patch: { title: "No" } },
        runtime,
      ),
      "not_found",
    );
    expectFailure(
      executeCreativeWorkspaceAgentOperation(
        { op: "canvas.edge.add", source_node_id: "missing", target_node_id: "board-note-start" },
        runtime,
      ),
      "not_found",
    );

    const clipId = addVideoClip(runtime);
    useDirectorCreativeWorkspaceStore.getState().toggleTrackLock("video-1");
    const lockedOperations = [
      { op: "edit.clip.update", clip_id: clipId, patch: { opacity: 0.5 } },
      { op: "edit.clip.move", clip_id: clipId, track_id: "video-2", start_sec: 4 },
      { op: "edit.clip.split", clip_id: clipId, at_sec: 2 },
      { op: "edit.clip.remove", clip_id: clipId },
      {
        op: "edit.clip.add",
        track_id: "video-1",
        media_id: "media:video:take",
        name: "Locked add",
        start_sec: 0,
        duration_sec: 1,
      },
      { op: "edit.track.remove", track_id: "video-1" },
    ];
    lockedOperations.forEach((operation) => {
      const failure = expectFailure(executeCreativeWorkspaceAgentOperation(operation, runtime), "locked");
      expect(failure.error).toContain("locked");
    });
  });

  it("rejects unknown and track-incompatible media plus invalid source ranges", () => {
    const runtime = context();
    expectFailure(
      executeCreativeWorkspaceAgentOperation(
        {
          op: "edit.clip.add",
          track_id: "video-1",
          media_id: "missing-media",
          name: "Missing",
          start_sec: 0,
          duration_sec: 1,
        },
        runtime,
      ),
      "not_found",
    );
    expectFailure(
      executeCreativeWorkspaceAgentOperation(
        {
          op: "edit.clip.add",
          track_id: "audio-1",
          media_id: "media:video:take",
          name: "Wrong track",
          start_sec: 0,
          duration_sec: 1,
        },
        runtime,
      ),
      "conflict",
    );
    expectFailure(
      executeCreativeWorkspaceAgentOperation(
        {
          op: "canvas.node.add",
          kind: "image",
          title: "Wrong media",
          media_id: "media:audio:dialogue",
          x: 0,
          y: 0,
        },
        runtime,
      ),
      "conflict",
    );

    const clipId = addVideoClip(runtime);
    expectFailure(
      executeCreativeWorkspaceAgentOperation(
        {
          op: "edit.clip.update",
          clip_id: clipId,
          patch: { in_sec: 10, duration_sec: 4, source_duration_sec: 12 },
        },
        runtime,
      ),
      "conflict",
    );
  });

  it("protects the final video track from deletion", () => {
    const runtime = context();
    expectSuccess(executeCreativeWorkspaceAgentOperation({ op: "edit.track.remove", track_id: "video-2" }, runtime));
    const failure = expectFailure(
      executeCreativeWorkspaceAgentOperation({ op: "edit.track.remove", track_id: "video-1" }, runtime),
      "conflict",
    );
    expect(failure.error).toContain("final video track");
  });

  it("observes board, tracks, settings, selections, and durable media metadata without object URLs", () => {
    const runtime = context();
    const node = expectSuccess(
      executeCreativeWorkspaceAgentOperation(
        {
          op: "canvas.node.add",
          kind: "image",
          title: "Poster",
          media_id: "media:image:poster",
          x: 12,
          y: 24,
        },
        runtime,
      ),
    );
    const clipId = addVideoClip(runtime);
    const snapshot = observeCreativeWorkspaceAgentSnapshot(runtime);

    expect(snapshot).toMatchObject({
      version: 1,
      board: {
        nodes: expect.arrayContaining([
          expect.objectContaining({ id: (node.result.node as { id: string }).id, media_id: "media:image:poster" }),
        ]),
      },
      edit: {
        tracks: expect.arrayContaining([
          expect.objectContaining({
            id: "video-1",
            clips: expect.arrayContaining([expect.objectContaining({ id: clipId })]),
          }),
        ]),
        settings: {
          aspect_ratio: "16 / 9",
          fps: 24,
          timebase: {
            rate: "24/1",
            numerator: 24,
            denominator: 1,
            drop_frame: false,
            start_timecode: "00:00:00:00",
          },
          snap_enabled: true,
          export_quality: "preview",
        },
      },
      selection: { board_node_id: (node.result.node as { id: string }).id, clip_id: clipId },
      media: {
        status: "ready",
        assets: expect.arrayContaining([
          expect.objectContaining({
            id: "media:video:take",
            file_name: "take.webm",
            duration_sec: 12,
            available: true,
            waveform_ready: false,
            proxy_of: null,
            playback_preference: "auto",
            proxy_profile: null,
          }),
        ]),
      },
      counts: { media_assets: 3, clips: 1 },
    });
    expect(snapshot.media.assets[0]).not.toHaveProperty("objectUrl");
    expect(snapshot.media.assets[0]).not.toHaveProperty("object_url");
  });

  it("accepts a current snapshot and rejects an actual stale edit", () => {
    const runtime = context();
    const observed = executeCreativeWorkspaceAgentRequest({ op: "observe" }, runtime);
    expect(observed.op).toBe("observe");
    if (observed.op !== "observe") throw new Error("Expected observe result");
    expect(observed.snapshot.snapshot_fingerprint).toEqual(expect.any(String));

    const accepted = executeCreativeWorkspaceAgentRequest(
      {
        op: "execute",
        idempotency_key: "creative-seek-accepted-v1",
        expected_snapshot_fingerprint: observed.snapshot.snapshot_fingerprint,
        operation: { op: "edit.seek", seconds: 3 },
      },
      runtime,
    );
    expect(accepted).toMatchObject({
      op: "execute",
      execution: { success: true, operation: "edit.seek" },
    });

    expectSuccess(executeCreativeWorkspaceAgentOperation({ op: "edit.seek", seconds: 4 }, runtime));
    const stale = executeCreativeWorkspaceAgentRequest(
      {
        op: "execute",
        idempotency_key: "creative-seek-stale-v1",
        expected_snapshot_fingerprint: observed.snapshot.snapshot_fingerprint,
        operation: { op: "edit.seek", seconds: 5 },
      },
      runtime,
    );
    expect(stale).toMatchObject({
      op: "execute",
      execution: { success: false, code: "conflict", operation: "edit.seek" },
    });
  });

  it("replays an exact creative mutation without applying it twice", () => {
    const runtime = context();
    const before = observeCreativeWorkspaceAgentSnapshot(runtime);
    const request = {
      op: "execute" as const,
      idempotency_key: "creative-replay-safe-v1",
      expected_snapshot_fingerprint: before.snapshot_fingerprint,
      operation: { op: "canvas.node.add" as const, kind: "note" as const, title: "Once", x: 10, y: 20 },
    };

    const first = executeCreativeWorkspaceAgentRequest(request, runtime);
    const second = executeCreativeWorkspaceAgentRequest(request, runtime);
    const conflicting = executeCreativeWorkspaceAgentRequest(
      { ...request, operation: { ...request.operation, title: "Different" } },
      runtime,
    );

    expect(first).toMatchObject({ execution: { success: true, result: { idempotency: { replayed: false } } } });
    expect(second).toMatchObject({ execution: { success: true, result: { idempotency: { replayed: true } } } });
    expect(conflicting).toMatchObject({
      execution: { success: false, result: { code: "idempotency_key_conflict" } },
    });
    expect(
      useDirectorCreativeWorkspaceStore.getState().boardNodes.filter((node) => node.title === "Once"),
    ).toHaveLength(1);
  });

  it("replays a stale-but-successful creative mutation with an explicit stale marker", () => {
    const runtime = context();
    const before = observeCreativeWorkspaceAgentSnapshot(runtime);
    const request = {
      op: "execute" as const,
      idempotency_key: "creative-replay-stale-v1",
      expected_snapshot_fingerprint: before.snapshot_fingerprint,
      operation: { op: "canvas.node.add" as const, kind: "note" as const, title: "Once Stale", x: 12, y: 24 },
    };

    const first = executeCreativeWorkspaceAgentRequest(request, runtime);
    expect(first).toMatchObject({ execution: { success: true } });
    if (first.op !== "execute" || !first.execution.success) throw new Error("Expected successful execute result");
    const originalFingerprint = first.execution.snapshot.snapshot_fingerprint;

    expectSuccess(executeCreativeWorkspaceAgentOperation({ op: "edit.seek", seconds: 6 }, runtime));
    const current = observeCreativeWorkspaceAgentSnapshot(runtime);
    expect(current.snapshot_fingerprint).not.toBe(originalFingerprint);

    const replayed = executeCreativeWorkspaceAgentRequest(request, runtime);
    expect(replayed).toMatchObject({
      op: "execute",
      execution: {
        success: true,
        message: expect.stringContaining("already succeeded"),
        result: {
          idempotency: {
            key: "creative-replay-stale-v1",
            replayed: true,
            stale: true,
            original_snapshot_fingerprint: originalFingerprint,
            current_snapshot_fingerprint: current.snapshot_fingerprint,
          },
        },
      },
    });
    expect(
      useDirectorCreativeWorkspaceStore.getState().boardNodes.filter((node) => node.title === "Once Stale"),
    ).toHaveLength(1);
  });

  it("invalidates the concurrency fingerprint when selection, playhead, or media readiness changes", () => {
    let mediaStatus: PersistentCreativeMediaState["status"] = "ready";
    const runtime = context();
    const getMediaState = runtime.media.getState;
    runtime.media.getState = () => ({ ...getMediaState(), status: mediaStatus });

    const baseline = observeCreativeWorkspaceAgentSnapshot(runtime).snapshot_fingerprint;
    useDirectorCreativeWorkspaceStore.getState().selectBoardNode("selection-from-another-agent");
    const afterSelection = observeCreativeWorkspaceAgentSnapshot(runtime).snapshot_fingerprint;
    expect(afterSelection).not.toBe(baseline);

    useDirectorCreativeWorkspaceStore.getState().setPlayhead(7.25);
    const afterPlayhead = observeCreativeWorkspaceAgentSnapshot(runtime).snapshot_fingerprint;
    expect(afterPlayhead).not.toBe(afterSelection);

    mediaStatus = "error";
    const afterMediaStatus = observeCreativeWorkspaceAgentSnapshot(runtime).snapshot_fingerprint;
    expect(afterMediaStatus).not.toBe(afterPlayhead);
  });

  it("advertises practical operations and supports an explicit diagnostic audit", () => {
    const runtime = context();
    const before = observeCreativeWorkspaceAgentSnapshot(runtime);
    const capabilities = executeCreativeWorkspaceAgentRequest({ op: "capabilities" }, runtime);
    expect(capabilities).toMatchObject({
      op: "capabilities",
      capabilities: {
        version: 2,
        request_ops: expect.arrayContaining([
          "observe",
          "execute_batch",
          "audit",
          "interchange",
          "collaboration",
          "pipeline",
        ]),
        operation_ids: expect.arrayContaining([
          "media.playback.update",
          "media.proxy.attach",
          "gallery.media.update",
          "gallery.folder.add",
          "gallery.preferences.update",
          "canvas.production.configure",
          "canvas.node.bring_to_front",
          "canvas.section.add",
          "canvas.node.assign_section",
          "canvas.board.set_viewport",
          "canvas.board.fit_content",
        ]),
        batch: {
          atomic: true,
          reference_syntax: "@alias",
          excluded_operations: expect.arrayContaining(["media.playback.update", "media.proxy.attach"]),
        },
        canvas_dag: {
          analysis: ["topological_order", "parallel_levels", "roots", "leaves", "cycle_path", "issues"],
          layout_operation: "canvas.dag.layout",
          layout_directions: ["horizontal", "vertical"],
          bring_to_front_operation: "canvas.node.bring_to_front",
          section_operations: [
            "canvas.section.add",
            "canvas.section.update",
            "canvas.section.remove",
            "canvas.node.assign_section",
          ],
          viewport_operations: ["canvas.board.set_viewport", "canvas.board.fit_content"],
          viewport_observe_path: "board.viewport",
          viewport_zoom_range: [0.1, 2.5],
        },
        limits: expect.objectContaining({ board_sections: 32 }),
        editorial: {
          timebase: {
            source_of_truth: "edit.settings.timebase",
            observe_path: "edit.settings.timebase",
            update_operation: "edit.settings.update",
            drop_frame_rates: ["30000/1001", "60000/1001"],
            example: {
              op: "edit.settings.update",
              patch: {
                frame_rate: { numerator: 30_000, denominator: 1_001 },
                drop_frame: true,
                start_timecode: "01:00:00;00",
              },
            },
          },
          gallery: {
            observe_path: "gallery",
            permanent_delete: "gallery.media.purge",
            media_operations: expect.arrayContaining(["gallery.media.update", "gallery.media.rename_many"]),
          },
          media: {
            observe_path: "media.assets",
            observable_fields: expect.arrayContaining([
              "available",
              "waveform_ready",
              "proxy_of",
              "playback_preference",
              "proxy_profile",
            ]),
            attach_proxy_operation: "media.proxy.attach",
            set_playback_operation: "media.playback.update",
            offline_relink: {
              supported: true,
              director_creative_operation: "media.relink",
            },
          },
        },
        interchange: {
          formats: expect.arrayContaining([
            expect.objectContaining({ id: "otio", payload: "text" }),
            expect.objectContaining({ id: "otioz", payload: "binary" }),
            expect.objectContaining({ id: "fountain", payload: "text" }),
            expect.objectContaining({ id: "gltf", payload: "text" }),
            expect.objectContaining({ id: "glb", payload: "binary" }),
            expect.objectContaining({ id: "usd", extensions: [".usd", ".usda"] }),
            expect.objectContaining({ id: "usdz", payload: "binary" }),
            expect.objectContaining({ id: "obj", extensions: [".zip"], payload: "binary" }),
            expect.objectContaining({ id: "stl", extensions: [".zip"], payload: "binary" }),
          ]),
          directions: ["import", "export"],
          execution_surface: "director_creative interchange plus DirectorInterchangeMenu",
          director_creative_operation: "interchange",
          agent_actions: ["capabilities", "plan-export", "export", "plan-import", "import"],
          agent_directions: ["export", "import"],
          import_mode: "agent-transfer",
          agent_transfer: expect.stringContaining("enabled"),
        },
        collaboration: {
          engine: "Yjs",
          capabilities: expect.arrayContaining([
            "presence and cursors",
            "anchored review comments",
            "version comparison",
            "version restore",
          ]),
          director_creative_operations: [
            "observe",
            "list-comments",
            "add-comment",
            "resolve-comment",
            "reopen-comment",
            "update-comment",
            "delete-comment",
            "list-versions",
            "compare",
            "create-version",
            "restore-version",
            "delete-version",
          ],
          concurrency_guard: "collaboration_fingerprint",
          agent_transfer: expect.stringContaining("enabled"),
        },
        pipeline: {
          observe_path: "board.pipeline_runs",
          request_op: "pipeline",
          configure_operation: "canvas.production.configure",
          actions: ["capabilities", "start", "status", "cancel"],
          execution: "topological-levels-with-bounded-parallelism",
          failure_semantics: expect.stringContaining("independent branches continue"),
        },
      },
    });
    expect(
      creativeWorkspaceAgentRequestSchema.safeParse({
        op: "execute_batch",
        idempotency_key: "creative-media-batch-v1",
        expected_snapshot_fingerprint: before.snapshot_fingerprint,
        steps: [
          {
            step_id: "media-choice",
            operation: {
              op: "media.playback.update",
              media_id: "media:video:take",
              preference: "original",
            },
          },
        ],
      }).success,
    ).toBe(false);

    const audited = executeCreativeWorkspaceAgentRequest(
      { op: "audit", scope: "all", quality_profile: "production" },
      runtime,
    );
    expect(audited).toMatchObject({
      op: "audit",
      audit: {
        snapshot_fingerprint: before.snapshot_fingerprint,
        summary: { warnings: expect.any(Number) },
      },
    });
    const restored = observeCreativeWorkspaceAgentSnapshot(runtime);
    expect(restored.counts).toMatchObject({
      board_nodes: before.counts.board_nodes,
      board_edges: before.counts.board_edges,
    });
  });

  it("describes the exact interchange request before dispatch", () => {
    const described = executeCreativeWorkspaceAgentRequest({ op: "describe", target: "interchange" }, context());
    expect(described).toMatchObject({
      op: "describe",
      description: {
        target: "interchange",
        kind: "operation",
      },
    });
    expect(JSON.stringify(described)).toContain("plan-import");
    expect(JSON.stringify(described)).toContain("source");
  });

  it("executes an alias-addressed Canvas batch atomically as one undo step", () => {
    const runtime = context();
    const before = observeCreativeWorkspaceAgentSnapshot(runtime);
    const execution = executeCreativeWorkspaceAgentRequest(
      {
        op: "execute_batch",
        idempotency_key: "creative-canvas-batch-v1",
        expected_snapshot_fingerprint: before.snapshot_fingerprint,
        steps: [
          {
            step_id: "intent",
            save_as: "intent",
            operation: { op: "canvas.node.add", kind: "note", title: "Intent", x: 40, y: 40 },
          },
          {
            step_id: "shot",
            save_as: "shot",
            operation: { op: "canvas.node.add", kind: "shot", title: "Shot 01", x: 420, y: 40 },
          },
          {
            step_id: "connect",
            operation: { op: "canvas.edge.add", source_node_id: "@intent", target_node_id: "@shot" },
          },
        ],
      },
      runtime,
    );
    expect(execution).toMatchObject({
      op: "execute_batch",
      execution: {
        success: true,
        operation: "batch",
        result: { references: { intent: expect.any(String), shot: expect.any(String) } },
        snapshot: {
          workspace: { can_undo: true, can_redo: false },
          counts: { board_nodes: before.counts.board_nodes + 2, board_edges: before.counts.board_edges + 1 },
        },
      },
    });

    const undone = executeCreativeWorkspaceAgentOperation({ op: "workspace.undo" }, runtime);
    expect(undone).toMatchObject({ success: true, operation: "workspace.undo" });
    const restored = observeCreativeWorkspaceAgentSnapshot(runtime);
    expect(restored.counts).toMatchObject({
      board_nodes: before.counts.board_nodes,
      board_edges: before.counts.board_edges,
    });
    expect(restored.snapshot_fingerprint).not.toBe(before.snapshot_fingerprint);
    expect(executeCreativeWorkspaceAgentOperation({ op: "workspace.redo" }, runtime)).toMatchObject({ success: true });
  });

  it("rolls back every completed batch step when a later semantic check fails", () => {
    const runtime = context();
    const before = observeCreativeWorkspaceAgentSnapshot(runtime);
    const execution = executeCreativeWorkspaceAgentRequest(
      {
        op: "execute_batch",
        idempotency_key: "creative-rollback-batch-v1",
        expected_snapshot_fingerprint: before.snapshot_fingerprint,
        steps: [
          {
            step_id: "temporary",
            save_as: "temporary",
            operation: { op: "canvas.node.add", kind: "note", title: "Temporary", x: 40, y: 40 },
          },
          {
            step_id: "bad-edge",
            operation: {
              op: "canvas.edge.add",
              source_node_id: "@temporary",
              target_node_id: "missing-node",
            },
          },
        ],
      },
      runtime,
    );
    expect(execution).toMatchObject({
      op: "execute_batch",
      execution: {
        success: false,
        operation: "batch",
        code: "not_found",
        result: { failed_step_id: "bad-edge", rolled_back: true },
      },
    });
    const restored = observeCreativeWorkspaceAgentSnapshot(runtime);
    expect(restored.counts).toMatchObject({
      board_nodes: before.counts.board_nodes,
      board_edges: before.counts.board_edges,
    });
  });

  it("rolls back the complete batch when a workspace mutation throws", () => {
    const baseRuntime = context();
    const runtime: CreativeWorkspaceAgentContext = {
      ...baseRuntime,
      workspace: {
        getState: () => {
          const state = useDirectorCreativeWorkspaceStore.getState();
          return {
            ...state,
            addBoardNode: (input: Parameters<DirectorCreativeWorkspaceState["addBoardNode"]>[0]) => {
              state.addBoardNode(input);
              throw new Error("synthetic batch failure");
            },
          };
        },
      },
    };
    const before = observeCreativeWorkspaceAgentSnapshot(baseRuntime);
    const execution = executeCreativeWorkspaceAgentRequest(
      {
        op: "execute_batch",
        idempotency_key: "creative-throwing-batch-v1",
        expected_snapshot_fingerprint: before.snapshot_fingerprint,
        steps: [
          {
            step_id: "throws",
            operation: { op: "canvas.node.add", kind: "note", title: "Must roll back", x: 40, y: 40 },
          },
        ],
      },
      runtime,
    );

    expect(execution).toMatchObject({
      op: "execute_batch",
      execution: {
        success: false,
        operation: "batch",
        code: "operation_rejected",
        result: { failed_step_id: "throws", rolled_back: true },
      },
    });
    expect(observeCreativeWorkspaceAgentSnapshot(baseRuntime).snapshot_fingerprint).toBe(before.snapshot_fingerprint);
    expect(useDirectorCreativeWorkspaceStore.getState().canUndo).toBe(false);
  });
});
