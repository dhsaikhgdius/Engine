import JSZip, { type JSZipObject } from "jszip";
import { z } from "zod";
import {
  persistentCreativeMediaLibrary,
  CREATIVE_MEDIA_KINDS,
  type CreativeMediaAsset,
  type CreativeMediaImportOptions,
  type CreativeMediaKind,
} from "../media/persistentCreativeMediaStore";
import {
  creativeMediaPlaybackPreferenceSchema,
  creativeMediaProxyProfileSchema,
  creativeMediaWaveformDataFields,
  type CreativeMediaPlaybackPreference,
  type CreativeMediaProxyProfile,
  type CreativeMediaWaveformData,
} from "../media/creativeMediaEngineering";
import { parseDirectorCreativeWorkspacePersistedState } from "./directorWorkspaceStore";
import creativeMediaFormats from "../media/creativeMediaFormats.json";
import type { DirectorEmbeddedMediaMetadata } from "../media/pngMetadata";
import { logDirectorProjectRepairs, parseDirectorProjectForLoad } from "../store/directorStore";
import {
  DIRECTOR_SPLAT_SEQUENCE_MANIFEST_SUFFIX,
  directorSplatSequenceManifestSchema,
  isDirectorSplatSequenceManifestFileName,
  resolveDirectorSplatSequenceFrameUrls,
} from "../loaders/splatFormats";
import type { DirectorAssetRef, DirectorProject } from "../schema/directorProject";
import {
  directorMediaTranscriptSchema,
  type DirectorMediaTranscript,
} from "../../../../../../packages/protocol/src/mediaTranscriptionProtocol";

/** IANA-style MIME type for the Director creative project bundle ZIP archive. */
export const CREATIVE_PROJECT_BUNDLE_MIME_TYPE = "application/vnd.director.creative-project+zip";
/** Default file name used when saving a creative project bundle to disk. */
export const CREATIVE_PROJECT_BUNDLE_FILE_NAME = "director-creative-project.director.zip";
/** Canonical path of the manifest entry inside the bundle archive. */
export const CREATIVE_PROJECT_BUNDLE_MANIFEST_PATH = "manifest.json";

/** Size and entry-count caps enforced during export and import. */
export const CREATIVE_PROJECT_BUNDLE_LIMITS = Object.freeze({
  // The archive must be able to carry the media and stage-asset budgets below
  // plus the manifest; bundles are stored uncompressed (STORE).
  maxArchiveBytes: 1040 * 1024 * 1024,
  maxManifestBytes: 8 * 1024 * 1024,
  maxMediaBytes: 192 * 1024 * 1024,
  maxTotalMediaBytes: 512 * 1024 * 1024,
  maxMediaEntries: 128,
  maxStageAssetBytes: 192 * 1024 * 1024,
  maxTotalStageAssetBytes: 512 * 1024 * 1024,
  maxStageAssetEntries: 64,
  maxZipEntries: 196,
});

/**
 * Lightweight descriptor of a media asset to include in the bundle.
 * Callers supply this alongside the workspace so the exporter can locate
 * and fetch each referenced media's binary payload.
 */
export interface CreativeProjectBundleMediaSource {
  /** Unique media identifier in the workspace. */
  id: string;
  /** Direct URL of the source media file, if still reachable. */
  sourceUrl?: string | null;
  /** Media kind. */
  kind?: CreativeMediaKind;
  /** User-visible name. */
  name?: string;
  /** Original file name. */
  fileName?: string;
  /** MIME type of the media file. */
  mimeType?: string;
  /** Duration in seconds. */
  durationSec?: number | null;
  /** Pixel width. */
  width?: number | null;
  /** Pixel height. */
  height?: number | null;
  /** Provenance label. */
  source?: string | null;
  /** Pre-computed waveform data. */
  waveform?: CreativeMediaWaveformData | null;
  /** ID of the original asset this proxy represents. */
  proxyOf?: string | null;
  /** Proxy transcoding profile. */
  proxyProfile?: CreativeMediaProxyProfile | null;
  /** Preferred playback strategy. */
  playbackPreference?: CreativeMediaPlaybackPreference;
  /** Embedded PNG metadata block. */
  embeddedMetadata?: DirectorEmbeddedMediaMetadata | null;
  /** Speech transcription data. */
  transcript?: DirectorMediaTranscript | null;
}

/**
 * Abstraction over the local media library so the exporter and importer
 * can read and write blobs without coupling to a specific store backend.
 */
export interface CreativeProjectBundleMediaLibrary {
  /** Looks up a single asset by its ID. */
  getAsset?(id: string): CreativeMediaAsset | null;
  /** Returns all assets known to the library. */
  listAssets?(): readonly CreativeMediaAsset[];
  /** Retrieves the raw binary for an asset. */
  getBlob(id: string): Promise<Blob | null>;
  /** Imports a blob into the library and returns its new asset ID. */
  importBlob(blob: Blob, options?: CreativeMediaImportOptions): Promise<Pick<CreativeMediaAsset, "id">>;
}

/** Re-registers a bundled 3D stage model on the target machine and returns its new URL. */
export type CreativeProjectBundleStageAssetUploader = (
  blob: Blob,
  fileName: string,
  assetId: string,
) => Promise<{ url: string; fileName?: string }>;

/**
 * Options controlling what gets bundled and how external media is fetched.
 */
export interface ExportCreativeProjectBundleOptions {
  /** Serialized workspace JSON payload. */
  serialized: string;
  /** Complete 3D stage project to embed. Local/generated model binaries it references are bundled too. */
  stageProject?: DirectorProject | null;
  /** Per-media metadata overrides for the export. */
  mediaSources?: Iterable<CreativeProjectBundleMediaSource>;
  /** Media library used to read blobs and asset metadata. */
  mediaLibrary?: CreativeProjectBundleMediaLibrary;
  /** Custom fetch implementation for downloading remote media. */
  fetcher?: typeof fetch;
  /** Clock override for the `exportedAt` timestamp. */
  now?: () => Date;
}

/**
 * Options controlling how an imported bundle is restored on the target machine.
 */
export interface ImportCreativeProjectBundleOptions {
  /** Media library used to write imported blobs. */
  mediaLibrary?: CreativeProjectBundleMediaLibrary;
  /** Callback that re-uploads a bundled 3D stage model and returns its new URL. */
  stageAssetUploader?: CreativeProjectBundleStageAssetUploader;
}

/**
 * Result of a successful bundle import. The workspace is remapped with
 * new local media IDs and the stage project has its model URLs rewritten.
 */
export interface ImportedCreativeProjectBundle {
  /** Re-serialized workspace JSON with remapped media IDs. */
  serialized: string;
  /** Map from original media IDs to the newly imported IDs. */
  mediaIdMap: ReadonlyMap<string, string>;
  /** Every media ID that was imported into the local library. */
  importedMediaIds: readonly string[];
  /** ISO-8601 timestamp of when the bundle was exported. */
  exportedAt: string;
  /** Validated 3D stage project with model URLs rewritten to this machine, or null for bundles without one. */
  stageProject: DirectorProject | null;
}

const nullableFiniteNonNegative = z.number().finite().nonnegative().nullable();
const workspaceEnvelopeSchema = z.looseObject({
  version: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  state: z.looseObject({
    boardNodes: z
      .array(
        z.looseObject({
          mediaId: z.string().max(512).nullable(),
        }),
      )
      .max(240)
      .optional(),
    editTracks: z
      .array(
        z.looseObject({
          clips: z
            .array(
              z.looseObject({
                mediaId: z.string().min(1).max(512),
              }),
            )
            .max(400),
        }),
      )
      .max(12)
      .optional(),
    galleryMedia: z
      .array(
        z.looseObject({
          mediaId: z.string().min(1).max(512),
          addedAt: z.string().nullable().optional(),
        }),
      )
      .max(5_000)
      .optional(),
  }),
});

const legacyCreativeProjectSchema = z.looseObject({
  documentType: z.literal("director-creative-project"),
  version: z.number().int().positive(),
  creative: workspaceEnvelopeSchema,
});

const safeMediaPathSchema = z
  .string()
  .max(96)
  .refine((value) => /^media\/[0-9]{4}\.[a-z0-9]{1,10}$/.test(value), "媒体路径不安全");

const safeStageAssetPathSchema = z
  .string()
  .max(96)
  .refine((value) => /^stage-assets\/[0-9]{4}\.[a-z0-9]{1,10}$/.test(value), "片场资产路径不安全");

const bundleWaveformSchema = z.object({
  ...creativeMediaWaveformDataFields,
  channelCount: creativeMediaWaveformDataFields.channelCount.max(64),
  minPeaks: creativeMediaWaveformDataFields.minPeaks.max(4096),
  maxPeaks: creativeMediaWaveformDataFields.maxPeaks.max(4096),
});

const bundleMediaSchema = z.object({
  id: z.string().min(1).max(512),
  path: safeMediaPathSchema,
  kind: z.enum(CREATIVE_MEDIA_KINDS),
  name: z.string().min(1).max(512),
  fileName: z.string().min(1).max(512),
  mimeType: z.string().min(1).max(128),
  size: z.number().int().nonnegative().max(CREATIVE_PROJECT_BUNDLE_LIMITS.maxMediaBytes),
  durationSec: nullableFiniteNonNegative,
  width: z.number().int().positive().max(100_000).nullable(),
  height: z.number().int().positive().max(100_000).nullable(),
  source: z.string().max(512).nullable(),
  waveform: bundleWaveformSchema.nullable().optional(),
  proxyOf: z.string().min(1).max(512).nullable().optional(),
  proxyProfile: creativeMediaProxyProfileSchema.nullable().optional(),
  playbackPreference: creativeMediaPlaybackPreferenceSchema.optional(),
  embeddedMetadata: z.record(z.string().max(80), z.string().max(200_000)).nullable().optional(),
  transcript: directorMediaTranscriptSchema.nullable().optional(),
});

const bundleStageAssetSchema = z.object({
  // The gateway upload endpoint rejects asset IDs longer than 120 bytes.
  id: z.string().min(1).max(120),
  path: safeStageAssetPathSchema,
  fileName: z
    .string()
    .min(1)
    .max(512)
    .refine((value) => !/[/\\]/.test(value) && value !== ".." && value !== ".", "片场资产文件名不安全"),
  mimeType: z.string().min(1).max(128),
  size: z.number().int().nonnegative().max(CREATIVE_PROJECT_BUNDLE_LIMITS.maxStageAssetBytes),
});

const bundleStageSchema = z.object({
  project: z.unknown(),
  assets: z.array(bundleStageAssetSchema).max(CREATIVE_PROJECT_BUNDLE_LIMITS.maxStageAssetEntries),
});

const bundleManifestSchema = z.object({
  documentType: z.literal("director-creative-project-bundle"),
  // Version 1 bundles predate the embedded 3D stage and stay importable.
  version: z.union([z.literal(1), z.literal(2)]),
  exportedAt: z.string().min(1).max(128),
  workspace: workspaceEnvelopeSchema,
  media: z.array(bundleMediaSchema).max(CREATIVE_PROJECT_BUNDLE_LIMITS.maxMediaEntries),
  stage: bundleStageSchema.optional(),
});

/** Inferred type of the workspace envelope carried inside a bundle. */
export type CreativeProjectWorkspaceDocument = z.infer<typeof workspaceEnvelopeSchema>;
type WorkspaceEnvelope = CreativeProjectWorkspaceDocument;
type BundleMedia = z.infer<typeof bundleMediaSchema>;
type BundleStageAsset = z.infer<typeof bundleStageAssetSchema>;
type BundleManifest = z.infer<typeof bundleManifestSchema>;

interface PreparedMedia {
  manifest: BundleMedia;
  bytes: Uint8Array;
}

interface PreparedStageAsset {
  manifest: BundleStageAsset;
  bytes: Uint8Array;
}

const MIME_EXTENSION: Readonly<Record<string, string>> = Object.freeze(creativeMediaFormats.mimeExtensions);

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function assertWorkspaceCanLoad(workspace: WorkspaceEnvelope): string {
  const serialized = JSON.stringify(workspace);
  if (Object.keys(parseDirectorCreativeWorkspacePersistedState(serialized)).length === 0) {
    throw new Error("Canvas/Video 工程数据无效或不受支持");
  }
  return serialized;
}

function parseWorkspaceValue(value: unknown): WorkspaceEnvelope {
  const parsed = workspaceEnvelopeSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Canvas/Video 工程结构无效：${parsed.error.issues[0]?.message ?? "未知错误"}`);
  assertWorkspaceCanLoad(parsed.data);
  return parsed.data;
}

/** Parses either a persisted workspace document or the legacy JSON export wrapper. */
export function parseLegacyCreativeProjectJson(serialized: string): string {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("工程 JSON 无法解析");
  }
  const legacy = legacyCreativeProjectSchema.safeParse(value);
  const workspace = legacy.success ? legacy.data.creative : parseWorkspaceValue(value);
  return assertWorkspaceCanLoad(workspace);
}

function parseWorkspaceSerialized(serialized: string): WorkspaceEnvelope {
  return parseWorkspaceValue(JSON.parse(parseLegacyCreativeProjectJson(serialized)));
}

function isVirtualMediaId(id: string) {
  return id.startsWith("text:");
}

/**
 * Collects every media ID referenced by the workspace — from board nodes,
 * edit timeline clips, and gallery records — excluding virtual text nodes.
 *
 * @param workspace - The workspace envelope to scan.
 * @returns Sorted array of unique referenced media IDs.
 */
export function getCreativeProjectReferencedMediaIds(workspace: WorkspaceEnvelope): string[] {
  const referenced = new Set<string>();
  workspace.state.boardNodes?.forEach((node) => {
    if (node.mediaId && !isVirtualMediaId(node.mediaId)) referenced.add(node.mediaId);
  });
  workspace.state.editTracks?.forEach((track) => {
    track.clips.forEach((clip) => {
      if (!isVirtualMediaId(clip.mediaId)) referenced.add(clip.mediaId);
    });
  });
  workspace.state.galleryMedia?.forEach((record) => {
    if (record.addedAt && !isVirtualMediaId(record.mediaId)) referenced.add(record.mediaId);
  });
  return [...referenced].sort();
}

function inferKind(blob: Blob, source: { id?: string; kind?: CreativeMediaKind } | undefined) {
  if (source?.kind) return source.kind;
  const prefix = blob.type.toLowerCase().split("/", 1)[0];
  if (prefix === "image" || prefix === "video" || prefix === "audio") return prefix;
  throw new Error(`无法识别媒体 ${source?.id ?? ""} 的类型`);
}

function safeExtension(fileName: string | undefined, mimeType: string, kind: CreativeMediaKind) {
  const mimeExtension = MIME_EXTENSION[mimeType.toLowerCase()];
  if (mimeExtension) return mimeExtension;
  const match = fileName?.toLowerCase().match(/\.([a-z0-9]{1,10})$/);
  if (match) return match[1];
  return kind === "image" ? "bin" : kind === "video" ? "vid" : "aud";
}

function normalizeNullableNumber(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function normalizeNullableDimension(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

function validateSourceUrl(sourceUrl: string) {
  const base = typeof window !== "undefined" ? window.location.href : "http://localhost/";
  const parsed = new URL(sourceUrl, base);
  if (!new Set(["http:", "https:", "blob:", "data:"]).has(parsed.protocol)) {
    throw new Error(`不允许读取 ${parsed.protocol} 媒体地址`);
  }
  return parsed.href;
}

async function fetchMediaBlob(sourceUrl: string, fetcher: typeof fetch): Promise<Blob> {
  const response = await fetcher(validateSourceUrl(sourceUrl));
  if (!response.ok) throw new Error(`媒体下载失败（HTTP ${response.status}）`);
  const declaredSize = Number(response.headers?.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > CREATIVE_PROJECT_BUNDLE_LIMITS.maxMediaBytes) {
    throw new Error("远程媒体超过单文件大小限制");
  }
  return response.blob();
}

/**
 * Packaged catalog models keep their canonical URLs and ship with the app;
 * only user-supplied and generated model binaries must travel in the bundle.
 */
function isBundledStageAsset(asset: DirectorAssetRef) {
  return (
    asset.sourceType === "model" &&
    asset.kind !== "panorama" &&
    (asset.assetSource === "local" || asset.assetSource === "generated")
  );
}

function stageAssetLabel(asset: Pick<DirectorAssetRef, "name" | "fileName" | "id">) {
  return asset.name || asset.fileName || asset.id;
}

function parseStageProject(value: unknown, sourceLabel: string): DirectorProject {
  const result = parseDirectorProjectForLoad(value);
  if (!result.success) throw new Error(`3D 片场工程数据无效：${result.error}`);
  logDirectorProjectRepairs(sourceLabel, result.repairs);
  return result.project;
}

/**
 * A 4DGS sequence asset points at a frame manifest whose frames live beside it
 * on the gateway. Bundles carry one file per asset, so the sequence travels as
 * a re-assembled upload ZIP (frames plus fps manifest); importing re-uploads
 * that ZIP and the target gateway unpacks it into a fresh manifest again.
 */
async function repackSplatSequenceArchive(asset: DirectorAssetRef, fetcher: typeof fetch): Promise<Blob> {
  const manifestBlob = await fetchMediaBlob(asset.url, fetcher);
  const manifest = directorSplatSequenceManifestSchema.parse(JSON.parse(await manifestBlob.text()));
  const zip = new JSZip();
  zip.file("manifest.json", JSON.stringify({ fps: manifest.fps }));
  const frameUrls = resolveDirectorSplatSequenceFrameUrls(asset.url, manifest.frames);
  for (const [frameIndex, frameUrl] of frameUrls.entries()) {
    const frameName = manifest.frames[frameIndex]!.split("/").pop() ?? `frame-${frameIndex + 1}`;
    const frameBlob = await fetchMediaBlob(frameUrl, fetcher);
    zip.file(frameName, await frameBlob.arrayBuffer());
  }
  const bytes = await zip.generateAsync({ type: "uint8array", compression: "STORE" });
  return new Blob([bytes], { type: "application/zip" });
}

function bundledStageAssetFileName(asset: DirectorAssetRef) {
  const fileName = (asset.fileName.split(/[\\/]/).pop() ?? "").slice(0, 512);
  if (!fileName || fileName === "." || fileName === "..") return null;
  if (!isDirectorSplatSequenceManifestFileName(fileName)) return fileName;
  const base = fileName.slice(0, -DIRECTOR_SPLAT_SEQUENCE_MANIFEST_SUFFIX.length) || "splat-sequence";
  return `${base}.zip`;
}

async function prepareStageAssets(project: DirectorProject, fetcher: typeof fetch): Promise<PreparedStageAsset[]> {
  const bundledAssets = project.assets.filter(isBundledStageAsset);
  if (bundledAssets.length > CREATIVE_PROJECT_BUNDLE_LIMITS.maxStageAssetEntries) {
    throw new Error("3D 片场引用的模型数量超过导出限制");
  }
  const prepared: PreparedStageAsset[] = [];
  let totalBytes = 0;
  for (const [index, asset] of bundledAssets.entries()) {
    if (asset.id.length > 120) {
      throw new Error(`3D 片场模型「${stageAssetLabel(asset)}」的资产 ID 超过 120 字符，无法打包`);
    }
    let blob: Blob;
    try {
      blob = isDirectorSplatSequenceManifestFileName(asset.fileName)
        ? await repackSplatSequenceArchive(asset, fetcher)
        : await fetchMediaBlob(asset.url, fetcher);
    } catch (error) {
      throw new Error(`3D 片场模型「${stageAssetLabel(asset)}」打包失败：${toErrorMessage(error)}`);
    }
    if (blob.size > CREATIVE_PROJECT_BUNDLE_LIMITS.maxStageAssetBytes) {
      throw new Error(`3D 片场模型「${stageAssetLabel(asset)}」超过单文件大小限制`);
    }
    totalBytes += blob.size;
    if (totalBytes > CREATIVE_PROJECT_BUNDLE_LIMITS.maxTotalStageAssetBytes) {
      throw new Error("3D 片场模型总大小超过导出限制");
    }
    const fileName = bundledStageAssetFileName(asset);
    if (!fileName) {
      throw new Error(`3D 片场模型「${stageAssetLabel(asset)}」缺少有效文件名，无法打包`);
    }
    const extension = fileName.toLowerCase().match(/\.([a-z0-9]{1,10})$/)?.[1] ?? "bin";
    prepared.push({
      manifest: {
        id: asset.id,
        path: `stage-assets/${String(index + 1).padStart(4, "0")}.${extension}`,
        fileName,
        mimeType: (blob.type || "application/octet-stream").slice(0, 128),
        size: blob.size,
      },
      bytes: new Uint8Array(await blob.arrayBuffer()),
    });
  }
  return prepared;
}

async function prepareReferencedMedia(
  id: string,
  index: number,
  mediaLibrary: CreativeProjectBundleMediaLibrary,
  source: CreativeProjectBundleMediaSource | undefined,
  fetcher: typeof fetch,
): Promise<PreparedMedia> {
  const asset = mediaLibrary.getAsset?.(id) ?? null;
  let blob = await mediaLibrary.getBlob(id);
  if (!blob) {
    const sourceUrl = source?.sourceUrl ?? asset?.objectUrl;
    if (!sourceUrl) throw new Error(`工程引用的媒体不存在：${id}`);
    blob = await fetchMediaBlob(sourceUrl, fetcher);
  }
  if (blob.size > CREATIVE_PROJECT_BUNDLE_LIMITS.maxMediaBytes) {
    throw new Error(`媒体 ${id} 超过单文件大小限制`);
  }
  const metadata = asset || source ? { ...asset, ...source } : undefined;
  const kind = inferKind(blob, metadata);
  const mimeType = (metadata?.mimeType || blob.type || `${kind}/octet-stream`).slice(0, 128);
  const fileName = (metadata?.fileName || `${metadata?.name || id}.${safeExtension(undefined, mimeType, kind)}`).slice(
    0,
    512,
  );
  const name = (metadata?.name || fileName || id).slice(0, 512);
  const extension = safeExtension(fileName, mimeType, kind);
  const path = `media/${String(index + 1).padStart(4, "0")}.${extension}`;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return {
    manifest: {
      id,
      path,
      kind,
      name,
      fileName,
      mimeType,
      size: bytes.byteLength,
      durationSec: normalizeNullableNumber(metadata?.durationSec),
      width: normalizeNullableDimension(metadata?.width),
      height: normalizeNullableDimension(metadata?.height),
      source: (metadata?.source ?? "project-bundle").slice(0, 512),
      waveform: metadata?.waveform ?? null,
      proxyOf: metadata?.proxyOf ?? null,
      proxyProfile: metadata?.proxyProfile ?? null,
      playbackPreference: metadata?.playbackPreference ?? "auto",
      embeddedMetadata: metadata?.embeddedMetadata ? { ...metadata.embeddedMetadata } : null,
      transcript: metadata?.transcript ?? null,
    },
    bytes,
  };
}

/**
 * Exports a creative project into a self-contained ZIP bundle. The bundle
 * carries the workspace JSON, every referenced media asset, referenced proxy
 * assets, and optionally an embedded 3D stage project with its local models.
 *
 * @param options - Serialized workspace, media sources, stage project, and overrides.
 * @returns A Blob representing the complete bundle archive.
 */
export async function exportCreativeProjectBundle(options: ExportCreativeProjectBundleOptions): Promise<Blob> {
  const workspace = parseWorkspaceSerialized(options.serialized);
  const directlyReferencedIds = getCreativeProjectReferencedMediaIds(workspace);
  const mediaLibrary = options.mediaLibrary ?? persistentCreativeMediaLibrary;
  const proxyIds = (mediaLibrary.listAssets?.() ?? [])
    .filter((asset) => asset.proxyOf && directlyReferencedIds.includes(asset.proxyOf))
    .map((asset) => asset.id)
    .sort();
  const referencedIds = [...directlyReferencedIds, ...proxyIds];
  if (referencedIds.length > CREATIVE_PROJECT_BUNDLE_LIMITS.maxMediaEntries) {
    throw new Error("工程引用的媒体数量超过导出限制");
  }
  const fetcher = options.fetcher ?? globalThis.fetch;
  if (!fetcher) throw new Error("当前环境无法下载外部媒体");
  const stageProject = options.stageProject ? parseStageProject(options.stageProject, "导出工程包") : null;
  const stageAssets = stageProject ? await prepareStageAssets(stageProject, fetcher) : [];
  const sourceMap = new Map([...(options.mediaSources ?? [])].map((source) => [source.id, source]));
  const prepared: PreparedMedia[] = [];
  let totalMediaBytes = 0;
  for (const [index, id] of referencedIds.entries()) {
    const item = await prepareReferencedMedia(id, index, mediaLibrary, sourceMap.get(id), fetcher);
    totalMediaBytes += item.bytes.byteLength;
    if (totalMediaBytes > CREATIVE_PROJECT_BUNDLE_LIMITS.maxTotalMediaBytes) {
      throw new Error("工程媒体总大小超过导出限制");
    }
    prepared.push(item);
  }

  const manifest: BundleManifest = {
    documentType: "director-creative-project-bundle",
    ...(stageProject
      ? { version: 2 as const, stage: { project: stageProject, assets: stageAssets.map((item) => item.manifest) } }
      : { version: 1 as const }),
    exportedAt: (options.now ?? (() => new Date()))().toISOString(),
    workspace,
    media: prepared.map((item) => item.manifest),
  };
  const manifestJson = JSON.stringify(manifest, null, 2);
  if (new TextEncoder().encode(manifestJson).byteLength > CREATIVE_PROJECT_BUNDLE_LIMITS.maxManifestBytes) {
    throw new Error("工程清单超过大小限制");
  }
  const zip = new JSZip();
  zip.file(CREATIVE_PROJECT_BUNDLE_MANIFEST_PATH, manifestJson);
  prepared.forEach((item) => zip.file(item.manifest.path, item.bytes));
  stageAssets.forEach((item) => zip.file(item.manifest.path, item.bytes));
  return zip.generateAsync({
    type: "blob",
    mimeType: CREATIVE_PROJECT_BUNDLE_MIME_TYPE,
    compression: "STORE",
    platform: "DOS",
  });
}

function assertSafeZipEntry(entry: JSZipObject) {
  const originalName = (entry as JSZipObject & { unsafeOriginalName?: string }).unsafeOriginalName ?? entry.name;
  const normalizedName = entry.dir && originalName.endsWith("/") ? originalName.slice(0, -1) : originalName;
  if (
    normalizedName.includes("\\") ||
    normalizedName.startsWith("/") ||
    normalizedName.split("/").some((segment) => segment === ".." || segment === "." || segment === "")
  ) {
    throw new Error(`ZIP 包含不安全路径：${originalName}`);
  }
}

function declaredUncompressedSize(entry: JSZipObject) {
  const internal = entry as JSZipObject & { _data?: { uncompressedSize?: number } };
  const size = internal._data?.uncompressedSize;
  return typeof size === "number" && Number.isFinite(size) ? size : null;
}

async function toArchiveBytes(input: Blob | ArrayBuffer | Uint8Array) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return new Uint8Array(await input.arrayBuffer());
}

function remapWorkspaceMediaIds(workspace: WorkspaceEnvelope, mediaIdMap: ReadonlyMap<string, string>) {
  const cloned = structuredClone(workspace);
  cloned.state.boardNodes?.forEach((node) => {
    if (node.mediaId) node.mediaId = mediaIdMap.get(node.mediaId) ?? node.mediaId;
  });
  cloned.state.editTracks?.forEach((track) => {
    track.clips.forEach((clip) => {
      clip.mediaId = mediaIdMap.get(clip.mediaId) ?? clip.mediaId;
    });
  });
  cloned.state.galleryMedia?.forEach((record) => {
    record.mediaId = mediaIdMap.get(record.mediaId) ?? record.mediaId;
  });
  return cloned;
}

const defaultStageAssetUploader: CreativeProjectBundleStageAssetUploader = async (blob, fileName, assetId) => {
  const { uploadBlenderModelAsset } = await import("../api/blenderLiveClient");
  return uploadBlenderModelAsset(blob, fileName, assetId);
};

interface StagedStageAsset {
  manifest: BundleStageAsset;
  blob: Blob;
}

function validateStageManifest(stage: NonNullable<BundleManifest["stage"]>, project: DirectorProject) {
  const assetIds = new Set<string>();
  const assetPaths = new Set<string>();
  for (const asset of stage.assets) {
    if (assetIds.has(asset.id)) throw new Error(`工程清单包含重复 3D 资产 ID：${asset.id}`);
    if (assetPaths.has(asset.path)) throw new Error(`工程清单包含重复 3D 资产路径：${asset.path}`);
    assetIds.add(asset.id);
    assetPaths.add(asset.path);
  }
  const projectAssetsById = new Map(project.assets.map((asset) => [asset.id, asset]));
  const unknownAsset = stage.assets.find((asset) => !projectAssetsById.has(asset.id));
  if (unknownAsset) throw new Error(`工程 ZIP 包含 3D 工程未引用的模型：${unknownAsset.id}`);
  const missingAsset = project.assets.find((asset) => isBundledStageAsset(asset) && !assetIds.has(asset.id));
  if (missingAsset) throw new Error(`工程 ZIP 缺少 3D 模型文件：${stageAssetLabel(missingAsset)}`);
  return assetPaths;
}

async function readStageAssets(zip: JSZip, stage: NonNullable<BundleManifest["stage"]>) {
  const staged: StagedStageAsset[] = [];
  let totalBytes = 0;
  for (const asset of stage.assets) {
    const entry = zip.file(asset.path);
    if (!entry || entry.dir) throw new Error(`工程 ZIP 缺少 3D 模型文件：${asset.path}`);
    const declaredSize = declaredUncompressedSize(entry);
    if (declaredSize !== null && declaredSize > CREATIVE_PROJECT_BUNDLE_LIMITS.maxStageAssetBytes) {
      throw new Error(`3D 模型 ${asset.id} 超过单文件大小限制`);
    }
    const bytes = await entry.async("uint8array");
    if (bytes.byteLength !== asset.size) throw new Error(`3D 模型 ${asset.id} 的大小与清单不一致`);
    totalBytes += bytes.byteLength;
    if (totalBytes > CREATIVE_PROJECT_BUNDLE_LIMITS.maxTotalStageAssetBytes) {
      throw new Error("3D 模型总大小超过导入限制");
    }
    staged.push({ manifest: asset, blob: new Blob([bytes], { type: asset.mimeType }) });
  }
  return staged;
}

/** Re-registers every bundled model on this machine and rewrites the project's asset URLs. */
async function restoreStageAssets(
  project: DirectorProject,
  staged: StagedStageAsset[],
  uploader: CreativeProjectBundleStageAssetUploader,
): Promise<DirectorProject> {
  if (!staged.length) return project;
  const uploadedById = new Map<string, { url: string; fileName?: string }>();
  for (const { manifest, blob } of staged) {
    try {
      uploadedById.set(manifest.id, await uploader(blob, manifest.fileName, manifest.id));
    } catch (error) {
      throw new Error(`3D 片场模型「${manifest.fileName}」恢复失败：${toErrorMessage(error)}`);
    }
  }
  return {
    ...project,
    assets: project.assets.map((asset) => {
      const uploaded = uploadedById.get(asset.id);
      if (!uploaded) return asset;
      return { ...asset, url: uploaded.url, fileName: uploaded.fileName ?? asset.fileName };
    }),
  };
}

/**
 * Imports a creative project bundle archive, restoring its workspace, media,
 * and optional stage project on the target machine. Every media asset is
 * re-imported into the local library with remapped IDs, and stage model URLs
 * are rewritten through the configured uploader.
 *
 * @param input - The bundle archive as a Blob, ArrayBuffer, or Uint8Array.
 * @param options - Media library and stage asset uploader overrides.
 * @returns The remapped workspace, ID map, and restored stage project.
 */
export async function importCreativeProjectBundle(
  input: Blob | ArrayBuffer | Uint8Array,
  options: ImportCreativeProjectBundleOptions = {},
): Promise<ImportedCreativeProjectBundle> {
  const archiveBytes = await toArchiveBytes(input);
  if (archiveBytes.byteLength > CREATIVE_PROJECT_BUNDLE_LIMITS.maxArchiveBytes) {
    throw new Error("工程 ZIP 超过大小限制");
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(archiveBytes, { checkCRC32: true, createFolders: false });
  } catch (error) {
    throw new Error(`工程 ZIP 无法读取：${toErrorMessage(error)}`);
  }
  const entries = Object.values(zip.files);
  if (entries.length > CREATIVE_PROJECT_BUNDLE_LIMITS.maxZipEntries) throw new Error("工程 ZIP 文件数量超过限制");
  entries.forEach(assertSafeZipEntry);
  const manifestEntry = zip.file(CREATIVE_PROJECT_BUNDLE_MANIFEST_PATH);
  if (!manifestEntry || manifestEntry.dir) throw new Error("工程 ZIP 缺少 manifest.json");
  const declaredManifestSize = declaredUncompressedSize(manifestEntry);
  if (declaredManifestSize !== null && declaredManifestSize > CREATIVE_PROJECT_BUNDLE_LIMITS.maxManifestBytes) {
    throw new Error("工程清单超过大小限制");
  }
  const manifestText = await manifestEntry.async("string");
  if (new TextEncoder().encode(manifestText).byteLength > CREATIVE_PROJECT_BUNDLE_LIMITS.maxManifestBytes) {
    throw new Error("工程清单超过大小限制");
  }
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(manifestText);
  } catch {
    throw new Error("工程清单不是有效 JSON");
  }
  const parsedManifest = bundleManifestSchema.safeParse(manifestValue);
  if (!parsedManifest.success) {
    throw new Error(`工程清单无效：${parsedManifest.error.issues[0]?.message ?? "未知错误"}`);
  }
  const manifest = parsedManifest.data;
  assertWorkspaceCanLoad(manifest.workspace);
  const stageProject = manifest.stage ? parseStageProject(manifest.stage.project, "导入工程包") : null;
  const stageAssetPaths =
    manifest.stage && stageProject ? validateStageManifest(manifest.stage, stageProject) : new Set<string>();

  const mediaIds = new Set<string>();
  const mediaPaths = new Set<string>();
  for (const media of manifest.media) {
    if (mediaIds.has(media.id)) throw new Error(`工程清单包含重复媒体 ID：${media.id}`);
    if (mediaPaths.has(media.path)) throw new Error(`工程清单包含重复媒体路径：${media.path}`);
    mediaIds.add(media.id);
    mediaPaths.add(media.path);
  }
  const referencedIds = getCreativeProjectReferencedMediaIds(manifest.workspace);
  const missingReference = referencedIds.find((id) => !mediaIds.has(id));
  if (missingReference) throw new Error(`工程 ZIP 缺少引用媒体：${missingReference}`);
  const extraMedia = manifest.media.find(
    (media) => !referencedIds.includes(media.id) && (!media.proxyOf || !referencedIds.includes(media.proxyOf)),
  );
  if (extraMedia) throw new Error(`工程 ZIP 包含未引用媒体：${extraMedia.id}`);
  const invalidProxy = manifest.media.find((media) => {
    if (!media.proxyOf) return false;
    const original = manifest.media.find((candidate) => candidate.id === media.proxyOf);
    return !original || original.proxyOf || original.kind !== media.kind;
  });
  if (invalidProxy) throw new Error(`工程 ZIP 包含无效代理媒体：${invalidProxy.id}`);
  const unexpectedEntry = entries.find(
    (entry) =>
      !entry.dir &&
      entry.name !== CREATIVE_PROJECT_BUNDLE_MANIFEST_PATH &&
      !mediaPaths.has(entry.name) &&
      !stageAssetPaths.has(entry.name),
  );
  if (unexpectedEntry) throw new Error(`工程 ZIP 包含未声明文件：${unexpectedEntry.name}`);
  const unexpectedDirectory = entries.find(
    (entry) => entry.dir && entry.name !== "media/" && entry.name !== "stage-assets/",
  );
  if (unexpectedDirectory) throw new Error(`工程 ZIP 包含未声明目录：${unexpectedDirectory.name}`);

  const staged: Array<{ media: BundleMedia; blob: Blob }> = [];
  let totalMediaBytes = 0;
  for (const media of manifest.media) {
    const entry = zip.file(media.path);
    if (!entry || entry.dir) throw new Error(`工程 ZIP 缺少媒体文件：${media.path}`);
    const declaredSize = declaredUncompressedSize(entry);
    if (declaredSize !== null && declaredSize > CREATIVE_PROJECT_BUNDLE_LIMITS.maxMediaBytes) {
      throw new Error(`媒体 ${media.id} 超过单文件大小限制`);
    }
    const bytes = await entry.async("uint8array");
    if (bytes.byteLength !== media.size) throw new Error(`媒体 ${media.id} 的大小与清单不一致`);
    totalMediaBytes += bytes.byteLength;
    if (totalMediaBytes > CREATIVE_PROJECT_BUNDLE_LIMITS.maxTotalMediaBytes) {
      throw new Error("工程媒体总大小超过导入限制");
    }
    staged.push({ media, blob: new Blob([bytes], { type: media.mimeType }) });
  }
  const stagedStageAssets = manifest.stage ? await readStageAssets(zip, manifest.stage) : [];

  // Model re-registration runs before the media library is mutated, so an
  // unreachable gateway aborts the import without leaving partial media.
  const restoredStageProject =
    stageProject === null
      ? null
      : await restoreStageAssets(
          stageProject,
          stagedStageAssets,
          options.stageAssetUploader ?? defaultStageAssetUploader,
        );

  const mediaLibrary = options.mediaLibrary ?? persistentCreativeMediaLibrary;
  const mediaIdMap = new Map<string, string>();
  const orderedStaged = [...staged].sort(
    (left, right) => Number(Boolean(left.media.proxyOf)) - Number(Boolean(right.media.proxyOf)),
  );
  for (const { media, blob } of orderedStaged) {
    const imported = await mediaLibrary.importBlob(blob, {
      kind: media.kind,
      name: media.name,
      fileName: media.fileName,
      durationSec: media.durationSec,
      width: media.width,
      height: media.height,
      source: media.source ?? "project-bundle",
      waveform: media.waveform ?? null,
      proxyOf: media.proxyOf ? (mediaIdMap.get(media.proxyOf) ?? media.proxyOf) : null,
      proxyProfile: media.proxyProfile ?? null,
      playbackPreference: media.playbackPreference ?? "auto",
      embeddedMetadata: media.embeddedMetadata ?? null,
      transcript: media.transcript ?? null,
    });
    mediaIdMap.set(media.id, imported.id);
  }
  const remappedWorkspace = remapWorkspaceMediaIds(manifest.workspace, mediaIdMap);
  const serialized = assertWorkspaceCanLoad(remappedWorkspace);
  return {
    serialized,
    mediaIdMap,
    importedMediaIds: [...new Set(mediaIdMap.values())],
    exportedAt: manifest.exportedAt,
    stageProject: restoredStageProject,
  };
}
