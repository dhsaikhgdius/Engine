// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { generated3dPromotionSchema } from "../../../../../../packages/protocol/src/generated3dProtocol";
import type { ImportedAssetInput } from "../../../../src/comprehensive/editor/store/directorStore";
import type { Generated3DJob } from "../../../../src/comprehensive/editor/generated3d/generated3dClient";
import { promoteGenerated3DJob } from "../../../../src/comprehensive/editor/generated3d/generated3dPromotion";

const digest = "a".repeat(64);
const thumbnailDigest = "b".repeat(64);
const completedAt = "2026-08-07T00:00:00.000Z";

const promotion = generated3dPromotionSchema.parse({
  contract: "director-generated-3d-v1",
  jobId: "job-generated-1",
  modelPath: `/generated-3d/${digest}/model.glb`,
  thumbnailPath: `/generated-3d/${digest}/thumbnail.png`,
  receipt: {
    contract: "director-generated-3d-v1",
    jobId: "job-generated-1",
    attemptId: "attempt-1",
    providerId: "meshy",
    providerModelVersion: "meshy-6",
    externalId: "meshy:text-refine:remote-1",
    mode: "text-to-3d",
    promptSha256: "c".repeat(64),
    sourceImageSha256: null,
    completedAt,
    providerOutputHosts: ["assets.test"],
    normalization: {
      contract: "director-generated-3d-v1",
      adapter: "director-generated-3d-normalizer-v1",
      stableAssetId: "generated3d:job-generated-1",
      sourceSha256: "d".repeat(64),
      normalizedSha256: digest,
      coordinateSystem: { linearUnit: "meter", metersPerUnit: 1, upAxis: "Y", handedness: "right" },
      targetHeightMeters: 1.5,
      appliedScale: 1,
      sourceBounds: { min: [0, 0, 0], max: [1, 1, 1] },
      normalizedBounds: { min: [-0.5, 0, -0.5], max: [0.5, 1.5, 0.5] },
      nodeCount: 2,
      meshCount: 1,
      materialCount: 1,
      triangleCount: 1200,
      animationCount: 0,
      skinCount: 0,
      removedCameraCount: 1,
      decodedCompressionExtensions: [],
      warnings: ["Provider camera removed"],
    },
    artifacts: [
      {
        role: "primary",
        fileName: "generated-model.glb",
        mimeType: "model/gltf-binary",
        bytes: 1024,
        sha256: digest,
      },
      {
        role: "thumbnail",
        fileName: "generated-thumbnail.png",
        mimeType: "image/png",
        bytes: 128,
        sha256: thumbnailDigest,
      },
    ],
  },
});

function job(status: Generated3DJob["status"] = "succeeded") {
  return {
    id: "job-generated-1",
    kind: "model.generate",
    status,
    input: {
      name: "Hero chair",
      prompt: "A carved production chair",
      providerId: "meshy",
      mode: "text-to-3d",
    },
    artifacts: [{ id: "receipt-artifact-1", role: "metadata" }],
  } as unknown as Generated3DJob;
}

describe("generated 3D promotion", () => {
  it("imports the thumbnail into Gallery and records exact model provenance in Stage", async () => {
    const inputs: ImportedAssetInput[] = [];
    const addImportedAsset = vi.fn((input: ImportedAssetInput) => {
      inputs.push(input);
      return input.id!;
    });
    const importFile = vi.fn(async () => ({ id: "creative-media:image:thumbnail" }));
    const result = await promoteGenerated3DJob(job(), {
      requestPromotion: vi.fn(async () => promotion),
      fetchPublicArtifact: vi.fn(async () => new Blob(["png"], { type: "image/png" })),
      publicUrl: (path) => `http://gateway.test${path}`,
      addImportedAsset,
      mediaLibrary: { importFile } as never,
      probeMedia: vi.fn(async () => ({ kind: "image" as const, width: 256, height: 256 })),
    });

    expect(result).toMatchObject({
      assetId: "generated3d:job-generated-1",
      galleryMediaId: "creative-media:image:thumbnail",
    });
    expect(importFile).toHaveBeenCalledWith(
      expect.any(File),
      expect.objectContaining({ source: "generated-3d:job-generated-1" }),
    );
    expect(inputs[0]).toMatchObject({
      id: "generated3d:job-generated-1",
      assetSource: "generated",
      modelNormalization: "preserve",
      addToScene: true,
      url: `http://gateway.test/generated-3d/${digest}/model.glb`,
      thumbnailUrl: `http://gateway.test/generated-3d/${digest}/thumbnail.png`,
      generation: {
        jobId: "job-generated-1",
        providerId: "meshy",
        externalId: "meshy:text-refine:remote-1",
        modelSha256: digest,
        thumbnailSha256: thumbnailDigest,
        receiptArtifactId: "receipt-artifact-1",
        prompt: "A carved production chair",
      },
    });
  });

  it("does not promote unfinished provider work", async () => {
    await expect(promoteGenerated3DJob(job("running"), { requestPromotion: vi.fn() })).rejects.toThrow(
      "只有成功的 3D 生成任务",
    );
  });
});
