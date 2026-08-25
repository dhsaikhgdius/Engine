import type { Generated3DPromotion } from "../../../../../../packages/protocol/src/generated3dProtocol";
import { probeCreativeMediaFile } from "../media/creativeMediaProbe";
import {
  persistentCreativeMediaLibrary,
  type PersistentCreativeMediaLibrary,
} from "../media/persistentCreativeMediaStore";
import { useDirectorStore, type ImportedAssetInput } from "../store/directorStore";
import {
  fetchGenerated3DPublicArtifact,
  generated3DPublicUrl,
  requestGenerated3DPromotion,
  type Generated3DJob,
} from "./generated3dClient";

/** Injectable dependencies for the 3D job promotion pipeline. */
export type Generated3DPromotionDependencies = {
  /** Function to request a promotion receipt from the server. */
  requestPromotion?: (jobId: string, signal?: AbortSignal) => Promise<Generated3DPromotion>;
  /** Function to download a public artifact blob. */
  fetchPublicArtifact?: (path: string, signal?: AbortSignal) => Promise<Blob>;
  /** Function to resolve a relative path to a full public URL. */
  publicUrl?: (path: string) => string;
  /** Function to register an imported asset in the Director store. */
  addImportedAsset?: (input: ImportedAssetInput) => string;
  /** Media library instance for importing files into the gallery. */
  mediaLibrary?: Pick<PersistentCreativeMediaLibrary, "importFile">;
  /** Function to probe a media file for metadata and dimensions. */
  probeMedia?: typeof probeCreativeMediaFile;
  /** Optional abort signal for cancellation. */
  signal?: AbortSignal;
};

/**
 * Prepares a completed 3D generation job for promotion into the production.
 *
 * Downloads the thumbnail, probes it, imports it into the media library,
 * and constructs the asset input record—without yet registering it in the
 * Director store. Callers that need the asset in the scene should use
 * {@link promoteGenerated3DJob} instead.
 *
 * @param job - The completed 3D generation job to promote.
 * @param options - Optional dependency overrides for testing or custom pipelines.
 * @returns A promise resolving to the prepared asset input, gallery media ID, and artifact URLs.
 */
export async function prepareGenerated3DJobPromotion(
  job: Generated3DJob,
  options: Generated3DPromotionDependencies = {},
) {
  if (job.status !== "succeeded") throw new Error("只有成功的 3D 生成任务可以加入片场");
  const requestPromotion = options.requestPromotion ?? requestGenerated3DPromotion;
  const fetchPublicArtifact = options.fetchPublicArtifact ?? fetchGenerated3DPublicArtifact;
  const publicUrl = options.publicUrl ?? generated3DPublicUrl;
  const mediaLibrary = options.mediaLibrary ?? persistentCreativeMediaLibrary;
  const probeMedia = options.probeMedia ?? probeCreativeMediaFile;
  const promotion = await requestPromotion(job.id, options.signal);
  const receipt = promotion.receipt;
  const model = receipt.artifacts.find((artifact) => artifact.role === "primary");
  const thumbnail = receipt.artifacts.find((artifact) => artifact.role === "thumbnail");
  const receiptArtifact = job.artifacts.find((artifact) => artifact.role === "metadata");
  if (!model || !thumbnail || !receiptArtifact) throw new Error("生成回执缺少模型、缩略图或元数据哈希");

  const thumbnailBlob = await fetchPublicArtifact(promotion.thumbnailPath, options.signal);
  const thumbnailFile = new File([thumbnailBlob], thumbnail.fileName, {
    type: thumbnail.mimeType,
    lastModified: Date.parse(receipt.completedAt),
  });
  const probe = await probeMedia(thumbnailFile);
  const embeddedMetadata = {
    ...(probe.embeddedMetadata ?? {}),
    director_generated_3d: JSON.stringify({
      version: 1,
      contract: receipt.contract,
      jobId: job.id,
      providerId: receipt.providerId,
      externalId: receipt.externalId,
      modelSha256: model.sha256,
      thumbnailSha256: thumbnail.sha256,
      targetHeightMeters: receipt.normalization.targetHeightMeters,
      triangleCount: receipt.normalization.triangleCount,
      warnings: receipt.normalization.warnings,
    }).slice(0, 200_000),
    director_prompt: job.input.prompt.slice(0, 200_000),
  };
  const galleryAsset = await mediaLibrary.importFile(thumbnailFile, {
    ...probe,
    name: `${job.input.name} · 3D`,
    source: `generated-3d:${job.id}`,
    embeddedMetadata,
  });

  const modelUrl = publicUrl(promotion.modelPath);
  const thumbnailUrl = publicUrl(promotion.thumbnailPath);
  const assetInput: ImportedAssetInput = {
    id: `generated3d:${job.id}`,
    kind: "prop",
    sourceType: "model",
    name: job.input.name,
    fileName: model.fileName,
    url: modelUrl,
    thumbnailUrl,
    assetSource: "generated",
    modelNormalization: "preserve",
    generation: {
      contract: receipt.contract,
      jobId: job.id,
      providerId: receipt.providerId,
      externalId: receipt.externalId,
      modelSha256: model.sha256,
      thumbnailSha256: thumbnail.sha256,
      receiptArtifactId: receiptArtifact.id,
      prompt: job.input.prompt,
      createdAt: receipt.completedAt,
    },
  };
  return { assetInput, galleryMediaId: galleryAsset.id, modelUrl, thumbnailUrl, promotion };
}

/**
 * Promotes a completed 3D generation job into the production and optionally adds it to the scene.
 *
 * This is the full pipeline: it calls {@link prepareGenerated3DJobPromotion},
 * then registers the asset in the Director store.
 *
 * @param job - The completed 3D generation job to promote.
 * @param options - Optional configuration including whether to add the asset to the scene and dependency overrides.
 * @returns A promise resolving to the prepared promotion data plus the registered asset ID.
 */
export async function promoteGenerated3DJob(
  job: Generated3DJob,
  options: { addToScene?: boolean } & Generated3DPromotionDependencies = {},
) {
  const prepared = await prepareGenerated3DJobPromotion(job, options);
  const addImportedAsset = options.addImportedAsset ?? useDirectorStore.getState().addImportedAsset;
  const assetId = addImportedAsset({ ...prepared.assetInput, addToScene: options.addToScene ?? true });
  return { ...prepared, assetId };
}