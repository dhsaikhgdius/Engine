import { afterEach, describe, expect, it, vi } from "vitest";
import { setStageViewportAudioEnabled } from "../../../../src/comprehensive/editor/audio/stageViewportAudio";
import {
  detectPlayerFootfall,
  getPlayerFootstepIntensity,
  PlayerRoamAudio,
} from "../../../../src/comprehensive/editor/player/playerRoamAudio";

const gaitSample = {
  crouching: false,
  grounded: true,
  mode: "run",
  normalizedPhase: 0,
  runSpeedMps: 8,
  slowWalking: false,
  speedMps: 8,
};

describe("detectPlayerFootfall", () => {
  it("fires on the half-cycle boundary and on phase wrap only", () => {
    expect(detectPlayerFootfall(0.3, 0.45)).toBe(false);
    expect(detectPlayerFootfall(0.45, 0.55)).toBe(true);
    expect(detectPlayerFootfall(0.55, 0.8)).toBe(false);
    expect(detectPlayerFootfall(0.9, 0.1)).toBe(true);
    expect(detectPlayerFootfall(0.5, 0.5)).toBe(false);
    expect(detectPlayerFootfall(Number.NaN, 0.6)).toBe(false);
  });
});

describe("getPlayerFootstepIntensity", () => {
  it("scales with speed and mutes for airborne or non-gait modes", () => {
    expect(getPlayerFootstepIntensity({ ...gaitSample })).toBeCloseTo(1, 5);
    const walk = getPlayerFootstepIntensity({ ...gaitSample, mode: "walk", speedMps: 2 });
    expect(walk).toBeGreaterThan(0.3);
    expect(walk).toBeLessThan(1);
    expect(getPlayerFootstepIntensity({ ...gaitSample, grounded: false })).toBe(0);
    expect(getPlayerFootstepIntensity({ ...gaitSample, mode: "idle" })).toBe(0);
    expect(getPlayerFootstepIntensity({ ...gaitSample, mode: "emote" })).toBe(0);
  });

  it("steps far quieter while crouching or slow walking", () => {
    const normal = getPlayerFootstepIntensity({ ...gaitSample, mode: "walk", speedMps: 3 });
    const crouched = getPlayerFootstepIntensity({ ...gaitSample, mode: "walk", speedMps: 3, crouching: true });
    const slow = getPlayerFootstepIntensity({ ...gaitSample, mode: "walk", speedMps: 3, slowWalking: true });
    expect(crouched).toBeLessThan(slow);
    expect(slow).toBeLessThan(normal);
    expect(crouched).toBeCloseTo(normal * 0.35, 5);
  });
});

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  destination = {};
  sampleRate = 48_000;
  currentTime = 0;
  state: AudioContextState = "running";
  gains: Array<{ value: number }> = [];

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  createGain() {
    const gain = {
      value: 1,
      setValueAtTime: () => undefined,
      exponentialRampToValueAtTime: () => undefined,
    };
    this.gains.push(gain);
    return {
      gain,
      connect: (destination: unknown) => destination,
      disconnect: () => undefined,
    };
  }

  createBuffer(_channels: number, length: number, _sampleRate: number) {
    return { getChannelData: () => new Float32Array(length) };
  }

  createBufferSource() {
    return {
      buffer: null as AudioBuffer | null,
      connect: (destination: unknown) => destination,
      start: () => undefined,
      stop: () => undefined,
    };
  }

  createBiquadFilter() {
    return {
      type: "lowpass" as BiquadFilterType,
      frequency: { value: 0 },
      Q: { value: 0 },
      connect: (destination: unknown) => destination,
    };
  }

  createOscillator() {
    return {
      type: "sine" as OscillatorType,
      frequency: {
        setValueAtTime: () => undefined,
        exponentialRampToValueAtTime: () => undefined,
      },
      connect: (destination: unknown) => destination,
      start: () => undefined,
      stop: () => undefined,
    };
  }

  resume() {
    return Promise.resolve();
  }

  close() {
    this.state = "closed";
    return Promise.resolve();
  }
}

describe("PlayerRoamAudio without an AudioContext", () => {
  it("stays inert in environments without WebAudio (jsdom)", () => {
    const audio = new PlayerRoamAudio();
    audio.unlock();
    expect(audio.stepGait({ ...gaitSample, normalizedPhase: 0.6 })).toBe(false);
    expect(() => audio.jump()).not.toThrow();
    expect(() => audio.land(6, 7.6)).not.toThrow();
    expect(() => audio.dispose()).not.toThrow();
    // Disposed instances must never lazily re-create a context.
    audio.unlock();
    expect(audio.stepGait({ ...gaitSample, normalizedPhase: 0.1 })).toBe(false);
  });
});

describe("PlayerRoamAudio stage mute", () => {
  afterEach(() => {
    setStageViewportAudioEnabled(true);
    FakeAudioContext.instances = [];
    vi.unstubAllGlobals();
  });

  it("does not build a graph while stage sound is muted", () => {
    vi.stubGlobal("AudioContext", FakeAudioContext as unknown as typeof AudioContext);
    setStageViewportAudioEnabled(false);
    const audio = new PlayerRoamAudio();
    audio.unlock();
    expect(FakeAudioContext.instances).toHaveLength(0);
    audio.dispose();
  });

  it("silences the master gain as soon as stage sound is turned off", () => {
    vi.stubGlobal("AudioContext", FakeAudioContext as unknown as typeof AudioContext);
    const audio = new PlayerRoamAudio();
    audio.unlock();
    expect(FakeAudioContext.instances).toHaveLength(1);
    const master = FakeAudioContext.instances[0]!.gains[0];
    expect(master?.value).toBeGreaterThan(0);
    setStageViewportAudioEnabled(false);
    expect(master?.value).toBe(0);
    expect(audio.stepGait({ ...gaitSample, normalizedPhase: 0.6 })).toBe(false);
    audio.dispose();
  });
});
