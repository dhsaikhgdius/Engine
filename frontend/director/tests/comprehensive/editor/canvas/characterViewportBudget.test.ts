import { describe, expect, it } from "vitest";
import {
  DIRECTOR_CHARACTER_ANIMATION_LOD_FAR_M,
  DIRECTOR_CHARACTER_ANIMATION_LOD_NEAR_M,
  getDirectorCharacterFrameStride,
  getDirectorCharacterFrameStrideForMode,
  quantizeDirectorCharacterPlaybackFrame,
  selectDirectorViewportLabelIds,
} from "../../../../src/comprehensive/editor/canvas/characterViewportBudget";

describe("getDirectorCharacterFrameStride", () => {
  it("keeps the full rate near the camera and for unknown distances", () => {
    expect(getDirectorCharacterFrameStride(0)).toBe(1);
    expect(getDirectorCharacterFrameStride(DIRECTOR_CHARACTER_ANIMATION_LOD_NEAR_M - 0.01)).toBe(1);
    expect(getDirectorCharacterFrameStride(null)).toBe(1);
    expect(getDirectorCharacterFrameStride(Number.NaN)).toBe(1);
  });

  it("steps down to half and quarter rate with distance", () => {
    expect(getDirectorCharacterFrameStride(DIRECTOR_CHARACTER_ANIMATION_LOD_NEAR_M)).toBe(2);
    expect(getDirectorCharacterFrameStride(DIRECTOR_CHARACTER_ANIMATION_LOD_FAR_M - 0.01)).toBe(2);
    expect(getDirectorCharacterFrameStride(DIRECTOR_CHARACTER_ANIMATION_LOD_FAR_M)).toBe(4);
    expect(getDirectorCharacterFrameStride(1_000)).toBe(4);
  });

  it("respects an explicit full-rate or adaptive sampling mode", () => {
    expect(getDirectorCharacterFrameStrideForMode(1_000, "full")).toBe(1);
    expect(getDirectorCharacterFrameStrideForMode(1_000, "adaptive")).toBe(4);
  });
});

describe("quantizeDirectorCharacterPlaybackFrame", () => {
  it("passes frames through at full rate", () => {
    expect(quantizeDirectorCharacterPlaybackFrame(37, 1)).toBe(37);
    expect(quantizeDirectorCharacterPlaybackFrame(37.5, 1)).toBe(37.5);
  });

  it("snaps frames down onto the stride grid so a window shares one sample", () => {
    expect(quantizeDirectorCharacterPlaybackFrame(37, 2)).toBe(36);
    expect(quantizeDirectorCharacterPlaybackFrame(36, 2)).toBe(36);
    expect(quantizeDirectorCharacterPlaybackFrame(39, 4)).toBe(36);
    expect(quantizeDirectorCharacterPlaybackFrame(40, 4)).toBe(40);
    expect(quantizeDirectorCharacterPlaybackFrame(0, 4)).toBe(0);
  });
});

describe("selectDirectorViewportLabelIds", () => {
  const candidate = (id: string, distanceM: number | null) => ({ id, distanceM });

  it("returns null while every candidate fits the budget", () => {
    const candidates = [candidate("a", 1), candidate("b", 2)];
    expect(selectDirectorViewportLabelIds(candidates, new Set(), 2)).toBeNull();
  });

  it("keeps the nearest candidates when the budget is exceeded", () => {
    const candidates = [candidate("far", 50), candidate("near", 1), candidate("mid", 10)];
    const allowed = selectDirectorViewportLabelIds(candidates, new Set(), 2);
    expect(allowed).not.toBeNull();
    expect([...allowed!].sort()).toEqual(["mid", "near"]);
  });

  it("always keeps the selection even when it is the farthest", () => {
    const candidates = [candidate("far-selected", 90), candidate("near", 1), candidate("mid", 10)];
    const allowed = selectDirectorViewportLabelIds(candidates, new Set(["far-selected"]), 2);
    expect(allowed).not.toBeNull();
    expect(allowed!.has("far-selected")).toBe(true);
    expect(allowed!.has("near")).toBe(true);
    expect(allowed!.has("mid")).toBe(false);
  });

  it("ranks unknown distances last", () => {
    const candidates = [candidate("unknown", null), candidate("near", 1), candidate("mid", 10)];
    const allowed = selectDirectorViewportLabelIds(candidates, new Set(), 2);
    expect(allowed).not.toBeNull();
    expect(allowed!.has("unknown")).toBe(false);
  });
});
