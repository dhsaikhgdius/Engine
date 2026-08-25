import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { DIRECTOR_GENERATED_3D_CONTRACT } from "../../../../packages/protocol/src/generated3dProtocol";
import { transitionProductionJob } from "../../../../packages/protocol/src/productionJobProtocol";
import { ProductionJobStore } from "../../jobs/productionJobStore";
import { Generated3DPromotionStore } from "../../generation/generated3dPromotionStore";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("Generated3DPromotionStore", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
    directories.length = 0;
  });

  it("verifies and promotes job artifacts to stable content-addressed public paths", async () => {
    const directory = await mkdtemp(join(tmpdir(), "director-generated-3d-promotion-"));
    const publicRoot = await mkdtemp(join(tmpdir(), "director-generated-3d-public-"));
    directories.push(directory, publicRoot);
    const store = new ProductionJobStore(directory);
    const queued = await store.enqueue({
      kind: "model.generate",
      input: {
        mode: "text-to-3d",
        providerId: "meshy",
        name: "Chair",
        prompt: "A chair",
        targetHeightMeters: 1,
        texture: true,
        pbr: true,
      },
      idempotencyKey: "promotion-test-key",
      provider: "generated3d:meshy",
      createId: () => "promotion-job",
    });
    const running = await store.update(transitionProductionJob(queued, "running"));
    const attempt = running.attempts[0]!;
    const model = Buffer.from("glTF promoted model");
    const thumbnail = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    const createdAt = "2026-08-07T00:00:00.000Z";
    const modelArtifact = {
      id: "model-artifact",
      attemptId: attempt.id,
      role: "primary" as const,
      mimeType: "model/gltf-binary",
      fileName: "generated-model.glb",
      sha256: hash(model),
      bytes: model.byteLength,
      createdAt,
    };
    const thumbnailArtifact = {
      id: "thumbnail-artifact",
      attemptId: attempt.id,
      role: "thumbnail" as const,
      mimeType: "image/png",
      fileName: "generated-thumbnail.png",
      sha256: hash(thumbnail),
      bytes: thumbnail.byteLength,
      createdAt,
    };
    const receipt = {
      contract: DIRECTOR_GENERATED_3D_CONTRACT,
      jobId: queued.id,
      attemptId: attempt.id,
      providerId: "meshy" as const,
      providerModelVersion: null,
      externalId: "meshy:text-refine:remote-1",
      mode: "text-to-3d" as const,
      promptSha256: hash(Buffer.from("A chair")),
      sourceImageSha256: null,
      completedAt: createdAt,
      providerOutputHosts: ["assets.test"],
      normalization: {
        contract: DIRECTOR_GENERATED_3D_CONTRACT,
        adapter: "director-generated-3d-normalizer-v1" as const,
        stableAssetId: "generated3d:promotion-job",
        sourceSha256: "a".repeat(64),
        normalizedSha256: hash(model),
        coordinateSystem: {
          linearUnit: "meter" as const,
          metersPerUnit: 1 as const,
          upAxis: "Y" as const,
          handedness: "right" as const,
        },
        targetHeightMeters: 1,
        appliedScale: 1,
        sourceBounds: { min: [0, 0, 0] as const, max: [1, 1, 1] as const },
        normalizedBounds: { min: [0, 0, 0] as const, max: [1, 1, 1] as const },
        nodeCount: 1,
        meshCount: 1,
        materialCount: 1,
        triangleCount: 12,
        animationCount: 0,
        skinCount: 0,
        removedCameraCount: 0,
        decodedCompressionExtensions: [],
        warnings: [],
      },
      artifacts: [modelArtifact, thumbnailArtifact].map(({ role, fileName, mimeType, bytes, sha256 }) => ({
        role,
        fileName,
        mimeType,
        bytes,
        sha256,
      })),
    };
    const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
    const receiptArtifact = {
      id: "receipt-artifact",
      attemptId: attempt.id,
      role: "metadata" as const,
      mimeType: "application/json",
      fileName: "generated-3d-receipt.json",
      sha256: hash(receiptBytes),
      bytes: receiptBytes.byteLength,
      createdAt,
    };
    await mkdir(join(directory, "production-jobs", queued.id, "attempts", attempt.id), { recursive: true });
    await Promise.all([
      writeFile(store.artifactFilePath(queued.id, attempt.id, modelArtifact.fileName), model),
      writeFile(store.artifactFilePath(queued.id, attempt.id, thumbnailArtifact.fileName), thumbnail),
      writeFile(store.artifactFilePath(queued.id, attempt.id, receiptArtifact.fileName), receiptBytes),
    ]);
    await store.update(
      transitionProductionJob(running, "succeeded", {
        progress: 1,
        artifacts: [modelArtifact, thumbnailArtifact, receiptArtifact],
        artifact: modelArtifact,
      }),
    );

    const promotions = new Generated3DPromotionStore(publicRoot, store);
    const promoted = await promotions.promote(queued.id);
    expect(promoted).toMatchObject({
      modelPath: `/generated-3d/${modelArtifact.sha256}/model.glb`,
      thumbnailPath: `/generated-3d/${modelArtifact.sha256}/thumbnail.png`,
      receipt: { externalId: "meshy:text-refine:remote-1" },
    });
    expect(await readFile(join(publicRoot, promoted!.modelPath))).toEqual(model);
    await expect(promotions.promote(queued.id)).resolves.toEqual(promoted);
  });
});
