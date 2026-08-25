/**
 * Deterministic replay verification for SessionRecords.
 *
 * Replay seeds a Director store from the initial snapshot, then re-executes
 * every recorded semantic operation through executeDirectorWorkbenchOperation
 * (the exact path used while recording; no parallel apply logic) and compares
 * the workbench-state fingerprint against the recorded pre/post fingerprints
 * after each step. Camera-pose and playhead entries are observational data
 * and are skipped. Replay mutates the provided store; run it against an
 * expendable or freshly reset store, never a session a human is editing.
 */
import { executeDirectorWorkbenchOperation } from "../../../agent/directorWorkbenchExecutor";
import type { DirectorWorkbenchOperation } from "@director/agent-engine";
import type { DirectorUiState } from "@director/protocol/workbench-ui";
import { useDirectorStore, type DirectorStore } from "../store/directorStore";
import {
  computeDirectorSessionFingerprintFromState,
  type DirectorWorkbenchStateSnapshot,
} from "./sessionFingerprint";
import type { SessionRecord } from "./sessionRecordTypes";

export interface DirectorSessionReplayOptions {
  /** Store accessor to replay into; defaults to the app's Director store. */
  getStore?: () => DirectorStore;
  /**
   * Idempotency scope passed to the executor. Defaults to a unique
   * per-replay scope so recorded retry receipts can never short-circuit a
   * replayed mutation.
   */
  scope?: string;
}

export interface DirectorSessionReplayDivergence {
  /** seq of the offending entry; -1 when the seeded initial state already diverges. */
  seq: number;
  /** Which fingerprint comparison failed. */
  phase: "initial" | "pre" | "post" | "final";
  expected: string;
  actual: string;
}

export type DirectorSessionReplayResult =
  | {
      ok: true;
      verifiedOperationCount: number;
      skippedEntryCount: number;
      finalFingerprint: string;
    }
  | {
      ok: false;
      failure: "seed-rejected" | "malformed-record" | "fingerprint-divergence";
      verifiedOperationCount: number;
      divergence?: DirectorSessionReplayDivergence;
      error?: string;
    };

let replaySequence = 0;

/**
 * Mirrors the workbench UI slice onto the store through its public actions.
 * This is state seeding (restoring the snapshot the recording started from),
 * not operation application; recorded operations always replay through the
 * executor itself.
 */
function seedWorkbenchUiState(getStore: () => DirectorStore, ui: DirectorUiState) {
  const store = getStore();
  store.setViewMode(ui.viewMode);
  store.setTransformMode(ui.transformMode);
  store.setViewportAspectRatio(ui.viewportAspectRatio);
  store.setViewportLayout(ui.viewportLayout);
  store.setViewportRuleOfThirdsEnabled(ui.viewportRuleOfThirdsEnabled);
  store.setViewportPanelsCollapsed(ui.viewportPanelsCollapsed);
  store.setViewportRotateSensitivity(ui.viewportRotateSensitivity);
  store.setViewportZoomSensitivity(ui.viewportZoomSensitivity);
  store.setViewportMoveSpeed(ui.viewportMoveSpeed);
  store.setViewportCharacterMoveSpeed(ui.viewportCharacterMoveSpeed);
  store.setViewportPilotInertia(ui.viewportPilotInertia);
  store.setViewportPilotLookSmoothing(ui.viewportPilotLookSmoothing);
  store.setViewportPilotBankStrength(ui.viewportPilotBankStrength);
  if (ui.directorInspectorMode === "scene") {
    getStore().openSceneInspector();
    return;
  }
  if (ui.selectedCrowdId) {
    getStore().selectCrowd(ui.selectedCrowdId);
    return;
  }
  const current = getStore();
  const validIds = ui.selectedObjectIds.filter((id) => current.project.objects.some((object) => object.id === id));
  current.selectObject(validIds[0] ?? null);
  for (const id of validIds.slice(1)) getStore().toggleObjectSelection(id);
}

/**
 * Replays a SessionRecord against a Director store, seeding from the initial snapshot
 * and re-executing every recorded semantic operation through the exact same executor path.
 * Camera-pose and playhead entries are skipped. Each step's pre/post fingerprint is
 * verified against the recorded values; any divergence is reported immediately.
 *
 * The replay mutates the provided store — run it against an expendable or freshly reset
 * store, never a session a human is editing.
 *
 * @param initialSnapshot - The deep-cloned workbench snapshot from when recording started.
 * @param record - The session record to replay.
 * @param options - Optional store accessor and idempotency scope.
 * @returns A replay result indicating success or the point of divergence.
 */
export function replayDirectorSessionRecord(
  initialSnapshot: DirectorWorkbenchStateSnapshot,
  record: SessionRecord,
  options: DirectorSessionReplayOptions = {},
): DirectorSessionReplayResult {
  const getStore = options.getStore ?? (() => useDirectorStore.getState());
  const scope = options.scope ?? `datarecorder-replay:${record.sessionId}:${(replaySequence += 1)}`;

  try {
    getStore().replaceProject(structuredClone(initialSnapshot.project));
    seedWorkbenchUiState(getStore, initialSnapshot.ui);
  } catch (error) {
    return {
      ok: false,
      failure: "seed-rejected",
      verifiedOperationCount: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const diverged = (
    seq: number,
    phase: DirectorSessionReplayDivergence["phase"],
    expected: string,
    actual: string,
    verifiedOperationCount: number,
  ): DirectorSessionReplayResult => ({
    ok: false,
    failure: "fingerprint-divergence",
    verifiedOperationCount,
    divergence: { seq, phase, expected, actual },
  });

  let actual = computeDirectorSessionFingerprintFromState(getStore());
  if (actual !== record.initialFingerprint) {
    return diverged(-1, "initial", record.initialFingerprint, actual, 0);
  }

  let verifiedOperationCount = 0;
  let skippedEntryCount = 0;
  let lastSeq = -1;
  for (const entry of record.records) {
    if (!Number.isSafeInteger(entry.seq) || entry.seq <= lastSeq) {
      return {
        ok: false,
        failure: "malformed-record",
        verifiedOperationCount,
        error: `records must carry strictly increasing integer seq values; entry seq ${entry.seq} follows ${lastSeq}.`,
      };
    }
    lastSeq = entry.seq;
    if (entry.kind !== "semantic-operation") {
      skippedEntryCount += 1;
      continue;
    }
    actual = computeDirectorSessionFingerprintFromState(getStore());
    if (actual !== entry.preFingerprint) {
      return diverged(entry.seq, "pre", entry.preFingerprint, actual, verifiedOperationCount);
    }
    // Recorded entries are frozen; the executor receives its own mutable clone.
    const operation: DirectorWorkbenchOperation = structuredClone(entry.operation);
    executeDirectorWorkbenchOperation(getStore, operation, { scope });
    actual = computeDirectorSessionFingerprintFromState(getStore());
    if (actual !== entry.postFingerprint) {
      return diverged(entry.seq, "post", entry.postFingerprint, actual, verifiedOperationCount);
    }
    verifiedOperationCount += 1;
  }

  actual = computeDirectorSessionFingerprintFromState(getStore());
  if (actual !== record.finalFingerprint) {
    return diverged(lastSeq, "final", record.finalFingerprint, actual, verifiedOperationCount);
  }
  return { ok: true, verifiedOperationCount, skippedEntryCount, finalFingerprint: actual };
}
