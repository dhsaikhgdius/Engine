import { describe, expect, it, vi } from "vitest";
import type { DirectorMediaItem } from "../../../../src/comprehensive/editor/workspaces/directorMediaLibrary";
import type { DirectorEditTrack } from "../../../../src/comprehensive/editor/workspaces/directorWorkspaceStore";
import {
  getContainedMediaRect,
  getDirectorClipOpacityAtTime,
  getDirectorMediaRect,
  getDirectorTimelineActiveAudioClips,
  getDirectorTimelineActiveLayers,
  getDirectorTimelineContentDuration,
  getDirectorTimelineRenderSize,
  renderDirectorTimelineFrame,
} from "../../../../src/comprehensive/editor/workspaces/directorTimelineVideoExport";

const media: DirectorMediaItem = {
  id: "capture:a",
  kind: "image",
  collection: "captures",
  name: "Frame A",
  subtitle: "Camera A",
  thumbnailUrl: "data:image/png;base64,AA==",
  sourceUrl: "data:image/png;base64,AA==",
  durationSec: 3,
  cameraId: "camera-a",
  frameStart: null,
  frameEnd: null,
};

function clip(id: string, mediaId: string, startSec: number, durationSec: number) {
  return {
    id,
    mediaId,
    name: id,
    startSec,
    durationSec,
    inSec: 0,
    sourceDurationSec: durationSec,
    playbackRate: 1,
    opacity: 1,
    volume: 1,
    fadeInSec: 0,
    fadeOutSec: 0,
    transitionInSec: 0,
    scale: 1,
    positionX: 0,
    positionY: 0,
    rotationDeg: 0,
    fit: "contain" as const,
  };
}

function tracks(): DirectorEditTrack[] {
  return [
    {
      id: "video-1",
      name: "视频 1",
      kind: "video",
      muted: false,
      locked: false,
      visible: true,
      clips: [clip("foreground", "text:title", 1, 3)],
    },
    {
      id: "video-2",
      name: "视频 2",
      kind: "video",
      muted: false,
      locked: false,
      visible: true,
      clips: [clip("background", media.id, 0, 5), clip("later", media.id, 2, 2)],
    },
    {
      id: "audio-1",
      name: "音频 1",
      kind: "audio",
      muted: false,
      locked: false,
      visible: true,
      clips: [clip("audio", "audio:a", 0, 3)],
    },
  ];
}

describe("director timeline video export planning", () => {
  it("uses real visible content duration instead of the editor's minimum ruler length", () => {
    expect(getDirectorTimelineContentDuration(tracks())).toBe(5);
    const hidden = tracks();
    hidden[1]!.visible = false;
    expect(getDirectorTimelineContentDuration(hidden)).toBe(4);

    const muted = tracks();
    muted[1]!.muted = true;
    expect(getDirectorTimelineContentDuration(muted)).toBe(5);
  });

  it("resolves bottom-to-top layers with half-open clip ranges", () => {
    const mediaById = new Map([[media.id, media]]);
    const active = getDirectorTimelineActiveLayers(tracks(), mediaById, 2.5);
    expect(active.map((layer) => layer.clip.id)).toEqual(["later", "foreground"]);
    expect(active.at(-1)?.kind).toBe("text");
    expect(getDirectorTimelineActiveLayers(tracks(), mediaById, 5)).toHaveLength(0);
  });

  it("maps timeline time into source time using the clip playback rate", () => {
    const timeline = tracks();
    timeline[1]!.clips = [{ ...clip("fast", media.id, 1, 3), inSec: 2, sourceDurationSec: 10, playbackRate: 2 }];
    const active = getDirectorTimelineActiveLayers(timeline, new Map([[media.id, media]]), 2.5);
    expect(active[0]?.sourceTimeSec).toBe(5);
  });

  it("keeps picture visibility independent from video-track audio", () => {
    const videoMedia = { ...media, id: "video:a", kind: "video" as const, sourceUrl: "blob:video" };
    const audioMedia = { ...media, id: "audio:a", kind: "audio" as const, sourceUrl: "blob:audio" };
    const timeline = tracks();
    timeline[1]!.clips = [clip("video-with-sound", videoMedia.id, 0, 5)];
    timeline[1]!.visible = false;
    const mediaById = new Map<string, DirectorMediaItem>([
      [videoMedia.id, videoMedia],
      [audioMedia.id, audioMedia],
    ]);
    expect(getDirectorTimelineActiveLayers(timeline, mediaById, 2)).toHaveLength(1);
    expect(getDirectorTimelineActiveAudioClips(timeline, mediaById, 2).map((item) => item.clip.id)).toEqual([
      "video-with-sound",
      "audio",
    ]);
    expect(getDirectorTimelineContentDuration(timeline, mediaById)).toBe(5);
    timeline[1]!.muted = true;
    expect(getDirectorTimelineActiveAudioClips(timeline, mediaById, 2).map((item) => item.clip.id)).toEqual(["audio"]);
    expect(getDirectorTimelineContentDuration(timeline, mediaById)).toBe(4);
  });

  it("maps quality and aspect presets to stable output rasters", () => {
    expect(getDirectorTimelineRenderSize("16 / 9", "preview")).toEqual({ width: 1280, height: 720 });
    expect(getDirectorTimelineRenderSize("9 / 16", "full")).toEqual({ width: 1080, height: 1920 });
    expect(getDirectorTimelineRenderSize("1 / 1", "full")).toEqual({ width: 1080, height: 1080 });
  });

  it("contains source media without stretching it", () => {
    expect(getContainedMediaRect(1920, 1080, 1080, 1080)).toEqual({ x: 0, y: 236.25, width: 1080, height: 607.5 });
  });

  it("applies fades and 1920x1080 design-space transforms consistently", () => {
    const transformed = {
      ...clip("move", media.id, 2, 4),
      fadeInSec: 1,
      fadeOutSec: 1,
      scale: 2,
      positionX: 192,
      positionY: 108,
    };
    expect(getDirectorClipOpacityAtTime(transformed, 2.5)).toBeCloseTo(0.5);
    expect(getDirectorClipOpacityAtTime(transformed, 4)).toBe(1);
    expect(getDirectorClipOpacityAtTime(transformed, 5.5)).toBeCloseTo(0.5);
    expect(getDirectorMediaRect(100, 100, 1920, 1080, transformed)).toEqual({
      x: 72,
      y: -432,
      width: 2160,
      height: 2160,
    });
  });

  it("ramps opacity through the cross-dissolve entry and multiplies coexisting fade-ins", () => {
    const entering = { ...clip("entering", media.id, 2, 4), transitionInSec: 2 };
    expect(getDirectorClipOpacityAtTime(entering, 2)).toBe(0);
    expect(getDirectorClipOpacityAtTime(entering, 3)).toBeCloseTo(0.5);
    expect(getDirectorClipOpacityAtTime(entering, 4.5)).toBe(1);

    const fadedEntering = { ...entering, fadeInSec: 2, transitionInSec: 1 };
    // At 0.5s in: fade-in 0.25 times transition ramp 0.5.
    expect(getDirectorClipOpacityAtTime(fadedEntering, 2.5)).toBeCloseTo(0.125);
    // Past the transition window only the fade-in remains.
    expect(getDirectorClipOpacityAtTime(fadedEntering, 3.5)).toBeCloseTo(0.75);
  });

  it("layers the adjacent predecessor beneath the entering clip during the transition window", () => {
    const timeline = tracks();
    timeline[1]!.clips = [
      { ...clip("previous", media.id, 0, 2), inSec: 1, sourceDurationSec: 10, playbackRate: 2 },
      { ...clip("entering", media.id, 2, 3), transitionInSec: 1 },
    ];
    const mediaById = new Map([[media.id, media]]);

    const inside = getDirectorTimelineActiveLayers(timeline, mediaById, 2.5);
    expect(inside.map((layer) => layer.clip.id)).toEqual(["previous", "entering", "foreground"]);
    expect(inside[0]).toMatchObject({ trackId: "video-2", isTransitionTail: true });
    // The tail keeps its own time mapping past its out point; consumers clamp
    // the overshoot to the last frame: 1 + 2.5 * 2 = 6.
    expect(inside[0]?.sourceTimeSec).toBe(6);
    expect(inside[1]?.isTransitionTail).toBeUndefined();

    const outside = getDirectorTimelineActiveLayers(timeline, mediaById, 3.2);
    expect(outside.map((layer) => layer.clip.id)).toEqual(["entering", "foreground"]);
  });

  it("skips the transition tail unless the previous clip edge is within tolerance", () => {
    const timeline = tracks();
    timeline[1]!.clips = [
      clip("previous", media.id, 0, 1.99),
      { ...clip("entering", media.id, 2, 3), transitionInSec: 1 },
    ];
    const mediaById = new Map([[media.id, media]]);
    // A 10ms gap breaks adjacency, so only the entering clip renders.
    expect(getDirectorTimelineActiveLayers(timeline, mediaById, 2.5).map((layer) => layer.clip.id)).toEqual([
      "entering",
      "foreground",
    ]);

    timeline[1]!.clips[0] = clip("previous", media.id, 0, 1.9995);
    expect(getDirectorTimelineActiveLayers(timeline, mediaById, 2.5).map((layer) => layer.clip.id)).toEqual([
      "previous",
      "entering",
      "foreground",
    ]);
  });

  it("renders a clean still through the same compositor used by video export", async () => {
    const timeline = tracks();
    timeline[1]!.clips = [];
    const context2d = {
      fillRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      strokeText: vi.fn(),
      fillText: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
      scale: vi.fn(),
      fillStyle: "",
      strokeStyle: "",
      font: "",
      textAlign: "start",
      textBaseline: "alphabetic",
      lineWidth: 1,
      shadowColor: "",
      shadowBlur: 0,
    } as unknown as CanvasRenderingContext2D;
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => context2d),
      toDataURL: vi.fn(() => "data:image/png;base64,dGltZWxpbmU="),
    } as unknown as HTMLCanvasElement;
    const originalCreateElement = document.createElement.bind(document);
    const createElement = vi
      .spyOn(document, "createElement")
      .mockImplementation(((tagName: string, options?: ElementCreationOptions) =>
        tagName === "canvas" ? canvas : originalCreateElement(tagName, options)) as typeof document.createElement);
    try {
      const frame = await renderDirectorTimelineFrame({
        tracks: timeline,
        mediaItems: [],
        aspectRatio: "16 / 9",
        quality: "preview",
        timeSec: 2.5,
      });
      expect(frame).toEqual({
        dataUrl: "data:image/png;base64,dGltZWxpbmU=",
        width: 1_280,
        height: 720,
        timeSec: 2.5,
        activeClipIds: ["foreground"],
      });
      expect(context2d.fillText).toHaveBeenCalledWith("foreground", 0, 0, 1_280 * 0.82);
    } finally {
      createElement.mockRestore();
    }
  });
});
