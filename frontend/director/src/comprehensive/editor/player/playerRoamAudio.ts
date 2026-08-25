/**
 * Procedural roam foley: footsteps, jump takeoff and landing thumps are
 * synthesized with WebAudio (filtered noise + low sine sweeps), so no audio
 * assets are required and every step gets organic pitch/level variation.
 *
 * The pure gait helpers are exported separately so the trigger logic stays
 * unit-testable without an AudioContext (jsdom has none).
 */

import {
  isStageViewportAudioEnabled,
  subscribeStageViewportAudio,
} from "../audio/stageViewportAudio";

const MASTER_GAIN = 0.22;
const FOOTSTEP_NOISE_S = 0.085;
const LAND_NOISE_S = 0.14;
/** Two footfalls per normalized gait cycle: at the wrap and at half phase. */
const FOOTFALL_MID_PHASE = 0.5;

/** Gait snapshot consumed by the foley system to set footstep volume and timing. */
export type PlayerFootstepGaitSample = {
  /** Whether crouch is active (reduces intensity). */
  crouching: boolean;
  /** Whether the character is on the ground. */
  grounded: boolean;
  /** Current gait mode: "walk", "run", or other. */
  mode: string;
  /** Phase within the current gait cycle, 0..1. */
  normalizedPhase: number;
  /** Reference run speed in m/s used for intensity normalization. */
  runSpeedMps: number;
  /** Whether slow-walk toggle is active (reduces intensity). */
  slowWalking: boolean;
  /** Current planar speed in m/s. */
  speedMps: number;
};

/**
 * A footfall lands when the gait phase crosses the half cycle or wraps past
 * the end. Both boundaries are checked in one call so a large frame delta
 * cannot skip a step entirely (it may merge two into one, which reads fine).
 */
export function detectPlayerFootfall(previousPhase: number, phase: number): boolean {
  if (!(Number.isFinite(previousPhase) && Number.isFinite(phase))) return false;
  if (phase === previousPhase) return false;
  if (phase < previousPhase) return true; // wrapped past 1.0
  return previousPhase < FOOTFALL_MID_PHASE && phase >= FOOTFALL_MID_PHASE;
}

/** Loudness follows gait energy; sneaking gaits step much softer. */
export function getPlayerFootstepIntensity(sample: PlayerFootstepGaitSample): number {
  if (!sample.grounded || (sample.mode !== "walk" && sample.mode !== "run")) return 0;
  const speedRatio = Math.min(1, Math.max(0, sample.speedMps / Math.max(0.01, sample.runSpeedMps)));
  const base = 0.35 + 0.65 * speedRatio;
  if (sample.crouching) return base * 0.35;
  if (sample.slowWalking) return base * 0.55;
  return base;
}

type AudioContextLike = AudioContext;

function createAudioContext(): AudioContextLike | null {
  try {
    const Constructor =
      typeof AudioContext !== "undefined"
        ? AudioContext
        : (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    return Constructor ? new Constructor() : null;
  } catch {
    return null;
  }
}

/**
 * Procedural roam foley engine. Synthesizes footsteps, jump takeoffs, and
 * landing thumps with WebAudio (filtered noise and low sine sweeps), so no
 * audio assets are required. The AudioContext is lazily created on the first
 * user gesture to comply with browser autoplay policies.
 */
export class PlayerRoamAudio {
  private context: AudioContextLike | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private previousPhase = 0;
  private disposed = false;
  private readonly unsubscribePreference: () => void;

  constructor() {
    this.unsubscribePreference = subscribeStageViewportAudio(() => this.syncEnabled());
  }

  private syncEnabled() {
    if (!this.master) return;
    this.master.gain.value = isStageViewportAudioEnabled() ? MASTER_GAIN : 0;
  }

  /** Safe to call every frame; only does work once audio is permitted. */
  private ensureGraph(): boolean {
    if (this.disposed) return false;
    if (this.context) return true;
    const context = createAudioContext();
    if (!context) return false;
    this.context = context;
    this.master = context.createGain();
    this.syncEnabled();
    this.master.connect(context.destination);
    const sampleCount = Math.max(1, Math.floor(context.sampleRate * 0.5));
    this.noiseBuffer = context.createBuffer(1, sampleCount, context.sampleRate);
    const channel = this.noiseBuffer.getChannelData(0);
    for (let index = 0; index < channel.length; index += 1) channel[index] = Math.random() * 2 - 1;
    return true;
  }

  /**
   * Browsers gate playback behind a user gesture; call from pointer/keyboard
   * handlers. Creation is also deferred here so page load stays silent.
   */
  unlock() {
    if (!isStageViewportAudioEnabled()) return;
    if (!this.ensureGraph() || !this.context) return;
    if (this.context.state === "suspended") void this.context.resume().catch(() => undefined);
  }

  private playNoise({
    at,
    durationS,
    filterType,
    frequency,
    gain,
    q = 1.1,
  }: {
    at: number;
    durationS: number;
    filterType: BiquadFilterType;
    frequency: number;
    gain: number;
    q?: number;
  }) {
    if (!this.context || !this.master || !this.noiseBuffer) return;
    const source = this.context.createBufferSource();
    source.buffer = this.noiseBuffer;
    const filter = this.context.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = frequency;
    filter.Q.value = q;
    const envelope = this.context.createGain();
    envelope.gain.setValueAtTime(gain, at);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + durationS);
    source.connect(filter).connect(envelope).connect(this.master);
    source.start(at, Math.random() * 0.25, durationS + 0.02);
    source.stop(at + durationS + 0.02);
  }

  private playThump({
    at,
    durationS,
    fromHz,
    gain,
    toHz,
  }: {
    at: number;
    durationS: number;
    fromHz: number;
    gain: number;
    toHz: number;
  }) {
    if (!this.context || !this.master) return;
    const oscillator = this.context.createOscillator();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(fromHz, at);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, toHz), at + durationS);
    const envelope = this.context.createGain();
    envelope.gain.setValueAtTime(gain, at);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + durationS);
    oscillator.connect(envelope).connect(this.master);
    oscillator.start(at);
    oscillator.stop(at + durationS + 0.01);
  }

  /**
   * Advance the gait clock and emit a footstep when a footfall boundary is
   * crossed. Returns whether a step sounded (useful for tests/telemetry).
   */
  stepGait(sample: PlayerFootstepGaitSample): boolean {
    const previousPhase = this.previousPhase;
    this.previousPhase = sample.normalizedPhase;
    const intensity = getPlayerFootstepIntensity(sample);
    if (intensity <= 0 || !detectPlayerFootfall(previousPhase, sample.normalizedPhase)) return false;
    if (!isStageViewportAudioEnabled()) return false;
    if (!this.context || this.context.state !== "running" || !this.master) return false;
    const at = this.context.currentTime;
    const jitter = 0.85 + Math.random() * 0.3;
    this.playNoise({
      at,
      durationS: FOOTSTEP_NOISE_S,
      filterType: "bandpass",
      frequency: (420 + 520 * intensity) * jitter,
      gain: 0.5 * intensity,
    });
    this.playThump({
      at,
      durationS: 0.07,
      fromHz: 95 * jitter,
      toHz: 58,
      gain: 0.55 * intensity,
    });
    return true;
  }

  /** Soft takeoff puff on an accepted jump impulse. */
  jump() {
    if (!isStageViewportAudioEnabled()) return;
    if (!this.context || this.context.state !== "running") return;
    const at = this.context.currentTime;
    this.playNoise({
      at,
      durationS: 0.06,
      filterType: "highpass",
      frequency: 900,
      gain: 0.12,
    });
  }

  /** Landing weight scales with the vertical impact speed the motor absorbed. */
  land(impactSpeedMps: number, referenceSpeedMps: number) {
    if (!isStageViewportAudioEnabled()) return;
    if (!this.context || this.context.state !== "running") return;
    const weight = Math.min(1, Math.max(0.2, impactSpeedMps / Math.max(0.01, referenceSpeedMps)));
    const at = this.context.currentTime;
    this.playNoise({
      at,
      durationS: LAND_NOISE_S,
      filterType: "lowpass",
      frequency: 320 + 280 * weight,
      gain: 0.5 * weight,
    });
    this.playThump({
      at,
      durationS: 0.11,
      fromHz: 80,
      toHz: 42,
      gain: 0.85 * weight,
    });
  }

  /** Releases the AudioContext and preference subscription. Safe to call multiple times. */
  dispose() {
    this.disposed = true;
    this.unsubscribePreference();
    const context = this.context;
    this.context = null;
    this.master = null;
    this.noiseBuffer = null;
    if (context) void context.close().catch(() => undefined);
  }
}
