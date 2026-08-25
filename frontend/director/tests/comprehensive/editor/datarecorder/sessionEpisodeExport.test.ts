import { describe, expect, it } from "vitest";
import { stableLexicalJson } from "@director/protocol/stable-json";
import {
  EPISODE_MANIFEST_CONTRACT,
  type EpisodeSemanticEvent,
} from "@director/protocol/episode";
import type { DirectorWorkbenchOperation } from "@director/agent-engine";
import type { SessionRecord, SessionRecordEntry } from "../../../../src/comprehensive/editor/datarecorder/sessionRecordTypes";
import {
  SessionEpisodeExportError,
  buildEpisodeManifest,
  convertSessionRecordToActionTrack,
  validateConvertedEpisode,
} from "../../../../src/comprehensive/editor/datarecorder/sessionEpisodeExport";

const HEX = "ab".repeat(32);

function authorAddObject(id: string): DirectorWorkbenchOperation {
  return {
    op: "author",
    actions: [
      {
        action: "add_object",
        id,
        name: id,
        kind: "prop",
        geometry_type: "box",
        parent_id: "stage-root",
      },
    ],
  };
}

function fixtureRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  const records: SessionRecordEntry[] = [
    {
      kind: "camera-pose",
      seq: 0,
      frame: 2,
      atMs: 1_000,
      cameraId: "cam_1",
      position: [0, 1.6, 4],
      rotation: [0, 0, 0, 1],
      fovDegrees: 50,
    },
    {
      kind: "semantic-operation",
      seq: 1,
      frame: 2,
      atMs: 1_000,
      operation: authorAddObject("box_a"),
      preFingerprint: "pre-a",
      postFingerprint: "post-a",
    },
    {
      kind: "camera-pose",
      seq: 2,
      frame: 5,
      atMs: 2_000,
      cameraId: "cam_1",
      position: [3, 2, 1],
      rotation: [0, 0, 1, 0],
      fovDegrees: 50,
    },
    {
      kind: "playhead",
      seq: 3,
      frame: 8,
      atMs: 3_000,
    },
    {
      kind: "semantic-operation",
      seq: 4,
      frame: 1,
      atMs: 3_500,
      operation: { op: "select", object_ids: ["box_a"] },
      preFingerprint: "pre-b",
      postFingerprint: "post-b",
    },
  ];
  return {
    sessionId: "director-session:fixture",
    projectId: "test-project",
    initialFingerprint: "initial",
    timebase: { frameRate: { numerator: 24, denominator: 1 } },
    records,
    finalFingerprint: "final",
    ...overrides,
  };
}

function eventTypes(events: readonly EpisodeSemanticEvent[] | undefined): string[] {
  return (events ?? []).map((event) => `${event.frame}:${event.type}`);
}

describe("sessionEpisodeExport", () => {
  it("holds camera poses with zero-order hold and back-fills frames before the first sample", () => {
    const { actionTrack, frameCount, warnings } = convertSessionRecordToActionTrack(fixtureRecord());
    expect(frameCount).toBe(9);
    const pose = actionTrack.cameraPose;
    expect(pose).toBeDefined();
    expect(pose!.positions).toHaveLength(9);
    expect(pose!.rotations).toHaveLength(9);
    // Frames 0-4 (before and including the first sample at frame 2, until frame 5) hold [0, 1.6, 4].
    for (const frame of [0, 1, 2, 3, 4]) {
      expect(pose!.positions[frame]).toEqual([0, 1.6, 4]);
      expect(pose!.rotations[frame]).toEqual([0, 0, 0, 1]);
    }
    // Frame 5 onward holds the second sample — not an interpolated midpoint.
    for (const frame of [5, 6, 7, 8]) {
      expect(pose!.positions[frame]).toEqual([3, 2, 1]);
      expect(pose!.rotations[frame]).toEqual([0, 0, 1, 0]);
    }
    const midpoint = pose!.positions[3];
    expect(midpoint).not.toEqual([1.5, 1.8, 2.5]);
    expect(warnings.some((warning) => warning.includes("back-filled frames [0, 2)"))).toBe(true);
  });

  it("maps timeline-playhead and session-elapsed onto different frame indices", () => {
    const record = fixtureRecord();
    const timeline = convertSessionRecordToActionTrack(record, { timeMapping: "timeline-playhead" });
    const elapsed = convertSessionRecordToActionTrack(record, { timeMapping: "session-elapsed" });

    expect(timeline.frameCount).toBe(9);
    expect(eventTypes(timeline.actionTrack.semanticEvents)).toEqual([
      "1:workbench.select",
      "2:workbench.author",
      "2:authoring.add_object",
      "8:timeline.playhead",
    ]);

    // origin atMs = 1000; 24 fps → Δ1s = 24 frames, Δ2s = 48, Δ2.5s = 60.
    expect(elapsed.frameCount).toBe(61);
    expect(eventTypes(elapsed.actionTrack.semanticEvents)).toEqual([
      "0:workbench.author",
      "0:authoring.add_object",
      "48:timeline.playhead",
      "60:workbench.select",
    ]);
    expect(elapsed.actionTrack.cameraPose!.positions[0]).toEqual([0, 1.6, 4]);
    expect(elapsed.actionTrack.cameraPose!.positions[24]).toEqual([3, 2, 1]);
  });

  it("emits dense arrays matching frameCount and passes integrity validation", () => {
    const converted = convertSessionRecordToActionTrack(fixtureRecord());
    const manifest = buildEpisodeManifest({
      id: "episode-fixture",
      projectId: "test-project",
      sceneRevision: "director-project-revision:v1:test",
      seed: 7,
      timebase: converted.timebase,
      renderer: {
        backendId: "three-webgl",
        version: "0.184.0",
        resolution: { width: 1280, height: 720 },
        colorSpace: "srgb",
      },
      provenance: {
        codeVersion: "test",
        configHash: "sha256:config-hash-fixture",
        assets: [{ assetId: "asset:box", sha256: HEX, license: "CC0-1.0" }],
      },
      artifacts: [{ path: "video/rgb.mp4", kind: "video", sha256: HEX, bytes: 128 }],
    });
    expect(manifest.contract).toBe(EPISODE_MANIFEST_CONTRACT);
    expect(converted.actionTrack.cameraPose!.positions).toHaveLength(converted.frameCount);
    expect(converted.actionTrack.cameraPose!.rotations).toHaveLength(converted.frameCount);
    expect(validateConvertedEpisode(manifest, converted.actionTrack)).toEqual([]);
  });

  it("sorts events by frame ascending and keeps same-frame seq order", () => {
    const { actionTrack } = convertSessionRecordToActionTrack(fixtureRecord());
    const events = actionTrack.semanticEvents ?? [];
    for (let index = 1; index < events.length; index += 1) {
      expect(events[index].frame).toBeGreaterThanOrEqual(events[index - 1].frame);
    }
    const frameTwo = events.filter((event) => event.frame === 2);
    expect(frameTwo.map((event) => event.type)).toEqual(["workbench.author", "authoring.add_object"]);
    expect(frameTwo[1].subjectId).toBe("box_a");
    expect(frameTwo[1].objectId).toBe("stage-root");
  });

  it("is a deterministic pure conversion", () => {
    const record = fixtureRecord();
    const first = convertSessionRecordToActionTrack(record);
    const second = convertSessionRecordToActionTrack(record);
    expect(stableLexicalJson(first.actionTrack)).toBe(stableLexicalJson(second.actionTrack));
    expect(first.warnings).toEqual(second.warnings);
    expect(first.frameCount).toBe(second.frameCount);
  });

  it("omits cameraPose when the session recorded no poses", () => {
    const record = fixtureRecord({
      records: [
        {
          kind: "semantic-operation",
          seq: 0,
          frame: 0,
          atMs: 0,
          operation: { op: "select", object_ids: ["box_a"] },
          preFingerprint: "pre",
          postFingerprint: "post",
        },
      ],
    });
    const { actionTrack } = convertSessionRecordToActionTrack(record);
    expect(actionTrack.cameraPose).toBeUndefined();
    expect(actionTrack.semanticEvents).toHaveLength(1);
  });

  it("rejects an explicit frameCount smaller than the derived length", () => {
    expect(() => convertSessionRecordToActionTrack(fixtureRecord(), { frameCount: 3 })).toThrow(
      SessionEpisodeExportError,
    );
    try {
      convertSessionRecordToActionTrack(fixtureRecord(), { frameCount: 3 });
    } catch (error) {
      expect(error).toMatchObject({ code: "frame-count-too-small" });
    }
  });

  it("rejects session-elapsed mapping when atMs is missing", () => {
    const record = fixtureRecord({
      records: [
        {
          kind: "playhead",
          seq: 0,
          frame: 0,
        },
      ],
    });
    expect(() => convertSessionRecordToActionTrack(record, { timeMapping: "session-elapsed" })).toThrow(
      SessionEpisodeExportError,
    );
  });
});
