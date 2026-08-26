import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CreativeWorkspaceAgentContext } from "../../../../src/agent/creativeWorkspaceAgentContract";
import { importLocalDirectorDeskCaptures } from "../../../../src/comprehensive/editor/io/localCaptureImport";
import type { CreativeMediaAsset } from "../../../../src/comprehensive/editor/media/persistentCreativeMediaStore";
import { useDirectorCreativeWorkspaceStore } from "../../../../src/comprehensive/editor/workspaces/directorWorkspaceStore";

function captureAsset(name: string): CreativeMediaAsset {
  return {
    id: `media-${name}`,
    kind: "image",
    name,
    fileName: `${name}.png`,
    mimeType: "image/png",
    size: 512,
    createdAt: "2026-08-01T08:00:00.000Z",
    lastModified: null,
    durationSec: null,
    width: 1_920,
    height: 1_080,
    source: "director-camera-capture",
    objectUrl: `blob:${name}`,
  };
}

/** Real workspace store plus an in-memory media catalog fed by the importBlob mock. */
function captureHarness(options: { catalogImports?: boolean } = {}) {
  const assets: CreativeMediaAsset[] = [];
  const importBlob = vi.fn(async (_blob: Blob, importOptions?: { name?: string }) => {
    const asset = captureAsset(importOptions?.name ?? "capture");
    if (options.catalogImports !== false) assets.push(asset);
    return asset;
  });
  const context: CreativeWorkspaceAgentContext = {
    workspace: { getState: () => useDirectorCreativeWorkspaceStore.getState() },
    media: {
      getState: () => ({ status: "ready", storageMode: "memory", warning: null, error: null, assets }),
    },
  };
  const fetchMedia = vi.fn(async () => ({
    blob: async () => new Blob(["capture"], { type: "image/png" }),
  })) as unknown as typeof fetch;
  return { importBlob, context, fetchMedia };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  useDirectorCreativeWorkspaceStore.getState().resetCreativeWorkspaces();
});

describe("local Director capture import", () => {
  it("persists standalone Stage captures into Canvas and Gallery through one shared-contract batch", async () => {
    const { importBlob, context, fetchMedia } = captureHarness();

    const imported = await importLocalDirectorDeskCaptures(
      {
        type: "storyai:director-desk-captures-sent",
        payload: {
          captures: [
            { dataUrl: "data:image/png;base64,AAAA", fileName: "主全景.png" },
            { dataUrl: "data:image/png;base64,BBBB", fileName: "交接近景.png" },
          ],
        },
      },
      {
        fetchMedia,
        library: { importBlob },
        context,
        now: () => new Date("2026-08-02T10:00:00.000Z"),
      },
    );

    expect(imported).toBe(2);
    expect(importBlob).toHaveBeenCalledTimes(2);

    const state = useDirectorCreativeWorkspaceStore.getState();
    expect(state.boardNodes).toHaveLength(2);
    expect(state.boardNodes[0]).toMatchObject({ title: "主全景", mediaId: "media-主全景", x: 80, y: 80 });
    expect(state.boardNodes[1]).toMatchObject({ title: "交接近景", mediaId: "media-交接近景", x: 440, y: 80 });
    expect(state.galleryMedia).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          mediaId: "media-主全景",
          addedAt: "2026-08-02T10:00:00.000Z",
          notes: "来自 Stage 相机截图",
        }),
        expect.objectContaining({ mediaId: "media-交接近景", addedAt: "2026-08-02T10:00:00.000Z" }),
      ]),
    );

    // The atomic batch lands as a single undo entry: one undo removes the
    // cataloging and every board node together.
    expect(state.canUndo).toBe(true);
    state.undo();
    const undone = useDirectorCreativeWorkspaceStore.getState();
    expect(undone.boardNodes).toHaveLength(0);
    expect(undone.galleryMedia.filter((record) => record.notes === "来自 Stage 相机截图")).toHaveLength(0);
  });

  it("rolls back the whole batch when any step is rejected", async () => {
    // Imports succeed but the media catalog never learns the ids, so the first
    // gallery.media.update step is rejected with not_found.
    const { importBlob, context, fetchMedia } = captureHarness({ catalogImports: false });

    await expect(
      importLocalDirectorDeskCaptures(
        {
          type: "storyai:director-desk-captures-sent",
          payload: {
            captures: [{ dataUrl: "data:image/png;base64,AAAA", fileName: "主全景.png" }],
          },
        },
        { fetchMedia, library: { importBlob }, context },
      ),
    ).rejects.toThrow(/not cataloged/);

    const state = useDirectorCreativeWorkspaceStore.getState();
    expect(state.boardNodes).toHaveLength(0);
    expect(state.galleryMedia.filter((record) => record.notes === "来自 Stage 相机截图")).toHaveLength(0);
  });

  it("ignores unrelated messages", async () => {
    await expect(importLocalDirectorDeskCaptures({ type: "something-else" })).resolves.toBe(0);
  });
});
