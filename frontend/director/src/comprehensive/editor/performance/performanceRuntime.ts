import { useSyncExternalStore } from "react";
import { z } from "zod";
import {
  detectPerformanceCapabilities,
  getPerformanceProfileConfig,
  normalizePerformanceProfileId,
  resolveAutomaticPerformanceProfile,
  type EffectivePerformanceProfileId,
  type PerformanceProfileConfig,
  type PerformanceProfileId,
} from "./performanceProfiles";

/** localStorage key for the selected performance profile. */
export const PERFORMANCE_PROFILE_STORAGE_KEY = "director.performance.profile";
/** localStorage key for per-config overrides. */
export const PERFORMANCE_OVERRIDES_STORAGE_KEY = "director.performance.overrides";

const performanceConfigOverridesSchema = z
  .object({
    mainDpr: z.number().min(0.5).max(4).optional(),
    quadDpr: z.number().min(0.5).max(4).optional(),
    gizmoDpr: z.number().min(0.5).max(4).optional(),
    previewDpr: z.number().min(0.5).max(4).optional(),
    shadowsEnabled: z.boolean().optional(),
    shadowMapSize: z.union([z.literal(512), z.literal(1024), z.literal(2048), z.literal(4096)]).optional(),
    characterAnimationSampling: z.enum(["adaptive", "full"]).optional(),
    characterLabelBudget: z.number().int().min(1).max(500).nullable().optional(),
  })
  .strict();

/** Zod-validated overrides for individual performance config knobs. */
export type PerformanceConfigOverrides = z.infer<typeof performanceConfigOverridesSchema>;
/** Valid keys for per-config overrides. */
export type PerformanceConfigOverrideKey = keyof PerformanceConfigOverrides;

/** Metrics reported by the Three.js renderer info object. */
export interface PerformanceRendererMetrics {
  /** Number of draw calls. */
  calls: number;
  /** Number of geometries. */
  geometries: number;
  /** Current pixel ratio. */
  pixelRatio: number;
  /** Number of textures. */
  textures: number;
  /** Number of rendered triangles. */
  triangles: number;
  /** Viewport height in pixels. */
  viewportHeight: number;
  /** Viewport width in pixels. */
  viewportWidth: number;
}

/** Complete runtime snapshot consumed by the performance panel and adaptive controller. */
export interface PerformanceRuntimeSnapshot {
  /** Recent average FPS, or null before the first sample. */
  averageFps: number | null;
  /** The currently effective profile id. */
  effectiveProfileId: EffectivePerformanceProfileId;
  /** Fraction of frames taking longer than 33ms. */
  longFrameRatio: number | null;
  /** 95th percentile frame time in ms. */
  p95FrameMs: number | null;
  /** Last renderer metrics snapshot. */
  renderer: PerformanceRendererMetrics | null;
  /** The user's selected profile id. */
  selectedProfileId: PerformanceProfileId;
  /** Timestamp of the last sample, or null. */
  sampledAt: number | null;
  /** Active config overrides. */
  configOverrides: PerformanceConfigOverrides;
  /** The resolved config after applying overrides. */
  resolvedConfig: PerformanceProfileConfig;
}

function readStoredPerformanceProfile(): PerformanceProfileId {
  if (typeof window === "undefined") return "auto";
  try {
    return normalizePerformanceProfileId(window.localStorage.getItem(PERFORMANCE_PROFILE_STORAGE_KEY));
  } catch {
    return "auto";
  }
}

function readStoredPerformanceConfigOverrides(): PerformanceConfigOverrides {
  if (typeof window === "undefined") return {};
  try {
    const stored = window.localStorage.getItem(PERFORMANCE_OVERRIDES_STORAGE_KEY);
    if (!stored) return {};
    const parsed = performanceConfigOverridesSchema.safeParse(JSON.parse(stored));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/**
 * Merges a performance profile config with user overrides.
 *
 * @param profileId - The effective profile id.
 * @param overrides - User-specified overrides.
 * @returns The resolved config.
 */
export function resolvePerformanceConfig(
  profileId: EffectivePerformanceProfileId,
  overrides: PerformanceConfigOverrides,
): PerformanceProfileConfig {
  return { ...getPerformanceProfileConfig(profileId), ...overrides };
}

function persistPerformanceConfigOverrides(overrides: PerformanceConfigOverrides) {
  try {
    if (Object.keys(overrides).length === 0) window.localStorage.removeItem(PERFORMANCE_OVERRIDES_STORAGE_KEY);
    else window.localStorage.setItem(PERFORMANCE_OVERRIDES_STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    // Private or embedded contexts can deny storage. The session preference still works.
  }
}

const initialSelectedProfile = readStoredPerformanceProfile();
const initialEffectiveProfile =
  initialSelectedProfile === "auto"
    ? resolveAutomaticPerformanceProfile(detectPerformanceCapabilities())
    : initialSelectedProfile;
const initialConfigOverrides = readStoredPerformanceConfigOverrides();

let snapshot: PerformanceRuntimeSnapshot = {
  averageFps: null,
  effectiveProfileId: initialEffectiveProfile,
  longFrameRatio: null,
  p95FrameMs: null,
  renderer: null,
  selectedProfileId: initialSelectedProfile,
  sampledAt: null,
  configOverrides: initialConfigOverrides,
  resolvedConfig: resolvePerformanceConfig(initialEffectiveProfile, initialConfigOverrides),
};
const listeners = new Set<() => void>();

function publish(next: PerformanceRuntimeSnapshot) {
  snapshot = next;
  listeners.forEach((listener) => listener());
}

/** Returns the current performance runtime snapshot. */
export function getPerformanceRuntimeSnapshot() {
  return snapshot;
}

/** Subscribes to performance runtime snapshot changes. */
export function subscribePerformanceRuntime(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React hook that re-renders on every performance runtime change. */
export function usePerformanceRuntimeSnapshot() {
  return useSyncExternalStore(
    subscribePerformanceRuntime,
    getPerformanceRuntimeSnapshot,
    getPerformanceRuntimeSnapshot,
  );
}

/** Narrow subscriptions keep high-frequency renderer samples out of the main 3D workspace tree. */
export function useSelectedPerformanceProfile() {
  return useSyncExternalStore(
    subscribePerformanceRuntime,
    () => snapshot.selectedProfileId,
    () => snapshot.selectedProfileId,
  );
}

/** Stable narrow subscription: frame samples do not re-render the Stage unless a quality control changes. */
export function useResolvedPerformanceConfig() {
  return useSyncExternalStore(
    subscribePerformanceRuntime,
    () => snapshot.resolvedConfig,
    () => snapshot.resolvedConfig,
  );
}

/**
 * Sets a single override on the performance config.
 *
 * @param key - The override key.
 * @param value - The override value.
 */
export function setPerformanceConfigOverride<Key extends PerformanceConfigOverrideKey>(
  key: Key,
  value: PerformanceConfigOverrides[Key],
) {
  const candidate = { ...snapshot.configOverrides, [key]: value };
  const parsed = performanceConfigOverridesSchema.safeParse(candidate);
  if (!parsed.success) return;
  persistPerformanceConfigOverrides(parsed.data);
  publish({
    ...snapshot,
    configOverrides: parsed.data,
    resolvedConfig: resolvePerformanceConfig(snapshot.effectiveProfileId, parsed.data),
  });
}

/** Resets all performance config overrides to their defaults. */
export function resetPerformanceConfigOverrides() {
  persistPerformanceConfigOverrides({});
  publish({
    ...snapshot,
    configOverrides: {},
    resolvedConfig: resolvePerformanceConfig(snapshot.effectiveProfileId, {}),
  });
}

/**
 * Sets the user's selected performance profile and persists it.
 *
 * Resets all runtime samples because the effective config has changed.
 *
 * @param profile - The selected profile id.
 */
export function setSelectedPerformanceProfile(profile: PerformanceProfileId) {
  const normalized = normalizePerformanceProfileId(profile);
  const effectiveProfileId =
    normalized === "auto" ? resolveAutomaticPerformanceProfile(detectPerformanceCapabilities()) : normalized;
  try {
    window.localStorage.setItem(PERFORMANCE_PROFILE_STORAGE_KEY, normalized);
  } catch {
    // Private or embedded contexts can deny storage. The session preference still works.
  }
  publish({
    ...snapshot,
    averageFps: null,
    effectiveProfileId,
    longFrameRatio: null,
    p95FrameMs: null,
    renderer: null,
    sampledAt: null,
    selectedProfileId: normalized,
    resolvedConfig: resolvePerformanceConfig(effectiveProfileId, snapshot.configOverrides),
  });
}

/**
 * Publishes a new performance sample from the adaptive controller.
 *
 * @param input - The sample data including FPS, frame ratios, and renderer metrics.
 */
export function publishPerformanceSample(input: {
  averageFps: number;
  effectiveProfileId: EffectivePerformanceProfileId;
  longFrameRatio: number;
  p95FrameMs: number;
  renderer: PerformanceRendererMetrics;
}) {
  const resolvedConfig =
    input.effectiveProfileId === snapshot.effectiveProfileId
      ? snapshot.resolvedConfig
      : resolvePerformanceConfig(input.effectiveProfileId, snapshot.configOverrides);
  publish({
    ...snapshot,
    averageFps: input.averageFps,
    effectiveProfileId: input.effectiveProfileId,
    longFrameRatio: input.longFrameRatio,
    p95FrameMs: input.p95FrameMs,
    renderer: input.renderer,
    sampledAt: Date.now(),
    resolvedConfig,
  });
}

/**
 * Resets the automatic performance profile to a new effective id.
 *
 * @param effectiveProfileId - The new effective profile id.
 */
export function resetAutomaticPerformanceProfile(effectiveProfileId: EffectivePerformanceProfileId) {
  publish({
    ...snapshot,
    averageFps: null,
    effectiveProfileId,
    longFrameRatio: null,
    p95FrameMs: null,
    renderer: null,
    sampledAt: null,
    resolvedConfig: resolvePerformanceConfig(effectiveProfileId, snapshot.configOverrides),
  });
}

function detectBrowserLabel(userAgent: string) {
  const match = userAgent.match(/Edg\/(\d+)|Chrome\/(\d+)|Firefox\/(\d+)|Version\/(\d+).+Safari\//);
  if (!match) return "unknown";
  if (match[1]) return `Edge ${match[1]}`;
  if (match[2]) return `Chrome ${match[2]}`;
  if (match[3]) return `Firefox ${match[3]}`;
  return `Safari ${match[4]}`;
}

/**
 * Creates an anonymous performance report for diagnostics.
 *
 * Contains no personal data — only profile, frame metrics, renderer stats,
 * and system capabilities.
 *
 * @param current - The snapshot to report; defaults to the current snapshot.
 * @returns A structured JSON-serializable report.
 */
export function createAnonymousPerformanceReport(current = snapshot) {
  const capabilities = detectPerformanceCapabilities();
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    performance: {
      selectedProfile: current.selectedProfileId,
      effectiveProfile: current.effectiveProfileId,
      averageFps: current.averageFps === null ? null : Number(current.averageFps.toFixed(1)),
      p95FrameMs: current.p95FrameMs === null ? null : Number(current.p95FrameMs.toFixed(2)),
      longFrameRatio: current.longFrameRatio === null ? null : Number(current.longFrameRatio.toFixed(4)),
      overrides: current.configOverrides,
      resolved: {
        mainDpr: current.resolvedConfig.mainDpr,
        quadDpr: current.resolvedConfig.quadDpr,
        gizmoDpr: current.resolvedConfig.gizmoDpr,
        previewDpr: current.resolvedConfig.previewDpr,
        shadowsEnabled: current.resolvedConfig.shadowsEnabled,
        shadowMapSize: current.resolvedConfig.shadowMapSize,
        characterAnimationSampling: current.resolvedConfig.characterAnimationSampling,
        characterLabelBudget: current.resolvedConfig.characterLabelBudget,
      },
    },
    renderer: current.renderer,
    system: {
      browser: typeof navigator === "undefined" ? "unknown" : detectBrowserLabel(navigator.userAgent),
      deviceMemoryGb: capabilities.deviceMemoryGb ?? null,
      devicePixelRatio: capabilities.devicePixelRatio,
      hardwareConcurrency: capabilities.hardwareConcurrency,
      platform: typeof navigator === "undefined" ? "unknown" : navigator.platform || "unknown",
    },
  };
}

/** Triggers a browser download of the anonymous performance report as JSON. */
export function downloadAnonymousPerformanceReport() {
  const blob = new Blob([`${JSON.stringify(createAnonymousPerformanceReport(), null, 2)}\n`], {
    type: "application/json",
  });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = "director-performance-report.json";
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
}
