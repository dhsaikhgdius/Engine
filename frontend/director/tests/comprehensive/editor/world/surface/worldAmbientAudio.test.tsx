import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DirectorWorldWeather } from "../../../../../../../packages/protocol/src/worldSystemsProtocol";
import { setStageViewportAudioEnabled } from "../../../../../src/comprehensive/editor/audio/stageViewportAudio";
import type { LivingWorldFrameContext } from "../../../../../src/comprehensive/editor/world/livingWorldContracts";
import { evaluateWorldClimate } from "../../../../../src/comprehensive/editor/world/worldClimate";
import WorldAmbientAudio, { fillSeededUnitNoise } from "../../../../../src/comprehensive/editor/world/surface/worldAmbientAudio";

const fiberMocks = vi.hoisted(() => ({ frame: null as null | (() => void) }));

vi.mock("@react-three/fiber", async () => {
  const actual = await vi.importActual<typeof import("@react-three/fiber")>("@react-three/fiber");
  return {
    ...actual,
    useFrame: (callback: () => void) => {
      fiberMocks.frame = callback;
    },
  };
});

function weather(overrides: Partial<DirectorWorldWeather> = {}): DirectorWorldWeather {
  return {
    preset: "rain",
    intensity: 1,
    wetness: 0.4,
    cloudCover: 0.6,
    ...overrides,
  };
}

function createContext(windVector: [number, number, number]): LivingWorldFrameContext {
  const settings = {
    enabled: true,
    seed: 1,
    wind: { directionDegrees: 0, speedMps: 8, gustiness: 0, turbulence: 0 },
    timeOfDay: { mode: "fixed" as const, hours: 12, cycleMinutes: 12, drivesSky: false },
    weather: weather(),
  };
  return {
    worldSeconds: 0,
    frame: 0,
    fps: 24,
    isPlaying: false,
    seed: 1,
    settings,
    climate: evaluateWorldClimate(settings, 0),
    windVector,
    groundHeight: 0,
  };
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  destination = {};
  gains: Array<{ gain: { value: number } }> = [];
  sampleRate = 48_000;
  state: AudioContextState = "running";

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  createGain() {
    const node = {
      gain: { value: 1 },
      connect: (destination: unknown) => destination,
      disconnect: () => undefined,
    };
    this.gains.push(node);
    return node;
  }

  createBiquadFilter() {
    return {
      type: "lowpass" as BiquadFilterType,
      frequency: { value: 0 },
      Q: { value: 0 },
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
      loop: false,
      connect: (destination: unknown) => destination,
      disconnect: () => undefined,
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

describe("seeded ambient noise", () => {
  it("is deterministic for a seed and independent of wall clocks", () => {
    const a = new Float32Array(32);
    const b = new Float32Array(32);
    fillSeededUnitNoise(a, 20260814);
    fillSeededUnitNoise(b, 20260814);
    expect(Array.from(a)).toEqual(Array.from(b));
    const other = new Float32Array(32);
    fillSeededUnitNoise(other, 7);
    expect(Array.from(a)).not.toEqual(Array.from(other));
    expect(Math.max(...a)).toBeLessThanOrEqual(1);
    expect(Math.min(...a)).toBeGreaterThanOrEqual(-1);
    const source = fillSeededUnitNoise.toString();
    expect(source).not.toContain("Math.random");
    expect(source).not.toContain("Date.now");
  });
});

describe("WorldAmbientAudio preference", () => {
  afterEach(() => {
    setStageViewportAudioEnabled(true);
    FakeAudioContext.instances = [];
    vi.unstubAllGlobals();
    fiberMocks.frame = null;
  });

  it("does not open an AudioContext when stage sound is muted", () => {
    vi.stubGlobal("AudioContext", FakeAudioContext as unknown as typeof AudioContext);
    setStageViewportAudioEnabled(false);
    const { unmount } = render(<WorldAmbientAudio context={createContext([8, 0, 0])} />);
    expect(FakeAudioContext.instances).toHaveLength(0);
    unmount();
  });

  it("opens an AudioContext while stage sound is enabled", () => {
    vi.stubGlobal("AudioContext", FakeAudioContext as unknown as typeof AudioContext);
    const { unmount } = render(<WorldAmbientAudio context={createContext([8, 0, 0])} />);
    expect(FakeAudioContext.instances).toHaveLength(1);
    unmount();
    expect(FakeAudioContext.instances[0]!.state).toBe("closed");
  });

  it("tracks mutable gust speed in the frame loop without a React rerender", () => {
    vi.stubGlobal("AudioContext", FakeAudioContext as unknown as typeof AudioContext);
    const windVector: [number, number, number] = [0, 0, 0];
    const { unmount } = render(<WorldAmbientAudio context={createContext(windVector)} />);
    const context = FakeAudioContext.instances[0]!;

    windVector[0] = 14;
    act(() => fiberMocks.frame?.());

    expect(context.gains[1]!.gain.value).toBeCloseTo(0.45, 8);
    unmount();
  });
});
