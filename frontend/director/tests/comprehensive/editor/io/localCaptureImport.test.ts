import { describe, expect, it, vi } from "vitest";
import { importLocalDirectorDeskCaptures } from "../../../../src/comprehensive/editor/io/localCaptureImport";

describe("local Director capture import", () => {
  it("persists standalone Stage captures into Canvas and Gallery", async () => {
    const beginHistoryBatch = vi.fn();
    const endHistoryBatch = vi.fn();
    const updateGalleryMedia = vi.fn();
    const addBoardNode = vi.fn();
    const importBlob = vi.fn(async (_blob: Blob, options: { name?: string }) => ({
      id: `media-${options.name}`,
    }));
    const blob = new Blob(["capture"], { type: "image/png" });

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
        fetchMedia: vi.fn(async () => ({ blob: async () => blob })) as unknown as typeof fetch,
        library: { importBlob } as never,
        workspace: { beginHistoryBatch, endHistoryBatch, updateGalleryMedia, addBoardNode },
        now: () => new Date("2026-08-08T01:30:00.000Z"),
      },
    );

    expect(imported).toBe(2);
    expect(beginHistoryBatch).toHaveBeenCalledOnce();
    expect(endHistoryBatch).toHaveBeenCalledOnce();
    expect(importBlob).toHaveBeenCalledTimes(2);
    expect(updateGalleryMedia).toHaveBeenNthCalledWith(1, "media-主全景", {
      addedAt: "2026-08-08T01:30:00.000Z",
      notes: "来自 Stage 相机截图",
    });
    expect(addBoardNode).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ title: "交接近景", mediaId: "media-交接近景", x: 440, y: 80 }),
    );
  });

  it("ignores unrelated messages", async () => {
    await expect(importLocalDirectorDeskCaptures({ type: "something-else" })).resolves.toBe(0);
  });
});
