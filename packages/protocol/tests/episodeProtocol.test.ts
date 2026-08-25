import { describe, expect, it } from "vitest";
import type { z } from "zod";

import {
  EPISODE_ACTION_TRACK_CONTRACT,
  EPISODE_CAPTIONS_CONTRACT,
  EPISODE_MANIFEST_CONTRACT,
  canonicalEpisodeJson,
  episodeActionTrackSchema,
  episodeCaptionsSchema,
  episodeManifestSchema,
  validateEpisodeIntegrity,
  type EpisodeDenseCaptionEntry,
  type EpisodeManifest,
  type EpisodeManifestInput,
} from "../src/episodeProtocol";

type ActionTrackInput = z.input<typeof episodeActionTrackSchema>;
type CaptionsInput = z.input<typeof episodeCaptionsSchema>;

const FRAME_COUNT = 4;
const hex = (char: string) => char.repeat(64);

function manifestInput(overrides: Partial<EpisodeManifestInput> = {}): EpisodeManifestInput {
  return {
    contract: EPISODE_MANIFEST_CONTRACT,
    id: "episode-0001",
    datasetId: "dataset-indoor-nav-v1",
    projectId: "project-warehouse",
    sceneRevision: `director-project-revision:v1:sha256:${hex("a")}`,
    seed: 42,
    timebase: {
      frameRate: { numerator: 24_000, denominator: 1_001 },
      frameCount: FRAME_COUNT,
      startTimecode: "00:00:00:00",
    },
    renderer: {
      backendId: "three-webgl",
      version: "0.184.0",
      resolution: { width: 1280, height: 720 },
      colorSpace: "srgb",
    },
    provenance: {
      codeVersion: "9f2c1e7d3b5a4c8e0f6d2a1b9c8e7f6d5a4b3c2d",
      configHash: `sha256:${hex("b")}`,
      assets: [{ assetId: "asset:crate", sha256: hex("c"), license: "CC0-1.0" }],
    },
    artifacts: [
      { path: "video/rgb.mp4", kind: "video", sha256: hex("d"), bytes: 1_024 },
      { path: "actions/track.json", kind: "action-track", sha256: hex("e"), bytes: 256 },
    ],
    quality: [{ gateId: "temporal-sync", passed: true, detail: "0 dropped frames" }],
    ...overrides,
  };
}

function rawControlInput(): NonNullable<ActionTrackInput["rawControl"]> {
  return {
    keys: ["KeyW", "KeyA"],
    pressed: [
      [1, 0],
      [1, 0],
      [0, 1],
      [0, 0],
    ],
    pointerDelta: [
      [0, 0],
      [2, -1],
      [0.5, 0],
      [0, 0],
    ],
    axes: [{ id: "gamepad-left-x", values: [0, 0.25, 0.5, 0] }],
  };
}

function cameraPoseInput(): NonNullable<ActionTrackInput["cameraPose"]> {
  const halfSqrt2 = Math.SQRT1_2;
  return {
    intrinsics: { fovDegrees: 50 },
    positions: [
      [0, 1.6, 5],
      [0, 1.6, 4.9],
      [0, 1.6, 4.8],
      [0, 1.6, 4.7],
    ],
    rotations: [
      [0, 0, 0, 1],
      [0, 0, 0, 1],
      [0, halfSqrt2, 0, halfSqrt2],
      [0, 0, 0, 1],
    ],
  };
}

function actionTrackInput(overrides: Partial<ActionTrackInput> = {}): ActionTrackInput {
  return {
    contract: EPISODE_ACTION_TRACK_CONTRACT,
    rawControl: rawControlInput(),
    cameraPose: cameraPoseInput(),
    semanticEvents: [
      {
        frame: 1,
        type: "object-picked",
        subjectId: "agent:player",
        objectId: "object:crate",
        payload: { hand: "right" },
      },
      { frame: 1, type: "camera-cut" },
      { frame: 3, type: "episode-end" },
    ],
    ...overrides,
  };
}

function denseLayer(entries: EpisodeDenseCaptionEntry[]): NonNullable<CaptionsInput["denseTemporal"]> {
  return { language: "en-US", generator: { method: "deterministic-composed" }, entries };
}

function captionsInput(overrides: Partial<CaptionsInput> = {}): CaptionsInput {
  return {
    contract: EPISODE_CAPTIONS_CONTRACT,
    narrative: {
      text: "The camera dollies through a sunlit warehouse while the player picks up a crate.",
      language: "en-US",
      generator: { method: "vlm-polished", model: "internal-captioner-v2" },
    },
    sceneStatic: {
      text: "A sunlit industrial warehouse with tall shelves, wooden crates and dusty concrete floors.",
      language: "en-US",
      generator: { method: "deterministic-composed" },
    },
    // Overlapping windows ([0,1] and [1,3]) are deliberately valid.
    denseTemporal: denseLayer([
      { frameStart: 0, frameEnd: 1, caption: "The camera dollies forward." },
      { frameStart: 1, frameEnd: 3, caption: "The player grabs the crate." },
    ]),
    ...overrides,
  };
}

const parseManifest = (input: EpisodeManifestInput) => episodeManifestSchema.parse(input);
const parseTrack = (input: ActionTrackInput) => episodeActionTrackSchema.parse(input);
const parseCaptions = (input: CaptionsInput) => episodeCaptionsSchema.parse(input);

describe("episodeProtocol", () => {
  it("parses a fully-populated manifest and a minimal one with defaults applied", () => {
    const full = parseManifest(manifestInput());
    expect(full.timebase.frameRate).toEqual({ numerator: 24_000, denominator: 1_001 });

    const { datasetId: _datasetId, quality: _quality, ...minimalBase } = manifestInput();
    const minimal = parseManifest({
      ...minimalBase,
      sceneRevision: 7,
      timebase: { frameRate: { numerator: 24, denominator: 1 }, frameCount: FRAME_COUNT },
      provenance: { codeVersion: "v0.3.1", configHash: `sha256:${hex("b")}` },
    });
    expect(minimal.sceneRevision).toBe(7);
    expect(minimal.provenance.assets).toEqual([]);
    expect(minimal.datasetId).toBeUndefined();
  });

  it("rejects structural manifest violations at the schema boundary", () => {
    const duplicatePath = manifestInput().artifacts[0];
    expect(() =>
      parseManifest(manifestInput({ artifacts: [duplicatePath, { ...duplicatePath, kind: "metadata" }] })),
    ).toThrow(/artifact paths must be unique/);
    expect(() => parseManifest(manifestInput({ artifacts: [{ ...duplicatePath, path: "../escape.mp4" }] }))).toThrow(
      /episode-relative/,
    );
    const asset = { assetId: "asset:crate", sha256: hex("c") };
    expect(() =>
      parseManifest(
        manifestInput({
          provenance: { codeVersion: "v1", configHash: `sha256:${hex("b")}`, assets: [asset, asset] },
        }),
      ),
    ).toThrow(/assetIds must be unique/);

    expect(episodeManifestSchema.safeParse(manifestInput({ seed: 1.5 })).success).toBe(false);
    expect(
      episodeManifestSchema.safeParse(
        manifestInput({
          timebase: { frameRate: { numerator: 24, denominator: 0 }, frameCount: FRAME_COUNT },
        }),
      ).success,
    ).toBe(false);
    expect(
      episodeManifestSchema.safeParse(
        manifestInput({
          timebase: {
            frameRate: { numerator: 24, denominator: 1 },
            frameCount: FRAME_COUNT,
            startTimecode: "0:00:00:00",
          },
        }),
      ).success,
    ).toBe(false);
    expect(episodeManifestSchema.safeParse({ ...manifestInput(), surprise: true }).success).toBe(false);
    expect(episodeManifestSchema.safeParse(manifestInput({ artifacts: [] })).success).toBe(false);
  });

  it("rejects invalid action tracks at the schema boundary", () => {
    expect(() => parseTrack({ contract: EPISODE_ACTION_TRACK_CONTRACT })).toThrow(/at least one layer/);
    expect(() =>
      parseTrack(actionTrackInput({ rawControl: { ...rawControlInput(), keys: ["KeyW", "KeyW"] } })),
    ).toThrow(/keys must be unique/);
    expect(() =>
      parseTrack(
        actionTrackInput({
          rawControl: { ...rawControlInput(), pressed: [[1, 0], [1], [0, 1], [0, 0]] },
        }),
      ),
    ).toThrow(/one flag per key/);
    expect(
      episodeActionTrackSchema.safeParse(
        actionTrackInput({
          rawControl: {
            ...rawControlInput(),
            axes: [
              { id: "x", values: [0] },
              { id: "x", values: [1] },
            ],
          },
        }),
      ).success,
    ).toBe(false);
    // Multi-hot flags must be 0 or 1.
    expect(
      episodeActionTrackSchema.safeParse({
        contract: EPISODE_ACTION_TRACK_CONTRACT,
        rawControl: { keys: ["KeyW"], pressed: [[2], [0], [0], [0]] },
      }).success,
    ).toBe(false);

    const pose = cameraPoseInput();
    expect(() =>
      parseTrack(actionTrackInput({ cameraPose: { ...pose, intrinsics: { fovDegrees: 50, focalLengthMm: 35 } } })),
    ).toThrow(/exactly one of focalLengthMm or fovDegrees/);
    expect(() => parseTrack(actionTrackInput({ cameraPose: { ...pose, intrinsics: {} } }))).toThrow(
      /exactly one of focalLengthMm or fovDegrees/,
    );
  });

  it("rejects invalid captions at the schema boundary", () => {
    expect(() => parseCaptions({ contract: EPISODE_CAPTIONS_CONTRACT })).toThrow(/at least one layer/);
    expect(
      episodeCaptionsSchema.safeParse({
        contract: EPISODE_CAPTIONS_CONTRACT,
        narrative: { text: "A caption.", language: "english language!", generator: { method: "human" } },
      }).success,
    ).toBe(false);
    expect(
      episodeCaptionsSchema.safeParse({
        contract: EPISODE_CAPTIONS_CONTRACT,
        sceneStatic: { text: "A caption.", language: "en-US", generator: { method: "hand-written" } },
      }).success,
    ).toBe(false);
    expect(episodeCaptionsSchema.safeParse(captionsInput({ denseTemporal: denseLayer([]) })).success).toBe(true);
  });

  it("accepts a consistent episode triple and a manifest on its own", () => {
    const manifest = parseManifest(manifestInput());
    expect(validateEpisodeIntegrity(manifest)).toEqual([]);
    expect(validateEpisodeIntegrity(manifest, parseTrack(actionTrackInput()), parseCaptions(captionsInput()))).toEqual(
      [],
    );
  });

  it("reports per-frame arrays that do not match the manifest frame count", () => {
    const manifest = parseManifest(manifestInput());
    const track = parseTrack(
      actionTrackInput({
        rawControl: {
          ...rawControlInput(),
          pressed: [
            [1, 0],
            [0, 1],
          ],
          pointerDelta: [
            [0, 0],
            [1, 1],
            [2, 2],
            [3, 3],
            [4, 4],
          ],
          axes: [{ id: "gamepad-left-x", values: [0] }],
        },
        cameraPose: {
          ...cameraPoseInput(),
          positions: [[0, 1.6, 5]],
          rotations: [[0, 0, 0, 1]],
        },
      }),
    );
    const issues = validateEpisodeIntegrity(manifest, track);
    expect(issues.every((issue) => issue.code === "frame-array-length")).toBe(true);
    expect(issues.map((issue) => issue.path)).toEqual([
      ["actionTrack", "rawControl", "pressed"],
      ["actionTrack", "rawControl", "pointerDelta"],
      ["actionTrack", "rawControl", "axes", 0, "values"],
      ["actionTrack", "cameraPose", "positions"],
      ["actionTrack", "cameraPose", "rotations"],
    ]);
  });

  it("reports out-of-bounds and unsorted semantic events", () => {
    const manifest = parseManifest(manifestInput());
    const outOfBounds = parseTrack(actionTrackInput({ semanticEvents: [{ frame: FRAME_COUNT, type: "episode-end" }] }));
    expect(validateEpisodeIntegrity(manifest, outOfBounds)).toEqual([
      expect.objectContaining({
        code: "event-frame-out-of-bounds",
        path: ["actionTrack", "semanticEvents", 0, "frame"],
      }),
    ]);

    const unsorted = parseTrack(
      actionTrackInput({
        semanticEvents: [
          { frame: 2, type: "camera-cut" },
          { frame: 1, type: "object-picked" },
        ],
      }),
    );
    expect(validateEpisodeIntegrity(manifest, unsorted)).toEqual([
      expect.objectContaining({ code: "event-order", path: ["actionTrack", "semanticEvents", 1, "frame"] }),
    ]);
  });

  it("reports dense caption range and order violations while allowing ordered overlaps", () => {
    const manifest = parseManifest(manifestInput());
    const track = parseTrack(actionTrackInput());

    const outOfBounds = parseCaptions(
      captionsInput({ denseTemporal: denseLayer([{ frameStart: 0, frameEnd: FRAME_COUNT, caption: "Too long." }]) }),
    );
    expect(validateEpisodeIntegrity(manifest, track, outOfBounds)).toEqual([
      expect.objectContaining({
        code: "caption-range-out-of-bounds",
        path: ["captions", "denseTemporal", "entries", 0, "frameEnd"],
      }),
    ]);

    const inverted = parseCaptions(
      captionsInput({ denseTemporal: denseLayer([{ frameStart: 3, frameEnd: 1, caption: "Backwards." }]) }),
    );
    expect(validateEpisodeIntegrity(manifest, track, inverted)).toEqual([
      expect.objectContaining({ code: "caption-range-inverted", path: ["captions", "denseTemporal", "entries", 0] }),
    ]);

    const unsorted = parseCaptions(
      captionsInput({
        denseTemporal: denseLayer([
          { frameStart: 2, frameEnd: 3, caption: "Second." },
          { frameStart: 0, frameEnd: 1, caption: "First." },
        ]),
      }),
    );
    expect(validateEpisodeIntegrity(manifest, track, unsorted)).toEqual([
      expect.objectContaining({
        code: "caption-order",
        path: ["captions", "denseTemporal", "entries", 1, "frameStart"],
      }),
    ]);

    // Overlap with equal starts stays valid as long as ordering holds.
    const overlapping = parseCaptions(
      captionsInput({
        denseTemporal: denseLayer([
          { frameStart: 0, frameEnd: 3, caption: "Whole clip." },
          { frameStart: 0, frameEnd: 1, caption: "Opening." },
          { frameStart: 1, frameEnd: 2, caption: "Middle." },
        ]),
      }),
    );
    expect(validateEpisodeIntegrity(manifest, track, overlapping)).toEqual([]);
  });

  it("checks quaternion normalization within the declared tolerance", () => {
    const manifest = parseManifest(manifestInput());
    const pose = cameraPoseInput();
    const denormalized = parseTrack(
      actionTrackInput({
        cameraPose: {
          ...pose,
          rotations: [
            [0, 0, 0, 0.5],
            [0, 0, 0, 1],
            [0, 0, 0, 1],
            [0, 0, 0, 1],
          ],
        },
      }),
    );
    expect(validateEpisodeIntegrity(manifest, denormalized)).toEqual([
      expect.objectContaining({
        code: "quaternion-not-normalized",
        path: ["actionTrack", "cameraPose", "rotations", 0],
      }),
    ]);

    const withinTolerance = parseTrack(
      actionTrackInput({
        cameraPose: {
          ...pose,
          rotations: [
            [0, 0, 0, 1.0005],
            [0, 0, 0, 1],
            [0, 0, 0, 1],
            [0, 0, 0, 0.9995],
          ],
        },
      }),
    );
    expect(validateEpisodeIntegrity(manifest, withinTolerance)).toEqual([]);
  });

  it("reports an invalid timebase instead of cascading frame-indexed noise", () => {
    const manifest = parseManifest(manifestInput());
    const zeroFrames: EpisodeManifest = { ...manifest, timebase: { ...manifest.timebase, frameCount: 0 } };
    const issues = validateEpisodeIntegrity(zeroFrames, parseTrack(actionTrackInput()), parseCaptions(captionsInput()));
    expect(issues).toEqual([
      expect.objectContaining({ code: "timebase-invalid", path: ["manifest", "timebase", "frameCount"] }),
    ]);

    const zeroDenominator: EpisodeManifest = {
      ...manifest,
      timebase: { ...manifest.timebase, frameRate: { numerator: 24, denominator: 0 } },
    };
    expect(validateEpisodeIntegrity(zeroDenominator)).toEqual([
      expect.objectContaining({
        code: "timebase-invalid",
        path: ["manifest", "timebase", "frameRate", "denominator"],
      }),
    ]);
  });

  it("canonicalizes manifests independent of key insertion order and applied defaults", () => {
    const base = manifestInput();
    const reordered: EpisodeManifestInput = {
      quality: base.quality,
      artifacts: base.artifacts,
      provenance: base.provenance,
      renderer: base.renderer,
      timebase: {
        startTimecode: "00:00:00:00",
        frameCount: FRAME_COUNT,
        frameRate: { denominator: 1_001, numerator: 24_000 },
      },
      seed: base.seed,
      sceneRevision: base.sceneRevision,
      projectId: base.projectId,
      datasetId: base.datasetId,
      id: base.id,
      contract: base.contract,
    };
    expect(canonicalEpisodeJson(reordered)).toBe(canonicalEpisodeJson(base));

    const explicitEmptyAssets = manifestInput({
      provenance: { codeVersion: "v1", configHash: `sha256:${hex("b")}`, assets: [] },
    });
    const defaultedAssets = manifestInput({
      provenance: { codeVersion: "v1", configHash: `sha256:${hex("b")}` },
    });
    expect(canonicalEpisodeJson(defaultedAssets)).toBe(canonicalEpisodeJson(explicitEmptyAssets));

    const artifact = manifestInput().artifacts[0];
    expect(() => canonicalEpisodeJson(manifestInput({ artifacts: [artifact, artifact] }))).toThrow(
      /artifact paths must be unique/,
    );
  });
});
