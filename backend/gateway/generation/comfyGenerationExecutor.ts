import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { WebSocket } from "ws";
import {
  audioGenerationJobInputSchema,
  imageGenerationJobInputSchema,
  productionJobArtifactSchema,
  transitionProductionJob,
  videoGenerationJobInputSchema,
  type ProductionJobArtifact,
  type ProductionJobRecord,
} from "../../../packages/protocol/src/productionJobProtocol";
import type { ProductionJobStore } from "../jobs/productionJobStore";
import { patchComfyWorkflow } from "./comfyWorkflow";
import type { ComfyNodePool } from "./comfyNodePool";
import type { ComfyWorkflowStore } from "./comfyWorkflowStore";

/**
 * Executor for ComfyUI-backed `image.generate` / `video.generate` /
 * `audio.generate` production jobs. One execution acquires a slot on the
 * chosen node (ComfyUI runs one prompt at a time per instance), patches the
 * stored workflow with the request inputs, submits it, and treats the
 * `/history/{promptId}` entry as the single source of truth for completion —
 * the WebSocket stream is used only for advisory progress and its absence
 * never fails a job.
 *
 * The prompt id is persisted on the job attempt before waiting begins, so a
 * gateway restart mid-render can later resolve the real outcome through
 * {@link ComfyGenerationExecutor.reconcile} instead of re-rendering blindly.
 */

/** One file location inside ComfyUI's output tree, as found in history JSON. */
type ComfyOutputReference = {
  filename: string;
  subfolder: string;
  type: "input" | "output" | "temp";
};

/** Cancellation handle plus the identifiers needed to cancel remotely. */
type ActiveExecution = {
  controller: AbortController;
  nodeId: string;
  promptId: string | null;
};

// Extension allowlist doubling as the MIME map; anything ComfyUI produces
// outside this set is ignored rather than served with a guessed type.
const OUTPUT_MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  avif: "image/avif",
  gif: "image/gif",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  wav: "audio/wav",
  mp3: "audio/mpeg",
  flac: "audio/flac",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
};

/** Extension of a filename only when it maps to a supported output type. */
function safeExtension(fileName: string) {
  const extension = fileName.split(".").at(-1)?.toLowerCase() ?? "";
  return Object.prototype.hasOwnProperty.call(OUTPUT_MIME_TYPES, extension) ? extension : null;
}

// History output layout varies by node pack, so instead of hardcoding shapes
// this walks the whole entry and collects anything that looks like a file
// reference, de-duplicated by (type, subfolder, filename).
function collectOutputReferences(value: unknown, results = new Map<string, ComfyOutputReference>()) {
  if (Array.isArray(value)) value.forEach((entry) => collectOutputReferences(entry, results));
  else if (value && typeof value === "object") {
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.filename === "string" && safeExtension(candidate.filename)) {
      const type = candidate.type === "input" || candidate.type === "temp" ? candidate.type : "output";
      const subfolder = typeof candidate.subfolder === "string" ? candidate.subfolder : "";
      results.set(`${type}:${subfolder}:${candidate.filename}`, { filename: candidate.filename, subfolder, type });
    }
    Object.values(candidate).forEach((entry) => collectOutputReferences(entry, results));
  }
  return [...results.values()];
}

/** Picks this prompt's entry out of the `/history/{id}` response, if present yet. */
function historyEntry(history: unknown, promptId: string) {
  if (!history || typeof history !== "object") return null;
  const record = (history as Record<string, unknown>)[promptId];
  return record && typeof record === "object" ? (record as Record<string, unknown>) : null;
}

/** Extracts a bounded failure description from a history entry, or null when it succeeded. */
function historyFailure(entry: Record<string, unknown>) {
  const status = entry.status;
  if (!status || typeof status !== "object") return null;
  const statusRecord = status as Record<string, unknown>;
  if (statusRecord.status_str === "error") return "ComfyUI reported an execution error";
  const messages = statusRecord.messages;
  if (!Array.isArray(messages)) return null;
  const failure = messages.find((message) => Array.isArray(message) && String(message[0]).includes("error"));
  return failure ? JSON.stringify(failure).slice(0, 12_000) : null;
}

/** Abortable sleep between history polls; rejects immediately on cancel. */
function delay(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("Generation cancelled"));
      },
      { once: true },
    );
  });
}

/** Derives the ComfyUI progress WebSocket URL from the node's HTTP base URL. */
function websocketUrl(baseUrl: string, clientId: string) {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/ws`;
  url.search = "";
  url.searchParams.set("clientId", clientId);
  return url.toString();
}

/** Configuration for the ComfyUI generation executor. */
export type ComfyGenerationExecutorOptions = {
  pollIntervalMs?: number;
  timeoutMs?: number;
  webSocketFactory?: ((url: string) => WebSocket) | null;
};

/**
 * Executes image, video, and audio generation jobs against a pool of ComfyUI
 * nodes. Submits a prompt, polls the history endpoint, observes progress via
 * WebSocket (with a polling fallback), downloads artifacts, and transitions
 * the durable job record. Supports cancellation and reconciliation of jobs
 * whose outcome was uncertain after a gateway restart.
 */
export class ComfyGenerationExecutor {
  private readonly active = new Map<string, ActiveExecution>();
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly webSocketFactory: ((url: string) => WebSocket) | null;

  constructor(
    private readonly store: ProductionJobStore,
    private readonly nodes: ComfyNodePool,
    private readonly workflows: ComfyWorkflowStore,
    options: ComfyGenerationExecutorOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 750;
    this.timeoutMs = options.timeoutMs ?? 30 * 60_000;
    this.webSocketFactory =
      options.webSocketFactory === undefined ? (url: string) => new WebSocket(url) : options.webSocketFactory;
  }

  /** Returns true when this executor can handle the given job kind. */
  supports(job: ProductionJobRecord) {
    return job.kind === "image.generate" || job.kind === "video.generate" || job.kind === "audio.generate";
  }

  private async updateProgress(jobId: string, progress: number, message: string) {
    try {
      const current = await this.store.get(jobId);
      if (!current || current.status !== "running") return;
      await this.store.update(
        transitionProductionJob(current, "running", {
          progress: Math.max(current.progress, Math.min(0.98, progress)),
          message: message.slice(0, 12_000),
        }),
      );
    } catch {
      // Progress is advisory; immutable final state always wins a race.
    }
  }

  // Advisory progress via the ComfyUI WebSocket. Multi-sampler workflows
  // (e.g. base + refiner) report per-sampler 0-100% ranges, so progress is
  // mapped into equal phases to avoid the bar jumping back to zero between
  // samplers. Updates are throttled to one per 200ms.
  private observeProgress(
    job: ProductionJobRecord,
    baseUrl: string,
    clientId: string,
    promptId: string,
    workflow: Record<string, { class_type: string; _meta?: { title?: string } }>,
  ) {
    let lastUpdate = 0;
    const samplerNodeIds = Object.entries(workflow)
      .filter(([, node]) => /sampler/i.test(node.class_type))
      .map(([nodeId]) => nodeId);
    let samplerPhase = 0;
    let socket: WebSocket | null = null;
    if (!this.webSocketFactory) return () => undefined;
    try {
      socket = this.webSocketFactory(websocketUrl(baseUrl, clientId));
      socket.on("message", (raw) => {
        try {
          const message = JSON.parse(raw.toString()) as {
            type?: string;
            data?: { prompt_id?: string; node?: string | null; value?: number; max?: number };
          };
          if (message.data?.prompt_id && message.data.prompt_id !== promptId) return;
          const now = Date.now();
          if (now - lastUpdate < 200) return;
          lastUpdate = now;
          if (
            message.type === "progress" &&
            Number.isFinite(message.data?.value) &&
            Number.isFinite(message.data?.max)
          ) {
            const ratio = Math.max(0, Math.min(1, message.data!.value! / Math.max(1, message.data!.max!)));
            const phases = Math.max(1, samplerNodeIds.length);
            const phaseProgress = (Math.min(phases - 1, samplerPhase) + ratio) / phases;
            const phaseLabel = phases > 1 ? `Phase ${Math.min(phases, samplerPhase + 1)}/${phases} · ` : "";
            void this.updateProgress(
              job.id,
              0.1 + phaseProgress * 0.82,
              `${phaseLabel}Sampling ${message.data!.value}/${message.data!.max}`,
            );
          } else if (message.type === "executing" && typeof message.data?.node === "string") {
            const node = workflow[message.data.node];
            const phase = samplerNodeIds.indexOf(message.data.node);
            if (phase >= 0) samplerPhase = phase;
            const label = node?._meta?.title || node?.class_type || message.data.node;
            void this.updateProgress(job.id, 0.12, `Running ${label}`);
          }
        } catch {
          // Binary preview frames and unknown extensions are intentionally ignored.
        }
      });
      socket.on("error", () => undefined);
    } catch {
      // Polling below is the compatibility fallback when WebSocket is unavailable.
    }
    return () => socket?.close();
  }

  // Downloads every discovered output. Files whose MIME class matches the job
  // kind rank first (the first becomes the primary artifact); mismatched extras
  // are kept as alternates because some workflows emit useful side outputs.
  private async downloadArtifacts(
    job: ProductionJobRecord,
    nodeId: string,
    promptId: string,
    entry: Record<string, unknown>,
  ) {
    const discoveredReferences = collectOutputReferences(entry.outputs ?? entry);
    if (!discoveredReferences.length)
      throw new Error("ComfyUI completed without a supported image, video, or audio output");
    const expectedMimePrefix =
      job.kind === "image.generate" ? "image/" : job.kind === "video.generate" ? "video/" : "audio/";
    const matchingReferences = discoveredReferences.filter((reference) => {
      const extension = safeExtension(reference.filename);
      return extension ? OUTPUT_MIME_TYPES[extension].startsWith(expectedMimePrefix) : false;
    });
    if (!matchingReferences.length) {
      throw new Error(`ComfyUI completed without a ${expectedMimePrefix.slice(0, -1)} output for ${job.kind}`);
    }
    const references = [
      ...matchingReferences,
      ...discoveredReferences.filter((reference) => !matchingReferences.includes(reference)),
    ];
    const attempt = job.attempts.at(-1)!;
    const artifacts: ProductionJobArtifact[] = [];
    for (let index = 0; index < references.length; index += 1) {
      const reference = references[index]!;
      const extension = safeExtension(reference.filename)!;
      const query = new URLSearchParams({
        filename: reference.filename,
        subfolder: reference.subfolder,
        type: reference.type,
      });
      const response = await this.nodes.request(nodeId, `/view?${query}`);
      if (!response.ok) throw new Error(`ComfyUI output download returned HTTP ${response.status}`);
      const declaredBytes = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredBytes) && declaredBytes > 2 * 1024 * 1024 * 1024) {
        throw new Error("ComfyUI output exceeds the 2 GiB Director artifact limit");
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.byteLength > 2 * 1024 * 1024 * 1024)
        throw new Error("ComfyUI output exceeds the 2 GiB Director artifact limit");
      const fileName = `output-${index + 1}.${extension}`;
      const artifact = productionJobArtifactSchema.parse({
        id: `${attempt.id}-artifact-${index + 1}`,
        attemptId: attempt.id,
        role: index === 0 ? "primary" : "alternate",
        mimeType: OUTPUT_MIME_TYPES[extension],
        fileName,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.byteLength,
        createdAt: new Date().toISOString(),
      });
      const path = this.store.artifactFilePath(job.id, attempt.id, fileName);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
      artifacts.push(artifact);
    }

    const receipt = Buffer.from(
      JSON.stringify(
        {
          version: 1,
          jobId: job.id,
          provider: `comfyui:${nodeId}`,
          promptId,
          kind: job.kind,
          input: job.input,
          outputs: references,
          completedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    const receiptFileName = "generation-receipt.json";
    const receiptArtifact = productionJobArtifactSchema.parse({
      id: `${attempt.id}-artifact-receipt`,
      attemptId: attempt.id,
      role: "metadata",
      mimeType: "application/json",
      fileName: receiptFileName,
      sha256: createHash("sha256").update(receipt).digest("hex"),
      bytes: receipt.byteLength,
      createdAt: new Date().toISOString(),
    });
    const receiptPath = this.store.artifactFilePath(job.id, attempt.id, receiptFileName);
    await mkdir(dirname(receiptPath), { recursive: true });
    await writeFile(receiptPath, receipt);
    artifacts.push(receiptArtifact);
    return artifacts;
  }

  private async completeFromHistory(
    job: ProductionJobRecord,
    nodeId: string,
    promptId: string,
    entry: Record<string, unknown>,
  ) {
    const failure = historyFailure(entry);
    if (failure) throw new Error(failure);
    const artifacts = await this.downloadArtifacts(job, nodeId, promptId, entry);
    const current = await this.store.get(job.id);
    if (!current) throw new Error(`Generation job ${job.id} disappeared`);
    const primary = artifacts.find((artifact) => artifact.role === "primary");
    const succeeded = transitionProductionJob(current, "succeeded", {
      progress: 1,
      message: `Completed on ${nodeId}`,
      artifacts,
      artifact: primary,
    });
    return this.store.update(succeeded);
  }

  /**
   * Executes a queued generation job: acquires a node slot, submits the
   * workflow, polls until completion, and downloads artifacts.
   *
   * @param jobOrId - The job record or its id.
   * @returns The updated job record after execution.
   */
  async execute(jobOrId: ProductionJobRecord | string) {
    const job = typeof jobOrId === "string" ? await this.store.get(jobOrId) : jobOrId;
    if (!job || !this.supports(job) || job.status !== "queued") return job;
    const imageInput = job.kind === "image.generate" ? imageGenerationJobInputSchema.parse(job.input) : null;
    const videoInput = job.kind === "video.generate" ? videoGenerationJobInputSchema.parse(job.input) : null;
    const audioInput = job.kind === "audio.generate" ? audioGenerationJobInputSchema.parse(job.input) : null;
    const input = imageInput ?? videoInput ?? audioInput!;
    const controller = new AbortController();
    const active: ActiveExecution = { controller, nodeId: input.nodeId, promptId: null };
    this.active.set(job.id, active);
    let release: (() => void) | null = null;
    let closeObserver: (() => void) | null = null;
    try {
      const workflowRecord = await this.workflows.get(input.workflowId);
      if (!workflowRecord) throw new Error(`ComfyUI workflow ${input.workflowId} does not exist`);
      const expectedKind = job.kind === "image.generate" ? "image" : job.kind === "video.generate" ? "video" : "audio";
      if (workflowRecord.mediaKind !== expectedKind) {
        throw new Error(`Workflow ${workflowRecord.name} produces ${workflowRecord.mediaKind}, not ${expectedKind}`);
      }
      release = await this.nodes.acquire(input.nodeId, controller.signal);
      let current = await this.store.get(job.id);
      if (!current || current.status !== "queued") return current;
      current = await this.store.update(
        transitionProductionJob(current, "running", { progress: 0.03, message: `Preparing ${workflowRecord.name}` }),
      );
      const workflow = patchComfyWorkflow(
        workflowRecord.workflow,
        workflowRecord.parameters,
        videoInput
          ? {
              prompt: videoInput.prompt,
              negativePrompt: videoInput.negativePrompt,
              width: videoInput.width,
              height: videoInput.height,
              seed: videoInput.seed,
              parameters: videoInput.parameters,
              durationSeconds: videoInput.durationSeconds,
              fps: videoInput.fps,
            }
          : audioInput
            ? {
                prompt: audioInput.prompt,
                negativePrompt: audioInput.negativePrompt,
                width: 1_024,
                height: 1_024,
                seed: audioInput.seed,
                parameters: audioInput.parameters,
                durationSeconds: audioInput.durationSeconds,
                sampleRate: audioInput.sampleRate,
                voice: audioInput.voice,
                language: audioInput.language,
                audioMode: audioInput.mode,
              }
            : {
                prompt: imageInput!.prompt,
                negativePrompt: imageInput!.negativePrompt,
                width: imageInput!.width,
                height: imageInput!.height,
                seed: imageInput!.seed,
                parameters: imageInput!.parameters,
              },
      );
      const clientId = `director-${randomUUID()}`;
      const response = await this.nodes.request(input.nodeId, "/prompt", {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ prompt: workflow, client_id: clientId }),
      });
      const responseBody = (await response.json().catch(() => null)) as { prompt_id?: unknown; error?: unknown } | null;
      if (!response.ok || typeof responseBody?.prompt_id !== "string") {
        throw new Error(
          typeof responseBody?.error === "string"
            ? responseBody.error
            : `ComfyUI submission returned HTTP ${response.status}`,
        );
      }
      // Persist the prompt id before waiting: this is what lets reconciliation
      // find the remote task again after a gateway crash mid-render.
      active.promptId = responseBody.prompt_id;
      await this.store.setCurrentAttemptExternalId(job.id, responseBody.prompt_id);
      const node = await this.nodes.get(input.nodeId);
      closeObserver = this.observeProgress(current, node!.baseUrl, clientId, responseBody.prompt_id, workflow);
      await this.updateProgress(job.id, 0.08, `Queued on ${node!.label}`);

      const deadline = Date.now() + this.timeoutMs;
      let consecutiveErrors = 0;
      while (Date.now() < deadline) {
        controller.signal.throwIfAborted();
        try {
          const history = await this.nodes.json(
            input.nodeId,
            `/history/${encodeURIComponent(responseBody.prompt_id)}`,
            {
              signal: controller.signal,
            },
          );
          const entry = historyEntry(history, responseBody.prompt_id);
          if (entry) return await this.completeFromHistory(current, input.nodeId, responseBody.prompt_id, entry);
          consecutiveErrors = 0;
        } catch (error) {
          if (controller.signal.aborted) throw error;
          consecutiveErrors += 1;
          if (consecutiveErrors >= 8) throw error;
        }
        await delay(this.pollIntervalMs, controller.signal);
      }
      throw new Error(`ComfyUI generation timed out after ${Math.round(this.timeoutMs / 1_000)} seconds`);
    } catch (error) {
      const current = await this.store.get(job.id);
      if (current?.status === "cancelled") return current;
      // A failure before the queued→running transition (e.g. missing workflow)
      // still has to pass through "running" because the job state machine only
      // allows failing a running job.
      let running = current;
      if (running?.status === "queued") {
        running = await this.store.update(
          transitionProductionJob(running, "running", {
            progress: running.progress,
            message: "Generation executor started",
          }),
        );
      }
      if (running?.status === "running") {
        const message = error instanceof Error ? error.message : String(error);
        return this.store.update(
          transitionProductionJob(running, "failed", {
            message: "Generation failed",
            error: message,
            structuredError: { code: "comfy_generation_failed", message, retryable: true },
          }),
        );
      }
      return running;
    } finally {
      closeObserver?.();
      release?.();
      this.active.delete(job.id);
    }
  }

  /**
   * Cancels an in-progress generation job. If the job is still queued or
   * running, the ComfyUI prompt is cancelled on the remote node.
   *
   * @param jobId - The job id to cancel.
   * @returns The updated job record, or null when the job does not exist.
   * @throws When the job is in a non-cancellable state.
   */
  async cancel(jobId: string) {
    const job = await this.store.get(jobId);
    if (!job || !this.supports(job)) return null;
    if (job.status === "cancelled" || job.status === "failed" || job.status === "succeeded") return job;
    if (job.status !== "queued" && job.status !== "running")
      throw new Error(`Cannot cancel job in ${job.status} state`);
    const input =
      job.kind === "image.generate"
        ? imageGenerationJobInputSchema.parse(job.input)
        : job.kind === "video.generate"
          ? videoGenerationJobInputSchema.parse(job.input)
          : audioGenerationJobInputSchema.parse(job.input);
    const active = this.active.get(jobId);
    active?.controller.abort(new Error("Generation cancelled by user"));
    const promptId = active?.promptId ?? job.attempts.at(-1)?.externalId ?? null;
    if (promptId)
      await this.nodes.cancelPrompt(input.nodeId, promptId, job.status === "running").catch(() => undefined);
    const latest = await this.store.get(jobId);
    if (!latest || (latest.status !== "queued" && latest.status !== "running")) return latest;
    return this.store.update(
      transitionProductionJob(latest, "cancelled", { message: "Cancelled by user", progress: latest.progress }),
    );
  }

  /**
   * Reconciles a job whose outcome was unknown after a gateway restart.
   * Queries the ComfyUI history endpoint to determine the final state.
   *
   * @param jobId - The job id to reconcile.
   * @returns The updated job record, or null when reconciliation is not needed.
   */
  async reconcile(jobId: string) {
    const job = await this.store.get(jobId);
    if (!job || !this.supports(job) || job.status !== "outcome_unknown") return job;
    const input =
      job.kind === "image.generate"
        ? imageGenerationJobInputSchema.parse(job.input)
        : job.kind === "video.generate"
          ? videoGenerationJobInputSchema.parse(job.input)
          : audioGenerationJobInputSchema.parse(job.input);
    const promptId = job.attempts.at(-1)?.externalId;
    if (!promptId) return job;
    const history = await this.nodes.json(input.nodeId, `/history/${encodeURIComponent(promptId)}`);
    const entry = historyEntry(history, promptId);
    if (!entry) return job;
    const reconciling = await this.store.beginReconciliation(jobId);
    if (!reconciling) return null;
    try {
      return await this.completeFromHistory(reconciling, input.nodeId, promptId, entry);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.store.resolveReconciliation(jobId, {
        status: "failed",
        message: "Reconciled ComfyUI failure",
        error: { code: "comfy_reconciled_failure", message, retryable: true },
      });
    }
  }
}
