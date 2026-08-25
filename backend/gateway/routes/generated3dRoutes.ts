import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  generated3dJobInputSchema,
  generated3dSubmitRequestSchema,
} from "../../../packages/protocol/src/generated3dProtocol";
import {
  productionJobRecordSchema,
  type ProductionJobRecord,
} from "../../../packages/protocol/src/productionJobProtocol";
import type { Generated3DExecutor } from "../generation/generated3dExecutor";
import type { Generated3DProviderRegistry } from "../generation/generated3dProviders";
import type { Generated3DPromotionStore } from "../generation/generated3dPromotionStore";
import type { Generated3DSourceStore } from "../generation/generated3dSourceStore";
import type { AssetSizeEstimator } from "../promptExpansion/assetSizeEstimator";
import { ProductionJobIdempotencyConflictError, type ProductionJobStore } from "../jobs/productionJobStore";

type JsonWriter = (response: ServerResponse, status: number, body: unknown) => void;
const retryRequestSchema = z.strictObject({ idempotencyKey: z.string().trim().min(8).max(180).optional() });

export type Generated3DRouteDependencies = {
  readBody: (request: IncomingMessage) => Promise<unknown>;
  json: JsonWriter;
  store: ProductionJobStore;
  providers: Generated3DProviderRegistry;
  sources: Generated3DSourceStore;
  executor: Generated3DExecutor;
  promotions: Generated3DPromotionStore;
  /** Estimates a plausible real-world height when a submission omits one. */
  sizeEstimator?: Pick<AssetSizeEstimator, "estimate">;
  createJobId?: () => string;
};

function routeId(pathname: string, suffix = "") {
  const escapedSuffix = suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = pathname.match(new RegExp(`^/api/generation/3d/jobs/([^/]+)${escapedSuffix}$`));
  return match ? decodeURIComponent(match[1]!) : null;
}

function isGenerated3DJob(job: ProductionJobRecord | null | undefined): job is ProductionJobRecord & {
  kind: "model.generate";
} {
  return job?.kind === "model.generate";
}

async function startJob(dependencies: Generated3DRouteDependencies, job: ProductionJobRecord) {
  if (job.status !== "queued") return;
  void dependencies.executor.execute(job).catch(() => undefined);
}

export async function handleGenerated3DRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  dependencies: Generated3DRouteDependencies,
) {
  const { json, store, providers, sources, executor } = dependencies;
  if (request.method === "GET" && url.pathname === "/api/generation/3d/providers") {
    json(response, 200, { defaultProvider: providers.defaultProvider, providers: providers.capabilities() });
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/generation/3d/jobs") {
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
    json(response, 200, { jobs: (await store.list(["model.generate"])).slice(0, limit) });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/generation/3d/jobs") {
    const parsed = generated3dSubmitRequestSchema.safeParse(await dependencies.readBody(request));
    if (!parsed.success) {
      json(response, 400, { message: "Generated 3D request is invalid", issues: parsed.error.issues });
      return true;
    }
    const providerId = parsed.data.providerId ?? providers.defaultProvider;
    const capability = providers.get(providerId).capability;
    if (!capability.configured) {
      json(response, 409, { message: `${capability.label} is not configured on the Director gateway` });
      return true;
    }
    const sourceImage = parsed.data.sourceImageDataUrl
      ? await sources.importDataUrl(parsed.data.sourceImageDataUrl)
      : null;
    // Without an explicit height, estimate one from the prompt so the asset
    // lands on the stage's metric scale; the job schema falls back to 1 m.
    let targetHeightMeters = parsed.data.targetHeightMeters;
    if (targetHeightMeters === undefined && dependencies.sizeEstimator) {
      try {
        targetHeightMeters = (
          await dependencies.sizeEstimator.estimate({ name: parsed.data.name, prompt: parsed.data.prompt })
        ).heightMeters;
      } catch {
        // Estimation is advisory; generation proceeds with the default height.
      }
    }
    const input = generated3dJobInputSchema.parse({
      mode: parsed.data.mode,
      providerId,
      name: parsed.data.name,
      prompt: parsed.data.prompt,
      negativePrompt: parsed.data.negativePrompt,
      sourceImage,
      targetHeightMeters,
      topology: parsed.data.topology,
      targetPolygonCount: parsed.data.targetPolygonCount,
      texture: parsed.data.texture,
      pbr: parsed.data.pbr,
      seed: parsed.data.seed,
      modelVersion: parsed.data.modelVersion,
    });
    try {
      const jobId = dependencies.createJobId?.() ?? `generated-3d-job-${randomUUID()}`;
      const job = await store.enqueue({
        kind: "model.generate",
        input,
        idempotencyKey: parsed.data.idempotencyKey ?? jobId,
        provider: `generated3d:${providerId}`,
        sourceRevisions: {
          ...(sourceImage ? { sourceImage: sourceImage.sha256 } : {}),
          providerModel: input.modelVersion ?? capability.modelVersion ?? "provider-default",
        },
        createId: () => jobId,
      });
      await startJob(dependencies, job);
      json(response, 202, { job: productionJobRecordSchema.parse(job) });
    } catch (error) {
      if (error instanceof ProductionJobIdempotencyConflictError) {
        json(response, 409, { code: error.code, message: error.message, existingJobId: error.existingJobId });
      } else {
        throw error;
      }
    }
    return true;
  }

  const cancelId = routeId(url.pathname, "/cancel");
  if (request.method === "POST" && cancelId) {
    try {
      const job = await executor.cancel(cancelId);
      if (!job) json(response, 404, { message: "Generated 3D job does not exist" });
      else json(response, 200, { job: productionJobRecordSchema.parse(job) });
    } catch (error) {
      json(response, 409, { message: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  const reconcileId = routeId(url.pathname, "/reconcile");
  if (request.method === "POST" && reconcileId) {
    try {
      const job = await executor.reconcile(reconcileId);
      if (!job) json(response, 404, { message: "Generated 3D job does not exist" });
      else json(response, 200, { job: productionJobRecordSchema.parse(job) });
    } catch (error) {
      json(response, 502, { message: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  const promoteId = routeId(url.pathname, "/promote");
  if (request.method === "POST" && promoteId) {
    try {
      const promotion = await dependencies.promotions.promote(promoteId);
      if (!promotion) json(response, 404, { message: "Generated 3D job does not exist" });
      else json(response, 200, { promotion });
    } catch (error) {
      json(response, 409, { message: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  const retryId = routeId(url.pathname, "/retry");
  if (request.method === "POST" && retryId) {
    const retryInput = retryRequestSchema.safeParse(await dependencies.readBody(request));
    if (!retryInput.success) {
      json(response, 400, { message: "Generated 3D retry request is invalid", issues: retryInput.error.issues });
      return true;
    }
    const source = await store.get(retryId);
    if (!isGenerated3DJob(source)) {
      json(response, 404, { message: "Generated 3D job does not exist" });
      return true;
    }
    if (source.status !== "failed" && source.status !== "cancelled") {
      json(response, 409, { message: "Only failed or cancelled generated 3D jobs can be retried" });
      return true;
    }
    const input = generated3dJobInputSchema.parse(source.input);
    if (!providers.get(input.providerId).capability.configured) {
      json(response, 409, { message: `${input.providerId} is no longer configured` });
      return true;
    }
    try {
      const retry = await store.enqueue({
        kind: "model.generate",
        input,
        idempotencyKey: retryInput.data.idempotencyKey ?? `${source.id}:retry:${randomUUID()}`,
        provider: source.attempts.at(-1)!.provider,
        sourceRevisions: { ...source.attempts.at(-1)!.sourceRevisions, retryOf: source.id },
        createId: dependencies.createJobId ?? (() => `generated-3d-job-${randomUUID()}`),
      });
      await startJob(dependencies, retry);
      json(response, 202, { job: productionJobRecordSchema.parse(retry) });
    } catch (error) {
      if (error instanceof ProductionJobIdempotencyConflictError) {
        json(response, 409, { code: error.code, message: error.message, existingJobId: error.existingJobId });
      } else {
        throw error;
      }
    }
    return true;
  }
  const jobId = routeId(url.pathname);
  if (request.method === "GET" && jobId) {
    const job = await store.get(jobId);
    if (!isGenerated3DJob(job)) json(response, 404, { message: "Generated 3D job does not exist" });
    else json(response, 200, { job: productionJobRecordSchema.parse(job) });
    return true;
  }
  return false;
}
