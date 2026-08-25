import { describe, expect, it, vi } from "vitest";
import { createDefaultDirectorProject } from "../../../../src/comprehensive/editor/store/directorStore";
import { captureDirectorShotPackage } from "../../../../src/comprehensive/editor/shot/shotPackageCapture";

function pngDataUrl(text: string) {
  return `data:image/png;base64,${btoa(text)}`;
}

function createDepthFloatFixture(width: number, height: number) {
  const depth = new Float32Array(width * height);
  for (let index = 0; index < depth.length; index += 1) depth[index] = 2 + (index % 5) * 0.5;
  depth[Math.floor(height / 2) * width + Math.floor(width / 2)] = 6.25;
  return {
    depth,
    metadata: {
      renderPass: "depth" as const,
      width,
      height,
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
  };
}

function createExrAwareCapture() {
  return vi.fn(async (request) => [
    {
      label: request.renderPass ?? "clean",
      dataUrl: pngDataUrl(`${request.renderPass}:${request.frame}`),
      meta: {
        mode: "camera" as const,
        cameraId: request.cameraId ?? null,
        fov: 35,
        position: [0, 2, 8] as [number, number, number],
        target: [0, 1, 0] as [number, number, number],
      },
      ...(request.depthFloat ? { depthFloat: createDepthFloatFixture(request.width, request.height) } : {}),
    },
  ]);
}

function dataUrlBytes(dataUrl: string) {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

/** Minimal single-Z-channel scanline EXR pixel reader for the uncompressed layout. */
function readExrDepthPixel(bytes: Uint8Array, x: number, y: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(view.getInt32(0, true)).toBe(20000630);
  expect(view.getInt32(4, true)).toBe(2);
  let cursor = 8;
  let width = 0;
  while (bytes[cursor] !== 0) {
    let nameEnd = cursor;
    while (bytes[nameEnd] !== 0) nameEnd += 1;
    const name = String.fromCharCode(...bytes.subarray(cursor, nameEnd));
    cursor = nameEnd + 1;
    while (bytes[cursor] !== 0) cursor += 1;
    cursor += 1;
    const size = view.getInt32(cursor, true);
    cursor += 4;
    if (name === "dataWindow") width = view.getInt32(cursor + 8, true) + 1;
    cursor += size;
  }
  cursor += 1; // header terminator
  const blockOffset = view.getUint32(cursor + y * 8 + 4, true) * 0x1_0000_0000 + view.getUint32(cursor + y * 8, true);
  expect(view.getInt32(blockOffset, true)).toBe(y);
  expect(view.getInt32(blockOffset + 4, true)).toBe(width * 4);
  return view.getFloat32(blockOffset + 8 + x * 4, true);
}

describe("captureDirectorShotPackage", () => {
  it("captures every requested real pass at one exact camera frame and hashes its bytes", async () => {
    const project = createDefaultDirectorProject();
    const capture = vi.fn(async (request) => [
      {
        label: request.renderPass ?? "clean",
        dataUrl: pngDataUrl(`${request.renderPass}:${request.frame}`),
        meta: {
          mode: "camera" as const,
          cameraId: request.cameraId ?? null,
          fov: 35,
          position: [0, 2, 8] as [number, number, number],
          target: [0, 1, 0] as [number, number, number],
        },
      },
    ]);

    const captured = await captureDirectorShotPackage(project, { frame: 24, width: 1280, height: 720 }, capture);

    expect(capture).toHaveBeenCalledTimes(5);
    expect(capture.mock.calls.map(([request]) => request.renderPass)).toEqual([
      "clean",
      "depth",
      "normal",
      "object-id",
      "mask",
    ]);
    expect(capture.mock.calls[0]?.[0]).toMatchObject({
      cameraId: "cam_1",
      frame: 24,
      width: 1280,
      height: 720,
      cleanPlate: true,
    });
    expect(captured.manifest.raster).toEqual({ width: 1280, height: 720 });
    expect(captured.manifest.artifacts).toHaveLength(9);
    expect(captured.manifest.artifacts.every((artifact) => artifact.sha256.startsWith("sha256:"))).toBe(true);
    expect(captured.files.map((file) => file.path)).toEqual([
      "passes/clean/frame-000024.png",
      "passes/depth/frame-000024.png",
      "passes/normal/frame-000024.png",
      "passes/object-id/frame-000024.png",
      "passes/mask/frame-000024.png",
    ]);
    expect(JSON.stringify(captured.manifest)).not.toContain("data:image/png");
  });

  it("canonicalizes a linked Stage camera-rig id before every exact-frame render pass", async () => {
    const project = createDefaultDirectorProject();
    const camera = project.cameras[0]!;
    const rig = project.objects.find((object) => object.kind === "camera" && object.linkedCameraId === camera.id)!;
    const capture = vi.fn(async (request) => [
      {
        label: request.renderPass ?? "clean",
        dataUrl: pngDataUrl(`${request.cameraId}:${request.frame}`),
        meta: {
          mode: "camera" as const,
          cameraId: request.cameraId ?? null,
          fov: 35,
          position: [0, 2, 8] as [number, number, number],
          target: [0, 1, 0] as [number, number, number],
        },
      },
    ]);

    const captured = await captureDirectorShotPackage(
      project,
      { cameraId: rig.id, frame: 24, width: 640, height: 360, renderPasses: ["clean"] },
      capture,
    );

    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ cameraId: camera.id, frame: 24 }));
    expect(captured.manifest.shotIr.camera.id).toBe(camera.id);
  });

  it("supports a selected production coverage and a subset of passes", async () => {
    const project = createDefaultDirectorProject();
    const shot = project.production!.sequences[0]!.shots[0]!;
    const capture = vi.fn(async (request) => [
      {
        label: "normal",
        dataUrl: pngDataUrl("normal"),
        meta: {
          mode: "camera" as const,
          cameraId: request.cameraId ?? null,
          fov: 35,
          position: [0, 2, 8] as [number, number, number],
          target: [0, 1, 0] as [number, number, number],
        },
      },
    ]);

    const captured = await captureDirectorShotPackage(
      project,
      {
        coverageShotId: shot.id,
        frame: shot.frameStart,
        width: 640,
        height: 360,
        renderPasses: ["normal"],
      },
      capture,
    );

    expect(captured.manifest.shotIr.production).toMatchObject({ coverageShotId: shot.id });
    expect(captured.manifest.renderPasses.map((pass) => pass.id)).toEqual(["normal"]);
    expect(captured.files).toHaveLength(1);
  });

  it("adds a decodable float EXR depth artifact with semantics when requested", async () => {
    const project = createDefaultDirectorProject();
    const capture = createExrAwareCapture();

    const captured = await captureDirectorShotPackage(
      project,
      { frame: 24, width: 8, height: 6, renderPasses: ["clean", "depth"], includeDepthExr: true },
      capture,
    );

    expect(capture).toHaveBeenCalledTimes(2);
    expect(capture.mock.calls.find(([request]) => request.renderPass === "clean")?.[0].depthFloat).toBeUndefined();
    expect(capture.mock.calls.find(([request]) => request.renderPass === "depth")?.[0].depthFloat).toBe(true);

    expect(captured.files.map((file) => file.path)).toEqual([
      "passes/clean/frame-000024.png",
      "passes/depth/frame-000024.png",
      "passes/depth/frame-000024.exr",
    ]);
    const exrFile = captured.files.find((file) => file.mimeType === "image/x-exr");
    expect(exrFile).toMatchObject({ id: "depth-exr-000024", renderPass: "depth", frame: 24 });

    const artifact = captured.manifest.artifacts.find((candidate) => candidate.id === "depth-exr-000024");
    expect(artifact).toMatchObject({
      kind: "render-pass",
      renderPass: "depth",
      frame: 24,
      path: "passes/depth/frame-000024.exr",
      mimeType: "image/x-exr",
      encoding: "exr",
      colorSpace: "data",
      depthSemantics: {
        representation: "linear-eye-depth",
        units: "metres",
        axis: "camera-forward",
        background: "far-plane",
        projection: "perspective",
        nearM: 0.1,
        farM: 1_000,
        reversedDepthBuffer: true,
        source: "rgba-packed-window-depth",
      },
    });
    expect(artifact?.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(artifact?.byteLength).toBe(dataUrlBytes(exrFile!.dataUrl).byteLength);
    expect(JSON.stringify(captured.manifest)).not.toContain("data:");

    // The encoded EXR must reproduce the readback fixture, centre pixel included.
    const exrBytes = dataUrlBytes(exrFile!.dataUrl);
    const fixture = createDepthFloatFixture(8, 6);
    expect(readExrDepthPixel(exrBytes, 4, 3)).toBe(6.25);
    expect(readExrDepthPixel(exrBytes, 0, 0)).toBe(fixture.depth[0]!);
    expect(readExrDepthPixel(exrBytes, 7, 5)).toBe(fixture.depth[5 * 8 + 7]!);

    const controlJson = captured.sidecars.find((sidecar) => sidecar.path === "ai/control.json");
    expect(JSON.parse(controlJson!.content).inputs.depthExr).toBe("passes/depth/frame-000024.exr");
  });

  it("keeps packages byte-identical when EXR depth is not requested", async () => {
    const project = createDefaultDirectorProject();
    const baseline = await captureDirectorShotPackage(
      project,
      { frame: 24, width: 8, height: 6 },
      createExrAwareCapture(),
    );
    const explicitlyOff = await captureDirectorShotPackage(
      project,
      { frame: 24, width: 8, height: 6, includeDepthExr: false },
      createExrAwareCapture(),
    );

    expect(explicitlyOff.manifest).toEqual(baseline.manifest);
    expect(baseline.files.every((file) => file.mimeType === "image/png")).toBe(true);
    const serialized = JSON.stringify(baseline.manifest);
    expect(serialized).not.toContain("image/x-exr");
    expect(serialized).not.toContain("depthSemantics");
    const controlJson = baseline.sidecars.find((sidecar) => sidecar.path === "ai/control.json");
    expect(JSON.parse(controlJson!.content).inputs.depthExr).toBeUndefined();
  });

  it("fails loudly when the capture handler cannot return float depth", async () => {
    const project = createDefaultDirectorProject();
    const legacyCapture = vi.fn(async (request) => [
      {
        label: request.renderPass ?? "clean",
        dataUrl: pngDataUrl(`${request.renderPass}`),
        meta: {
          mode: "camera" as const,
          cameraId: request.cameraId ?? null,
          fov: 35,
          position: [0, 2, 8] as [number, number, number],
          target: [0, 1, 0] as [number, number, number],
        },
      },
    ]);

    await expect(
      captureDirectorShotPackage(
        project,
        { frame: 24, width: 8, height: 6, renderPasses: ["depth"], includeDepthExr: true },
        legacyCapture,
      ),
    ).rejects.toThrow("cannot encode EXR depth");
  });

  it("rejects EXR depth without the depth pass and mismatched float rasters", async () => {
    const project = createDefaultDirectorProject();
    await expect(
      captureDirectorShotPackage(
        project,
        { frame: 24, width: 8, height: 6, renderPasses: ["clean"], includeDepthExr: true },
        createExrAwareCapture(),
      ),
    ).rejects.toThrow('EXR depth output requires the "depth" render pass.');

    const mismatchedCapture = vi.fn(async (request) => [
      {
        label: request.renderPass ?? "clean",
        dataUrl: pngDataUrl(`${request.renderPass}`),
        meta: {
          mode: "camera" as const,
          cameraId: request.cameraId ?? null,
          fov: 35,
          position: [0, 2, 8] as [number, number, number],
          target: [0, 1, 0] as [number, number, number],
        },
        ...(request.depthFloat ? { depthFloat: createDepthFloatFixture(4, 3) } : {}),
      },
    ]);
    await expect(
      captureDirectorShotPackage(
        project,
        { frame: 24, width: 8, height: 6, renderPasses: ["depth"], includeDepthExr: true },
        mismatchedCapture,
      ),
    ).rejects.toThrow("EXR depth raster 4x3 must match the requested 8x6.");
  });

  it("rejects malformed pass payloads and duplicate pass requests", async () => {
    const project = createDefaultDirectorProject();
    await expect(
      captureDirectorShotPackage(
        project,
        { frame: 0, width: 640, height: 360, renderPasses: ["clean", "clean"] },
        async () => [],
      ),
    ).rejects.toThrow('Duplicate render pass "clean".');
    await expect(
      captureDirectorShotPackage(project, { frame: 0, width: 640, height: 360, renderPasses: ["clean"] }, async () => [
        {
          label: "bad",
          dataUrl: "data:image/jpeg;base64,AAAA",
          meta: { mode: "camera", cameraId: "cam_1", fov: 35, position: [0, 2, 8], target: [0, 1, 0] },
        },
      ]),
    ).rejects.toThrow("base64 PNG");
  });
});
