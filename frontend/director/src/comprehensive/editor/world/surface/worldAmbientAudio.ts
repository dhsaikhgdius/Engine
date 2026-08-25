/**
 * Seeded procedural world bed: wind rumble, rain hiss, snow hush.
 *
 * The noise buffer is an LCG — never `Math.random` / `Date.now` — so two
 * sessions with the same world seed produce the same loop. Gains are a pure
 * function of weather + wind (see computeWorldAmbientAudioGains). The graph
 * is muted while the ambient clock is suspended (capture / export) and when
 * the Stage sound toggle is off.
 */

import { useEffect, useLayoutEffect, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type { DirectorWorldWeather } from "../../../../../../../packages/protocol/src/worldSystemsProtocol";
import { useStageViewportAudioEnabled } from "../../audio/stageViewportAudio";
import { isWorldAmbientClockSuspended, useWorldClockStore } from "../worldClock";
import { computeWorldAmbientAudioGains } from "./worldSurfaceResponse";

/**
 * Fills a Float32Array with deterministic unit noise via an LCG, so the same
 * seed always produces the same buffer — critical for reproducible ambient loops
 * across sessions.
 *
 * @param output - The destination buffer to fill with values in [-1, 1].
 * @param seed - Integer seed for the linear congruential generator.
 */
export function fillSeededUnitNoise(output: Float32Array, seed: number): void {
  let state = seed >>> 0;
  if (state === 0) state = 0x9e3779b9;
  for (let index = 0; index < output.length; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    output[index] = (state / 0x100000000) * 2 - 1;
  }
}

/**
 * Fills a Float32Array with deterministic brown(ish) noise: the same LCG
 * stream leaked through a one-pole integrator, then peak-normalised. The
 * spectrum falls off ~6 dB/octave, which reads as a deep storm rumble once
 * low-passed. Same seed → same buffer; loop-safe like the unit noise.
 *
 * @param output - The destination buffer to fill with values in [-1, 1].
 * @param seed - Integer seed for the linear congruential generator.
 */
export function fillSeededBrownNoise(output: Float32Array, seed: number): void {
  let state = seed >>> 0;
  if (state === 0) state = 0x9e3779b9;
  let level = 0;
  let peak = 1e-6;
  for (let index = 0; index < output.length; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const white = (state / 0x100000000) * 2 - 1;
    // Leaky integrator keeps the walk bounded so loops never drift or click.
    level = level * 0.985 + white * 0.045;
    output[index] = level;
    const magnitude = Math.abs(level);
    if (magnitude > peak) peak = magnitude;
  }
  for (let index = 0; index < output.length; index += 1) {
    output[index] = output[index]! / peak;
  }
}

function createAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    const Ctor =
      typeof AudioContext !== "undefined"
        ? AudioContext
        : (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    return Ctor ? new Ctor() : null;
  } catch {
    return null;
  }
}

function createLoopSource(
  context: AudioContext,
  seed: number,
  durationSeconds: number,
  fill: (output: Float32Array, seed: number) => void = fillSeededUnitNoise,
): AudioBufferSourceNode {
  const length = Math.max(1, Math.floor(context.sampleRate * durationSeconds));
  const buffer = context.createBuffer(1, length, context.sampleRate);
  fill(buffer.getChannelData(0), seed);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  return source;
}

/**
 * React component that drives a procedural ambient audio bed (wind rumble,
 * rain hiss, snow hush) from the current world seed, weather, and wind vector.
 *
 * The graph is muted while the ambient clock is suspended or the Stage sound
 * toggle is off. Gains update every frame via {@link computeWorldAmbientAudioGains}.
 *
 * @param seed - World seed that deterministically seeds the three noise loops.
 * @param weather - Current weather preset and intensity.
 * @param windVector - World-space wind direction and magnitude.
 * @returns null — this component renders nothing; it owns the Web Audio graph.
 */
export default function WorldAmbientAudio({
  seed,
  weather,
  windVector,
}: {
  seed: number;
  weather: DirectorWorldWeather;
  windVector: readonly [number, number, number];
}) {
  const audioEnabled = useStageViewportAudioEnabled();
  const suspended = useWorldClockStore((state) => state.suspended);
  const masterRef = useRef<GainNode | null>(null);
  const windGainRef = useRef<GainNode | null>(null);
  const rainGainRef = useRef<GainNode | null>(null);
  const snowGainRef = useRef<GainNode | null>(null);
  const patterGainRef = useRef<GainNode | null>(null);
  const rumbleGainRef = useRef<GainNode | null>(null);

  useEffect(() => {
    if (!audioEnabled) return undefined;
    const context = createAudioContext();
    if (!context) return undefined;

    const master = context.createGain();
    master.gain.value = isWorldAmbientClockSuspended() ? 0 : 1;
    master.connect(context.destination);

    const windFilter = context.createBiquadFilter();
    windFilter.type = "lowpass";
    windFilter.frequency.value = 180;
    const windGain = context.createGain();
    windGain.gain.value = 0;

    const rainFilter = context.createBiquadFilter();
    rainFilter.type = "highpass";
    rainFilter.frequency.value = 900;
    const rainGain = context.createGain();
    rainGain.gain.value = 0;

    const snowFilter = context.createBiquadFilter();
    snowFilter.type = "bandpass";
    snowFilter.frequency.value = 420;
    snowFilter.Q.value = 0.65;
    const snowGain = context.createGain();
    snowGain.gain.value = 0;

    // Rain droplet patter: a narrow bright band over the broadband hiss so
    // rain reads as drops on surfaces, not just static.
    const patterFilter = context.createBiquadFilter();
    patterFilter.type = "bandpass";
    patterFilter.frequency.value = 2800;
    patterFilter.Q.value = 1.4;
    const patterGain = context.createGain();
    patterGain.gain.value = 0;

    // Storm rumble: brown noise through a deep lowpass.
    const rumbleFilter = context.createBiquadFilter();
    rumbleFilter.type = "lowpass";
    rumbleFilter.frequency.value = 110;
    const rumbleGain = context.createGain();
    rumbleGain.gain.value = 0;

    const windSource = createLoopSource(context, seed, 2.5);
    const rainSource = createLoopSource(context, seed ^ 0x9e3779b9, 1.75);
    const snowSource = createLoopSource(context, seed + 0x85ebca6b, 3.1);
    const patterSource = createLoopSource(context, seed ^ 0xc2b2ae35, 1.35);
    const rumbleSource = createLoopSource(context, seed + 0x27d4eb2f, 4.7, fillSeededBrownNoise);

    windSource.connect(windFilter).connect(windGain).connect(master);
    rainSource.connect(rainFilter).connect(rainGain).connect(master);
    snowSource.connect(snowFilter).connect(snowGain).connect(master);
    patterSource.connect(patterFilter).connect(patterGain).connect(master);
    rumbleSource.connect(rumbleFilter).connect(rumbleGain).connect(master);

    windSource.start(0);
    rainSource.start(0);
    snowSource.start(0);
    patterSource.start(0);
    rumbleSource.start(0);

    masterRef.current = master;
    windGainRef.current = windGain;
    rainGainRef.current = rainGain;
    snowGainRef.current = snowGain;
    patterGainRef.current = patterGain;
    rumbleGainRef.current = rumbleGain;

    void context.resume();

    return () => {
      for (const source of [windSource, rainSource, snowSource, patterSource, rumbleSource]) {
        source.stop();
        source.disconnect();
      }
      master.disconnect();
      masterRef.current = null;
      windGainRef.current = null;
      rainGainRef.current = null;
      snowGainRef.current = null;
      patterGainRef.current = null;
      rumbleGainRef.current = null;
      void context.close();
    };
  }, [audioEnabled, seed]);

  const syncAudioGains = () => {
    const windSpeedMps = Math.hypot(windVector[0], windVector[2]);
    const gains = computeWorldAmbientAudioGains(weather, windSpeedMps);
    if (windGainRef.current) windGainRef.current.gain.value = gains.wind;
    // Rain, snow, patter, and rumble are attenuated relative to the computed
    // gains so the composite never clips even when several beds play at once.
    if (rainGainRef.current) rainGainRef.current.gain.value = gains.rain * 0.55;
    if (snowGainRef.current) snowGainRef.current.gain.value = gains.snow * 0.4;
    if (patterGainRef.current) patterGainRef.current.gain.value = gains.rain * 0.18;
    if (rumbleGainRef.current) rumbleGainRef.current.gain.value = gains.rumble * 0.5;
    if (masterRef.current) masterRef.current.gain.value = suspended ? 0 : 1;
  };

  useLayoutEffect(() => {
    syncAudioGains();
  });
  useFrame(syncAudioGains);

  return null;
}
