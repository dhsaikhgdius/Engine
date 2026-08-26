import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  persistentCreativeMediaLibrary,
  type CreativeMediaAsset,
  type PersistentCreativeMediaState,
} from "../../src/comprehensive/editor/media/persistentCreativeMediaStore";
import { useDirectorCreativeWorkspaceStore } from "../../src/comprehensive/editor/workspaces/directorWorkspaceStore";
import {
  creativeWorkspaceAgentRequestSchema,
  executeCreativeWorkspaceAgentOperation,
  executeCreativeWorkspaceAgentOperationAsync,
  parseCreativeWorkspaceAgentOperation,
  type CreativeWorkspaceAgentContext,
  type CreativeWorkspaceAgentExecutionResult,
} from "../../src/agent/creativeWorkspaceAgentContract";

const mediaProbeMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/comprehensive/editor/media/creativeMediaProbe", () => ({
  probeCreativeMediaFile: mediaProbeMock,
}));

const POSTER: CreativeMediaAsset = {
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
};

function mediaState(assets: readonly CreativeMediaAsset[]): PersistentCreativeMediaState {
  return {
    status: "ready",
    storageMode: "memory",
    warning: null,
    error: null,
    assets: assets.map((asset) => ({ ...asset })),
  };
}

function context(
  assets: readonly CreativeMediaAsset[] = [POSTER],
  readBlob?: (id: string) => Promise<Blob | null>,
): CreativeWorkspaceAgentContext {
  return {
    workspace: { getState: () => useDirectorCreativeWorkspaceStore.getState() },
    media: {
      getState: () => mediaState(assets),
      attachExistingProxy: () => null,
      updatePlaybackPreference: () => null,
      ...(readBlob ? { readBlob } : {}),
    },
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

describe("creative workspace gallery purge and media.relink", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    mediaProbeMock.mockReset();
    useDirectorCreativeWorkspaceStore.getState().resetCreativeWorkspaces();
  });

  it("requires confirm:true on gallery.media.purge at the schema boundary", () => {
    expect(parseCreativeWorkspaceAgentOperation({ op: "gallery.media.purge", media_ids: [POSTER.id] }).success).toBe(
      false,
    );
    expect(
      parseCreativeWorkspaceAgentOperation({
        op: "gallery.media.purge",
        media_ids: [POSTER.id],
        confirm: true,
      }).success,
    ).toBe(true);
  });

  it("permanently deletes unreferenced Gallery media after confirm", () => {
    const runtime = context();
    expectSuccess(
      executeCreativeWorkspaceAgentOperation(
        { op: "gallery.media.update", media_id: POSTER.id, patch: { rating: 3 } },
        runtime,
      ),
    );
    expect(
      useDirectorCreativeWorkspaceStore.getState().galleryMedia.some((record) => record.mediaId === POSTER.id),
    ).toBe(true);

    expectSuccess(
      executeCreativeWorkspaceAgentOperation(
        { op: "gallery.media.purge", media_ids: [POSTER.id], confirm: true },
        runtime,
      ),
    );
    expect(
      useDirectorCreativeWorkspaceStore.getState().galleryMedia.some((record) => record.mediaId === POSTER.id),
    ).toBe(false);
  });

  it("rejects purge when Canvas still references the media", () => {
    const runtime = context();
    expectSuccess(
      executeCreativeWorkspaceAgentOperation(
        {
          op: "canvas.node.add",
          kind: "image",
          title: "Poster still",
          media_id: POSTER.id,
          x: 40,
          y: 40,
        },
        runtime,
      ),
    );
    expectFailure(
      executeCreativeWorkspaceAgentOperation(
        { op: "gallery.media.purge", media_ids: [POSTER.id], confirm: true },
        runtime,
      ),
      "conflict",
    );
  });

  it("rejects the sync media.relink path and asks for the async executor", () => {
    const runtime = context();
    expectFailure(
      executeCreativeWorkspaceAgentOperation(
        {
          op: "media.relink",
          media_id: POSTER.id,
          source: { kind: "inline", encoding: "utf8", payload: "replacement-bytes", file_name: "poster.png" },
        },
        runtime,
      ),
      "operation_rejected",
    );
  });

  it("rejects async media.relink for media that is not cataloged", async () => {
    const result = await executeCreativeWorkspaceAgentOperationAsync(
      {
        op: "media.relink",
        media_id: "media:missing",
        source: { kind: "inline", encoding: "utf8", payload: "replacement-bytes" },
      },
      context(),
    );
    expectFailure(result, "not_found");
  });

  it("stamps probed storage and durability on a successful media.relink receipt", async () => {
    mediaProbeMock.mockResolvedValue({ kind: "image", width: 2, height: 2 });
    const runtime: CreativeWorkspaceAgentContext = {
      workspace: { getState: () => useDirectorCreativeWorkspaceStore.getState() },
      media: {
        getState: () => {
          const real = persistentCreativeMediaLibrary.store.getState();
          return { ...real, assets: [...real.assets, { ...POSTER }] };
        },
        readBlob: (id) => persistentCreativeMediaLibrary.getBlob(id),
      },
    };
    const result = await executeCreativeWorkspaceAgentOperationAsync(
      {
        op: "media.relink",
        media_id: POSTER.id,
        source: { kind: "inline", encoding: "utf8", payload: "replacement-bytes", file_name: "poster.png" },
      },
      runtime,
    );
    const receipt = expectSuccess(result);
    expect(receipt.result).toMatchObject({
      old_media_id: POSTER.id,
      storage: { mode: "memory", durable: false },
      durability: {
        outcome: "verified",
        cataloged_bytes: "replacement-bytes".length,
        stored_bytes: "replacement-bytes".length,
        omit_reason: null,
      },
    });
    expect(receipt.result.new_media_id).toBe((receipt.result.durability as { media_id: string }).media_id);
  });

  it("stamps a typed omit reason on media.relink receipts when the host cannot read blobs", async () => {
    mediaProbeMock.mockResolvedValue({ kind: "image", width: 2, height: 2 });
    const runtime: CreativeWorkspaceAgentContext = {
      workspace: { getState: () => useDirectorCreativeWorkspaceStore.getState() },
      media: {
        getState: () => {
          const real = persistentCreativeMediaLibrary.store.getState();
          return { ...real, assets: [...real.assets, { ...POSTER }] };
        },
      },
    };
    const result = await executeCreativeWorkspaceAgentOperationAsync(
      {
        op: "media.relink",
        media_id: POSTER.id,
        source: { kind: "inline", encoding: "utf8", payload: "omit-reason-bytes", file_name: "poster.png" },
      },
      runtime,
    );
    const receipt = expectSuccess(result);
    expect(receipt.result).toMatchObject({
      durability: { outcome: "unverified", omit_reason: "blob_reader_unavailable", stored_bytes: null },
    });
  });
});

describe("creative workspace media.verify durable byte probes", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    useDirectorCreativeWorkspaceStore.getState().resetCreativeWorkspaces();
  });

  it("rejects the sync media.verify path and asks for the async executor", () => {
    const failure = expectFailure(
      executeCreativeWorkspaceAgentOperation({ op: "media.verify", media_ids: [POSTER.id] }, context()),
      "operation_rejected",
    );
    expect(failure.error).toContain("executeCreativeWorkspaceAgentOperationAsync");
  });

  it("rejects duplicate media_ids at the schema boundary", () => {
    expect(
      parseCreativeWorkspaceAgentOperation({ op: "media.verify", media_ids: [POSTER.id, POSTER.id] }).success,
    ).toBe(false);
  });

  it("excludes media.verify from execute_batch", () => {
    const parsed = creativeWorkspaceAgentRequestSchema.safeParse({
      op: "execute_batch",
      idempotency_key: "verify-batch-v1",
      expected_snapshot_fingerprint: "fingerprint",
      steps: [{ step_id: "step-1", operation: { op: "media.verify", media_ids: [POSTER.id] } }],
    });
    expect(parsed.success).toBe(false);
  });

  it("probes bytes back from the durable store with typed per-item outcomes", async () => {
    const intact = { ...POSTER, id: "media:image:intact", size: 4 };
    const shrunken = { ...POSTER, id: "media:image:shrunken", size: 4_096 };
    const evicted = { ...POSTER, id: "media:image:evicted", size: 512, objectUrl: null };
    const blobs = new Map<string, Blob>([
      [intact.id, new Blob(["four"])],
      [shrunken.id, new Blob(["short"])],
    ]);
    const runtime = context([intact, shrunken, evicted], async (id) => blobs.get(id) ?? null);
    const result = await executeCreativeWorkspaceAgentOperationAsync(
      { op: "media.verify", media_ids: [intact.id, shrunken.id, evicted.id, "media:image:ghost"] },
      runtime,
    );
    const receipt = expectSuccess(result);
    expect(receipt.operation).toBe("media.verify");
    expect(receipt.result).toMatchObject({
      storage: { mode: "memory", durable: false, warning: null },
      counts: { verified: 1, size_mismatch: 1, missing_bytes: 1, not_cataloged: 1, unverified: 0 },
      items: [
        {
          media_id: intact.id,
          outcome: "verified",
          cataloged_bytes: 4,
          stored_bytes: 4,
          object_url_present: true,
          omit_reason: null,
        },
        {
          media_id: shrunken.id,
          outcome: "size_mismatch",
          cataloged_bytes: 4_096,
          stored_bytes: 5,
          omit_reason: null,
        },
        {
          media_id: evicted.id,
          outcome: "missing_bytes",
          cataloged_bytes: 512,
          stored_bytes: null,
          object_url_present: false,
        },
        {
          media_id: "media:image:ghost",
          outcome: "not_cataloged",
          cataloged_bytes: null,
          stored_bytes: null,
          object_url_present: null,
        },
      ],
    });
  });

  it("stamps blob_reader_unavailable instead of guessing when the host cannot read blobs", async () => {
    const result = await executeCreativeWorkspaceAgentOperationAsync(
      { op: "media.verify", media_ids: [POSTER.id] },
      context(),
    );
    const receipt = expectSuccess(result);
    expect(receipt.result).toMatchObject({
      counts: { verified: 0, unverified: 1 },
      items: [
        {
          media_id: POSTER.id,
          outcome: "unverified",
          omit_reason: "blob_reader_unavailable",
          cataloged_bytes: POSTER.size,
          stored_bytes: null,
        },
      ],
    });
  });

  it("stamps probe_failed with the failure detail when the durable read throws", async () => {
    const runtime = context([POSTER], async () => {
      throw new Error("backend transaction aborted");
    });
    const result = await executeCreativeWorkspaceAgentOperationAsync(
      { op: "media.verify", media_ids: [POSTER.id] },
      runtime,
    );
    const receipt = expectSuccess(result);
    expect(receipt.result).toMatchObject({
      items: [{ media_id: POSTER.id, outcome: "unverified", omit_reason: "probe_failed" }],
    });
    expect((receipt.result.items as Array<{ detail: string }>)[0]!.detail).toContain("backend transaction aborted");
  });
});
