import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FilesystemArtifactStorage,
  ObjectStorageArtifactStorage,
  ObjectStorageUnconfiguredError,
  assertArtifactStorageKey,
  createArtifactStorageBackend,
  type ObjectStorageClient,
} from "../../media/artifactStorage";

function fakeObjectStorageClient() {
  const objects = new Map<string, { bytes: Uint8Array; modifiedAt: string }>();
  const calls: string[] = [];
  const client: ObjectStorageClient = {
    async putObject(key, bytes) {
      calls.push(`put:${key}`);
      objects.set(key, { bytes, modifiedAt: new Date().toISOString() });
    },
    async getObject(key) {
      calls.push(`get:${key}`);
      return objects.get(key)?.bytes ?? null;
    },
    async headObject(key) {
      calls.push(`head:${key}`);
      const object = objects.get(key);
      return object ? { bytes: object.bytes.byteLength, modifiedAt: object.modifiedAt } : null;
    },
    async deleteObject(key) {
      calls.push(`delete:${key}`);
      return objects.delete(key);
    },
    async listObjects(prefix) {
      calls.push(`list:${prefix}`);
      return [...objects.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, object]) => ({ key, bytes: object.bytes.byteLength, modifiedAt: object.modifiedAt }));
    },
  };
  return { client, objects, calls };
}

describe("artifactStorage", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  async function createRoot() {
    const dir = await mkdtemp(join(tmpdir(), "director-artifact-storage-"));
    tempDirs.push(dir);
    return dir;
  }

  it("rejects unsafe storage keys on every backend", () => {
    for (const key of ["", "/absolute", "trailing/", "a//b", "../escape", "a/../b", "a\\b", "a/./b"]) {
      expect(() => assertArtifactStorageKey(key), key).toThrow();
    }
    expect(assertArtifactStorageKey("production-jobs/job-1/attempts/a-1/output.png")).toBe(
      "production-jobs/job-1/attempts/a-1/output.png",
    );
  });

  it("round-trips bytes through the filesystem backend with listing and deletion", async () => {
    const storage = new FilesystemArtifactStorage(await createRoot());
    expect(storage.kind).toBe("filesystem");

    const bytes = new TextEncoder().encode("artifact bytes");
    const stored = await storage.put("production-jobs/job-1/attempts/a-1/output.png", bytes);
    expect(stored).toMatchObject({ key: "production-jobs/job-1/attempts/a-1/output.png", bytes: bytes.byteLength });

    expect(await storage.get("production-jobs/job-1/attempts/a-1/output.png")).toEqual(Buffer.from(bytes));
    expect(await storage.get("production-jobs/missing")).toBeNull();
    expect(await storage.head("production-jobs/job-1/attempts/a-1/output.png")).toMatchObject({
      bytes: bytes.byteLength,
    });

    await storage.put("media-transcode-inputs/aa.bin", bytes);
    const listed = await storage.list("production-jobs/");
    expect(listed.map((object) => object.key)).toEqual(["production-jobs/job-1/attempts/a-1/output.png"]);
    expect((await storage.list()).map((object) => object.key)).toEqual([
      "media-transcode-inputs/aa.bin",
      "production-jobs/job-1/attempts/a-1/output.png",
    ]);

    expect(await storage.delete("production-jobs/job-1/attempts/a-1/output.png")).toBe(true);
    expect(await storage.delete("production-jobs/job-1/attempts/a-1/output.png")).toBe(false);
    expect(await storage.get("production-jobs/job-1/attempts/a-1/output.png")).toBeNull();
  });

  it("lists prefix subtrees without scanning unrelated roots, including partial last segments", async () => {
    const storage = new FilesystemArtifactStorage(await createRoot());
    const bytes = new TextEncoder().encode("x");
    await storage.put("production-jobs/job-1/attempts/a-1/output.png", bytes);
    await storage.put("production-jobs/job-10/attempts/a-1/output.png", bytes);
    await storage.put("media-transcode-inputs/aa.bin", bytes);

    expect((await storage.list("production-jobs/job-1/")).map((object) => object.key)).toEqual([
      "production-jobs/job-1/attempts/a-1/output.png",
    ]);
    // A partial trailing segment stays a plain string-prefix filter.
    expect((await storage.list("production-jobs/job-1")).map((object) => object.key)).toEqual([
      "production-jobs/job-1/attempts/a-1/output.png",
      "production-jobs/job-10/attempts/a-1/output.png",
    ]);
    expect(await storage.list("production-jobs/missing/")).toEqual([]);
    expect(await storage.list("media-transcode-inputs/aa.bin")).toHaveLength(1);
  });

  it("delegates the object-storage skeleton to the injected client with validated keys", async () => {
    const { client, calls } = fakeObjectStorageClient();
    const storage = new ObjectStorageArtifactStorage(client);
    expect(storage.kind).toBe("object-storage");

    const bytes = new TextEncoder().encode("remote artifact");
    await storage.put("production-jobs/job-2/attempts/a-1/clip.mp4", bytes);
    expect(await storage.get("production-jobs/job-2/attempts/a-1/clip.mp4")).toEqual(bytes);
    expect(await storage.head("production-jobs/job-2/attempts/a-1/clip.mp4")).toMatchObject({
      bytes: bytes.byteLength,
    });
    expect((await storage.list("production-jobs/")).map((object) => object.key)).toEqual([
      "production-jobs/job-2/attempts/a-1/clip.mp4",
    ]);
    expect(await storage.delete("production-jobs/job-2/attempts/a-1/clip.mp4")).toBe(true);

    await expect(storage.put("../escape", bytes)).rejects.toThrow(/unsafe/);
    expect(calls[0]).toBe("put:production-jobs/job-2/attempts/a-1/clip.mp4");
  });

  it("drops unsafe keys returned by an injected object-storage client", async () => {
    const { client, objects } = fakeObjectStorageClient();
    const now = new Date().toISOString();
    objects.set("production-jobs/job-3/attempts/a-1/safe.mp4", { bytes: new Uint8Array(1), modifiedAt: now });
    objects.set("../escape.mp4", { bytes: new Uint8Array(1), modifiedAt: now });
    objects.set("/absolute.mp4", { bytes: new Uint8Array(1), modifiedAt: now });

    const storage = new ObjectStorageArtifactStorage(client);
    expect((await storage.list()).map((object) => object.key)).toEqual([
      "production-jobs/job-3/attempts/a-1/safe.mp4",
    ]);
  });

  it("selects the filesystem backend by default and requires a client for object storage", async () => {
    const root = await createRoot();
    const defaultBackend = createArtifactStorageBackend({ dataDirectory: root, environment: {} });
    expect(defaultBackend.kind).toBe("filesystem");

    expect(() =>
      createArtifactStorageBackend({
        dataDirectory: root,
        environment: { DIRECTOR_ARTIFACT_STORAGE: "object-storage" },
      }),
    ).toThrow(ObjectStorageUnconfiguredError);

    const { client } = fakeObjectStorageClient();
    const objectBackend = createArtifactStorageBackend({
      dataDirectory: root,
      environment: { DIRECTOR_ARTIFACT_STORAGE: "object-storage" },
      objectStorageClient: client,
    });
    expect(objectBackend.kind).toBe("object-storage");
  });
});
