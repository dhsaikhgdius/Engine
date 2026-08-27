import { createHash, randomInt, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  comfyGenerationSubmitRequestSchema,
  comfyUploadedInputImageSchema,
  comfyNodeDefinitionSchema,
  comfyWorkflowImportRequestSchema,
} from "../../../packages/protocol/src/comfyGenerationProtocol";
import {
  productionJobRecordSchema,
  type ProductionJobRecord,
} from "../../../packages/protocol/src/productionJobProtocol";
import type { ComfyGenerationExecutor } from "../generation/comfyGenerationExecutor";
import type { ComfyNodePool } from "../generation/comfyNodePool";
import type { ComfyWorkflowStore } from "../generation/comfyWorkflowStore";
import type { ImagePromptExpander } from "../promptExpansion/imagePromptExpander";
import { ProductionJobIdempotencyConflictError, type ProductionJobStore } from "../jobs/productionJobStore";

/**
 * HTTP routes for ComfyUI-backed generation (`/api/generation/...`): node
 * pool management, reference-image staging, workflow import/inspection, and
 * image/video/audio job submission with cancel/reconcile/retry.
 *
 * Boundary rules this handler enforces:
 * - Reference-image uploads are integrity-checked (caller-declared SHA-256
 *   must match the received bytes), size-capped, MIME-allowlisted, and the
 *   file name is sanitized before it is forwarded to a ComfyUI node.
 * - Multi-copy submissions fan out across the reachable nodes with derived
 *   per-copy idempotency keys (`<base>:<n>`) and one shared group id, so a
 *   replayed request maps onto the same job set.
 * - Prompt expansion is best effort: failures degrade to the verbatim
 *   prompt with a warning, and the raw prompt is preserved on the job's
 *   source context for reproducibility.
 */

type JsonWriter = (response: ServerResponse, status: number, body: unknown) => void;

/** Dependencies injected into the generation route handler. */
export type GenerationRouteDependencies = {
  /** Reads the JSON request body from the incoming HTTP message. */
  readBody: (request: IncomingMessage) => Promise<unknown>;
  /** Writes a JSON response with the given status code. */
  json: JsonWriter;
  /** The durable production job store. */
  store: ProductionJobStore;
  /** The ComfyUI node pool registry. */
  nodes: ComfyNodePool;
  /** The ComfyUI workflow store. */
  workflows: ComfyWorkflowStore;
  /** The ComfyUI generation executor. */
  executor: ComfyGenerationExecutor;
  /** Rewrites image prompts into the workflow's dialect when enhancePrompt is requested. */
  imagePromptExpander?: Pick<ImagePromptExpander, "expand">;
  /** Optional override for job id generation (defaults to a UUID-based generator). */
  createJobId?: () => string;
};

const inspectRequestSchema = comfyWorkflowImportRequestSchema.pick({ mediaKind: true, workflow: true });
const nodeActionSchema = z.strictObject({ action: z.enum(["interrupt", "free", "restart"]) });
const retryRequestSchema = z.strictObject({ idempotencyKey: z.string().trim().min(8).max(180).optional() });
const inputImageQuerySchema = z.strictObject({
  source_media_id: z.string().trim().min(1).max(512),
  source_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  file_name: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .refine((value) => value !== "." && value !== ".." && !value.includes("/") && !value.includes("\\")),
});
const COMFY_INPUT_IMAGE_MAX_BYTES = 256 * 1024 * 1024;
const COMFY_INPUT_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp"]);

/** Extracts the id from `/api/generation/<collection>/<id><suffix>` paths. */
function routeId(pathname: string, collection: "jobs" | "nodes" | "workflows", suffix = "") {
  const escapedSuffix = suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = pathname.match(new RegExp(`^\\/api\\/generation\\/${collection}\\/([^/]+)${escapedSuffix}$`));
  return match ? decodeURIComponent(match[1]!) : null;
}

// The job store is shared across kinds; these routes only answer for the
// generation kinds and report anything else as "does not exist".
function isGenerationJob(job: ProductionJobRecord) {
  return job.kind === "image.generate" || job.kind === "video.generate" || job.kind === "audio.generate";
}

// Fire-and-forget: the executor persists progress and failures on the job
// record; the route never awaits execution.
async function startJob(dependencies: GenerationRouteDependencies, job: ProductionJobRecord) {
  if (job.status !== "queued") return;
  void dependencies.executor.execute(job).catch(() => undefined);
}

/**
 * Streams the raw request body with a hard byte cap enforced both on the
 * declared Content-Length and on the actual received bytes, so a lying
 * header cannot buffer an oversized upload into memory.
 */
async function readRawBody(request: IncomingMessage, maximumBytes: number) {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maximumBytes) throw new RangeError("Reference image is too large");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = new Uint8Array(Buffer.from(chunk));
    size += bytes.byteLength;
    if (size > maximumBytes) throw new RangeError("Reference image is too large");
    chunks.push(bytes);
  }
  if (!size) throw new TypeError("Reference image is empty");
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

// Sanitized, digest-prefixed name for the ComfyUI input directory: strips
// path separators/odd characters and keeps names collision-free per content.
function safeInputFileName(fileName: string, sha256: string) {
  const normalized = fileName
    .normalize("NFKC")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(-180);
  return `director-${sha256.slice(0, 20)}-${normalized || "reference.png"}`;
}

/**
 * Routes generation HTTP requests: node management, workflow import/inspection,
 * job submission, cancellation, reconciliation, and retry.
 *
 * Returns `true` when the request was handled; `false` when the URL does not
 * match any generation route and the caller should try the next handler.
 *
 * @param request - The incoming HTTP request.
 * @param response - The outgoing HTTP response.
 * @param url - The parsed request URL.
 * @param dependencies - The generation subsystem dependencies.
 * @returns `true` when the request was handled, `false` otherwise.
 */
export async function handleGenerationRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  dependencies: GenerationRouteDependencies,
): Promise<boolean> {
  const { json, nodes, workflows, store, executor } = dependencies;

  if (request.method === "GET" && url.pathname === "/api/generation/nodes") {
    json(response, 200, { nodes: await nodes.snapshots() });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/generation/nodes") {
    const parsed = comfyNodeDefinitionSchema.safeParse(await dependencies.readBody(request));
    if (!parsed.success) {
      json(response, 400, { message: "ComfyUI node definition is invalid", issues: parsed.error.issues });
      return true;
    }
    json(response, 200, { node: await nodes.upsert(parsed.data) });
    return true;
  }
  const inputImageNodeId = routeId(url.pathname, "nodes", "/input-images");
  if (request.method === "POST" && inputImageNodeId) {
    const parsed = inputImageQuerySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) {
      json(response, 400, { message: "Reference-image upload query is invalid", issues: parsed.error.issues });
      return true;
    }
    const mimeType = String(request.headers["content-type"] ?? "")
      .split(";", 1)[0]!
      .trim()
      .toLowerCase();
    if (!COMFY_INPUT_IMAGE_MIME_TYPES.has(mimeType)) {
      json(response, 415, { message: "Reference image must be PNG, JPEG, WebP, GIF, or BMP" });
      return true;
    }
    try {
      const bytes = await readRawBody(request, COMFY_INPUT_IMAGE_MAX_BYTES);
      const actualSha256 = createHash("sha256").update(bytes).digest("hex");
      if (actualSha256 !== parsed.data.source_sha256) {
        json(response, 409, { message: "Reference-image SHA-256 does not match the uploaded bytes" });
        return true;
      }
      const fileName = safeInputFileName(parsed.data.file_name, actualSha256);
      const form = new FormData();
      form.set("image", new Blob([bytes], { type: mimeType }), fileName);
      form.set("type", "input");
      form.set("subfolder", "director");
      form.set("overwrite", "true");
      const upload = await nodes.request(inputImageNodeId, "/upload/image", {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(120_000),
      });
      const body = (await upload.json().catch(() => null)) as Record<string, unknown> | null;
      if (!upload.ok || !body) throw new Error(`ComfyUI input upload returned HTTP ${upload.status}`);
      const returnedName = typeof body.name === "string" ? body.name : fileName;
      const subfolder = typeof body.subfolder === "string" ? body.subfolder : "director";
      const storageType = body.type === "input" ? "input" : null;
      if (!returnedName || returnedName.includes("/") || returnedName.includes("\\") || storageType !== "input") {
        throw new Error("ComfyUI returned an invalid input-image receipt");
      }
      const workflowValue = subfolder
        ? `${subfolder.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")}/${returnedName}`
        : returnedName;
      json(
        response,
        201,
        comfyUploadedInputImageSchema.parse({
          version: 1,
          nodeId: inputImageNodeId,
          sourceMediaId: parsed.data.source_media_id,
          sourceSha256: actualSha256,
          bytes: bytes.byteLength,
          mimeType,
          fileName: returnedName,
          subfolder,
          storageType,
          workflowValue,
          uploadedAt: new Date().toISOString(),
        }),
      );
    } catch (error) {
      json(response, error instanceof RangeError ? 413 : 502, {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }
  const nodeActionId = routeId(url.pathname, "nodes", "/actions");
  if (request.method === "POST" && nodeActionId) {
    const parsed = nodeActionSchema.safeParse(await dependencies.readBody(request));
    if (!parsed.success) {
      json(response, 400, { message: "ComfyUI node action is invalid", issues: parsed.error.issues });
      return true;
    }
    try {
      json(response, 200, { node: await nodes.action(nodeActionId, parsed.data.action) });
    } catch (error) {
      json(response, 502, { message: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  const nodeId = routeId(url.pathname, "nodes");
  if (request.method === "DELETE" && nodeId) {
    try {
      const removed = await nodes.remove(nodeId);
      json(response, removed ? 200 : 404, { removed });
    } catch (error) {
      json(response, 409, { message: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/generation/workflows") {
    json(response, 200, { workflows: await workflows.list() });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/generation/workflows/inspect") {
    const parsed = inspectRequestSchema.safeParse(await dependencies.readBody(request));
    if (!parsed.success) {
      json(response, 400, { message: "ComfyUI API workflow JSON is invalid", issues: parsed.error.issues });
      return true;
    }
    const supported = await nodes.supportedClassTypes();
    try {
      json(response, 200, {
        inspection: workflows.inspect(
          parsed.data.workflow,
          parsed.data.mediaKind,
          supported.size ? supported : undefined,
        ),
      });
    } catch (error) {
      json(response, 400, { message: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/generation/workflows") {
    const body = await dependencies.readBody(request);
    const parsed = comfyWorkflowImportRequestSchema.safeParse(body);
    if (!parsed.success) {
      json(response, 400, { message: "ComfyUI workflow import is invalid", issues: parsed.error.issues });
      return true;
    }
    const supported = await nodes.supportedClassTypes();
    try {
      json(response, 201, { workflow: await workflows.import(parsed.data, supported.size ? supported : undefined) });
    } catch (error) {
      json(response, 422, { message: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  const workflowId = routeId(url.pathname, "workflows");
  if (request.method === "DELETE" && workflowId) {
    try {
      const removed = await workflows.remove(workflowId);
      json(response, removed ? 200 : 404, { removed });
    } catch (error) {
      json(response, 409, { message: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/generation/jobs") {
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
    const jobs = (await store.list(["image.generate", "video.generate", "audio.generate"])).slice(0, limit);
    json(response, 200, { jobs });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/generation/jobs") {
    const parsed = comfyGenerationSubmitRequestSchema.safeParse(await dependencies.readBody(request));
    if (!parsed.success) {
      json(response, 400, { message: "Generation request is invalid", issues: parsed.error.issues });
      return true;
    }
    const workflow = await workflows.get(parsed.data.workflowId);
    if (!workflow) {
      json(response, 404, { message: `ComfyUI workflow ${parsed.data.workflowId} does not exist` });
      return true;
    }
    const expectedKind =
      parsed.data.kind === "image.generate" ? "image" : parsed.data.kind === "video.generate" ? "video" : "audio";
    if (workflow.mediaKind !== expectedKind) {
      json(response, 409, { message: `Selected workflow produces ${workflow.mediaKind}, not ${expectedKind}` });
      return true;
    }
    const candidates = await nodes.available(parsed.data.nodeIds);
    if (!candidates.length) {
      json(response, 409, { message: "No selected ComfyUI node is currently reachable" });
      return true;
    }
    if (parsed.data.inputImages.length) {
      // Reference images were staged onto one specific node's input storage;
      // fanning the job out to other nodes would render without them.
      if (parsed.data.nodeIds.length !== 1 || candidates.length !== 1) {
        json(response, 409, { message: "Reference-image generation must target exactly one ComfyUI node" });
        return true;
      }
      const candidateId = candidates[0]!.id;
      const descriptors = new Map(workflow.parameters.map((parameter) => [parameter.id, parameter]));
      const seenParameters = new Set<string>();
      for (const inputImage of parsed.data.inputImages) {
        const descriptor = descriptors.get(inputImage.parameterId);
        if (
          inputImage.nodeId !== candidateId ||
          !descriptor ||
          (descriptor.type !== "image" && descriptor.semantic !== "reference_image") ||
          parsed.data.parameters[inputImage.parameterId] !== inputImage.workflowValue ||
          seenParameters.has(inputImage.parameterId)
        ) {
          json(response, 409, { message: `Reference-image binding ${inputImage.parameterId} is invalid` });
          return true;
        }
        seenParameters.add(inputImage.parameterId);
      }
    }
    let prompt = parsed.data.prompt;
    let negativePrompt = parsed.data.negativePrompt;
    let sourceContext = parsed.data.sourceContext;
    const warnings: string[] = [];
    if (parsed.data.enhancePrompt && parsed.data.kind === "image.generate") {
      if (!dependencies.imagePromptExpander) {
        warnings.push("Prompt expansion is not configured on this gateway; the prompt was submitted verbatim.");
      } else {
        try {
          const expansion = await dependencies.imagePromptExpander.expand({
            prompt: parsed.data.prompt,
            negativePrompt: parsed.data.negativePrompt,
            width: parsed.data.width,
            height: parsed.data.height,
            referenceImageCount: parsed.data.inputImages.length,
          });
          prompt = expansion.expandedPrompt;
          if (!negativePrompt && expansion.suggestedNegativePrompt) {
            negativePrompt = expansion.suggestedNegativePrompt;
          }
          // The raw prompt stays on the durable job so results remain reproducible and auditable.
          sourceContext = {
            ...sourceContext,
            metadata: {
              ...sourceContext.metadata,
              raw_prompt: parsed.data.prompt.slice(0, 4_000),
              prompt_expanded: true,
            },
          };
        } catch (error) {
          warnings.push(
            `Prompt expansion failed (${error instanceof Error ? error.message : String(error)}); the original prompt was submitted verbatim.`,
          );
        }
      }
    }
    // One submission may enqueue several copies: each copy gets a derived
    // idempotency key (`<base>:<n>`) and all share one group id, so a
    // replayed request resolves to the same job set.
    const groupId = parsed.data.idempotencyKey
      ? `generation-group:${parsed.data.idempotencyKey}`
      : `generation-group-${randomUUID()}`;
    const baseKey = parsed.data.idempotencyKey ?? groupId;
    const jobs: ProductionJobRecord[] = [];
    try {
      for (let index = 0; index < parsed.data.copies; index += 1) {
        // Round-robin copies across the reachable nodes; seeds follow the
        // requested strategy (fixed, random, or deterministic increment).
        const node = candidates[index % candidates.length]!;
        const seed =
          parsed.data.seedStrategy === "fixed"
            ? parsed.data.seed
            : parsed.data.seedStrategy === "random"
              ? randomInt(0, 2_147_483_648)
              : (parsed.data.seed + index) % 2_147_483_648;
        const input =
          parsed.data.kind === "audio.generate"
            ? {
                prompt: parsed.data.prompt,
                negativePrompt: parsed.data.negativePrompt,
                mode: parsed.data.audioMode,
                durationSeconds: parsed.data.durationSeconds,
                sampleRate: parsed.data.sampleRate,
                voice: parsed.data.voice,
                language: parsed.data.language,
                workflowId: workflow.id,
                nodeId: node.id,
                seed,
                parameters: parsed.data.parameters,
                inputImages: parsed.data.inputImages,
                sourceArtifactIds: [
                  ...new Set([
                    ...parsed.data.sourceArtifactIds,
                    ...parsed.data.inputImages.map((image) => image.sourceMediaId),
                  ]),
                ],
                sourceContext: parsed.data.sourceContext,
                promptProvenance: parsed.data.promptProvenance,
              }
            : {
                prompt,
                negativePrompt,
                width: parsed.data.width,
                height: parsed.data.height,
                workflowId: workflow.id,
                nodeId: node.id,
                seed,
                parameters: parsed.data.parameters,
                inputImages: parsed.data.inputImages,
                sourceArtifactIds: [
                  ...new Set([
                    ...parsed.data.sourceArtifactIds,
                    ...parsed.data.inputImages.map((image) => image.sourceMediaId),
                  ]),
                ],
                sourceContext,
                promptProvenance: parsed.data.promptProvenance,
                ...(parsed.data.kind === "video.generate"
                  ? { durationSeconds: parsed.data.durationSeconds, fps: parsed.data.fps }
                  : {}),
              };
        const job = await store.enqueue({
          kind: parsed.data.kind,
          input,
          idempotencyKey: `${baseKey}:${index + 1}`,
          provider: `comfyui:${node.id}`,
          sourceRevisions: {
            workflow: workflow.workflowSha256,
            group: groupId,
            ...Object.fromEntries(
              parsed.data.inputImages.map((image, imageIndex) => [`inputImage${imageIndex + 1}`, image.sourceSha256]),
            ),
          },
          createId: dependencies.createJobId ?? (() => `generation-job-${randomUUID()}`),
        });
        jobs.push(job);
        await startJob(dependencies, job);
      }
    } catch (error) {
      if (error instanceof ProductionJobIdempotencyConflictError) {
        json(response, 409, { code: error.code, message: error.message, existingJobId: error.existingJobId });
        return true;
      }
      throw error;
    }
    json(response, 202, {
      groupId,
      jobs: jobs.map((job) => productionJobRecordSchema.parse(job)),
      ...(warnings.length ? { warnings } : {}),
    });
    return true;
  }

  const cancelJobId = routeId(url.pathname, "jobs", "/cancel");
  if (request.method === "POST" && cancelJobId) {
    try {
      const job = await executor.cancel(cancelJobId);
      if (!job) json(response, 404, { message: "Generation job does not exist" });
      else json(response, 200, { job: productionJobRecordSchema.parse(job) });
    } catch (error) {
      json(response, 409, { message: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  const reconcileJobId = routeId(url.pathname, "jobs", "/reconcile");
  if (request.method === "POST" && reconcileJobId) {
    try {
      const job = await executor.reconcile(reconcileJobId);
      if (!job) json(response, 404, { message: "Generation job does not exist" });
      else json(response, 200, { job: productionJobRecordSchema.parse(job) });
    } catch (error) {
      json(response, 502, { message: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  const retryJobId = routeId(url.pathname, "jobs", "/retry");
  if (request.method === "POST" && retryJobId) {
    const retryInput = retryRequestSchema.safeParse(await dependencies.readBody(request));
    if (!retryInput.success) {
      json(response, 400, { message: "Generation retry request is invalid", issues: retryInput.error.issues });
      return true;
    }
    const source = await store.get(retryJobId);
    if (!source || !isGenerationJob(source)) {
      json(response, 404, { message: "Generation job does not exist" });
      return true;
    }
    if (source.status !== "failed" && source.status !== "cancelled") {
      json(response, 409, { message: "Only failed or cancelled generation jobs can be retried" });
      return true;
    }
    const workflow = await workflows.get(source.input.workflowId);
    if (!workflow) {
      json(response, 409, { message: "The generation workflow is no longer available" });
      return true;
    }
    try {
      const retry = await store.enqueue({
        kind: source.kind,
        input: source.input,
        idempotencyKey: retryInput.data.idempotencyKey ?? `${source.id}:retry:${randomUUID()}`,
        provider: source.attempts.at(-1)!.provider,
        sourceRevisions: { workflow: workflow.workflowSha256, retryOf: source.id },
        createId: dependencies.createJobId ?? (() => `generation-job-${randomUUID()}`),
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
  const jobId = routeId(url.pathname, "jobs");
  if (request.method === "GET" && jobId) {
    const job = await store.get(jobId);
    if (!job || !isGenerationJob(job)) json(response, 404, { message: "Generation job does not exist" });
    else json(response, 200, { job: productionJobRecordSchema.parse(job) });
    return true;
  }

  return false;
}
