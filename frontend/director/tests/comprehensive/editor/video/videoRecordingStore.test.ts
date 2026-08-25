import { beforeEach, describe, expect, it } from "vitest";
import { useVideoRecordingStore } from "../../../../src/comprehensive/editor/video/videoRecordingStore";

function recording(frameStart: number, frameEnd: number, size = 4) {
  return {
    blob: new Blob([new Uint8Array(size)], { type: "video/webm" }),
    thumbnailDataUrl: "data:image/png;base64,demo",
    extension: "webm" as const,
    mimeType: "video/webm",
    frameStart,
    frameEnd,
    frameCount: frameEnd - frameStart + 1,
    sourceFps: 24,
    outputFps: 24,
    durationSec: (frameEnd - frameStart) / 24,
  };
}

beforeEach(() => useVideoRecordingStore.getState().reset());

describe("page-session render recording library", () => {
  it("keeps recorded blobs and frame metadata outside the authoritative project", () => {
    const item = useVideoRecordingStore.getState().addRecording(recording(12, 36));

    expect(item).toMatchObject({
      name: "渲染视频01",
      fileName: "director-render-01-f12-f36.webm",
      frameStart: 12,
      frameEnd: 36,
      sourceFps: 24,
      durationSec: 1,
      status: "ready",
    });
    expect(useVideoRecordingStore.getState().recordings[0]?.blob).toBe(item.blob);
  });

  it("tracks ComfyUI upload state without serializing it into scene data", () => {
    const item = useVideoRecordingStore.getState().addRecording(recording(0, 24));
    useVideoRecordingStore.getState().updateRecordingStatus(item.id, "uploaded", "已上传 input/demo.webm");

    expect(useVideoRecordingStore.getState().recordings[0]).toMatchObject({
      status: "uploaded",
      statusMessage: "已上传 input/demo.webm",
    });
  });
});
