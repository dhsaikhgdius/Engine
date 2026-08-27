import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DIRECTOR_GENERATED_3D_CONTRACT,
  DIRECTOR_GENERATED_3D_MAX_MODEL_BYTES,
  DIRECTOR_GENERATED_3D_MAX_THUMBNAIL_BYTES,
  generated3dJobInputSchema,
  generated3dReceiptSchema,
  type Generated3DJobInput,
  type Generated3DReceipt,
} from "../../../packages/protocol/src/generated3dProtocol";
import {
  productionJobArtifactSchema,
  transitionProductionJob,
  type ProductionJobArtifact,
  type ProductionJobRecord,
} from "../../../packages/protocol/src/productionJobProtocol";
import type { ProductionJobStore } from "../jobs/productionJobStore";
import { normalizeGenerated3DGlb } from "./generated3dNormalizer";
import type { Generated3DProviderSnapshot } from "./generated3dProviders";
import { Generated3DProviderRegistry } from "./generated3dProviders";
import type { Generated3DSourceStore } from "./generated3dSourceStore";

/**
 * Executor for `model.generate` production jobs. Owns the full lifecycle of
 * one generation: submit to a registered provider, poll until terminal,
 * download the outputs within hard byte caps, normalize the GLB for the Stage
 * runtime, and persist artifacts plus a signed receipt through the job store.
 *
 * Failure semantics are deliberately asymmetric: errors raised before the
 * provider accepted the submission fail the job outright, while errors after
 * acceptance transition to `outcome_unknown` because the provider may still be
 * (or have finished) rendering — {@link Generated3DExecutor.reconcile} later
 * resolves those against the provider's authoritative state. Artifact writes
 * are immutable (`wx` + content compare) so reconciliation after a crash can
 * never silently replace bytes a previous attempt already delivered.
 */

/** Cancellation handle for one in-flight execution keyed by job id. */
type ActiveExecution = { controller: AbortController; externalId: string | null };

/** Provider said "failed" definitively — no reconciliation needed, fail the job. */
class ProviderTerminalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderTerminalError";
  }
}

/** Abortable sleep between provider polls; rejects immediately on cancel. */
function delay(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("Generated 3D job cancelled"));
      },
      { once: true },
    );
  });
}

function sha256(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Loads a prior attempt's receipt if present; a malformed receipt is corruption, not absence. */
async function readExistingReceipt(path: string) {
  try {
    return generated3dReceiptSchema.parse(JSON.parse(await readFile(path, "utf8"))) as Generated3DReceipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(
      `Existing generated 3D receipt is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Write-once artifact persistence: `wx` refuses to overwrite, and an EEXIST
 * with byte-identical content is treated as success so a reconciliation rerun
 * is idempotent. Divergent existing content is an integrity error.
 */
async function writeImmutableArtifact(path: string, bytes: Uint8Array) {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, bytes, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readFile(path);
    if (existing.byteLength !== bytes.byteLength || sha256(existing) !== sha256(bytes)) {
      throw new Error(`Existing immutable artifact does not match the reconciled provider output: ${path}`);
    }
  }
}

/** Rejects credentialed URLs and plain HTTP (except loopback, used by local test doubles). */
function assertProviderUrl(raw: string) {
  const url = new URL(raw);
  if (url.username || url.password) throw new Error("Provider artifact URL must not contain credentials");
  const localHttp = url.protocol === "http:" && new Set(["127.0.0.1", "localhost", "::1", "[::1]"]).has(url.hostname);
  if (url.protocol !== "https:" && !localHttp) throw new Error("Provider artifact URL must use HTTPS");
  return url;
}

/** Local providers (Infinigen) hand over file:// URLs pointing at their own work directory. */
async function readLocalArtifact(rawUrl: string, maximumBytes: number, label: string) {
  const bytes = await readFile(fileURLToPath(rawUrl));
  if (!bytes.byteLength || bytes.byteLength > maximumBytes) {
    throw new Error(`${label} must be between 1 and ${maximumBytes} bytes`);
  }
  return bytes;
}

/** Downloads a provider artifact with size caps enforced both on the declared and actual byte counts. */
async function downloadBounded(
  fetchImpl: typeof fetch,
  rawUrl: string,
  maximumBytes: number,
  label: string,
  signal: AbortSignal,
) {
  assertProviderUrl(rawUrl);
  const response = await fetchImpl(rawUrl, { signal, redirect: "follow" });
  if (!response.ok) throw new Error(`${label} download returned HTTP ${response.status}`);
  // Redirects are followed, so the final URL must also pass the safety check.
  if (response.url) assertProviderUrl(response.url);
  const declaredBytes = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredBytes) && declaredBytes > maximumBytes) {
    throw new Error(`${label} exceeds the ${maximumBytes} byte limit`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.byteLength || bytes.byteLength > maximumBytes) {
    throw new Error(`${label} must be between 1 and ${maximumBytes} bytes`);
  }
  return bytes;
}

/** Sniffs the actual image format from magic bytes; provider-declared MIME types are not trusted. */
function thumbnailFormat(bytes: Buffer) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { extension: "png", mimeType: "image/png" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { extension: "jpg", mimeType: "image/jpeg" };
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { extension: "webp", mimeType: "image/webp" };
  }
  throw new Error("Generated 3D thumbnail is not PNG, JPEG, or WebP");
}

/** Most recent provider task id recorded for the current attempt (multi-phase providers append several). */
function latestExternalId(job: ProductionJobRecord) {
  const attempt = job.attempts.at(-1);
  return attempt?.externalIds?.at(-1) ?? attempt?.externalId ?? null;
}

/** Configuration for the generated 3D executor. */
export type Generated3DExecutorOptions = {
  pollIntervalMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

/**
 * Executes `model.generate` jobs against registered 3D generation providers.
 * Handles submission, polling, artifact download, GLB normalization, and
 * durable job transitions. Supports cancellation and reconciliation of jobs
 * whose outcome was uncertain after a gateway restart.
 */
export class Generated3DExecutor {
  private readonly active = new Map<string, ActiveExecution>();
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly store: ProductionJobStore,
    private readonly providers: Generated3DProviderRegistry,
    private readonly sources: Generated3DSourceStore,
    options: Generated3DExecutorOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
    this.timeoutMs = options.timeoutMs ?? 30 * 60_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Returns true when this executor can handle the given job kind. */
  supports(job: ProductionJobRecord) {
    return job.kind === "model.generate";
  }

  private async updateProgress(jobId: string, progress: number, message: string) {
    const current = await this.store.get(jobId);
    if (!current || current.status !== "running") return;
    await this.store.update(
      transitionProductionJob(current, "running", {
        progress: Math.max(current.progress, Math.min(0.98, progress)),
        message: message.slice(0, 12_000),
      }),
    );
  }

  private async writeArtifacts(
    job: ProductionJobRecord,
    input: Generated3DJobInput,
    snapshot: Required<Pick<Generated3DProviderSnapshot, "externalId" | "modelUrl" | "thumbnailUrl">>,
    signal: AbortSignal,
  ) {
    const localProvider = Boolean(this.providers.get(input.providerId).localArtifacts);
    const collect = (rawUrl: string, maximumBytes: number, label: string) =>
      localProvider && rawUrl.startsWith("file:")
        ? readLocalArtifact(rawUrl, maximumBytes, label)
        : downloadBounded(this.fetchImpl, rawUrl, maximumBytes, label, signal);
    const rawModel = await collect(snapshot.modelUrl, DIRECTOR_GENERATED_3D_MAX_MODEL_BYTES, "Generated GLB");
    await this.updateProgress(job.id, 0.94, "Validating and normalizing GLB");
    const normalized = await normalizeGenerated3DGlb(rawModel, {
      stableAssetId: `generated3d:${job.id}`,
      targetHeightMeters: input.targetHeightMeters,
      providerId: input.providerId,
      externalId: snapshot.externalId,
    });
    const thumbnail = await collect(
      snapshot.thumbnailUrl,
      DIRECTOR_GENERATED_3D_MAX_THUMBNAIL_BYTES,
      "Generated 3D thumbnail",
    );
    const thumbnailType = thumbnailFormat(thumbnail);
    const current = await this.store.get(job.id);
    if (!current) throw new Error(`Generated 3D job ${job.id} disappeared`);
    const attempt = current.attempts.at(-1)!;
    const receiptPath = this.store.artifactFilePath(job.id, attempt.id, "generated-3d-receipt.json");
    // A receipt from a previous (crashed) run of this same attempt makes the
    // rerun idempotent — but only when it matches this exact provider output.
    const existingReceipt = await readExistingReceipt(receiptPath);
    if (
      existingReceipt &&
      (existingReceipt.jobId !== job.id ||
        existingReceipt.attemptId !== attempt.id ||
        existingReceipt.providerId !== input.providerId ||
        existingReceipt.externalId !== snapshot.externalId ||
        existingReceipt.normalization.normalizedSha256 !== normalized.report.normalizedSha256)
    ) {
      throw new Error("Existing generated 3D receipt belongs to different provider output");
    }
    const createdAt = existingReceipt?.completedAt ?? new Date().toISOString();
    const primary = productionJobArtifactSchema.parse({
      id: `${attempt.id}-artifact-model`,
      attemptId: attempt.id,
      role: "primary",
      mimeType: "model/gltf-binary",
      fileName: "generated-model.glb",
      sha256: sha256(normalized.bytes),
      bytes: normalized.bytes.byteLength,
      createdAt,
    });
    const thumbnailArtifact = productionJobArtifactSchema.parse({
      id: `${attempt.id}-artifact-thumbnail`,
      attemptId: attempt.id,
      role: "thumbnail",
      mimeType: thumbnailType.mimeType,
      fileName: `generated-thumbnail.${thumbnailType.extension}`,
      sha256: sha256(thumbnail),
      bytes: thumbnail.byteLength,
      createdAt,
    });
    const receipt = generated3dReceiptSchema.parse({
      contract: DIRECTOR_GENERATED_3D_CONTRACT,
      jobId: job.id,
      attemptId: attempt.id,
      providerId: input.providerId,
      providerModelVersion: input.modelVersion ?? this.providers.get(input.providerId).capability.modelVersion,
      externalId: snapshot.externalId,
      mode: input.mode,
      promptSha256: sha256(input.prompt),
      sourceImageSha256: input.sourceImage?.sha256 ?? null,
      completedAt: createdAt,
      providerOutputHosts: [...new Set([new URL(snapshot.modelUrl).host, new URL(snapshot.thumbnailUrl).host])].filter(
        Boolean,
      ),
      normalization: normalized.report,
      artifacts: [primary, thumbnailArtifact].map((artifact) => ({
        role: artifact.role,
        fileName: artifact.fileName,
        mimeType: artifact.mimeType,
        bytes: artifact.bytes,
        sha256: artifact.sha256,
      })),
    });
    const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
    const receiptArtifact = productionJobArtifactSchema.parse({
      id: `${attempt.id}-artifact-receipt`,
      attemptId: attempt.id,
      role: "metadata",
      mimeType: "application/json",
      fileName: "generated-3d-receipt.json",
      sha256: sha256(receiptBytes),
      bytes: receiptBytes.byteLength,
      createdAt,
    });
    const files: Array<[ProductionJobArtifact, Uint8Array]> = [
      [primary, normalized.bytes],
      [thumbnailArtifact, thumbnail],
      [receiptArtifact, receiptBytes],
    ];
    await Promise.all(
      files.map(async ([artifact, bytes]) => {
        const path = this.store.artifactFilePath(job.id, attempt.id, artifact.fileName);
        await writeImmutableArtifact(path, bytes);
      }),
    );
    return { artifacts: files.map(([artifact]) => artifact), primary };
  }

  private async complete(
    job: ProductionJobRecord,
    input: Generated3DJobInput,
    snapshot: Generated3DProviderSnapshot,
    signal: AbortSignal,
  ) {
    if (!snapshot.modelUrl || !snapshot.thumbnailUrl) throw new Error("3D provider completion lacks output URLs");
    const { artifacts, primary } = await this.writeArtifacts(
      job,
      input,
      { externalId: snapshot.externalId, modelUrl: snapshot.modelUrl, thumbnailUrl: snapshot.thumbnailUrl },
      signal,
    );
    const current = await this.store.get(job.id);
    if (!current) throw new Error(`Generated 3D job ${job.id} disappeared`);
    return this.store.update(
      transitionProductionJob(current, "succeeded", {
        progress: 1,
        message: `Generated 3D asset normalized from ${input.providerId}`,
        artifacts,
        artifact: primary,
      }),
    );
  }

  /**
   * Executes a queued 3D generation job: submits to the provider, polls until
   * completion, downloads and normalizes the GLB, and persists artifacts.
   *
   * @param jobOrId - The job record or its id.
   * @returns The updated job record after execution.
   */
  async execute(jobOrId: ProductionJobRecord | string) {
    const job = typeof jobOrId === "string" ? await this.store.get(jobOrId) : jobOrId;
    if (!job || !this.supports(job) || job.status !== "queued") return job;
    const input = generated3dJobInputSchema.parse(job.input);
    const provider = this.providers.get(input.providerId);
    const controller = new AbortController();
    const active: ActiveExecution = { controller, externalId: null };
    this.active.set(job.id, active);
    let accepted = false;
    try {
      await this.store.update(
        transitionProductionJob(job, "running", {
          progress: 0.02,
          message: `Preparing ${provider.capability.label} generation`,
        }),
      );
      if (!provider.capability.configured) {
        throw new ProviderTerminalError(`${provider.capability.label} is not configured`);
      }
      const source = input.sourceImage
        ? { bytes: await this.sources.read(input.sourceImage), mimeType: input.sourceImage.mimeType }
        : null;
      await this.updateProgress(job.id, 0.03, `Submitting to ${provider.capability.label}`);
      active.externalId = await provider.submit(input, source, controller.signal);
      accepted = true;
      await this.store.appendCurrentAttemptExternalId(job.id, active.externalId);
      await this.updateProgress(job.id, 0.05, `Accepted by ${provider.capability.label}`);
      const deadline = Date.now() + this.timeoutMs;
      let consecutiveErrors = 0;
      while (Date.now() < deadline) {
        controller.signal.throwIfAborted();
        try {
          const snapshot = await provider.inspect(active.externalId, input, controller.signal);
          if (snapshot.externalId !== active.externalId) {
            active.externalId = snapshot.externalId;
            await this.store.appendCurrentAttemptExternalId(job.id, active.externalId);
          }
          consecutiveErrors = 0;
          await this.updateProgress(
            job.id,
            0.05 + snapshot.progress * 0.85,
            `${provider.capability.label} ${Math.round(snapshot.progress * 100)}%`,
          );
          if (snapshot.status === "succeeded") return await this.complete(job, input, snapshot, controller.signal);
          if (snapshot.status === "failed") throw new ProviderTerminalError(snapshot.error ?? "3D provider failed");
          if (snapshot.status === "cancelled") {
            const current = await this.store.get(job.id);
            if (!current || current.status !== "running") return current;
            return this.store.update(
              transitionProductionJob(current, "cancelled", {
                progress: current.progress,
                message: `${provider.capability.label} cancelled the task`,
              }),
            );
          }
        } catch (error) {
          // Transient poll failures (network blips, provider 5xx) are tolerated
          // up to a streak of 8; terminal provider verdicts and local aborts
          // propagate immediately.
          if (error instanceof ProviderTerminalError || controller.signal.aborted) throw error;
          consecutiveErrors += 1;
          if (consecutiveErrors >= 8) throw error;
        }
        await delay(this.pollIntervalMs, controller.signal);
      }
      throw new Error(`Generated 3D provider outcome was not confirmed within ${Math.round(this.timeoutMs / 1_000)}s`);
    } catch (error) {
      const current = await this.store.get(job.id);
      if (!current || current.status === "cancelled") return current;
      const message = error instanceof Error ? error.message : String(error);
      if (current.status === "running") {
        // Once the provider accepted the submission, any non-terminal error
        // leaves the remote task in an unknown state; report outcome_unknown so
        // reconcile can recover a success instead of double-billing a retry.
        const uncertain = accepted && !(error instanceof ProviderTerminalError);
        return this.store.update(
          transitionProductionJob(current, uncertain ? "outcome_unknown" : "failed", {
            progress: current.progress,
            message: uncertain ? "Provider outcome requires reconciliation" : "Generated 3D job failed",
            error: message,
            structuredError: {
              code: uncertain ? "generated_3d_outcome_unknown" : "generated_3d_failed",
              message,
              retryable: true,
            },
          }),
        );
      }
      return current;
    } finally {
      this.active.delete(job.id);
    }
  }

  /**
   * Cancels an in-progress 3D generation job. Attempts remote cancellation
   * at the provider when an external id is known.
   *
   * @param jobId - The job id to cancel.
   * @returns The updated job record, or null when the job does not exist.
   * @throws When the job is in a non-cancellable state.
   */
  async cancel(jobId: string) {
    const job = await this.store.get(jobId);
    if (!job || !this.supports(job)) return null;
    if (["succeeded", "failed", "cancelled"].includes(job.status)) return job;
    if (job.status !== "queued" && job.status !== "running")
      throw new Error(`Cannot cancel job in ${job.status} state`);
    const input = generated3dJobInputSchema.parse(job.input);
    const active = this.active.get(job.id);
    const externalId = active?.externalId ?? latestExternalId(job);
    active?.controller.abort(new Error("Generated 3D job cancelled by user"));
    const remotelyCancelled = externalId
      ? await this.providers
          .get(input.providerId)
          .cancel(externalId, input, AbortSignal.timeout(10_000))
          .catch(() => false)
      : false;
    const current = await this.store.get(job.id);
    if (!current || (current.status !== "queued" && current.status !== "running")) return current;
    return this.store.update(
      transitionProductionJob(current, "cancelled", {
        progress: current.progress,
        message: remotelyCancelled
          ? "Cancelled locally and at the 3D provider"
          : "Cancelled locally; this provider has no confirmed remote cancellation endpoint",
      }),
    );
  }

  /**
   * Reconciles a job whose outcome was unknown after a gateway restart.
   * Queries the provider for the final state and transitions accordingly.
   *
   * @param jobId - The job id to reconcile.
   * @returns The updated job record, or null when reconciliation is not needed.
   */
  async reconcile(jobId: string) {
    const job = await this.store.get(jobId);
    if (!job || !this.supports(job) || job.status !== "outcome_unknown") return job;
    const input = generated3dJobInputSchema.parse(job.input);
    const externalId = latestExternalId(job);
    if (!externalId) return job;
    const snapshot = await this.providers.get(input.providerId).inspect(externalId, input, AbortSignal.timeout(30_000));
    if (snapshot.externalId !== externalId)
      await this.store.appendCurrentAttemptExternalId(job.id, snapshot.externalId);
    if (snapshot.status !== "succeeded" && snapshot.status !== "failed" && snapshot.status !== "cancelled") return job;
    const reconciling = await this.store.beginReconciliation(job.id);
    if (!reconciling) return null;
    if (snapshot.status === "succeeded") {
      return this.complete(reconciling, input, snapshot, AbortSignal.timeout(5 * 60_000));
    }
    return this.store.resolveReconciliation(job.id, {
      status: "failed",
      message: `Reconciled ${input.providerId} ${snapshot.status}`,
      error: {
        code: snapshot.status === "cancelled" ? "generated_3d_provider_cancelled" : "generated_3d_provider_failed",
        message: snapshot.error ?? `Provider task is ${snapshot.status}`,
        retryable: true,
      },
    });
  }
}
