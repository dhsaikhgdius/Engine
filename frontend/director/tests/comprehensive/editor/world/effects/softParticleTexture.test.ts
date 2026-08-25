import { describe, expect, it } from "vitest";
import {
  EFFECT_SPRITE_TEXTURE_SIZE,
  buildEffectSpriteAtlasData,
} from "../../../../../src/comprehensive/editor/world/effects/softParticleTexture";

const SIZE = EFFECT_SPRITE_TEXTURE_SIZE;

/** Sample one channel (0 = r flame, 1 = g flake, 2 = b ring, 3 = a disc) at (u, v). */
function sampleChannel(data: Uint8Array, channel: number, u: number, v: number): number {
  const column = Math.min(SIZE - 1, Math.max(0, Math.floor(u * SIZE)));
  const row = Math.min(SIZE - 1, Math.max(0, Math.floor(v * SIZE)));
  return data[(row * SIZE + column) * 4 + channel];
}

function channelSum(data: Uint8Array, channel: number, predicate: (u: number, v: number) => boolean): number {
  let sum = 0;
  for (let row = 0; row < SIZE; row += 1) {
    const v = (row + 0.5) / SIZE;
    for (let column = 0; column < SIZE; column += 1) {
      const u = (column + 0.5) / SIZE;
      if (predicate(u, v)) sum += data[(row * SIZE + column) * 4 + channel];
    }
  }
  return sum;
}

describe("effect sprite atlas", () => {
  it("is byte-deterministic: two builds produce identical payloads", () => {
    const first = buildEffectSpriteAtlasData();
    const second = buildEffectSpriteAtlasData();
    expect(first.length).toBe(SIZE * SIZE * 4);
    expect(first).toEqual(second);
  });

  it("packs a soft disc into the alpha channel, brightest at the centre", () => {
    const data = buildEffectSpriteAtlasData();
    const centre = sampleChannel(data, 3, 0.5, 0.5);
    expect(centre).toBeGreaterThan(240);
    // Monotone-ish falloff toward the rim, fully transparent at the corner.
    expect(sampleChannel(data, 3, 0.75, 0.5)).toBeLessThan(centre);
    expect(sampleChannel(data, 3, 0.02, 0.02)).toBe(0);
    // Accent lobes keep rotation visible: the sprite is not radially uniform.
    const east = sampleChannel(data, 3, 0.66, 0.41);
    const west = sampleChannel(data, 3, 0.34, 0.41);
    expect(Math.abs(east - west)).toBeGreaterThan(4);
  });

  it("packs a flame teardrop into red: dense base, feathered tip pointing up", () => {
    const data = buildEffectSpriteAtlasData();
    // Bulk of the flame mass sits below the vertical midline (v < 0.5).
    const lowerMass = channelSum(data, 0, (_u, v) => v < 0.5);
    const upperMass = channelSum(data, 0, (_u, v) => v >= 0.5);
    expect(lowerMass).toBeGreaterThan(upperMass * 1.5);
    // The tip still reaches high (a teardrop, not a squashed blob)...
    expect(sampleChannel(data, 0, 0.5, 0.85)).toBeGreaterThan(20);
    // ...while the flanks near the top stay empty.
    expect(sampleChannel(data, 0, 0.15, 0.85)).toBe(0);
    expect(sampleChannel(data, 0, 0.85, 0.85)).toBe(0);
    // The base fades out before the quad edge so no hard cut shows.
    expect(sampleChannel(data, 0, 0.5, 0.005)).toBeLessThan(40);
  });

  it("packs a six-armed crystal into green with sixfold arm structure", () => {
    const data = buildEffectSpriteAtlasData();
    // Solid core.
    expect(sampleChannel(data, 1, 0.5, 0.5)).toBeGreaterThan(200);
    // Along an arm (0 degrees) the mask is dense; midway BETWEEN arms
    // (30 degrees) at the same radius it is empty.
    const radius = 0.3;
    const onArm = sampleChannel(data, 1, 0.5 + radius, 0.5);
    const betweenArms = sampleChannel(
      data,
      1,
      0.5 + radius * Math.cos(Math.PI / 6),
      0.5 + radius * Math.sin(Math.PI / 6),
    );
    expect(onArm).toBeGreaterThan(120);
    expect(betweenArms).toBeLessThan(30);
    // All six arm tips carry mass (six-fold symmetry, not a single stroke).
    for (let arm = 0; arm < 6; arm += 1) {
      const angle = (arm * Math.PI) / 3;
      const tip = sampleChannel(data, 1, 0.5 + 0.32 * Math.cos(angle), 0.5 + 0.32 * Math.sin(angle));
      expect(tip, `arm ${arm}`).toBeGreaterThan(60);
    }
  });

  it("packs a splash ring into blue: a band that is hollow at the centre", () => {
    const data = buildEffectSpriteAtlasData();
    expect(sampleChannel(data, 2, 0.5, 0.5)).toBe(0);
    // Peak on the ring band radius (0.33) in every direction.
    for (const angle of [0, Math.PI / 3, Math.PI, (3 * Math.PI) / 2]) {
      const band = sampleChannel(data, 2, 0.5 + 0.33 * Math.cos(angle), 0.5 + 0.33 * Math.sin(angle));
      expect(band).toBeGreaterThan(200);
    }
    // Outside the band it falls back off.
    expect(sampleChannel(data, 2, 0.99, 0.5)).toBeLessThan(10);
  });
});
