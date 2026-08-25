import JSZip from "jszip";
import { expect, it, vi } from "vitest";
import { createDefaultDirectorProject } from "../../../../src/comprehensive/editor/store/directorStore";
import { buildDirectorShotIr } from "../../../../src/comprehensive/editor/shot/shotIr";
import { computeDirectorDenseMotionFlow, DIRECTOR_DENSE_MOTION_FLOW_SEMANTICS } from "../../../../src/comprehensive/editor/render/denseMotionFlow";
import { exportDirectorMultimodalFramePackage } from "../../../../src/comprehensive/editor/video/multimodalFrameExport";

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

function motionFlowField(frame: number, width = 2, height = 2) {
  return computeDirectorDenseMotionFlow({
    width,
    height,
    fromFrame: Math.max(0, frame - 1),
    toFrame: frame,
    fromCamera: { position: [0, 0, 5], target: [0, 0, 0], fovDegrees: 60, aspect: 1 },
    toCamera: { position: [1, 0, 5], target: [1, 0, 0], fovDegrees: 60, aspect: 1 },
    toDepth: new Float32Array(width * height).fill(5),
  });
}

function metricDepth(width = 2, height = 2) {
  return {
    depth: new Float32Array(width * height).fill(4.5),
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
        reversedDepthBuffer: false,
        source: "rgba-packed-window-depth" as const,
      },
    },
  };
}

it("packages the selected passes and optional per-frame state only", async () => {
  const project = createDefaultDirectorProject();
  const capturePass = vi.fn(async (frame: number, renderPass: string) =>
    png(2, 2, frame + (renderPass === "depth" ? 10 : 0)),
  );
  const buildShot = vi.fn((frame: number) => buildDirectorShotIr(project, { frame }));

  const exported = await exportDirectorMultimodalFramePackage({
    frameStart: 0,
    frameEnd: 1,
    fps: 24,
    selection: {
      renderPasses: ["clean", "depth"],
      includeCamera: true,
      includeObjects: false,
    },
    capturePass,
    buildShotIr: buildShot,
  });

  expect(capturePass.mock.calls.map(([frame, pass]) => [frame, pass])).toEqual([
    [0, "clean"],
    [0, "depth"],
    [1, "clean"],
    [1, "depth"],
  ]);
  expect(buildShot).toHaveBeenCalledTimes(2);
  expect(exported.kind).toBe("multimodal-dataset");
  expect(exported.archive.type).toBe("application/zip");
  expect(exported.manifest.selection).toEqual({
    renderPasses: ["clean", "depth"],
    includeCamera: true,
    includeObjects: false,
  });
  expect(exported.manifest.artifacts.filter((artifact) => artifact.kind === "render-pass")).toHaveLength(4);
  expect(exported.manifest.artifacts).toContainEqual(
    expect.objectContaining({ path: "metadata/frames.jsonl", kind: "frame-metadata" }),
  );
  expect(exported.manifest.packageFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
});

it("requires at least one image channel", async () => {
  const project = createDefaultDirectorProject();
  await expect(
    exportDirectorMultimodalFramePackage({
      frameStart: 0,
      frameEnd: 0,
      fps: 24,
      selection: { renderPasses: [], includeCamera: true, includeObjects: true },
      capturePass: async () => png(),
      buildShotIr: (frame) => buildDirectorShotIr(project, { frame }),
    }),
  ).rejects.toThrow("Select at least one render pass.");
});

it("adds metric depth EXR beside each selected depth PNG", async () => {
  const project = createDefaultDirectorProject();
  const exported = await exportDirectorMultimodalFramePackage({
    frameStart: 0,
    frameEnd: 1,
    fps: 24,
    selection: {
      renderPasses: ["depth"],
      includeCamera: false,
      includeObjects: false,
      depthExr: true,
    },
    capturePass: async (frame, renderPass) => ({
      image: png(2, 2, frame),
      ...(renderPass === "depth" ? { depthFloat: metricDepth() } : {}),
    }),
    buildShotIr: (frame) => buildDirectorShotIr(project, { frame }),
  });

  expect(exported.manifest.selection.depthExr).toBe(true);
  const artifacts = exported.manifest.artifacts.filter((artifact) => artifact.kind === "depth-exr");
  expect(artifacts).toHaveLength(2);
  expect(artifacts.map((artifact) => artifact.path)).toEqual([
    "passes/depth/frame-000000.exr",
    "passes/depth/frame-000001.exr",
  ]);
  expect(artifacts[0]).toMatchObject({
    encoding: "exr",
    depthSemantics: { representation: "linear-eye-depth", units: "metres" },
  });
  const zip = await JSZip.loadAsync(await exported.archive.arrayBuffer());
  expect(zip.file("passes/depth/frame-000000.exr")).not.toBeNull();
  expect(await zip.file("passes/depth/frame-000000.exr")!.async("uint8array")).not.toHaveLength(0);
});

it("exports per-frame instance colors, visible pixels, and pixel bounds", async () => {
  const project = createDefaultDirectorProject();
  const object = buildDirectorShotIr(project, { frame: 0 }).objects[0]!;
  const rgba = new Uint8Array([11, 22, 33, 255, 11, 22, 33, 255, 0, 0, 0, 255, 0, 0, 0, 255]);
  const capturePass = vi.fn(async (_frame: number, renderPass: string) =>
    renderPass === "object-id"
      ? {
          image: png(2, 2),
          renderPixels: { width: 2, height: 2, data: rgba },
          objectIdColors: { [object.id]: [11, 22, 33] as [number, number, number] },
        }
      : png(2, 2),
  );

  const exported = await exportDirectorMultimodalFramePackage({
    frameStart: 0,
    frameEnd: 0,
    fps: 24,
    selection: {
      renderPasses: ["clean"],
      includeCamera: false,
      includeObjects: false,
      includeInstanceAnnotations: true,
    },
    capturePass,
    buildShotIr: (frame) => buildDirectorShotIr(project, { frame }),
  });

  expect(capturePass.mock.calls.map(([, pass]) => pass)).toEqual(["clean", "object-id"]);
  const artifact = exported.manifest.artifacts.find((candidate) => candidate.kind === "instance-annotations");
  expect(artifact).toMatchObject({ path: "annotations/instances/frame-000000.json", frame: 0 });
  const zip = await JSZip.loadAsync(await exported.archive.arrayBuffer());
  const annotations = JSON.parse(await zip.file("annotations/instances/frame-000000.json")!.async("text"));
  expect(annotations).toMatchObject({
    contract: "director-instance-annotations-v1",
    frame: 0,
    raster: { width: 2, height: 2, origin: "top-left" },
  });
  expect(annotations.instances.find((entry: { objectId: string }) => entry.objectId === object.id)).toMatchObject({
    rgb: [11, 22, 33],
    visiblePixels: 2,
    frameCoverage: 0.5,
    bounds: { x: 0, y: 0, width: 2, height: 1 },
  });
});

it("ships object-id and semantic decoding metadata without requiring instance annotations", async () => {
  const project = createDefaultDirectorProject();
  const objectIdColors = { "object-a": [12, 34, 56] as [number, number, number] };
  const categoryColors = {
    character: [150, 5, 61] as [number, number, number],
    prop: [0, 102, 200] as [number, number, number],
    environment: [4, 200, 3] as [number, number, number],
    background: [0, 0, 0] as [number, number, number],
  };

  const exported = await exportDirectorMultimodalFramePackage({
    frameStart: 0,
    frameEnd: 0,
    fps: 24,
    selection: {
      renderPasses: ["object-id", "semantic"],
      includeCamera: false,
      includeObjects: false,
    },
    capturePass: async (_frame, renderPass) => ({
      image: png(2, 2),
      ...(renderPass === "object-id" ? { objectIdColors } : { categoryColors }),
    }),
    buildShotIr: (frame) => buildDirectorShotIr(project, { frame }),
  });

  const zip = await JSZip.loadAsync(await exported.archive.arrayBuffer());
  const objectMetadata = JSON.parse(
    await zip.file("metadata/segmentation/object-id/frame-000000.json")!.async("text"),
  );
  const semanticMetadata = JSON.parse(
    await zip.file("metadata/segmentation/semantic/frame-000000.json")!.async("text"),
  );
  expect(objectMetadata).toMatchObject({
    contract: "director-segmentation-metadata-v1",
    frame: 0,
    renderPass: "object-id",
    raster: { width: 2, height: 2, origin: "top-left" },
    objectIdToRgb: objectIdColors,
  });
  expect(semanticMetadata).toMatchObject({
    contract: "director-segmentation-metadata-v1",
    frame: 0,
    renderPass: "semantic",
    categoryToRgb: categoryColors,
  });
  expect(exported.manifest.artifacts.filter((artifact) => artifact.kind === "segmentation-metadata")).toHaveLength(2);
});

it("requires depth data and object-id pixels only when their opt-in channels are selected", async () => {
  const project = createDefaultDirectorProject();
  const base = {
    frameStart: 0,
    frameEnd: 0,
    fps: 24,
    buildShotIr: (frame: number) => buildDirectorShotIr(project, { frame }),
  };

  await expect(
    exportDirectorMultimodalFramePackage({
      ...base,
      selection: {
        renderPasses: ["clean"],
        includeCamera: false,
        includeObjects: false,
        depthExr: true,
      },
      capturePass: async () => png(),
    }),
  ).rejects.toThrow('Metric depth EXR requires the "depth" render pass.');

  await expect(
    exportDirectorMultimodalFramePackage({
      ...base,
      selection: {
        renderPasses: ["clean"],
        includeCamera: false,
        includeObjects: false,
        includeInstanceAnnotations: true,
      },
      capturePass: async () => png(),
    }),
  ).rejects.toThrow("Instance annotations require object-id pixels and color metadata.");
});

it("adds dense motion flow EXR artifacts with fingerprints and semantics when enabled", async () => {
  const project = createDefaultDirectorProject();
  const captureMotionFlow = vi.fn(async (frame: number) => motionFlowField(frame));

  const exported = await exportDirectorMultimodalFramePackage({
    frameStart: 0,
    frameEnd: 1,
    fps: 24,
    selection: { renderPasses: ["clean"], includeCamera: false, includeObjects: false, denseMotionExr: true },
    capturePass: async (frame) => png(2, 2, frame),
    captureMotionFlow,
    buildShotIr: (frame) => buildDirectorShotIr(project, { frame }),
  });

  expect(captureMotionFlow.mock.calls.map(([frame]) => frame)).toEqual([0, 1]);
  expect(exported.manifest.selection.denseMotionExr).toBe(true);
  expect(exported.manifest.motionFlowSemantics).toEqual(DIRECTOR_DENSE_MOTION_FLOW_SEMANTICS);

  const flowArtifacts = exported.manifest.artifacts.filter((artifact) => artifact.kind === "motion-flow-exr");
  expect(flowArtifacts).toHaveLength(2);
  expect(flowArtifacts.map((artifact) => artifact.path)).toEqual([
    "passes/motion/frame-000000.exr",
    "passes/motion/frame-000001.exr",
  ]);
  flowArtifacts.forEach((artifact, index) => {
    expect(artifact.frame).toBe(index);
    expect(artifact.renderPass).toBe("motion");
    expect(artifact.encoding).toBe("exr");
    expect(artifact.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(artifact.byteLength).toBeGreaterThan(0);
  });
  expect(exported.manifest.packageFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
});

it("keeps the package byte-identical when the dense motion flow channel stays off", async () => {
  const project = createDefaultDirectorProject();
  const exportWith = (selection: Parameters<typeof exportDirectorMultimodalFramePackage>[0]["selection"]) =>
    exportDirectorMultimodalFramePackage({
      frameStart: 0,
      frameEnd: 1,
      fps: 24,
      selection,
      capturePass: async (frame, renderPass) => png(2, 2, frame + (renderPass === "depth" ? 10 : 0)),
      buildShotIr: (frame) => buildDirectorShotIr(project, { frame }),
    });

  const legacySelection = await exportWith({ renderPasses: ["clean"], includeCamera: true, includeObjects: false });
  const explicitFalse = await exportWith({
    renderPasses: ["clean"],
    includeCamera: true,
    includeObjects: false,
    denseMotionExr: false,
  });

  expect(explicitFalse.manifest.packageFingerprint).toBe(legacySelection.manifest.packageFingerprint);
  expect("denseMotionExr" in explicitFalse.manifest.selection).toBe(false);
  expect("motionFlowSemantics" in explicitFalse.manifest).toBe(false);
  expect(explicitFalse.manifest.artifacts.some((artifact) => artifact.kind === "motion-flow-exr")).toBe(false);
  expect(new Uint8Array(await explicitFalse.archive.arrayBuffer())).toEqual(
    new Uint8Array(await legacySelection.archive.arrayBuffer()),
  );
});

it("rejects a dense motion flow selection without a capture callback", async () => {
  const project = createDefaultDirectorProject();
  await expect(
    exportDirectorMultimodalFramePackage({
      frameStart: 0,
      frameEnd: 0,
      fps: 24,
      selection: { renderPasses: ["clean"], includeCamera: false, includeObjects: false, denseMotionExr: true },
      capturePass: async () => png(),
      buildShotIr: (frame) => buildDirectorShotIr(project, { frame }),
    }),
  ).rejects.toThrow("Dense motion flow EXR export requires a captureMotionFlow callback.");
});

it("rejects dense motion flow rasters that do not match the render passes", async () => {
  const project = createDefaultDirectorProject();
  await expect(
    exportDirectorMultimodalFramePackage({
      frameStart: 0,
      frameEnd: 0,
      fps: 24,
      selection: { renderPasses: ["clean"], includeCamera: false, includeObjects: false, denseMotionExr: true },
      capturePass: async () => png(2, 2),
      captureMotionFlow: async (frame) => motionFlowField(frame, 3, 3),
      buildShotIr: (frame) => buildDirectorShotIr(project, { frame }),
    }),
  ).rejects.toThrow("Dense motion flow at frame 0 is 3x3; expected 2x2.");
});
