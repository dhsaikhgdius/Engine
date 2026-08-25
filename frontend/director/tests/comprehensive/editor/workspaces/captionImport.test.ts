import { beforeEach, describe, expect, it } from "vitest";
import {
  insertDirectorCaptionCuesIntoTimeline,
  parseDirectorCaptionFile,
} from "../../../../src/comprehensive/editor/workspaces/captionImport";
import { useDirectorCreativeWorkspaceStore } from "../../../../src/comprehensive/editor/workspaces/directorWorkspaceStore";

beforeEach(() => useDirectorCreativeWorkspaceStore.getState().resetCreativeWorkspaces());

describe("parseDirectorCaptionFile", () => {
  it("parses SRT cues and strips markup", () => {
    expect(
      parseDirectorCaptionFile(
        `1\n00:00:01,250 --> 00:00:03,500\n<b>第一句</b>\n\n2\n00:00:04,000 --> 00:00:05,000\nSecond line`,
      ),
    ).toEqual([
      { startSec: 1.25, endSec: 3.5, text: "第一句" },
      { startSec: 4, endSec: 5, text: "Second line" },
    ]);
  });

  it("parses WebVTT settings and ignores invalid cues", () => {
    expect(
      parseDirectorCaptionFile(`WEBVTT\n\n00:01.000 --> 00:02.250 align:center\nHello\nworld\n\nbad --> nope\nIgnored`),
    ).toEqual([{ startSec: 1, endSec: 2.25, text: "Hello\nworld" }]);
  });

  it("inserts transcription captions atomically and deduplicates the same job", () => {
    const cues = [
      { startSec: 0, endSec: 1, text: "First" },
      { startSec: 1, endSec: 2, text: "Second" },
    ];
    const first = insertDirectorCaptionCuesIntoTimeline(cues, {
      sourceMediaId: "media-dialogue",
      transcriptionJobId: "transcription-job-1",
      offsetSec: 3,
      fps: 24,
    });
    const second = insertDirectorCaptionCuesIntoTimeline(cues, {
      sourceMediaId: "media-dialogue",
      transcriptionJobId: "transcription-job-1",
      offsetSec: 3,
      fps: 24,
    });

    expect(first).toMatchObject({ inserted: 2, trackId: "video-2", alreadyPresent: false });
    expect(second).toMatchObject({ inserted: 0, trackId: "video-2", alreadyPresent: true });
    const clips = useDirectorCreativeWorkspaceStore
      .getState()
      .editTracks.find((track) => track.id === "video-2")!.clips;
    expect(clips).toHaveLength(2);
    expect(clips.map((clip) => clip.startSec)).toEqual([3, 4]);
    expect(clips[0]?.mediaId).toContain("transcription-job-1");
  });
});
