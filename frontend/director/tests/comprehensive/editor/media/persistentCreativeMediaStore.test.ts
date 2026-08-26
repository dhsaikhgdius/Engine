import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MemoryCreativeMediaBackend,
  createPersistentCreativeMediaLibrary,
  hashCreativeMediaBlob,
  persistentCreativeMediaLibrary,
  usePersistentCreativeMedia,
  CREATIVE_MEDIA_HASH_CHUNK_BYTES,
  CREATIVE_MEDIA_LARGE_IMPORT_BYTES,
  type CreativeMediaObjectUrlFactory,
  type PersistentCreativeMediaLibrary,
} from "../../../../src/comprehensive/editor/media/persistentCreativeMediaStore";

function createObjectUrlTracker() {
  let nextId = 1;
  const created: Array<{ blob: Blob; url: string }> = [];
  const revoked: string[] = [];
  const factory: CreativeMediaObjectUrlFactory = {
    createObjectURL(blob) {
      const url = `blob:creative-media-test-${nextId}`;
      nextId += 1;
      created.push({ blob, url });
      return url;
    },
    revokeObjectURL(url) {
      revoked.push(url);
    },
  };
  return { factory, created, revoked };
}

async function deterministicTestHash(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return `test:${Array.from(bytes).join("-")}`;
}

const libraries: PersistentCreativeMediaLibrary[] = [];

function trackLibrary(library: PersistentCreativeMediaLibrary): PersistentCreativeMediaLibrary {
  libraries.push(library);
  return library;
}

afterEach(() => {
  libraries.splice(0).forEach((library) => library.dispose());
  persistentCreativeMediaLibrary.dispose();
});

describe("persistent creative media library", () => {
  it("imports image Files with a stable content ID and deduplicates renamed copies", async () => {
    const backend = new MemoryCreativeMediaBackend();
    const urls = createObjectUrlTracker();
    const library = trackLibrary(
      createPersistentCreativeMediaLibrary({
        backend,
        objectUrls: urls.factory,
        now: () => new Date("2026-07-31T08:00:00.000Z"),
        hashBlob: deterministicTestHash,
      }),
    );
    const original = new File([new Uint8Array([1, 2, 3])], "poster.png", {
      type: "image/png",
      lastModified: 42,
    });
    const renamedCopy = new File([new Uint8Array([1, 2, 3])], "renamed.png", { type: "image/png" });

    const imported = await library.importFile(original, { width: 1920, height: 1080, source: "user-import" });
    const duplicate = await library.importFile(renamedCopy);

    expect(imported).toMatchObject({
      id: "creative-media:image:test:1-2-3",
      kind: "image",
      name: "poster",
      fileName: "poster.png",
      mimeType: "image/png",
      size: 3,
      lastModified: 42,
      width: 1920,
      height: 1080,
      source: "user-import",
      objectUrl: "blob:creative-media-test-1",
    });
    expect(duplicate).toBe(imported);
    expect(library.store.getState().assets).toHaveLength(1);
    expect(urls.created).toHaveLength(1);
    expect(await library.getBlob(imported.id)).toBe(original);
  });

  it("imports image, video, and audio FileList-compatible batches", async () => {
    const library = trackLibrary(
      createPersistentCreativeMediaLibrary({
        backend: new MemoryCreativeMediaBackend(),
        objectUrls: createObjectUrlTracker().factory,
        hashBlob: deterministicTestHash,
      }),
    );
    const files = [
      new File(["image"], "frame.webp", { type: "image/webp" }),
      new File(["video"], "take.mp4", { type: "video/mp4" }),
      new File(["audio"], "dialogue.wav", { type: "audio/wav" }),
    ];

    const imported = await library.importFiles(files, { source: "multi-file-input" });

    expect(imported.map((asset) => asset.kind)).toEqual(["image", "video", "audio"]);
    expect(imported.every((asset) => asset.source === "multi-file-input")).toBe(true);
    expect(library.store.getState().assets).toHaveLength(3);
  });

  it("restores persisted video blobs with fresh object URLs after a library restart", async () => {
    const backend = new MemoryCreativeMediaBackend();
    const urls = createObjectUrlTracker();
    const first = trackLibrary(
      createPersistentCreativeMediaLibrary({
        backend,
        objectUrls: urls.factory,
        hashBlob: deterministicTestHash,
      }),
    );
    const video = new Blob([new Uint8Array([9, 8, 7, 6])], { type: "video/webm" });
    const imported = await first.importBlob(video, {
      fileName: "take-01.webm",
      durationSec: 4.5,
      source: "stage-recording",
      embeddedMetadata: {
        prompt: '{"1":{"class_type":"CLIPTextEncode","inputs":{"text":"foggy coast"}}}',
        workflow: '{"nodes":[]}',
      },
    });
    const firstUrl = imported.objectUrl;

    first.dispose();
    expect(urls.revoked).toContain(firstUrl);

    const second = trackLibrary(
      createPersistentCreativeMediaLibrary({
        backend,
        objectUrls: urls.factory,
        hashBlob: deterministicTestHash,
      }),
    );
    await second.initialize();

    const restored = second.getAsset(imported.id);
    expect(restored).toMatchObject({
      id: imported.id,
      kind: "video",
      fileName: "take-01.webm",
      durationSec: 4.5,
      source: "stage-recording",
      embeddedMetadata: {
        prompt: expect.stringContaining("foggy coast"),
        workflow: '{"nodes":[]}',
      },
    });
    expect(restored?.objectUrl).toBe("blob:creative-media-test-2");
    expect(restored?.objectUrl).not.toBe(firstUrl);
    expect(await second.getBlob(imported.id)).toBe(video);
  });

  it("revokes owned object URLs when media is removed, cleared, or disposed", async () => {
    const urls = createObjectUrlTracker();
    const library = trackLibrary(
      createPersistentCreativeMediaLibrary({
        backend: new MemoryCreativeMediaBackend(),
        objectUrls: urls.factory,
        hashBlob: deterministicTestHash,
      }),
    );
    const image = await library.importBlob(new Blob(["image"], { type: "image/png" }), {
      fileName: "frame.png",
    });
    const audio = await library.importBlob(new Blob(["audio"], { type: "audio/wav" }), {
      fileName: "score.wav",
      durationSec: 8,
    });

    await expect(library.remove(image.id)).resolves.toBe(true);
    expect(urls.revoked).toEqual([image.objectUrl]);
    await expect(library.remove("missing-media")).resolves.toBe(false);

    await library.clear();
    expect(urls.revoked).toEqual([image.objectUrl, audio.objectUrl]);
    expect(library.store.getState().assets).toEqual([]);
    await expect(library.getBlob(audio.id)).resolves.toBeNull();

    library.dispose();
    expect(urls.revoked).toHaveLength(2);
  });

  it("uses a safe memory fallback when IndexedDB is unavailable", async () => {
    const library = trackLibrary(
      createPersistentCreativeMediaLibrary({
        indexedDB: null,
        objectUrls: createObjectUrlTracker().factory,
        hashBlob: deterministicTestHash,
      }),
    );
    await library.initialize();

    expect(library.store.getState()).toMatchObject({
      status: "ready",
      storageMode: "memory",
    });
    expect(library.store.getState().warning).toContain("IndexedDB 不可用");

    const audio = await library.importBlob(new Blob(["score"], { type: "audio/mpeg" }), {
      fileName: "score.mp3",
      durationSec: 12,
    });
    expect(audio.kind).toBe("audio");
    expect(await library.getBlob(audio.id)).not.toBeNull();
  });

  it("falls back after an IndexedDB open failure and keeps accepting imports", async () => {
    const open = vi.fn(() => {
      const request = {
        error: new DOMException("storage denied", "SecurityError"),
        onblocked: null,
        onerror: null,
        onsuccess: null,
        onupgradeneeded: null,
      } as unknown as IDBOpenDBRequest;
      queueMicrotask(() => request.onerror?.(new Event("error")));
      return request;
    });
    const failingFactory = { open } as unknown as IDBFactory;
    const library = trackLibrary(
      createPersistentCreativeMediaLibrary({
        indexedDB: failingFactory,
        objectUrls: createObjectUrlTracker().factory,
        hashBlob: deterministicTestHash,
      }),
    );

    await library.initialize();
    expect(open).toHaveBeenCalledOnce();
    expect(library.store.getState()).toMatchObject({ status: "ready", storageMode: "memory" });
    expect(library.store.getState().warning).toContain("storage denied");

    const imported = await library.importBlob(new Blob(["fallback-video"], { type: "video/mp4" }), {
      fileName: "fallback.mp4",
    });
    expect(imported.kind).toBe("video");
    expect(await library.getBlob(imported.id)).not.toBeNull();
  });

  it("produces stable hashes and rejects unknown Blob media without an explicit kind", async () => {
    const first = new Blob([new Uint8Array([3, 1, 4, 1, 5])]);
    const second = new Blob([new Uint8Array([3, 1, 4, 1, 5])]);
    expect(await hashCreativeMediaBlob(first)).toBe(await hashCreativeMediaBlob(second));

    const library = trackLibrary(
      createPersistentCreativeMediaLibrary({
        backend: new MemoryCreativeMediaBackend(),
        objectUrls: createObjectUrlTracker().factory,
        hashBlob: deterministicTestHash,
      }),
    );
    await expect(library.importBlob(new Blob(["unknown"]))).rejects.toThrow("无法识别媒体类型");
    expect(library.store.getState().assets).toEqual([]);
  });

  it("hashes multi-chunk blobs identically to a single contiguous digest", async () => {
    const bytes = new Uint8Array(CREATIVE_MEDIA_HASH_CHUNK_BYTES + 17);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
    const chunked = new Blob([bytes], { type: "application/octet-stream" });
    const compact = new Blob([bytes.slice()], { type: "application/octet-stream" });
    const left = await hashCreativeMediaBlob(chunked);
    const right = await hashCreativeMediaBlob(compact);
    expect(left).toBe(right);
    expect(left.startsWith("sha256:") || left.startsWith("fnv1a64:")).toBe(true);
  });

  it("surfaces a soft warning when importing media at or above the large-import threshold", async () => {
    const library = trackLibrary(
      createPersistentCreativeMediaLibrary({
        backend: new MemoryCreativeMediaBackend(),
        objectUrls: createObjectUrlTracker().factory,
        hashBlob: deterministicTestHash,
      }),
    );
    const large = new Blob([new Uint8Array([9, 9, 9])], { type: "video/mp4" });
    Object.defineProperty(large, "size", { value: CREATIVE_MEDIA_LARGE_IMPORT_BYTES });
    await library.importBlob(large, { fileName: "large.mp4", durationSec: 12 });
    expect(library.store.getState().warning).toMatch(/导入素材约 \d+ MB/);
  });

  it("generates a waveform once, persists it, and reuses the cache after hydration", async () => {
    const backend = new MemoryCreativeMediaBackend();
    const urls = createObjectUrlTracker();
    const first = trackLibrary(
      createPersistentCreativeMediaLibrary({
        backend,
        objectUrls: urls.factory,
        hashBlob: deterministicTestHash,
      }),
    );
    const audio = await first.importBlob(new Blob(["dialogue"], { type: "audio/wav" }), {
      fileName: "dialogue.wav",
      durationSec: 2,
    });
    const samples = Float32Array.from({ length: 64 }, (_, index) => (index % 2 ? 0.75 : -0.5));
    const close = vi.fn().mockResolvedValue(undefined);
    const audioContextFactory = vi.fn(() => ({
      decodeAudioData: vi.fn().mockResolvedValue({
        duration: 2,
        sampleRate: 32,
        numberOfChannels: 1,
        length: samples.length,
        getChannelData: () => samples,
      }),
      close,
    }));

    const generated = await first.ensureWaveform(audio.id, { peakCount: 32, audioContextFactory });
    expect(generated).toMatchObject({ version: 1, durationSec: 2, samplesPerPeak: 2 });
    expect(first.getAsset(audio.id)?.waveform).toEqual(generated);
    expect((await backend.get(audio.id))?.waveform).toEqual(generated);
    expect(audioContextFactory).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();

    first.dispose();
    const second = trackLibrary(
      createPersistentCreativeMediaLibrary({
        backend,
        objectUrls: urls.factory,
        hashBlob: deterministicTestHash,
      }),
    );
    await second.initialize();
    const unusedDecoderFactory = vi.fn(() => null);
    await expect(second.ensureWaveform(audio.id, { audioContextFactory: unusedDecoderFactory })).resolves.toEqual(
      generated,
    );
    expect(unusedDecoderFactory).not.toHaveBeenCalled();
  });

  it("persists a verified transcript on the exact original timed-media asset", async () => {
    const backend = new MemoryCreativeMediaBackend();
    const library = trackLibrary(
      createPersistentCreativeMediaLibrary({
        backend,
        objectUrls: createObjectUrlTracker().factory,
        hashBlob: deterministicTestHash,
      }),
    );
    const audio = await library.importBlob(new Blob(["dialogue"], { type: "audio/wav" }), {
      fileName: "dialogue.wav",
      durationSec: 2,
    });
    const transcript = {
      version: 1 as const,
      jobId: "transcription-job-1",
      sourceMediaId: audio.id,
      sourceSha256: "a".repeat(64),
      provider: "openai-compatible",
      model: "whisper-1",
      language: "zh",
      durationSec: 2,
      text: "你好",
      segments: [{ startSec: 0, endSec: 2, text: "你好", speaker: null, confidence: 0.98 }],
      createdAt: "2026-08-07T00:00:00.000Z",
    };

    await expect(library.setTranscript(audio.id, transcript)).resolves.toMatchObject({ transcript });
    expect((await backend.get(audio.id))?.transcript).toEqual(transcript);

    library.dispose();
    const restored = trackLibrary(
      createPersistentCreativeMediaLibrary({
        backend,
        objectUrls: createObjectUrlTracker().factory,
        hashBlob: deterministicTestHash,
      }),
    );
    await restored.initialize();
    expect(restored.getAsset(audio.id)?.transcript).toEqual(transcript);
  });

  it("keeps proxy relationships distinct from content deduplication and removes proxies with their original", async () => {
    const urls = createObjectUrlTracker();
    const backend = new MemoryCreativeMediaBackend();
    const library = trackLibrary(
      createPersistentCreativeMediaLibrary({
        backend,
        objectUrls: urls.factory,
        hashBlob: deterministicTestHash,
      }),
    );
    const original = await library.importBlob(new Blob(["original"], { type: "video/mp4" }), {
      fileName: "original.mp4",
      width: 3840,
      height: 2160,
    });
    const otherOriginal = await library.importBlob(new Blob(["other-original"], { type: "video/mp4" }), {
      fileName: "other.mp4",
    });
    const proxyBlob = new Blob(["shared-proxy"], { type: "video/mp4" });
    const standalone = await library.importBlob(proxyBlob, { fileName: "standalone.mp4" });
    const proxy = await library.attachProxy(original.id, proxyBlob, {
      fileName: "original-proxy.mp4",
      width: 1280,
      height: 720,
    });
    const otherProxy = await library.attachProxy(otherOriginal.id, proxyBlob, { fileName: "other-proxy.mp4" });

    expect(new Set([standalone.id, proxy.id, otherProxy.id]).size).toBe(3);
    expect(proxy).toMatchObject({ proxyOf: original.id, kind: "video", width: 1280, height: 720 });
    expect(proxy.id).toContain(":proxy-of:");
    expect(otherProxy.proxyOf).toBe(otherOriginal.id);

    await expect(library.setPlaybackPreference(original.id, "proxy")).resolves.toMatchObject({
      id: original.id,
      playbackPreference: "proxy",
    });
    expect((await backend.get(original.id))?.playbackPreference).toBe("proxy");

    await expect(library.remove(original.id)).resolves.toBe(true);
    expect(library.getAsset(original.id)).toBeNull();
    expect(library.getAsset(proxy.id)).toBeNull();
    expect(library.getAsset(standalone.id)).toBe(standalone);
    expect(library.getAsset(otherProxy.id)).toBe(otherProxy);
    expect(urls.revoked).toEqual(expect.arrayContaining([original.objectUrl, proxy.objectUrl]));
  });

  it("exposes a React selector hook that hydrates the default library", async () => {
    persistentCreativeMediaLibrary.dispose();
    const { result } = renderHook(() => usePersistentCreativeMedia((state) => state.status));
    await waitFor(() => expect(result.current).toBe("ready"));
  });
});
