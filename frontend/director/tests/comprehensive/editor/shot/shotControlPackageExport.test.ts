import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import { createDefaultDirectorProject } from "../../../../src/comprehensive/editor/store/directorStore";
import { buildDirectorAiControlPackageArchive, createDirectorAiControlPackage } from "../../../../src/comprehensive/editor/shot/shotControlPackageExport";

function pngDataUrl(text: string) {
  return `data:image/png;base64,${btoa(text)}`;
}

describe("Director AI control package", () => {
  it("packages helper-free passes, ShotIR, camera trajectory and provider-neutral AI controls", async () => {
    const project = createDefaultDirectorProject();
    project.scene.timeline = {
      version: 1,
      fps: 24,
      frameStart: 0,
      frameEnd: 2,
      currentFrame: 1,
      loop: false,
    };
    const capture = vi.fn(async (request) => [
      {
        label: request.renderPass ?? "clean",
        dataUrl: pngDataUrl(request.renderPass ?? "clean"),
        meta: {
          mode: "camera" as const,
          cameraId: request.cameraId ?? null,
          fov: 35,
          position: [0, 2, 8] as [number, number, number],
          target: [0, 1, 0] as [number, number, number],
        },
      },
    ]);

    const result = await createDirectorAiControlPackage(project, { frame: 1, width: 640, height: 360 }, capture);
    const archive = await buildDirectorAiControlPackageArchive(result.captured);
    const zip = await JSZip.loadAsync(await archive.arrayBuffer());

    expect(capture).toHaveBeenCalledTimes(5);
    expect(result.captured.manifest.controlPackage).toMatchObject({
      contract: "director-ai-control-v1",
      primaryFrame: 1,
      trajectoryFrameRange: { start: 0, end: 2, sampleCount: 3 },
    });
    expect(Object.keys(zip.files).sort()).toEqual(
      expect.arrayContaining([
        "README.md",
        "ai/control.json",
        "camera/trajectory.json",
        "manifest.json",
        "metadata/shot-ir.json",
        "passes/clean/frame-000001.png",
        "passes/depth/frame-000001.png",
        "passes/mask/frame-000001.png",
        "passes/normal/frame-000001.png",
        "passes/object-id/frame-000001.png",
      ]),
    );
    const trajectory = JSON.parse(await zip.file("camera/trajectory.json")!.async("text"));
    expect(trajectory.samples).toHaveLength(3);
    const control = JSON.parse(await zip.file("ai/control.json")!.async("text"));
    expect(control.inputs.mask).toBe("passes/mask/frame-000001.png");
  });

  it("exports opt-in clay and PBR control renders from the same camera frame", async () => {
    const project = createDefaultDirectorProject();
    const capture = vi.fn(async (request) => [
      {
        label: request.renderPass ?? "clean",
        dataUrl: pngDataUrl(request.renderPass ?? "clean"),
        meta: {
          mode: "camera" as const,
          cameraId: request.cameraId ?? null,
          fov: 35,
          position: [0, 2, 8] as [number, number, number],
          target: [0, 1, 0] as [number, number, number],
        },
      },
    ]);

    const result = await createDirectorAiControlPackage(
      project,
      {
        frame: 1,
        width: 640,
        height: 360,
        renderPasses: ["clay", "albedo", "roughness", "metalness", "emissive", "ao", "shadow"],
      },
      capture,
    );
    const zip = await JSZip.loadAsync(await result.archive.arrayBuffer());
    const control = JSON.parse(await zip.file("ai/control.json")!.async("text"));

    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ renderPass: "clay", frame: 1 }));
    expect(zip.file("passes/clay/frame-000001.png")).not.toBeNull();
    expect(control.inputs.clay).toBe("passes/clay/frame-000001.png");
    expect(control.inputs).toMatchObject({
      albedo: "passes/albedo/frame-000001.png",
      roughness: "passes/roughness/frame-000001.png",
      metalness: "passes/metalness/frame-000001.png",
      emissive: "passes/emissive/frame-000001.png",
      ao: "passes/ao/frame-000001.png",
      shadow: "passes/shadow/frame-000001.png",
    });
  });

  it("archives the float EXR depth artifact alongside the PNG passes when requested", async () => {
    const project = createDefaultDirectorProject();
    const capture = vi.fn(async (request) => [
      {
        label: request.renderPass ?? "clean",
        dataUrl: pngDataUrl(request.renderPass ?? "clean"),
        meta: {
          mode: "camera" as const,
          cameraId: request.cameraId ?? null,
          fov: 35,
          position: [0, 2, 8] as [number, number, number],
          target: [0, 1, 0] as [number, number, number],
        },
        ...(request.depthFloat
          ? {
              depthFloat: {
                depth: new Float32Array(request.width * request.height).fill(4.5),
                metadata: {
                  renderPass: "depth" as const,
                  width: request.width,
                  height: request.height,
                  pixelFormat: "float32" as const,
                  bitsPerChannel: 32 as const,
                  rowOrder: "top-to-bottom" as const,
                  colorSpace: "data" as const,
                  encoding: "linear-eye-depth" as const,
                  helpersExcluded: true as const,
                  depthSemantics: {
                    representation: "linear-eye-depth" as const,
                    units: "metres" as const,
                    axis: "camera-forward" as const,
                    background: "far-plane" as const,
                    projection: "perspective" as const,
                    nearM: 0.1,
                    farM: 1_000,
                    reversedDepthBuffer: true,
                    source: "rgba-packed-window-depth" as const,
                  },
                },
              },
            }
          : {}),
      },
    ]);

    const result = await createDirectorAiControlPackage(
      project,
      { frame: 1, width: 8, height: 6, includeDepthExr: true },
      capture,
    );
    const zip = await JSZip.loadAsync(await result.archive.arrayBuffer());

    const exrEntry = zip.file("passes/depth/frame-000001.exr");
    expect(exrEntry).not.toBeNull();
    const exrBytes = await exrEntry!.async("uint8array");
    expect([...exrBytes.subarray(0, 4)]).toEqual([0x76, 0x2f, 0x31, 0x01]);
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("text"));
    expect(
      manifest.artifacts.some(
        (artifact: { path: string; encoding?: string }) =>
          artifact.path === "passes/depth/frame-000001.exr" && artifact.encoding === "exr",
      ),
    ).toBe(true);
  });
});
