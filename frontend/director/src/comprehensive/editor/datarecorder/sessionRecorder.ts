/**
 * Headless session recorder: captures every typed workbench operation (the
 * shared UI/Agent boundary), active-camera pose changes, and playhead moves
 * into a frame-indexed SessionRecord that replays deterministically from the
 * initial snapshot.
 *
 * Interception is purely observational: a default-off listener on
 * executeDirectorWorkbenchOperation plus plain zustand subscriptions. No
 * existing behavior changes while a recorder is attached.
 */
import { Matrix4, Quaternion, Vector3 } from "three";
import { stableLexicalJson } from "@director/protocol/stable-json";
import {
  subscribeDirectorWorkbenchExecutions,
  type DirectorWorkbenchExecutionEvent,
} from "../../../agent/directorWorkbenchExecutor";
import type { DirectorWorkbenchOperation } from "@director/agent-engine";
import { getCameraViewSnapshotFromShot } from "../schema/cameraGeometry";
import { normalizeDirectorTimebase } from "../timeline/frameRate";
import { useDirectorStore, type DirectorStore } from "../store/directorStore";
import { useTimelineRuntimeStore } from "../runtime/timelineRuntimeStore";
import {
  captureDirectorWorkbenchSnapshot,
  computeDirectorSessionFingerprint,
  computeDirectorSessionFingerprintFromState,
  type DirectorWorkbenchStateSnapshot,
} from "./sessionFingerprint";
import type { SessionRecord, SessionRecordEntry, SessionTimebase } from "./sessionRecordTypes";

/**
 * Operations that can change the fingerprinted workbench document. Everything
 * else on the executor boundary is either a pure read (observe, inspect,
 * snapshot, catalog, audit, diff, trace, shot_ir, deliver, capabilities,
 * describe) or rejected by the core executor (browser-gateway-only surfaces),
 * so skipping those entries cannot break fingerprint continuity.
 */
const DOCUMENT_MUTATING_OPS = new Set<DirectorWorkbenchOperation["op"]>([
  "patch",
  "author",
  "run_macro",
  "correct",
  "replace_project",
  "undo",
  "select",
  "viewport",
  "playback",
]);

/** Options for starting a session recording, with injectable store hooks for testing. */
export interface DirectorSessionRecorderOptions {
  sessionId?: string;
  projectId?: string;
  /** Store hooks are injectable for isolated tests; defaults are the app singletons. */
  directorStore?: typeof useDirectorStore;
  timelineStore?: typeof useTimelineRuntimeStore;
}

export interface DirectorSessionRecorderHandle {
  readonly sessionId: string;
  /** Deep-cloned workbench document taken when recording started; feed it to replay. */
  readonly initialSnapshot: DirectorWorkbenchStateSnapshot;
  readonly initialFingerprint: string;
  isRecording(): boolean;
  /** Detaches all subscriptions and returns the finished record. Idempotent. */
  stop(): SessionRecord;
}

let sessionIdSequence = 0;

function generateSessionId(): string {
  const unique = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${(sessionIdSequence += 1)}`;
  return `director-session:${unique}`;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}

const WORLD_UP = new Vector3(0, 1, 0);

/**
 * Converts the camera's look-at pose into a unit quaternion with a canonical
 * non-negative w sign, so identical orientations always serialize identically.
 */
function lookAtQuaternion(
  position: readonly [number, number, number],
  target: readonly [number, number, number],
): [number, number, number, number] {
  const eye = new Vector3(...position);
  const focus = new Vector3(...target);
  if (eye.distanceToSquared(focus) < 1e-12) return [0, 0, 0, 1];
  const rotation = new Quaternion().setFromRotationMatrix(new Matrix4().lookAt(eye, focus, WORLD_UP)).normalize();
  return rotation.w < 0
    ? [-rotation.x, -rotation.y, -rotation.z, -rotation.w]
    : [rotation.x, rotation.y, rotation.z, rotation.w];
}

interface ActiveCameraPose {
  key: string;
  cameraId: string;
  fov: number;
  position: [number, number, number];
  target: [number, number, number];
}

function activeCameraPose(state: DirectorStore): ActiveCameraPose | null {
  const cameraId = state.project.activeCameraId;
  const camera = cameraId ? state.project.cameras.find((candidate) => candidate.id === cameraId) : undefined;
  if (!cameraId || !camera) return null;
  const view = getCameraViewSnapshotFromShot(camera);
  return {
    key: stableLexicalJson({ cameraId, fov: view.fov, position: view.position, target: view.target }),
    cameraId,
    fov: view.fov,
    position: [...view.position],
    target: [...camera.target],
  };
}

function sessionTimebase(state: DirectorStore): SessionTimebase {
  const timeline = state.project.scene.timeline;
  const rate = normalizeDirectorTimebase(timeline?.timebase, timeline?.fps ?? 24).rate;
  return { frameRate: { numerator: rate.numerator, denominator: rate.denominator } };
}

/** Non-document mutations that a fresh replay environment cannot reproduce. */
function environmentMutationDescription(operation: DirectorWorkbenchOperation): string | null {
  if (operation.op === "macro" && (operation.command.action === "save" || operation.command.action === "remove")) {
    return `macro ${operation.command.action} mutates the local automation library`;
  }
  if (operation.op === "memory" && (operation.command.action === "pin" || operation.command.action === "forget")) {
    return `memory ${operation.command.action} mutates the local automation library`;
  }
  return null;
}

/**
 * Starts recording a Director session. Every typed workbench operation, active-camera pose
 * change, and playhead move is captured into a frame-indexed SessionRecord.
 *
 * The recorder is purely observational: it subscribes to the workbench executor and
 * zustand stores without changing any existing behavior. Call `stop()` on the returned
 * handle to detach all subscriptions and receive the finished record.
 *
 * @param options - Optional session ID, project ID, and injectable store hooks.
 * @returns A handle with `stop()` and `isRecording()` methods.
 */
export function startDirectorSessionRecording(
  options: DirectorSessionRecorderOptions = {},
): DirectorSessionRecorderHandle {
  const directorStore = options.directorStore ?? useDirectorStore;
  const timelineStore = options.timelineStore ?? useTimelineRuntimeStore;
  const startState = directorStore.getState();

  const sessionId = options.sessionId ?? generateSessionId();
  const projectId = options.projectId ?? startState.project.nativeScene?.projectId ?? "local-stage";
  const initialSnapshot = deepFreeze(captureDirectorWorkbenchSnapshot(startState));
  const initialFingerprint = computeDirectorSessionFingerprint(initialSnapshot);
  const timebase = sessionTimebase(startState);
  const initialUndoDepth = startState.undoStack.length;

  const records: SessionRecordEntry[] = [];
  const warnings: string[] = [];
  let seq = 0;
  let lastFingerprint = initialFingerprint;
  let lastCameraPoseKey = activeCameraPose(startState)?.key ?? null;
  let lastPlayheadFrame = Math.round(timelineStore.getState().playheadFrame);
  let finished: SessionRecord | null = null;

  const warn = (message: string) => {
    if (!warnings.includes(message)) warnings.push(message);
  };

  const currentFrame = () => {
    const frame = Math.round(timelineStore.getState().playheadFrame);
    return Number.isSafeInteger(frame) ? frame : 0;
  };

  const push = (entry: SessionRecordEntry) => {
    records.push(deepFreeze(entry));
  };

  const noteDeterminismCaveats = (operation: DirectorWorkbenchOperation, entrySeq: number) => {
    if (operation.op === "run_macro") {
      warn(
        `seq ${entrySeq}: run_macro resolves "${operation.macro_id}" from the local automation library at execution time; replay requires the same library content.`,
      );
    }
    if (operation.op === "correct" && operation.audit_token) {
      warn(
        `seq ${entrySeq}: correct references volatile runtime audit token "${operation.audit_token}"; replay in a fresh runtime cannot resolve it.`,
      );
    }
    if (operation.op === "undo") {
      warn(
        `seq ${entrySeq}: undo replays deterministically only while it stays within mutations recorded in this session${
          initialUndoDepth > 0 ? ` (the session started with ${initialUndoDepth} pre-session undo entries)` : ""
        }.`,
      );
    }
    if (operation.op === "author" && operation.actions.some((action) => action.action === "add_world_effect")) {
      warn(
        "add_world_effect stamps a wall-clock createdAt into project state; session fingerprints exclude world.effects[*].createdAt, so replayed projects may differ in that diagnostic field.",
      );
    }
  };

  const onExecution = (event: DirectorWorkbenchExecutionEvent) => {
    if (finished) return;
    if (!DOCUMENT_MUTATING_OPS.has(event.operation.op)) {
      const environmentMutation = environmentMutationDescription(event.operation);
      if (environmentMutation) {
        warn(`skipped non-replayable operation while recording: ${environmentMutation}.`);
      }
      return;
    }
    const preFingerprint = computeDirectorSessionFingerprint(event.beforeDocument);
    if (preFingerprint !== lastFingerprint) {
      warn(
        `untracked state change before seq ${seq}: the workbench document was modified outside the typed operation path; replay will diverge here.`,
      );
    }
    const postFingerprint = computeDirectorSessionFingerprint(event.afterDocument);
    const entrySeq = seq;
    seq += 1;
    noteDeterminismCaveats(event.operation, entrySeq);
    push({
      kind: "semantic-operation",
      seq: entrySeq,
      frame: currentFrame(),
      atMs: Date.now(),
      operation: structuredClone(event.operation),
      preFingerprint,
      postFingerprint,
    });
    lastFingerprint = postFingerprint;
  };

  const onDirectorState = (state: DirectorStore) => {
    if (finished) return;
    const pose = activeCameraPose(state);
    if (!pose) {
      lastCameraPoseKey = null;
      return;
    }
    if (pose.key === lastCameraPoseKey) return;
    lastCameraPoseKey = pose.key;
    push({
      kind: "camera-pose",
      seq: seq++,
      frame: currentFrame(),
      atMs: Date.now(),
      cameraId: pose.cameraId,
      position: pose.position,
      rotation: lookAtQuaternion(pose.position, pose.target),
      fovDegrees: pose.fov,
    });
  };

  const onTimelineState = (state: { playheadFrame: number }) => {
    if (finished) return;
    const frame = Math.round(state.playheadFrame);
    if (!Number.isSafeInteger(frame) || frame === lastPlayheadFrame) return;
    lastPlayheadFrame = frame;
    push({ kind: "playhead", seq: seq++, frame, atMs: Date.now() });
  };

  const unsubscribeExecutions = subscribeDirectorWorkbenchExecutions(onExecution);
  const unsubscribeDirector = directorStore.subscribe(onDirectorState);
  const unsubscribeTimeline = timelineStore.subscribe(onTimelineState);

  return {
    sessionId,
    initialSnapshot,
    initialFingerprint,
    isRecording: () => finished === null,
    stop: () => {
      if (finished) return finished;
      unsubscribeExecutions();
      unsubscribeDirector();
      unsubscribeTimeline();
      const finalFingerprint = computeDirectorSessionFingerprintFromState(directorStore.getState());
      if (finalFingerprint !== lastFingerprint) {
        warn(
          "untracked state change after the last recorded operation: the final fingerprint no longer matches the last recorded post-operation fingerprint.",
        );
      }
      finished = deepFreeze({
        sessionId,
        projectId,
        initialFingerprint,
        timebase,
        records,
        finalFingerprint,
        ...(warnings.length ? { warnings } : {}),
      });
      return finished;
    },
  };
}
