import { describe, expect, it, vi } from "vitest";
import type { CreativeMediaAsset } from "../../../../src/comprehensive/editor/media/persistentCreativeMediaStore";
import {
  generateCreativeMediaWaveform,
  isCreativeMediaWaveformData,
  probeCreativeMediaAvailability,
  scoreCreativeMediaRelinkCandidate,
  selectCreativeMediaPlaybackSource,
} from "../../../../src/comprehensive/editor/media/creativeMediaEngineering";

function mediaAsset(overrides: Partial<CreativeMediaAsset> = {}): CreativeMediaAsset {
  return {
    id: "creative-media:video:original",
    kind: "video",
    name: "Original",
    fileName: "original.mp4",
    mimeType: "video/mp4",
    size: 80 * 1024 * 1024,
    createdAt: "2026-07-31T08:00:00.000Z",
    lastModified: null,
    durationSec: 10,
    width: 3840,
    height: 2160,
    source: "test",
    waveform: null,
    proxyOf: null,
    proxyProfile: null,
    objectUrl: "blob:original",
    ...overrides,
  };
}

function proxyAsset(id: string, originalId: string, width: number, overrides: Partial<CreativeMediaAsset> = {}) {
  return mediaAsset({
    id,
    name: `${width} proxy`,
    fileName: `${width}.mp4`,
    size: width * 1_000,
    width,
    height: Math.round((width * 9) / 16),
    proxyOf: originalId,
    proxyProfile: {
      label: `${width} proxy`,
      width,
      height: Math.round((width * 9) / 16),
      videoBitrateKbps: null,
      audioBitrateKbps: null,
      codec: "video/mp4",
      createdAt: "2026-07-31T08:00:00.000Z",
    },
    objectUrl: `blob:${id}`,
    ...overrides,
  });
}

describe("creative media waveform engineering", () => {
  it("reduces every decoded channel into deterministic cached min/max peaks and closes the decoder", async () => {
    const left = Float32Array.from({ length: 64 }, (_, index) => (index % 4 === 0 ? -0.8 : 0.25));
    const right = Float32Array.from({ length: 64 }, (_, index) => (index % 4 === 1 ? 0.9 : -0.1));
    const close = vi.fn().mockResolvedValue(undefined);
    const decodeAudioData = vi.fn().mockResolvedValue({
      duration: 2,
      sampleRate: 32,
      numberOfChannels: 2,
      length: 64,
      getChannelData: (channel: number) => [left, right][channel],
    });

    const waveform = await generateCreativeMediaWaveform(new Blob(["audio"]), {
      peakCount: 32,
      audioContextFactory: () => ({ decodeAudioData, close }),
    });

    expect(decodeAudioData).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(waveform).toMatchObject({
      version: 1,
      durationSec: 2,
      sampleRate: 32,
      channelCount: 2,
      samplesPerPeak: 2,
    });
    expect(waveform?.minPeaks).toHaveLength(32);
    expect(waveform?.maxPeaks).toHaveLength(32);
    expect(waveform?.minPeaks[0]).toBe(-0.8);
    expect(waveform?.maxPeaks[0]).toBe(0.9);
    expect(isCreativeMediaWaveformData(waveform)).toBe(true);
  });

  it("closes the decoder and returns null for unsupported streams", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const waveform = await generateCreativeMediaWaveform(new Blob(["not-decodable"]), {
      audioContextFactory: () => ({
        decodeAudioData: vi.fn().mockRejectedValue(new DOMException("unsupported", "EncodingError")),
        close,
      }),
    });

    expect(waveform).toBeNull();
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects malformed persisted waveform envelopes", () => {
    expect(
      isCreativeMediaWaveformData({
        version: 1,
        durationSec: 1,
        sampleRate: 48_000,
        channelCount: 1,
        samplesPerPeak: 0,
        minPeaks: [0.5],
        maxPeaks: [-0.5],
      }),
    ).toBe(false);
  });
});

describe("creative media proxy selection", () => {
  it("chooses the largest compatible proxy that fits the preview policy", () => {
    const original = mediaAsset();
    const proxies = [
      proxyAsset("proxy-640", original.id, 640),
      proxyAsset("proxy-1280", original.id, 1280),
      proxyAsset("proxy-1920", original.id, 1920),
      proxyAsset("wrong-original", "somewhere-else", 960),
      proxyAsset("wrong-kind", original.id, 720, { kind: "audio" }),
    ];

    expect(selectCreativeMediaPlaybackSource(original, proxies, { maxWidth: 1280 })).toMatchObject({
      variant: "proxy",
      assetId: "proxy-1280",
      proxyAssetId: "proxy-1280",
      reason: "proxy-fits-preview",
    });
    expect(
      selectCreativeMediaPlaybackSource(original, proxies, {
        maxWidth: 700,
        saveData: true,
      }),
    ).toMatchObject({ variant: "proxy", assetId: "proxy-640", reason: "proxy-for-data-saver" });
    expect(selectCreativeMediaPlaybackSource(original, proxies, { preference: "proxy" })).toMatchObject({
      variant: "proxy",
      assetId: "proxy-1920",
      reason: "proxy-requested",
    });
  });

  it("falls back to an online proxy when the original is offline", () => {
    const original = mediaAsset({ objectUrl: null });
    const proxy = proxyAsset("proxy-only", original.id, 1280);

    expect(selectCreativeMediaPlaybackSource(original, [proxy], { preference: "original" })).toMatchObject({
      variant: "proxy",
      assetId: proxy.id,
      reason: "proxy-only-source",
    });
    expect(selectCreativeMediaPlaybackSource(original, [], { preference: "proxy" })).toMatchObject({
      variant: "unavailable",
      assetId: null,
      reason: "source-unavailable",
    });
  });
});

describe("creative media availability and relink scoring", () => {
  it("probes HEAD and falls back to a ranged GET when HEAD is unsupported", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 405 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 206 }));

    await expect(
      probeCreativeMediaAvailability("https://media.example.test/take.mp4", {
        fetcher: fetcher as typeof fetch,
      }),
    ).resolves.toBe("online");
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "https://media.example.test/take.mp4",
      expect.objectContaining({ method: "HEAD", signal: expect.any(AbortSignal) }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "https://media.example.test/take.mp4",
      expect.objectContaining({ method: "GET", headers: { Range: "bytes=0-0" } }),
    );
  });

  it("classifies intrinsic, missing, unsupported, and failed sources honestly", async () => {
    const blobFetcher = vi.fn();
    await expect(probeCreativeMediaAvailability("data:audio/wav;base64,AA==")).resolves.toBe("online");
    await expect(
      probeCreativeMediaAvailability("blob:http://localhost/director-capture", {
        fetcher: blobFetcher as typeof fetch,
      }),
    ).resolves.toBe("online");
    expect(blobFetcher).not.toHaveBeenCalled();
    await expect(probeCreativeMediaAvailability("   ")).resolves.toBe("offline");
    await expect(probeCreativeMediaAvailability("file:///outside-project/take.mp4")).resolves.toBe("unverified");
    await expect(
      probeCreativeMediaAvailability("https://media.example.test/missing.mp4", {
        fetcher: vi.fn().mockRejectedValue(new TypeError("network error")) as typeof fetch,
      }),
    ).resolves.toBe("offline");
  });

  it("ranks compatible replacements by normalized name, duration, and dimensions", () => {
    expect(
      scoreCreativeMediaRelinkCandidate(
        { name: "Scene 07 OFFLINE.mov", kind: "video", durationSec: 10, width: 1920, height: 1080 },
        { name: "scene-07.mp4", kind: "video", durationSec: 10.02, width: 1920, height: 1080 },
      ),
    ).toEqual({
      compatible: true,
      score: 1,
      reasons: ["media-kind-match", "file-name-match", "duration-match", "dimensions-match"],
    });
    expect(
      scoreCreativeMediaRelinkCandidate(
        { name: "Scene 07.mov", kind: "video" },
        { name: "Scene 07.wav", kind: "audio" },
      ),
    ).toEqual({ compatible: false, score: 0, reasons: ["media-kind-mismatch"] });
  });
});
