import { describe, expect, it } from "vitest";
import { stableLexicalJson } from "@director/protocol/stable-json";
import {
  EPISODE_MANIFEST_CONTRACT,
  validateEpisodeIntegrity,
  type EpisodeManifest,
  type EpisodeSemanticEvent,
  type EpisodeTimebase,
} from "@director/protocol/episode";
import { createDefaultDirectorProject } from "../../../../src/comprehensive/editor/store/directorStore";
import { composeEpisodeCaptions } from "../../../../src/comprehensive/editor/datarecorder/episodeCaptionComposer";

const HEX = "cd".repeat(32);

const MOTION_WORDS = [
  "move",
  "moves",
  "moving",
  "walk",
  "walks",
  "walking",
  "pan",
  "pans",
  "panning",
  "tilt",
  "tilts",
  "then",
  "after",
  "before",
  "while",
  "during",
  "later",
  "next",
  "begins",
  "starts",
  "proceeds",
  "follows",
  "dollies",
  "orbits",
  "turns",
  "rotates",
  "travels",
  "approaches",
  "leaves",
  "enters",
  "exits",
  "cuts",
  "jumps",
  "plays",
  "seeks",
];

const FRAME_COUNT = 24;
const TIMEBASE: EpisodeTimebase = {
  frameRate: { numerator: 24, denominator: 1 },
  frameCount: FRAME_COUNT,
};

function fixtureEvents(): EpisodeSemanticEvent[] {
  return [
    {
      frame: 2,
      type: "workbench.author",
      payload: { op: "author" },
    },
    {
      frame: 2,
      type: "authoring.add_object",
      subjectId: "box_a",
      objectId: "stage-root",
      payload: { action: "add_object", id: "box_a" },
    },
    {
      frame: 8,
      type: "timeline.playhead",
      payload: { playheadFrame: 8 },
    },
    {
      frame: 8,
      type: "workbench.select",
      subjectId: "box_a",
    },
    {
      frame: 20,
      type: "completely.unknown.event",
      subjectId: "mystery",
    },
  ];
}

function minimalManifest(frameCount: number): EpisodeManifest {
  return {
    contract: EPISODE_MANIFEST_CONTRACT,
    id: "episode-caption-fixture",
    projectId: "test-project",
    sceneRevision: "rev-1",
    seed: 1,
    timebase: { frameRate: { numerator: 24, denominator: 1 }, frameCount },
    renderer: {
      backendId: "three-webgl",
      version: "test",
      resolution: { width: 64, height: 64 },
      colorSpace: "srgb",
    },
    provenance: { codeVersion: "test", configHash: "sha256:caption-config", assets: [] },
    artifacts: [{ path: "video/rgb.mp4", kind: "video", sha256: HEX, bytes: 1 }],
  };
}

function containsMotionWord(text: string): string | null {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
  return MOTION_WORDS.find((word) => tokens.includes(word)) ?? null;
}

describe("episodeCaptionComposer", () => {
  it("emits three validated layers from a real Director project", () => {
    const project = createDefaultDirectorProject();
    const captions = composeEpisodeCaptions({
      project,
      events: fixtureEvents(),
      timebase: TIMEBASE,
    });
    expect(captions.sceneStatic).toBeDefined();
    expect(captions.narrative).toBeDefined();
    expect(captions.denseTemporal).toBeDefined();
    expect(captions.sceneStatic!.generator.method).toBe("deterministic-composed");
    expect(captions.narrative!.generator.method).toBe("deterministic-composed");
    expect(captions.denseTemporal!.generator.method).toBe("deterministic-composed");
    expect(captions.sceneStatic!.language).toBe("en");
    expect(captions.denseTemporal!.entries.length).toBe(3);
    expect(validateEpisodeIntegrity(minimalManifest(FRAME_COUNT), undefined, captions)).toEqual([]);
  });

  it("keeps sceneStatic free of motion vocabulary", () => {
    const captions = composeEpisodeCaptions({
      project: createDefaultDirectorProject(),
      events: fixtureEvents(),
      timebase: TIMEBASE,
    });
    expect(containsMotionWord(captions.sceneStatic!.text)).toBeNull();
    expect(captions.sceneStatic!.text).toMatch(/stage contains/i);
    expect(captions.sceneStatic!.text).toMatch(/lighting consists of/i);
    expect(captions.sceneStatic!.text).toMatch(/ground plane/i);
  });

  it("is a deterministic pure function of project and events", () => {
    const project = createDefaultDirectorProject();
    const events = fixtureEvents();
    const first = composeEpisodeCaptions({ project, events, timebase: TIMEBASE });
    const second = composeEpisodeCaptions({ project, events, timebase: TIMEBASE });
    expect(stableLexicalJson(first)).toBe(stableLexicalJson(second));

    const reorderedProject = {
      ...project,
      objects: [...project.objects].reverse(),
      lights: [...(project.lights ?? [])].reverse(),
    };
    const reorderedEvents: EpisodeSemanticEvent[] = events.map((event) => ({
      payload: event.payload,
      objectId: event.objectId,
      subjectId: event.subjectId,
      type: event.type,
      frame: event.frame,
    }));
    const shuffled = composeEpisodeCaptions({
      project: reorderedProject,
      events: reorderedEvents,
      timebase: TIMEBASE,
    });
    expect(stableLexicalJson(shuffled)).toBe(stableLexicalJson(first));
  });

  it("still produces a valid sceneStatic caption when the event list is empty", () => {
    const captions = composeEpisodeCaptions({
      project: createDefaultDirectorProject(),
      events: [],
      timebase: TIMEBASE,
    });
    expect(captions.sceneStatic?.text.length).toBeGreaterThan(0);
    expect(captions.denseTemporal).toBeUndefined();
    expect(captions.narrative?.text).toMatch(/No scripted events are present/);
    expect(validateEpisodeIntegrity(minimalManifest(FRAME_COUNT), undefined, captions)).toEqual([]);
  });

  it("does not throw on unknown event types", () => {
    const captions = composeEpisodeCaptions({
      project: createDefaultDirectorProject(),
      events: [{ frame: 0, type: "not.a.real.type", subjectId: "x" }],
      timebase: TIMEBASE,
    });
    expect(captions.denseTemporal?.entries[0]?.caption).toMatch(/event not a real type occurs \(x\)/);
  });
});
