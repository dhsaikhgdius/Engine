import { describe, expect, it } from "vitest";
import {
  addDirectorVideoCaptureBytes,
  createLiveDirectorVideoRecorder,
  exportDeterministicDirectorFrames,
  getDirectorDeterministicFramePlan,
  getDirectorVideoDurationSec,
  getDirectorVideoFinalFrameHoldMs,
  getDirectorVideoFrameSequence,
  getDirectorVideoFrameSamples,
  recordDirectorVideo,
  resolveDirectorVideoMimeSelection,
  scoreDirectorVideoThumbnailPixels,
  selectDirectorVideoThumbnailDataUrl,
  selectDirectorVideoMimeType,
} from "../../../../src/comprehensive/editor/video/directorVideoExport";

function installMediaRecorderHarness() {
  const events: string[] = [];
  const requestFrame = vi.fn(() => events.push("track.requestFrame"));
  const stopTrack = vi.fn(() => events.push("track.stop"));
  const track = { requestFrame, stop: stopTrack } as unknown as MediaStreamTrack & { requestFrame: () => void };
  const stream = {
    getVideoTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
  const drawImage = vi.fn(() => events.push("canvas.drawImage"));
  const clearRect = vi.fn(() => events.push("canvas.clearRect"));
  const context = { drawImage, clearRect } as unknown as CanvasRenderingContext2D;
  const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => context as never);
  const previousCaptureStream = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "captureStream");
  const captureStream = vi.fn(() => {
    events.push("canvas.captureStream");
    return stream;
  });
  Object.defineProperty(HTMLCanvasElement.prototype, "captureStream", {
    configurable: true,
    value: captureStream,
  });

  class FakeMediaRecorder extends EventTarget {
    static isTypeSupported() {
      return true;
    }

    mimeType: string;
    state: RecordingState = "inactive";

    constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
      super();
      this.mimeType = options?.mimeType || "video/webm";
      events.push("recorder.construct");
    }

    start() {
      events.push("recorder.start");
      this.state = "recording";
      queueMicrotask(() => {
        events.push("recorder.start.event");
        this.dispatchEvent(new Event("start"));
      });
    }

    pause() {
      this.state = "paused";
    }

    resume() {
      this.state = "recording";
    }

    requestData() {
      events.push("recorder.requestData");
      const event = new Event("dataavailable");
      Object.defineProperty(event, "data", {
        value: new Blob(["encoded-frame"], { type: this.mimeType }),
      });
      this.dispatchEvent(event);
    }

    stop() {
      if (this.state === "inactive") return;
      events.push("recorder.stop");
      this.state = "inactive";
      queueMicrotask(() => {
        events.push("recorder.stop.event");
        this.dispatchEvent(new Event("stop"));
      });
    }
  }

  vi.stubGlobal("MediaRecorder", FakeMediaRecorder as unknown as typeof MediaRecorder);
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width: 4, height: 2, close: vi.fn() }) as unknown as ImageBitmap),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      blob: async () => new Blob(["png-frame"], { type: "image/png" }),
    })) as unknown as typeof fetch,
  );

  return {
    clearRect,
    drawImage,
    events,
    requestFrame,
    restore: () => {
      getContext.mockRestore();
      if (previousCaptureStream) {
        Object.defineProperty(HTMLCanvasElement.prototype, "captureStream", previousCaptureStream);
      } else {
        Reflect.deleteProperty(HTMLCanvasElement.prototype, "captureStream");
      }
      vi.unstubAllGlobals();
    },
  };
}

describe("director video export", () => {
  it("exposes the deterministic offline exporter without replacing MediaRecorder recording", () => {
    expect(exportDeterministicDirectorFrames).toBeTypeOf("function");
    expect(getDirectorDeterministicFramePlan(0, 1, 24, 24).map(({ sourceFrame }) => sourceFrame)).toEqual([0, 1]);
  });

  it("selects a supported WebM or MP4 encoder without lying about the extension", () => {
    expect(selectDirectorVideoMimeType("webm", (mimeType) => mimeType === "video/webm;codecs=vp8")).toBe(
      "video/webm;codecs=vp8",
    );
    expect(selectDirectorVideoMimeType("mp4", (mimeType) => mimeType === "video/mp4")).toBe("video/mp4");
    expect(selectDirectorVideoMimeType("auto", () => false)).toBe("");
  });

  it("exports an inclusive integer frame sequence through the effective endpoint", () => {
    expect(getDirectorVideoFrameSequence(12, 15)).toEqual([12, 13, 14, 15]);
    expect(getDirectorVideoFrameSequence(15, 12)).toEqual([12, 13, 14, 15]);
  });

  it("reports inclusive clip duration and holds the OUT frame for one encoder interval", () => {
    expect(getDirectorVideoDurationSec(1, 24, 24)).toBe(1);
    expect(getDirectorVideoDurationSec(24, 1, 24)).toBe(1);
    expect(getDirectorVideoDurationSec(12, 12, 24)).toBeCloseTo(1 / 24);
    expect(getDirectorVideoFinalFrameHoldMs(24)).toBe(42);
    expect(getDirectorVideoFinalFrameHoldMs(60)).toBe(17);
  });

  it.each([120, 240])("samples %i fps source time at no more than 60 fps without slow motion", (sourceFps) => {
    const samples = getDirectorVideoFrameSamples(12, 12 + sourceFps, sourceFps);
    expect(samples[0]).toEqual({ frame: 12, timeSec: 0 });
    expect(samples[samples.length - 1]).toEqual({ frame: 12 + sourceFps, timeSec: 1 });
    expect(samples).toHaveLength(61);
    expect(new Set(samples.map((sample) => sample.frame)).size).toBe(samples.length);
    expect(samples.every((sample, index) => index === 0 || sample.frame > samples[index - 1].frame)).toBe(true);
  });

  it("preserves a fractional source duration and always includes the exact endpoint", () => {
    const samples = getDirectorVideoFrameSamples(0, 241, 240);
    expect(samples[samples.length - 1]).toEqual({ frame: 241, timeSec: 241 / 240 });
    expect(samples.filter((sample) => sample.frame === 241)).toHaveLength(1);
  });

  it("uses a real WebM fallback when MP4 MediaRecorder is unavailable", () => {
    expect(resolveDirectorVideoMimeSelection("mp4", (mimeType) => mimeType === "video/webm")).toEqual({
      mimeType: "video/webm",
      fallbackFrom: "mp4",
    });
    expect(resolveDirectorVideoMimeSelection("mp4", (mimeType) => mimeType === "video/mp4")).toEqual({
      mimeType: "video/mp4",
      fallbackFrom: undefined,
    });
  });

  it("keeps the first valid PNG as a thumbnail fallback without treating compression size as content", () => {
    const blackFrame = `data:image/png;base64,${"a".repeat(12)}`;
    const representativeFrame = `data:image/png;base64,${"b".repeat(80)}`;
    expect(selectDirectorVideoThumbnailDataUrl("", blackFrame)).toBe(blackFrame);
    expect(selectDirectorVideoThumbnailDataUrl(blackFrame, representativeFrame)).toBe(blackFrame);
    expect(selectDirectorVideoThumbnailDataUrl(representativeFrame, blackFrame)).toBe(representativeFrame);
    expect(selectDirectorVideoThumbnailDataUrl(blackFrame, "data:image/jpeg;base64,longer-but-wrong-format")).toBe(
      blackFrame,
    );
  });

  it("scores a framed subject above an empty stage using pixels rather than PNG byte length", () => {
    const width = 12;
    const height = 8;
    const emptyStage = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4;
        const gridLine = x % 4 === 0 || y % 4 === 0;
        const gray = gridLine ? 55 : 48;
        emptyStage.set([gray, gray, gray, 255], offset);
      }
    }
    const framedSubject = new Uint8ClampedArray(emptyStage);
    for (let y = 2; y <= 6; y += 1) {
      for (let x = 5; x <= 7; x += 1) {
        framedSubject.set([218, 154, 28, 255], (y * width + x) * 4);
      }
    }

    const emptyScore = scoreDirectorVideoThumbnailPixels(emptyStage, width, height);
    const subjectScore = scoreDirectorVideoThumbnailPixels(framedSubject, width, height);
    expect(emptyScore).toBeGreaterThan(0);
    expect(subjectScore).toBeGreaterThan(emptyScore * 3);
    expect(scoreDirectorVideoThumbnailPixels(new Uint8ClampedArray(), 0, 0)).toBe(0);
  });

  it("fails clearly before capture when browser recording is unavailable", async () => {
    const previousMediaRecorder = globalThis.MediaRecorder;
    // @ts-expect-error deliberate capability removal for the negative path
    globalThis.MediaRecorder = undefined;
    const captureFrame = vi.fn(async () => "data:image/png;base64,unused");
    await expect(recordDirectorVideo({ frameStart: 0, frameEnd: 2, fps: 24, captureFrame })).rejects.toThrow(
      "不支持 WebM/MP4",
    );
    expect(captureFrame).not.toHaveBeenCalled();
    globalThis.MediaRecorder = previousMediaRecorder;
  });

  it("bounds PNG staging memory before MediaRecorder encoding", () => {
    expect(addDirectorVideoCaptureBytes(40, 60, 100)).toBe(100);
    expect(() => addDirectorVideoCaptureBytes(40, 61, 100)).toThrow("256 MiB");
    expect(() => addDirectorVideoCaptureBytes(-1, 1)).toThrow("大小无效");
  });

  it("seeds the canvas before capture and commits first/final frames only after MediaRecorder starts", async () => {
    const harness = installMediaRecorderHarness();
    try {
      const recording = await recordDirectorVideo({
        frameStart: 0,
        frameEnd: 0,
        fps: 60,
        captureFrame: async () => "data:image/png;base64,frame",
      });

      expect(recording.blob.size).toBeGreaterThan(0);
      expect(harness.clearRect).not.toHaveBeenCalled();
      expect(harness.drawImage).toHaveBeenCalledTimes(3);
      expect(harness.requestFrame).toHaveBeenCalledTimes(2);

      const drawIndices = harness.events.flatMap((event, index) => (event === "canvas.drawImage" ? [index] : []));
      const requestIndices = harness.events.flatMap((event, index) => (event === "track.requestFrame" ? [index] : []));
      expect(drawIndices[0]).toBeLessThan(harness.events.indexOf("canvas.captureStream"));
      expect(harness.events.indexOf("recorder.start.event")).toBeLessThan(drawIndices[1]);
      expect(requestIndices).toHaveLength(2);
      expect(drawIndices[1]).toBeLessThan(requestIndices[0]);
      expect(drawIndices[2]).toBeLessThan(requestIndices[1]);
    } finally {
      harness.restore();
    }
  });

  it("uses the same safe presentation order for live recording and repaints its terminal frame", async () => {
    const harness = installMediaRecorderHarness();
    try {
      const recorder = createLiveDirectorVideoRecorder({ fps: 60 });
      await recorder.appendFrame("data:image/png;base64,frame", 12);
      const recording = await recorder.stop();

      expect(recording.frameStart).toBe(12);
      expect(recording.frameEnd).toBe(12);
      expect(harness.clearRect).not.toHaveBeenCalled();
      expect(harness.drawImage).toHaveBeenCalledTimes(3);
      expect(harness.requestFrame).toHaveBeenCalledTimes(2);
      expect(harness.events.indexOf("canvas.drawImage")).toBeLessThan(harness.events.indexOf("canvas.captureStream"));
      expect(harness.events.indexOf("recorder.start.event")).toBeLessThan(
        harness.events.lastIndexOf("canvas.drawImage"),
      );
    } finally {
      harness.restore();
    }
  });
});
