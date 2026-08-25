import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  executeDirectorWorkbenchOperation,
  resetDirectorWorkbenchRuntimeForTests,
} from "../../../../src/agent/directorWorkbenchExecutor";
import type { DirectorWorkbenchOperation } from "@director/agent-engine";
import { getDirectorAgentCatalogAsset } from "@director/agent-engine/asset-catalog";
import {
  createDefaultDirectorProject,
  useDirectorStore,
} from "../../../../src/comprehensive/editor/store/directorStore";
import { useTimelineRuntimeStore } from "../../../../src/comprehensive/editor/runtime/timelineRuntimeStore";
import {
  captureDirectorWorkbenchSnapshot,
  computeDirectorSessionFingerprint,
} from "../../../../src/comprehensive/editor/datarecorder/sessionFingerprint";
import { startDirectorSessionRecording } from "../../../../src/comprehensive/editor/datarecorder/sessionRecorder";
import { replayDirectorSessionRecord } from "../../../../src/comprehensive/editor/datarecorder/sessionReplay";
import type {
  SessionCameraPoseEntry,
  SessionPlayheadEntry,
  SessionRecord,
  SessionSemanticOperationEntry,
} from "../../../../src/comprehensive/editor/datarecorder/sessionRecordTypes";

function runWorkbenchOperation(input: DirectorWorkbenchOperation) {
  return executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), input);
}

function semanticEntries(record: SessionRecord): SessionSemanticOperationEntry[] {
  return record.records.filter((entry): entry is SessionSemanticOperationEntry => entry.kind === "semantic-operation");
}

/**
 * Records the reference scripted session: three distinct semantic operation
 * kinds (author, select, viewport) plus an active-camera move and a playhead
 * move, exactly as the recorder sees them on the live executor boundary.
 */
function recordScriptedSession() {
  const recorder = startDirectorSessionRecording({
    sessionId: "director-session:test-episode",
    projectId: "test-project",
  });

  expect(
    runWorkbenchOperation({
      op: "author",
      actions: [
        { action: "upsert_asset", asset: getDirectorAgentCatalogAsset("flick:animals:cat.glb")!.asset },
        {
          action: "upsert_asset",
          asset: {
            id: "asset-recorder-box",
            kind: "prop",
            sourceType: "model",
            fileName: "recorder-box.glb",
            url: "https://assets.example.test/recorder-box.glb",
          },
        },
        {
          action: "add_object",
          id: "recorder_box",
          name: "Recorder Box",
          kind: "prop",
          asset_id: "flick:animals:cat.glb",
          transform: { position: [2, 0.5, -1], rotation: [0, 0, 0], scale: [1, 1, 1] },
        },
      ],
    }),
  ).toMatchObject({ success: true });
  expect(
    runWorkbenchOperation({
      op: "author",
      actions: [{ action: "update_camera", camera_id: "cam_1", patch: { position: [8, 5, 12], target: [0, 1, 0] } }],
    }),
  ).toMatchObject({ success: true });
  expect(runWorkbenchOperation({ op: "select", object_ids: ["recorder_box"] })).toMatchObject({ success: true });
  expect(runWorkbenchOperation({ op: "viewport", transform_mode: "rotate" })).toMatchObject({ success: true });

  useTimelineRuntimeStore.getState().setPlayheadFrame(42);

  const initialSnapshot = recorder.initialSnapshot;
  const record = recorder.stop();
  return { initialSnapshot, record };
}

describe("Director session recorder and deterministic replay", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      get length() {
        return values.size;
      },
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => Array.from(values.keys())[index] ?? null,
      removeItem: (key: string) => {
        values.delete(key);
      },
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    } satisfies Storage);
    resetDirectorWorkbenchRuntimeForTests();
    useTimelineRuntimeStore.getState().reset();
    useDirectorStore.getState().replaceProject(createDefaultDirectorProject());
  });

  it("records a scripted session into a frame-indexed SessionRecord", () => {
    const { record } = recordScriptedSession();

    expect(record.sessionId).toBe("director-session:test-episode");
    expect(record.projectId).toBe("test-project");
    expect(record.timebase).toEqual({ frameRate: { numerator: 24, denominator: 1 } });
    expect(record.warnings).toBeUndefined();

    const seqs = record.records.map((entry) => entry.seq);
    expect(seqs).toEqual([...seqs].sort((left, right) => left - right));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs[0]).toBe(0);

    const semantic = semanticEntries(record);
    expect(semantic.map((entry) => entry.operation.op)).toEqual(["author", "author", "select", "viewport"]);
    for (const entry of semantic) {
      expect(entry.preFingerprint).toMatch(/^director-session-fingerprint:v1:sha256:[0-9a-f]{64}$/);
      expect(entry.postFingerprint).toMatch(/^director-session-fingerprint:v1:sha256:[0-9a-f]{64}$/);
      expect(entry.postFingerprint).not.toBe(entry.preFingerprint);
      expect(Number.isSafeInteger(entry.frame)).toBe(true);
    }
    // Consecutive semantic entries chain: each pre matches the previous post.
    for (let index = 1; index < semantic.length; index += 1) {
      expect(semantic[index]!.preFingerprint).toBe(semantic[index - 1]!.postFingerprint);
    }
    expect(semantic[0]!.preFingerprint).toBe(record.initialFingerprint);
    expect(semantic.at(-1)!.postFingerprint).toBe(record.finalFingerprint);
    expect(record.finalFingerprint).not.toBe(record.initialFingerprint);

    const cameraPoses = record.records.filter((entry): entry is SessionCameraPoseEntry => entry.kind === "camera-pose");
    expect(cameraPoses).toHaveLength(1);
    expect(cameraPoses[0]).toMatchObject({ cameraId: "cam_1", fovDegrees: expect.any(Number) });
    // The rig/view round-trip is deterministic but not bit-exact to the input.
    expect(cameraPoses[0]!.position[0]).toBeCloseTo(8, 6);
    expect(cameraPoses[0]!.position[1]).toBeCloseTo(5, 6);
    expect(cameraPoses[0]!.position[2]).toBeCloseTo(12, 6);
    const [x, y, z, w] = cameraPoses[0]!.rotation;
    expect(Math.hypot(x, y, z, w)).toBeCloseTo(1, 10);
    expect(w).toBeGreaterThanOrEqual(0);

    const playheads = record.records.filter((entry): entry is SessionPlayheadEntry => entry.kind === "playhead");
    expect(playheads).toHaveLength(1);
    expect(playheads[0]!.frame).toBe(42);

    // The record is an immutable artifact.
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(semantic[0]!.operation)).toBe(true);
  });

  it("replays deterministically from the initial snapshot with matching fingerprints", () => {
    const { initialSnapshot, record } = recordScriptedSession();

    const result = replayDirectorSessionRecord(initialSnapshot, record, {
      getStore: () => useDirectorStore.getState(),
    });

    expect(result).toEqual({
      ok: true,
      verifiedOperationCount: 4,
      skippedEntryCount: 2,
      finalFingerprint: record.finalFingerprint,
    });
  });

  it("detects a tampered operation payload at the exact seq", () => {
    const { initialSnapshot, record } = recordScriptedSession();

    const tampered: SessionRecord = structuredClone(record);
    const target = semanticEntries(tampered).find((entry) => entry.operation.op === "author")!;
    const authorOperation = target.operation as Extract<DirectorWorkbenchOperation, { op: "author" }>;
    const addObject = authorOperation.actions[0] as Extract<
      (typeof authorOperation.actions)[number],
      { action: "add_object" }
    >;
    addObject.transform = { position: [9, 9, 9], rotation: [0, 0, 0], scale: [2, 2, 2] };

    const result = replayDirectorSessionRecord(initialSnapshot, tampered, {
      getStore: () => useDirectorStore.getState(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe("fingerprint-divergence");
    expect(result.divergence).toMatchObject({
      seq: target.seq,
      phase: "post",
      expected: target.postFingerprint,
    });
    expect(result.divergence!.actual).not.toBe(target.postFingerprint);
    expect(result.verifiedOperationCount).toBe(0);
  });

  it("records untyped store mutations as untracked-drift warnings and replay reports the pre divergence", () => {
    const recorder = startDirectorSessionRecording();
    // A raw store call bypasses the typed operation boundary on purpose.
    useDirectorStore.getState().selectObject("char_default_a");
    expect(runWorkbenchOperation({ op: "viewport", transform_mode: "scale" })).toMatchObject({ success: true });
    const record = recorder.stop();

    expect(record.warnings?.some((warning) => warning.includes("untracked state change before seq 0"))).toBe(true);

    const result = replayDirectorSessionRecord(recorder.initialSnapshot, record, {
      getStore: () => useDirectorStore.getState(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.divergence).toMatchObject({ seq: 0, phase: "pre" });
  });

  it("produces identical fingerprints for identical state regardless of object key order", () => {
    const snapshot = captureDirectorWorkbenchSnapshot(useDirectorStore.getState());
    const reordered = reverseKeysDeep(snapshot) as typeof snapshot;
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(snapshot));
    expect(computeDirectorSessionFingerprint(reordered)).toBe(computeDirectorSessionFingerprint(snapshot));

    const changed = structuredClone(snapshot);
    changed.project.scene.backgroundColor = "#123456";
    expect(computeDirectorSessionFingerprint(changed)).not.toBe(computeDirectorSessionFingerprint(snapshot));
  });
});

function reverseKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeysDeep);
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>).reverse()) {
      result[key] = reverseKeysDeep(entry);
    }
    return result;
  }
  return value;
}
