import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CreativeMediaAsset } from "../../../../src/comprehensive/editor/media/persistentCreativeMediaStore";
import type { CreativeMediaWaveformData } from "../../../../src/comprehensive/editor/media/creativeMediaEngineering";
import { LanguageProvider } from "../../../../src/comprehensive/i18n/language";

const mediaMocks = vi.hoisted(() => ({
  attachProxy: vi.fn(),
  getAsset: vi.fn(),
  importBlob: vi.fn(),
  importFile: vi.fn(),
  probe: vi.fn(),
}));

vi.mock("../../../../src/comprehensive/editor/media/creativeMediaProbe", () => ({
  probeCreativeMediaFile: mediaMocks.probe,
}));

vi.mock("../../../../src/comprehensive/editor/media/persistentCreativeMediaStore", () => ({
  persistentCreativeMediaLibrary: {
    attachProxy: mediaMocks.attachProxy,
    getAsset: mediaMocks.getAsset,
    importBlob: mediaMocks.importBlob,
    importFile: mediaMocks.importFile,
  },
  usePersistentCreativeMediaAssets: () => [],
}));

import {
  attachDirectorCreativeMediaProxy,
  getDirectorMediaEngineeringSnapshot,
  getDirectorMediaPreviewSource,
  getOfflineDirectorMediaDuration,
  inferDirectorMediaKindFromId,
  persistDirectorMediaItem,
  relinkDirectorCreativeMedia,
  resolveDirectorStoryboardPreviewSource,
  useDirectorMediaLibrary,
  type DirectorMediaItem,
} from "../../../../src/comprehensive/editor/workspaces/directorMediaLibrary";
import {
  setDirectorCreativeWorkspaceScope,
  useDirectorCreativeWorkspaceStore,
} from "../../../../src/comprehensive/editor/workspaces/directorWorkspaceStore";

const WAVEFORM: CreativeMediaWaveformData = {
  version: 1,
  durationSec: 3,
  sampleRate: 48_000,
  channelCount: 1,
  samplesPerPeak: 24_000,
  minPeaks: [-0.5, -0.25],
  maxPeaks: [0.5, 0.25],
};

function importedAsset(overrides: Partial<CreativeMediaAsset> = {}): CreativeMediaAsset {
  return {
    id: "creative-media:video:new-take",
    kind: "video",
    name: "New take",
    fileName: "new-take.mp4",
    mimeType: "video/mp4",
    size: 1_024,
    createdAt: "2026-07-31T08:00:00.000Z",
    lastModified: null,
    durationSec: 3,
    width: 1920,
    height: 1080,
    source: "media-relink",
    waveform: WAVEFORM,
    proxyOf: null,
    proxyProfile: null,
    objectUrl: "blob:new-take",
    ...overrides,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  setDirectorCreativeWorkspaceScope("director-media-library-tests");
  useDirectorCreativeWorkspaceStore.getState().resetCreativeWorkspaces();
  mediaMocks.attachProxy.mockReset();
  mediaMocks.getAsset.mockReset();
  mediaMocks.importBlob.mockReset();
  mediaMocks.importFile.mockReset();
  mediaMocks.probe.mockReset();
});

describe("Director transient media persistence", () => {
  it("copies a camera capture into durable creative media before it is referenced", async () => {
    const capture: DirectorMediaItem = {
      id: "capture:camera-1:capture-1",
      kind: "image",
      collection: "captures",
      name: "Camera 1 Capture 1",
      subtitle: "Camera 1 · 50 mm",
      thumbnailUrl: "data:image/png;base64,capture",
      sourceUrl: "data:image/png;base64,capture",
      durationSec: 3,
      cameraId: "camera-1",
      frameStart: null,
      frameEnd: null,
      width: 1920,
      height: 1080,
    };
    const blob = new Blob(["capture"], { type: "image/png" });
    const fetchMedia = vi.fn().mockResolvedValue({ ok: true, blob: async () => blob });
    const durable = importedAsset({
      id: "creative-media:image:camera-capture",
      kind: "image",
      name: capture.name,
      fileName: "Camera 1 Capture 1.png",
      mimeType: "image/png",
      objectUrl: "blob:camera-capture",
      width: 1920,
      height: 1080,
    });
    const library = { importBlob: vi.fn().mockResolvedValue(durable) };

    await expect(persistDirectorMediaItem(capture, library, fetchMedia as unknown as typeof fetch)).resolves.toBe(
      durable.id,
    );
    expect(fetchMedia).toHaveBeenCalledWith(capture.sourceUrl);
    expect(library.importBlob).toHaveBeenCalledWith(
      blob,
      expect.objectContaining({
        kind: "image",
        name: capture.name,
        fileName: "Camera 1 Capture 1.png",
        source: "director-captures",
      }),
    );
  });

  it("keeps an existing durable media id without copying it again", async () => {
    const durableItem: DirectorMediaItem = {
      id: "creative-media:video:existing",
      kind: "video",
      collection: "imports",
      name: "Existing",
      subtitle: "3s",
      thumbnailUrl: null,
      sourceUrl: "blob:existing",
      durationSec: 3,
      cameraId: null,
      frameStart: null,
      frameEnd: null,
    };
    const library = { importBlob: vi.fn() };
    const fetchMedia = vi.fn();

    await expect(persistDirectorMediaItem(durableItem, library, fetchMedia)).resolves.toBe(durableItem.id);
    expect(fetchMedia).not.toHaveBeenCalled();
    expect(library.importBlob).not.toHaveBeenCalled();
  });
});

describe("Director media preview resolution", () => {
  it("uses the exact persisted storyboard thumbnail instead of the camera's latest capture", () => {
    const thumbnail = importedAsset({ id: "creative-media:image:shot-01", objectUrl: "blob:shot-01" });

    expect(
      resolveDirectorStoryboardPreviewSource(
        {
          thumbnail: {
            mediaId: thumbnail.id,
            cameraId: "camera-1",
            frame: 48,
            width: 1920,
            height: 1080,
            capturedAt: "2026-08-09T00:00:00.000Z",
          },
        },
        [thumbnail],
        "data:image/png;base64,newest-camera-capture",
      ),
    ).toEqual({ sourceUrl: "blob:shot-01", availability: "online" });
  });

  it("marks a broken storyboard thumbnail reference offline without substituting another shot", () => {
    expect(
      resolveDirectorStoryboardPreviewSource(
        {
          thumbnail: {
            mediaId: "creative-media:image:missing",
            cameraId: "camera-1",
            frame: 48,
            width: 1920,
            height: 1080,
            capturedAt: "2026-08-09T00:00:00.000Z",
          },
        },
        [],
        "data:image/png;base64,wrong-shot",
      ),
    ).toEqual({ sourceUrl: null, availability: "offline" });
  });

  it("recovers media kind and a sensible duration for stale timeline references", () => {
    expect(inferDirectorMediaKindFromId("creative-media:image:missing-still", "video")).toBe("image");
    expect(inferDirectorMediaKindFromId("recording:missing-take", "audio")).toBe("video");
    expect(getOfflineDirectorMediaDuration("image", 3600, 3600)).toBe(3);
    expect(getOfflineDirectorMediaDuration("image", 3600, 5)).toBe(5);
  });

  it("keeps a Gallery-only missing asset visible as an offline relink target", () => {
    const missingId = "creative-media:video:gallery-only-missing";
    useDirectorCreativeWorkspaceStore.getState().updateGalleryMedia(missingId, {
      customName: "Gallery missing take",
      addedAt: "2026-08-11T00:00:00.000Z",
    });

    const { result } = renderHook(() => useDirectorMediaLibrary());

    expect(result.current.find((item) => item.id === missingId)).toMatchObject({
      id: missingId,
      kind: "video",
      collection: "imports",
      availability: "offline",
      sourceUrl: null,
      thumbnailUrl: null,
    });
  });

  it("localizes the generated offline subtitle without translating the media name", () => {
    const missingId = "creative-media:video:english-offline-copy";
    window.localStorage.setItem("director.ui.locale", "en-US");
    useDirectorCreativeWorkspaceStore.getState().updateGalleryMedia(missingId, {
      customName: "中文素材名",
      addedAt: "2026-08-11T00:00:00.000Z",
    });

    const { result } = renderHook(() => useDirectorMediaLibrary(), { wrapper: LanguageProvider });

    expect(result.current.find((item) => item.id === missingId)).toMatchObject({
      name: "中文素材名",
      subtitle: "Offline media · Waiting to reconnect",
    });
  });

  it("prefers original media for the video editor preview surface", () => {
    expect(
      getDirectorMediaPreviewSource({
        kind: "image",
        originalSourceUrl: "blob:original",
        sourceUrl: "blob:proxy",
        thumbnailUrl: "blob:thumb",
      }),
    ).toBe("blob:original");
    expect(
      getDirectorMediaPreviewSource({
        kind: "video",
        originalSourceUrl: "blob:original-video",
        sourceUrl: "blob:proxy-video",
        thumbnailUrl: null,
      }),
    ).toBe("blob:original-video");
  });
});

describe("Director media relink", () => {
  it("repairs every Canvas and timeline reference in one undo unit, including locked tracks", async () => {
    const missingId = "creative-media:video:missing-take";
    const workspace = useDirectorCreativeWorkspaceStore.getState();
    const node = workspace.addBoardNode({
      kind: "video",
      title: "Missing board take",
      mediaId: missingId,
      x: 40,
      y: 80,
    });
    const lockedClip = workspace.addClip({
      trackId: "video-1",
      mediaId: missingId,
      name: "Missing locked take",
      startSec: 0,
      durationSec: 8,
      sourceDurationSec: 8,
    });
    const secondClip = workspace.addClip({
      trackId: "video-2",
      mediaId: missingId,
      name: "Missing second take",
      startSec: 2,
      durationSec: 6,
      sourceDurationSec: 8,
    });
    workspace.toggleTrackLock("video-1");
    const replacement = importedAsset();
    mediaMocks.probe.mockResolvedValue({
      kind: "video",
      durationSec: 3,
      width: 1920,
      height: 1080,
      waveform: WAVEFORM,
    });
    mediaMocks.importFile.mockResolvedValue(replacement);
    const file = new File(["replacement"], "new-take.mp4", { type: "video/mp4" });

    await expect(relinkDirectorCreativeMedia(missingId, file, "video")).resolves.toEqual({
      ok: true,
      operation: "media.relink",
      oldMediaId: missingId,
      newMediaId: replacement.id,
      referencesUpdated: 3,
      waveformReady: true,
    });

    const repaired = useDirectorCreativeWorkspaceStore.getState();
    expect(repaired.boardNodes.find((entry) => entry.id === node?.id)?.mediaId).toBe(replacement.id);
    expect(repaired.editTracks.find((track) => track.id === "video-1")?.locked).toBe(true);
    expect(
      repaired.editTracks
        .flatMap((track) => track.clips)
        .filter((clip) => [lockedClip?.id, secondClip?.id].includes(clip.id)),
    ).toEqual([
      expect.objectContaining({ id: lockedClip?.id, mediaId: replacement.id, sourceDurationSec: 3, durationSec: 3 }),
      expect.objectContaining({ id: secondClip?.id, mediaId: replacement.id, sourceDurationSec: 3, durationSec: 3 }),
    ]);
    expect(mediaMocks.importFile).toHaveBeenCalledWith(
      file,
      expect.objectContaining({ kind: "video", waveform: WAVEFORM, source: "media-relink" }),
    );

    repaired.undo();
    const undone = useDirectorCreativeWorkspaceStore.getState();
    expect(undone.boardNodes.find((entry) => entry.id === node?.id)?.mediaId).toBe(missingId);
    expect(undone.editTracks.find((track) => track.id === "video-1")?.locked).toBe(true);
    expect(undone.editTracks.flatMap((track) => track.clips).filter((clip) => clip.mediaId === missingId)).toHaveLength(
      2,
    );
  });

  it("rejects incompatible replacements before importing or mutating references", async () => {
    mediaMocks.probe.mockResolvedValue({ kind: "audio", durationSec: 2 });
    const file = new File(["audio"], "voice.wav", { type: "audio/wav" });

    await expect(relinkDirectorCreativeMedia("missing-shot", file, "shot")).rejects.toThrow("重连类型不匹配");
    expect(mediaMocks.importFile).not.toHaveBeenCalled();
    expect(useDirectorCreativeWorkspaceStore.getState().canUndo).toBe(false);
  });

  it("preserves Gallery metadata when the replacement restores the same content-addressed id", async () => {
    const missingId = "creative-media:video:same-content";
    const workspace = useDirectorCreativeWorkspaceStore.getState();
    workspace.updateGalleryMedia(missingId, {
      rating: 5,
      tags: ["approved"],
      customName: "Hero take",
      addedAt: "2026-08-11T00:00:00.000Z",
    });
    mediaMocks.probe.mockResolvedValue({ kind: "video", durationSec: 3, width: 1920, height: 1080 });
    mediaMocks.importFile.mockResolvedValue(importedAsset({ id: missingId, waveform: null }));

    await relinkDirectorCreativeMedia(
      missingId,
      new File(["same-content"], "hero-take.mp4", { type: "video/mp4" }),
      "video",
    );

    expect(useDirectorCreativeWorkspaceStore.getState().galleryMedia).toEqual([
      expect.objectContaining({
        mediaId: missingId,
        rating: 5,
        tags: ["approved"],
        customName: "Hero take",
        addedAt: "2026-08-11T00:00:00.000Z",
      }),
    ]);
  });
});

describe("Director media proxy and engineering state", () => {
  it("attaches a typed proxy profile to a persisted original", async () => {
    const original = importedAsset({ id: "creative-media:video:original", name: "Original take" });
    const proxy = importedAsset({
      id: "creative-media:video:proxy",
      name: "Original take Proxy",
      width: 1280,
      height: 720,
      proxyOf: original.id,
    });
    mediaMocks.getAsset.mockReturnValue(original);
    mediaMocks.probe.mockResolvedValue({
      kind: "video",
      durationSec: 3,
      width: 1280,
      height: 720,
      waveform: WAVEFORM,
    });
    mediaMocks.attachProxy.mockResolvedValue(proxy);
    const file = new File(["proxy"], "take-proxy.mp4", { type: "video/mp4" });

    await expect(attachDirectorCreativeMediaProxy(original.id, file)).resolves.toEqual({
      ok: true,
      operation: "media.proxy.attach",
      originalMediaId: original.id,
      proxyMediaId: proxy.id,
      waveformReady: true,
    });
    expect(mediaMocks.attachProxy).toHaveBeenCalledWith(
      original.id,
      file,
      expect.objectContaining({
        kind: "video",
        fileName: "take-proxy.mp4",
        name: "Original take Proxy",
        proxyProfile: expect.objectContaining({ label: "1280×720 proxy", width: 1280, height: 720 }),
      }),
    );
  });

  it("summarizes online, offline, waveform, and available-proxy state", () => {
    const items: DirectorMediaItem[] = [
      {
        id: "online",
        kind: "video",
        collection: "imports",
        name: "Online",
        subtitle: "Proxy",
        thumbnailUrl: null,
        sourceUrl: "blob:proxy",
        durationSec: 3,
        cameraId: null,
        frameStart: null,
        frameEnd: null,
        availability: "online",
        waveform: WAVEFORM,
        playbackSource: {
          variant: "proxy",
          assetId: "proxy",
          url: "blob:proxy",
          proxyAssetId: "proxy",
          reason: "proxy-fits-preview",
        },
      },
      {
        id: "offline",
        kind: "audio",
        collection: "imports",
        name: "Offline",
        subtitle: "Missing",
        thumbnailUrl: null,
        sourceUrl: null,
        durationSec: 2,
        cameraId: null,
        frameStart: null,
        frameEnd: null,
        availability: "offline",
      },
    ];

    expect(getDirectorMediaEngineeringSnapshot(items)).toMatchObject({
      version: 1,
      total: 2,
      online: 1,
      offline: 1,
      unverified: 0,
      waveformReady: 1,
      proxyReady: 1,
      items: [
        { id: "online", playbackVariant: "proxy", waveformReady: true, proxyAssetId: "proxy" },
        { id: "offline", playbackVariant: "unavailable", waveformReady: false, proxyAssetId: null },
      ],
    });
  });
});
