import { describe, expect, it, vi } from "vitest";
import { createDefaultDirectorProject } from "../../../../src/comprehensive/editor/store/directorStore";
import { captureDirectorStoryboardThumbnail } from "../../../../src/comprehensive/editor/storyboard/storyboardCapture";

function fixture() {
  const project = createDefaultDirectorProject();
  const cameraId = project.cameras[0]!.id;
  const shot = {
    id: "shot-capture",
    title: "开场大全景",
    cameraId,
    frameStart: 24,
    frameEnd: 71,
    shotSize: "wide" as const,
    movement: "static" as const,
    action: "建立空间",
  };
  project.storyboard = { version: 1, title: "截图", logline: "", shots: [shot] };
  return { project, shot, cameraId };
}

describe("captureDirectorStoryboardThumbnail", () => {
  it("captures one exact camera/frame PNG and persists a compact media reference", async () => {
    const { project, shot, cameraId } = fixture();
    const pngBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    const dataUrl = `data:image/png;base64,${btoa(String.fromCharCode(...pngBytes))}`;
    const capture = vi.fn(async () => [
      {
        label: "当前机位",
        dataUrl,
        meta: {
          mode: "camera" as const,
          cameraId,
          fov: 50,
          position: [0, 1, 5] as [number, number, number],
          target: [0, 1, 0] as [number, number, number],
          renderPass: "clean" as const,
          raster: { width: 960, height: 540 },
          frame: 24,
        },
      },
    ]);
    const importBlob = vi.fn(async () => ({ id: "creative-media:image:storyboard-test" }));

    const thumbnail = await captureDirectorStoryboardThumbnail(project, shot, new AbortController().signal, {
      capture,
      mediaLibrary: { importBlob } as never,
      now: () => new Date("2026-08-07T00:00:00.000Z"),
    });

    expect(capture).toHaveBeenCalledWith({
      preset: "current",
      source: "capture-panel",
      cameraId,
      cleanPlate: true,
      renderPass: "clean",
      width: 960,
      height: 540,
      frame: 24,
      signal: expect.any(AbortSignal),
    });
    const [persistedBlob, importOptions] = importBlob.mock.calls[0] as unknown as [Blob, Record<string, unknown>];
    expect(new Uint8Array(await persistedBlob.arrayBuffer())).toEqual(pngBytes);
    expect(importOptions).toMatchObject({
      kind: "image",
      width: 960,
      height: 540,
      source: "storyboard-shot:shot-capture",
      embeddedMetadata: {
        "director.contract": "director-storyboard-thumbnail-v1",
        "director.shotId": "shot-capture",
        "director.cameraId": cameraId,
        "director.frame": "24",
      },
    });
    expect(thumbnail).toEqual({
      mediaId: "creative-media:image:storyboard-test",
      cameraId,
      frame: 24,
      width: 960,
      height: 540,
      capturedAt: "2026-08-07T00:00:00.000Z",
    });
  });

  it("rejects mismatched capture evidence before media persistence", async () => {
    const { project, shot } = fixture();
    const importBlob = vi.fn();
    await expect(
      captureDirectorStoryboardThumbnail(project, shot, new AbortController().signal, {
        capture: async () => [
          {
            label: "错误机位",
            dataUrl: "data:image/png;base64,iVBORw0KGgo=",
            meta: {
              mode: "camera",
              cameraId: "another-camera",
              fov: 50,
              position: [0, 0, 0],
              target: [0, 0, 0],
              raster: { width: 960, height: 540 },
              frame: 24,
            },
          },
        ],
        mediaLibrary: { importBlob } as never,
      }),
    ).rejects.toThrow("错误机位");
    expect(importBlob).not.toHaveBeenCalled();
  });
});
