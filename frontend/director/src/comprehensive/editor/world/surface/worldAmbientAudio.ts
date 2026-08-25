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
import { useStageViewportAudioEnabled } from "../../audio/stageViewportAudio";
import type { LivingWorldFrameContext } from "../livingWorldContracts";
import { isWorldAmbientClockSuspended, useWorldClockStore } from "../worldClock";
import { computeClimateAmbientAudioGains, computeWorldAmbientAudioGains } from "./worldSurfaceResponse";

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

function createLoopSource(context: AudioContext, seed: number, durationSeconds: number): AudioBufferSourceNode {
  const length = Math.max(1, Math.floor(context.sampleRate * durationSeconds));
  const buffer = context.createBuffer(1, length, context.sampleRate);
  fillSeededUnitNoise(buffer.getChannelData(0), seed);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  return source;
}

/**
 * React component that drives a procedural ambient audio bed (wind rumble,
 * rain hiss, snow hush) from the shared Living World frame context.
 *
 * The graph is muted while the ambient clock is suspended or the Stage sound
 * toggle is off. Gains update every frame from the evaluated climate (see
 * {@link computeClimateAmbientAudioGains}): the rain bed fades in and out
 * with the evolving precipitation instead of stepping on the preset gate.
 * Static mode reproduces {@link computeWorldAmbientAudioGains} exactly.
 *
 * @param context - The Living World frame context (seed, climate, wind).
 * @returns null — this component renders nothing; it owns the Web Audio graph.
 */
export default function WorldAmbientAudio({ context }: { context: LivingWorldFrameContext }) {
  const seed = context.seed;
  const audioEnabled = useStageViewportAudioEnabled();
  const suspended = useWorldClockStore((state) => state.suspended);
  const masterRef = useRef<GainNode | null>(null);
  const windGainRef = useRef<GainNode | null>(null);
  const rainGainRef = useRef<GainNode | null>(null);
  const snowGainRef = useRef<GainNode | null>(null);

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

    const windSource = createLoopSource(context, seed, 2.5);
    const rainSource = createLoopSource(context, seed ^ 0x9e3779b9, 1.75);
    const snowSource = createLoopSource(context, seed + 0x85ebca6b, 3.1);

    windSource.connect(windFilter).connect(windGain).connect(master);
    rainSource.connect(rainFilter).connect(rainGain).connect(master);
    snowSource.connect(snowFilter).connect(snowGain).connect(master);

    windSource.start(0);
    rainSource.start(0);
    snowSource.start(0);

    masterRef.current = master;
    windGainRef.current = windGain;
    rainGainRef.current = rainGain;
    snowGainRef.current = snowGain;

    void context.resume();

    return () => {
      windSource.stop();
      rainSource.stop();
      snowSource.stop();
      windSource.disconnect();
      rainSource.disconnect();
      snowSource.disconnect();
      master.disconnect();
      masterRef.current = null;
      windGainRef.current = null;
      rainGainRef.current = null;
      snowGainRef.current = null;
      void context.close();
    };
  }, [audioEnabled, seed]);

  const syncAudioGains = () => {
    const windSpeedMps = Math.hypot(context.windVector[0], context.windVector[2]);
    const climate = context.climate;
    const gains = climate.evolving
      ? computeClimateAmbientAudioGains(climate, windSpeedMps)
      : computeWorldAmbientAudioGains(climate.weather, windSpeedMps);
    if (windGainRef.current) windGainRef.current.gain.value = gains.wind;
    // Rain and snow are attenuated relative to the computed gains so the
    // composite never clips even when multiple presets contribute at once.
    if (rainGainRef.current) rainGainRef.current.gain.value = gains.rain * 0.55;
    if (snowGainRef.current) snowGainRef.current.gain.value = gains.snow * 0.4;
    if (masterRef.current) masterRef.current.gain.value = suspended ? 0 : 1;
  };

  useLayoutEffect(() => {
    syncAudioGains();
  });
  useFrame(syncAudioGains);

  return null;
}
