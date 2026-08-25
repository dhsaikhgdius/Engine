import { z } from "zod";
import type { CreativeMediaAsset, CreativeMediaKind } from "./persistentCreativeMediaStore";
import { clamp } from "../../../../../../packages/protocol/src/primitives";

/** Schema version for the waveform data format. */
export const CREATIVE_MEDIA_WAVEFORM_VERSION = 1;
/** Default number of peak pairs when no explicit count is requested. */
export const DEFAULT_CREATIVE_MEDIA_WAVEFORM_PEAKS = 768;

/** Zod raw shape defining the waveform data structure shared by schema and refinements. */
export const creativeMediaWaveformDataFields = {
  version: z.literal(CREATIVE_MEDIA_WAVEFORM_VERSION),
  durationSec: z.number().finite().positive(),
  sampleRate: z.number().finite().positive(),
  channelCount: z.number().int().positive(),
  samplesPerPeak: z.number().int().positive(),
  minPeaks: z.array(z.number().finite().min(-1).max(1)).min(1),
  maxPeaks: z.array(z.number().finite().min(-1).max(1)).min(1),
} satisfies z.ZodRawShape;

/** Full waveform data schema with cross-field validation of peak arrays. */
export const creativeMediaWaveformDataSchema = z
  .object(creativeMediaWaveformDataFields)
  .refine(
    ({ minPeaks, maxPeaks }) =>
      minPeaks.length === maxPeaks.length && minPeaks.every((minimum, index) => minimum <= maxPeaks[index]!),
    { message: "Waveform peak pairs must have equal lengths and ordered bounds" },
  );
/** Decoded and validated waveform data ready for display. */
export type CreativeMediaWaveformData = z.infer<typeof creativeMediaWaveformDataSchema>;

/** Type guard that checks whether an unknown value is valid waveform data. */
export function isCreativeMediaWaveformData(value: unknown): value is CreativeMediaWaveformData {
  return creativeMediaWaveformDataSchema.safeParse(value).success;
}

/** Zod schema for a proxy media profile attached to an original asset. */
export const creativeMediaProxyProfileSchema = z.object({
  label: z.string().min(1).max(160),
  width: z.number().int().positive().max(100_000).nullable(),
  height: z.number().int().positive().max(100_000).nullable(),
  videoBitrateKbps: z.number().finite().positive().max(10_000_000).nullable(),
  audioBitrateKbps: z.number().finite().positive().max(100_000).nullable(),
  codec: z.string().max(160).nullable(),
  createdAt: z.string().min(1).max(128),
});
/** Zod schema for the user's playback preference on a media asset. */
export const creativeMediaPlaybackPreferenceSchema = z.enum(["auto", "original", "proxy"]);
/** Decoded proxy profile metadata attached to an original media asset. */
export type CreativeMediaProxyProfile = z.infer<typeof creativeMediaProxyProfileSchema>;

/** Whether a source URL is verified reachable, confirmed offline, or has not yet been probed. */
export type CreativeMediaAvailability = "online" | "offline" | "unverified";
/** User preference controlling which source variant to play. */
export type CreativeMediaPlaybackPreference = z.infer<typeof creativeMediaPlaybackPreferenceSchema>;
/** Which variant the playback engine selected for a given source. */
export type CreativeMediaPlaybackVariant = "original" | "proxy" | "unavailable";

/** Policy inputs that influence the original-vs-proxy selection. */
export interface CreativeMediaPlaybackPolicy {
  /** Explicit user preference; "auto" lets the engine decide. */
  preference?: CreativeMediaPlaybackPreference;
  /** Maximum display width used to evaluate proxy-fit disqualification. */
  maxWidth?: number | null;
  /** Whether the browser has requested data-saver mode. */
  saveData?: boolean;
  /** Whether the playback engine should favor lighter proxies for smooth playback. */
  prioritizeFluidPlayback?: boolean;
}

/** The result of a playback source selection, including the reason for the choice. */
export interface CreativeMediaPlaybackSelection {
  /** Which variant was selected. */
  variant: CreativeMediaPlaybackVariant;
  /** The id of the asset chosen for playback, or null when unavailable. */
  assetId: string | null;
  /** The playable URL, or null when unavailable. */
  url: string | null;
  /** The proxy asset id when a proxy was selected, or null otherwise. */
  proxyAssetId: string | null;
  /** Machine-readable reason for the selection. */
  reason:
    | "original-requested"
    | "proxy-requested"
    | "proxy-for-data-saver"
    | "proxy-for-fluid-playback"
    | "proxy-fits-preview"
    | "proxy-only-source"
    | "original-default"
    | "source-unavailable";
}

interface AudioBufferLike {
  readonly duration: number;
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  readonly length: number;
  getChannelData(channel: number): Float32Array;
}

interface AudioContextLike {
  decodeAudioData(data: ArrayBuffer): Promise<AudioBufferLike>;
  close(): Promise<void>;
}

/** Options for waveform generation, including the peak count and audio context factory. */
export interface GenerateCreativeMediaWaveformOptions {
  /** Number of peak pairs to generate; clamped to [32, 4096]. */
  peakCount?: number;
  /** Factory for the AudioContext used to decode; defaults to the global constructor. */
  audioContextFactory?: () => AudioContextLike | null;
}

/** Options for probing whether a source URL is reachable. */
export interface ProbeCreativeMediaAvailabilityOptions {
  /** Custom fetch implementation; defaults to globalThis.fetch. */
  fetcher?: typeof fetch;
  /** Request timeout in ms; clamped to [250, 30000]. */
  timeoutMs?: number;
}

/** Minimal metadata needed to score a candidate for relinking. */
export interface CreativeMediaRelinkCandidate {
  /** Display name of the missing or candidate asset. */
  name: string;
  /** Media kind (image, video, audio). */
  kind: CreativeMediaKind;
  /** Duration in seconds, if known. */
  durationSec?: number | null;
  /** Width in pixels, if known. */
  width?: number | null;
  /** Height in pixels, if known. */
  height?: number | null;
}

/** Scored result of comparing a missing asset against a candidate for relinking. */
export interface CreativeMediaRelinkScore {
  /** Whether the candidate is compatible at all (same kind). */
  compatible: boolean;
  /** Score in [0, 1]; higher is a better match. */
  score: number;
  /** Human-readable reasons contributing to the score. */
  reasons: string[];
}

function defaultAudioContextFactory(): AudioContextLike | null {
  const runtime = globalThis as typeof globalThis & {
    AudioContext?: new () => AudioContextLike;
    webkitAudioContext?: new () => AudioContextLike;
  };
  const AudioContextConstructor = runtime.AudioContext ?? runtime.webkitAudioContext;
  return AudioContextConstructor ? new AudioContextConstructor() : null;
}

/**
 * Decodes browser-supported audio and reduces it to deterministic min/max
 * peaks. The compact result is safe to persist with media metadata and avoids
 * decoding the source again whenever the timeline is reopened.
 */
export async function generateCreativeMediaWaveform(
  blob: Blob,
  options: GenerateCreativeMediaWaveformOptions = {},
): Promise<CreativeMediaWaveformData | null> {
  const context = (options.audioContextFactory ?? defaultAudioContextFactory)();
  if (!context) return null;
  try {
    const buffer = await context.decodeAudioData(await blob.arrayBuffer());
    const frameCount = Math.max(0, buffer.length);
    const channelCount = Math.max(0, buffer.numberOfChannels);
    if (!frameCount || !channelCount || !Number.isFinite(buffer.duration) || buffer.duration <= 0) return null;
    const requestedPeaks = Math.round(options.peakCount ?? DEFAULT_CREATIVE_MEDIA_WAVEFORM_PEAKS);
    const peakCount = clamp(requestedPeaks, 32, 4096);
    const actualPeakCount = Math.min(frameCount, peakCount);
    const samplesPerPeak = Math.max(1, Math.ceil(frameCount / actualPeakCount));
    const minPeaks = new Array<number>(actualPeakCount);
    const maxPeaks = new Array<number>(actualPeakCount);
    const channels = Array.from({ length: channelCount }, (_, channel) => buffer.getChannelData(channel));

    for (let peakIndex = 0; peakIndex < actualPeakCount; peakIndex += 1) {
      const start = Math.floor((peakIndex * frameCount) / actualPeakCount);
      const end = Math.max(start + 1, Math.floor(((peakIndex + 1) * frameCount) / actualPeakCount));
      // Very long recordings stay responsive while retaining the envelope.
      const stride = Math.max(1, Math.ceil((end - start) / 256));
      let minimum = 0;
      let maximum = 0;
      for (const channel of channels) {
        for (let sampleIndex = start; sampleIndex < end; sampleIndex += stride) {
          const sample = channel[sampleIndex] ?? 0;
          if (sample < minimum) minimum = sample;
          if (sample > maximum) maximum = sample;
        }
      }
      minPeaks[peakIndex] = Number(clamp(minimum, -1, 1).toFixed(5));
      maxPeaks[peakIndex] = Number(clamp(maximum, -1, 1).toFixed(5));
    }

    return {
      version: CREATIVE_MEDIA_WAVEFORM_VERSION,
      durationSec: buffer.duration,
      sampleRate: buffer.sampleRate,
      channelCount,
      samplesPerPeak,
      minPeaks,
      maxPeaks,
    };
  } catch {
    // Some browsers cannot decode the audio stream inside every supported
    // video container. Metadata probing remains useful without a waveform.
    return null;
  } finally {
    await context.close().catch(() => undefined);
  }
}

function proxyWidth(asset: CreativeMediaAsset) {
  const width = asset.proxyProfile?.width ?? asset.width;
  return typeof width === "number" && Number.isFinite(width) && width > 0 ? width : Number.POSITIVE_INFINITY;
}

function chooseProxy(
  original: CreativeMediaAsset,
  proxies: readonly CreativeMediaAsset[],
  maximumWidth: number | null | undefined,
) {
  const online = proxies.filter(
    (proxy) =>
      proxy.id !== original.id &&
      proxy.kind === original.kind &&
      (!proxy.proxyOf || proxy.proxyOf === original.id) &&
      Boolean(proxy.objectUrl),
  );
  if (!online.length) return null;
  const sorted = [...online].sort(
    (left, right) =>
      proxyWidth(left) - proxyWidth(right) ||
      left.createdAt.localeCompare(right.createdAt) ||
      left.id.localeCompare(right.id),
  );
  if (!maximumWidth || maximumWidth <= 0) return sorted.at(-1) ?? null;
  return sorted.findLast((proxy) => proxyWidth(proxy) <= maximumWidth) ?? sorted[0] ?? null;
}

/**
 * Selects an original or attached proxy without hiding why that choice won.
 *
 * @param original - The original media asset.
 * @param proxies - All available proxy assets in the library.
 * @param policy - Playback policy influencing the selection.
 * @returns The selection result with the chosen variant, asset id, URL, and reason.
 */
export function selectCreativeMediaPlaybackSource(
  original: CreativeMediaAsset,
  proxies: readonly CreativeMediaAsset[],
  policy: CreativeMediaPlaybackPolicy = {},
): CreativeMediaPlaybackSelection {
  const preference = policy.preference ?? "auto";
  const proxy = chooseProxy(original, proxies, policy.maxWidth);
  const originalOnline = Boolean(original.objectUrl);
  if (preference === "original" && originalOnline) {
    return {
      variant: "original",
      assetId: original.id,
      url: original.objectUrl,
      proxyAssetId: proxy?.id ?? null,
      reason: "original-requested",
    };
  }
  if (preference === "proxy" && proxy) {
    return {
      variant: "proxy",
      assetId: proxy.id,
      url: proxy.objectUrl,
      proxyAssetId: proxy.id,
      reason: "proxy-requested",
    };
  }
  if (!originalOnline && proxy) {
    return {
      variant: "proxy",
      assetId: proxy.id,
      url: proxy.objectUrl,
      proxyAssetId: proxy.id,
      reason: "proxy-only-source",
    };
  }
  if (proxy && policy.saveData) {
    return {
      variant: "proxy",
      assetId: proxy.id,
      url: proxy.objectUrl,
      proxyAssetId: proxy.id,
      reason: "proxy-for-data-saver",
    };
  }
  if (proxy && policy.prioritizeFluidPlayback) {
    return {
      variant: "proxy",
      assetId: proxy.id,
      url: proxy.objectUrl,
      proxyAssetId: proxy.id,
      reason: "proxy-for-fluid-playback",
    };
  }
  if (
    proxy &&
    policy.maxWidth &&
    policy.maxWidth > 0 &&
    (original.width ?? Number.POSITIVE_INFINITY) > policy.maxWidth &&
    proxyWidth(proxy) <= policy.maxWidth
  ) {
    return {
      variant: "proxy",
      assetId: proxy.id,
      url: proxy.objectUrl,
      proxyAssetId: proxy.id,
      reason: "proxy-fits-preview",
    };
  }
  if (originalOnline) {
    return {
      variant: "original",
      assetId: original.id,
      url: original.objectUrl,
      proxyAssetId: proxy?.id ?? null,
      reason: "original-default",
    };
  }
  return {
    variant: "unavailable",
    assetId: null,
    url: null,
    proxyAssetId: proxy?.id ?? null,
    reason: "source-unavailable",
  };
}

function timeoutSignal(timeoutMs: number) {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, cancel: () => globalThis.clearTimeout(timeout) };
}

/**
 * Performs an explicit source check; callers decide when network probing is appropriate.
 *
 * @param sourceUrl - The URL to probe; null/empty/unsupported protocols return "offline" or "unverified".
 * @param options - Optional fetcher and timeout configuration.
 * @returns "online", "offline", or "unverified" based on the HEAD/range-GET result.
 */
export async function probeCreativeMediaAvailability(
  sourceUrl: string | null | undefined,
  options: ProbeCreativeMediaAvailabilityOptions = {},
): Promise<CreativeMediaAvailability> {
  if (!sourceUrl?.trim()) return "offline";
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl, typeof window === "undefined" ? "http://localhost/" : window.location.href);
  } catch {
    return "offline";
  }
  if (parsed.protocol === "data:" || parsed.protocol === "blob:") return "online";
  const fetcher = options.fetcher ?? globalThis.fetch;
  if (!fetcher || !new Set(["blob:", "http:", "https:"]).has(parsed.protocol)) return "unverified";
  const requestedTimeout = options.timeoutMs ?? 6_000;
  const timeoutMs = Number.isFinite(requestedTimeout) ? clamp(requestedTimeout, 250, 30_000) : 6_000;
  const timeout = timeoutSignal(timeoutMs);
  try {
    let response = await fetcher(parsed.href, { method: "HEAD", signal: timeout.signal });
    if (response.status === 405 || response.status === 501) {
      response = await fetcher(parsed.href, {
        method: "GET",
        headers: { Range: "bytes=0-0" },
        signal: timeout.signal,
      });
    }
    return response.ok ? "online" : "offline";
  } catch {
    return "offline";
  } finally {
    timeout.cancel();
  }
}

function normalizedStem(name: string) {
  return name
    .toLocaleLowerCase()
    .replace(/\.[a-z0-9]{1,10}$/i, "")
    .replace(/(?:proxy|offline|missing|代理|离线|缺失)/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * Scores a candidate for automatic relink suggestions without performing a mutation.
 *
 * @param missing - Metadata for the asset that needs relinking.
 * @param candidate - Metadata for a candidate that might replace it.
 * @returns A score and compatibility verdict with human-readable reasons.
 */
export function scoreCreativeMediaRelinkCandidate(
  missing: CreativeMediaRelinkCandidate,
  candidate: CreativeMediaRelinkCandidate,
): CreativeMediaRelinkScore {
  if (missing.kind !== candidate.kind) {
    return { compatible: false, score: 0, reasons: ["media-kind-mismatch"] };
  }
  let score = 0.25;
  const reasons = ["media-kind-match"];
  const leftName = normalizedStem(missing.name);
  const rightName = normalizedStem(candidate.name);
  if (leftName && rightName && leftName === rightName) {
    score += 0.45;
    reasons.push("file-name-match");
  } else if (leftName && rightName && (leftName.includes(rightName) || rightName.includes(leftName))) {
    score += 0.25;
    reasons.push("file-name-similar");
  }
  if (missing.durationSec && candidate.durationSec) {
    const difference = Math.abs(missing.durationSec - candidate.durationSec) / Math.max(missing.durationSec, 0.001);
    if (difference <= 0.01) {
      score += 0.2;
      reasons.push("duration-match");
    } else if (difference <= 0.05) {
      score += 0.1;
      reasons.push("duration-close");
    }
  }
  if (missing.width && missing.height && candidate.width && candidate.height) {
    if (missing.width === candidate.width && missing.height === candidate.height) {
      score += 0.1;
      reasons.push("dimensions-match");
    }
  }
  return { compatible: true, score: Number(Math.min(1, score).toFixed(3)), reasons };
}
