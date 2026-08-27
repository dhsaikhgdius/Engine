/**
 * The persistent creative media library: content-addressed image/video/audio
 * assets stored in IndexedDB (with an in-memory fallback for tests/private
 * modes), exposed as a vanilla Zustand store plus React hooks.
 *
 * Responsibilities: import/relink files, hydrate object URLs on demand, track
 * availability (offline assets keep metadata but lose bytes), cache audio
 * waveforms and transcripts, and persist playback preferences and proxy
 * profiles. This is the single source of media truth shared by the Canvas
 * board, video editor, gallery, and generation bridges.
 */
import { useEffect } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { errorMessage } from "../../../../../../packages/protocol/src/primitives";
import creativeMediaFormats from "./creativeMediaFormats.json";
import {
  generateCreativeMediaWaveform,
  isCreativeMediaWaveformData,
  type CreativeMediaPlaybackPreference,
  type CreativeMediaProxyProfile,
  type CreativeMediaWaveformData,
  type GenerateCreativeMediaWaveformOptions,
} from "./creativeMediaEngineering";
import type { DirectorEmbeddedMediaMetadata } from "./pngMetadata";
import {
  directorMediaTranscriptSchema,
  type DirectorMediaTranscript,
} from "../../../../../../packages/protocol/src/mediaTranscriptionProtocol";

/** IndexedDB database name for the creative media library. */
export const CREATIVE_MEDIA_DATABASE_NAME = "director-creative-media";
/** IndexedDB schema version for the creative media library. */
export const CREATIVE_MEDIA_DATABASE_VERSION = 1;
/** IndexedDB object store name for media records. */
export const CREATIVE_MEDIA_OBJECT_STORE = "media";

/** Discriminated media kind: image, video, or audio. */
export type CreativeMediaKind = keyof typeof creativeMediaFormats.defaultMimeTypes;
/** Ordered list of all supported media kinds. */
export const CREATIVE_MEDIA_KINDS = Object.keys(creativeMediaFormats.defaultMimeTypes) as [
  CreativeMediaKind,
  ...CreativeMediaKind[],
];
/** Whether the library stores data in IndexedDB or in-memory. */
export type CreativeMediaStorageMode = "indexeddb" | "memory";
/** Lifecycle status of the media library. */
export type CreativeMediaLibraryStatus = "idle" | "hydrating" | "ready" | "error";

/** Persisted metadata for a creative media asset, independent of runtime object URLs. */
export interface CreativeMediaMetadata {
  /** Content-addressed stable id. */
  id: string;
  /** Media kind: image, video, or audio. */
  kind: CreativeMediaKind;
  /** Display name. */
  name: string;
  /** Original file name. */
  fileName: string;
  /** MIME type. */
  mimeType: string;
  /** File size in bytes. */
  size: number;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  /** Last modified timestamp from the file system, or null. */
  lastModified: number | null;
  /** Duration in seconds, or null if unknown. */
  durationSec: number | null;
  /** Width in pixels, or null. */
  width: number | null;
  /** Height in pixels, or null. */
  height: number | null;
  /** Original source URL, or null for locally imported files. */
  source: string | null;
  /** Bounded embedded file metadata (for example ComfyUI PNG prompt/workflow text chunks). */
  embeddedMetadata?: DirectorEmbeddedMediaMetadata | null;
  /** Cached, content-derived envelope used by the editing timeline. */
  waveform?: CreativeMediaWaveformData | null;
  /** Durable speech-to-text result tied to this exact content-addressed source. */
  transcript?: DirectorMediaTranscript | null;
  /** A proxy is a separately persisted asset linked back to its original. */
  proxyOf?: string | null;
  /** Technical metadata about the proxy encode. */
  proxyProfile?: CreativeMediaProxyProfile | null;
  /** Persisted source choice; auto remains policy-driven as proxies change. */
  playbackPreference?: CreativeMediaPlaybackPreference;
}

/** A runtime asset with resolved object URL for in-browser playback. */
export interface CreativeMediaAsset extends CreativeMediaMetadata {
  /** Live blob URL; null when the blob hasn't been hydrated yet. */
  objectUrl: string | null;
}

/** A persisted record including the raw blob for storage. */
export interface CreativeMediaStoredRecord extends CreativeMediaMetadata {
  /** The raw media bytes. */
  blob: Blob;
}

/** Options passed to importBlob/importFile with optional overrides. */
export interface CreativeMediaImportOptions {
  /** Override the inferred media kind. */
  kind?: CreativeMediaKind;
  /** Override display name. */
  name?: string;
  /** Override file name. */
  fileName?: string;
  /** Pre-probed duration in seconds. */
  durationSec?: number | null;
  /** Pre-probed width. */
  width?: number | null;
  /** Pre-probed height. */
  height?: number | null;
  /** Source URL. */
  source?: string | null;
  /** Pre-extracted embedded metadata. */
  embeddedMetadata?: DirectorEmbeddedMediaMetadata | null;
  /** Pre-computed waveform. */
  waveform?: CreativeMediaWaveformData | null;
  /** Pre-existing transcript. */
  transcript?: DirectorMediaTranscript | null;
  /** Id of the original asset this is a proxy for. */
  proxyOf?: string | null;
  /** Proxy encode metadata. */
  proxyProfile?: CreativeMediaProxyProfile | null;
  /** Playback preference. */
  playbackPreference?: CreativeMediaPlaybackPreference;
}

/** Pluggable storage backend for the creative media library. */
export interface CreativeMediaPersistenceBackend {
  /** Which storage mode this backend uses. */
  readonly mode: CreativeMediaStorageMode;
  /** Human-readable warning when the backend is degraded, or null. */
  readonly warning: string | null;
  /** Lists all stored records. */
  list(): Promise<CreativeMediaStoredRecord[]>;
  /** Gets a single record by id, or null. */
  get(id: string): Promise<CreativeMediaStoredRecord | null>;
  /** Upserts a record. */
  put(record: CreativeMediaStoredRecord): Promise<void>;
  /** Deletes a record by id. */
  delete(id: string): Promise<void>;
  /** Deletes all records. */
  clear(): Promise<void>;
  /** Closes the backend and releases any held resources. */
  close(): void;
}

/** Factory for creating and revoking blob object URLs. */
export interface CreativeMediaObjectUrlFactory {
  /** Creates a blob URL; may return null in restricted environments. */
  createObjectURL(blob: Blob): string | null;
  /** Revokes a previously created URL. */
  revokeObjectURL(url: string): void;
}

/** Zustand-published state of the creative media library. */
export interface PersistentCreativeMediaState {
  /** Lifecycle status. */
  status: CreativeMediaLibraryStatus;
  /** Active storage mode. */
  storageMode: CreativeMediaStorageMode;
  /** Human-readable warning, or null. */
  warning: string | null;
  /** Last error message, or null. */
  error: string | null;
  /** All loaded assets, sorted by creation time. */
  assets: readonly CreativeMediaAsset[];
}

/** The public API surface of the creative media library. */
export interface PersistentCreativeMediaLibrary {
  /** The underlying Zustand store for direct subscription. */
  readonly store: StoreApi<PersistentCreativeMediaState>;
  /** Hydrates the store from the backend; no-op if already ready. */
  initialize(): Promise<void>;
  /** Imports a raw blob, computing its content-addressed id. */
  importBlob(blob: Blob, options?: CreativeMediaImportOptions): Promise<CreativeMediaAsset>;
  /** Imports a File, using its name as the default fileName. */
  importFile(file: File, options?: Omit<CreativeMediaImportOptions, "fileName">): Promise<CreativeMediaAsset>;
  /** Imports multiple files concurrently. */
  importFiles(
    files: Iterable<File> | ArrayLike<File>,
    options?: Omit<CreativeMediaImportOptions, "fileName">,
  ): Promise<CreativeMediaAsset[]>;
  /** Looks up an asset by id from the in-memory cache. */
  getAsset(id: string): CreativeMediaAsset | null;
  /** Returns all loaded assets. */
  listAssets(): readonly CreativeMediaAsset[];
  /** Retrieves the raw blob from the backend. */
  getBlob(id: string): Promise<Blob | null>;
  /** Ensures a waveform exists for the given asset; no-op for images. */
  ensureWaveform(id: string, options?: GenerateCreativeMediaWaveformOptions): Promise<CreativeMediaWaveformData | null>;
  /** Persists a transcript against the original media (not a proxy). */
  setTranscript(id: string, transcript: DirectorMediaTranscript | null): Promise<CreativeMediaAsset | null>;
  /** Creates a new proxy asset linked to the original. */
  attachProxy(
    originalId: string,
    proxy: Blob,
    options?: Omit<CreativeMediaImportOptions, "proxyOf">,
  ): Promise<CreativeMediaAsset>;
  /** Links an existing asset as a proxy of another. */
  attachExistingProxy(originalId: string, proxyId: string): CreativeMediaAsset | null;
  /** Synchronously updates the playback preference in the store and persists it. */
  updatePlaybackPreference(id: string, preference: CreativeMediaPlaybackPreference): CreativeMediaAsset | null;
  /** Asynchronously persists a playback preference after initialization. */
  setPlaybackPreference(id: string, preference: CreativeMediaPlaybackPreference): Promise<CreativeMediaAsset | null>;
  /** Removes an asset and its proxies; returns true if something was deleted. */
  remove(id: string): Promise<boolean>;
  /** Clears all assets and object URLs. */
  clear(): Promise<void>;
  /** Disposes of the library, closing the backend and revoking all URLs. */
  dispose(): void;
}

/** Options for constructing a creative media library. */
export interface CreatePersistentCreativeMediaLibraryOptions {
  /** Optional custom backend; defaults to IndexedDB with memory fallback. */
  backend?: CreativeMediaPersistenceBackend;
  /** Optional IndexedDB factory; defaults to globalThis.indexedDB. */
  indexedDB?: IDBFactory | null;
  /** Optional object URL factory; defaults to global URL. */
  objectUrls?: CreativeMediaObjectUrlFactory;
  /** Optional clock; defaults to new Date(). */
  now?: () => Date;
  /** Optional blob hasher; defaults to SHA-256 with FNV-1a-64 fallback. */
  hashBlob?: (blob: Blob) => Promise<string>;
}

const MEDIA_KINDS = new Set(CREATIVE_MEDIA_KINDS);
const EXTENSION_KIND = new Map(
  Object.entries(creativeMediaFormats.extensionKinds) as Array<[string, CreativeMediaKind]>,
);
const DEFAULT_MIME_TYPE = creativeMediaFormats.defaultMimeTypes as Record<CreativeMediaKind, string>;

function isBlobValue(value: unknown): value is Blob {
  if (!value || typeof value !== "object") return false;
  if (typeof Blob !== "undefined" && value instanceof Blob) return true;
  const candidate = value as Partial<Blob>;
  return (
    typeof candidate.size === "number" &&
    typeof candidate.type === "string" &&
    typeof candidate.arrayBuffer === "function" &&
    typeof candidate.slice === "function"
  );
}

function isStoredRecord(value: unknown): value is CreativeMediaStoredRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<CreativeMediaStoredRecord>;
  return (
    typeof record.id === "string" &&
    record.id.length > 0 &&
    typeof record.kind === "string" &&
    MEDIA_KINDS.has(record.kind as CreativeMediaKind) &&
    typeof record.name === "string" &&
    typeof record.fileName === "string" &&
    typeof record.mimeType === "string" &&
    typeof record.size === "number" &&
    Number.isFinite(record.size) &&
    record.size >= 0 &&
    typeof record.createdAt === "string" &&
    isBlobValue(record.blob) &&
    (record.embeddedMetadata === undefined ||
      record.embeddedMetadata === null ||
      (typeof record.embeddedMetadata === "object" &&
        Object.values(record.embeddedMetadata).every((entry) => typeof entry === "string"))) &&
    (record.transcript === undefined ||
      record.transcript === null ||
      directorMediaTranscriptSchema.safeParse(record.transcript).success)
  );
}

function getFileName(blob: Blob): string | null {
  const candidate = blob as Partial<File>;
  return typeof candidate.name === "string" && candidate.name.trim() ? candidate.name.trim() : null;
}

function getLastModified(blob: Blob): number | null {
  const candidate = blob as Partial<File>;
  return typeof candidate.lastModified === "number" && Number.isFinite(candidate.lastModified)
    ? candidate.lastModified
    : null;
}

function getExtension(fileName: string): string {
  const lastDot = fileName.lastIndexOf(".");
  return lastDot >= 0 ? fileName.slice(lastDot + 1).toLowerCase() : "";
}

function stripExtension(fileName: string): string {
  const lastDot = fileName.lastIndexOf(".");
  return (lastDot > 0 ? fileName.slice(0, lastDot) : fileName).trim();
}

function inferMediaKind(blob: Blob, fileName: string, requestedKind?: CreativeMediaKind): CreativeMediaKind {
  if (requestedKind) return requestedKind;
  const mimePrefix = blob.type.trim().toLowerCase().split("/", 1)[0];
  if (mimePrefix && MEDIA_KINDS.has(mimePrefix as CreativeMediaKind)) return mimePrefix as CreativeMediaKind;
  const extensionKind = EXTENSION_KIND.get(getExtension(fileName));
  if (extensionKind) return extensionKind;
  throw new Error("无法识别媒体类型；请为 Blob 指定 image、video 或 audio kind");
}

function nullablePositiveNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function nullablePositiveInteger(value: number | null | undefined): number | null {
  const normalized = nullablePositiveNumber(value);
  return normalized === null ? null : Math.round(normalized);
}

function toAsset(record: CreativeMediaStoredRecord, objectUrl: string | null): CreativeMediaAsset {
  const { blob: _blob, ...metadata } = record;
  return { ...metadata, objectUrl };
}

function sortAssets(assets: CreativeMediaAsset[]): CreativeMediaAsset[] {
  return assets.sort((left, right) => {
    const byCreatedAt = right.createdAt.localeCompare(left.createdAt);
    return byCreatedAt || left.id.localeCompare(right.id);
  });
}

/** Soft import guidance threshold; hashing still proceeds above this size. */
export const CREATIVE_MEDIA_LARGE_IMPORT_BYTES = 64 * 1024 * 1024;
/** Chunk size for streaming blob reads during content hashing. */
export const CREATIVE_MEDIA_HASH_CHUNK_BYTES = 1024 * 1024;

function fallbackHashBlobSyncChunks(blob: Blob, chunkBytes: number): Promise<string> {
  return (async () => {
    let hash = 0xcbf29ce484222325n;
    const prime = 0x100000001b3n;
    const mask = 0xffffffffffffffffn;
    let offset = 0;
    while (offset < blob.size) {
      const end = Math.min(offset + chunkBytes, blob.size);
      const chunk = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
      for (const byte of chunk) {
        hash ^= BigInt(byte);
        hash = (hash * prime) & mask;
      }
      offset = end;
      // Yield so large imports do not monopolize the main thread.
      await Promise.resolve();
    }
    return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
  })();
}

function digestToSha256Hex(digest: ArrayBuffer): string {
  const bytes = new Uint8Array(digest);
  const hexadecimal = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `sha256:${hexadecimal}`;
}

/**
 * Computes a content-addressed hash for a blob.
 *
 * Uses SHA-256 when available via Web Crypto. Large blobs are read in chunks
 * and only assembled for the digest call so callers can interleave other work
 * between slices; the FNV-1a-64 fallback hashes chunk-by-chunk without retaining
 * the full byte array.
 *
 * @param blob - The blob to hash.
 * @returns A prefixed hash string like "sha256:..." or "fnv1a64:...".
 */
export async function hashCreativeMediaBlob(blob: Blob): Promise<string> {
  const chunkBytes = CREATIVE_MEDIA_HASH_CHUNK_BYTES;
  try {
    const subtle = globalThis.crypto?.subtle;
    if (subtle) {
      if (blob.size <= chunkBytes) {
        const digest = await subtle.digest("SHA-256", await blob.arrayBuffer());
        return digestToSha256Hex(digest);
      }
      // Chunked read keeps peak temporary buffers to one slice at a time until
      // the final contiguous view required by SubtleCrypto.digest.
      const assembled = new Uint8Array(blob.size);
      let offset = 0;
      while (offset < blob.size) {
        const end = Math.min(offset + chunkBytes, blob.size);
        const chunk = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
        assembled.set(chunk, offset);
        offset = end;
        await Promise.resolve();
      }
      const digest = await subtle.digest("SHA-256", assembled);
      return digestToSha256Hex(digest);
    }
  } catch {
    // Older webviews may expose crypto.subtle but reject digest operations.
  }
  return fallbackHashBlobSyncChunks(blob, chunkBytes);
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

/** IndexedDB-backed persistence backend for creative media assets. */
export class IndexedDbCreativeMediaBackend implements CreativeMediaPersistenceBackend {
  readonly mode = "indexeddb" as const;
  readonly warning = null;
  private databasePromise: Promise<IDBDatabase> | null = null;

  constructor(
    private readonly factory: IDBFactory,
    private readonly databaseName = CREATIVE_MEDIA_DATABASE_NAME,
    private readonly objectStoreName = CREATIVE_MEDIA_OBJECT_STORE,
  ) {}

  private openDatabase(): Promise<IDBDatabase> {
    if (this.databasePromise) return this.databasePromise;
    this.databasePromise = new Promise((resolve, reject) => {
      const request = this.factory.open(this.databaseName, CREATIVE_MEDIA_DATABASE_VERSION);
      let rejected = false;
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(this.objectStoreName)) {
          request.result.createObjectStore(this.objectStoreName, { keyPath: "id" });
        }
      };
      request.onsuccess = () => {
        if (rejected) {
          request.result.close();
          return;
        }
        resolve(request.result);
      };
      request.onerror = () => reject(request.error ?? new Error("Unable to open IndexedDB"));
      request.onblocked = () => {
        rejected = true;
        reject(new Error("IndexedDB upgrade is blocked by another page"));
      };
    });
    return this.databasePromise;
  }

  async list(): Promise<CreativeMediaStoredRecord[]> {
    const database = await this.openDatabase();
    const transaction = database.transaction(this.objectStoreName, "readonly");
    const completed = transactionComplete(transaction);
    const records = await requestResult(transaction.objectStore(this.objectStoreName).getAll());
    await completed;
    return records.filter(isStoredRecord);
  }

  async get(id: string): Promise<CreativeMediaStoredRecord | null> {
    const database = await this.openDatabase();
    const transaction = database.transaction(this.objectStoreName, "readonly");
    const completed = transactionComplete(transaction);
    const record: unknown = await requestResult(transaction.objectStore(this.objectStoreName).get(id));
    await completed;
    return isStoredRecord(record) ? record : null;
  }

  async put(record: CreativeMediaStoredRecord): Promise<void> {
    const database = await this.openDatabase();
    const transaction = database.transaction(this.objectStoreName, "readwrite");
    const completed = transactionComplete(transaction);
    await requestResult(transaction.objectStore(this.objectStoreName).put(record));
    await completed;
  }

  async delete(id: string): Promise<void> {
    const database = await this.openDatabase();
    const transaction = database.transaction(this.objectStoreName, "readwrite");
    const completed = transactionComplete(transaction);
    await requestResult(transaction.objectStore(this.objectStoreName).delete(id));
    await completed;
  }

  async clear(): Promise<void> {
    const database = await this.openDatabase();
    const transaction = database.transaction(this.objectStoreName, "readwrite");
    const completed = transactionComplete(transaction);
    await requestResult(transaction.objectStore(this.objectStoreName).clear());
    await completed;
  }

  close(): void {
    const pendingDatabase = this.databasePromise;
    this.databasePromise = null;
    if (!pendingDatabase) return;
    void pendingDatabase.then((database) => database.close()).catch(() => undefined);
  }
}

/** In-memory persistence backend used as a fallback when IndexedDB is unavailable. */
export class MemoryCreativeMediaBackend implements CreativeMediaPersistenceBackend {
  readonly mode = "memory" as const;
  readonly warning: string | null;
  private readonly records = new Map<string, CreativeMediaStoredRecord>();

  constructor(warning: string | null = null) {
    this.warning = warning;
  }

  async list(): Promise<CreativeMediaStoredRecord[]> {
    return Array.from(this.records.values());
  }

  async get(id: string): Promise<CreativeMediaStoredRecord | null> {
    return this.records.get(id) ?? null;
  }

  async put(record: CreativeMediaStoredRecord): Promise<void> {
    this.records.set(record.id, record);
  }

  async delete(id: string): Promise<void> {
    this.records.delete(id);
  }

  async clear(): Promise<void> {
    this.records.clear();
  }

  close(): void {}

  replace(records: CreativeMediaStoredRecord[]): void {
    this.records.clear();
    records.forEach((record) => this.records.set(record.id, record));
  }
}

class FallbackCreativeMediaBackend implements CreativeMediaPersistenceBackend {
  private primary: CreativeMediaPersistenceBackend | null;
  private readonly memory: MemoryCreativeMediaBackend;
  private fallbackWarning: string | null;

  constructor(primary: CreativeMediaPersistenceBackend | null) {
    this.primary = primary;
    this.fallbackWarning = primary ? null : "IndexedDB 不可用，媒体将在当前页面会话中安全保留";
    this.memory = new MemoryCreativeMediaBackend(this.fallbackWarning);
  }

  get mode(): CreativeMediaStorageMode {
    return this.primary ? "indexeddb" : "memory";
  }

  get warning(): string | null {
    return this.fallbackWarning;
  }

  private disablePrimary(error: unknown): void {
    this.primary?.close();
    this.primary = null;
    this.fallbackWarning = `IndexedDB 不可用，已切换到内存存储：${errorMessage(error)}`;
  }

  async list(): Promise<CreativeMediaStoredRecord[]> {
    if (!this.primary) return this.memory.list();
    try {
      const records = await this.primary.list();
      this.memory.replace(records);
      return records;
    } catch (error) {
      this.disablePrimary(error);
      return this.memory.list();
    }
  }

  async get(id: string): Promise<CreativeMediaStoredRecord | null> {
    if (!this.primary) return this.memory.get(id);
    try {
      const record = await this.primary.get(id);
      if (record) await this.memory.put(record);
      return record;
    } catch (error) {
      this.disablePrimary(error);
      return this.memory.get(id);
    }
  }

  async put(record: CreativeMediaStoredRecord): Promise<void> {
    await this.memory.put(record);
    if (!this.primary) return;
    try {
      await this.primary.put(record);
    } catch (error) {
      this.disablePrimary(error);
    }
  }

  async delete(id: string): Promise<void> {
    await this.memory.delete(id);
    if (!this.primary) return;
    try {
      await this.primary.delete(id);
    } catch (error) {
      this.disablePrimary(error);
    }
  }

  async clear(): Promise<void> {
    await this.memory.clear();
    if (!this.primary) return;
    try {
      await this.primary.clear();
    } catch (error) {
      this.disablePrimary(error);
    }
  }

  close(): void {
    this.primary?.close();
    this.memory.close();
  }
}

function getDefaultIndexedDbFactory(): IDBFactory | null {
  try {
    return typeof globalThis.indexedDB === "undefined" ? null : globalThis.indexedDB;
  } catch {
    return null;
  }
}

const defaultObjectUrls: CreativeMediaObjectUrlFactory = {
  createObjectURL(blob) {
    return typeof URL !== "undefined" && typeof URL.createObjectURL === "function" ? URL.createObjectURL(blob) : null;
  },
  revokeObjectURL(url) {
    if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(url);
  },
};

/**
 * Creates a persistent creative media library.
 *
 * Operations are serialized through an internal queue to prevent concurrent
 * IndexedDB transactions. The library automatically falls back to in-memory
 * storage when IndexedDB is unavailable or fails.
 *
 * @param options - Optional backend, object URL, clock, and hasher overrides.
 * @returns A new library instance.
 */
export function createPersistentCreativeMediaLibrary(
  options: CreatePersistentCreativeMediaLibraryOptions = {},
): PersistentCreativeMediaLibrary {
  const hasIndexedDbOverride = Object.prototype.hasOwnProperty.call(options, "indexedDB");
  const indexedDbFactory = hasIndexedDbOverride ? (options.indexedDB ?? null) : getDefaultIndexedDbFactory();
  const backend =
    options.backend ??
    new FallbackCreativeMediaBackend(indexedDbFactory ? new IndexedDbCreativeMediaBackend(indexedDbFactory) : null);
  const objectUrls = options.objectUrls ?? defaultObjectUrls;
  const now = options.now ?? (() => new Date());
  const hashBlob = options.hashBlob ?? hashCreativeMediaBlob;
  const urlsById = new Map<string, string>();
  const store = createStore<PersistentCreativeMediaState>(() => ({
    status: "idle",
    storageMode: backend.mode,
    warning: backend.warning,
    error: null,
    assets: [],
  }));
  let initializePromise: Promise<void> | null = null;
  let lifecycleGeneration = 0;
  let operationQueue: Promise<void> = Promise.resolve();
  let objectUrlWarning: string | null = null;
  let largeImportWarning: string | null = null;

  function runtimeWarning(): string | null {
    return [backend.warning, objectUrlWarning, largeImportWarning].filter(Boolean).join(" · ") || null;
  }

  function updateRuntimeFlags(): void {
    store.setState({ storageMode: backend.mode, warning: runtimeWarning() });
  }

  function revokeUrl(id: string): void {
    const url = urlsById.get(id);
    if (!url) return;
    urlsById.delete(id);
    try {
      objectUrls.revokeObjectURL(url);
    } catch {
      // Revocation failure is harmless; the browser will release it at page teardown.
    }
  }

  function revokeAllUrls(): void {
    Array.from(urlsById.keys()).forEach(revokeUrl);
  }

  function createUrl(id: string, blob: Blob): string | null {
    revokeUrl(id);
    try {
      const url = objectUrls.createObjectURL(blob);
      if (url) urlsById.set(id, url);
      return url;
    } catch (error) {
      objectUrlWarning = `媒体预览 URL 创建失败：${errorMessage(error)}`;
      return null;
    }
  }

  async function initialize(): Promise<void> {
    if (store.getState().status === "ready") return;
    if (initializePromise) return initializePromise;
    const generation = lifecycleGeneration;
    store.setState({ status: "hydrating", error: null });
    initializePromise = (async () => {
      try {
        const records = await backend.list();
        if (generation !== lifecycleGeneration) return;
        revokeAllUrls();
        const assets = sortAssets(records.map((record) => toAsset(record, createUrl(record.id, record.blob))));
        store.setState({
          status: "ready",
          storageMode: backend.mode,
          warning: runtimeWarning(),
          error: null,
          assets,
        });
      } catch (error) {
        if (generation !== lifecycleGeneration) return;
        store.setState({
          status: "error",
          storageMode: backend.mode,
          warning: runtimeWarning(),
          error: errorMessage(error),
        });
        throw error;
      } finally {
        initializePromise = null;
      }
    })();
    return initializePromise;
  }

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = operationQueue.then(operation, operation);
    operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function importBlob(blob: Blob, importOptions: CreativeMediaImportOptions = {}): Promise<CreativeMediaAsset> {
    return enqueue(async () => {
      await initialize();
      if (!isBlobValue(blob)) throw new TypeError("importBlob expects a Blob or File");
      const fileName = importOptions.fileName?.trim() || getFileName(blob) || "untitled-media";
      const kind = inferMediaKind(blob, fileName, importOptions.kind);
      const proxyOf = importOptions.proxyOf?.trim() || null;
      if (proxyOf) {
        const original = store.getState().assets.find((asset) => asset.id === proxyOf);
        if (!original) throw new Error(`代理媒体的原始素材不存在：${proxyOf}`);
        if (original.proxyOf) throw new Error("不能为代理媒体继续关联代理");
        if (original.kind !== kind) throw new Error("代理媒体类型必须与原始素材一致");
      }
      largeImportWarning =
        blob.size >= CREATIVE_MEDIA_LARGE_IMPORT_BYTES
          ? `导入素材约 ${Math.max(1, Math.round(blob.size / (1024 * 1024)))} MB，内容哈希按分块读取；建议优先生成代理媒体以降低后续编辑压力。`
          : null;
      const digest = await hashBlob(blob);
      const contentId = `creative-media:${kind}:${digest}`;
      const id = proxyOf ? `${contentId}:proxy-of:${encodeURIComponent(proxyOf)}` : contentId;
      const existing = store.getState().assets.find((asset) => asset.id === id);
      if (existing) return existing;

      const requestedName = importOptions.name?.trim();
      const record: CreativeMediaStoredRecord = {
        id,
        kind,
        name: requestedName || stripExtension(fileName) || fileName,
        fileName,
        mimeType: blob.type.trim().toLowerCase() || DEFAULT_MIME_TYPE[kind],
        size: blob.size,
        createdAt: now().toISOString(),
        lastModified: getLastModified(blob),
        durationSec: nullablePositiveNumber(importOptions.durationSec),
        width: nullablePositiveInteger(importOptions.width),
        height: nullablePositiveInteger(importOptions.height),
        source: importOptions.source?.trim() || null,
        embeddedMetadata: importOptions.embeddedMetadata ? { ...importOptions.embeddedMetadata } : null,
        waveform: isCreativeMediaWaveformData(importOptions.waveform) ? importOptions.waveform : null,
        transcript: importOptions.transcript ? directorMediaTranscriptSchema.parse(importOptions.transcript) : null,
        proxyOf,
        proxyProfile: importOptions.proxyProfile ?? null,
        playbackPreference: importOptions.playbackPreference ?? "auto",
        blob,
      };
      await backend.put(record);
      const asset = toAsset(record, createUrl(id, blob));
      store.setState((state) => ({
        status: "ready",
        storageMode: backend.mode,
        warning: runtimeWarning(),
        error: null,
        assets: sortAssets([...state.assets, asset]),
      }));
      return asset;
    });
  }

  async function importFile(
    file: File,
    importOptions: Omit<CreativeMediaImportOptions, "fileName"> = {},
  ): Promise<CreativeMediaAsset> {
    return importBlob(file, { ...importOptions, fileName: file.name });
  }

  async function importFiles(
    files: Iterable<File> | ArrayLike<File>,
    importOptions: Omit<CreativeMediaImportOptions, "fileName"> = {},
  ): Promise<CreativeMediaAsset[]> {
    return Promise.all(Array.from(files).map((file) => importFile(file, importOptions)));
  }

  function getAsset(id: string): CreativeMediaAsset | null {
    return store.getState().assets.find((asset) => asset.id === id) ?? null;
  }

  function listAssets(): readonly CreativeMediaAsset[] {
    return store.getState().assets;
  }

  async function getBlob(id: string): Promise<Blob | null> {
    await initialize();
    const record = await backend.get(id);
    updateRuntimeFlags();
    return record?.blob ?? null;
  }

  async function ensureWaveform(
    id: string,
    waveformOptions: GenerateCreativeMediaWaveformOptions = {},
  ): Promise<CreativeMediaWaveformData | null> {
    return enqueue(async () => {
      await initialize();
      const asset = getAsset(id);
      if (!asset || asset.kind === "image") return null;
      if (isCreativeMediaWaveformData(asset.waveform)) return asset.waveform;
      const record = await backend.get(id);
      if (!record) return null;
      const waveform = await generateCreativeMediaWaveform(record.blob, waveformOptions);
      if (!waveform) return null;
      const updated = { ...record, waveform };
      await backend.put(updated);
      store.setState((state) => ({
        storageMode: backend.mode,
        warning: runtimeWarning(),
        error: null,
        assets: state.assets.map((entry) => (entry.id === id ? { ...entry, waveform } : entry)),
      }));
      return waveform;
    });
  }

  async function attachProxy(
    originalId: string,
    proxy: Blob,
    proxyOptions: Omit<CreativeMediaImportOptions, "proxyOf"> = {},
  ): Promise<CreativeMediaAsset> {
    await initialize();
    const original = getAsset(originalId);
    if (!original) throw new Error(`代理媒体的原始素材不存在：${originalId}`);
    if (original.proxyOf) throw new Error("不能为代理媒体继续关联代理");
    const requestedKind =
      proxyOptions.kind ?? inferMediaKind(proxy, proxyOptions.fileName ?? getFileName(proxy) ?? "proxy");
    if (requestedKind !== original.kind) throw new Error("代理媒体类型必须与原始素材一致");
    return importBlob(proxy, {
      ...proxyOptions,
      kind: requestedKind,
      proxyOf: originalId,
      source: proxyOptions.source ?? "user-proxy",
    });
  }

  async function setTranscript(id: string, transcriptInput: DirectorMediaTranscript | null) {
    return enqueue(async () => {
      await initialize();
      const asset = getAsset(id);
      if (!asset) return null;
      if (asset.kind === "image") throw new Error("图片素材不能保存语音转录");
      if (asset.proxyOf) throw new Error("转录必须绑定到原始媒体，而不是代理媒体");
      const transcript = transcriptInput ? directorMediaTranscriptSchema.parse(transcriptInput) : null;
      if (transcript && transcript.sourceMediaId !== id) {
        throw new Error("转录结果与目标媒体 ID 不匹配");
      }
      const record = await backend.get(id);
      if (!record) return null;
      const updatedRecord = { ...record, transcript };
      await backend.put(updatedRecord);
      let updatedAsset: CreativeMediaAsset | null = null;
      store.setState((state) => ({
        storageMode: backend.mode,
        warning: runtimeWarning(),
        error: null,
        assets: state.assets.map((entry) => {
          if (entry.id !== id) return entry;
          updatedAsset = { ...entry, transcript };
          return updatedAsset;
        }),
      }));
      return updatedAsset;
    });
  }

  function persistMetadataPatch(
    id: string,
    patch: Partial<Pick<CreativeMediaMetadata, "proxyOf" | "playbackPreference">>,
  ): void {
    const generation = lifecycleGeneration;
    void enqueue(async () => {
      await initialize();
      const record = await backend.get(id);
      if (!record) throw new Error(`媒体素材不存在：${id}`);
      await backend.put({ ...record, ...patch });
      if (generation === lifecycleGeneration) {
        store.setState({
          storageMode: backend.mode,
          warning: runtimeWarning(),
          error: null,
        });
      }
    }).catch((error) => {
      if (generation !== lifecycleGeneration) return;
      store.setState({
        storageMode: backend.mode,
        warning: runtimeWarning(),
        error: errorMessage(error),
      });
    });
  }

  function attachExistingProxy(originalId: string, proxyId: string): CreativeMediaAsset | null {
    const original = getAsset(originalId);
    const proxy = getAsset(proxyId);
    if (!original || !proxy) return null;
    if (original.id === proxy.id) throw new Error("原始媒体与代理媒体必须是不同素材");
    if (original.proxyOf) throw new Error("不能为代理媒体继续关联代理");
    if (original.kind !== proxy.kind) throw new Error("代理媒体类型必须与原始素材一致");
    if (proxy.proxyOf && proxy.proxyOf !== original.id) throw new Error("代理媒体已经关联到其他原始素材");
    if (store.getState().assets.some((asset) => asset.proxyOf === proxy.id)) {
      throw new Error("已有代理的原始媒体不能再作为其他素材的代理");
    }
    if (proxy.proxyOf === original.id) return proxy;

    const updated = { ...proxy, proxyOf: original.id };
    store.setState((state) => ({
      error: null,
      assets: state.assets.map((asset) => (asset.id === proxy.id ? updated : asset)),
    }));
    persistMetadataPatch(proxy.id, { proxyOf: original.id });
    return updated;
  }

  function updatePlaybackPreference(
    id: string,
    preference: CreativeMediaPlaybackPreference,
  ): CreativeMediaAsset | null {
    const asset = getAsset(id);
    if (!asset) return null;
    if (asset.proxyOf) throw new Error("播放版本偏好必须设置在原始媒体上");
    if ((asset.playbackPreference ?? "auto") === preference) return asset;

    const updated = { ...asset, playbackPreference: preference };
    store.setState((state) => ({
      error: null,
      assets: state.assets.map((entry) => (entry.id === id ? updated : entry)),
    }));
    persistMetadataPatch(id, { playbackPreference: preference });
    return updated;
  }

  async function setPlaybackPreference(
    id: string,
    preference: CreativeMediaPlaybackPreference,
  ): Promise<CreativeMediaAsset | null> {
    return enqueue(async () => {
      await initialize();
      const asset = getAsset(id);
      if (!asset) return null;
      if (asset.proxyOf) throw new Error("播放版本偏好必须设置在原始媒体上");
      if (asset.playbackPreference === preference) return asset;
      const record = await backend.get(id);
      if (!record) return null;
      const updatedRecord = { ...record, playbackPreference: preference };
      await backend.put(updatedRecord);
      let updatedAsset: CreativeMediaAsset | null = null;
      store.setState((state) => ({
        storageMode: backend.mode,
        warning: runtimeWarning(),
        error: null,
        assets: state.assets.map((entry) => {
          if (entry.id !== id) return entry;
          updatedAsset = { ...entry, playbackPreference: preference };
          return updatedAsset;
        }),
      }));
      return updatedAsset;
    });
  }

  async function remove(id: string): Promise<boolean> {
    return enqueue(async () => {
      await initialize();
      const currentAssets = store.getState().assets;
      if (!currentAssets.some((asset) => asset.id === id)) return false;
      const removedIds = new Set([
        id,
        ...currentAssets.filter((asset) => asset.proxyOf === id).map((asset) => asset.id),
      ]);
      for (const removedId of removedIds) {
        await backend.delete(removedId);
        revokeUrl(removedId);
      }
      store.setState((state) => ({
        storageMode: backend.mode,
        warning: runtimeWarning(),
        error: null,
        assets: state.assets.filter((asset) => !removedIds.has(asset.id)),
      }));
      return true;
    });
  }

  async function clear(): Promise<void> {
    return enqueue(async () => {
      await initialize();
      await backend.clear();
      revokeAllUrls();
      store.setState({
        status: "ready",
        storageMode: backend.mode,
        warning: runtimeWarning(),
        error: null,
        assets: [],
      });
    });
  }

  function dispose(): void {
    lifecycleGeneration += 1;
    initializePromise = null;
    revokeAllUrls();
    backend.close();
    store.setState({
      status: "idle",
      storageMode: backend.mode,
      warning: runtimeWarning(),
      error: null,
      assets: [],
    });
  }

  return {
    store,
    initialize,
    importBlob,
    importFile,
    importFiles,
    getAsset,
    listAssets,
    getBlob,
    ensureWaveform,
    setTranscript,
    attachProxy,
    attachExistingProxy,
    updatePlaybackPreference,
    setPlaybackPreference,
    remove,
    clear,
    dispose,
  };
}

/** Singleton creative media library instance used throughout the app. */
export const persistentCreativeMediaLibrary = createPersistentCreativeMediaLibrary();

/**
 * React hook that subscribes to a slice of the creative media library state.
 *
 * Initializes the library on first mount if it hasn't been hydrated yet.
 *
 * @param selector - A Zustand selector function.
 * @returns The selected state slice.
 */
export function usePersistentCreativeMedia<T>(selector: (state: PersistentCreativeMediaState) => T): T {
  useEffect(() => {
    void persistentCreativeMediaLibrary.initialize().catch(() => undefined);
  }, []);
  return useStore(persistentCreativeMediaLibrary.store, selector);
}

/** React hook that returns all loaded creative media assets and auto-initializes the library. */
export function usePersistentCreativeMediaAssets(): readonly CreativeMediaAsset[] {
  return usePersistentCreativeMedia((state) => state.assets);
}
