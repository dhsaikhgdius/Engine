import { describe, expect, it } from "vitest";
import { WILDLIFE_RENDER_PROFILES } from "../../../../../src/comprehensive/editor/world/wildlife/placeholderModels";
import {
  computeWildlifeModelNormalization,
  resolveWildlifePlaceholderHeightM,
  selectWildlifeClipIndex,
  wildlifeMixerTimeSeconds,
} from "../../../../../src/comprehensive/editor/world/wildlife/wildlifeAssets";

describe("clip selection", () => {
  const clips = ["Armature|Idle", "Walk_Cycle", "Run", "Eat_Grass"];

  it("prefers walk/run while moving and idle/eat/graze while grazing", () => {
    expect(selectWildlifeClipIndex(clips, true)).toBe(1);
    expect(selectWildlifeClipIndex(clips, false)).toBe(0);
    expect(selectWildlifeClipIndex(["Sprint", "RUNNING"], true)).toBe(1);
    expect(selectWildlifeClipIndex(["Graze", "walkfast"], false)).toBe(0);
  });

  it("matches case-insensitively on substrings", () => {
    expect(selectWildlifeClipIndex(["deer_WALK_loop"], true)).toBe(0);
    expect(selectWildlifeClipIndex(["EATING"], false)).toBe(0);
  });

  it("falls back to the first clip on no keyword match and -1 on empty", () => {
    expect(selectWildlifeClipIndex(["TPose", "Swim"], true)).toBe(0);
    expect(selectWildlifeClipIndex(["TPose", "Swim"], false)).toBe(0);
    expect(selectWildlifeClipIndex([], true)).toBe(-1);
    // Substring matching is intentionally naive: "Death" contains "eat".
    expect(selectWildlifeClipIndex(["TPose", "Death"], false)).toBe(1);
  });
});

describe("deterministic mixer time", () => {
  it("is a pure function of (worldSeconds, phase, playbackScale)", () => {
    expect(wildlifeMixerTimeSeconds(12.5, 1.75, 1.2)).toBe(wildlifeMixerTimeSeconds(12.5, 1.75, 1.2));
    expect(wildlifeMixerTimeSeconds(12.5, 1.75, 1.2)).toBeCloseTo((12.5 + 1.75) * 1.2, 12);
  });

  it("decorrelates agents by phase and scales cadence by playbackScale", () => {
    expect(wildlifeMixerTimeSeconds(10, 0.4, 1)).not.toBe(wildlifeMixerTimeSeconds(10, 2.9, 1));
    expect(wildlifeMixerTimeSeconds(10, 0, 2)).toBe(20);
    // Order of evaluation must not matter (scrubbing/export parity).
    const forward = [0, 1, 2].map((t) => wildlifeMixerTimeSeconds(t, 0.7, 1.5));
    const backward = [2, 1, 0].map((t) => wildlifeMixerTimeSeconds(t, 0.7, 1.5)).reverse();
    expect(forward).toEqual(backward);
  });
});

describe("model normalization", () => {
  it("scales bbox height to the target and rests the bbox base at y=0", () => {
    const normalization = computeWildlifeModelNormalization(-0.5, 2, 1);
    expect(normalization.scale).toBeCloseTo(0.5, 12);
    expect(normalization.offsetY).toBeCloseTo(0.25, 12);
    // A model authored with feet at origin needs no offset.
    expect(computeWildlifeModelNormalization(0, 4, 2).offsetY).toBe(0);
  });

  it("stays finite on degenerate bounds", () => {
    const normalization = computeWildlifeModelNormalization(0, 0, 1.4);
    expect(Number.isFinite(normalization.scale)).toBe(true);
    expect(Number.isFinite(normalization.offsetY)).toBe(true);
  });
});

describe("placeholder target height", () => {
  it("derives standing height from the placeholder silhouette plus body offset", () => {
    const deer = resolveWildlifePlaceholderHeightM("deer");
    const rabbits = resolveWildlifePlaceholderHeightM("rabbits");
    expect(deer).toBeGreaterThan(WILDLIFE_RENDER_PROFILES.deer.bodyOffsetYM);
    expect(deer).toBeLessThan(3);
    expect(rabbits).toBeGreaterThan(0);
    expect(deer).toBeGreaterThan(rabbits);
    // Memoized: identical on repeat calls.
    expect(resolveWildlifePlaceholderHeightM("deer")).toBe(deer);
  });
});
