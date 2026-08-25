/**
 * 创意媒体波形图组件，根据波形数据和时间窗口渲染 SVG 波形路径。
 *
 * @module creative-media-waveform
 */

import { useMemo } from "react";
import type { CreativeMediaWaveformData } from "../media/creativeMediaEngineering";

const WAVEFORM_VIEWBOX_WIDTH = 120;
const WAVEFORM_VIEWBOX_HEIGHT = 40;

/** 波形图的显示窗口，定义起始时间、持续时间和播放速率。 */
export interface CreativeMediaWaveformWindow {
  inSec: number;
  durationSec: number;
  playbackRate: number;
}

/**
 * 根据波形数据和窗口构建 SVG 路径字符串。
 * @param waveform - 波形数据，包含峰值数组和时长。
 * @param window - 显示窗口。
 * @param width - SVG 视口宽度，默认 120。
 * @param height - SVG 视口高度，默认 40。
 * @returns SVG 路径字符串，无效输入时返回空字符串。
 */
export function buildCreativeMediaWaveformPath(
  waveform: CreativeMediaWaveformData,
  window: CreativeMediaWaveformWindow,
  width = WAVEFORM_VIEWBOX_WIDTH,
  height = WAVEFORM_VIEWBOX_HEIGHT,
): string {
  const peakCount = Math.min(waveform.minPeaks.length, waveform.maxPeaks.length);
  if (
    !peakCount ||
    !Number.isFinite(waveform.durationSec) ||
    waveform.durationSec <= 0 ||
    !Number.isFinite(window.inSec) ||
    !Number.isFinite(window.durationSec) ||
    !Number.isFinite(window.playbackRate) ||
    window.durationSec <= 0 ||
    window.playbackRate <= 0 ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return "";
  }
  const startRatio = Math.max(0, Math.min(1, window.inSec / waveform.durationSec));
  const endRatio = Math.max(
    startRatio,
    Math.min(1, (window.inSec + window.durationSec * window.playbackRate) / waveform.durationSec),
  );
  const startIndex = Math.min(peakCount - 1, Math.floor(startRatio * peakCount));
  const endIndex = Math.max(startIndex + 1, Math.min(peakCount, Math.ceil(endRatio * peakCount)));
  // Duplicate a single source bucket across the clip width so very short
  // source ranges still have visible area instead of a zero-width polygon.
  const columnCount = Math.max(2, Math.min(Math.max(2, Math.round(width)), endIndex - startIndex || 2));
  const upper: string[] = [];
  const lower: string[] = [];
  const midpoint = height / 2;
  const amplitude = height * 0.46;

  for (let column = 0; column < columnCount; column += 1) {
    const bucketStart = startIndex + Math.floor((column * (endIndex - startIndex)) / columnCount);
    const bucketEnd = Math.max(
      bucketStart + 1,
      startIndex + Math.ceil(((column + 1) * (endIndex - startIndex)) / columnCount),
    );
    let minimum = 0;
    let maximum = 0;
    for (let index = bucketStart; index < Math.min(bucketEnd, peakCount); index += 1) {
      const left = waveform.minPeaks[index] ?? 0;
      const right = waveform.maxPeaks[index] ?? 0;
      minimum = Math.min(minimum, left, right);
      maximum = Math.max(maximum, left, right);
    }
    const x = columnCount === 1 ? 0 : (column / (columnCount - 1)) * width;
    upper.push(`${x.toFixed(2)},${(midpoint - maximum * amplitude).toFixed(2)}`);
    lower.push(`${x.toFixed(2)},${(midpoint - minimum * amplitude).toFixed(2)}`);
  }
  return `M ${upper.join(" L ")} L ${lower.reverse().join(" L ")} Z`;
}

/**
 * 渲染一个 SVG 波形图，表示媒体在指定时间窗口内的音频振幅。
 * @param waveform - 波形数据。
 * @param window - 显示窗口。
 * @param label - 无障碍标签。
 */
export function CreativeMediaWaveform({
  waveform,
  window,
  label,
}: {
  waveform: CreativeMediaWaveformData;
  window: CreativeMediaWaveformWindow;
  label: string;
}) {
  const path = useMemo(() => buildCreativeMediaWaveformPath(waveform, window), [waveform, window]);
  if (!path) return null;
  return (
    <svg
      aria-label={label}
      className="creative-clip-waveform"
      preserveAspectRatio="none"
      role="img"
      viewBox={`0 0 ${WAVEFORM_VIEWBOX_WIDTH} ${WAVEFORM_VIEWBOX_HEIGHT}`}
    >
      <line x1="0" x2={WAVEFORM_VIEWBOX_WIDTH} y1={WAVEFORM_VIEWBOX_HEIGHT / 2} y2={WAVEFORM_VIEWBOX_HEIGHT / 2} />
      <path d={path} />
    </svg>
  );
}
