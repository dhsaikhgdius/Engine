import JSZip from "jszip";
import { beforeEach, describe, expect, it } from "vitest";
import {
  setDirectorCreativeWorkspaceScope,
  useDirectorCreativeWorkspaceStore,
} from "../../../../src/comprehensive/editor/workspaces/directorWorkspaceStore";
import {
  applyDirectorCreativeOtioImport,
  exportDirectorCreativeTimelineToOtio,
  exportDirectorCreativeTimelineToOtioz,
  importDirectorCreativeTimelineFromOtio,
  importDirectorCreativeTimelineFromOtioz,
  serializeDirectorCreativeTimelineToOtio,
  type DirectorCreativeOtioSource,
} from "../../../../src/comprehensive/editor/interchange/creativeOtio";

const SOURCE: DirectorCreativeOtioSource = {
  editSettings: {
    aspectRatio: "16 / 9",
    fps: 24,
    timebase: {
      rate: { numerator: 24, denominator: 1 },
      dropFrame: false,
      startTimecode: "01:00:00:00",
    },
    snapEnabled: true,
    exportQuality: "full",
  },
  editTracks: [
    {
      id: "video-main",
      name: "Picture",
      kind: "video",
      muted: false,
      locked: true,
      visible: false,
      clips: [
        {
          id: "clip-picture-001",
          mediaId: "media-video-001",
          name: "Picture clip",
          startSec: 1,
          durationSec: 2,
          inSec: 0.5,
          sourceDurationSec: 10,
          playbackRate: 2,
          opacity: 0.75,
          volume: 0.8,
          fadeInSec: 0.25,
          fadeOutSec: 0.5,
          scale: 1.25,
          positionX: 32,
          positionY: -18,
          rotationDeg: 3,
          fit: "cover",
        },
        {
          id: "clip-overlap-002",
          mediaId: "media-offline-002",
          name: "Overlapping offline clip",
          startSec: 2,
          durationSec: 1,
          inSec: 0,
          sourceDurationSec: 3,
          playbackRate: 1,
          opacity: 1,
          volume: 1,
          fadeInSec: 0,
          fadeOutSec: 0,
          scale: 1,
          positionX: 0,
          positionY: 0,
          rotationDeg: 0,
          fit: "contain",
        },
      ],
    },
    {
      id: "audio-main",
      name: "Dialogue",
      kind: "audio",
      muted: true,
      locked: false,
      visible: true,
      clips: [
        {
          id: "clip-audio-001",
          mediaId: "media-audio-001",
          name: "Dialogue clip",
          startSec: 0.25,
          durationSec: 1.5,
          inSec: 1,
          sourceDurationSec: 6,
          playbackRate: 1,
          opacity: 1,
          volume: 0.6,
          fadeInSec: 0.1,
          fadeOutSec: 0.2,
          scale: 1,
          positionX: 0,
          positionY: 0,
          rotationDeg: 0,
          fit: "contain",
        },
      ],
    },
  ],
};

const MEDIA = [
  {
    id: "media-video-001",
    kind: "video" as const,
    collection: "imports" as const,
    name: "Source picture.mov",
    sourceUrl: "https://media.example/picture.mov",
    durationSec: 10,
    availability: "online" as const,
  },
  {
    id: "media-offline-002",
    kind: "video" as const,
    collection: "imports" as const,
    name: "Missing insert.mov",
    sourceUrl: null,
    durationSec: 3,
    availability: "offline" as const,
  },
  {
    id: "media-audio-001",
    kind: "audio" as const,
    collection: "imports" as const,
    name: "Dialogue.wav",
    sourceUrl: "https://media.example/dialogue.wav",
    durationSec: 6,
    availability: "online" as const,
  },
];

beforeEach(() => {
  setDirectorCreativeWorkspaceScope("creative-otio-tests");
  useDirectorCreativeWorkspaceStore.getState().resetCreativeWorkspaces();
});

describe("Video Editor OTIO interchange", () => {
  it("exports rational video/audio tracks, source trims, speed effects, flags, and media references", () => {
    const otio = exportDirectorCreativeTimelineToOtio(SOURCE, MEDIA) as Record<string, any>;
    expect(otio.global_start_time).toMatchObject({ value: 86_400, rate: 24 });
    expect(otio.metadata.director.editSettings.timebase.rate).toEqual({ numerator: 24, denominator: 1 });
    const tracks = otio.tracks.children as Array<Record<string, any>>;
    expect(tracks.map((track) => track.kind)).toEqual(["Video", "Video", "Audio"]);
    expect(tracks[0]!.metadata.director).toMatchObject({
      stableId: "video-main",
      muted: false,
      locked: true,
      visible: false,
    });
    const picture = tracks[0]!.children.find((item: Record<string, unknown>) => item.OTIO_SCHEMA === "Clip.2");
    expect(picture.source_range).toMatchObject({
      start_time: { value: 12, rate: 24 },
      duration: { value: 96, rate: 24 },
    });
    expect(picture.effects[0]).toMatchObject({ OTIO_SCHEMA: "LinearTimeWarp.1", time_scalar: 2 });
    expect(picture.media_reference).toMatchObject({
      OTIO_SCHEMA: "ExternalReference.1",
      target_url: "https://media.example/picture.mov",
    });
    expect(tracks[1]!.children.at(-1)?.metadata.director.stableId).toBe("clip-overlap-002");
  });

  it("round-trips all editor fields, merges overlap lanes, and leaves unavailable media explicit", () => {
    const imported = importDirectorCreativeTimelineFromOtio(serializeDirectorCreativeTimelineToOtio(SOURCE, MEDIA), {
      knownMediaIds: MEDIA.map((media) => media.id),
    });
    expect(imported.editSettings).toEqual(SOURCE.editSettings);
    expect(imported.editTracks).toHaveLength(2);
    expect(imported.editTracks[0]).toMatchObject({
      id: "video-main",
      name: "Picture",
      kind: "video",
      muted: false,
      locked: true,
      visible: false,
    });
    expect(imported.editTracks[0]!.clips).toEqual(SOURCE.editTracks[0]!.clips);
    expect(imported.editTracks[1]!.clips).toEqual(SOURCE.editTracks[1]!.clips);
    expect(imported.mediaReferences.find((media) => media.originalMediaId === "media-offline-002")).toMatchObject({
      offline: true,
      targetUrl: null,
    });
    expect(imported.warnings).toContain("Media Missing insert.mov is offline and requires relinking.");
    expect(imported.omitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "offline_media",
          subject: "Missing insert.mov",
        }),
      ]),
    );
  });

  it("stamps typed omitted records for track limits, unsupported items, and invalid ranges", () => {
    const tracks = Array.from({ length: 14 }, (_, index) => ({
      OTIO_SCHEMA: "Track.1",
      name: `V${index + 1}`,
      kind: "Video",
      metadata: {},
      children: [
        {
          OTIO_SCHEMA: "Transition.1",
          name: "Wipe",
          source_range: {
            OTIO_SCHEMA: "TimeRange.1",
            start_time: { OTIO_SCHEMA: "RationalTime.1", value: 0, rate: 24 },
            duration: { OTIO_SCHEMA: "RationalTime.1", value: 12, rate: 24 },
          },
          metadata: {},
        },
        {
          OTIO_SCHEMA: "Clip.2",
          name: "Bare",
          metadata: {},
        },
      ],
    }));
    const imported = importDirectorCreativeTimelineFromOtio({
      OTIO_SCHEMA: "Timeline.1",
      name: "Limits",
      global_start_time: { OTIO_SCHEMA: "RationalTime.1", value: 0, rate: 24 },
      metadata: {},
      tracks: {
        OTIO_SCHEMA: "Stack.1",
        name: "Tracks",
        metadata: {},
        children: tracks,
      },
    });
    expect(imported.omitted.some((entry) => entry.code === "track_limit")).toBe(true);
    expect(imported.omitted.some((entry) => entry.code === "unsupported_as_gap")).toBe(true);
    expect(imported.omitted.some((entry) => entry.code === "invalid_source_range")).toBe(true);
    expect(imported.omitted.length).toBe(imported.warnings.filter((warning) => !warning.includes("remapped")).length);
  });

  it("preserves an unknown external media URL in an offline virtual ID for later re-export", () => {
    const external = {
      OTIO_SCHEMA: "Timeline.1",
      name: "External",
      global_start_time: { OTIO_SCHEMA: "RationalTime.1", value: 0, rate: 24 },
      metadata: {},
      tracks: {
        OTIO_SCHEMA: "Stack.1",
        name: "Tracks",
        metadata: {},
        children: [
          {
            OTIO_SCHEMA: "Track.1",
            name: "V1",
            kind: "Video",
            metadata: {},
            children: [
              {
                OTIO_SCHEMA: "Clip.2",
                name: "Remote",
                source_range: {
                  OTIO_SCHEMA: "TimeRange.1",
                  start_time: { OTIO_SCHEMA: "RationalTime.1", value: 24, rate: 24 },
                  duration: { OTIO_SCHEMA: "RationalTime.1", value: 48, rate: 24 },
                },
                media_reference: {
                  OTIO_SCHEMA: "ExternalReference.1",
                  name: "Remote.mov",
                  target_url: "file:///Volumes/Offline/Remote.mov",
                  metadata: {},
                },
                metadata: {},
              },
            ],
          },
        ],
      },
    };
    const imported = importDirectorCreativeTimelineFromOtio(external);
    expect(imported.editTracks[0]!.clips[0]!.mediaId).toMatch(/^otio-offline:/);
    expect(imported.mediaReferences[0]).toMatchObject({
      targetUrl: "file:///Volumes/Offline/Remote.mov",
      offline: true,
    });
    const reexported = exportDirectorCreativeTimelineToOtio(imported) as Record<string, any>;
    const clip = reexported.tracks.children[0].children[0];
    expect(clip.media_reference.target_url).toBe("file:///Volumes/Offline/Remote.mov");
  });

  it("round-trips OTIOZ, rejects traversal, and atomically replaces only the edit projection", async () => {
    const archive = await exportDirectorCreativeTimelineToOtioz(SOURCE, MEDIA);
    const zip = await JSZip.loadAsync(archive);
    expect(Object.keys(zip.files)).toEqual(expect.arrayContaining(["content.otio", "version.txt"]));
    const imported = await importDirectorCreativeTimelineFromOtioz(archive, {
      knownMediaIds: MEDIA.map((media) => media.id),
    });

    const store = useDirectorCreativeWorkspaceStore.getState();
    const originalBoardNodeIds = store.boardNodes.map((node) => node.id);
    expect(applyDirectorCreativeOtioImport(imported)).toBe(true);
    const next = useDirectorCreativeWorkspaceStore.getState();
    expect(next.mode).toBe("video");
    expect(next.editTracks.map((track) => track.id)).toEqual(["video-main", "audio-main"]);
    expect(next.boardNodes.map((node) => node.id)).toEqual(originalBoardNodeIds);
    expect(next.canUndo).toBe(false);

    const malicious = new JSZip();
    malicious.file("../content.otio", "{}", { compression: "STORE" });
    await expect(
      importDirectorCreativeTimelineFromOtioz(await malicious.generateAsync({ type: "uint8array" })),
    ).rejects.toThrow(/Unsafe OTIOZ entry path/);
  });
});
