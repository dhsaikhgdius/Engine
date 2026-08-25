/**
 * @module AdaptivePerformanceController
 * @description Invisible R3F controller that samples frame intervals and
 *   automatically degrades or recovers the performance profile to keep the
 *   viewport responsive.
 */

import { useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useRef } from "react";
import {
  comparePerformanceProfiles,
  recommendAdaptivePerformanceProfile,
  summarizeFrameIntervals,
  type EffectivePerformanceProfileId,
} from "./performanceProfiles";
import { publishPerformanceSample } from "./performanceRuntime";

const SAMPLE_WINDOW_MS = 3_000;
const SWITCH_COOLDOWN_MS = 9_000;
const RECOVERY_WINDOW_COUNT = 3;

export function AdaptivePerformanceController({
  automatic,
  effectiveProfileId,
  onAutomaticProfileChange,
}: {
  automatic: boolean;
  effectiveProfileId: EffectivePerformanceProfileId;
  onAutomaticProfileChange: (profile: EffectivePerformanceProfileId) => void;
}) {
  const { gl, size } = useThree();
  const profileRef = useRef(effectiveProfileId);
  const frameIntervalsRef = useRef<number[]>([]);
  const sampleElapsedMsRef = useRef(0);
  const warmupRemainingMsRef = useRef(SAMPLE_WINDOW_MS);
  const lastSwitchAtMsRef = useRef(Number.NEGATIVE_INFINITY);
  const degradeWindowCountRef = useRef(0);
  const recoveryWindowCountRef = useRef(0);

  const resetSampleWindow = useCallback(() => {
    frameIntervalsRef.current = [];
    sampleElapsedMsRef.current = 0;
  }, []);

  useEffect(() => {
    profileRef.current = effectiveProfileId;
    warmupRemainingMsRef.current = SAMPLE_WINDOW_MS;
    degradeWindowCountRef.current = 0;
    recoveryWindowCountRef.current = 0;
    resetSampleWindow();
  }, [automatic, effectiveProfileId, resetSampleWindow]);

  useFrame((state, deltaSeconds) => {
    const frameMs = deltaSeconds * 1_000;
    if (typeof document !== "undefined" && document.hidden) return;
    if (!Number.isFinite(frameMs) || frameMs <= 0 || frameMs > 250) {
      resetSampleWindow();
      return;
    }

    if (warmupRemainingMsRef.current > 0) {
      warmupRemainingMsRef.current -= frameMs;
      return;
    }

    frameIntervalsRef.current.push(frameMs);
    sampleElapsedMsRef.current += frameMs;
    if (sampleElapsedMsRef.current < SAMPLE_WINDOW_MS) return;

    const summary = summarizeFrameIntervals(frameIntervalsRef.current);
    const current = profileRef.current;
    const recommended = automatic ? recommendAdaptivePerformanceProfile(current, summary) : current;
    const isRecovery = comparePerformanceProfiles(recommended, current) > 0;
    const isDegradation = comparePerformanceProfiles(recommended, current) < 0;
    degradeWindowCountRef.current = isDegradation ? degradeWindowCountRef.current + 1 : 0;
    recoveryWindowCountRef.current = isRecovery ? recoveryWindowCountRef.current + 1 : 0;

    const nowMs = state.clock.elapsedTime * 1_000;
    const canSwitch = nowMs - lastSwitchAtMsRef.current >= SWITCH_COOLDOWN_MS;
    const shouldSwitch = degradeWindowCountRef.current >= 2 || recoveryWindowCountRef.current >= RECOVERY_WINDOW_COUNT;
    let nextProfile = current;
    if (automatic && canSwitch && recommended !== current && shouldSwitch) {
      nextProfile = recommended;
      profileRef.current = nextProfile;
      lastSwitchAtMsRef.current = nowMs;
      warmupRemainingMsRef.current = SAMPLE_WINDOW_MS;
      degradeWindowCountRef.current = 0;
      recoveryWindowCountRef.current = 0;
      onAutomaticProfileChange(nextProfile);
    }

    const rendererInfo = gl.info;
    publishPerformanceSample({
      averageFps: summary.averageFps,
      effectiveProfileId: nextProfile,
      longFrameRatio: summary.longFrameRatio,
      p95FrameMs: summary.p95FrameMs,
      renderer: {
        calls: rendererInfo?.render?.calls ?? 0,
        geometries: rendererInfo?.memory?.geometries ?? 0,
        pixelRatio: typeof gl.getPixelRatio === "function" ? gl.getPixelRatio() : 1,
        textures: rendererInfo?.memory?.textures ?? 0,
        triangles: rendererInfo?.render?.triangles ?? 0,
        viewportHeight: size.height,
        viewportWidth: size.width,
      },
    });
    resetSampleWindow();
  });

  return null;
}
