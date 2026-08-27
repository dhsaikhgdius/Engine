/**
 * Parity harness for the creative workspace UI dispatch layer.
 *
 * The same operation scripts run once through dispatchCreativeWorkspaceOperations
 * (the UI executor) and once through the public Agent envelope
 * (executeCreativeWorkspaceAgentRequest with an explicit snapshot guard).
 * Their final revisions must be identical after normalizing generated ids;
 * a mismatch fails with a structural diff of the two snapshots. The harness
 * also proves the migrated UI behaviors (ripple delete, cross dissolve)
 * still match the legacy direct-store mutators they replaced.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDirectorCreativeWorkspaceStore } from "../../src/comprehensive/editor/workspaces/directorWorkspaceStore";
import type {
  CreativeMediaAsset,
  PersistentCreativeMediaState,
} from "../../src/comprehensive/editor/media/persistentCreativeMediaStore";
import {
  creativeWorkspaceAgentRequestSchema,
  executeCreativeWorkspaceAgentOperation,
  executeCreativeWorkspaceAgentRequest,
  observeCreativeWorkspaceAgentSnapshot,
  type CreativeWorkspaceAgentContext,
  type CreativeWorkspaceAgentSnapshot,
} from "../../src/agent/creativeWorkspaceAgentContract";
import {
  dispatchCreativeWorkspaceMediaRelink,
  dispatchCreativeWorkspaceOperations,
  type CreativeWorkspaceOperationInput,
} from "../../src/agent/dispatchCreativeWorkspaceOperations";

vi.mock("../../src/comprehensive/editor/workspaces/directorMediaLibrary", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/comprehensive/editor/workspaces/directorMediaLibrary")>();
  return {
    ...actual,
    relinkDirectorCreativeMedia: vi.fn(async (oldMediaId: string) => ({
      ok: true,
      operation: "media.relink" as const,
      oldMediaId,
      newMediaId: "media:image:relinked",
      referencesUpdated: 1,
      waveformReady: false,
    })),
  };
});

import { relinkDirectorCreativeMedia } from "../../src/comprehensive/editor/workspaces/directorMediaLibrary";

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
];

function mediaState(): PersistentCreativeMediaState {
  return {
    status: "ready",
    storageMode: "memory",
    warning: null,
    error: null,
    assets: MEDIA_ASSETS,
  };
}

function context(): CreativeWorkspaceAgentContext {
  return {
    workspace: { getState: () => useDirectorCreativeWorkspaceStore.getState() },
    media: { getState: () => mediaState() },
  };
}

/** Executes one operation and returns its result payload; throws on rejection. */
type ParityExecutor = (operation: CreativeWorkspaceOperationInput) => Record<string, unknown>;

function uiExecutor(runtime: CreativeWorkspaceAgentContext): ParityExecutor {
  return (operation) => {
    const receipt = dispatchCreativeWorkspaceOperations(operation, { context: runtime });
    if (!receipt.ok) throw new Error(`UI dispatch rejected ${JSON.stringify(operation)}: ${receipt.error}`);
    return receipt.execution.result;
  };
}

let agentRequestCounter = 0;

/** Mirrors a live agent loop: observe, then execute with the fingerprint guard. */
function agentExecutor(runtime: CreativeWorkspaceAgentContext): ParityExecutor {
  return (operation) => {
    const observed = observeCreativeWorkspaceAgentSnapshot(runtime);
    const result = executeCreativeWorkspaceAgentRequest(
      creativeWorkspaceAgentRequestSchema.parse({
        op: "execute",
        operation,
        idempotency_key: `agent-parity:${(agentRequestCounter += 1)}`,
        expected_snapshot_fingerprint: observed.snapshot_fingerprint,
      }),
      runtime,
    );
    if (result.op !== "execute") throw new Error(`Unexpected tool result "${result.op}"`);
    if (!result.execution.success) {
      throw new Error(`Agent envelope rejected ${JSON.stringify(operation)}: ${result.execution.error}`);
    }
    return result.execution.result;
  };
}

/**
 * Generated entity ids are random per run, so both executors would trivially
 * diverge. Rewrite every generated id to a stable alias in first-appearance
 * order (creation order) and drop the fingerprint, which hashes the raw ids.
 */
function normalizedRevision(snapshot: CreativeWorkspaceAgentSnapshot): Record<string, unknown> {
  const { snapshot_fingerprint: _fingerprint, ...rest } = snapshot;
  const aliases = new Map<string, string>();
  const normalized = JSON.stringify(rest).replace(
    /(board-node|board-edge|board-section|edit-clip|gallery-folder)-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g,
    (match, prefix: string) => {
      let alias = aliases.get(match);
      if (!alias) {
        alias = `${prefix}#${aliases.size + 1}`;
        aliases.set(match, alias);
      }
      return alias;
    },
  );
  return JSON.parse(normalized) as Record<string, unknown>;
}

function resetWorkspace() {
  useDirectorCreativeWorkspaceStore.getState().resetCreativeWorkspaces();
}

/** Runs the same script against a fresh workspace per executor and returns both revisions. */
function compareExecutors(script: (execute: ParityExecutor) => void) {
  resetWorkspace();
  const uiRuntime = context();
  script(uiExecutor(uiRuntime));
  const uiRevision = normalizedRevision(observeCreativeWorkspaceAgentSnapshot(uiRuntime));

  resetWorkspace();
  const agentRuntime = context();
  script(agentExecutor(agentRuntime));
  const agentRevision = normalizedRevision(observeCreativeWorkspaceAgentSnapshot(agentRuntime));

  return { uiRevision, agentRevision };
}

function createdId(result: Record<string, unknown>, key: string): string {
  return (result[key] as { id: string }).id;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
  resetWorkspace();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("creative workspace UI/agent parity harness", () => {
  it("produces identical revisions for the Canvas batch (node/section/edge/layout/viewport/bring-to-front)", () => {
    const { uiRevision, agentRevision } = compareExecutors((execute) => {
      const note = execute({ op: "canvas.node.add", kind: "note", title: "灵感", body: "旁白基调", x: 80, y: 64 });
      const poster = execute({
        op: "canvas.node.add",
        kind: "image",
        title: "Poster",
        media_id: "media:image:poster",
        x: 480,
        y: 64,
        accent: "#8f83d9",
      });
      const edge = execute({
        op: "canvas.edge.add",
        source_node_id: createdId(note, "node"),
        target_node_id: createdId(poster, "node"),
      });
      execute({ op: "canvas.dag.layout", direction: "horizontal" });
      const section = execute({ op: "canvas.section.add", title: "生成区", kind: "generation", x: 20, y: 20 });
      execute({
        op: "canvas.node.assign_section",
        node_id: createdId(note, "node"),
        section_id: createdId(section, "section"),
      });
      execute({
        op: "canvas.section.update",
        section_id: createdId(section, "section"),
        patch: { title: "成片区", collapsed: true },
      });
      execute({
        op: "canvas.section.update",
        section_id: createdId(section, "section"),
        patch: { collapsed: false },
      });
      const doomed = execute({ op: "canvas.node.add", kind: "frame", title: "镜头组", x: 40, y: 400 });
      execute({ op: "canvas.node.bring_to_front", node_id: createdId(note, "node") });
      execute({ op: "canvas.node.send_to_back", node_id: createdId(poster, "node") });
      execute({ op: "canvas.board.set_viewport", x: 12, y: 24, zoom: 1.1 });
      execute({ op: "canvas.board.fit_content", surface_width: 900, surface_height: 600 });
      execute({ op: "canvas.node.remove", node_id: createdId(doomed, "node") });
      execute({ op: "canvas.section.remove", section_id: createdId(section, "section") });
      execute({ op: "canvas.edge.remove", edge_id: createdId(edge, "edge") });
      execute({
        op: "canvas.edge.add",
        source_node_id: createdId(note, "node"),
        target_node_id: createdId(poster, "node"),
      });
    });
    expect(uiRevision).toEqual(agentRevision);
  });

  it("produces identical revisions for Canvas z-order raise and lower", () => {
    const { uiRevision, agentRevision } = compareExecutors((execute) => {
      const back = execute({ op: "canvas.node.add", kind: "note", title: "底层", x: 40, y: 40 });
      const mid = execute({ op: "canvas.node.add", kind: "note", title: "中层", x: 80, y: 80 });
      const front = execute({ op: "canvas.node.add", kind: "note", title: "顶层", x: 120, y: 120 });
      execute({ op: "canvas.node.bring_to_front", node_id: createdId(back, "node") });
      execute({ op: "canvas.node.send_to_back", node_id: createdId(front, "node") });
      execute({ op: "canvas.node.send_to_back", node_id: createdId(mid, "node") });
      execute({ op: "canvas.node.bring_to_front", node_id: createdId(mid, "node") });
    });
    expect(uiRevision).toEqual(agentRevision);
    expect(uiRevision.board.nodes.map((node) => ({ title: node.title, z_index: node.z_index }))).toEqual([
      { title: "顶层", z_index: 0 },
      { title: "底层", z_index: 1 },
      { title: "中层", z_index: 2 },
    ]);
  });

  it("produces identical revisions for Canvas section update (collapse and orphan on remove)", () => {
    const { uiRevision, agentRevision } = compareExecutors((execute) => {
      const note = execute({ op: "canvas.node.add", kind: "note", title: "草稿", x: 120, y: 120 });
      const section = execute({ op: "canvas.section.add", title: "角色区", kind: "character", x: 40, y: 40 });
      const sectionId = createdId(section, "section");
      execute({ op: "canvas.node.assign_section", node_id: createdId(note, "node"), section_id: sectionId });
      execute({ op: "canvas.section.update", section_id: sectionId, patch: { title: "人物区", collapsed: true } });
      execute({ op: "canvas.section.update", section_id: sectionId, patch: { collapsed: false } });
      execute({ op: "canvas.section.remove", section_id: sectionId });
    });
    expect(uiRevision).toEqual(agentRevision);
    expect(uiRevision.board).toMatchObject({
      sections: [],
      nodes: [expect.objectContaining({ section_id: null })],
    });
  });

  it("produces identical revisions for the Gallery batch (folders, cataloging, review metadata, move)", () => {
    // Folder creation and move-cataloging stamp wall-clock timestamps; freeze
    // time so the two executor runs cannot diverge by milliseconds.
    vi.useFakeTimers({ now: new Date("2026-08-02T10:00:00.000Z") });
    const { uiRevision, agentRevision } = compareExecutors((execute) => {
      const folder = execute({ op: "gallery.folder.add", name: "精选" });
      execute({
        op: "gallery.media.update",
        media_id: "media:image:poster",
        patch: { added_at: "2026-08-02T10:00:00.000Z", notes: "来自 Stage 相机截图" },
      });
      execute({
        op: "gallery.media.update",
        media_id: "media:image:poster",
        patch: { rating: 4, tags: ["精选", "夜景"] },
      });
      execute({
        op: "gallery.media.move",
        media_ids: ["media:image:poster"],
        folder_id: (folder.folder as { id: string }).id,
      });
    });
    expect(uiRevision).toEqual(agentRevision);
  });

  it("produces identical revisions for the Fountain script import (canvas.script.apply_plan)", () => {
    const fountain = [
      "INT. STUDIO - DAY",
      "",
      "The director frames the opening shot.",
      "",
      "EXT. RIVER - DUSK",
      "",
      "The crew moves to the river bank.",
    ].join("\n");
    const { uiRevision, agentRevision } = compareExecutors((execute) => {
      const note = execute({ op: "canvas.node.add", kind: "note", title: "旧节点", x: 0, y: 0 });
      const applied = execute({ op: "canvas.script.apply_plan", fountain_text: fountain });
      expect(applied).toMatchObject({ storyboard_shots: 2, nodes_added: 2, omitted: [] });
      // Chain the nodes so the dag projection is structurally ordered; an
      // edgeless dag would sort by random node UUIDs and defeat the diff.
      const shots = applied.nodes as Array<{ id: string }>;
      execute({ op: "canvas.edge.add", source_node_id: createdId(note, "node"), target_node_id: shots[0]!.id });
      execute({ op: "canvas.edge.add", source_node_id: shots[0]!.id, target_node_id: shots[1]!.id });
    });
    expect(uiRevision).toEqual(agentRevision);
  });

  it("produces identical revisions for undo/redo and workspace switches", () => {
    const { uiRevision, agentRevision } = compareExecutors((execute) => {
      execute({ op: "canvas.node.add", kind: "note", title: "第一稿", x: 0, y: 0 });
      execute({ op: "canvas.node.add", kind: "note", title: "第二稿", x: 320, y: 0 });
      execute({ op: "workspace.undo" });
      execute({ op: "workspace.redo" });
      execute({ op: "workspace.undo" });
      execute({ op: "workspace.switch", workspace: "video" });
    });
    expect(uiRevision).toEqual(agentRevision);
  });

  it("matches the agent execute_batch envelope for the capture-import batch shape", () => {
    // Same catalog + node-add pairs the Stage capture import dispatches.
    const steps: CreativeWorkspaceOperationInput[] = [
      {
        op: "gallery.media.update",
        media_id: "media:image:poster",
        patch: { added_at: "2026-08-02T10:00:00.000Z", notes: "来自 Stage 相机截图" },
      },
      {
        op: "canvas.node.add",
        kind: "image",
        title: "主全景",
        body: "Stage camera capture",
        media_id: "media:image:poster",
        x: 80,
        y: 80,
        accent: "#45b3d6",
      },
    ];

    resetWorkspace();
    const uiRuntime = context();
    const uiBatch = dispatchCreativeWorkspaceOperations(steps, { context: uiRuntime });
    if (!uiBatch.ok) throw new Error(uiBatch.error);
    const uiRevision = normalizedRevision(observeCreativeWorkspaceAgentSnapshot(uiRuntime));

    resetWorkspace();
    const agentRuntime = context();
    const observed = observeCreativeWorkspaceAgentSnapshot(agentRuntime);
    const agentBatch = executeCreativeWorkspaceAgentRequest(
      creativeWorkspaceAgentRequestSchema.parse({
        op: "execute_batch",
        idempotency_key: `agent-parity:${(agentRequestCounter += 1)}`,
        expected_snapshot_fingerprint: observed.snapshot_fingerprint,
        steps: steps.map((operation, index) => ({ step_id: `agent-step-${index + 1}`, operation })),
      }),
      agentRuntime,
    );
    if (agentBatch.op !== "execute_batch" || !agentBatch.execution.success) {
      throw new Error("agent execute_batch rejected the capture-import shape");
    }
    const agentRevision = normalizedRevision(observeCreativeWorkspaceAgentSnapshot(agentRuntime));

    expect(uiRevision).toEqual(agentRevision);
  });

  it("produces identical revisions for the Video batch (clip split/transition/ripple, tracks, settings)", () => {
    const { uiRevision, agentRevision } = compareExecutors((execute) => {
      execute({ op: "edit.track.add", kind: "video", name: "叠化层" });
      const takeA = execute({
        op: "edit.clip.add",
        track_id: "video-1",
        media_id: "media:video:take",
        name: "Take A",
        start_sec: 0,
        duration_sec: 4,
        source_duration_sec: 12,
      });
      const takeB = execute({
        op: "edit.clip.add",
        track_id: "video-1",
        media_id: "media:video:take",
        name: "Take B",
        start_sec: 4,
        duration_sec: 4,
        source_duration_sec: 12,
      });
      execute({
        op: "edit.clip.update",
        clip_id: createdId(takeB, "clip"),
        patch: { transition_in_sec: 0.5, fade_out_sec: 0.25 },
      });
      execute({ op: "edit.clip.split", clip_id: createdId(takeA, "clip"), at_sec: 2 });
      execute({ op: "edit.clip.remove", clip_id: createdId(takeA, "clip"), ripple: true });
      execute({ op: "edit.track.update", track_id: "audio-1", patch: { muted: true, name: "对白" } });
      execute({
        op: "edit.settings.update",
        patch: { frame_rate: { numerator: 24_000, denominator: 1_001 }, snap_enabled: false, aspect_ratio: "9 / 16" },
      });
      // Discrete timeline viewport writes (zoom presets/buttons and fit)
      // share the same executor as the Agent ops.
      execute({ op: "edit.timeline.set_zoom", zoom: 1.5 });
      const fitted = execute({ op: "edit.timeline.fit", surface_width: 600 });
      expect(fitted).toMatchObject({ surface_width: 600, unchanged: false });
    });
    expect(uiRevision).toEqual(agentRevision);
  });

  it("keeps the legacy direct-store ripple delete and cross dissolve semantics", () => {
    const seedTimeline = (runtime: CreativeWorkspaceAgentContext) => {
      const executed = agentExecutor(runtime);
      const first = executed({
        op: "edit.clip.add",
        track_id: "video-1",
        media_id: "media:video:take",
        name: "Head",
        start_sec: 0,
        duration_sec: 3,
        source_duration_sec: 12,
      });
      const second = executed({
        op: "edit.clip.add",
        track_id: "video-1",
        media_id: "media:video:take",
        name: "Tail",
        start_sec: 3,
        duration_sec: 5,
        source_duration_sec: 12,
      });
      return { firstId: createdId(first, "clip"), secondId: createdId(second, "clip") };
    };

    // Legacy path: the direct store mutators the Video Editor used to call.
    resetWorkspace();
    const legacyRuntime = context();
    const legacySeed = seedTimeline(legacyRuntime);
    useDirectorCreativeWorkspaceStore.getState().setClipTransition(legacySeed.secondId, 0.5);
    useDirectorCreativeWorkspaceStore.getState().rippleRemoveClip(legacySeed.firstId);
    const legacyRevision = normalizedRevision(observeCreativeWorkspaceAgentSnapshot(legacyRuntime));

    // Migrated path: the shared dispatch the Video Editor calls today.
    resetWorkspace();
    const dispatchRuntime = context();
    const dispatchSeed = seedTimeline(dispatchRuntime);
    const executed = uiExecutor(dispatchRuntime);
    executed({ op: "edit.clip.update", clip_id: dispatchSeed.secondId, patch: { transition_in_sec: 0.5 } });
    executed({ op: "edit.clip.remove", clip_id: dispatchSeed.firstId, ripple: true });
    const dispatchRevision = normalizedRevision(observeCreativeWorkspaceAgentSnapshot(dispatchRuntime));

    expect(dispatchRevision).toEqual(legacyRevision);
  });

  it("reports ripple receipts with the shifted clips", () => {
    const runtime = context();
    const executed = uiExecutor(runtime);
    const first = executed({
      op: "edit.clip.add",
      track_id: "video-1",
      media_id: "media:video:take",
      name: "Head",
      start_sec: 0,
      duration_sec: 3,
      source_duration_sec: 12,
    });
    const second = executed({
      op: "edit.clip.add",
      track_id: "video-1",
      media_id: "media:video:take",
      name: "Tail",
      start_sec: 3,
      duration_sec: 5,
      source_duration_sec: 12,
    });
    const removal = executed({ op: "edit.clip.remove", clip_id: createdId(first, "clip"), ripple: true });
    expect(removal).toMatchObject({
      removed_id: createdId(first, "clip"),
      track_id: "video-1",
      ripple_shift_sec: 3,
      shifted_clip_ids: [createdId(second, "clip")],
    });
    const state = useDirectorCreativeWorkspaceStore.getState();
    const survivor = state.editTracks.find((track) => track.id === "video-1")?.clips[0];
    expect(survivor?.id).toBe(createdId(second, "clip"));
    expect(survivor?.startSec).toBe(0);
  });

  it("fills the snapshot guard and a fresh idempotency key on every dispatch", () => {
    const runtime = context();
    const before = observeCreativeWorkspaceAgentSnapshot(runtime).snapshot_fingerprint;
    const first = dispatchCreativeWorkspaceOperations(
      { op: "edit.settings.update", patch: { snap_enabled: false } },
      { context: runtime },
    );
    if (!first.ok) throw new Error(first.error);
    expect(first.snapshot_fingerprint_before).toBe(before);
    expect(first.snapshot_fingerprint_after).toBe(observeCreativeWorkspaceAgentSnapshot(runtime).snapshot_fingerprint);
    expect(first.execution.result.idempotency).toMatchObject({ key: first.idempotency_key, replayed: false });

    // Repeating the same intent must not be swallowed by idempotency replay.
    const second = dispatchCreativeWorkspaceOperations(
      { op: "edit.settings.update", patch: { snap_enabled: true } },
      { context: runtime },
    );
    if (!second.ok) throw new Error(second.error);
    expect(second.idempotency_key).not.toBe(first.idempotency_key);
    expect(useDirectorCreativeWorkspaceStore.getState().editSettings.snapEnabled).toBe(true);
  });

  it("surfaces contract rejections instead of silent no-ops and leaves the revision untouched", () => {
    const runtime = context();
    const executed = uiExecutor(runtime);
    const clip = executed({
      op: "edit.clip.add",
      track_id: "video-1",
      media_id: "media:video:take",
      name: "Solo",
      start_sec: 2,
      duration_sec: 4,
      source_duration_sec: 12,
    });
    const before = observeCreativeWorkspaceAgentSnapshot(runtime).snapshot_fingerprint;

    // A cross dissolve needs an adjacent predecessor; the store used to no-op.
    const transition = dispatchCreativeWorkspaceOperations(
      { op: "edit.clip.update", clip_id: createdId(clip, "clip"), patch: { transition_in_sec: 0.5 } },
      { context: runtime },
    );
    expect(transition).toMatchObject({ ok: false, code: "conflict" });
    if (transition.ok) throw new Error("expected rejection");
    expect(transition.error).toContain("predecessor");

    executed({ op: "edit.track.update", track_id: "video-1", patch: { locked: true } });
    const lockedFingerprint = observeCreativeWorkspaceAgentSnapshot(runtime).snapshot_fingerprint;
    const removal = dispatchCreativeWorkspaceOperations(
      { op: "edit.clip.remove", clip_id: createdId(clip, "clip"), ripple: true },
      { context: runtime },
    );
    expect(removal).toMatchObject({ ok: false, code: "locked" });
    expect(observeCreativeWorkspaceAgentSnapshot(runtime).snapshot_fingerprint).toBe(lockedFingerprint);
    expect(before).not.toBe(lockedFingerprint);
  });

  it("edit.clip.add overwrite trims covered neighbours the same way commitClipPlacement does", () => {
    const runtime = context();
    const executed = uiExecutor(runtime);
    executed({
      op: "edit.clip.add",
      track_id: "video-1",
      media_id: "media:image:poster",
      name: "Covered still",
      start_sec: 0,
      duration_sec: 3,
      source_duration_sec: 3,
    });
    executed({
      op: "edit.clip.add",
      track_id: "video-1",
      media_id: "media:video:take",
      name: "Overwrite take",
      start_sec: 0,
      duration_sec: 4,
      source_duration_sec: 12,
      overwrite: true,
    });
    const track = useDirectorCreativeWorkspaceStore.getState().editTracks.find((item) => item.id === "video-1");
    expect(track?.clips).toHaveLength(1);
    expect(track?.clips[0]).toMatchObject({ name: "Overwrite take", startSec: 0, durationSec: 4 });
  });

  it("dispatches media.proxy.attach for a cataloged original and proxy candidate", () => {
    const assets: CreativeMediaAsset[] = [
      ...MEDIA_ASSETS,
      {
        id: "media:video:take-proxy",
        kind: "video",
        name: "Take Proxy",
        fileName: "take-proxy.webm",
        mimeType: "video/webm",
        size: 2_048,
        createdAt: "2026-07-31T08:02:00.000Z",
        lastModified: null,
        durationSec: 12,
        width: 1_280,
        height: 720,
        source: "test",
        objectUrl: "blob:take-proxy",
        proxyOf: null,
      },
    ];
    const runtime: CreativeWorkspaceAgentContext = {
      workspace: { getState: () => useDirectorCreativeWorkspaceStore.getState() },
      media: {
        getState: () => ({
          status: "ready",
          storageMode: "memory",
          warning: null,
          error: null,
          assets,
        }),
        attachExistingProxy: (originalId, proxyId) => {
          const proxy = assets.find((asset) => asset.id === proxyId);
          const original = assets.find((asset) => asset.id === originalId);
          if (!proxy || !original) return null;
          const updated = { ...proxy, proxyOf: originalId };
          const index = assets.findIndex((asset) => asset.id === proxyId);
          assets[index] = updated;
          return updated;
        },
      },
    };
    const receipt = dispatchCreativeWorkspaceOperations(
      {
        op: "media.proxy.attach",
        original_media_id: "media:video:take",
        proxy_media_id: "media:video:take-proxy",
      },
      { context: runtime },
    );
    expect(receipt).toMatchObject({ ok: true });
    if (!receipt.ok) throw new Error(receipt.error);
    expect(receipt.execution.result).toMatchObject({
      proxy: { id: "media:video:take-proxy", proxy_of: "media:video:take" },
      changed: true,
    });
  });

  it("edit.clip.update overwrite nudges into a neighbour the same way keyboard frame steps do", () => {
    const runtime = context();
    const executed = uiExecutor(runtime);
    const first = executed({
      op: "edit.clip.add",
      track_id: "video-1",
      media_id: "media:image:poster",
      name: "Left still",
      start_sec: 0,
      duration_sec: 2,
      source_duration_sec: 3,
    });
    const second = executed({
      op: "edit.clip.add",
      track_id: "video-1",
      media_id: "media:video:take",
      name: "Right take",
      start_sec: 2,
      duration_sec: 2,
      source_duration_sec: 12,
    });
    executed({
      op: "edit.clip.update",
      clip_id: createdId(second, "clip"),
      patch: { start_sec: 1 },
      overwrite: true,
    });
    const track = useDirectorCreativeWorkspaceStore.getState().editTracks.find((item) => item.id === "video-1");
    expect(track?.clips).toHaveLength(2);
    expect(track?.clips.find((clip) => clip.id === createdId(first, "clip"))).toMatchObject({
      startSec: 0,
      durationSec: 1,
    });
    expect(track?.clips.find((clip) => clip.id === createdId(second, "clip"))).toMatchObject({
      name: "Right take",
      startSec: 1,
      durationSec: 2,
    });
  });

  it("edit.clip.add preserves in/opacity/volume and overwrite for duplicate-after placement", () => {
    const runtime = context();
    const executed = uiExecutor(runtime);
    executed({
      op: "edit.clip.add",
      track_id: "video-1",
      media_id: "media:video:take",
      name: "Source take",
      start_sec: 0,
      duration_sec: 3,
      source_duration_sec: 12,
      in_sec: 1.5,
      opacity: 0.75,
      volume: 0.4,
    });
    // Neighbour that the duplicate lands on; overwrite should trim it away.
    executed({
      op: "edit.clip.add",
      track_id: "video-1",
      media_id: "media:image:poster",
      name: "Covered still",
      start_sec: 3,
      duration_sec: 2,
      source_duration_sec: 3,
    });
    const duplicate = executed({
      op: "edit.clip.add",
      track_id: "video-1",
      media_id: "media:video:take",
      name: "Source take",
      start_sec: 3,
      duration_sec: 3,
      source_duration_sec: 12,
      in_sec: 1.5,
      opacity: 0.75,
      volume: 0.4,
      fade_in_sec: 0.2,
      fade_out_sec: 0.1,
      overwrite: true,
    });
    const track = useDirectorCreativeWorkspaceStore.getState().editTracks.find((item) => item.id === "video-1");
    expect(track?.clips).toHaveLength(2);
    expect(track?.clips.find((clip) => clip.id === createdId(duplicate, "clip"))).toMatchObject({
      name: "Source take",
      startSec: 3,
      durationSec: 3,
      inSec: 1.5,
      opacity: 0.75,
      volume: 0.4,
      fadeInSec: 0.2,
      fadeOutSec: 0.1,
    });
    expect(track?.clips.some((clip) => clip.name === "Covered still")).toBe(false);
  });

  it("edit.clip.add accepts virtual text: media ids without a Gallery asset", () => {
    const runtime = context();
    const executed = uiExecutor(runtime);
    const added = executed({
      op: "edit.clip.add",
      track_id: "video-2",
      media_id: "text:title-parity-1",
      name: "标题文字",
      start_sec: 1,
      duration_sec: 3,
      source_duration_sec: 60 * 60,
      overwrite: true,
    });
    expect(added).toMatchObject({
      track_id: "video-2",
      overwrite: true,
      virtual_text: true,
      clip: { media_id: "text:title-parity-1", name: "标题文字", start_sec: 1, duration_sec: 3 },
    });
    const track = useDirectorCreativeWorkspaceStore.getState().editTracks.find((item) => item.id === "video-2");
    expect(track?.clips.some((clip) => clip.mediaId === "text:title-parity-1")).toBe(true);

    const rejected = dispatchCreativeWorkspaceOperations(
      {
        op: "edit.clip.add",
        track_id: "audio-1",
        media_id: "text:on-audio",
        name: "坏标题",
        start_sec: 0,
        duration_sec: 1,
        source_duration_sec: 60,
      },
      { context: runtime },
    );
    expect(rejected).toMatchObject({ ok: false, code: "conflict" });
  });

  it("UI and Agent agree on a virtual text title clip revision", () => {
    const { uiRevision, agentRevision } = compareExecutors((execute) => {
      execute({
        op: "edit.clip.add",
        track_id: "video-2",
        media_id: "text:parity-title",
        name: "标题文字",
        start_sec: 2,
        duration_sec: 3,
        source_duration_sec: 60 * 60,
        overwrite: true,
      });
    });
    expect(uiRevision).toEqual(agentRevision);
  });

  it("produces identical revisions for clip renames on media and virtual title clips", () => {
    const { uiRevision, agentRevision } = compareExecutors((execute) => {
      const take = execute({
        op: "edit.clip.add",
        track_id: "video-1",
        media_id: "media:video:take",
        name: "Take",
        start_sec: 0,
        duration_sec: 4,
        source_duration_sec: 12,
      });
      const title = execute({
        op: "edit.clip.add",
        track_id: "video-2",
        media_id: "text:parity-rename-title",
        name: "标题文字",
        start_sec: 0,
        duration_sec: 3,
        source_duration_sec: 60 * 60,
      });
      execute({ op: "edit.clip.update", clip_id: createdId(take, "clip"), patch: { name: "开场镜头" } });
      // A title clip's name is its rendered text, so renaming rewrites the overlay.
      execute({ op: "edit.clip.update", clip_id: createdId(title, "clip"), patch: { name: "第一幕 · 黎明" } });
    });
    expect(uiRevision).toEqual(agentRevision);
  });

  it("keeps the legacy direct-store rename semantics for contract-expressible names", () => {
    const seedClip = (runtime: CreativeWorkspaceAgentContext) => {
      const added = agentExecutor(runtime)({
        op: "edit.clip.add",
        track_id: "video-1",
        media_id: "media:video:take",
        name: "Take",
        start_sec: 0,
        duration_sec: 4,
        source_duration_sec: 12,
      });
      return createdId(added, "clip");
    };

    // Legacy path: the per-keystroke direct store write the inspector used to call.
    resetWorkspace();
    const legacyRuntime = context();
    const legacyClipId = seedClip(legacyRuntime);
    useDirectorCreativeWorkspaceStore.getState().updateClip(legacyClipId, { name: "开场镜头" });
    const legacyRevision = normalizedRevision(observeCreativeWorkspaceAgentSnapshot(legacyRuntime));

    // Migrated path: the shared dispatch the inspector calls today.
    resetWorkspace();
    const dispatchRuntime = context();
    const dispatchClipId = seedClip(dispatchRuntime);
    const renamed = uiExecutor(dispatchRuntime)({
      op: "edit.clip.update",
      clip_id: dispatchClipId,
      patch: { name: "开场镜头" },
    });
    expect(renamed).toMatchObject({ clip: { name: "开场镜头" }, track_id: "video-1", overwrite: false });
    const dispatchRevision = normalizedRevision(observeCreativeWorkspaceAgentSnapshot(dispatchRuntime));

    expect(dispatchRevision).toEqual(legacyRevision);
  });

  it("rejects a rename on a locked track where the store used to silently no-op", () => {
    const runtime = context();
    const executed = uiExecutor(runtime);
    const clip = executed({
      op: "edit.clip.add",
      track_id: "video-1",
      media_id: "media:video:take",
      name: "Take",
      start_sec: 0,
      duration_sec: 4,
      source_duration_sec: 12,
    });
    executed({ op: "edit.track.update", track_id: "video-1", patch: { locked: true } });
    const before = observeCreativeWorkspaceAgentSnapshot(runtime).snapshot_fingerprint;

    const rename = dispatchCreativeWorkspaceOperations(
      { op: "edit.clip.update", clip_id: createdId(clip, "clip"), patch: { name: "开场镜头" } },
      { context: runtime },
    );
    expect(rename).toMatchObject({ ok: false, code: "locked" });
    expect(observeCreativeWorkspaceAgentSnapshot(runtime).snapshot_fingerprint).toBe(before);
  });

  it("dispatches multi-operation arrays as one atomic batch that rolls back on failure", () => {
    const runtime = context();
    const before = observeCreativeWorkspaceAgentSnapshot(runtime);

    const failed = dispatchCreativeWorkspaceOperations(
      [
        { op: "canvas.node.add", kind: "note", title: "第一步", x: 0, y: 0 },
        { op: "canvas.node.remove", node_id: "board-node-missing" },
      ],
      { context: runtime },
    );
    expect(failed).toMatchObject({ ok: false, code: "not_found" });
    if (failed.ok) throw new Error("expected batch rejection");
    expect(failed.execution?.result).toMatchObject({ failed_step_id: "ui-step-2", rolled_back: true });
    // The fingerprint is a revision counter that advances across the rollback,
    // so equality is asserted on the normalized content instead.
    const after = observeCreativeWorkspaceAgentSnapshot(runtime);
    expect(after.counts.board_nodes).toBe(before.counts.board_nodes);
    expect(normalizedRevision(after)).toEqual(normalizedRevision(before));

    const succeeded = dispatchCreativeWorkspaceOperations(
      [
        { op: "canvas.node.add", kind: "note", title: "第一步", x: 0, y: 0 },
        { op: "canvas.node.add", kind: "note", title: "第二步", x: 320, y: 0 },
      ],
      { context: runtime },
    );
    if (!succeeded.ok) throw new Error(succeeded.error);
    expect(observeCreativeWorkspaceAgentSnapshot(runtime).counts.board_nodes).toBe(before.counts.board_nodes + 2);
  });

  it("routes UI file-picker relink through the shared media.relink executor", async () => {
    const runtime = context();
    const file = new File(["replacement"], "poster-v2.png", { type: "image/png" });
    const receipt = await dispatchCreativeWorkspaceMediaRelink("media:image:poster", file, {
      context: runtime,
      idempotencyKey: "ui-relink-test",
    });
    expect(receipt).toMatchObject({ ok: true, idempotency_key: "ui-relink-test" });
    if (!receipt.ok) throw new Error(receipt.error);
    expect(receipt.execution).toMatchObject({
      success: true,
      operation: "media.relink",
      result: {
        old_media_id: "media:image:poster",
        new_media_id: "media:image:relinked",
        references_updated: 1,
        waveform_ready: false,
      },
    });
    expect(vi.mocked(relinkDirectorCreativeMedia)).toHaveBeenCalledWith("media:image:poster", file, "image");
  });
});
