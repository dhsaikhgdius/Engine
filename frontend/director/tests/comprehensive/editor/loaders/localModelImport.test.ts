import { beforeEach, describe, expect, it, vi } from "vitest";

const loaderMocks = vi.hoisted(() => ({
  estimateAssetRealWorldSize: vi.fn(),
  uploadBlenderModelAsset: vi.fn(),
}));

vi.mock("../../../../src/comprehensive/editor/api/assetSizeClient", () => ({
  estimateAssetRealWorldSize: loaderMocks.estimateAssetRealWorldSize,
}));
vi.mock("../../../../src/comprehensive/editor/api/blenderLiveClient", () => ({
  uploadBlenderModelAsset: loaderMocks.uploadBlenderModelAsset,
}));

import {
  estimateLocalModelSizeM,
  readLocalModelFile,
} from "../../../../src/comprehensive/editor/loaders/localModelImport";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("readLocalModelFile", () => {
  it("uploads gaussian splat captures and strips the extension from the display name", async () => {
    loaderMocks.uploadBlenderModelAsset.mockResolvedValue({
      byteLength: 3,
      fileName: "花园扫描.spz",
      url: "/native-models/asset-splat/%E8%8A%B1%E5%9B%AD%E6%89%AB%E6%8F%8F.spz",
    });

    const result = await readLocalModelFile(new File(["spz"], "花园扫描.spz"));

    expect(loaderMocks.uploadBlenderModelAsset).toHaveBeenCalledWith(expect.any(File), "花园扫描.spz", result.id);
    expect(result.name).toBe("花园扫描");
    expect(result.fileName).toBe("花园扫描.spz");
    expect(result.url).toBe("/native-models/asset-splat/%E8%8A%B1%E5%9B%AD%E6%89%AB%E6%8F%8F.spz");
  });

  it("imports a 4DGS ZIP as the gateway-unpacked sequence manifest with its frame metadata", async () => {
    loaderMocks.uploadBlenderModelAsset.mockResolvedValue({
      byteLength: 12,
      fileName: "dance.4dgs.json",
      url: "/native-models/asset-dance/dance.4dgs.json",
      splatSequence: { frameCount: 48, fps: 24 },
    });

    const result = await readLocalModelFile(new File(["zip"], "dance.zip"));

    expect(result.name).toBe("dance");
    expect(result.fileName).toBe("dance.4dgs.json");
    expect(result.url).toBe("/native-models/asset-dance/dance.4dgs.json");
    expect(result.splatSequence).toEqual({ frameCount: 48, fps: 24 });
  });

  it("rejects files that are neither mesh models nor gaussian splats without uploading", async () => {
    await expect(readLocalModelFile(new File(["usd"], "scene.usd"))).rejects.toThrow(
      "当前仅支持 FBX / OBJ / GLB / GLTF 模型文件，PLY / SPLAT / KSPLAT / SPZ / SOG 高斯泼溅文件，以及 ZIP 泼溅帧序列",
    );
    expect(loaderMocks.uploadBlenderModelAsset).not.toHaveBeenCalled();
  });
});

describe("estimateLocalModelSizeM", () => {
  it("estimates a metric size from the model's display name", async () => {
    loaderMocks.estimateAssetRealWorldSize.mockResolvedValue(0.92);

    await expect(estimateLocalModelSizeM("  本地椅子  ")).resolves.toBe(0.92);
    expect(loaderMocks.estimateAssetRealWorldSize).toHaveBeenCalledWith({ name: "本地椅子" }, {});
  });

  it("degrades to no size instead of failing the import when the gateway is unavailable", async () => {
    loaderMocks.estimateAssetRealWorldSize.mockRejectedValue(new Error("gateway offline"));
    await expect(estimateLocalModelSizeM("本地椅子")).resolves.toBeNull();

    loaderMocks.estimateAssetRealWorldSize.mockClear();
    await expect(estimateLocalModelSizeM("   ")).resolves.toBeNull();
    expect(loaderMocks.estimateAssetRealWorldSize).not.toHaveBeenCalled();
  });
});
