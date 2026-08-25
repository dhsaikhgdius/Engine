import { describe, expect, it } from "vitest";
import { WILDLIFE_PART_ANGLE_SLOTS, WILDLIFE_PART_SLOTS } from "../../../../../src/comprehensive/editor/world/wildlife/placeholderModels";
import {
  resolveWildlifeGaitProfile,
  WILDLIFE_GAIT_PROFILES,
  wildlifeBodyLiftM,
  wildlifeBodyPitchRad,
  wildlifeGaitPhase,
  wildlifeHeadPitchRad,
  wildlifeLegSwingRad,
  wildlifeTailSwingRad,
  writeWildlifePartAngles,
} from "../../../../../src/comprehensive/editor/world/wildlife/wildlifeGait";

const PHASES = [0, 0.35, 0.7, 1.9, Math.PI, 4.4, 6.1];
const LEG_FL = 0;
const LEG_FR = 1;
const LEG_HL = 2;
const LEG_HR = 3;

describe("gait profiles", () => {
  it("exist for every herd species and only for herd species", () => {
    expect(resolveWildlifeGaitProfile("deer")).toBe(WILDLIFE_GAIT_PROFILES.deer);
    expect(resolveWildlifeGaitProfile("wolves")).toBe(WILDLIFE_GAIT_PROFILES.wolves);
    expect(resolveWildlifeGaitProfile("sheep")).toBe(WILDLIFE_GAIT_PROFILES.sheep);
    expect(resolveWildlifeGaitProfile("rabbits")).toBe(WILDLIFE_GAIT_PROFILES.rabbits);
    expect(resolveWildlifeGaitProfile("birds")).toBeNull();
    expect(resolveWildlifeGaitProfile("butterflies")).toBeNull();
    expect(resolveWildlifeGaitProfile("fish")).toBeNull();
    expect(WILDLIFE_GAIT_PROFILES.rabbits.kind).toBe("hop");
    expect(WILDLIFE_GAIT_PROFILES.deer.kind).toBe("trot");
  });

  it("derives the phase deterministically from worldSeconds and the sim phase", () => {
    expect(wildlifeGaitPhase(2, 1, 1.5)).toBeCloseTo(2 * Math.PI * 2 * 1.5 + 1, 12);
    expect(wildlifeGaitPhase(2, 1, 1.5)).toBe(wildlifeGaitPhase(2, 1, 1.5)); // pure
    expect(wildlifeGaitPhase(0, 0.25, 3)).toBe(0.25); // phase offset survives t=0
  });
});

describe("trot leg swing (deer, wolves, sheep)", () => {
  it("moves diagonal pairs together and the two pairs in anti-phase", () => {
    const profile = WILDLIFE_GAIT_PROFILES.deer;
    for (const phase of PHASES) {
      const fl = wildlifeLegSwingRad(profile, phase, LEG_FL, 1);
      const fr = wildlifeLegSwingRad(profile, phase, LEG_FR, 1);
      const hl = wildlifeLegSwingRad(profile, phase, LEG_HL, 1);
      const hr = wildlifeLegSwingRad(profile, phase, LEG_HR, 1);
      expect(fl).toBeCloseTo(hr, 10); // diagonal pair front-left + hind-right
      expect(fr).toBeCloseTo(hl, 10); // diagonal pair front-right + hind-left
      expect(fl).toBeCloseTo(-fr, 10); // pairs in anti-phase
    }
  });

  it("scales amplitude with speed and vanishes at rest", () => {
    const profile = WILDLIFE_GAIT_PROFILES.wolves;
    const phase = Math.PI / 2; // sin peak
    for (let leg = 0; leg < 4; leg += 1) {
      expect(Math.abs(wildlifeLegSwingRad(profile, phase, leg, 0))).toBe(0);
    }
    const slow = Math.abs(wildlifeLegSwingRad(profile, phase, LEG_FL, 0.3));
    const fast = Math.abs(wildlifeLegSwingRad(profile, phase, LEG_FL, 1));
    expect(slow).toBeGreaterThan(0);
    expect(fast).toBeGreaterThan(slow);
    expect(fast).toBeCloseTo(profile.legSwingRad, 10);
    // Speed factor clamps: overspeed does not overswing.
    expect(wildlifeLegSwingRad(profile, phase, LEG_FL, 2)).toBeCloseTo(fast, 10);
  });
});

describe("rabbit hop", () => {
  const profile = WILDLIFE_GAIT_PROFILES.rabbits;

  it("keeps both hind legs in phase and both front legs in phase", () => {
    for (const phase of PHASES) {
      expect(wildlifeLegSwingRad(profile, phase, LEG_HL, 1)).toBeCloseTo(
        wildlifeLegSwingRad(profile, phase, LEG_HR, 1),
        10,
      );
      expect(wildlifeLegSwingRad(profile, phase, LEG_FL, 1)).toBeCloseTo(
        wildlifeLegSwingRad(profile, phase, LEG_FR, 1),
        10,
      );
    }
  });

  it("lags the front pair behind the hind pair", () => {
    const hindAtLag = wildlifeLegSwingRad(profile, profile.frontLegPhaseLagRad, LEG_HL, 1) / profile.legSwingRad;
    const frontAtLag = wildlifeLegSwingRad(profile, profile.frontLegPhaseLagRad, LEG_FL, 1) / profile.frontLegSwingRad;
    expect(frontAtLag).toBeCloseTo(0, 10); // front pair crosses zero exactly one lag later
    expect(Math.abs(hindAtLag - frontAtLag)).toBeGreaterThan(0.5); // pairs are genuinely offset
  });

  it("arcs the body upward once per cycle, never below the resting height", () => {
    let peak = 0;
    for (let phase = 0; phase < Math.PI * 2; phase += 0.1) {
      const lift = wildlifeBodyLiftM(profile, phase, 1);
      expect(lift).toBeGreaterThanOrEqual(0);
      peak = Math.max(peak, lift);
    }
    expect(peak).toBeCloseTo(profile.bodyLiftM, 3);
    expect(wildlifeBodyLiftM(profile, Math.PI, 0)).toBe(0); // no hop at rest
    // Pitch oscillates only for hoppers and follows the arc (nose up on rise).
    expect(wildlifeBodyPitchRad(profile, Math.PI / 2, 1)).toBeCloseTo(-profile.hopPitchRad, 10);
    expect(wildlifeBodyPitchRad(WILDLIFE_GAIT_PROFILES.deer, Math.PI / 2, 1)).toBe(0);
  });

  it("trot bob is zero-mean unlike the hop arc", () => {
    const deer = WILDLIFE_GAIT_PROFILES.deer;
    let min = Number.POSITIVE_INFINITY;
    for (let phase = 0; phase < Math.PI * 2; phase += 0.1) {
      min = Math.min(min, wildlifeBodyLiftM(deer, phase, 1));
    }
    expect(min).toBeLessThan(0); // sin(2φ) bob dips below the mean
    expect(wildlifeBodyLiftM(deer, 0.7, 0)).toBe(0); // still at rest
  });
});

describe("head and tail", () => {
  it("pitches the head down to the full graze pose and suppresses the nod while grazing", () => {
    const profile = WILDLIFE_GAIT_PROFILES.deer;
    expect(wildlifeHeadPitchRad(profile, Math.PI / 2, 1, 1)).toBeCloseTo(profile.grazeHeadPitchRad, 10);
    const nod = wildlifeHeadPitchRad(profile, Math.PI / 2, 1, 0);
    expect(nod).toBeCloseTo(profile.headNodRad, 10); // walk nod at full speed
    expect(wildlifeHeadPitchRad(profile, Math.PI / 2, 0, 0)).toBe(0); // standing, not grazing
    const half = wildlifeHeadPitchRad(profile, Math.PI / 2, 1, 0.5);
    expect(half).toBeGreaterThan(nod);
    expect(half).toBeLessThan(profile.grazeHeadPitchRad);
  });

  it("keeps a small idle tail motion at rest and adds amplitude with speed", () => {
    const profile = WILDLIFE_GAIT_PROFILES.wolves;
    let idlePeak = 0;
    let movePeak = 0;
    for (let phase = 0; phase < Math.PI * 4; phase += 0.05) {
      idlePeak = Math.max(idlePeak, Math.abs(wildlifeTailSwingRad(profile, phase, 0)));
      movePeak = Math.max(movePeak, Math.abs(wildlifeTailSwingRad(profile, phase, 1)));
    }
    expect(idlePeak).toBeCloseTo(profile.tailIdleRad, 2); // alive while standing
    expect(movePeak).toBeCloseTo(profile.tailIdleRad + profile.tailMoveRad, 2);
  });
});

describe("writeWildlifePartAngles", () => {
  it("fills the 8 slots at the agent offset and leaves neighbors untouched", () => {
    const profile = WILDLIFE_GAIT_PROFILES.deer;
    const phase = 1.234;
    const target = new Float32Array(WILDLIFE_PART_ANGLE_SLOTS * 4).fill(99);
    writeWildlifePartAngles(target, 2, profile, phase, 0.8, 0.25);

    const base = 2 * WILDLIFE_PART_ANGLE_SLOTS;
    expect(target[base + WILDLIFE_PART_SLOTS.body]).toBe(0);
    expect(target[base + WILDLIFE_PART_SLOTS.head]).toBeCloseTo(wildlifeHeadPitchRad(profile, phase, 0.8, 0.25), 6);
    for (let leg = 0; leg < 4; leg += 1) {
      expect(target[base + WILDLIFE_PART_SLOTS.legFrontLeft + leg]).toBeCloseTo(
        wildlifeLegSwingRad(profile, phase, leg, 0.8),
        6,
      );
    }
    expect(target[base + WILDLIFE_PART_SLOTS.tail]).toBeCloseTo(wildlifeTailSwingRad(profile, phase, 0.8), 6);
    expect(target[base + WILDLIFE_PART_ANGLE_SLOTS - 1]).toBe(0); // shade defaults to 0

    for (let index = 0; index < target.length; index += 1) {
      if (index < base || index >= base + WILDLIFE_PART_ANGLE_SLOTS) {
        expect(target[index]).toBe(99); // canaries intact
      }
    }
  });

  it("carries the per-agent shade in slot 7 without touching angle slots", () => {
    const profile = WILDLIFE_GAIT_PROFILES.sheep;
    const plain = new Float32Array(WILDLIFE_PART_ANGLE_SLOTS);
    const shaded = new Float32Array(WILDLIFE_PART_ANGLE_SLOTS);
    writeWildlifePartAngles(plain, 0, profile, 2.2, 0.5, 0.3);
    writeWildlifePartAngles(shaded, 0, profile, 2.2, 0.5, 0.3, 0.42);
    expect(shaded[WILDLIFE_PART_ANGLE_SLOTS - 1]).toBeCloseTo(0.42, 6);
    // Every angle slot is identical: shade is fragment-only data.
    for (let slot = 0; slot < WILDLIFE_PART_ANGLE_SLOTS - 1; slot += 1) {
      expect(shaded[slot]).toBe(plain[slot]);
    }
  });

  it("is deterministic for identical inputs", () => {
    const profile = WILDLIFE_GAIT_PROFILES.rabbits;
    const a = new Float32Array(WILDLIFE_PART_ANGLE_SLOTS);
    const b = new Float32Array(WILDLIFE_PART_ANGLE_SLOTS);
    writeWildlifePartAngles(a, 0, profile, 5.5, 0.6, 0, 0.77);
    writeWildlifePartAngles(b, 0, profile, 5.5, 0.6, 0, 0.77);
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});
