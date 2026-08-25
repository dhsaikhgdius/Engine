import {
  productionArtifactKindSchema,
  type ProductionArtifactVersion,
  type ProductionArtifactVersionInput,
} from "../../../packages/protocol/src/productionArtifactProtocol";
import type {
  ProductionJobArtifact,
  ProductionJobRecord,
} from "../../../packages/protocol/src/productionJobProtocol";
import type { ProductionArtifactStore } from "./productionArtifactStore";

/** Recorded creator id for versions registered through the job bridge. */
export const PRODUCTION_JOB_BRIDGE_CREATED_BY = "director.production-job-bridge" as const;

type ProductionArtifactKind = (typeof productionArtifactKindSchema.options)[number];

/**
 * Maps an artifact MIME type onto the broad production artifact kind used by
 * the immutable evidence store.
 *
 * @param mimeType - The artifact MIME type as recorded on the job artifact.
 * @returns The broad production artifact kind.
 */
export function productionArtifactKindFromMimeType(mimeType: string): ProductionArtifactKind {
  const normalized = mimeType.split(";", 1)[0]!.trim().toLowerCase();
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("video/")) return "video";
  if (normalized.startsWith("audio/")) return "audio";
  if (normalized.startsWith("model/")) return "model";
  if (normalized === "application/zip" || normalized === "application/gzip" || normalized.endsWith("+zip")) {
    return "archive";
  }
  if (
    normalized.startsWith("text/") ||
    normalized === "application/json" ||
    normalized === "application/pdf" ||
    normalized.endsWith("+json")
  ) {
    return "document";
  }
  return "other";
}

/** Stable artifact identity for one role slot of one logical job. */
export function productionJobArtifactId(jobId: string, role: string): string {
  return `production-job:${jobId}:${role}`;
}

/** Stable version identity for one immutable job artifact. */
export function productionJobArtifactVersionId(jobId: string, artifactId: string): string {
  return `production-job:${jobId}:${artifactId}`;
}

function attemptForArtifact(job: ProductionJobRecord, artifact: ProductionJobArtifact) {
  const attempt = job.attempts.find((candidate) => candidate.id === artifact.attemptId);
  if (!attempt) {
    throw new Error(`Production job artifact ${artifact.id} references unknown attempt ${artifact.attemptId}`);
  }
  return attempt;
}

/**
 * Projects a succeeded production job's immutable artifacts into
 * {@link ProductionArtifactVersionInput} records for the director_production
 * evidence store. The projection is deterministic: identities derive only
 * from the job id, artifact role, and artifact id, retries of the same
 * logical job append new ordinals under the same artifact id, and replaying
 * the projection yields byte-identical inputs so registration is idempotent.
 *
 * @param job - The full durable job record; must be in the succeeded state.
 * @returns One version input per job artifact, in job artifact order.
 * @throws When the job is not succeeded or an artifact references an unknown attempt.
 */
export function productionJobArtifactVersionInputs(job: ProductionJobRecord): ProductionArtifactVersionInput[] {
  if (job.status !== "succeeded") {
    throw new Error(`Only succeeded production jobs create artifact versions; job ${job.id} is ${job.status}`);
  }
  const ordinalByRole = new Map<string, number>();
  return job.artifacts.map((artifact) => {
    const attempt = attemptForArtifact(job, artifact);
    const ordinal = (ordinalByRole.get(artifact.role) ?? 0) + 1;
    ordinalByRole.set(artifact.role, ordinal);
    return {
      contract: "director-artifact-version-v1",
      versionId: productionJobArtifactVersionId(job.id, artifact.id),
      artifactId: productionJobArtifactId(job.id, artifact.role),
      ordinal,
      immutable: true,
      kind: productionArtifactKindFromMimeType(artifact.mimeType),
      name: `${job.kind} ${artifact.role} (${artifact.fileName})`,
      content: {
        sha256: artifact.sha256,
        bytes: artifact.bytes,
        mimeType: artifact.mimeType,
        fileName: artifact.fileName,
      },
      provenance: {
        kind: "job",
        jobId: job.id,
        attemptId: artifact.attemptId,
        inputFingerprint: `production-job:${job.inputFingerprint}`,
        provider: { provider: attempt.provider },
      },
      sourceVersionIds: [],
      createdAt: artifact.createdAt,
      createdBy: PRODUCTION_JOB_BRIDGE_CREATED_BY,
    } satisfies ProductionArtifactVersionInput;
  });
}

/** One registered version together with whether the write was an idempotent replay. */
export interface ProductionJobArtifactRegistration {
  readonly version: ProductionArtifactVersion;
  readonly replayed: boolean;
}

/**
 * Registers every artifact of a succeeded production job as an immutable
 * artifact version in the director_production evidence store. Replaying the
 * registration for the same job returns the existing evidence with
 * `replayed: true` instead of writing duplicates.
 *
 * @param store - The immutable production artifact store.
 * @param job - The succeeded job whose artifacts should become evidence.
 * @returns One registration per job artifact, in job artifact order.
 */
export async function registerProductionJobArtifactVersions(
  store: ProductionArtifactStore,
  job: ProductionJobRecord,
): Promise<ProductionJobArtifactRegistration[]> {
  const inputs = productionJobArtifactVersionInputs(job);
  const registrations: ProductionJobArtifactRegistration[] = [];
  for (const input of inputs) {
    registrations.push(await store.putVersion(input));
  }
  return registrations;
}
