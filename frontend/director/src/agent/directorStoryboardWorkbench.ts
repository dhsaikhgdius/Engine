import { requestViewportCapture } from "../comprehensive/editor/io/captureBridge";
import {
  captureDirectorStoryboardThumbnail,
  type DirectorStoryboardThumbnail,
} from "../comprehensive/editor/storyboard/storyboardCapture";
import {
  createDirectorStoryboardPdf,
  downloadDirectorStoryboardPdf,
  downloadDirectorStoryboardVerificationPackage,
  type DirectorStoryboardPdfResult,
} from "../comprehensive/editor/storyboard/storyboardPdf";
import { createEmptyDirectorStoryboard } from "../comprehensive/editor/storyboard/directorStoryboard";
import { getDirectorProjectRevision } from "@director/project-schema";
import { useDirectorStore, type DirectorStore } from "../comprehensive/editor/store/directorStore";
import type {
  DirectorStoryboardArtifactCommand,
  DirectorWorkbenchExecutableOperation,
} from "@director/agent-engine/contract";
import {
  executeDirectorWorkbenchOperation,
  type DirectorWorkbenchExecution,
  type DirectorWorkbenchExecutionOptions,
} from "./directorWorkbenchExecutor";
import { DirectorProjectRevisionConflictError, runWithDirectorProjectRevision } from "./directorRevisionBoundCapture";
import { stableJson } from "@director/protocol/stableJson";

type RevisionRunner = typeof runWithDirectorProjectRevision;
type StoryboardThumbnailCapture = typeof captureDirectorStoryboardThumbnail;

type StoryboardRetryReceipt = {
  signature: string;
  projectRevisionAfter: string;
  execution: DirectorWorkbenchExecution;
};

/**
 * Maximum number of idempotency receipts to keep in memory before evicting
 * the oldest entry (FIFO). Each receipt records a successful storyboard
 * operation so a retry with the same key can replay the cached result.
 */
const STORYBOARD_RECEIPT_LIMIT = 128;

/**
 * In-memory LRU cache of idempotency receipts keyed by scoped request key.
 * Entries are evicted FIFO when the map exceeds {@link STORYBOARD_RECEIPT_LIMIT}.
 */
const storyboardRetryReceipts = new Map<string, StoryboardRetryReceipt>();

/**
 * Clear the in-memory idempotency receipt cache. Exposed so tests can reset
 * the runtime between test cases without restarting the process.
 */
export function resetDirectorStoryboardWorkbenchRuntimeForTests() {
  storyboardRetryReceipts.clear();
}

function storyboardRetryKey(scope: string | undefined, key: string) {
  return `${scope?.trim() || "local-stage"}\u0000${key}`;
}

function storyboardIntentSignature(command: DirectorStoryboardArtifactCommand) {
  const { expected_revision: _expectedRevision, idempotency_key: _idempotencyKey, ...intent } = command;
  return stableJson(intent);
}

function resultRecord(result: unknown) {
  return result && typeof result === "object" && !Array.isArray(result) ? (result as Record<string, unknown>) : {};
}

/**
 * Dependency injection surface for the storyboard workbench. Each method
 * isolates a side effect (store access, thumbnail capture, PDF generation,
 * download) so the executor can be tested with stubs.
 */
export interface DirectorStoryboardWorkbenchDependencies {
  /** Return the current Director Zustand store snapshot. */
  getStore?: () => DirectorStore;
  /** Run a callback under a bounded project revision. */
  runWithRevision?: RevisionRunner;
  /** Capture a thumbnail for a single storyboard shot. */
  captureThumbnail?: StoryboardThumbnailCapture;
  /** Generate a storyboard PDF artifact. */
  createPdf?: typeof createDirectorStoryboardPdf;
  /** Trigger a browser download of the PDF artifact. */
  downloadPdf?: typeof downloadDirectorStoryboardPdf;
  /** Trigger a browser download of the verification package. */
  downloadPackage?: typeof downloadDirectorStoryboardVerificationPackage;
  /** Execute a generic workbench operation (used to persist captured thumbnails). */
  executeWorkbench?: (
    getStore: () => DirectorStore,
    operation: DirectorWorkbenchExecutableOperation,
    options?: DirectorWorkbenchExecutionOptions,
  ) => DirectorWorkbenchExecution;
}

function defaultDependencies(): Required<DirectorStoryboardWorkbenchDependencies> {
  return {
    getStore: () => useDirectorStore.getState(),
    runWithRevision: runWithDirectorProjectRevision,
    captureThumbnail: (project, shot, signal) =>
      captureDirectorStoryboardThumbnail(project, shot, signal, {
        capture: (request) => requestViewportCapture({ ...request, signal, waitForHandlerMs: 2_000 }),
      }),
    createPdf: createDirectorStoryboardPdf,
    downloadPdf: downloadDirectorStoryboardPdf,
    downloadPackage: downloadDirectorStoryboardVerificationPackage,
    executeWorkbench: executeDirectorWorkbenchOperation,
  };
}

function mergeResult(execution: DirectorWorkbenchExecution, storyboardArtifact: Record<string, unknown>) {
  const existing =
    execution.result && typeof execution.result === "object" && !Array.isArray(execution.result)
      ? (execution.result as Record<string, unknown>)
      : { value: execution.result ?? null };
  return { ...execution, result: { ...existing, storyboard_artifact: storyboardArtifact } };
}

function captureTargets(command: DirectorStoryboardArtifactCommand, shotIds: string[]) {
  if (command.action === "capture_thumbnail") return [command.shot_id];
  return shotIds;
}

async function captureStoryboardThumbnails(
  command: Extract<DirectorStoryboardArtifactCommand, { action: "capture_thumbnail" | "capture_missing" }>,
  signal: AbortSignal | undefined,
  scope: string | undefined,
  dependencies: Required<DirectorStoryboardWorkbenchDependencies>,
) {
  const revision = command.expected_revision ?? getDirectorProjectRevision(dependencies.getStore().project);
  const captured = await dependencies.runWithRevision(
    revision,
    async ({ project, signal: revisionSignal }) => {
      const storyboard = project.storyboard ?? createEmptyDirectorStoryboard();
      if (!storyboard.shots.length) throw new Error("Storyboard has no shots to capture");
      const candidateIds =
        command.action === "capture_missing"
          ? // Only capture shots whose thumbnail is missing, orphaned (wrong camera),
            // or stale (frame has changed).
            storyboard.shots
              .filter(
                (shot) =>
                  !shot.thumbnail ||
                  shot.thumbnail.cameraId !== shot.cameraId ||
                  shot.thumbnail.frame !== shot.frameStart,
              )
              .map((shot) => shot.id)
          : storyboard.shots.map((shot) => shot.id);
      const targetIds = captureTargets(command, candidateIds);
      const availableIds = new Set(storyboard.shots.map((shot) => shot.id));
      targetIds.forEach((id) => {
        if (!availableIds.has(id)) throw new Error(`Storyboard shot "${id}" does not exist`);
      });
      const thumbnails = new Map<string, DirectorStoryboardThumbnail>();
      for (const id of targetIds) {
        revisionSignal.throwIfAborted();
        const shot = storyboard.shots.find((candidate) => candidate.id === id)!;
        thumbnails.set(id, await dependencies.captureThumbnail(project, shot, revisionSignal));
      }
      return {
        storyboard: {
          ...storyboard,
          shots: storyboard.shots.map((shot) =>
            thumbnails.has(shot.id) ? { ...shot, thumbnail: thumbnails.get(shot.id)! } : shot,
          ),
        },
        thumbnails,
      };
    },
    signal,
  );

  if (!captured.thumbnails.size) {
    // All targeted thumbnails are already current; skip the persist step.
    return {
      success: true,
      result: {
        storyboard_artifact: {
          action: command.action,
          captured: 0,
          skipped: true,
          reason: "all_storyboard_thumbnails_current",
          project_revision: revision,
        },
      },
    } satisfies DirectorWorkbenchExecution;
  }

  const operation = {
    op: "author" as const,
    actions: [{ action: "set_storyboard" as const, storyboard: captured.storyboard }],
    expected_revision: revision,
    idempotency_key: command.idempotency_key,
  } satisfies DirectorWorkbenchExecutableOperation;
  const execution = dependencies.executeWorkbench(dependencies.getStore, operation, { scope });
  return mergeResult(execution, {
    action: command.action,
    captured: captured.thumbnails.size,
    shot_ids: [...captured.thumbnails.keys()],
    thumbnails: Object.fromEntries(captured.thumbnails),
  });
}

async function exportStoryboardPdf(
  command: Extract<DirectorStoryboardArtifactCommand, { action: "export_pdf" }>,
  signal: AbortSignal | undefined,
  dependencies: Required<DirectorStoryboardWorkbenchDependencies>,
) {
  const revision = command.expected_revision ?? getDirectorProjectRevision(dependencies.getStore().project);
  const result: DirectorStoryboardPdfResult = await dependencies.runWithRevision(
    revision,
    ({ project, signal: revisionSignal }) =>
      dependencies.createPdf(
        project,
        {
          paperSize: command.paper_size,
          orientation: command.orientation,
          columns: command.columns,
          scope: command.scope,
          selectedShotIds: command.shot_ids,
          includeMetadata: command.include_metadata,
          includeAction: command.include_action,
        },
        { signal: revisionSignal },
      ),
    signal,
  );
  if (command.download) {
    if (command.artifact === "pdf") dependencies.downloadPdf(result);
    else await dependencies.downloadPackage(result);
  }
  return {
    success: true,
    result: {
      storyboard_artifact: {
        action: command.action,
        artifact: command.artifact,
        downloaded: command.download,
        manifest: result.manifest,
      },
    },
  } satisfies DirectorWorkbenchExecution;
}

/**
 * Execute a storyboard artifact command: capture thumbnails, capture missing
 * thumbnails, or export a PDF. Idempotency is enforced via the command's
 * {@link DirectorStoryboardArtifactCommand.idempotency_key}: a repeated call
 * with the same key and intent replays the cached result instead of
 * re-executing.
 *
 * @param command - The storyboard artifact command to execute.
 * @param signal - An optional abort signal to cancel the operation.
 * @param options - Optional scope for isolating receipt keys and optional
 *   dependency overrides for testing.
 * @returns The execution result, decorated with idempotency and revision
 *   metadata.
 */
export async function executeDirectorStoryboardWorkbenchCommand(
  command: DirectorStoryboardArtifactCommand,
  signal?: AbortSignal,
  options: { scope?: string; dependencies?: DirectorStoryboardWorkbenchDependencies } = {},
): Promise<DirectorWorkbenchExecution> {
  const dependencies = { ...defaultDependencies(), ...options.dependencies };
  const projectRevisionBefore = getDirectorProjectRevision(dependencies.getStore().project);
  if (!command.expected_revision || !command.idempotency_key) {
    return {
      success: false,
      error: "Storyboard Agent execution requires an exact project revision and idempotency key.",
      result: { code: "missing_agent_boundary", project_revision: projectRevisionBefore },
    };
  }
  const receiptKey = storyboardRetryKey(options.scope, command.idempotency_key);
  const signature = storyboardIntentSignature(command);
  const prior = storyboardRetryReceipts.get(receiptKey);
  if (prior) {
    // The same idempotency key with a different intent payload is a hard conflict.
    if (prior.signature !== signature) {
      return {
        success: false,
        error: `Request key "${command.idempotency_key}" was already used for a different storyboard intent.`,
        result: { code: "idempotency_key_conflict", idempotency_key: command.idempotency_key },
      };
    }
    const replayStale = prior.projectRevisionAfter !== projectRevisionBefore;
    // Replay the cached result; flag when the project has moved on since the original execution.
    return {
      ...structuredClone(prior.execution),
      result: {
        ...resultRecord(structuredClone(prior.execution.result)),
        idempotency_key: command.idempotency_key,
        idempotency_replayed: true,
        ...(replayStale
          ? {
              replay_stale: true,
              original_project_revision: prior.projectRevisionAfter,
              current_project_revision: projectRevisionBefore,
              message:
                "This storyboard request already succeeded and was not re-executed; the project has changed since that result.",
            }
          : {}),
      },
    };
  }
  try {
    signal?.throwIfAborted();
    const execution =
      command.action === "export_pdf"
        ? await exportStoryboardPdf(command, signal, dependencies)
        : await captureStoryboardThumbnails(command, signal, options.scope, dependencies);
    const projectRevisionAfter = getDirectorProjectRevision(dependencies.getStore().project);
    const decorated = {
      ...execution,
      result: {
        ...resultRecord(execution.result),
        idempotency_key: command.idempotency_key,
        idempotency_replayed: false,
        project_revision_before: projectRevisionBefore,
        project_revision: projectRevisionAfter,
      },
    } satisfies DirectorWorkbenchExecution;
    if (decorated.success) {
      storyboardRetryReceipts.set(receiptKey, { signature, projectRevisionAfter, execution: structuredClone(decorated) });
      // Evict the oldest receipt (FIFO) when the cache exceeds the limit.
      if (storyboardRetryReceipts.size > STORYBOARD_RECEIPT_LIMIT) {
        storyboardRetryReceipts.delete(storyboardRetryReceipts.keys().next().value!);
      }
    }
    return decorated;
  } catch (error) {
    const code =
      error instanceof DirectorProjectRevisionConflictError
        ? error.code
        : error instanceof DOMException && error.name === "AbortError"
          ? "cancelled"
          : "storyboard_artifact_failed";
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      result: { code },
    };
  }
}
