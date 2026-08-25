import { useEffect, useMemo, useState } from "react";
import { useDirectorStore } from "../store/directorStore";
import type { DirectorStoryboardShot } from "../schema/directorProject";
import { getStoryboardShotDuration } from "../storyboard/directorStoryboard";
import { useVideoRecordingStore } from "../video/videoRecordingStore";
import { useLanguage } from "../../i18n/language";
import { probeCreativeMediaFile } from "../media/creativeMediaProbe";
import type { DirectorEmbeddedMediaMetadata } from "../media/pngMetadata";
import type { DirectorMediaTranscript } from "../../../../../../packages/protocol/src/mediaTranscriptionProtocol";
import {
  probeCreativeMediaAvailability,
  selectCreativeMediaPlaybackSource,
  type CreativeMediaAvailability,
  type CreativeMediaPlaybackPreference,
  type CreativeMediaPlaybackSelection,
  type CreativeMediaWaveformData,
} from "../media/creativeMediaEngineering";
import {
  persistentCreativeMediaLibrary,
  type CreativeMediaAsset,
  type PersistentCreativeMediaLibrary,
  usePersistentCreativeMediaAssets,
} from "../media/persistentCreativeMediaStore";
import { useDirectorCreativeWorkspaceStore } from "./directorWorkspaceStore";

/** The coarse media type used for routing to the correct viewer and editor. */
export type DirectorMediaKind = "image" | "video" | "audio" | "shot";

/** The logical collection a media item belongs to, used for grouping in the library. */
export type DirectorMediaCollection = "shots" | "captures" | "recordings" | "references" | "imports";

/** A unified media item surfaced in the director media library. */
export interface DirectorMediaItem {
  /** Stable unique identifier. */
  id: string;
  /** Coarse media type. */
  kind: DirectorMediaKind;
  /** Logical collection the item belongs to. */
  collection: DirectorMediaCollection;
  /** Primary display name. */
  name: string;
  /** Descriptive subtitle shown below the name. */
  subtitle: string;
  /** Thumbnail URL, or null when unavailable. */
  thumbnailUrl: string | null;
  /** Playback source URL, or null when offline. */
  sourceUrl: string | null;
  /** Duration in seconds. */
  durationSec: number;
  /** Associated camera id, or null for non-camera sources. */
  cameraId: string | null;
  /** Start frame number, or null when not applicable. */
  frameStart: number | null;
  /** End frame number, or null when not applicable. */
  frameEnd: number | null;
  /** Whether the source is online, offline, or not yet verified. */
  availability?: CreativeMediaAvailability;
  /** Waveform data for audio-capable media, or null. */
  waveform?: CreativeMediaWaveformData | null;
  /** The selected playback variant (original, proxy, or unavailable). */
  playbackSource?: CreativeMediaPlaybackSelection;
  /** The original source URL before proxy substitution. */
  originalSourceUrl?: string | null;
  /** The proxy source URL, or null when no proxy is attached. */
  proxySourceUrl?: string | null;
  /** The user's playback preference for this media. */
  playbackPreference?: CreativeMediaPlaybackPreference;
  /** ISO 8601 creation timestamp, or null when unknown. */
  createdAt?: string | null;
  /** Original file name, or null when unknown. */
  fileName?: string | null;
  /** MIME type, or null when unknown. */
  mimeType?: string | null;
  /** File size in bytes, or null when unknown. */
  byteSize?: number | null;
  /** Pixel width, or null when unknown. */
  width?: number | null;
  /** Pixel height, or null when unknown. */
  height?: number | null;
  /** Provenance label describing where the media came from. */
  source?: string | null;
  /** Content hash derived from the persistent media id, or null. */
  contentHash?: string | null;
  /** Embedded metadata extracted from the media file (ComfyUI workflow, etc.). */
  embeddedMetadata?: DirectorEmbeddedMediaMetadata | null;
  /** AI-generated transcript, or null when not available. */
  transcript?: DirectorMediaTranscript | null;
}

/** A point-in-time snapshot of the media library's engineering health. */
export interface DirectorMediaEngineeringSnapshot {
  /** Schema version for forward compatibility. */
  version: 1;
  /** Total number of media items. */
  total: number;
  /** Number of items with online availability. */
  online: number;
  /** Number of items with offline availability. */
  offline: number;
  /** Number of items whose availability has not been verified. */
  unverified: number;
  /** Number of items with waveform data ready. */
  waveformReady: number;
  /** Number of items with a proxy asset attached. */
  proxyReady: number;
  /** Per-item engineering details. */
  items: Array<{
    /** Media item id. */
    id: string;
    /** Coarse media type. */
    kind: DirectorMediaKind;
    /** Current availability status. */
    availability: CreativeMediaAvailability;
    /** Whether waveform data is available for this item. */
    waveformReady: boolean;
    /** The active playback variant. */
    playbackVariant: CreativeMediaPlaybackSelection["variant"] | "direct";
    /** The proxy asset id, or null when no proxy is attached. */
    proxyAssetId: string | null;
  }>;
}

/** Receipt returned after a successful media relink operation. */
export interface DirectorMediaRelinkReceipt {
  /** Always true; indicates success. */
  ok: true;
  /** Operation identifier for audit trails. */
  operation: "media.relink";
  /** The old media id that was replaced. */
  oldMediaId: string;
  /** The new media id that replaced it. */
  newMediaId: string;
  /** Number of canvas nodes and timeline clips updated. */
  referencesUpdated: number;
  /** Whether the new media has waveform data ready. */
  waveformReady: boolean;
}

/** Receipt returned after a successful proxy attachment operation. */
export interface DirectorMediaProxyReceipt {
  /** Always true; indicates success. */
  ok: true;
  /** Operation identifier for audit trails. */
  operation: "media.proxy.attach";
  /** The original media id the proxy was attached to. */
  originalMediaId: string;
  /** The newly created proxy media id. */
  proxyMediaId: string;
  /** Whether the proxy has waveform data ready. */
  waveformReady: boolean;
}

/** Resolved preview source for a storyboard shot's thumbnail. */
export interface DirectorStoryboardPreviewSource {
  /** The resolved source URL, or null when offline. */
  sourceUrl: string | null;
  /** Availability status of the resolved source. */
  availability: CreativeMediaAvailability;
}

/**
 * A captured storyboard frame is bound to the shot, not merely to its camera.
 * Only fall back to the camera's latest capture for legacy shots without an
 * explicit thumbnail reference.
 */
export function resolveDirectorStoryboardPreviewSource(
  shot: Pick<DirectorStoryboardShot, "thumbnail">,
  importedAssets: readonly Pick<CreativeMediaAsset, "id" | "objectUrl">[],
  legacyCameraCapture: string | null,
): DirectorStoryboardPreviewSource {
  if (shot.thumbnail) {
    const sourceUrl = importedAssets.find((asset) => asset.id === shot.thumbnail?.mediaId)?.objectUrl ?? null;
    return { sourceUrl, availability: sourceUrl ? "online" : "offline" };
  }
  return {
    sourceUrl: legacyCameraCapture,
    availability: legacyCameraCapture ? "online" : "unverified",
  };
}

/** Prefer full-resolution media for the video editor preview surface. */
export function getDirectorMediaPreviewSource(
  media: Pick<DirectorMediaItem, "kind" | "originalSourceUrl" | "sourceUrl" | "thumbnailUrl">,
) {
  if (media.kind === "image" || media.kind === "shot") {
    return media.originalSourceUrl ?? media.sourceUrl ?? media.thumbnailUrl ?? null;
  }
  if (media.kind === "video") {
    return media.originalSourceUrl ?? media.sourceUrl ?? null;
  }
  return media.sourceUrl ?? null;
}

/**
 * Infer the coarse media kind from a durable media id prefix.
 *
 * @param mediaId - The media id to inspect.
 * @param fallback - The kind to return when the id cannot be parsed.
 * @returns The inferred media kind.
 */
export function inferDirectorMediaKindFromId(
  mediaId: string,
  fallback: Exclude<DirectorMediaKind, "shot">,
): DirectorMediaKind {
  const durableKind = mediaId.match(/^creative-media:(image|video|audio):/)?.[1];
  if (durableKind === "image" || durableKind === "video" || durableKind === "audio") return durableKind;
  if (mediaId.startsWith("capture:") || mediaId.startsWith("reference:")) return "image";
  if (mediaId.startsWith("recording:")) return "video";
  if (mediaId.startsWith("shot:")) return "shot";
  return fallback;
}

/**
 * Determine a sensible default duration for a media item whose source is
 * offline, falling back to clip metadata when available.
 *
 * @param kind - The media kind.
 * @param sourceDurationSec - The duration from the source file, or 0.
 * @param clipDurationSec - The duration from the timeline clip, or 0.
 * @returns A reasonable duration in seconds.
 */
export function getOfflineDirectorMediaDuration(
  kind: DirectorMediaKind,
  sourceDurationSec: number,
  clipDurationSec: number,
) {
  if (kind === "image") {
    return clipDurationSec > 0 && clipDurationSec <= 60 ? clipDurationSec : 3;
  }
  if (kind === "shot") return clipDurationSec > 0 ? clipDurationSec : 3;
  return sourceDurationSec > 0 ? sourceDurationSec : Math.max(0.1, clipDurationSec);
}

function persistedMediaKind(item: DirectorMediaItem, blob: Blob) {
  if (item.kind !== "shot") return item.kind;
  return blob.type.startsWith("video/") ? "video" : "image";
}

function persistedMediaFileName(item: DirectorMediaItem, blob: Blob) {
  if (item.fileName?.trim()) return item.fileName;
  const subtype = blob.type.split("/")[1]?.split(";")[0]?.replace(/^x-/, "") || persistedMediaKind(item, blob);
  const extension = subtype === "jpeg" ? "jpg" : subtype;
  return `${item.name}.${extension}`;
}

/**
 * Canvas and timeline references must outlive transient camera captures,
 * recording object URLs, and removable Stage assets.
 */
export async function persistDirectorMediaItem(
  item: DirectorMediaItem,
  library: Pick<PersistentCreativeMediaLibrary, "importBlob"> = persistentCreativeMediaLibrary,
  fetchMedia: typeof fetch = globalThis.fetch,
): Promise<string> {
  if (item.collection === "imports" || !item.sourceUrl) return item.id;
  const response = await fetchMedia(item.sourceUrl);
  if (!response.ok) throw new Error(`素材读取失败：${item.name}`);
  const blob = await response.blob();
  const asset = await library.importBlob(blob, {
    kind: persistedMediaKind(item, blob),
    name: item.name,
    fileName: persistedMediaFileName(item, blob),
    durationSec: item.durationSec || null,
    width: item.width ?? null,
    height: item.height ?? null,
    source: `director-${item.collection}`,
  });
  return asset.id;
}

function useRecordingObjectUrls() {
  const recordings = useVideoRecordingStore((state) => state.recordings);
  const [urls, setUrls] = useState<Map<string, string>>(() => new Map());

  useEffect(() => {
    const next = new Map<string, string>();
    recordings.forEach((recording) => next.set(recording.id, URL.createObjectURL(recording.blob)));
    setUrls(next);
    return () => next.forEach((url) => URL.revokeObjectURL(url));
  }, [recordings]);

  return { recordings, urls };
}

function canProbeMediaSource(sourceUrl: string): boolean {
  try {
    const parsed = new URL(sourceUrl, typeof window === "undefined" ? "http://localhost/" : window.location.href);
    return parsed.protocol === "blob:" || parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function useProbedMediaAvailability(sourceUrls: readonly string[]) {
  const [availability, setAvailability] = useState<Map<string, CreativeMediaAvailability>>(() => new Map());

  useEffect(() => {
    let active = true;
    if (!sourceUrls.length) {
      setAvailability((current) => (current.size ? new Map() : current));
      return () => {
        active = false;
      };
    }
    void Promise.all(
      sourceUrls.map(async (sourceUrl) => [sourceUrl, await probeCreativeMediaAvailability(sourceUrl)] as const),
    ).then((results) => {
      if (active) setAvailability(new Map(results));
    });
    return () => {
      active = false;
    };
  }, [sourceUrls]);

  return availability;
}

/**
 * React hook that derives the unified media library from all project sources —
 * storyboard shots, camera captures, recordings, reference assets, and
 * imported media — resolving availability, playback variants, and offline
 * placeholders.
 *
 * @returns The complete, sorted array of media items for the library view.
 */
export function useDirectorMediaLibrary(): DirectorMediaItem[] {
  const { t } = useLanguage();
  const cameras = useDirectorStore((state) => state.project.cameras);
  const assets = useDirectorStore((state) => state.project.assets);
  const storyboard = useDirectorStore((state) => state.project.storyboard);
  const fps = useDirectorStore((state) => state.project.scene.timeline?.fps ?? 24);
  const { recordings, urls } = useRecordingObjectUrls();
  const importedAssets = usePersistentCreativeMediaAssets();
  const editTracks = useDirectorCreativeWorkspaceStore((state) => state.editTracks);
  const boardNodes = useDirectorCreativeWorkspaceStore((state) => state.boardNodes);
  const galleryMedia = useDirectorCreativeWorkspaceStore((state) => state.galleryMedia);
  const availabilitySources = useMemo(
    () =>
      [
        ...new Set([
          ...recordings.map((recording) => urls.get(recording.id)),
          ...assets.filter((asset) => asset.sourceType === "image").map((asset) => asset.url),
          ...importedAssets.map((asset) => asset.objectUrl),
        ]),
      ].filter((sourceUrl): sourceUrl is string => Boolean(sourceUrl) && canProbeMediaSource(sourceUrl!)),
    [assets, importedAssets, recordings, urls],
  );
  const availabilityBySource = useProbedMediaAvailability(availabilitySources);

  return useMemo(() => {
    const cameraById = new Map(cameras.map((camera) => [camera.id, camera]));
    const items: DirectorMediaItem[] = [];

    storyboard?.shots.forEach((shot) => {
      const camera = shot.cameraId ? cameraById.get(shot.cameraId) : undefined;
      const legacyCameraCapture = camera?.captures?.at(-1)?.dataUrl ?? camera?.lastCaptureUrl ?? null;
      const preview = resolveDirectorStoryboardPreviewSource(shot, importedAssets, legacyCameraCapture);
      const availability = preview.sourceUrl
        ? (availabilityBySource.get(preview.sourceUrl) ?? preview.availability)
        : preview.availability;
      const previewUrl = availability === "offline" ? null : preview.sourceUrl;
      items.push({
        id: `shot:${shot.id}`,
        kind: "shot",
        collection: "shots",
        name: shot.title,
        subtitle: `${camera?.name ?? "未指定机位"} · F${shot.frameStart}–F${shot.frameEnd}`,
        thumbnailUrl: previewUrl,
        sourceUrl: previewUrl,
        durationSec: getStoryboardShotDuration(shot, fps),
        cameraId: shot.cameraId,
        frameStart: shot.frameStart,
        frameEnd: shot.frameEnd,
        availability,
      });
    });

    cameras.forEach((camera) => {
      camera.captures?.forEach((capture) => {
        items.push({
          id: `capture:${camera.id}:${capture.id}`,
          kind: "image",
          collection: "captures",
          name: capture.name,
          subtitle: `${camera.name} · ${camera.focalLengthMm ?? 35} mm`,
          thumbnailUrl: capture.dataUrl,
          sourceUrl: capture.dataUrl,
          durationSec: 3,
          cameraId: camera.id,
          frameStart: null,
          frameEnd: null,
          availability: "online",
        });
      });
    });

    recordings.forEach((recording) => {
      items.push({
        id: `recording:${recording.id}`,
        kind: "video",
        collection: "recordings",
        name: recording.name,
        subtitle: `${recording.durationSec.toFixed(1)}s · ${recording.extension.toUpperCase()}`,
        thumbnailUrl: recording.thumbnailDataUrl || null,
        sourceUrl: urls.get(recording.id) ?? null,
        durationSec: recording.durationSec,
        cameraId: null,
        frameStart: recording.frameStart,
        frameEnd: recording.frameEnd,
        availability: urls.get(recording.id)
          ? (availabilityBySource.get(urls.get(recording.id)!) ?? "online")
          : "offline",
      });
    });

    assets
      .filter((asset) => asset.sourceType === "image")
      .forEach((asset) => {
        items.push({
          id: `reference:${asset.id}`,
          kind: "image",
          collection: "references",
          name: asset.name ?? asset.fileName,
          subtitle: "参考图",
          thumbnailUrl: asset.url,
          sourceUrl: asset.url,
          durationSec: 3,
          cameraId: null,
          frameStart: null,
          frameEnd: null,
          availability: asset.url ? (availabilityBySource.get(asset.url) ?? "online") : "offline",
        });
      });

    const projectMediaIds = new Set([
      ...galleryMedia.filter((record) => record.addedAt !== null).map((record) => record.mediaId),
      ...boardNodes.flatMap((node) => (node.mediaId ? [node.mediaId] : [])),
      ...editTracks.flatMap((track) => track.clips.map((clip) => clip.mediaId)),
    ]);
    const playableImportedAssets = importedAssets
      .filter((asset) => projectMediaIds.has(asset.id) || (asset.proxyOf ? projectMediaIds.has(asset.proxyOf) : false))
      .map((asset) =>
        asset.objectUrl && availabilityBySource.get(asset.objectUrl) === "offline"
          ? { ...asset, objectUrl: null }
          : asset,
      );
    const proxyAssets = playableImportedAssets.filter((asset) => asset.proxyOf);
    const proxiesByOriginal = new Map<string, typeof proxyAssets>();
    proxyAssets.forEach((proxy) => {
      if (!proxy.proxyOf) return;
      const proxies = proxiesByOriginal.get(proxy.proxyOf) ?? [];
      proxies.push(proxy);
      proxiesByOriginal.set(proxy.proxyOf, proxies);
    });
    const connection = (globalThis.navigator as (Navigator & { connection?: { saveData?: boolean } }) | undefined)
      ?.connection;
    playableImportedAssets
      .filter((asset) => !asset.proxyOf)
      .forEach((asset) => {
        const selection = selectCreativeMediaPlaybackSource(asset, proxiesByOriginal.get(asset.id) ?? [], {
          preference: asset.playbackPreference ?? "auto",
          maxWidth: 1280,
          saveData: connection?.saveData === true,
          prioritizeFluidPlayback: asset.kind === "video" && asset.size > 24 * 1024 * 1024,
        });
        const proxy = selection.proxyAssetId
          ? playableImportedAssets.find((candidate) => candidate.id === selection.proxyAssetId)
          : undefined;
        items.push({
          id: asset.id,
          kind: asset.kind,
          collection: "imports",
          name: asset.name,
          subtitle:
            asset.kind === "image"
              ? `${asset.width ?? "?"} × ${asset.height ?? "?"}`
              : `${(asset.durationSec ?? 0).toFixed(1)}s · ${asset.mimeType || asset.kind}${selection.variant === "proxy" ? " · Proxy" : ""}`,
          thumbnailUrl: asset.kind === "image" ? selection.url : null,
          sourceUrl: selection.url,
          durationSec: asset.durationSec ?? (asset.kind === "image" ? 3 : 1),
          cameraId: null,
          frameStart: null,
          frameEnd: null,
          availability:
            selection.variant === "unavailable"
              ? "offline"
              : (availabilityBySource.get(selection.url ?? "") ?? "online"),
          waveform: asset.waveform ?? proxy?.waveform ?? null,
          playbackSource: selection,
          originalSourceUrl: asset.objectUrl,
          proxySourceUrl: proxy?.objectUrl ?? null,
          playbackPreference: asset.playbackPreference ?? "auto",
          createdAt: asset.createdAt,
          fileName: asset.fileName,
          mimeType: asset.mimeType,
          byteSize: asset.size,
          width: asset.width,
          height: asset.height,
          source: asset.source,
          contentHash: asset.id.match(/^creative-media:(?:image|video|audio):(.+?)(?::proxy-of:|$)/)?.[1] ?? null,
          embeddedMetadata: asset.embeddedMetadata ?? null,
          transcript: asset.transcript ?? null,
        });
      });

    const itemsById = new Map(items.map((item) => [item.id, item]));
    const missing = new Map<string, Pick<DirectorMediaItem, "kind" | "name" | "durationSec">>();
    editTracks.forEach((track) => {
      track.clips.forEach((clip) => {
        if (clip.mediaId.startsWith("text:") || itemsById.has(clip.mediaId)) return;
        const kind = inferDirectorMediaKindFromId(clip.mediaId, track.kind);
        missing.set(clip.mediaId, {
          kind,
          name: clip.name || clip.mediaId,
          durationSec: getOfflineDirectorMediaDuration(kind, clip.sourceDurationSec, clip.durationSec),
        });
      });
    });
    boardNodes.forEach((node) => {
      if (!node.mediaId || node.mediaId.startsWith("text:") || itemsById.has(node.mediaId)) return;
      const kind = node.kind === "audio" || node.kind === "video" || node.kind === "shot" ? node.kind : "image";
      missing.set(node.mediaId, { kind, name: node.title || node.mediaId, durationSec: 0 });
    });
    galleryMedia.forEach((record) => {
      if (
        !record.addedAt ||
        record.mediaId.startsWith("text:") ||
        itemsById.has(record.mediaId) ||
        missing.has(record.mediaId)
      ) {
        return;
      }
      const kind = inferDirectorMediaKindFromId(record.mediaId, "image");
      missing.set(record.mediaId, {
        kind,
        name: record.customName ?? record.mediaId,
        durationSec: kind === "image" || kind === "shot" ? 3 : 0,
      });
    });
    missing.forEach((entry, id) => {
      items.push({
        id,
        kind: entry.kind,
        collection: "imports",
        name: entry.name,
        subtitle: t("离线素材 · 等待重连"),
        thumbnailUrl: null,
        sourceUrl: null,
        durationSec: entry.durationSec,
        cameraId: null,
        frameStart: null,
        frameEnd: null,
        availability: "offline",
        waveform: null,
        originalSourceUrl: null,
        proxySourceUrl: null,
      });
    });

    return items;
  }, [
    assets,
    availabilityBySource,
    boardNodes,
    cameras,
    editTracks,
    fps,
    galleryMedia,
    importedAssets,
    recordings,
    storyboard?.shots,
    t,
    urls,
  ]);
}

/**
 * Produce a point-in-time engineering snapshot of the media library, counting
 * online, offline, unverified, waveform-ready, and proxy-ready items.
 *
 * @param items - The current media library items.
 * @returns A snapshot with aggregate counts and per-item details.
 */
export function getDirectorMediaEngineeringSnapshot(
  items: readonly DirectorMediaItem[],
): DirectorMediaEngineeringSnapshot {
  const normalized: DirectorMediaEngineeringSnapshot["items"] = items.map((item) => {
    const availability = item.availability ?? (item.sourceUrl || item.kind === "shot" ? "online" : "unverified");
    return {
      id: item.id,
      kind: item.kind,
      availability,
      waveformReady: Boolean(item.waveform),
      playbackVariant:
        item.playbackSource?.variant ?? (item.sourceUrl ? ("direct" as const) : ("unavailable" as const)),
      proxyAssetId: item.playbackSource?.proxyAssetId ?? null,
    };
  });
  return {
    version: 1,
    total: normalized.length,
    online: normalized.filter((item) => item.availability === "online").length,
    offline: normalized.filter((item) => item.availability === "offline").length,
    unverified: normalized.filter((item) => item.availability === "unverified").length,
    waveformReady: normalized.filter((item) => item.waveformReady).length,
    proxyReady: normalized.filter((item) => item.proxyAssetId).length,
    items: normalized,
  };
}

/**
 * Replace an offline media reference with a newly imported file, updating
 * every canvas node and timeline clip that references the old id.
 *
 * Gallery metadata (rating, tags, color, notes, folder) is carried over to the
 * new media id.
 *
 * @param oldMediaId - The media id to replace.
 * @param file - The new media file to import.
 * @param expectedKind - Optional media kind to validate against the file.
 * @returns A receipt describing the relink result.
 * @throws If the file kind does not match the expected kind.
 */
export async function relinkDirectorCreativeMedia(
  oldMediaId: string,
  file: File,
  expectedKind?: DirectorMediaKind,
): Promise<DirectorMediaRelinkReceipt> {
  const probe = await probeCreativeMediaFile(file);
  const kindMatches =
    !expectedKind ||
    (expectedKind === "shot" ? probe.kind === "image" || probe.kind === "video" : probe.kind === expectedKind);
  if (!kindMatches) {
    throw new Error(`重连类型不匹配：需要 ${expectedKind}，收到 ${probe.kind}`);
  }
  const imported = await persistentCreativeMediaLibrary.importFile(file, { ...probe, source: "media-relink" });
  const store = useDirectorCreativeWorkspaceStore.getState();
  const previousGalleryRecord = store.galleryMedia.find((record) => record.mediaId === oldMediaId);
  let referencesUpdated = 0;
  store.beginHistoryBatch();
  try {
    store.boardNodes.forEach((node) => {
      if (node.mediaId !== oldMediaId) return;
      store.updateBoardNode(node.id, { mediaId: imported.id });
      referencesUpdated += 1;
    });
    store.editTracks.forEach((track) => {
      const matchingClips = track.clips.filter((clip) => clip.mediaId === oldMediaId);
      if (!matchingClips.length) return;
      if (track.locked) store.toggleTrackLock(track.id);
      try {
        matchingClips.forEach((clip) => {
          store.updateClip(clip.id, {
            mediaId: imported.id,
            sourceDurationSec: imported.durationSec ?? clip.sourceDurationSec,
          });
          referencesUpdated += 1;
        });
      } finally {
        if (track.locked) store.toggleTrackLock(track.id);
      }
    });
    store.updateGalleryMedia(imported.id, {
      ...(previousGalleryRecord
        ? {
            rating: previousGalleryRecord.rating,
            tags: [...previousGalleryRecord.tags],
            color: previousGalleryRecord.color,
            customName: previousGalleryRecord.customName,
            notes: previousGalleryRecord.notes,
            folderId: previousGalleryRecord.folderId,
            trashedAt: previousGalleryRecord.trashedAt,
          }
        : {}),
      addedAt: previousGalleryRecord?.addedAt ?? new Date().toISOString(),
    });
    if (previousGalleryRecord && imported.id !== oldMediaId) store.purgeGalleryMedia([oldMediaId]);
    store.endHistoryBatch();
  } catch (error) {
    store.rollbackHistoryBatch();
    throw error;
  }
  return {
    ok: true,
    operation: "media.relink",
    oldMediaId,
    newMediaId: imported.id,
    referencesUpdated,
    waveformReady: Boolean(imported.waveform),
  };
}

/**
 * Attach a lightweight proxy file to an existing persistent media asset for
 * lower-bandwidth playback.
 *
 * @param originalMediaId - The original media id to attach a proxy to.
 * @param file - The proxy media file.
 * @returns A receipt describing the proxy attachment result.
 * @throws If the original media is not in the persistent library or the proxy kind differs.
 */
export async function attachDirectorCreativeMediaProxy(
  originalMediaId: string,
  file: File,
): Promise<DirectorMediaProxyReceipt> {
  const original = persistentCreativeMediaLibrary.getAsset(originalMediaId);
  if (!original) throw new Error("只有持久媒体库中的原始素材才能关联代理");
  const probe = await probeCreativeMediaFile(file);
  if (probe.kind !== original.kind) throw new Error("代理媒体类型必须与原始素材一致");
  const proxy = await persistentCreativeMediaLibrary.attachProxy(originalMediaId, file, {
    ...probe,
    fileName: file.name,
    name: `${original.name} Proxy`,
    proxyProfile: {
      label: `${probe.width ?? "audio"}${probe.height ? `×${probe.height}` : ""} proxy`,
      width: probe.width ?? null,
      height: probe.height ?? null,
      videoBitrateKbps: null,
      audioBitrateKbps: null,
      codec: file.type || null,
      createdAt: new Date().toISOString(),
    },
  });
  return {
    ok: true,
    operation: "media.proxy.attach",
    originalMediaId,
    proxyMediaId: proxy.id,
    waveformReady: Boolean(proxy.waveform),
  };
}

/** The canonical list of media library collection tabs, including the "all" pseudo-collection. */
export const DIRECTOR_MEDIA_COLLECTIONS: Array<{ id: "all" | DirectorMediaCollection; label: string }> = [
  { id: "all", label: "全部" },
  { id: "shots", label: "分镜" },
  { id: "captures", label: "截图" },
  { id: "recordings", label: "视频" },
  { id: "references", label: "参考" },
  { id: "imports", label: "导入" },
];
