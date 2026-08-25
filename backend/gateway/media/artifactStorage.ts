import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

/**
 * Pluggable storage for durable production media and artifact bytes.
 *
 * The default backend is the local filesystem rooted at the gateway data
 * directory (the layout the {@link ProductionJobStore} and staging stores
 * already write). An object-storage backend skeleton exists behind the same
 * interface so a deployment can plug in an S3-compatible client without
 * changing job, GC, or route code; it is not a supported deployment path yet.
 */

/** Metadata for one stored artifact object. */
export interface StoredArtifactObject {
  /** POSIX-style relative key, e.g. `production-jobs/<job>/attempts/<attempt>/<file>`. */
  key: string;
  /** Object size in bytes. */
  bytes: number;
  /** Last modification instant as an ISO-8601 string. */
  modifiedAt: string;
}

/** Uniform byte-storage contract shared by the filesystem and object-storage backends. */
export interface ArtifactStorageBackend {
  /** Which backend family serves this store. */
  readonly kind: "filesystem" | "object-storage";
  /** Writes an object, replacing any existing object under the same key. */
  put(key: string, bytes: Uint8Array): Promise<StoredArtifactObject>;
  /** Reads an object's bytes, or null when the key does not exist. */
  get(key: string): Promise<Uint8Array | null>;
  /** Returns object metadata without reading bytes, or null when absent. */
  head(key: string): Promise<StoredArtifactObject | null>;
  /** Deletes an object; returns whether an object existed. */
  delete(key: string): Promise<boolean>;
  /** Lists objects whose key starts with the given prefix, sorted by key. */
  list(prefix?: string): Promise<StoredArtifactObject[]>;
}

/**
 * Validates a storage key: a relative POSIX path of safe segments. Rejects
 * absolute paths, traversal segments, backslashes, and control characters so
 * a key can never escape the storage root on any backend.
 *
 * @param key - The candidate storage key.
 * @returns The validated key.
 * @throws When the key is unsafe.
 */
export function assertArtifactStorageKey(key: string): string {
  if (!key || key.length > 1024) throw new TypeError("Artifact storage key must be 1-1024 characters");
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f]/.test(key)) throw new TypeError("Artifact storage key contains unsafe characters");
  if (key.startsWith("/") || key.endsWith("/")) throw new TypeError("Artifact storage key must be a relative path");
  for (const segment of key.split("/")) {
    if (!segment || segment === "." || segment === "..") {
      throw new TypeError("Artifact storage key contains an unsafe path segment");
    }
  }
  return key;
}

async function walkFiles(root: string, relative: string, out: StoredArtifactObject[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(join(root, relative), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await walkFiles(root, childRelative, out);
    } else if (entry.isFile()) {
      const info = await stat(join(root, childRelative));
      out.push({ key: childRelative, bytes: info.size, modifiedAt: info.mtime.toISOString() });
    }
  }
}

/**
 * Default artifact storage: files under a local root directory. Keys map
 * 1:1 onto relative paths, which makes this backend layout-compatible with
 * the durable job store (`production-jobs/…`) and the content-addressed
 * staging stores (`media-transcode-inputs/…`), so GC can enumerate real
 * gateway data without a migration.
 */
export class FilesystemArtifactStorage implements ArtifactStorageBackend {
  readonly kind = "filesystem" as const;

  /**
   * @param rootDirectory - Absolute directory that owns every stored object.
   */
  constructor(readonly rootDirectory: string) {}

  private pathFor(key: string): string {
    return join(this.rootDirectory, ...assertArtifactStorageKey(key).split("/"));
  }

  async put(key: string, bytes: Uint8Array): Promise<StoredArtifactObject> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, bytes, { flag: "wx" });
    await rename(temporaryPath, path);
    const info = await stat(path);
    return { key, bytes: info.size, modifiedAt: info.mtime.toISOString() };
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return await readFile(this.pathFor(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async head(key: string): Promise<StoredArtifactObject | null> {
    try {
      const info = await stat(this.pathFor(key));
      if (!info.isFile()) return null;
      return { key, bytes: info.size, modifiedAt: info.mtime.toISOString() };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async delete(key: string): Promise<boolean> {
    const path = this.pathFor(key);
    try {
      const info = await stat(path);
      if (!info.isFile()) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    await rm(path, { force: true });
    return true;
  }

  async list(prefix = ""): Promise<StoredArtifactObject[]> {
    const objects: StoredArtifactObject[] = [];
    await walkFiles(this.rootDirectory, "", objects);
    return objects
      .filter((object) => object.key.startsWith(prefix))
      .sort((left, right) => left.key.localeCompare(right.key));
  }

  /**
   * Streams a stored file's absolute path for callers that must hand a path
   * to an external process (e.g. ffmpeg). Object-storage backends have no
   * equivalent; callers must fall back to {@link get}.
   */
  absolutePath(key: string): string {
    return this.pathFor(key);
  }

  /** Opens a read stream over a stored object without buffering it. */
  createReadStream(key: string) {
    return createReadStream(this.pathFor(key));
  }
}

/**
 * Minimal S3-compatible client surface the object-storage backend delegates
 * to. A deployment supplies an implementation (AWS SDK, MinIO client, …);
 * the repository intentionally bundles none.
 */
export interface ObjectStorageClient {
  putObject(key: string, bytes: Uint8Array): Promise<void>;
  getObject(key: string): Promise<Uint8Array | null>;
  headObject(key: string): Promise<{ bytes: number; modifiedAt: string } | null>;
  deleteObject(key: string): Promise<boolean>;
  listObjects(prefix: string): Promise<{ key: string; bytes: number; modifiedAt: string }[]>;
}

/** Thrown when object storage is selected but no client implementation was injected. */
export class ObjectStorageUnconfiguredError extends Error {
  readonly code = "object_storage_unconfigured";

  constructor() {
    super(
      "Object storage is selected (DIRECTOR_ARTIFACT_STORAGE=object-storage) but no ObjectStorageClient implementation was provided; the gateway bundles no cloud SDK.",
    );
    this.name = "ObjectStorageUnconfiguredError";
  }
}

/**
 * Object-storage artifact backend skeleton. All operations validate keys and
 * delegate to the injected {@link ObjectStorageClient}; the class carries no
 * provider-specific behavior of its own so it stays testable with a fake
 * client and swappable for any S3-compatible implementation.
 */
export class ObjectStorageArtifactStorage implements ArtifactStorageBackend {
  readonly kind = "object-storage" as const;

  /**
   * @param client - The injected S3-compatible client implementation.
   */
  constructor(private readonly client: ObjectStorageClient) {}

  async put(key: string, bytes: Uint8Array): Promise<StoredArtifactObject> {
    assertArtifactStorageKey(key);
    await this.client.putObject(key, bytes);
    const info = await this.client.headObject(key);
    return { key, bytes: info?.bytes ?? bytes.byteLength, modifiedAt: info?.modifiedAt ?? new Date().toISOString() };
  }

  async get(key: string): Promise<Uint8Array | null> {
    return this.client.getObject(assertArtifactStorageKey(key));
  }

  async head(key: string): Promise<StoredArtifactObject | null> {
    const info = await this.client.headObject(assertArtifactStorageKey(key));
    return info ? { key, ...info } : null;
  }

  async delete(key: string): Promise<boolean> {
    return this.client.deleteObject(assertArtifactStorageKey(key));
  }

  async list(prefix = ""): Promise<StoredArtifactObject[]> {
    const objects = await this.client.listObjects(prefix);
    return [...objects].sort((left, right) => left.key.localeCompare(right.key));
  }
}

/** Configuration resolved for {@link createArtifactStorageBackend}. */
export interface ArtifactStorageBackendOptions {
  /** Gateway data directory backing the default filesystem store. */
  dataDirectory: string;
  /** Environment map; defaults to `process.env`. */
  environment?: Record<string, string | undefined>;
  /** Injected object-storage client; required when object storage is selected. */
  objectStorageClient?: ObjectStorageClient;
}

/**
 * Creates the artifact storage backend for a gateway process. The filesystem
 * backend rooted at the data directory is the default; setting
 * `DIRECTOR_ARTIFACT_STORAGE=object-storage` selects the object-storage
 * skeleton, which requires an injected {@link ObjectStorageClient}.
 *
 * @param options - Data directory, environment, and optional injected client.
 * @returns The selected artifact storage backend.
 * @throws {@link ObjectStorageUnconfiguredError} When object storage is selected without a client.
 */
export function createArtifactStorageBackend(options: ArtifactStorageBackendOptions): ArtifactStorageBackend {
  const environment = options.environment ?? process.env;
  const selected = (environment.DIRECTOR_ARTIFACT_STORAGE ?? "filesystem").trim().toLowerCase();
  if (selected === "object-storage") {
    if (!options.objectStorageClient) throw new ObjectStorageUnconfiguredError();
    return new ObjectStorageArtifactStorage(options.objectStorageClient);
  }
  return new FilesystemArtifactStorage(options.dataDirectory);
}
