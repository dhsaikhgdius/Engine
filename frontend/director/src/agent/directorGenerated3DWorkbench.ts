/**
 * Generated-3D workbench command executor (`generated_3d` operations).
 *
 * Bridges the Agent contract to the browser generated-3D pipeline: provider
 * discovery, job lifecycle (list / get / submit / cancel / retry / reconcile),
 * and promotion of a succeeded job's mesh into the Director asset library —
 * optionally placing it on the Stage through the same authoring path the UI
 * uses. Image-to-3D submissions resolve Gallery media to bytes locally so the
 * gateway never needs read access to the browser media store.
 */
import { prepareDirectorReferenceImage } from "../comprehensive/editor/reconstruction/referenceImageAnalysis";
import { directorAssetRefSchema } from "@director/project-schema";
import {
  persistentCreativeMediaLibrary,
  type CreativeMediaAsset,
} from "../comprehensive/editor/media/persistentCreativeMediaStore";
import { useDirectorStore, type DirectorStore } from "../comprehensive/editor/store/directorStore";
import {
  cancelGenerated3DJob,
  inspectGenerated3DJob,
  listGenerated3DJobs,
  listGenerated3DProviders,
  reconcileGenerated3DJob,
  retryGenerated3DJob,
  submitGenerated3DJob,
  type Generated3DJob,
} from "../comprehensive/editor/generated3d/generated3dClient";
import { prepareGenerated3DJobPromotion } from "../comprehensive/editor/generated3d/generated3dPromotion";
import type { DirectorAuthoringAction } from "@director/agent-engine/authoring";
import type { DirectorGenerated3DCommand, DirectorWorkbenchOperation } from "@director/agent-engine/contract";
import {
  executeDirectorWorkbenchOperation,
  type DirectorWorkbenchExecution,
  type DirectorWorkbenchExecutionOptions,
} from "./directorWorkbenchExecutor";

type PreparedPromotion = Awaited<ReturnType<typeof prepareGenerated3DJobPromotion>>;

/**
 * Injectable dependencies for the generated 3D workbench command.
 * Every field has a default wired to the live Director store and API clients;
 * override individual fields in tests or headless environments.
 */
export type DirectorGenerated3DWorkbenchDependencies = {
  /** Returns the current Director Zustand store snapshot. */
  getStore?: () => DirectorStore;
  /** Lists available 3D generation providers. */
  listProviders?: typeof listGenerated3DProviders;
  /** Lists generated 3D jobs, newest first. */
  listJobs?: typeof listGenerated3DJobs;
  /** Inspects a single generated 3D job by id. */
  inspectJob?: typeof inspectGenerated3DJob;
  /** Submits a new generated 3D job. */
  submitJob?: typeof submitGenerated3DJob;
  /** Cancels a running generated 3D job. */
  cancelJob?: typeof cancelGenerated3DJob;
  /** Retries a failed generated 3D job. */
  retryJob?: typeof retryGenerated3DJob;
  /** Reconciles a generated 3D job whose remote status may have diverged. */
  reconcileJob?: typeof reconcileGenerated3DJob;
  /** Looks up a Creative Media asset by id from the persistent library. */
  getMediaAsset?: (id: string) => CreativeMediaAsset | null;
  /** Reads the raw bytes of a Creative Media asset. */
  getMediaBlob?: (id: string) => Promise<Blob | null>;
  /** Prepares promotion data (asset, media, model URL) for a succeeded job. */
  preparePromotion?: (job: Generated3DJob, signal?: AbortSignal) => Promise<PreparedPromotion>;
  /** Executes an arbitrary Director workbench operation against the store. */
  executeWorkbench?: (
    getStore: () => DirectorStore,
    operation: DirectorWorkbenchOperation,
    options?: DirectorWorkbenchExecutionOptions,
  ) => DirectorWorkbenchExecution;
};

// Wire production dependencies to the live Director singleton and API clients.
function defaultDependencies(): Required<DirectorGenerated3DWorkbenchDependencies> {
  return {
    getStore: () => useDirectorStore.getState(),
    listProviders: listGenerated3DProviders,
    listJobs: listGenerated3DJobs,
    inspectJob: inspectGenerated3DJob,
    submitJob: submitGenerated3DJob,
    cancelJob: cancelGenerated3DJob,
    retryJob: retryGenerated3DJob,
    reconcileJob: reconcileGenerated3DJob,
    getMediaAsset: (id) => persistentCreativeMediaLibrary.getAsset(id),
    getMediaBlob: (id) => persistentCreativeMediaLibrary.getBlob(id),
    preparePromotion: (job, signal) => prepareGenerated3DJobPromotion(job, { signal }),
    executeWorkbench: executeDirectorWorkbenchOperation,
  };
}

/** Wrap a payload as a successful workbench execution. */
function executionResult(result: unknown): DirectorWorkbenchExecution {
  return { success: true, result };
}

// Merge workbench metadata into an existing execution result without
// overwriting the authoring outcome payload.
function mergedResult(execution: DirectorWorkbenchExecution, metadata: Record<string, unknown>) {
  const existing =
    execution.result && typeof execution.result === "object" && !Array.isArray(execution.result)
      ? (execution.result as Record<string, unknown>)
      : { value: execution.result ?? null };
  return { ...execution, result: { ...existing, ...metadata } };
}

/**
 * Executes a generated 3D workbench command.
 *
 * Supports listing providers, listing/inspecting/submitting/cancelling/
 * retrying/reconciling generated 3D jobs, and promoting a succeeded job's
 * output into the Director asset library and optionally onto the stage.
 *
 * @param command - The generated 3D command with action and parameters.
 * @param signal - Optional abort signal to cancel the operation.
 * @param options - Optional scope tag and dependency overrides.
 * @returns A workbench execution result with success status and payload.
 * @throws Never throws — errors are caught and returned as a failed execution.
 */
export async function executeDirectorGenerated3DWorkbenchCommand(
  command: DirectorGenerated3DCommand,
  signal?: AbortSignal,
  options: { scope?: string; dependencies?: DirectorGenerated3DWorkbenchDependencies } = {},
): Promise<DirectorWorkbenchExecution> {
  const dependencies = { ...defaultDependencies(), ...options.dependencies };
  try {
    signal?.throwIfAborted();
    switch (command.action) {
      case "providers":
        return executionResult(await dependencies.listProviders(signal));
      case "list":
        return executionResult({ jobs: await dependencies.listJobs(command.limit, signal) });
      case "get":
        return executionResult({ job: await dependencies.inspectJob(command.job_id, signal) });
      case "submit": {
        let sourceImageDataUrl: string | undefined;
        if (command.mode === "image-to-3d") {
          const source = dependencies.getMediaAsset(command.source_media_id!);
          if (!source) throw new Error(`Gallery media "${command.source_media_id}" does not exist`);
          if (source.kind !== "image") throw new Error(`Gallery media "${source.id}" is not an image`);
          const blob = await dependencies.getMediaBlob(source.id);
          if (!blob) throw new Error(`Gallery image "${source.id}" has no durable bytes`);
          signal?.throwIfAborted();
          const prepared = await prepareDirectorReferenceImage(
            new File([blob], source.fileName, {
              type: source.mimeType,
              lastModified: source.lastModified ?? Date.now(),
            }),
          );
          signal?.throwIfAborted();
          sourceImageDataUrl = prepared.dataUrl;
        }
        const job = await dependencies.submitJob(
          {
            mode: command.mode,
            providerId: command.provider_id,
            name: command.name,
            prompt: command.prompt,
            negativePrompt: command.negative_prompt,
            sourceImageDataUrl,
            targetHeightMeters: command.target_height_m,
            topology: command.topology,
            targetPolygonCount: command.target_polygon_count,
            texture: command.texture,
            pbr: command.pbr,
            seed: command.seed,
            modelVersion: command.model_version,
            idempotencyKey: command.idempotency_key,
          },
          signal,
        );
        return executionResult({ job, accepted: true });
      }
      case "cancel":
        return executionResult({ job: await dependencies.cancelJob(command.job_id, signal) });
      case "retry":
        return executionResult({ job: await dependencies.retryJob(command.job_id, command.idempotency_key, signal) });
      case "reconcile":
        return executionResult({ job: await dependencies.reconcileJob(command.job_id, signal) });
      case "promote": {
        const job = await dependencies.inspectJob(command.job_id, signal);
        if (job.status !== "succeeded") throw new Error(`Generated 3D job "${job.id}" is ${job.status}, not succeeded`);
        const prepared = await dependencies.preparePromotion(job, signal);
        signal?.throwIfAborted();
        const { addToScene: _addToScene, ...assetInput } = prepared.assetInput;
        const asset = directorAssetRefSchema.parse(assetInput);
        const actions: DirectorAuthoringAction[] = [{ action: "upsert_asset", asset }];
        if (command.add_to_scene) {
          actions.push({
            action: "add_object",
            id: command.object_id ?? `generated3d-object:${job.id}`,
            name: job.input.name,
            kind: "prop",
            asset_id: asset.id,
            transform: command.transform ?? { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
            placement_mode: command.placement_mode,
          });
        }
        const operation = {
          op: "author" as const,
          actions,
          expected_revision: command.expected_revision,
          idempotency_key: command.idempotency_key,
        } satisfies DirectorWorkbenchOperation;
        const execution = dependencies.executeWorkbench(dependencies.getStore, operation, { scope: options.scope });
        return mergedResult(execution, {
          generated_3d: {
            job_id: job.id,
            asset_id: asset.id,
            object_id: command.add_to_scene ? (command.object_id ?? `generated3d-object:${job.id}`) : null,
            gallery_media_id: prepared.galleryMediaId,
            model_url: prepared.modelUrl,
            thumbnail_url: prepared.thumbnailUrl,
            receipt: prepared.promotion.receipt,
          },
        });
      }
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      result: {
        code: error instanceof DOMException && error.name === "AbortError" ? "cancelled" : "generated_3d_failed",
      },
    };
  }
}
