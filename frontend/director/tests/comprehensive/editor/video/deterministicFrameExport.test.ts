import { describe, expect, it, vi } from "vitest";
import {
  exportDeterministicDirectorFrames,
  getDirectorDeterministicFramePlan,
  inspectDirectorPng,
  type DirectorDeterministicVideoMuxer,
  type DirectorMuxedVideoChunk,
  type DirectorWebCodecsRuntime,
} from "../../../../src/comprehensive/editor/video/deterministicFrameExport";
import { directorZipCrc32 } from "../../../../src/comprehensive/editor/video/deterministicZip";

// Golden values captured from the module as it existed before the transparent
// background option landed (frameStart 2, frameEnd 3, sourceFps 24, synthetic
// 3x4 frames). Any drift is a byte-compatibility break for default exports.
const GOLDEN_COMPOSITED_FINGERPRINT = "sha256:e150292f90d44036596796eab2ba424964ea937ff0c1cdaea7ec98bcc606f72c";
const GOLDEN_COMPOSITED_ZIP_BYTES = 1_239;
const GOLDEN_COMPOSITED_ZIP_FNV1A = "e0a2518c";

function fnv1a(bytes: Uint8Array): string {
  let hash = 2_166_136_261;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 16_777_619);
  return (hash >>> 0).toString(16);
}

function png(width = 2, height = 2, marker = 0): Uint8Array {
  const bytes = new Uint8Array(25);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  bytes[24] = marker;
  return bytes;
}

function pngDataUrl(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:image/png;base64,${btoa(binary)}`;
}

function mp4Bytes(): Uint8Array {
  return Uint8Array.of(0, 0, 0, 12, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d);
}

function pngChunk(type: string, payload: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + payload.byteLength);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, payload.byteLength, false);
  for (let index = 0; index < 4; index += 1) chunk[4 + index] = type.charCodeAt(index);
  chunk.set(payload, 8);
  view.setUint32(8 + payload.byteLength, directorZipCrc32(chunk.subarray(4, 8 + payload.byteLength)), false);
  return chunk;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65_521;
    b = (b + a) % 65_521;
  }
  return ((b << 16) | a) >>> 0;
}

/** A real, decodable RGBA PNG (color type 6) using a stored deflate block. */
function rgbaPng(width: number, height: number, pixels: Uint8Array): Uint8Array {
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width, false);
  ihdrView.setUint32(4, height, false);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const stride = width * 4;
  const raw = new Uint8Array(height * (stride + 1));
  for (let row = 0; row < height; row += 1) {
    raw.set(pixels.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1);
  }
  const idat = new Uint8Array(7 + raw.byteLength + 4);
  idat.set(
    [0x78, 0x01, 0x01, raw.byteLength & 0xff, (raw.byteLength >>> 8) & 0xff, ~raw.byteLength & 0xff, (~raw.byteLength >>> 8) & 0xff],
    0,
  );
  idat.set(raw, 7);
  new DataView(idat.buffer).setUint32(7 + raw.byteLength, adler32(raw), false);
  const parts = [
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

/** Reads pixels back out of an rgbaPng-produced (stored deflate) PNG. */
function storedPngPixels(bytes: Uint8Array, width: number, height: number): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 8; offset < bytes.byteLength; offset += 12 + view.getUint32(offset, false)) {
    if (String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)) !== "IDAT") continue;
    const raw = bytes.subarray(offset + 8 + 7, offset + 8 + view.getUint32(offset, false) - 4);
    const stride = width * 4;
    const pixels: number[] = [];
    for (let row = 0; row < height; row += 1) {
      pixels.push(...raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1)));
    }
    return pixels;
  }
  throw new Error("stored PNG is missing its IDAT chunk");
}

interface FakeWebCodecsResult {
  runtime: DirectorWebCodecsRuntime;
  frameInits: VideoFrameInit[];
  encoderConfigs: VideoEncoderConfig[];
  closeCounts: { images: number; frames: number; encoders: number };
}

function fakeWebCodecsRuntime(supported = true): FakeWebCodecsResult {
  const frameInits: VideoFrameInit[] = [];
  const encoderConfigs: VideoEncoderConfig[] = [];
  const closeCounts = { images: 0, frames: 0, encoders: 0 };
  const runtime: DirectorWebCodecsRuntime = {
    isConfigSupported: async (config) => ({ supported, config }),
    decodePng: async () =>
      ({
        width: 2,
        height: 2,
        close: () => {
          closeCounts.images += 1;
        },
      }) as unknown as CanvasImageSource & { close: () => void },
    createVideoFrame: (_source, init) => {
      frameInits.push({ ...init });
      return {
        timestamp: init.timestamp,
        duration: init.duration,
        close: () => {
          closeCounts.frames += 1;
        },
      } as unknown as VideoFrame;
    },
    createEncoder: (init) => ({
      encodeQueueSize: 0,
      configure: (config) => encoderConfigs.push({ ...config }),
      encode: (frame, options) => {
        const timestamp = frame.timestamp;
        const duration = frame.duration;
        const chunk = {
          byteLength: 2,
          timestamp,
          duration,
          type: options?.keyFrame ? "key" : "delta",
          copyTo: (target: AllowSharedBufferSource) => {
            const view = ArrayBuffer.isView(target)
              ? new Uint8Array(target.buffer, target.byteOffset, target.byteLength)
              : new Uint8Array(target);
            view.set([timestamp & 0xff, duration ?? 0]);
          },
        } as EncodedVideoChunk;
        init.output(chunk, {
          decoderConfig: {
            codec: "vp09.00.10.08",
            codedWidth: 2,
            codedHeight: 2,
            description: Uint8Array.of(1, 2, 3),
          },
        });
      },
      flush: async () => {},
      reset: () => {},
      close: () => {
        closeCounts.encoders += 1;
      },
    }),
  };
  return { runtime, frameInits, encoderConfigs, closeCounts };
}

function mp4Muxer(chunks: DirectorMuxedVideoChunk[]): DirectorDeterministicVideoMuxer {
  return {
    container: "mp4",
    mimeType: "video/mp4",
    extension: "mp4",
    addVideoChunk: (chunk) => {
      chunks.push(chunk);
    },
    finalize: () => mp4Bytes(),
  };
}

function webmMuxer(chunks: DirectorMuxedVideoChunk[]): DirectorDeterministicVideoMuxer {
  return {
    container: "webm",
    mimeType: "video/webm",
    extension: "webm",
    addVideoChunk: (chunk) => {
      chunks.push(chunk);
    },
    finalize: () => Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4),
  };
}

describe("deterministic frame export", () => {
  it("plans an inclusive constant-rate sequence with exact integer microsecond timing", () => {
    expect(getDirectorDeterministicFramePlan(12, 15, 24, 24)).toEqual([
      { outputIndex: 0, sourceFrame: 12, timestampUs: 0, durationUs: 41_667 },
      { outputIndex: 1, sourceFrame: 13, timestampUs: 41_667, durationUs: 41_666 },
      { outputIndex: 2, sourceFrame: 14, timestampUs: 83_333, durationUs: 41_667 },
      { outputIndex: 3, sourceFrame: 15, timestampUs: 125_000, durationUs: 41_667 },
    ]);
    expect(getDirectorDeterministicFramePlan(9, 9, 240, 60)).toEqual([
      { outputIndex: 0, sourceFrame: 9, timestampUs: 0, durationUs: 16_667 },
    ]);
  });

  it("represents both endpoints while downsampling and requests every repeated frame while upsampling", async () => {
    expect(getDirectorDeterministicFramePlan(0, 120, 120, 60).map((sample) => sample.sourceFrame)).toEqual(
      Array.from({ length: 61 }, (_, index) => index * 2),
    );
    const captureFrame = vi.fn(async (frame: number) => png(2, 2, frame));
    const result = await exportDeterministicDirectorFrames({
      frameStart: 4,
      frameEnd: 5,
      sourceFps: 24,
      outputFps: 60,
      captureFrame,
    });

    expect(result.kind).toBe("png-sequence");
    expect(captureFrame.mock.calls.map(([frame]) => frame)).toEqual([4, 4, 5, 5, 5]);
    expect(result.manifest.frames.map((frame) => frame.outputIndex)).toEqual([0, 1, 2, 3, 4]);
  });

  it("returns a byte-stable PNG-sequence ZIP with per-frame hashes and a total fingerprint", async () => {
    const run = () =>
      exportDeterministicDirectorFrames({
        frameStart: 2,
        frameEnd: 3,
        sourceFps: 24,
        captureFrame: async (frame) => pngDataUrl(png(3, 4, frame)),
      });
    const first = await run();
    const second = await run();
    expect(first.kind).toBe("png-sequence");
    expect(second.kind).toBe("png-sequence");
    if (first.kind !== "png-sequence" || second.kind !== "png-sequence") throw new Error("unexpected result");

    expect(first.mimeType).toBe("application/zip");
    expect(first.fileName).toBe("director-png-sequence-f000002-f000003.zip");
    expect(first.manifest).toMatchObject({
      schemaVersion: 1,
      sampling: "nearest-endpoint-inclusive",
      sourceFrameStart: 2,
      sourceFrameEnd: 3,
      sourceFps: 24,
      outputFps: 24,
      outputFrameCount: 2,
      durationUs: 83_333,
      width: 3,
      height: 4,
    });
    expect(first.manifest.frames[0]).toMatchObject({
      path: "frames/frame-000000.png",
      mimeType: "image/png",
      sourceFrame: 2,
      byteLength: 25,
    });
    expect(first.manifest.frames[0]!.sha256).toMatch(/^sha256:[a-f\d]{64}$/);
    expect(first.manifest.packageFingerprint).toBe(second.manifest.packageFingerprint);
    expect(new Uint8Array(await first.archive.arrayBuffer())).toEqual(
      new Uint8Array(await second.archive.arrayBuffer()),
    );
  });

  it("keeps the default composited package byte-identical to the pre-transparency golden", async () => {
    const run = (background?: "composited") =>
      exportDeterministicDirectorFrames({
        frameStart: 2,
        frameEnd: 3,
        sourceFps: 24,
        ...(background ? { background } : {}),
        captureFrame: async (frame) => png(3, 4, frame),
      });
    const implicit = await run();
    if (implicit.kind !== "png-sequence") throw new Error("unexpected result kind");

    expect(implicit.manifest.background).toBeUndefined();
    expect(implicit.manifest.packageFingerprint).toBe(GOLDEN_COMPOSITED_FINGERPRINT);
    const zipBytes = new Uint8Array(await implicit.archive.arrayBuffer());
    expect(zipBytes.byteLength).toBe(GOLDEN_COMPOSITED_ZIP_BYTES);
    expect(fnv1a(zipBytes)).toBe(GOLDEN_COMPOSITED_ZIP_FNV1A);

    // Spelling out the composited default must not change a single byte.
    const explicit = await run("composited");
    if (explicit.kind !== "png-sequence") throw new Error("unexpected result kind");
    expect(explicit.manifest.packageFingerprint).toBe(GOLDEN_COMPOSITED_FINGERPRINT);
    expect(new Uint8Array(await explicit.archive.arrayBuffer())).toEqual(zipBytes);
  });

  it("records the transparent mode and carries color type 6 RGBA alpha through the package untouched", async () => {
    // One opaque red authored pixel next to a half-covered green edge pixel.
    const pixels = Uint8Array.of(255, 0, 0, 255, 0, 255, 0, 128);
    const frameBytes = rgbaPng(2, 1, pixels);
    expect(frameBytes[25]).toBe(6);
    expect(inspectDirectorPng(frameBytes)).toEqual({ width: 2, height: 1 });

    const result = await exportDeterministicDirectorFrames({
      frameStart: 0,
      frameEnd: 0,
      sourceFps: 24,
      background: "transparent",
      captureFrame: async () => frameBytes,
    });
    if (result.kind !== "png-sequence") throw new Error("unexpected result kind");

    expect(result.manifest.background).toBe("transparent");
    expect(result.manifest.packageFingerprint).not.toBe(GOLDEN_COMPOSITED_FINGERPRINT);

    // The packaged frame is the captured PNG byte for byte: color type 6,
    // straight alpha, no re-encode anywhere in the pipeline.
    const packaged = result.files[0]!.bytes;
    expect([...packaged]).toEqual([...frameBytes]);
    expect(packaged[25]).toBe(6);
    const decoded = storedPngPixels(packaged, 2, 1);
    expect(decoded).toEqual([...pixels]);
    expect(decoded[3]).toBe(255);
    expect(decoded[7]).toBe(128);

    // The archive stores entries uncompressed, so the serialized
    // manifest.json inside it must record the mode verbatim.
    const archiveBytes = new Uint8Array(await result.archive.arrayBuffer());
    let archiveText = "";
    for (const byte of archiveBytes) archiveText += String.fromCharCode(byte);
    expect(archiveText).toContain('"background":"transparent"');

    await expect(
      exportDeterministicDirectorFrames({
        frameStart: 0,
        frameEnd: 0,
        sourceFps: 24,
        background: "green-screen" as never,
        captureFrame: async () => frameBytes,
      }),
    ).rejects.toThrow('background must be "composited" or "transparent"');
  });

  it("muxes alpha video only when the encoder keeps alpha inside a WebM container", async () => {
    // An encoder that silently strips the alpha request (Chrome today) must
    // fall back to the honest RGBA PNG package instead of shipping opaque video.
    const stripping = fakeWebCodecsRuntime();
    const echoSupport = stripping.runtime.isConfigSupported;
    stripping.runtime.isConfigSupported = async (config) => {
      const support = await echoSupport(config);
      const { alpha: _alpha, ...rest } = (support.config ?? config) as VideoEncoderConfig & { alpha?: unknown };
      return { supported: true, config: rest };
    };
    const stripped = await exportDeterministicDirectorFrames({
      frameStart: 0,
      frameEnd: 0,
      sourceFps: 24,
      background: "transparent",
      captureFrame: async () => png(),
      webCodecs: { runtime: stripping.runtime, createMuxer: async () => webmMuxer([]) },
    });
    expect(stripped).toMatchObject({ kind: "png-sequence", extension: "zip" });
    expect(stripped.kind === "png-sequence" && stripped.manifest.background).toBe("transparent");
    expect(stripped.kind === "png-sequence" && stripped.fallbackReason).toContain("cannot keep the alpha channel");

    // Alpha kept but muxed into MP4 is equally dishonest: only WebM carries it.
    const mp4Runtime = fakeWebCodecsRuntime();
    const wrongContainer = await exportDeterministicDirectorFrames({
      frameStart: 0,
      frameEnd: 0,
      sourceFps: 24,
      background: "transparent",
      captureFrame: async () => png(),
      webCodecs: { runtime: mp4Runtime.runtime, createMuxer: async () => mp4Muxer([]) },
    });
    expect(wrongContainer).toMatchObject({ kind: "png-sequence", extension: "zip" });
    expect(wrongContainer.kind === "png-sequence" && wrongContainer.fallbackReason).toContain("WebM");

    // A runtime that genuinely keeps alpha in a WebM container may mux video.
    const keeping = fakeWebCodecsRuntime();
    const chunks: DirectorMuxedVideoChunk[] = [];
    const video = await exportDeterministicDirectorFrames({
      frameStart: 0,
      frameEnd: 0,
      sourceFps: 24,
      background: "transparent",
      captureFrame: async () => png(),
      webCodecs: { runtime: keeping.runtime, createMuxer: async () => webmMuxer(chunks) },
    });
    expect(video.kind).toBe("video");
    if (video.kind !== "video") throw new Error("expected video");
    expect(video).toMatchObject({ container: "webm", mimeType: "video/webm", extension: "webm" });
    expect(video.blob.type).toBe("video/webm");
    expect(video.manifest.background).toBe("transparent");
    expect(keeping.encoderConfigs[0]).toMatchObject({ alpha: "keep" });
    expect(chunks).toHaveLength(1);

    // Composited exports never request alpha from the encoder.
    const composited = fakeWebCodecsRuntime();
    const compositedResult = await exportDeterministicDirectorFrames({
      frameStart: 0,
      frameEnd: 0,
      sourceFps: 24,
      captureFrame: async () => png(),
      webCodecs: { runtime: composited.runtime, createMuxer: async () => webmMuxer([]) },
    });
    expect(compositedResult.kind).toBe("video");
    expect(composited.encoderConfigs[0]).not.toHaveProperty("alpha");
  });

  it("encodes through WebCodecs using the plan's explicit timestamp and duration when a real muxer exists", async () => {
    const chunks: DirectorMuxedVideoChunk[] = [];
    const fake = fakeWebCodecsRuntime();
    const createMuxer = vi.fn(async () => mp4Muxer(chunks));
    const result = await exportDeterministicDirectorFrames({
      frameStart: 10,
      frameEnd: 12,
      sourceFps: 24,
      outputFps: 24,
      captureFrame: async (frame) => png(2, 2, frame),
      webCodecs: { runtime: fake.runtime, createMuxer, keyFrameInterval: 2 },
    });

    expect(result.kind).toBe("video");
    if (result.kind !== "video") throw new Error("expected video");
    expect(result).toMatchObject({
      timing: "explicit-webcodecs-timestamps",
      container: "mp4",
      mimeType: "video/mp4",
      extension: "mp4",
    });
    expect(fake.frameInits).toEqual([
      { timestamp: 0, duration: 41_667 },
      { timestamp: 41_667, duration: 41_666 },
      { timestamp: 83_333, duration: 41_667 },
    ]);
    expect(chunks.map(({ type, timestampUs, durationUs }) => ({ type, timestampUs, durationUs }))).toEqual([
      { type: "key", timestampUs: 0, durationUs: 41_667 },
      { type: "delta", timestampUs: 41_667, durationUs: 41_666 },
      { type: "key", timestampUs: 83_333, durationUs: 41_667 },
    ]);
    expect(chunks[0]!.decoderConfig?.description).toEqual(Uint8Array.of(1, 2, 3));
    expect(fake.encoderConfigs[0]).toMatchObject({ width: 2, height: 2, framerate: 24, bitrate: 8_000_000 });
    expect(fake.closeCounts).toEqual({ images: 3, frames: 3, encoders: 1 });
    expect(result.blob.type).toBe("video/mp4");
  });

  it("falls back to the honest PNG package when WebCodecs is unsupported or the container is invalid", async () => {
    const unsupported = fakeWebCodecsRuntime(false);
    const unsupportedResult = await exportDeterministicDirectorFrames({
      frameStart: 0,
      frameEnd: 0,
      sourceFps: 24,
      captureFrame: async () => png(),
      webCodecs: { runtime: unsupported.runtime, createMuxer: async () => mp4Muxer([]) },
    });
    expect(unsupportedResult).toMatchObject({
      kind: "png-sequence",
      extension: "zip",
      fallbackReason: 'WebCodecs codec "vp09.00.10.08" is unsupported.',
    });

    const supported = fakeWebCodecsRuntime();
    const invalidContainer = await exportDeterministicDirectorFrames({
      frameStart: 0,
      frameEnd: 0,
      sourceFps: 24,
      captureFrame: async () => png(),
      webCodecs: {
        runtime: supported.runtime,
        createMuxer: async () => ({ ...mp4Muxer([]), finalize: () => Uint8Array.of(1, 2, 3) }),
      },
    });
    expect(invalidContainer).toMatchObject({
      kind: "png-sequence",
      extension: "zip",
    });
    expect(invalidContainer.kind === "png-sequence" && invalidContainer.fallbackReason).toContain("self-contained");
  });

  it("bounds encoded chunk staging before muxing and falls back without claiming video", async () => {
    const fake = fakeWebCodecsRuntime();
    const result = await exportDeterministicDirectorFrames({
      frameStart: 0,
      frameEnd: 0,
      sourceFps: 24,
      captureFrame: async () => png(),
      maxEncodedBytes: 1,
      webCodecs: { runtime: fake.runtime, createMuxer: async () => mp4Muxer([]) },
    });
    expect(result).toMatchObject({ kind: "png-sequence", extension: "zip" });
    expect(result.kind === "png-sequence" && result.fallbackReason).toContain("chunks exceed");
  });

  it("reports monotonic capture, encode, and package progress", async () => {
    const fake = fakeWebCodecsRuntime();
    const reports: Array<{ phase: string; progress: number }> = [];
    await exportDeterministicDirectorFrames({
      frameStart: 0,
      frameEnd: 1,
      sourceFps: 24,
      captureFrame: async () => png(),
      onProgress: ({ phase, progress }) => reports.push({ phase, progress }),
      webCodecs: { runtime: fake.runtime, createMuxer: async () => mp4Muxer([]) },
    });
    expect(new Set(reports.map(({ phase }) => phase))).toEqual(new Set(["capture", "encode", "package"]));
    expect(reports.at(-1)).toEqual({ phase: "package", progress: 1 });
    expect(reports.every((item, index) => index === 0 || item.progress >= reports[index - 1]!.progress)).toBe(true);
  });

  it("aborts between exact capture requests and does not package partial output", async () => {
    const controller = new AbortController();
    const captureFrame = vi.fn(async (frame: number, _sample: unknown, signal?: AbortSignal) => {
      expect(signal).toBe(controller.signal);
      if (frame === 1) controller.abort();
      return png();
    });
    await expect(
      exportDeterministicDirectorFrames({
        frameStart: 0,
        frameEnd: 3,
        sourceFps: 24,
        captureFrame,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(captureFrame).toHaveBeenCalledTimes(2);
  });

  it("aborts an in-flight WebCodecs pass and closes its decoded image and encoder", async () => {
    const controller = new AbortController();
    const fake = fakeWebCodecsRuntime();
    const decodePng = fake.runtime.decodePng;
    fake.runtime.decodePng = async (bytes) => {
      const image = await decodePng(bytes);
      controller.abort();
      return image;
    };
    const abortMuxer = vi.fn();
    await expect(
      exportDeterministicDirectorFrames({
        frameStart: 0,
        frameEnd: 0,
        sourceFps: 24,
        captureFrame: async () => png(),
        signal: controller.signal,
        webCodecs: {
          runtime: fake.runtime,
          createMuxer: async () => ({ ...mp4Muxer([]), abort: abortMuxer }),
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(abortMuxer).toHaveBeenCalledOnce();
    expect(fake.closeCounts).toEqual({ images: 1, frames: 0, encoders: 1 });
  });

  it("enforces frame, memory, PNG, and consistent-raster safety bounds", async () => {
    await expect(
      exportDeterministicDirectorFrames({
        frameStart: 0,
        frameEnd: 2,
        sourceFps: 24,
        captureFrame: async () => png(),
        maxFrames: 2,
      }),
    ).rejects.toThrow("3 frames");
    await expect(
      exportDeterministicDirectorFrames({
        frameStart: 0,
        frameEnd: 0,
        sourceFps: 24,
        captureFrame: async () => png(),
        maxCaptureBytes: 24,
      }),
    ).rejects.toThrow("memory limit");
    await expect(
      exportDeterministicDirectorFrames({
        frameStart: 0,
        frameEnd: 1,
        sourceFps: 24,
        captureFrame: async (frame) => png(frame === 0 ? 2 : 3, 2),
      }),
    ).rejects.toThrow("expected 2x2");
    await expect(
      exportDeterministicDirectorFrames({
        frameStart: 0,
        frameEnd: 0,
        sourceFps: 24,
        captureFrame: async () => png(2, 2),
        maxRasterPixels: 3,
      }),
    ).rejects.toThrow("3-pixel limit");
    expect(() => inspectDirectorPng(Uint8Array.of(1, 2, 3))).toThrow("real PNG");
    expect(() => getDirectorDeterministicFramePlan(2, 1, 24, 24)).toThrow("before frameStart");
    expect(() => getDirectorDeterministicFramePlan(0, 1, 23.976, 24)).toThrow("integer");
    expect(() => getDirectorDeterministicFramePlan(0, 7_200, 24, 24)).toThrow("hard limit");
  });
});
