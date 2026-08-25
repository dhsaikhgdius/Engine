import type { ComfyGenerationSubmitRequest, ComfyWorkflowRecord } from "@director/protocol/comfyGenerationProtocol";
import type { ProductionJobArtifact, ProductionJobRecord } from "@director/protocol/productionJobProtocol";
import { probeCreativeMediaFile } from "../comprehensive/editor/media/creativeMediaProbe";
import {
  persistentCreativeMediaLibrary,
  type CreativeMediaAsset,
  type CreativeMediaImportOptions,
} from "../comprehensive/editor/media/persistentCreativeMediaStore";
import {
  cancelComfyGenerationJob,
  fetchGenerationArtifact,
  inspectComfyGenerationJob,
  listComfyGenerationJobs,
  listComfyGenerationNodes,
  listComfyGenerationWorkflows,
  reconcileComfyGenerationJob,
  retryComfyGenerationJob,
  submitComfyGeneration,
} from "../comprehensive/editor/workspaces/galleryGenerationBridge";
import type { DirectorGenerationCommand } from "@director/agent-engine/contract";
import type { DirectorWorkbenchExecution } from "./directorWorkbenchExecutor";

type GenerationJob = Extract<ProductionJobRecord, { kind: "image.generate" | "video.generate" | "audio.generate" }>;

/**
 * Injectable dependencies for the generation workbench command.
 * Every field has a default wired to the live Comfy generation bridge and
 * persistent media library; override individual fields in tests or headless
 * environments.
 */
export type DirectorGenerationWorkbenchDependencies = {
  /** Lists available Comfy generation nodes. */
  listNodes?: typeof listComfyGenerationNodes;
  /** Lists available Comfy generation workflows. */
  listWorkflows?: typeof listComfyGenerationWorkflows;
  /** Lists generation jobs, newest first. */
  listJobs?: typeof listComfyGenerationJobs;
  /** Inspects a single generation job by id. */
  inspectJob?: typeof inspectComfyGenerationJob;
  /** Submits a new generation job. */
  submitJob?: typeof submitComfyGeneration;
  /** Cancels a running generation job. */
  cancelJob?: typeof cancelComfyGenerationJob;
  /** Retries a failed generation job. */
  retryJob?: typeof retryComfyGenerationJob;
  /** Reconciles a generation job whose remote status may have diverged. */
  reconcileJob?: typeof reconcileComfyGenerationJob;
  /** Downloads a generation artifact blob by job and artifact id. */
  fetchArtifact?: typeof fetchGenerationArtifact;
  /** Probes a media file to determine its kind and intrinsic properties. */
  probeFile?: (file: File) => Promise<CreativeMediaImportOptions>;
  /** Imports a media file into the persistent Creative Media library. */
  importFile?: (file: File, options?: Omit<CreativeMediaImportOptions, "fileName">) => Promise<CreativeMediaAsset>;
  /** Ensures a waveform preview is generated for an audio asset. */
  ensureWaveform?: (id: string) => Promise<unknown>;
  /** Returns the current time as a Unix timestamp in milliseconds. */
  now?: () => number;
};

// Wire production dependencies to the live Comfy bridge and persistent media library.
function defaultDependencies(): Required<DirectorGenerationWorkbenchDependencies> {
  return {
    listNodes: listComfyGenerationNodes,
    listWorkflows: listComfyGenerationWorkflows,
    listJobs: listComfyGenerationJobs,
    inspectJob: inspectComfyGenerationJob,
    submitJob: submitComfyGeneration,
    cancelJob: cancelComfyGenerationJob,
    retryJob: retryComfyGenerationJob,
    reconcileJob: reconcileComfyGenerationJob,
    fetchArtifact: fetchGenerationArtifact,
    probeFile: probeCreativeMediaFile,
    importFile: (file, options) => persistentCreativeMediaLibrary.importFile(file, options),
    ensureWaveform: (id) => persistentCreativeMediaLibrary.ensureWaveform(id),
    now: Date.now,
  };
}

// Narrow a generic ProductionJobRecord to the generation-specific union.
function isGenerationJob(job: ProductionJobRecord): job is GenerationJob {
  return job.kind === "image.generate" || job.kind === "video.generate" || job.kind === "audio.generate";
}

// Map a generation job's kind to the Creative Media kind its artifacts produce.
function expectedMediaKind(job: GenerationJob) {
  return job.kind === "image.generate" ? "image" : job.kind === "video.generate" ? "video" : "audio";
}

// Strip the workflow body (which can be large) for compact listing responses.
function workflowSummary(workflow: ComfyWorkflowRecord) {
  const { workflow: _workflow, ...summary } = workflow;
  return summary;
}

// Filter job artifacts to the expected media kind, or validate specific
// requested artifact IDs. Throws when a requested artifact is missing or
// has the wrong media type.
function generationArtifacts(job: GenerationJob, requestedIds: readonly string[]): ProductionJobArtifact[] {
  const prefix = `${expectedMediaKind(job)}/`;
  const artifacts = job.artifacts.filter((artifact) => artifact.mimeType.toLocaleLowerCase().startsWith(prefix));
  if (!requestedIds.length) return artifacts;
  const byId = new Map(job.artifacts.map((artifact) => [artifact.id, artifact]));
  return requestedIds.map((id) => {
    const artifact = byId.get(id);
    if (!artifact) throw new Error(`Generation artifact "${id}" does not exist on job "${job.id}"`);
    if (!artifact.mimeType.toLocaleLowerCase().startsWith(prefix)) {
      throw new Error(`Generation artifact "${id}" is ${artifact.mimeType}, not ${expectedMediaKind(job)}`);
    }
    return artifact;
  });
}

// Build the Comfy generation submit payload from the workbench command.
// inputImages and sourceArtifactIds are left empty — the workbench does not
// support image-to-image or artifact-to-artifact chains through this path.
function submitRequest(
  command: Extract<DirectorGenerationCommand, { action: "submit" }>,
): ComfyGenerationSubmitRequest {
  return {
    kind: command.kind,
    workflowId: command.workflow_id,
    prompt: command.prompt,
    negativePrompt: command.negative_prompt,
    width: command.width,
    height: command.height,
    seed: command.seed,
    durationSeconds: command.duration_seconds,
    fps: command.fps,
    audioMode: command.audio_mode,
    sampleRate: command.sample_rate,
    voice: command.voice,
    language: command.language,
    parameters: command.parameters,
    inputImages: [],
    sourceArtifactIds: [],
    sourceContext: { source: "manual", metadata: {} },
    nodeIds: command.node_ids,
    copies: command.copies,
    seedStrategy: command.seed_strategy,
    promptProvenance: command.prompt_provenance,
    enhancePrompt: false,
    idempotencyKey: command.idempotency_key,
  };
}

function success(result: unknown): DirectorWorkbenchExecution {
  return { success: true, result };
}

/**
 * Executes a generation workbench command.
 *
 * Supports listing nodes/workflows, listing/inspecting/submitting/cancelling/
 * retrying/reconciling generation jobs, and promoting a succeeded job's
 * artifacts into the persistent Creative Media library with embedded
 * provenance metadata.
 *
 * @param command - The generation command with action and parameters.
 * @param signal - Optional abort signal to cancel the operation.
 * @param options - Optional dependency overrides.
 * @returns A workbench execution result with success status and payload.
 * @throws Never throws — errors are caught and returned as a failed execution.
 */
export async function executeDirectorGenerationWorkbenchCommand(
  command: DirectorGenerationCommand,
  signal?: AbortSignal,
  options: { dependencies?: DirectorGenerationWorkbenchDependencies } = {},
): Promise<DirectorWorkbenchExecution> {
  const dependencies = { ...defaultDependencies(), ...options.dependencies };
  try {
    signal?.throwIfAborted();
    switch (command.action) {
      case "nodes":
        return success({ nodes: await dependencies.listNodes(signal) });
      case "workflows": {
        const workflows = await dependencies.listWorkflows(signal);
        return success({
          workflows: workflows
            .filter((workflow) => !command.media_kind || workflow.mediaKind === command.media_kind)
            .map(workflowSummary),
        });
      }
      case "list":
        return success({ jobs: (await dependencies.listJobs(command.limit, signal)).filter(isGenerationJob) });
      case "get": {
        const job = await dependencies.inspectJob(command.job_id, signal);
        if (!isGenerationJob(job)) throw new Error(`Job "${command.job_id}" is not a Gallery generation job`);
        return success({ job });
      }
      case "submit": {
        const submitted = await dependencies.submitJob(submitRequest(command), signal);
        signal?.throwIfAborted();
        return success({ ...submitted, accepted: true });
      }
      case "cancel":
      case "retry":
      case "reconcile": {
        const job =
          command.action === "cancel"
            ? await dependencies.cancelJob(command.job_id, signal)
            : command.action === "retry"
              ? await dependencies.retryJob(command.job_id, command.idempotency_key, signal)
              : await dependencies.reconcileJob(command.job_id, signal);
        if (!isGenerationJob(job)) throw new Error(`Job "${command.job_id}" is not a Gallery generation job`);
        return success({ job });
      }
      case "promote": {
        const job = await dependencies.inspectJob(command.job_id, signal);
        if (!isGenerationJob(job)) throw new Error(`Job "${command.job_id}" is not a Gallery generation job`);
        if (job.status !== "succeeded") throw new Error(`Generation job "${job.id}" is ${job.status}, not succeeded`);
        const artifacts = generationArtifacts(job, command.artifact_ids);
        if (!artifacts.length) throw new Error(`Generation job "${job.id}" has no ${expectedMediaKind(job)} artifact`);
        const workflows = await dependencies.listWorkflows(signal);
        const workflow = workflows.find((candidate) => candidate.id === job.input.workflowId) ?? null;
        const promoted: Array<{
          artifact_id: string;
          media_id: string;
          bytes: number;
          mime_type: string;
          file_name: string;
          waveform_ready: boolean;
        }> = [];
        for (const artifact of artifacts) {
          signal?.throwIfAborted();
          const blob = await dependencies.fetchArtifact(job.id, artifact.id, signal);
          if (blob.size !== artifact.bytes) {
            throw new Error(
              `Generation artifact "${artifact.id}" byte count mismatch (${blob.size} received, ${artifact.bytes} expected)`,
            );
          }
          const file = new File([blob], artifact.fileName, {
            type: artifact.mimeType,
            lastModified: dependencies.now(),
          });
          const probe = await dependencies.probeFile(file);
          if (probe.kind !== expectedMediaKind(job)) {
            throw new Error(
              `Generation artifact "${artifact.id}" decoded as ${String(probe.kind)}, not ${expectedMediaKind(job)}`,
            );
          }
          const generationMetadata = JSON.stringify({
            version: 1,
            jobId: job.id,
            artifactId: artifact.id,
            kind: job.kind,
            prompt: job.input.prompt,
            negativePrompt: job.input.negativePrompt ?? "",
            seed: job.input.seed,
            workflowId: job.input.workflowId,
            nodeId: job.input.nodeId,
            parameters: job.input.parameters,
            promptProvenance: job.input.promptProvenance,
          }).slice(0, 200_000);
          const asset = await dependencies.importFile(file, {
            ...probe,
            source: `comfy-generation:${job.id}`,
            embeddedMetadata: {
              ...(probe.embeddedMetadata ?? {}),
              director_generation: generationMetadata,
              director_prompt: job.input.prompt.slice(0, 200_000),
              ...(workflow && !probe.embeddedMetadata?.workflow
                ? { workflow: JSON.stringify(workflow.workflow).slice(0, 200_000) }
                : {}),
            },
          });
          const waveform =
            command.ensure_waveform && asset.kind !== "image" ? await dependencies.ensureWaveform(asset.id) : null;
          promoted.push({
            artifact_id: artifact.id,
            media_id: asset.id,
            bytes: blob.size,
            mime_type: artifact.mimeType,
            file_name: artifact.fileName,
            waveform_ready: Boolean(asset.waveform || waveform),
          });
        }
        return success({
          generation: {
            job_id: job.id,
            kind: job.kind,
            workflow_id: job.input.workflowId,
            promoted,
          },
        });
      }
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      result: {
        code: error instanceof DOMException && error.name === "AbortError" ? "cancelled" : "generation_failed",
      },
    };
  }
}
