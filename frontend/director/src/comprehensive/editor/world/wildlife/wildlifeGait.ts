import type { WorldWildlifeSpecies } from "../../../../../../../packages/protocol/src/worldSystemsProtocol";
import { WILDLIFE_PART_ANGLE_SLOTS, WILDLIFE_PART_SLOTS } from "./placeholderModels";

/**
 * Pure gait math: per-part rotation angles for the articulated placeholder
 * quadrupeds (plus the whole-body lift/pitch that accompanies the gait) and
 * the bird wing flap-glide cycle. Everything here is a pure function of
 * (worldSeconds, per-agent sim phase, interpolated speed, graze blend), so
 * exports and scrubbing reproduce identical poses — no Math.random, no
 * Date.now, no retained state.
 *
 * Gait model:
 * - trot (deer, wolves, sheep): diagonal leg pairs swing in anti-phase
 *   (front-left + hind-right vs front-right + hind-left), swing amplitude
 *   scales linearly with normalized speed and is exactly 0 at rest. Body
 *   bobs at 2× the stride frequency (two diagonal footfalls per cycle) and
 *   the head nods subtly with the stride.
 * - hop (rabbits): both hind legs swing together, front pair together with a
 *   phase lag, and the body arcs upward once per cycle (lift >= 0) with a
 *   nose-up-on-rise pitch.
 * - grazing: the head part pitches down by `grazeHeadPitchRad`, blended by
 *   the sim's smoothed 0..1 graze blend (which also fades the walk nod out).
 * - tail: swings with a small idle amplitude even at rest (life at
 *   standstill) plus a speed-scaled component.
 *
 * The gait phase advances with worldSeconds at a fixed per-species stride
 * frequency (amplitude, not frequency, tracks speed) so the phase never needs
 * integration and stays deterministic under scrubbing.
 */

const TWO_PI = Math.PI * 2;

/** Phase offset that decorrelates tail swing from the leg stride cycle. */
export const WILDLIFE_TAIL_PHASE_OFFSET_RAD = Math.PI / 3;

/** Herd species that have a gait profile (quadrupeds with articulated legs). */
export type WildlifeHerdSpecies = "deer" | "rabbits" | "wolves" | "sheep";

/** Gait locomotion pattern: trot (diagonal leg pairs) or hop (hind-pair drive). */
export type WildlifeGaitKind = "trot" | "hop";

/** Per-species tuning constants for the articulated quadruped gait. */
export interface WildlifeGaitProfile {
  /** Locomotion pattern (trot or hop). */
  kind: WildlifeGaitKind;
  /** Stride cycles per second (fixed; speed scales amplitude only). */
  strideHz: number;
  /** Max leg swing at full speed (hind legs for hop), radians. */
  legSwingRad: number;
  /** Hop only: front-pair swing amplitude, radians. */
  frontLegSwingRad: number;
  /** Hop only: front pair trails the hind pair by this phase, radians. */
  frontLegPhaseLagRad: number;
  /** Walk head-nod amplitude at full speed, radians. */
  headNodRad: number;
  /** Head-down pitch at full graze blend, radians (+X pitch = head down). */
  grazeHeadPitchRad: number;
  /** Tail swing amplitude at rest, radians. */
  tailIdleRad: number;
  /** Additional tail swing amplitude at full speed, radians. */
  tailMoveRad: number;
  /** Tail swing frequency relative to the stride frequency. */
  tailRateScale: number;
  /** Body lift amplitude (m at sizeScale 1): trot bob or hop arc height. */
  bodyLiftM: number;
  /** Hop only: body pitch oscillation amplitude, radians. */
  hopPitchRad: number;
}

/**
 * Gait constants tuned per herd species for visually plausible motion.
 *
 * Cadence carries species character (stride frequency is fixed, so it IS the
 * character): deer trot at a neutral 1.5 Hz; wolves lope — a SLOWER cadence
 * with a much longer reaching swing and a visible bound in the body lift;
 * sheep plod — QUICKER, shorter steps with almost no bounce; rabbits hop.
 * At cruise speed that works out to ≈1.85 m of ground per wolf stride vs
 * ≈0.7 m per sheep step, which reads instantly from a previz camera.
 */
export const WILDLIFE_GAIT_PROFILES: Record<WildlifeHerdSpecies, WildlifeGaitProfile> = {
  deer: {
    kind: "trot",
    strideHz: 1.5,
    legSwingRad: 0.5,
    frontLegSwingRad: 0.5,
    frontLegPhaseLagRad: 0,
    headNodRad: 0.07,
    grazeHeadPitchRad: 1.35,
    tailIdleRad: 0.08,
    tailMoveRad: 0.18,
    tailRateScale: 1,
    bodyLiftM: 0.03,
    hopPitchRad: 0,
  },
  wolves: {
    kind: "trot",
    strideHz: 1.35,
    legSwingRad: 0.7,
    frontLegSwingRad: 0.7,
    frontLegPhaseLagRad: 0,
    headNodRad: 0.06,
    grazeHeadPitchRad: 0.55,
    tailIdleRad: 0.3,
    tailMoveRad: 0.25,
    tailRateScale: 1.5,
    bodyLiftM: 0.035,
    hopPitchRad: 0,
  },
  sheep: {
    kind: "trot",
    strideHz: 1.75,
    legSwingRad: 0.3,
    frontLegSwingRad: 0.3,
    frontLegPhaseLagRad: 0,
    headNodRad: 0.05,
    grazeHeadPitchRad: 1.05,
    tailIdleRad: 0.12,
    tailMoveRad: 0.15,
    tailRateScale: 1,
    bodyLiftM: 0.012,
    hopPitchRad: 0,
  },
  rabbits: {
    kind: "hop",
    strideHz: 2.4,
    legSwingRad: 0.9,
    frontLegSwingRad: 0.55,
    frontLegPhaseLagRad: 1.9,
    headNodRad: 0.08,
    grazeHeadPitchRad: 0.5,
    tailIdleRad: 0.1,
    tailMoveRad: 0.2,
    tailRateScale: 1,
    bodyLiftM: 0.055,
    hopPitchRad: 0.14,
  },
};

/** Gait profile for a herd species, or null for flock/school species. */
export function resolveWildlifeGaitProfile(species: WorldWildlifeSpecies): WildlifeGaitProfile | null {
  switch (species) {
    case "deer":
    case "rabbits":
    case "wolves":
    case "sheep":
      return WILDLIFE_GAIT_PROFILES[species];
    default:
      return null;
  }
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Gait phase (radians) at a moment in time. `agentPhase` is the sim's
 * immutable per-agent phase offset, so herd members are desynchronized.
 */
export function wildlifeGaitPhase(worldSeconds: number, agentPhase: number, strideHz: number): number {
  return worldSeconds * TWO_PI * strideHz + agentPhase;
}

/** Leg order matching the angle slots legFrontLeft..legHindRight (slots 2..5). */
export const WILDLIFE_LEG_ORDER = ["legFrontLeft", "legFrontRight", "legHindLeft", "legHindRight"] as const;

/**
 * Fore/aft leg swing (radians about the hip/shoulder X axis) for leg index
 * 0..3 in WILDLIFE_LEG_ORDER. Trot: diagonal pairs (FL+HR vs FR+HL) in
 * anti-phase. Hop: hind pair together, front pair together with a lag.
 * Amplitude scales with clamped speedFactor and vanishes at rest.
 */
export function wildlifeLegSwingRad(
  profile: WildlifeGaitProfile,
  phase: number,
  legIndex: number,
  speedFactor: number,
): number {
  const sf = clamp01(speedFactor);
  if (profile.kind === "hop") {
    const isFront = legIndex < 2;
    const amplitude = (isFront ? profile.frontLegSwingRad : profile.legSwingRad) * sf;
    const lag = isFront ? profile.frontLegPhaseLagRad : 0;
    return Math.sin(phase - lag) * amplitude;
  }
  const diagonalSign = legIndex === 0 || legIndex === 3 ? 1 : -1;
  return Math.sin(phase) * diagonalSign * profile.legSwingRad * sf;
}

/**
 * Vertical body offset (metres at sizeScale 1). Trot: bob at twice the
 * stride frequency (two footfalls per cycle), zero-mean. Hop: one-per-cycle
 * arc, always >= 0. Both vanish at rest.
 */
export function wildlifeBodyLiftM(profile: WildlifeGaitProfile, phase: number, speedFactor: number): number {
  const sf = clamp01(speedFactor);
  if (profile.kind === "hop") {
    return (0.5 - 0.5 * Math.cos(phase)) * profile.bodyLiftM * sf;
  }
  return Math.sin(phase * 2) * profile.bodyLiftM * sf;
}

/**
 * Whole-body pitch (radians, +X = nose down). Hop only: nose up while the
 * arc rises (lift slope is max at phase π/2), nose down on the descent.
 */
export function wildlifeBodyPitchRad(profile: WildlifeGaitProfile, phase: number, speedFactor: number): number {
  if (profile.kind !== "hop") return 0;
  return -Math.sin(phase) * profile.hopPitchRad * clamp01(speedFactor);
}

/**
 * Head part pitch (radians about the neck-base X axis, positive = down).
 * Blends between the walking nod and the full graze pose; at grazeBlend 1
 * the nod is fully suppressed and the head holds `grazeHeadPitchRad`.
 */
export function wildlifeHeadPitchRad(
  profile: WildlifeGaitProfile,
  phase: number,
  speedFactor: number,
  grazeBlend: number,
): number {
  const graze = clamp01(grazeBlend);
  const nod = Math.sin(phase) * profile.headNodRad * clamp01(speedFactor);
  return graze * profile.grazeHeadPitchRad + (1 - graze) * nod;
}

/**
 * Tail swing (radians about the species' tail axis). Keeps a small idle
 * amplitude at rest — a standing animal still moves its tail — plus a
 * speed-scaled component.
 */
export function wildlifeTailSwingRad(profile: WildlifeGaitProfile, phase: number, speedFactor: number): number {
  const amplitude = profile.tailIdleRad + profile.tailMoveRad * clamp01(speedFactor);
  return Math.sin(phase * profile.tailRateScale + WILDLIFE_TAIL_PHASE_OFFSET_RAD) * amplitude;
}

// ---------------------------------------------------------------------------
// Bird wing flap-glide (flock render path)
// ---------------------------------------------------------------------------

/** Tuning for the bird wing beat and its flap/glide alternation. */
export interface WildlifeBirdWingProfile {
  /** Wing-beat frequency during a flap burst, Hz. */
  flapHz: number;
  /** Peak wing elevation/depression during a beat, radians. */
  flapAmplitudeRad: number;
  /** Flap-burst / glide alternation frequency, Hz (one cycle ≈ 6 s). */
  glideHz: number;
  /** Wings held in a shallow raised V while gliding, radians. */
  glideDihedralRad: number;
}

/**
 * Bird wing motion: bursts of wing beats separated by stiff-winged glides —
 * the signature that separates a bird from a butterfly at previz distance
 * (butterflies flap continuously at high frequency and never glide).
 * `flapHz` must equal WILDLIFE_RENDER_PROFILES.birds.flapHz so the small
 * body rock in the render layer stays in phase with the beat (locked by a
 * test).
 */
export const WILDLIFE_BIRD_WING_PROFILE: WildlifeBirdWingProfile = {
  flapHz: 4,
  flapAmplitudeRad: 0.85,
  glideHz: 0.16,
  glideDihedralRad: 0.22,
};

/**
 * Flap-burst gate: 1 while the bird beats its wings, 0 mid-glide, with a
 * smooth ramp between. A pure function of (worldSeconds, agentPhase); the
 * 1.9 phase multiplier decorrelates glide onsets across the flock without
 * touching the shared beat frequency.
 */
export function wildlifeBirdFlapEnvelope01(worldSeconds: number, agentPhase: number): number {
  const gate = Math.sin(worldSeconds * TWO_PI * WILDLIFE_BIRD_WING_PROFILE.glideHz + agentPhase * 1.9);
  return clamp01((gate + 0.35) / 0.7);
}

/**
 * Shared wing flap angle (radians, positive raises both tips — the wing
 * parts carry mirrored ±Z axes, see placeholderModels.ts). Inside a burst
 * the wings beat sinusoidally at `flapHz` using the SAME phase as the render
 * layer's body rock; during a glide they hold the dihedral V.
 */
export function wildlifeBirdWingFlapRad(worldSeconds: number, agentPhase: number): number {
  const profile = WILDLIFE_BIRD_WING_PROFILE;
  const envelope = wildlifeBirdFlapEnvelope01(worldSeconds, agentPhase);
  const beat = Math.sin(worldSeconds * TWO_PI * profile.flapHz + agentPhase) * profile.flapAmplitudeRad;
  return envelope * beat + (1 - envelope) * profile.glideDihedralRad;
}

/**
 * Writes the 8 angle slots for one bird: the shared wing flap into both
 * wing slots (the mirrored part axes resolve left/right), zero for every
 * other part, and the per-agent shade into slot 7 — same layout contract as
 * {@link writeWildlifePartAngles}.
 */
export function writeWildlifeBirdPartAngles(
  target: Float32Array,
  agentIndex: number,
  worldSeconds: number,
  agentPhase: number,
  shade01 = 0,
): void {
  const base = agentIndex * WILDLIFE_PART_ANGLE_SLOTS;
  const wing = wildlifeBirdWingFlapRad(worldSeconds, agentPhase);
  target[base + WILDLIFE_PART_SLOTS.body] = 0;
  target[base + WILDLIFE_PART_SLOTS.head] = 0;
  target[base + WILDLIFE_PART_SLOTS.legFrontLeft] = wing;
  target[base + WILDLIFE_PART_SLOTS.legFrontRight] = wing;
  target[base + WILDLIFE_PART_SLOTS.legHindLeft] = 0;
  target[base + WILDLIFE_PART_SLOTS.legHindRight] = 0;
  target[base + WILDLIFE_PART_SLOTS.tail] = 0;
  target[base + WILDLIFE_PART_ANGLE_SLOTS - 1] = shade01;
}

/**
 * Writes the 8 per-part angle slots for one agent into an interleaved
 * Float32Array (stride WILDLIFE_PART_ANGLE_SLOTS). Slot layout follows
 * WILDLIFE_PART_SLOTS; the body slot (0) always carries 0 so untagged
 * vertices never rotate. Slot 7 is not an angle: it carries the agent's
 * 0..1 shade variation, read directly by the fragment stage of the part
 * material (no vertex has part id 7, so the angle picker never sees it).
 */
export function writeWildlifePartAngles(
  target: Float32Array,
  agentIndex: number,
  profile: WildlifeGaitProfile,
  phase: number,
  speedFactor: number,
  grazeBlend: number,
  shade01 = 0,
): void {
  const base = agentIndex * WILDLIFE_PART_ANGLE_SLOTS;
  target[base + WILDLIFE_PART_SLOTS.body] = 0;
  target[base + WILDLIFE_PART_SLOTS.head] = wildlifeHeadPitchRad(profile, phase, speedFactor, grazeBlend);
  for (let leg = 0; leg < 4; leg += 1) {
    target[base + WILDLIFE_PART_SLOTS.legFrontLeft + leg] = wildlifeLegSwingRad(profile, phase, leg, speedFactor);
  }
  target[base + WILDLIFE_PART_SLOTS.tail] = wildlifeTailSwingRad(profile, phase, speedFactor);
  target[base + WILDLIFE_PART_ANGLE_SLOTS - 1] = shade01;
}
