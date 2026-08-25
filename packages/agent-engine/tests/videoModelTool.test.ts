import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultScene } from "@director/stage-protocol";
import { VideoGenerationService } from "../../../backend/gateway/video/videoGenerationService";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("stage_video", () => {
  it("prepares a portable video-generation job from the validated white-box scene", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "director-video-test-"));
    temporaryDirectories.push(root);
    const service = new VideoGenerationService({
      workspaceRoot: root,
      dataDirectory: resolve(root, "data"),
      defaultProvider: "comfyui",
      capturePreview: async () =>
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zs2kAAAAASUVORK5CYII=",
    });
    const execution = await service.execute(createDefaultScene(), {
      op: "prepare",
      prompt: "Turn the exact white-box blocking into a cinematic live-action shot",
      duration_s: 5,
      fps: 24,
    });

    expect(execution.success).toBe(true);
    expect(execution.result).toMatchObject({ status: "prepared", reference_image: "reference.png" });
    const jobId = (execution.result as { job_id: string }).job_id;
    const manifest = JSON.parse(await readFile(resolve(root, "data", "video-jobs", jobId, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({
      jobId,
      scene: { objectCount: 1, cameraCount: 1 },
      requested: { width: 1280, height: 720, fps: 24, durationS: 5, numFrames: 120 },
      resolved: { generationWidth: 1280, generationHeight: 720, fps: 24, numFrames: 120 },
    });
  });

  it("refuses video preparation before the scene has geometry and a camera", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "director-video-test-"));
    temporaryDirectories.push(root);
    const empty = createDefaultScene();
    empty.objects = {};
    empty.show.tracks = [];
    const service = new VideoGenerationService({
      workspaceRoot: root,
      dataDirectory: resolve(root, "data"),
      defaultProvider: "comfyui",
    });
    const execution = await service.execute(empty, {
      op: "prepare",
      prompt: "A cinematic shot",
    });
    expect(execution).toMatchObject({ success: false, error: expect.stringContaining("not video-ready") });
  });
});
