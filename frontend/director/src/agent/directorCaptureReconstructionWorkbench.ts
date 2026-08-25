import type {
  CaptureReconstructionPlan,
  CaptureSourceKind,
} from "@director/protocol/captureReconstructionProtocol";
import type { ProductionJobRecord } from "@director/protocol/productionJobProtocol";
import { uploadBlenderModelAsset } from "../comprehensive/editor/api/blenderLiveClient";
import {
  persistentCreativeMediaLibrary,
  type CreativeMediaAsset,
} from "../comprehensive/editor/media/persistentCreativeMediaStore";
import {
  compareLuminanceImages,
  luminanceFromRgba,
  type LuminanceImage,
} from "../comprehensive/editor/reconstruction/captureCompare";
import { buildCaptureReconstructionAuthoringActions } from "../comprehensive/editor/reconstruction/captureReconstructionApply";
import {
  detectCaptureSourceKind,
  fetchCaptureArtifactBlob,
  fetchCaptureReconstructionPlan,
  getCaptureReconstructionJob,
  listCaptureReconstructionJobs,
  stageCaptureSource,
  submitCaptureReconstruction,
} from "../comprehensive/editor/reconstruction/captureReconstructionClient";
import { useDirectorStore, type DirectorStore } from "../comprehensive/editor/store/directorStore";
import type { DirectorReconstructionCommand, DirectorWorkbenchOperation } from "@director/agent-engine/contract";
import {
  executeDirectorWorkbenchOperation,
  type DirectorWorkbenchExecution,
  type DirectorWorkbenchExecutionOptions,
} from "./directorWorkbenchExecutor";

/**
 * Pattern matching a staged source identifier: an optional prefix chain
 * followed by {@code sha256:} and a 64-char hex digest. When a source media
 * id matches this pattern it is already uploaded and must be accompanied by
 * an explicit {@code source_kind}.
 */
const STAGED_SOURCE_ID_PATTERN = /^(?:[A-Za-z0-9._-]+:)*sha256:[a-f0-9]{64}$/;

/**
 * Parameters for an offscreen render capture of a specific camera view at a
 * given frame, used to compare the current 3D scene against a reconstruction
 * keyframe.
 */
export type CaptureViewportRequest = {
  /** Identifier of the camera to render from. */
  cameraId: string;
  /** Frame number to capture. */
  frame: number;
  /** Render width in pixels. */
  width: number;
  /** Render height in pixels. */
  height: number;
};

/**
 * Injectable dependencies for the capture reconstruction workbench command.
 * Every field has a default wired to the live Director store and API clients;
 * override individual fields in tests or headless environments.
 */
export type DirectorCaptureReconstructionWorkbenchDependencies = {
  /** Returns the current Director Zustand store snapshot. */
  getStore?: () => DirectorStore;
  /** Lists reconstruction jobs, optionally filtered by scope. */
  listJobs?: typeof listCaptureReconstructionJobs;
  /** Fetches a single reconstruction job by id. */
  getJob?: typeof getCaptureReconstructionJob;
  /** Fetches the full reconstruction plan for a completed job. */
  fetchPlan?: typeof fetchCaptureReconstructionPlan;
  /** Submits a new capture reconstruction job. */
  submitJob?: typeof submitCaptureReconstruction;
  /** Uploads a capture source file to the staging area. */
  stageSource?: typeof stageCaptureSource;
  /** Downloads a reconstruction artifact blob by artifact id. */
  fetchArtifactBlob?: typeof fetchCaptureArtifactBlob;
  /** Looks up a Creative Media asset by id from the persistent library. */
  getMediaAsset?: (id: string) => CreativeMediaAsset | null;
  /** Reads the raw bytes of a Creative Media asset. */
  getMediaBlob?: (id: string) => Promise<Blob | null>;
  /** Uploads a model blob as a Blender asset and returns its URL. */
  uploadModelAsset?: (blob: Blob, fileName: string, assetId: string) => Promise<{ url: string }>;
  /** Offscreen stage render through the browser capture bridge. */
  requestCapture?: (request: CaptureViewportRequest, signal?: AbortSignal) => Promise<string | null>;
  /** Decodes a keyframe Blob or a stage-capture data URL into luminance. */
  decodeImage?: (source: Blob | string) => Promise<LuminanceImage>;
  /** Executes an arbitrary Director workbench operation against the store. */
  executeWorkbench?: (
    getStore: () => DirectorStore,
    operation: DirectorWorkbenchOperation,
    options?: DirectorWorkbenchExecutionOptions,
  ) => DirectorWorkbenchExecution;
  /** Returns the current timestamp as an ISO-8601 string. */
  now?: () => string;
};

// Decode either a blob or a data URL into a luminance image for comparison.
// createImageBitmap handles both formats natively; the canvas round-trip
// extracts raw pixel data for luminance computation.
async function defaultDecodeImage(source: Blob | string): Promise<LuminanceImage> {
  const bitmap = await createImageBitmap(typeof source === "string" ? await (await fetch(source)).blob() : source);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D context is unavailable; cannot compare images");
    context.drawImage(bitmap, 0, 0);
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    return luminanceFromRgba(imageData.data, imageData.width, imageData.height);
  } finally {
    bitmap.close();
  }
}

// Wire production dependencies to the live Director singleton and API clients.
function defaultDependencies(): Required<DirectorCaptureReconstructionWorkbenchDependencies> {
  return {
    getStore: () => useDirectorStore.getState(),
    listJobs: listCaptureReconstructionJobs,
    getJob: getCaptureReconstructionJob,
    fetchPlan: fetchCaptureReconstructionPlan,
    submitJob: submitCaptureReconstruction,
    stageSource: stageCaptureSource,
    fetchArtifactBlob: fetchCaptureArtifactBlob,
    getMediaAsset: (id) => persistentCreativeMediaLibrary.getAsset(id),
    getMediaBlob: (id) => persistentCreativeMediaLibrary.getBlob(id),
    uploadModelAsset: (blob, fileName, assetId) => uploadBlenderModelAsset(blob, fileName, assetId),
    requestCapture: async () => null,
    decodeImage: defaultDecodeImage,
    executeWorkbench: executeDirectorWorkbenchOperation,
    now: () => new Date().toISOString(),
  };
}

function executionResult(result: unknown): DirectorWorkbenchExecution {
  return { success: true, result };
}

// Extract only the fields the workbench contract exposes; omit internal
// job metadata that callers should not depend on.
function compactJob(job: ProductionJobRecord) {
  const input = job.kind === "scene.reconstruct" ? job.input : null;
  return {
    job_id: job.id,
    status: job.status,
    progress: job.progress,
    message: job.message ?? null,
    file_name: input?.fileName ?? null,
    source_kind: input?.sourceKind ?? null,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
  };
}

// Produce a compact summary of the reconstruction plan suitable for
// agent consumption — raw plan objects are too large for context windows.
function planSummary(plan: CaptureReconstructionPlan) {
  return {
    plan_id: plan.id,
    job_id: plan.jobId,
    status: plan.analysis.status,
    providers: plan.analysis.providers,
    metrics: plan.analysis.metrics,
    warnings: plan.analysis.warnings,
    object_count: plan.objects.length,
    door_count: plan.objects.filter((object) => object.role === "door").length,
    camera_count: plan.cameras.length,
    has_shell: Boolean(plan.shell),
  };
}

/**
 * Executes a capture reconstruction workbench command.
 *
 * Supports listing, inspecting, submitting, planning, applying, and comparing
 * capture reconstruction jobs. The apply action authors scene objects from a
 * completed reconstruction plan; compare renders the current stage viewport
 * and scores it against the original capture keyframe.
 *
 * @param command - The reconstruction command with action and parameters.
 * @param signal - Optional abort signal to cancel the operation.
 * @param options - Optional scope tag and dependency overrides.
 * @returns A workbench execution result with success status and payload.
 * @throws Never throws — errors are caught and returned as a failed execution.
 */
export async function executeDirectorCaptureReconstructionWorkbenchCommand(
  command: DirectorReconstructionCommand,
  signal?: AbortSignal,
  options: { scope?: string; dependencies?: DirectorCaptureReconstructionWorkbenchDependencies } = {},
): Promise<DirectorWorkbenchExecution> {
  const dependencies = { ...defaultDependencies(), ...options.dependencies };
  try {
    signal?.throwIfAborted();
    switch (command.action) {
      case "list": {
        const jobs = await dependencies.listJobs(signal);
        return executionResult({ jobs: jobs.slice(0, command.limit).map(compactJob) });
      }
      case "get":
        return executionResult({ job: compactJob(await dependencies.getJob(command.job_id, signal)) });
      case "submit": {
        let sourceMediaId = command.source_media_id;
        let sourceKind: CaptureSourceKind | undefined = command.source_kind;
        let fileName = "capture.bin";
        if (STAGED_SOURCE_ID_PATTERN.test(sourceMediaId)) {
          if (!sourceKind) {
            throw new Error("Staged capture input must set source_kind (rgbd-bundle or rgb-video)");
          }
          fileName = sourceKind === "rgbd-bundle" ? "capture.zip" : "capture.mp4";
        } else {
          const media = dependencies.getMediaAsset(sourceMediaId);
          if (!media) throw new Error(`Gallery media "${sourceMediaId}" does not exist`);
          const blob = await dependencies.getMediaBlob(media.id);
          if (!blob) throw new Error(`Gallery media "${media.id}" has no usable bytes`);
          signal?.throwIfAborted();
          const file = new File([blob], media.fileName, { type: media.mimeType });
          sourceKind = sourceKind ?? detectCaptureSourceKind(file);
          fileName = media.fileName;
          const staged = await dependencies.stageSource(file, signal);
          sourceMediaId = staged.sourceMediaId;
        }
        const job = await dependencies.submitJob(
          {
            sourceMediaId,
            sourceKind,
            fileName,
            maxKeyViews: command.max_key_views,
            maxObjects: command.max_objects,
            gridResolution: 192,
            prompt: command.prompt,
          },
          command.idempotency_key ?? `reconstruction:${sourceMediaId.slice(-24)}`,
          signal,
        );
        return executionResult({ job: compactJob(job), accepted: true });
      }
      case "plan": {
        const plan = await dependencies.fetchPlan(command.job_id, signal);
        return executionResult({ summary: planSummary(plan), plan });
      }
      case "apply": {
        const plan = await dependencies.fetchPlan(command.job_id, signal);
        signal?.throwIfAborted();
        let shellAsset: { id: string; url: string; fileName: string; realWorldSizeM: number } | null = null;
        if (command.include_shell && plan.shell) {
          const blob = await dependencies.fetchArtifactBlob(command.job_id, plan.shell.artifactId, signal);
          const assetId = `capture-shell-${command.job_id}`;
          const uploaded = await dependencies.uploadModelAsset(blob, plan.shell.fileName, assetId);
          shellAsset = {
            id: assetId,
            url: uploaded.url,
            fileName: plan.shell.fileName,
            realWorldSizeM: Math.max(...plan.shell.sizeM),
          };
        }
        const existingObjectIds =
          command.mode === "replace"
            ? dependencies
                .getStore()
                .project.objects.filter((object) => object.kind !== "camera")
                .map((object) => object.id)
            : [];
        const batch = buildCaptureReconstructionAuthoringActions(plan, {
          mode: command.mode,
          includeCameras: command.include_cameras,
          shellAsset,
          existingObjectIds,
        });
        const operation = {
          op: "author" as const,
          actions: batch.actions,
          expected_revision: command.expected_revision,
          idempotency_key: command.idempotency_key,
        } satisfies DirectorWorkbenchOperation;
        const execution = dependencies.executeWorkbench(dependencies.getStore, operation, { scope: options.scope });
        if (!execution.success) return execution;
        const existing =
          execution.result && typeof execution.result === "object" && !Array.isArray(execution.result)
            ? (execution.result as Record<string, unknown>)
            : { value: execution.result ?? null };
        return {
          ...execution,
          result: {
            ...existing,
            reconstruction: {
              job_id: command.job_id,
              plan_id: plan.id,
              status: plan.analysis.status,
              object_ids: batch.objectIds,
              camera_ids: batch.cameraIds,
              shell_object_id: batch.shellObjectId,
              warnings: plan.analysis.warnings,
              next: "Use capture on camera_ids, then reconstruction.compare to score against the capture keyframes.",
            },
          },
        };
      }
      case "compare": {
        const plan = await dependencies.fetchPlan(command.job_id, signal);
        const camera = command.camera_id
          ? plan.cameras.find((candidate) => candidate.id === command.camera_id)
          : command.view_id
            ? plan.cameras.find((candidate) => candidate.viewId === command.view_id)
            : plan.cameras[0];
        if (!camera) {
          throw new Error("This reconstruction plan has no matching capture-view camera; confirm view_id / camera_id first.");
        }
        const project = dependencies.getStore().project;
        if (!project.cameras.some((candidate) => candidate.id === camera.id)) {
          throw new Error(
            `Capture-view camera ${camera.id} is not on the stage yet; run reconstruction.apply with include_cameras: true first`,
          );
        }
        const captureDataUrl = await dependencies.requestCapture(
          { cameraId: camera.id, frame: command.frame, width: camera.width, height: camera.height },
          signal,
        );
        if (!captureDataUrl) throw new Error("Stage capture failed: the browser canvas is unavailable");
        signal?.throwIfAborted();
        const keyframeBlob = await dependencies.fetchArtifactBlob(command.job_id, camera.keyframeArtifactId, signal);
        const [reference, candidate] = await Promise.all([
          dependencies.decodeImage(keyframeBlob),
          dependencies.decodeImage(captureDataUrl),
        ]);
        const { score, grid } = compareLuminanceImages(reference, candidate);
        return executionResult({
          compare: {
            viewId: camera.viewId,
            cameraId: camera.id,
            score,
            grid,
            capturedAt: dependencies.now(),
          },
          hint:
            score.composite >= 0.75
              ? "Match to the capture keyframe is strong."
              : "Match is weak: fix the regions in grid.worst first (large forms and layout, then materials, then lighting).",
        });
      }
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      result: {
        code: error instanceof DOMException && error.name === "AbortError" ? "cancelled" : "reconstruction_failed",
      },
    };
  }
}
