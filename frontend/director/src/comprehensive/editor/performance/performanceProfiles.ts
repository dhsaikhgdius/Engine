/** User-facing profile id; "auto" delegates to adaptive detection. */
export type PerformanceProfileId = "auto" | "fluid" | "balanced" | "quality";
/** Concrete profile id after "auto" resolution. */
export type EffectivePerformanceProfileId = "fluid" | "balanced" | "quality";
/** Device-pixel ratio: a single number or a [min, max] range. */
export type RenderDpr = number | [number, number];
/** How character animation poses are sampled across frames. */
export type CharacterAnimationSampling = "adaptive" | "full";

/** Highest quality tier. */
export const DIRECTOR_MAX_QUALITY_PROFILE_ID = "quality" as const;
/** Use native high-density output and supersample standard-density displays. */
export const DIRECTOR_MAX_QUALITY_DPR: RenderDpr = [2, 4];

/** Ordered from cheapest to most expensive render budget. */
export const PERFORMANCE_PROFILE_LADDER: readonly EffectivePerformanceProfileId[] = ["fluid", "balanced", "quality"];

/**
 * Compares two performance profiles by their position in the ladder.
 *
 * @param left - First profile.
 * @param right - Second profile.
 * @returns Negative if left is cheaper, positive if right is cheaper, zero if equal.
 */
export function comparePerformanceProfiles(left: EffectivePerformanceProfileId, right: EffectivePerformanceProfileId) {
  return PERFORMANCE_PROFILE_LADDER.indexOf(left) - PERFORMANCE_PROFILE_LADDER.indexOf(right);
}

/** Device capabilities detected at startup for adaptive profile resolution. */
export interface PerformanceCapabilities {
  /** Available device memory in GB, or null when unavailable (Safari/Firefox). */
  deviceMemoryGb?: number | null;
  /** Current device pixel ratio. */
  devicePixelRatio: number;
  /** Number of logical processor cores. */
  hardwareConcurrency: number;
}

/** Concrete render budget configuration for one performance tier. */
export interface PerformanceProfileConfig {
  /** The profile id. */
  id: EffectivePerformanceProfileId;
  /** Human-readable label. */
  label: string;
  /** Human-readable description. */
  description: string;
  /** DPR for the main 3D viewport. */
  mainDpr: RenderDpr;
  /** DPR for the quad-view inset panels. */
  quadDpr: RenderDpr;
  /** DPR for gizmo overlays. */
  gizmoDpr: RenderDpr;
  /** DPR for camera preview insets. */
  previewDpr: RenderDpr;
  /** Whether shadow maps are enabled. */
  shadowsEnabled: boolean;
  /** Shadow map texture size. */
  shadowMapSize: 512 | 1024 | 2048 | 4096;
  /** Character animation sampling strategy. */
  characterAnimationSampling: CharacterAnimationSampling;
  /** Maximum number of character labels visible at once, or null for unlimited. */
  characterLabelBudget: number | null;
}

/** User-facing profile options for the settings UI. */
export const PERFORMANCE_PROFILE_OPTIONS = performanceProfiles.options as Array<{
  id: PerformanceProfileId;
  label: string;
  description: string;
}>;
/** Concrete configs keyed by effective profile id. */
export const PERFORMANCE_PROFILE_CONFIGS = performanceProfiles.configs as Record<
  EffectivePerformanceProfileId,
  PerformanceProfileConfig
>;

/**
 * Normalizes a user-facing profile id to a valid value.
 *
 * @param value - The raw value, possibly from localStorage.
 * @returns A valid PerformanceProfileId, defaulting to "auto".
 */
export function normalizePerformanceProfileId(value: unknown): PerformanceProfileId {
  return value === "auto" || value === "fluid" || value === "balanced" || value === "quality" ? value : "auto";
}

/**
 * Detects the device's hardware capabilities.
 *
 * @returns A capabilities snapshot with memory, DPR, and core count.
 */
export function detectPerformanceCapabilities(): PerformanceCapabilities {
  if (typeof navigator === "undefined" || typeof window === "undefined") {
    return { deviceMemoryGb: null, devicePixelRatio: 1, hardwareConcurrency: 4 };
  }

  const extendedNavigator = navigator as Navigator & { deviceMemory?: number };
  return {
    deviceMemoryGb: Number.isFinite(extendedNavigator.deviceMemory) ? (extendedNavigator.deviceMemory ?? null) : null,
    devicePixelRatio: Math.max(1, window.devicePixelRatio || 1),
    hardwareConcurrency: Math.max(1, navigator.hardwareConcurrency || 4),
  };
}

/**
 * Static capability check used before any frame samples exist. The adaptive
 * controller then refines the choice with measured frame times.
 */
export function resolveAutomaticPerformanceProfile(
  capabilities: PerformanceCapabilities,
): EffectivePerformanceProfileId {
  const memoryGb = capabilities.deviceMemoryGb;
  const cores = capabilities.hardwareConcurrency;
  if ((memoryGb != null && memoryGb <= 4) || cores <= 4) return "fluid";
  // deviceMemory is unavailable on Safari/Firefox; a high core count alone is
  // enough evidence for the top budget because adaptive sampling can still
  // downgrade after the first measured windows.
  if ((memoryGb == null || memoryGb >= 8) && cores >= 8) return DIRECTOR_MAX_QUALITY_PROFILE_ID;
  return "balanced";
}

/**
 * Resolves the config for a given effective profile id.
 *
 * @param id - The effective profile id.
 * @returns The corresponding config.
 */
export function getPerformanceProfileConfig(id: EffectivePerformanceProfileId) {
  return PERFORMANCE_PROFILE_CONFIGS[id];
}

/**
 * Resolves a RenderDpr (single number or range) to a concrete value.
 *
 * @param dpr - The dpr config.
 * @param devicePixelRatio - The device's actual pixel ratio.
 * @returns The resolved dpr clamped to the [min, max] range.
 */
export function resolveRenderDpr(dpr: RenderDpr, devicePixelRatio: number) {
  if (!Array.isArray(dpr)) return dpr;
  return Math.min(dpr[1], Math.max(dpr[0], devicePixelRatio));
}

/** Summary statistics computed from a window of frame interval samples. */
export interface AdaptiveFrameSummary {
  /** Average frames per second over the window. */
  averageFps: number;
  /** Estimated display refresh rate derived from the p10 interval. */
  estimatedRefreshFps: number;
  /** Fraction of frames exceeding 33ms (slower than 30fps). */
  longFrameRatio: number;
  /** 95th percentile frame time in milliseconds. */
  p95FrameMs: number;
}

/**
 * Computes summary statistics from raw frame interval samples.
 *
 * @param frameIntervalsMs - Array of per-frame durations in milliseconds.
 * @returns Aggregated statistics for adaptive profile decisions.
 */
export function summarizeFrameIntervals(frameIntervalsMs: number[]): AdaptiveFrameSummary {
  const samples = frameIntervalsMs.filter((value) => Number.isFinite(value) && value > 0 && value < 1_000);
  if (!samples.length) {
    return { averageFps: 0, estimatedRefreshFps: 60, longFrameRatio: 0, p95FrameMs: 0 };
  }

  const sorted = [...samples].sort((left, right) => left - right);
  const total = samples.reduce((sum, value) => sum + value, 0);
  const p95Index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1));
  const p10Index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.1) - 1));
  return {
    averageFps: 1_000 / (total / samples.length),
    estimatedRefreshFps: Math.min(60, 1_000 / (sorted[p10Index] ?? 1_000 / 60)),
    longFrameRatio: samples.filter((value) => value > 1_000 / 30).length / samples.length,
    p95FrameMs: sorted[p95Index] ?? 0,
  };
}

/**
 * Steps one rung down when the measured window is clearly struggling and one
 * rung up only when it is comfortably healthy, so the ladder cannot oscillate
 * on borderline scenes. The caller adds cooldowns and window hysteresis.
 */
export function recommendAdaptivePerformanceProfile(
  current: EffectivePerformanceProfileId,
  summary: AdaptiveFrameSummary,
): EffectivePerformanceProfileId {
  if (summary.averageFps <= 0) return current;
  const targetFps = Math.min(60, Math.max(30, summary.estimatedRefreshFps));
  const struggling = summary.averageFps < targetFps * 0.75 || summary.longFrameRatio > 0.2;
  const comfortable =
    summary.averageFps >= targetFps * 0.92 && summary.longFrameRatio <= 0.05 && summary.p95FrameMs <= 24;
  const index = PERFORMANCE_PROFILE_LADDER.indexOf(current);
  if (struggling) return PERFORMANCE_PROFILE_LADDER[Math.max(0, index - 1)] ?? current;
  if (comfortable)
    return PERFORMANCE_PROFILE_LADDER[Math.min(PERFORMANCE_PROFILE_LADDER.length - 1, index + 1)] ?? current;
  return current;
}
import performanceProfiles from "./performanceProfiles.json";
