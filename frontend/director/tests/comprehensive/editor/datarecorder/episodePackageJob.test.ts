import { describe, expect, it } from "vitest";
import { createDefaultDirectorProject } from "../../../../src/comprehensive/editor/store/directorStore";
import { prepareEpisodePackageJobInput } from "../../../../src/comprehensive/editor/datarecorder/episodePackageJob";
import type { SessionRecord } from "../../../../src/comprehensive/editor/datarecorder/sessionRecordTypes";

const HEX = "ab".repeat(32);

function fixtureRecord(): SessionRecord {
  return {
    sessionId: "director-session:package",
    projectId: "test-project",
    initialFingerprint: "initial",
    timebase: { frameRate: { numerator: 24, denominator: 1 } },
    records: [
      {
        kind: "semantic-operation",
        seq: 0,
        frame: 0,
        atMs: 0,
        operation: {
          op: "author",
          actions: [{ action: "add_object", id: "box_a", name: "Box", kind: "prop", geometry_type: "box" }],
        },
        preFingerprint: "pre",
        postFingerprint: "post",
      },
      {
        kind: "camera-pose",
        seq: 1,
        frame: 0,
        atMs: 0,
        cameraId: "cam_1",
        position: [0, 1.6, 4],
        rotation: [0, 0, 0, 1],
        fovDegrees: 50,
      },
    ],
    finalFingerprint: "final",
  };
}

describe("prepareEpisodePackageJobInput", () => {
  it("converts a session, composes captions, and yields a valid episode.package spec", () => {
    const prepared = prepareEpisodePackageJobInput({
      record: fixtureRecord(),
      project: createDefaultDirectorProject(),
      sourceVideoMediaId: `media-input:sha256:${HEX}`,
      sceneRevision: "rev-1",
      renderer: {
        backendId: "three-webgl",
        version: "test",
        resolution: { width: 1280, height: 720 },
        colorSpace: "srgb",
      },
      provenance: { codeVersion: "test", configHash: "sha256:episode-config" },
      seed: 3,
    });
    expect(prepared.kind).toBe("episode.package");
    expect(prepared.input.episodeId).toBe("director-session:package");
    expect(prepared.input.actionTrack.semanticEvents?.some((event) => event.type === "authoring.add_object")).toBe(
      true,
    );
    expect(prepared.input.actionTrack.cameraPose?.positions).toHaveLength(prepared.input.timebase.frameCount);
    expect(prepared.input.captions.sceneStatic?.generator.method).toBe("deterministic-composed");
    expect(prepared.input.sessionRecord).toMatchObject({ sessionId: "director-session:package" });
    expect(prepared.input.seed).toBe(3);
  });
});
