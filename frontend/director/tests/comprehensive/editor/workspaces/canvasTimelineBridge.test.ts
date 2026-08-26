import { beforeEach, describe, expect, it } from "vitest";
import { persistentCreativeMediaLibrary } from "../../../../src/comprehensive/editor/media/persistentCreativeMediaStore";
import { appendBoardNodeToTimeline } from "../../../../src/comprehensive/editor/workspaces/canvasTimelineBridge";
import type { DirectorMediaItem } from "../../../../src/comprehensive/editor/workspaces/directorMediaLibrary";
import { useDirectorCreativeWorkspaceStore } from "../../../../src/comprehensive/editor/workspaces/directorWorkspaceStore";

function mediaItem(overrides: Partial<DirectorMediaItem>): DirectorMediaItem {
  return {
    id: "media:video:take",
    kind: "video",
    collection: "imports",
    name: "Camera take",
    subtitle: "4.0s · video/mp4",
    thumbnailUrl: null,
    sourceUrl: "blob:take",
    durationSec: 4,
    cameraId: null,
    frameStart: null,
    frameEnd: null,
    ...overrides,
  };
}

function seedLibrary(id: string, kind: "video" | "audio" | "image", durationSec: number | null) {
  persistentCreativeMediaLibrary.store.setState({
    status: "ready",
    storageMode: "memory",
    warning: null,
    error: null,
    assets: [
      {
        id,
        kind,
        name: "Bridge asset",
        fileName: "bridge-asset.bin",
        mimeType: kind === "image" ? "image/png" : kind === "video" ? "video/mp4" : "audio/wav",
        size: 1_024,
        createdAt: "2026-08-01T00:00:00.000Z",
        lastModified: null,
        durationSec,
        width: kind === "audio" ? null : 1_920,
        height: kind === "audio" ? null : 1_080,
        source: "test",
        objectUrl: `blob:${id}`,
      },
    ],
  });
}

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, "", "/");
  useDirectorCreativeWorkspaceStore.getState().resetCreativeWorkspaces();
  persistentCreativeMediaLibrary.store.setState({
    status: "ready",
    storageMode: "memory",
    warning: null,
    error: null,
    assets: [],
  });
});

describe("canvas timeline bridge", () => {
  it("adds the clip via the shared contract and switches to the Video workspace", () => {
    seedLibrary("media:video:take", "video", 4);

    const receipt = appendBoardNodeToTimeline(mediaItem({}));

    expect(receipt.ok).toBe(true);
    const state = useDirectorCreativeWorkspaceStore.getState();
    const clips = state.editTracks.find((track) => track.id === "video-1")?.clips ?? [];
    expect(clips).toHaveLength(1);
    expect(clips[0]).toMatchObject({ mediaId: "media:video:take", name: "Camera take", startSec: 0, durationSec: 4 });
    expect(state.mode).toBe("video");
    expect(new URL(window.location.href).searchParams.get("workspace")).toBe("video");
  });

  it("places audio items on the primary audio track", () => {
    seedLibrary("media:audio:vo", "audio", 2.5);

    const receipt = appendBoardNodeToTimeline(
      mediaItem({ id: "media:audio:vo", kind: "audio", name: "Voice over", durationSec: 2.5 }),
    );

    expect(receipt.ok).toBe(true);
    const audioClips =
      useDirectorCreativeWorkspaceStore.getState().editTracks.find((track) => track.id === "audio-1")?.clips ?? [];
    expect(audioClips).toHaveLength(1);
    expect(audioClips[0]).toMatchObject({ mediaId: "media:audio:vo", durationSec: 2.5 });
  });

  it("returns the failing receipt and stays on Canvas when the media is unknown", () => {
    const receipt = appendBoardNodeToTimeline(mediaItem({ id: "media:missing" }));

    expect(receipt).toMatchObject({ ok: false, code: "not_found" });
    const state = useDirectorCreativeWorkspaceStore.getState();
    expect(state.editTracks.flatMap((track) => track.clips)).toHaveLength(0);
    expect(state.mode).not.toBe("video");
    expect(new URL(window.location.href).searchParams.get("workspace")).toBeNull();
  });
});
