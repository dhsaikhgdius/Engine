import { beforeEach, describe, expect, it } from "vitest";
import type {
  CreativeMediaAsset,
  PersistentCreativeMediaState,
} from "../../src/comprehensive/editor/media/persistentCreativeMediaStore";
import { useDirectorCreativeWorkspaceStore } from "../../src/comprehensive/editor/workspaces/directorWorkspaceStore";
import {
  executeCreativeWorkspaceAgentOperation,
  executeCreativeWorkspaceAgentOperationAsync,
  parseCreativeWorkspaceAgentOperation,
  type CreativeWorkspaceAgentContext,
  type CreativeWorkspaceAgentExecutionResult,
} from "../../src/agent/creativeWorkspaceAgentContract";

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

function context(assets: readonly CreativeMediaAsset[] = [POSTER]): CreativeWorkspaceAgentContext {
  return {
    workspace: { getState: () => useDirectorCreativeWorkspaceStore.getState() },
    media: {
      getState: () => mediaState(assets),
      attachExistingProxy: () => null,
      updatePlaybackPreference: () => null,
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
    expect(useDirectorCreativeWorkspaceStore.getState().galleryMedia.some((record) => record.mediaId === POSTER.id)).toBe(
      true,
    );

    expectSuccess(
      executeCreativeWorkspaceAgentOperation(
        { op: "gallery.media.purge", media_ids: [POSTER.id], confirm: true },
        runtime,
      ),
    );
    expect(useDirectorCreativeWorkspaceStore.getState().galleryMedia.some((record) => record.mediaId === POSTER.id)).toBe(
      false,
    );
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
});
