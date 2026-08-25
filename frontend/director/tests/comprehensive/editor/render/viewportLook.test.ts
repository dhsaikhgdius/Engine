import { ACESFilmicToneMapping } from "three";
import { describe, expect, it } from "vitest";
import { DIRECTOR_VIEWPORT_TONE_MAPPING, DIRECTOR_VIEWPORT_TONE_MAPPING_EXPOSURE } from "../../../../src/comprehensive/editor/render/viewportLook";

describe("director viewport look", () => {
  it("keeps ACES so authored materials match the previous Stage display transform", () => {
    expect(DIRECTOR_VIEWPORT_TONE_MAPPING).toBe(ACESFilmicToneMapping);
    expect(DIRECTOR_VIEWPORT_TONE_MAPPING_EXPOSURE).toBe(1);
  });
});
