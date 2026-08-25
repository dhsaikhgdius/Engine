import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import {
  CREATIVE_PROJECT_BUNDLE_MANIFEST_PATH,
  exportCreativeProjectBundle,
  importCreativeProjectBundle,
  parseLegacyCreativeProjectJson,
  type CreativeProjectBundleMediaLibrary,
} from "../../../../src/comprehensive/editor/workspaces/creativeProjectBundle";
import { parseDirectorCreativeWorkspacePersistedState } from "../../../../src/comprehensive/editor/workspaces/directorWorkspaceStore";
import { createDefaultDirectorProject } from "../../../../src/comprehensive/editor/store/directorStore";

function clip(id: string, mediaId: string) {
  return {
    id,
    mediaId,
    name: id,
    startSec: 0,
    durationSec: 2,
    inSec: 0,
    sourceDurationSec: 2,
    opacity: 1,
    volume: 1,
    fadeInSec: 0,
    fadeOutSec: 0,
    scale: 1,
    positionX: 0,
    positionY: 0,
    rotationDeg: 0,
    fit: "contain" as const,
  };
}

function workspaceDocument() {
  return {
    version: 2 as const,
    state: {
      mode: "video" as const,
      boardNodes: [
        {
          id: "node-local",
          kind: "image" as const,
          title: "Local still",
          body: "",
          mediaId: "media:local",
          x: 20,
          y: 40,
          width: 320,
          height: 220,
          accent: "#29d6ff",
        },
      ],
      boardEdges: [],
      boardViewport: { x: 0, y: 0, zoom: 1 },
      editTracks: [
        {
          id: "video-1",
          name: "Video 1",
          kind: "video" as const,
          muted: false,
          locked: false,
          visible: true,
          clips: [clip("clip-remote", "media:remote"), clip("clip-title", "text:title")],
        },
      ],
      editSettings: {
        aspectRatio: "16 / 9" as const,
        fps: 24 as const,
        snapEnabled: true,
        exportQuality: "full" as const,
      },
      playheadSec: 1,
      timelineZoom: 1,
    },
  };
}

function createLibrary(blobs: ReadonlyMap<string, Blob> = new Map()) {
  const imported: Array<{ blob: Blob; options: Parameters<CreativeProjectBundleMediaLibrary["importBlob"]>[1] }> = [];
  const library: CreativeProjectBundleMediaLibrary = {
    getBlob: vi.fn(async (id: string) => blobs.get(id) ?? null),
    importBlob: vi.fn(async (blob, options) => {
      imported.push({ blob, options });
      return { id: `imported:${options?.fileName ?? imported.length}` };
    }),
  };
  return { library, imported };
}

async function makeZip(manifest: unknown, files: Record<string, Uint8Array> = {}) {
  const zip = new JSZip();
  zip.file(CREATIVE_PROJECT_BUNDLE_MANIFEST_PATH, JSON.stringify(manifest));
  Object.entries(files).forEach(([path, bytes]) => zip.file(path, bytes));
  return zip.generateAsync({ type: "uint8array", compression: "STORE" });
}

describe("creative project bundle", () => {
  it("exports only referenced media, preferring persisted blobs before source URL fetches", async () => {
    const localBlob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    const remoteBlob = new Blob([new Uint8Array([8, 9])], { type: "video/mp4" });
    const { library } = createLibrary(new Map([["media:local", localBlob]]));
    const fetcher = vi.fn(
      async () => ({ ok: true, status: 200, headers: new Headers(), blob: async () => remoteBlob }) as Response,
    );

    const bundle = await exportCreativeProjectBundle({
      serialized: JSON.stringify(workspaceDocument()),
      mediaLibrary: library,
      fetcher,
      now: () => new Date("2026-07-31T10:00:00.000Z"),
      mediaSources: [
        {
          id: "media:local",
          sourceUrl: "https://assets.example/local.png",
          kind: "image",
          name: "Local still",
          fileName: "still.png",
          mimeType: "image/png",
          width: 1920,
          height: 1080,
        },
        {
          id: "media:remote",
          sourceUrl: "https://assets.example/take.mp4",
          kind: "video",
          name: "Remote take",
          fileName: "take.mp4",
          mimeType: "video/mp4",
          durationSec: 2,
        },
        {
          id: "media:unused",
          sourceUrl: "https://assets.example/unused.png",
          kind: "image",
        },
      ],
    });

    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith("https://assets.example/take.mp4");
    expect(library.getBlob).toHaveBeenCalledTimes(2);
    expect(library.getBlob).not.toHaveBeenCalledWith("media:unused");

    const zip = await JSZip.loadAsync(await bundle.arrayBuffer());
    const manifest = JSON.parse(await zip.file(CREATIVE_PROJECT_BUNDLE_MANIFEST_PATH)!.async("string"));
    expect(manifest).toMatchObject({
      documentType: "director-creative-project-bundle",
      version: 1,
      exportedAt: "2026-07-31T10:00:00.000Z",
    });
    expect(manifest.media.map((media: { id: string }) => media.id)).toEqual(["media:local", "media:remote"]);
    expect(Object.keys(zip.files).sort()).toEqual(["manifest.json", "media/", "media/0001.png", "media/0002.mp4"]);
    expect([...(await zip.file("media/0001.png")!.async("uint8array"))]).toEqual([1, 2, 3]);
    expect([...(await zip.file("media/0002.mp4")!.async("uint8array"))]).toEqual([8, 9]);
  });

  it("validates all blobs, imports them, and remaps Canvas nodes and Video clips", async () => {
    const exportLibrary = createLibrary(
      new Map([
        ["media:local", new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" })],
        ["media:remote", new Blob([new Uint8Array([4, 5, 6])], { type: "video/mp4" })],
      ]),
    );
    const bundle = await exportCreativeProjectBundle({
      serialized: JSON.stringify(workspaceDocument()),
      mediaLibrary: exportLibrary.library,
      mediaSources: [
        { id: "media:local", kind: "image", name: "Still", fileName: "still.png", mimeType: "image/png" },
        { id: "media:remote", kind: "video", name: "Take", fileName: "take.mp4", mimeType: "video/mp4" },
      ],
    });
    const importLibrary = createLibrary();

    const result = await importCreativeProjectBundle(bundle, { mediaLibrary: importLibrary.library });

    expect(result.stageProject).toBeNull();
    expect(importLibrary.imported).toHaveLength(2);
    expect(importLibrary.imported.map((item) => item.options?.kind)).toEqual(["image", "video"]);
    expect(result.mediaIdMap).toEqual(
      new Map([
        ["media:local", "imported:still.png"],
        ["media:remote", "imported:take.mp4"],
      ]),
    );
    const restored = JSON.parse(result.serialized);
    expect(restored.state.boardNodes[0].mediaId).toBe("imported:still.png");
    expect(restored.state.editTracks[0].clips.map((item: { mediaId: string }) => item.mediaId)).toEqual([
      "imported:take.mp4",
      "text:title",
    ]);
    expect(Object.keys(parseDirectorCreativeWorkspacePersistedState(result.serialized)).length).toBeGreaterThan(0);
  });

  it("bundles Gallery-only catalog entries, embedded generation metadata, folders, and review state", async () => {
    const base = workspaceDocument();
    const workspace = {
      version: 4 as const,
      state: {
        ...base.state,
        mode: "stage" as const,
        boardNodes: [],
        editTracks: [],
        galleryMedia: [
          {
            mediaId: "media:gallery-only",
            rating: 5,
            tags: ["approved"],
            color: "green" as const,
            customName: "Hero Select",
            notes: "Keep the seed",
            folderId: "folder-selects",
            addedAt: "2026-08-07T00:00:00.000Z",
            trashedAt: null,
          },
        ],
        galleryFolders: [
          {
            id: "folder-selects",
            name: "Selects",
            parentId: null,
            createdAt: "2026-08-07T00:00:00.000Z",
          },
        ],
        galleryPrefs: {
          viewMode: "masonry" as const,
          sortBy: "rating" as const,
          sortDirection: "desc" as const,
          thumbnailSize: 224,
          activeFolderId: "folder-selects",
          includeSubfolders: true,
          showTrash: false,
        },
      },
    };
    const exportLibrary = createLibrary(
      new Map([["media:gallery-only", new Blob([new Uint8Array([8, 6, 7, 5])], { type: "image/png" })]]),
    );
    const bundle = await exportCreativeProjectBundle({
      serialized: JSON.stringify(workspace),
      mediaLibrary: exportLibrary.library,
      mediaSources: [
        {
          id: "media:gallery-only",
          kind: "image",
          name: "Generated Hero",
          fileName: "generated-hero.png",
          mimeType: "image/png",
          embeddedMetadata: {
            prompt: '{"1":{"class_type":"CLIPTextEncode","inputs":{"text":"cinematic sunrise"}}}',
            workflow: '{"nodes":[]}',
          },
        },
      ],
    });

    const zip = await JSZip.loadAsync(await bundle.arrayBuffer());
    const manifest = JSON.parse(await zip.file(CREATIVE_PROJECT_BUNDLE_MANIFEST_PATH)!.async("string"));
    expect(manifest.media).toEqual([
      expect.objectContaining({
        id: "media:gallery-only",
        embeddedMetadata: expect.objectContaining({ workflow: '{"nodes":[]}' }),
      }),
    ]);

    const importLibrary = createLibrary();
    const result = await importCreativeProjectBundle(bundle, { mediaLibrary: importLibrary.library });
    const restored = JSON.parse(result.serialized);
    expect(importLibrary.imported[0]?.options).toMatchObject({
      fileName: "generated-hero.png",
      embeddedMetadata: expect.objectContaining({ prompt: expect.stringContaining("cinematic sunrise") }),
    });
    expect(restored.state.galleryMedia).toEqual([
      expect.objectContaining({
        mediaId: "imported:generated-hero.png",
        rating: 5,
        tags: ["approved"],
        folderId: "folder-selects",
      }),
    ]);
    expect(restored.state.galleryFolders).toEqual([expect.objectContaining({ id: "folder-selects", name: "Selects" })]);
    expect(restored.state.galleryPrefs).toMatchObject({ viewMode: "masonry", activeFolderId: "folder-selects" });
  });

  it("rejects traversal paths before importing any media", async () => {
    const workspace = { version: 2, state: { mode: "canvas" } };
    const archive = await makeZip(workspace, { "../outside.bin": new Uint8Array([1]) });
    const { library, imported } = createLibrary();

    await expect(importCreativeProjectBundle(archive, { mediaLibrary: library })).rejects.toThrow("不安全路径");
    expect(imported).toEqual([]);
  });

  it("stages and validates every declared blob before mutating the media library", async () => {
    const workspace = workspaceDocument();
    const manifest = {
      documentType: "director-creative-project-bundle",
      version: 1,
      exportedAt: "2026-07-31T10:00:00.000Z",
      workspace,
      media: [
        {
          id: "media:local",
          path: "media/0001.png",
          kind: "image",
          name: "Still",
          fileName: "still.png",
          mimeType: "image/png",
          size: 99,
          durationSec: null,
          width: 1920,
          height: 1080,
          source: "test",
        },
        {
          id: "media:remote",
          path: "media/0002.mp4",
          kind: "video",
          name: "Take",
          fileName: "take.mp4",
          mimeType: "video/mp4",
          size: 2,
          durationSec: 2,
          width: null,
          height: null,
          source: "test",
        },
      ],
    };
    const archive = await makeZip(manifest, {
      "media/0001.png": new Uint8Array([1, 2, 3]),
      "media/0002.mp4": new Uint8Array([4, 5]),
    });
    const { library, imported } = createLibrary();

    await expect(importCreativeProjectBundle(archive, { mediaLibrary: library })).rejects.toThrow("大小与清单不一致");
    expect(imported).toEqual([]);
  });

  it("parses both raw persisted workspaces and legacy JSON wrappers", () => {
    const workspace = workspaceDocument();
    expect(JSON.parse(parseLegacyCreativeProjectJson(JSON.stringify(workspace)))).toEqual(workspace);
    expect(
      JSON.parse(
        parseLegacyCreativeProjectJson(
          JSON.stringify({ documentType: "director-creative-project", version: 2, creative: workspace }),
        ),
      ),
    ).toEqual(workspace);
    expect(() => parseLegacyCreativeProjectJson("not-json")).toThrow("无法解析");
    expect(() => parseLegacyCreativeProjectJson('{"version":2,"state":{"boardNodes":"broken"}}')).toThrow("结构无效");
  });

  function stageProjectWithLocalModel() {
    const project = createDefaultDirectorProject();
    project.assets = [
      ...project.assets,
      {
        id: "local-chair",
        kind: "prop" as const,
        sourceType: "model" as const,
        fileName: "chair.glb",
        name: "Chair",
        url: "/native-models/asset-local-chair/chair.glb",
        assetSource: "local" as const,
      },
    ];
    return project;
  }

  async function exportStageBundle(modelBytes: Uint8Array) {
    const { library } = createLibrary(
      new Map([
        ["media:local", new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" })],
        ["media:remote", new Blob([new Uint8Array([4, 5, 6])], { type: "video/mp4" })],
      ]),
    );
    const fetcher = vi.fn(
      async (input: RequestInfo | URL) =>
        ({
          ok: true,
          status: 200,
          headers: new Headers(),
          url: String(input),
          blob: async () => new Blob([modelBytes], { type: "model/gltf-binary" }),
        }) as unknown as Response,
    );
    const bundle = await exportCreativeProjectBundle({
      serialized: JSON.stringify(workspaceDocument()),
      stageProject: stageProjectWithLocalModel(),
      mediaLibrary: library,
      fetcher,
      mediaSources: [
        { id: "media:local", kind: "image", name: "Still", fileName: "still.png", mimeType: "image/png" },
        { id: "media:remote", kind: "video", name: "Take", fileName: "take.mp4", mimeType: "video/mp4" },
      ],
    });
    return { bundle, fetcher };
  }

  it("embeds the 3D stage project, bundles its local models, and restores them through the uploader", async () => {
    const modelBytes = new Uint8Array([7, 7, 7, 7]);
    const { bundle, fetcher } = await exportStageBundle(modelBytes);

    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0]?.[0])).toContain("/native-models/asset-local-chair/chair.glb");
    const zip = await JSZip.loadAsync(await bundle.arrayBuffer());
    const manifest = JSON.parse(await zip.file(CREATIVE_PROJECT_BUNDLE_MANIFEST_PATH)!.async("string"));
    expect(manifest.version).toBe(2);
    expect(manifest.stage.assets).toEqual([
      expect.objectContaining({ id: "local-chair", path: "stage-assets/0001.glb", fileName: "chair.glb", size: 4 }),
    ]);
    expect([...(await zip.file("stage-assets/0001.glb")!.async("uint8array"))]).toEqual([7, 7, 7, 7]);

    const importLibrary = createLibrary();
    const uploader = vi.fn(async (blob: Blob, fileName: string, assetId: string) => {
      expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([7, 7, 7, 7]);
      return { url: `/native-models/restored-${assetId}/${fileName}` };
    });
    const result = await importCreativeProjectBundle(bundle, {
      mediaLibrary: importLibrary.library,
      stageAssetUploader: uploader,
    });

    expect(uploader).toHaveBeenCalledOnce();
    expect(uploader).toHaveBeenCalledWith(expect.any(Blob), "chair.glb", "local-chair");
    const restoredAsset = result.stageProject?.assets.find((asset) => asset.id === "local-chair");
    expect(restoredAsset?.url).toBe("/native-models/restored-local-chair/chair.glb");
    const untouchedAssets = result.stageProject?.assets.filter((asset) => asset.id !== "local-chair") ?? [];
    expect(untouchedAssets.every((asset) => !asset.url.startsWith("/native-models/restored-"))).toBe(true);
    expect(importLibrary.imported).toHaveLength(2);
  });

  it("re-packs 4DGS sequences as upload ZIPs so bundles round trip through the gateway unpack", async () => {
    const project = createDefaultDirectorProject();
    project.assets = [
      ...project.assets,
      {
        id: "local-dance",
        kind: "prop" as const,
        sourceType: "model" as const,
        fileName: "dance.4dgs.json",
        name: "Dance",
        url: "/native-models/asset-local-dance/dance.4dgs.json",
        assetSource: "local" as const,
        splatSequence: { frameCount: 2, fps: 24 },
      },
    ];
    const responses = new Map<string, { bytes: Uint8Array; type: string }>([
      [
        "/native-models/asset-local-dance/dance.4dgs.json",
        {
          bytes: new TextEncoder().encode(
            JSON.stringify({
              format: "director-splat-sequence@1",
              fps: 24,
              frameCount: 2,
              frames: ["frames/frame-00001.spz", "frames/frame-00002.spz"],
            }),
          ),
          type: "application/json",
        },
      ],
      [
        "/native-models/asset-local-dance/frames/frame-00001.spz",
        { bytes: new Uint8Array([1, 1]), type: "application/octet-stream" },
      ],
      [
        "/native-models/asset-local-dance/frames/frame-00002.spz",
        { bytes: new Uint8Array([2, 2]), type: "application/octet-stream" },
      ],
    ]);
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const key = String(input);
      const match = [...responses.entries()].find(([path]) => key.includes(path));
      if (!match) throw new Error(`unexpected fetch: ${key}`);
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        url: key,
        blob: async () => new Blob([match[1].bytes], { type: match[1].type }),
      } as unknown as Response;
    });
    const { library } = createLibrary(
      new Map([
        ["media:local", new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" })],
        ["media:remote", new Blob([new Uint8Array([4, 5, 6])], { type: "video/mp4" })],
      ]),
    );

    const bundle = await exportCreativeProjectBundle({
      serialized: JSON.stringify(workspaceDocument()),
      stageProject: project,
      mediaLibrary: library,
      fetcher,
      mediaSources: [
        { id: "media:local", kind: "image", name: "Still", fileName: "still.png", mimeType: "image/png" },
        { id: "media:remote", kind: "video", name: "Take", fileName: "take.mp4", mimeType: "video/mp4" },
      ],
    });

    const zip = await JSZip.loadAsync(await bundle.arrayBuffer());
    const manifest = JSON.parse(await zip.file(CREATIVE_PROJECT_BUNDLE_MANIFEST_PATH)!.async("string"));
    expect(manifest.stage.assets).toEqual([
      expect.objectContaining({
        id: "local-dance",
        path: "stage-assets/0001.zip",
        fileName: "dance.zip",
        mimeType: "application/zip",
      }),
    ]);
    const repacked = await JSZip.loadAsync(await zip.file("stage-assets/0001.zip")!.async("uint8array"));
    expect(JSON.parse(await repacked.file("manifest.json")!.async("string"))).toEqual({ fps: 24 });
    expect([...(await repacked.file("frame-00001.spz")!.async("uint8array"))]).toEqual([1, 1]);
    expect([...(await repacked.file("frame-00002.spz")!.async("uint8array"))]).toEqual([2, 2]);

    const uploader = vi.fn(async (_blob: Blob, _fileName: string, assetId: string) => ({
      url: `/native-models/restored-${assetId}/dance.4dgs.json`,
      fileName: "dance.4dgs.json",
    }));
    const result = await importCreativeProjectBundle(bundle, {
      mediaLibrary: createLibrary().library,
      stageAssetUploader: uploader,
    });

    expect(uploader).toHaveBeenCalledWith(expect.any(Blob), "dance.zip", "local-dance");
    const restored = result.stageProject?.assets.find((asset) => asset.id === "local-dance");
    expect(restored?.url).toBe("/native-models/restored-local-dance/dance.4dgs.json");
    expect(restored?.fileName).toBe("dance.4dgs.json");
    expect(restored?.splatSequence).toEqual({ frameCount: 2, fps: 24 });
  });

  it("rejects stage tampering before mutating the media library or the gateway", async () => {
    const { bundle } = await exportStageBundle(new Uint8Array([9, 9]));
    const bundleBytes = await bundle.arrayBuffer();

    const missingModel = await JSZip.loadAsync(bundleBytes);
    missingModel.remove("stage-assets/0001.glb");
    const missingLibrary = createLibrary();
    const missingUploader = vi.fn();
    await expect(
      importCreativeProjectBundle(await missingModel.generateAsync({ type: "uint8array", compression: "STORE" }), {
        mediaLibrary: missingLibrary.library,
        stageAssetUploader: missingUploader,
      }),
    ).rejects.toThrow("缺少 3D 模型文件");
    expect(missingLibrary.imported).toEqual([]);
    expect(missingUploader).not.toHaveBeenCalled();

    const undeclaredModel = await JSZip.loadAsync(bundleBytes);
    undeclaredModel.file("stage-assets/0002.glb", new Uint8Array([1]));
    await expect(
      importCreativeProjectBundle(await undeclaredModel.generateAsync({ type: "uint8array", compression: "STORE" }), {
        mediaLibrary: createLibrary().library,
        stageAssetUploader: vi.fn(),
      }),
    ).rejects.toThrow("未声明文件");

    const ghostAsset = await JSZip.loadAsync(bundleBytes);
    const manifest = JSON.parse(await ghostAsset.file(CREATIVE_PROJECT_BUNDLE_MANIFEST_PATH)!.async("string"));
    manifest.stage.assets[0].id = "ghost";
    ghostAsset.file(CREATIVE_PROJECT_BUNDLE_MANIFEST_PATH, JSON.stringify(manifest));
    await expect(
      importCreativeProjectBundle(await ghostAsset.generateAsync({ type: "uint8array", compression: "STORE" }), {
        mediaLibrary: createLibrary().library,
        stageAssetUploader: vi.fn(),
      }),
    ).rejects.toThrow("3D 工程未引用的模型");
  });

  it("fails the whole import when a bundled model cannot be re-registered", async () => {
    const { bundle } = await exportStageBundle(new Uint8Array([3, 1, 4]));
    const importLibrary = createLibrary();
    await expect(
      importCreativeProjectBundle(bundle, {
        mediaLibrary: importLibrary.library,
        stageAssetUploader: vi.fn(async () => {
          throw new Error("gateway unreachable");
        }),
      }),
    ).rejects.toThrow("恢复失败");
    expect(importLibrary.imported).toEqual([]);
  });
});
