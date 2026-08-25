/**
 * Local mirror of the episode protocol; to be replaced by the
 * packages/protocol episode module once that contract lands.
 *
 * A SessionRecord is a frame-indexed action log for one editing session: it
 * pairs an initial workbench-state fingerprint with an ordered stream of
 * typed entries and a final fingerprint, so the session can be replayed
 * deterministically from the initial snapshot and verified entry by entry.
 */
import type { DirectorWorkbenchOperation } from "@director/agent-engine";

/** Rational timebase of the session's timeline (for example 24/1 or 30000/1001). */
export interface SessionTimebase {
  frameRate: {
    numerator: number;
    denominator: number;
  };
}

interface SessionRecordEntryBase {
  /** Monotonically increasing integer across all entry kinds of one session. */
  seq: number;
  /** Integer timeline frame index (transient playhead) at record time. */
  frame: number;
  /** Optional wall-clock milliseconds, carried for diagnostics only. */
  atMs?: number;
}

/**
 * One typed workbench operation exactly as it executed, together with the
 * workbench-state fingerprints observed immediately before and after it.
 */
export interface SessionSemanticOperationEntry extends SessionRecordEntryBase {
  kind: "semantic-operation";
  /** Verbatim parsed operation payload, deep-cloned and frozen at record time. */
  operation: DirectorWorkbenchOperation;
  preFingerprint: string;
  postFingerprint: string;
}

/** Active-camera pose sample, recorded when the pose changes (not per frame). */
export interface SessionCameraPoseEntry extends SessionRecordEntryBase {
  kind: "camera-pose";
  cameraId?: string;
  position: [number, number, number];
  /** Unit quaternion [x, y, z, w] with a canonical non-negative w sign. */
  rotation: [number, number, number, number];
  fovDegrees?: number;
}

/** Playhead move; the shared `frame` field carries the new playhead frame. */
export interface SessionPlayheadEntry extends SessionRecordEntryBase {
  kind: "playhead";
}

// rawControl (keyboard/pointer) entries are a reserved future layer of the
// episode protocol, for example:
//   interface SessionRawControlEntry extends SessionRecordEntryBase {
//     kind: "raw-control";
//     device: "keyboard" | "pointer";
//     ...
//   }
// This version records only typed semantic operations, camera poses, and
// playhead moves.

export type SessionRecordEntry = SessionSemanticOperationEntry | SessionCameraPoseEntry | SessionPlayheadEntry;

export interface SessionRecord {
  sessionId: string;
  projectId: string;
  /** Workbench-state fingerprint at the moment recording started. */
  initialFingerprint: string;
  timebase: SessionTimebase;
  records: SessionRecordEntry[];
  /** Workbench-state fingerprint at the moment recording stopped. */
  finalFingerprint: string;
  /** Determinism and coverage caveats collected while recording. */
  warnings?: string[];
}
