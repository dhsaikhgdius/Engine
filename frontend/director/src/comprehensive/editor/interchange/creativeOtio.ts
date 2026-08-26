import { isRecord } from "../../../../../../packages/protocol/src/primitives";
import {
  frameRateToNumber,
  normalizeDirectorFrameRate,
  normalizeDirectorTimebase,
  type DirectorTimelineTimebase,
} from "../timeline/frameRate";
import { formatSmpteTimecode, parseSmpteTimecode } from "../timeline/timecode";
import type { DirectorMediaCollection, DirectorMediaItem, DirectorMediaKind } from "../workspaces/directorMediaLibrary";
import {
  serializeDirectorCreativeWorkspacePersistedState,
  useDirectorCreativeWorkspaceStore,
  type DirectorEditClip,
  type DirectorEditSettings,
  type DirectorEditTrack,
} from "../workspaces/directorWorkspaceStore";
import { DIRECTOR_INTERCHANGE_CONTRACT, stableDirectorInterchangeId } from "./contract";
import {
  createDirectorOtiozArchive,
  metadataFor,
  parseOtioSource as parseJson,
  rationalTime,
  readDirectorOtiozContent,
  schemaName,
  timeRange,
} from "./otio";

export const DIRECTOR_CREATIVE_OTIO_ADAPTER = "director-creative-otio-v1" as const;

/** A media source that can be referenced from an OTIO clip in the Creative workspace. */
export interface DirectorCreativeOtioMediaSource {
  /** Stable identifier matching the media in Director's media library. */
  id: string;
  /** Media kind; `"text"` is a Director-specific extension for subtitle tracks. */
  kind?: DirectorMediaKind | "text";
  /** The media library collection this item belongs to. */
  collection?: DirectorMediaCollection;
  /** Display name. */
  name?: string;
  /** The absolute or relative URL to the media asset. */
  sourceUrl?: string | null;
  /** Duration in seconds, when known ahead of export. */
  durationSec?: number;
  /** Whether the media is available at export time. */
  availability?: "online" | "offline" | "unverified";
}

/** A resolved media reference that carries both the source identity and its availability status. */
export interface DirectorCreativeOtioMediaReference extends DirectorCreativeOtioMediaSource {
  /** The resolved URL used in the OTIO external reference. */
  targetUrl: string | null;
  /** Whether the media is offline and requires relinking on import. */
  offline: boolean;
  /** The original media ID before any relinking or offline encoding. */
  originalMediaId: string | null;
}

/** The Creative workspace state to export. */
export interface DirectorCreativeOtioSource {
  /** The edit tracks with their clip arrangements. */
  editTracks: readonly DirectorEditTrack[];
  /** Shared edit settings (fps, aspect ratio, etc.). */
  editSettings: DirectorEditSettings;
}

/** Options controlling how media identities are resolved during import. */
export interface DirectorCreativeOtioImportOptions {
  /** Media IDs that are known to exist in the current session; others become offline. */
  knownMediaIds?: Iterable<string>;
}

/**
 * Structured warn-and-omit codes for Creative OTIO import. Agents read these
 * instead of scraping free-text `warnings[]`. Duplicate stable-ID remaps stay
 * warnings only (nothing was dropped).
 */
export const DIRECTOR_CREATIVE_OTIO_OMITTED_CODES = [
  "track_limit",
  "invalid_source_range",
  "unsupported_as_gap",
  "clip_limit",
  "offline_media",
] as const;

/** One Creative OTIO omit code. */
export type DirectorCreativeOtioOmittedCode = (typeof DIRECTOR_CREATIVE_OTIO_OMITTED_CODES)[number];

/** One typed Creative OTIO import omission. */
export interface DirectorCreativeOtioOmitted {
  code: DirectorCreativeOtioOmittedCode;
  /** Track name, media name, or other human-readable subject. */
  subject: string;
  reason: string;
}

/** The result of importing a Creative OTIO timeline. */
export interface DirectorCreativeOtioImportResult {
  /** The reconstructed edit tracks. */
  editTracks: DirectorEditTrack[];
  /** The reconstructed edit settings. */
  editSettings: DirectorEditSettings;
  /** All media references discovered during import, including offline ones. */
  mediaReferences: DirectorCreativeOtioMediaReference[];
  /** Non-fatal diagnostic messages (kept for older UIs / free-text scrapers). */
  warnings: string[];
  /**
   * Typed omit records for Agent/UI honesty. Length matches the skip events
   * that could not be carried as Director edit clips / online media.
   */
  omitted: DirectorCreativeOtioOmitted[];
  /** The timeline name from the OTIO document. */
  name: string;
}

interface CreativeTimelineMetadata {
  adapter: typeof DIRECTOR_CREATIVE_OTIO_ADAPTER;
  contract: typeof DIRECTOR_INTERCHANGE_CONTRACT;
  editSettings: DirectorEditSettings;
}

interface OfflineMediaPayload {
  version: 1;
  originalMediaId: string | null;
  targetUrl: string | null;
  kind: DirectorCreativeOtioMediaSource["kind"];
  collection?: DirectorMediaCollection;
  name: string;
  durationSec: number;
}

const OFFLINE_MEDIA_PREFIX = "otio-offline:";
const MAX_TRACKS = 12;
const MAX_CLIPS_PER_TRACK = 400;

function secondsToFrames(seconds: number, rate: number) {
  return Math.max(0, Math.round((Number.isFinite(seconds) ? seconds : 0) * rate));
}

function rationalSeconds(value: unknown, fallbackRate: number) {
  if (!isRecord(value) || typeof value.value !== "number" || !Number.isFinite(value.value)) return null;
  const rate =
    typeof value.rate === "number" && Number.isFinite(value.rate) && value.rate > 0 ? value.rate : fallbackRate;
  return value.value / rate;
}

function rangeParts(value: unknown, fallbackRate: number) {
  if (!isRecord(value)) return null;
  const startSec = rationalSeconds(value.start_time, fallbackRate) ?? 0;
  const durationSec = rationalSeconds(value.duration, fallbackRate);
  return durationSec === null ? null : { startSec, durationSec: Math.max(0, durationSec) };
}

function encodeOfflineMedia(payload: OfflineMediaPayload) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return `${OFFLINE_MEDIA_PREFIX}${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

function decodeOfflineMedia(mediaId: string): OfflineMediaPayload | null {
  if (!mediaId.startsWith(OFFLINE_MEDIA_PREFIX)) return null;
  try {
    const encoded = mediaId.slice(OFFLINE_MEDIA_PREFIX.length).replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "="));
    const value = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0))),
    ) as unknown;
    if (!isRecord(value) || value.version !== 1 || typeof value.name !== "string") return null;
    return value as unknown as OfflineMediaPayload;
  } catch {
    return null;
  }
}

function clipLanes(clips: readonly DirectorEditClip[], rate: number) {
  const lanes: Array<{ endFrame: number; clips: DirectorEditClip[] }> = [];
  [...clips]
    .sort((left, right) => left.startSec - right.startSec || left.id.localeCompare(right.id))
    .forEach((clip) => {
      const startFrame = secondsToFrames(clip.startSec, rate);
      const lane = lanes.find((candidate) => candidate.endFrame <= startFrame);
      const endFrame = startFrame + Math.max(1, secondsToFrames(clip.durationSec, rate));
      if (lane) {
        lane.clips.push(clip);
        lane.endFrame = endFrame;
      } else {
        lanes.push({ endFrame, clips: [clip] });
      }
    });
  return lanes.length ? lanes : [{ endFrame: 0, clips: [] }];
}

function mediaReference(
  clip: DirectorEditClip,
  mediaById: ReadonlyMap<string, DirectorCreativeOtioMediaSource>,
  rate: number,
) {
  const media = mediaById.get(clip.mediaId);
  const offlinePayload = media ? null : decodeOfflineMedia(clip.mediaId);
  const sourceUrl = media?.sourceUrl ?? offlinePayload?.targetUrl ?? null;
  const kind = media?.kind ?? offlinePayload?.kind ?? (clip.mediaId.startsWith("text:") ? "text" : undefined);
  const name = media?.name ?? offlinePayload?.name ?? clip.name;
  const durationSec = Math.max(clip.sourceDurationSec, media?.durationSec ?? offlinePayload?.durationSec ?? 0.1);
  const offline = media?.availability === "offline" || (!media && !offlinePayload) || !sourceUrl;
  const director = {
    mediaId: clip.mediaId,
    originalMediaId: offlinePayload?.originalMediaId ?? clip.mediaId,
    kind: kind ?? null,
    collection: media?.collection ?? offlinePayload?.collection ?? null,
    name,
    sourceUrl,
    durationSec,
    offline,
  };
  if (!sourceUrl) {
    return {
      OTIO_SCHEMA: "MissingReference.1",
      name,
      metadata: { director },
    };
  }
  return {
    OTIO_SCHEMA: "ExternalReference.1",
    name,
    target_url: sourceUrl,
    available_range: timeRange(0, Math.max(1, secondsToFrames(durationSec, rate)), rate),
    metadata: { director },
  };
}

/**
 * Exports the Creative workspace edit data as an OTIO timeline object.
 *
 * Overlapping clips are split into separate lanes per track. Media references
 * that are offline or unknown are encoded as self-describing `MissingReference`
 * entries so the timeline can be shared without its media files.
 *
 * @param source - The Creative workspace state to export.
 * @param mediaSources - Known media sources to resolve against.
 * @returns An OTIO Timeline JSON object.
 */
export function exportDirectorCreativeTimelineToOtio(
  source: DirectorCreativeOtioSource,
  mediaSources: Iterable<DirectorCreativeOtioMediaSource> = [],
) {
  const timebase = normalizeDirectorTimebase(source.editSettings.timebase, source.editSettings.fps);
  const rate = frameRateToNumber(timebase.rate);
  const mediaById = new Map([...mediaSources].map((media) => [media.id, media]));
  const globalStart =
    parseSmpteTimecode(timebase.startTimecode, timebase.rate, { dropFrame: timebase.dropFrame })?.frame ?? 0;
  const trackChildren: Array<Record<string, unknown>> = [];

  source.editTracks.forEach((track, trackIndex) => {
    clipLanes(track.clips, rate).forEach((lane, laneIndex) => {
      const children: Array<Record<string, unknown>> = [];
      let cursorFrame = 0;
      lane.clips.forEach((clip) => {
        const startFrame = secondsToFrames(clip.startSec, rate);
        const timelineDurationFrames = Math.max(1, secondsToFrames(clip.durationSec, rate));
        const sourceInFrames = secondsToFrames(clip.inSec, rate);
        const sourceConsumedFrames = Math.max(1, secondsToFrames(clip.durationSec * clip.playbackRate, rate));
        if (startFrame > cursorFrame) {
          children.push({
            OTIO_SCHEMA: "Gap.1",
            name: "Gap",
            source_range: timeRange(0, startFrame - cursorFrame, rate),
            metadata: {},
          });
        }
        children.push({
          OTIO_SCHEMA: "Clip.2",
          name: clip.name,
          source_range: timeRange(sourceInFrames, sourceConsumedFrames, rate),
          media_reference: mediaReference(clip, mediaById, rate),
          effects:
            clip.playbackRate === 1
              ? []
              : [
                  {
                    OTIO_SCHEMA: "LinearTimeWarp.1",
                    name: `${clip.playbackRate}x`,
                    effect_name: "Time Remap",
                    time_scalar: clip.playbackRate,
                    metadata: { director: { playbackRate: clip.playbackRate } },
                  },
                ],
          metadata: {
            director: {
              adapter: DIRECTOR_CREATIVE_OTIO_ADAPTER,
              contract: DIRECTOR_INTERCHANGE_CONTRACT,
              stableId: clip.id,
              mediaId: clip.mediaId,
              timelineStart: rationalTime(startFrame, rate),
              timelineDuration: rationalTime(timelineDurationFrames, rate),
              sourceDuration: rationalTime(Math.max(1, secondsToFrames(clip.sourceDurationSec, rate)), rate),
              playbackRate: clip.playbackRate,
              opacity: clip.opacity,
              volume: clip.volume,
              fadeInSec: clip.fadeInSec,
              fadeOutSec: clip.fadeOutSec,
              scale: clip.scale,
              positionX: clip.positionX,
              positionY: clip.positionY,
              rotationDeg: clip.rotationDeg,
              fit: clip.fit,
            },
          },
        });
        cursorFrame = startFrame + timelineDurationFrames;
      });
      trackChildren.push({
        OTIO_SCHEMA: "Track.1",
        name: laneIndex ? `${track.name} · overlap ${laneIndex + 1}` : track.name,
        kind: track.kind === "audio" ? "Audio" : "Video",
        children,
        metadata: {
          director: {
            adapter: DIRECTOR_CREATIVE_OTIO_ADAPTER,
            contract: DIRECTOR_INTERCHANGE_CONTRACT,
            stableId: track.id,
            sourceTrackIndex: trackIndex,
            laneIndex,
            muted: track.muted,
            locked: track.locked,
            visible: track.visible,
            name: track.name,
          },
        },
      });
    });
  });

  const metadata: CreativeTimelineMetadata = {
    adapter: DIRECTOR_CREATIVE_OTIO_ADAPTER,
    contract: DIRECTOR_INTERCHANGE_CONTRACT,
    editSettings: {
      ...source.editSettings,
      fps: rate,
      timebase,
    },
  };
  return {
    OTIO_SCHEMA: "Timeline.1",
    name: "Director Video Editor",
    global_start_time: rationalTime(globalStart, rate),
    metadata: { director: metadata },
    tracks: {
      OTIO_SCHEMA: "Stack.1",
      name: "Director edit tracks",
      metadata: {},
      children: trackChildren,
    },
  };
}

/**
 * Serializes the Creative workspace to an OTIO JSON string.
 *
 * @param source - The Creative workspace state to export.
 * @param mediaSources - Known media sources to resolve against.
 * @param pretty - Whether to pretty-print the JSON (default true).
 * @returns A formatted OTIO JSON string.
 */
export function serializeDirectorCreativeTimelineToOtio(
  source: DirectorCreativeOtioSource,
  mediaSources: Iterable<DirectorCreativeOtioMediaSource> = [],
  pretty = true,
) {
  return `${JSON.stringify(exportDirectorCreativeTimelineToOtio(source, mediaSources), null, pretty ? 2 : undefined)}\n`;
}

function collectTracks(value: unknown): Array<Record<string, unknown>> {
  if (!isRecord(value)) return [];
  if (schemaName(value) === "Track") return [value];
  return (Array.isArray(value.children) ? value.children : []).flatMap(collectTracks);
}

function timeWarp(item: Record<string, unknown>, metadata: Record<string, unknown> | null) {
  if (
    typeof metadata?.playbackRate === "number" &&
    Number.isFinite(metadata.playbackRate) &&
    metadata.playbackRate > 0
  ) {
    return metadata.playbackRate;
  }
  const effect = (Array.isArray(item.effects) ? item.effects : []).find(
    (candidate) => isRecord(candidate) && schemaName(candidate) === "LinearTimeWarp",
  );
  return isRecord(effect) && typeof effect.time_scalar === "number" && effect.time_scalar > 0 ? effect.time_scalar : 1;
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number) {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}

function mediaFromClip(
  item: Record<string, unknown>,
  clipMetadata: Record<string, unknown> | null,
  knownMediaIds: ReadonlySet<string>,
  sourceDurationSec: number,
) {
  const reference = isRecord(item.media_reference) ? item.media_reference : {};
  const referenceMetadata = metadataFor(reference);
  const targetUrl = typeof reference.target_url === "string" ? reference.target_url : null;
  const declaredId =
    typeof clipMetadata?.mediaId === "string"
      ? clipMetadata.mediaId
      : typeof referenceMetadata?.mediaId === "string"
        ? referenceMetadata.mediaId
        : null;
  const originalMediaId =
    typeof referenceMetadata?.originalMediaId === "string" ? referenceMetadata.originalMediaId : declaredId;
  const kind =
    referenceMetadata?.kind === "image" ||
    referenceMetadata?.kind === "video" ||
    referenceMetadata?.kind === "audio" ||
    referenceMetadata?.kind === "shot" ||
    referenceMetadata?.kind === "text"
      ? referenceMetadata.kind
      : undefined;
  const collection =
    referenceMetadata?.collection === "shots" ||
    referenceMetadata?.collection === "captures" ||
    referenceMetadata?.collection === "recordings" ||
    referenceMetadata?.collection === "references" ||
    referenceMetadata?.collection === "imports"
      ? referenceMetadata.collection
      : undefined;
  const name =
    typeof referenceMetadata?.name === "string"
      ? referenceMetadata.name
      : typeof reference.name === "string"
        ? reference.name
        : typeof item.name === "string"
          ? item.name
          : "Offline media";
  const explicitlyMissing = schemaName(reference) === "MissingReference" || referenceMetadata?.offline === true;
  const locallyKnown = declaredId ? knownMediaIds.has(declaredId) : false;
  const offline = explicitlyMissing || !locallyKnown;
  const payload: OfflineMediaPayload = {
    version: 1,
    originalMediaId,
    targetUrl,
    kind,
    collection,
    name,
    durationSec: Math.max(0.1, sourceDurationSec),
  };
  const mediaId = declaredId && locallyKnown ? declaredId : encodeOfflineMedia(payload);
  return {
    mediaId,
    reference: {
      id: mediaId,
      kind,
      collection,
      name,
      sourceUrl: targetUrl,
      durationSec: payload.durationSec,
      availability: offline ? ("offline" as const) : ("online" as const),
      targetUrl,
      offline,
      originalMediaId,
    } satisfies DirectorCreativeOtioMediaReference,
  };
}

/**
 * Imports a Creative OTIO timeline and reconstructs the edit tracks and settings.
 *
 * Supports full Director round-trip metadata as well as generic OTIO timelines
 * from other tools. Media that is not in the known set is encoded as offline
 * and must be relinked before playback.
 *
 * @param source - An OTIO JSON string or pre-parsed object.
 * @param options - Import options including known media IDs.
 * @returns The reconstructed edit tracks, settings, media references, and warnings.
 */
export function importDirectorCreativeTimelineFromOtio(
  source: string | unknown,
  options: DirectorCreativeOtioImportOptions = {},
): DirectorCreativeOtioImportResult {
  const root = parseJson(source);
  if (!isRecord(root) || schemaName(root) !== "Timeline" || !isRecord(root.tracks)) {
    throw new Error("OTIO root must be an OpenTimelineIO Timeline with a tracks Stack");
  }
  const warnings: string[] = [];
  const omitted: DirectorCreativeOtioOmitted[] = [];
  const pushOmit = (code: DirectorCreativeOtioOmittedCode, subject: string, reason: string) => {
    omitted.push({ code, subject, reason });
    warnings.push(reason);
  };
  const rootMetadata = metadataFor(root);
  const embeddedSettings = isRecord(rootMetadata?.editSettings) ? rootMetadata.editSettings : null;
  const embeddedTimebase = isRecord(embeddedSettings?.timebase) ? embeddedSettings.timebase : null;
  const embeddedRate = isRecord(embeddedTimebase?.rate) ? embeddedTimebase.rate : null;
  const rate = normalizeDirectorFrameRate(
    embeddedRate && typeof embeddedRate.numerator === "number" && typeof embeddedRate.denominator === "number"
      ? { numerator: embeddedRate.numerator, denominator: embeddedRate.denominator }
      : isRecord(root.global_start_time) && typeof root.global_start_time.rate === "number"
        ? root.global_start_time.rate
        : 24,
  );
  const rateNumber = frameRateToNumber(rate);
  const dropFrame = embeddedTimebase?.dropFrame === true;
  const globalStart = rationalSeconds(root.global_start_time, rateNumber) ?? 0;
  const startTimecode =
    typeof embeddedTimebase?.startTimecode === "string"
      ? embeddedTimebase.startTimecode
      : formatSmpteTimecode(secondsToFrames(globalStart, rateNumber), rate, { dropFrame });
  const timebase: DirectorTimelineTimebase = normalizeDirectorTimebase({ rate, dropFrame, startTimecode }, rate);
  const editSettings: DirectorEditSettings = {
    aspectRatio:
      embeddedSettings?.aspectRatio === "9 / 16" || embeddedSettings?.aspectRatio === "1 / 1"
        ? embeddedSettings.aspectRatio
        : "16 / 9",
    fps: rateNumber,
    timebase,
    snapEnabled: typeof embeddedSettings?.snapEnabled === "boolean" ? embeddedSettings.snapEnabled : true,
    exportQuality: embeddedSettings?.exportQuality === "full" ? "full" : "preview",
  };
  const knownMediaIds = new Set(options.knownMediaIds ?? []);
  const trackGroups = new Map<string, { track: DirectorEditTrack; sourceTrackIndex: number; clipIds: Set<string> }>();
  const mediaReferences = new Map<string, DirectorCreativeOtioMediaReference>();

  collectTracks(root.tracks)
    .slice(0, MAX_TRACKS * 8)
    .forEach((rawTrack, rawTrackIndex) => {
      const trackMetadata = metadataFor(rawTrack);
      const directorLane =
        trackMetadata?.adapter === DIRECTOR_CREATIVE_OTIO_ADAPTER &&
        trackMetadata.contract === DIRECTOR_INTERCHANGE_CONTRACT &&
        typeof trackMetadata.stableId === "string";
      const kind: DirectorEditTrack["kind"] = rawTrack.kind === "Audio" ? "audio" : "video";
      const groupId = directorLane
        ? String(trackMetadata.stableId)
        : stableDirectorInterchangeId("edit-track", `${rawTrackIndex}:${String(rawTrack.name ?? kind)}`);
      let group = trackGroups.get(groupId);
      if (!group) {
        if (trackGroups.size >= MAX_TRACKS) {
          const trackSubject = String(rawTrack.name ?? rawTrackIndex + 1);
          pushOmit(
            "track_limit",
            trackSubject,
            `Track ${trackSubject} was skipped because Director supports ${MAX_TRACKS} tracks.`,
          );
          return;
        }
        group = {
          sourceTrackIndex:
            typeof trackMetadata?.sourceTrackIndex === "number" ? trackMetadata.sourceTrackIndex : rawTrackIndex,
          clipIds: new Set(),
          track: {
            id: groupId,
            name:
              typeof trackMetadata?.name === "string"
                ? trackMetadata.name
                : typeof rawTrack.name === "string"
                  ? rawTrack.name
                  : kind === "audio"
                    ? `Audio ${rawTrackIndex + 1}`
                    : `Video ${rawTrackIndex + 1}`,
            kind,
            muted: trackMetadata?.muted === true,
            locked: trackMetadata?.locked === true,
            visible: trackMetadata?.visible !== false,
            clips: [],
          },
        };
        trackGroups.set(groupId, group);
      }
      let cursorFrame = 0;
      (Array.isArray(rawTrack.children) ? rawTrack.children : []).forEach((rawItem, itemIndex) => {
        if (!isRecord(rawItem)) return;
        const range = rangeParts(rawItem.source_range, rateNumber);
        if (!range) {
          pushOmit(
            "invalid_source_range",
            group!.track.name,
            `Track ${group!.track.name} item ${itemIndex + 1} has no valid source range and was skipped.`,
          );
          return;
        }
        const itemSchema = schemaName(rawItem);
        if (itemSchema === "Gap") {
          cursorFrame += secondsToFrames(range.durationSec, rateNumber);
          return;
        }
        if (itemSchema !== "Clip") {
          pushOmit(
            "unsupported_as_gap",
            group!.track.name,
            `Unsupported OTIO ${itemSchema || "item"} on ${group!.track.name} was treated as a gap.`,
          );
          cursorFrame += secondsToFrames(range.durationSec, rateNumber);
          return;
        }
        if (group!.track.clips.length >= MAX_CLIPS_PER_TRACK) {
          pushOmit(
            "clip_limit",
            group!.track.name,
            `${group!.track.name} exceeds Director's ${MAX_CLIPS_PER_TRACK}-clip limit; remaining clips were skipped.`,
          );
          return;
        }
        const clipMetadata = metadataFor(rawItem);
        const speed = boundedNumber(timeWarp(rawItem, clipMetadata), 1, 0.25, 4);
        const sourceDurationSec = Math.min(
          3_600,
          Math.max(
            range.startSec + range.durationSec,
            rationalSeconds(clipMetadata?.sourceDuration, rateNumber) ?? 0,
            0.1,
          ),
        );
        const inSec = Math.min(Math.max(0, range.startSec), Math.max(0, sourceDurationSec - 0.1));
        const timelineDurationSec = Math.min(
          3_600,
          Math.max(0.1, Math.min(range.durationSec / speed, (sourceDurationSec - inSec) / speed)),
        );
        let id =
          typeof clipMetadata?.stableId === "string" && clipMetadata.stableId
            ? clipMetadata.stableId
            : stableDirectorInterchangeId("edit-clip", `${groupId}:${itemIndex}:${String(rawItem.name ?? "clip")}`);
        if (group!.clipIds.has(id)) {
          const duplicate = id;
          id = stableDirectorInterchangeId("edit-clip", `${duplicate}:${rawTrackIndex}:${itemIndex}`);
          warnings.push(`Duplicate clip stable ID ${duplicate} was remapped to ${id}.`);
        }
        group!.clipIds.add(id);
        const media = mediaFromClip(rawItem, clipMetadata, knownMediaIds, sourceDurationSec);
        mediaReferences.set(media.reference.id, media.reference);
        const clip: DirectorEditClip = {
          id,
          mediaId: media.mediaId,
          name: typeof rawItem.name === "string" && rawItem.name.trim() ? rawItem.name.trim() : `Clip ${itemIndex + 1}`,
          startSec: cursorFrame / rateNumber,
          durationSec: timelineDurationSec,
          inSec,
          sourceDurationSec,
          playbackRate: speed,
          opacity: boundedNumber(clipMetadata?.opacity, 1, 0, 1),
          volume: boundedNumber(clipMetadata?.volume, 1, 0, 1),
          fadeInSec: boundedNumber(clipMetadata?.fadeInSec, 0, 0, timelineDurationSec),
          fadeOutSec: boundedNumber(clipMetadata?.fadeOutSec, 0, 0, timelineDurationSec),
          scale: boundedNumber(clipMetadata?.scale, 1, 0.05, 20),
          positionX: boundedNumber(clipMetadata?.positionX, 0, -7_680, 7_680),
          positionY: boundedNumber(clipMetadata?.positionY, 0, -7_680, 7_680),
          rotationDeg: boundedNumber(clipMetadata?.rotationDeg, 0, -3600, 3600),
          fit: clipMetadata?.fit === "cover" ? "cover" : "contain",
        };
        group!.track.clips.push(clip);
        cursorFrame += Math.max(1, secondsToFrames(timelineDurationSec, rateNumber));
      });
    });

  const editTracks = [...trackGroups.values()]
    .sort((left, right) => left.sourceTrackIndex - right.sourceTrackIndex)
    .map(({ track }) => ({
      ...track,
      clips: track.clips.sort((left, right) => left.startSec - right.startSec || left.id.localeCompare(right.id)),
    }));
  if (!editTracks.some((track) => track.kind === "video")) {
    editTracks.unshift({
      id: "video-1",
      name: "Video 1",
      kind: "video",
      muted: false,
      locked: false,
      visible: true,
      clips: [],
    });
  }
  mediaReferences.forEach((reference) => {
    if (reference.offline) {
      const subject = reference.name ?? reference.originalMediaId ?? reference.id;
      pushOmit("offline_media", subject, `Media ${subject} is offline and requires relinking.`);
    }
  });
  return {
    editTracks,
    editSettings,
    mediaReferences: [...mediaReferences.values()],
    warnings,
    omitted,
    name: typeof root.name === "string" && root.name.trim() ? root.name.trim() : "Imported OTIO timeline",
  };
}

/**
 * Applies an imported Creative OTIO result directly to the workspace store.
 *
 * This is the convenience entry point for the UI: it serializes the store
 * state with the imported tracks and settings, then reloads the workspace.
 *
 * @param result - The import result from {@link importDirectorCreativeTimelineFromOtio}.
 */
export function applyDirectorCreativeOtioImport(result: DirectorCreativeOtioImportResult) {
  const store = useDirectorCreativeWorkspaceStore.getState();
  const serialized = serializeDirectorCreativeWorkspacePersistedState({
    ...store,
    mode: "video",
    editTracks: result.editTracks,
    editSettings: result.editSettings,
    playheadSec: 0,
  });
  return store.loadCreativeWorkspace(serialized);
}

/**
 * Exports the Creative workspace to an OTIOZ (zipped OTIO) archive.
 *
 * @param source - The Creative workspace state to export.
 * @param mediaSources - Known media sources to resolve against.
 * @returns The OTIOZ archive bytes.
 */
export async function exportDirectorCreativeTimelineToOtioz(
  source: DirectorCreativeOtioSource,
  mediaSources: Iterable<DirectorCreativeOtioMediaSource> = [],
) {
  return createDirectorOtiozArchive(serializeDirectorCreativeTimelineToOtio(source, mediaSources));
}

/**
 * Imports a Creative OTIOZ (zipped OTIO) archive.
 *
 * Reads the `content.otio` entry from the archive and delegates to
 * {@link importDirectorCreativeTimelineFromOtio}.
 *
 * @param source - The OTIOZ archive bytes.
 * @param options - Import options.
 * @returns The import result.
 */
export async function importDirectorCreativeTimelineFromOtioz(
  source: Uint8Array | ArrayBuffer | Blob,
  options: DirectorCreativeOtioImportOptions = {},
) {
  return importDirectorCreativeTimelineFromOtio(await readDirectorOtiozContent(source), options);
}

export type { DirectorMediaItem };
