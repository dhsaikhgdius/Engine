import type { DirectorProject } from "@director/project-schema";
import { getDirectorProjectRevision } from "@director/project-schema";
import { useDirectorStore } from "../comprehensive/editor/store/directorStore";

/**
 * Error thrown when the director project revision changes during a revision-bound capture.
 *
 * A stale revision before capture means the caller's intent is based on outdated
 * project state. A change during capture means the in-flight renderer was aborted
 * because the project was edited mid-capture — no evidence from that capture is
 * accepted.
 */
export class DirectorProjectRevisionConflictError extends Error {
  /** Machine-readable error code for programmatic handling of revision conflicts. */
  readonly code = "stale_project_revision";

  /**
   * @param expectedRevision - The revision the caller expected to capture against.
   * @param actualRevision - The revision found in the project store at the time of detection.
   * @param phase - Whether the mismatch was detected before the capture started or during its execution.
   */
  constructor(
    /** The revision the caller expected to capture against. */
    readonly expectedRevision: string,
    /** The revision actually found in the project store at the time of detection. */
    readonly actualRevision: string,
    phase: "before" | "during",
  ) {
    super(
      phase === "before"
        ? `Stale project revision before capture: expected "${expectedRevision}", current "${actualRevision}".`
        : `Director project changed during capture: expected "${expectedRevision}", current "${actualRevision}". No evidence was accepted.`,
    );
    this.name = "DirectorProjectRevisionConflictError";
  }
}

/**
 * Runs an asynchronous capture against one immutable project revision. Any
 * semantic project edit aborts the in-flight renderer and rejects the whole
 * evidence set, preventing multi-pass packages from mixing scene versions.
 */
export async function runWithDirectorProjectRevision<T>(
  expectedRevision: string,
  capture: (context: { project: DirectorProject; signal: AbortSignal }) => Promise<T>,
  externalSignal?: AbortSignal,
): Promise<T> {
  const initialProject = useDirectorStore.getState().project;
  const initialRevision = getDirectorProjectRevision(initialProject);
  if (initialRevision !== expectedRevision) {
    throw new DirectorProjectRevisionConflictError(expectedRevision, initialRevision, "before");
  }

  const project = structuredClone(initialProject);
  const controller = new AbortController();
  const abortFromExternal = () => {
    if (!controller.signal.aborted) {
      const reason = externalSignal?.reason;
      controller.abort(
        reason instanceof DOMException && reason.name === "AbortError"
          ? reason
          : new DOMException("Director capture cancelled by the gateway", "AbortError"),
      );
    }
  };
  if (externalSignal?.aborted) abortFromExternal();
  else externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
  let changedRevision: string | null = null;
  const unsubscribe = useDirectorStore.subscribe((state) => {
    // UI-only store updates keep the immutable project reference; skip the
    // full normalize-and-hash pass unless the project object itself changed.
    if (state.project === initialProject || controller.signal.aborted) return;
    const currentRevision = getDirectorProjectRevision(state.project);
    if (currentRevision === expectedRevision) return;
    changedRevision = currentRevision;
    controller.abort(new DOMException("Director project changed during capture", "AbortError"));
  });

  try {
    const result = await capture({ project, signal: controller.signal });
    // In-flight edits abort the renderer. Evidence that already resolved is kept;
    // the caller reports live-scene drift as a stale outcome instead of discarding the frame.
    if (changedRevision) {
      throw new DirectorProjectRevisionConflictError(expectedRevision, changedRevision, "during");
    }
    return result;
  } catch (error) {
    if (changedRevision) {
      throw new DirectorProjectRevisionConflictError(expectedRevision, changedRevision, "during");
    }
    throw error;
  } finally {
    unsubscribe();
    externalSignal?.removeEventListener("abort", abortFromExternal);
  }
}
