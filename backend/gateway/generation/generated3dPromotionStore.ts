import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  DIRECTOR_GENERATED_3D_CONTRACT,
  generated3dJobInputSchema,
  generated3dPromotionSchema,
  generated3dReceiptSchema,
  type Generated3DPromotion,
} from "../../../packages/protocol/src/generated3dProtocol";
import type { ProductionJobArtifact, ProductionJobRecord } from "../../../packages/protocol/src/productionJobProtocol";
import type { ProductionJobStore } from "../jobs/productionJobStore";

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requiredArtifact(job: ProductionJobRecord, role: ProductionJobArtifact["role"]) {
  const matches = job.artifacts.filter((artifact) => artifact.role === role);
  if (matches.length !== 1) throw new Error(`Generated 3D job must have exactly one ${role} artifact`);
  return matches[0]!;
}

function thumbnailExtension(mimeType: string) {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  throw new Error(`Generated 3D thumbnail has unsupported MIME type ${mimeType}`);
}

async function writeImmutable(path: string, bytes: Uint8Array, expectedSha256: string) {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, bytes, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readFile(path);
    if (existing.byteLength !== bytes.byteLength || sha256(existing) !== expectedSha256) {
      throw new Error(`Immutable generated asset path contains different bytes: ${path}`);
    }
  }
}

/**
 * Promotes completed generated 3D jobs to publicly accessible asset paths.
 *
 * Verifies artifact integrity, validates the generation receipt, and writes
 * the model and thumbnail to immutable, content-addressed paths under the
 * generated asset root directory.
 */
export class Generated3DPromotionStore {
  /**
   * Creates a new promotion store.
   *
   * @param generatedAssetRoot - The root directory for promoted generated assets.
   * @param jobs - The production job store for reading artifacts.
   */
  constructor(
    private readonly generatedAssetRoot: string,
    private readonly jobs: ProductionJobStore,
  ) {}

  /**
   * Promotes a completed generated 3D job.
   *
   * Verifies all artifacts, validates the receipt, and writes the model
   * and thumbnail to immutable paths. Returns a promotion record with
   * public URIs.
   *
   * @param jobId - The job identifier to promote.
   * @returns A promotion record with public paths, or null if the job is not a model generation job.
   * @throws When the job has not succeeded, artifacts fail verification,
   *         or the receipt does not match the artifacts.
   */
  async promote(jobId: string): Promise<Generated3DPromotion | null> {
    const job = await this.jobs.get(jobId);
    if (!job || job.kind !== "model.generate") return null;
    if (job.status !== "succeeded")
      throw new Error(`Generated 3D job must succeed before promotion (is ${job.status})`);

    const input = generated3dJobInputSchema.parse(job.input);
    const modelArtifact = requiredArtifact(job, "primary");
    const thumbnailArtifact = requiredArtifact(job, "thumbnail");
    const receiptArtifact = requiredArtifact(job, "metadata");
    if (modelArtifact.mimeType !== "model/gltf-binary") throw new Error("Primary generated 3D artifact is not GLB");

    const [model, thumbnail, receiptBytes] = await Promise.all([
      this.jobs.readArtifact(job, modelArtifact),
      this.jobs.readArtifact(job, thumbnailArtifact),
      this.jobs.readArtifact(job, receiptArtifact),
    ]);
    for (const [artifact, bytes] of [
      [modelArtifact, model],
      [thumbnailArtifact, thumbnail],
      [receiptArtifact, receiptBytes],
    ] as const) {
      if (bytes.byteLength !== artifact.bytes || sha256(bytes) !== artifact.sha256) {
        throw new Error(`Generated 3D artifact failed integrity verification: ${artifact.fileName}`);
      }
    }

    const receipt = generated3dReceiptSchema.parse(JSON.parse(receiptBytes.toString("utf8")));
    if (
      receipt.jobId !== job.id ||
      receipt.providerId !== input.providerId ||
      receipt.normalization.normalizedSha256 !== modelArtifact.sha256 ||
      receipt.artifacts.find((artifact) => artifact.role === "primary")?.sha256 !== modelArtifact.sha256 ||
      receipt.artifacts.find((artifact) => artifact.role === "thumbnail")?.sha256 !== thumbnailArtifact.sha256
    ) {
      throw new Error("Generated 3D receipt does not match the immutable job artifacts");
    }

    const extension = thumbnailExtension(thumbnailArtifact.mimeType);
    const publicDirectory = resolve(this.generatedAssetRoot, "generated-3d", modelArtifact.sha256);
    const modelPath = resolve(publicDirectory, "model.glb");
    const thumbnailPath = resolve(publicDirectory, `thumbnail.${extension}`);
    await Promise.all([
      writeImmutable(modelPath, model, modelArtifact.sha256),
      writeImmutable(thumbnailPath, thumbnail, thumbnailArtifact.sha256),
    ]);

    return generated3dPromotionSchema.parse({
      contract: DIRECTOR_GENERATED_3D_CONTRACT,
      jobId: job.id,
      modelPath: `/generated-3d/${modelArtifact.sha256}/model.glb`,
      thumbnailPath: `/generated-3d/${modelArtifact.sha256}/thumbnail.${extension}`,
      receipt,
    });
  }
}
