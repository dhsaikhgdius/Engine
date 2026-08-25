import { describe, expect, it } from "vitest";
import type { DirectorShotIr } from "../../../../src/comprehensive/editor/shot/shotIr";
import {
  buildDirectorShotPackage,
  DEFAULT_DIRECTOR_SHOT_RENDER_PASSES,
  type DirectorShotDepthSemantics,
  type DirectorShotPackageArtifactInput,
} from "../../../../src/comprehensive/editor/shot/shotPackage";

function createShotIr(): DirectorShotIr {
  return {
    schemaVersion: 1,
    id: "director-shot:camera-main:frame:12",
    revisionFingerprint: "fnv1a32:12345678",
    projectVersion: 1,
    fps: 24,
    frame: 12,
    timeSeconds: 0.5,
    camera: {
      id: "camera-main",
      name: "Main",
      position: [0, 2, 8],
      target: [0, 1, 0],
      fov: 35,
      focalLengthMm: 50,
      aspectRatio: "16:9",
      aspectValue: 16 / 9,
      sensor: {
        format: "super35",
        gateWidthMm: 24.89,
        gateHeightMm: 18.66,
        usedWidthMm: 24.89,
        usedHeightMm: 14.000625,
      },
      actionMode: "still",
      targetMode: "manual",
      referenceRefs: [],
    },
    objects: [],
  };
}

const artifacts: DirectorShotPackageArtifactInput[] = [
  {
    id: "clean-12",
    kind: "render-pass",
    renderPass: "clean",
    frame: 12,
    path: "passes/clean/frame-000012.png",
    mimeType: "image/png",
    content: "hello",
  },
  {
    id: "metadata",
    kind: "metadata",
    path: "metadata/shot.json",
    mimeType: "application/json",
    content: '{"shot":12}',
  },
];

describe("buildDirectorShotPackage", () => {
  it("builds a stable clean multi-pass manifest with content hashes and no binary payloads", async () => {
    const options = { frameStart: 0, frameEnd: 24, width: 1920, height: 1080, artifacts };

    const first = await buildDirectorShotPackage(createShotIr(), options);
    const reordered = await buildDirectorShotPackage(createShotIr(), {
      ...options,
      artifacts: [...artifacts].reverse(),
    });

    expect(reordered).toEqual(first);
    expect(first.packageFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.packageId).toMatch(/^director-package:[0-9a-f]{24}$/);
    expect(first.frameRange).toEqual({
      start: 0,
      end: 24,
      fps: 24,
      timebase: {
        rate: "24/1",
        numerator: 24,
        denominator: 1,
        dropFrame: false,
        startTimecode: "00:00:00:00",
      },
      timecodeStart: "00:00:00:00",
      timecodeEnd: "00:00:01:00",
      frameCount: 25,
    });
    expect(first.renderPasses.map((pass) => pass.id)).toEqual(["clean", "depth", "mask", "normal", "object-id"]);
    expect(first.renderPasses.every((pass) => pass.includesHelpers === false)).toBe(true);
    expect(first.renderPasses.every((pass) => pass.bitDepth === 8)).toBe(true);
    expect(first.artifacts[0]).toMatchObject({
      id: "clean-12",
      byteLength: 5,
      sha256: "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    });
    expect(JSON.stringify(first)).not.toContain("hello");
    expect(JSON.stringify(first)).not.toMatch(/data:|blob:/);
  });

  it("changes artifact and package fingerprints when output bytes change", async () => {
    const base = await buildDirectorShotPackage(createShotIr(), {
      frameStart: 12,
      frameEnd: 12,
      width: 1280,
      height: 720,
      artifacts: [artifacts[0]!],
    });
    const changed = await buildDirectorShotPackage(createShotIr(), {
      frameStart: 12,
      frameEnd: 12,
      width: 1280,
      height: 720,
      artifacts: [{ ...artifacts[0]!, content: "different" }],
    });

    expect(changed.artifacts[0]?.sha256).not.toBe(base.artifacts[0]?.sha256);
    expect(changed.packageFingerprint).not.toBe(base.packageFingerprint);
  });

  it("preserves an exact rational drop-frame timebase in the portable manifest", async () => {
    const shotIr = createShotIr();
    shotIr.fps = 30_000 / 1_001;
    shotIr.frame = 1_800;
    shotIr.timeSeconds = 1_800 / shotIr.fps;
    shotIr.timebase = {
      rate: "30000/1001",
      numerator: 30_000,
      denominator: 1_001,
      dropFrame: true,
      startTimecode: "00:00:00;00",
    };
    shotIr.timecode = "00:01:00;02";

    const manifest = await buildDirectorShotPackage(shotIr, {
      frameStart: 1_800,
      frameEnd: 1_800,
      width: 1920,
      height: 1080,
    });

    expect(manifest.frameRange).toMatchObject({
      fps: 30_000 / 1_001,
      timebase: {
        rate: "30000/1001",
        numerator: 30_000,
        denominator: 1_001,
        dropFrame: true,
      },
      timecodeStart: "00:01:00;02",
      timecodeEnd: "00:01:00;02",
    });
  });

  it("rejects unsafe paths, duplicate artifacts, and frames outside the package range", async () => {
    await expect(
      buildDirectorShotPackage(createShotIr(), {
        frameStart: 0,
        frameEnd: 24,
        width: 1920,
        height: 1080,
        artifacts: [{ ...artifacts[0]!, path: "../capture.png" }],
      }),
    ).rejects.toThrow("must not contain empty, dot, parent, or backslash segments");

    await expect(
      buildDirectorShotPackage(createShotIr(), {
        frameStart: 0,
        frameEnd: 24,
        width: 1920,
        height: 1080,
        artifacts: [artifacts[0]!, { ...artifacts[0]!, path: "other.png" }],
      }),
    ).rejects.toThrow('Duplicate artifact id "clean-12".');

    await expect(
      buildDirectorShotPackage(createShotIr(), {
        frameStart: 0,
        frameEnd: 10,
        width: 1920,
        height: 1080,
      }),
    ).rejects.toThrow("ShotIR frame 12 is outside package range 0-10.");
  });

  const depthSemantics: DirectorShotDepthSemantics = {
    representation: "linear-eye-depth",
    units: "metres",
    axis: "camera-forward",
    background: "far-plane",
    projection: "perspective",
    nearM: 0.1,
    farM: 1_000,
    reversedDepthBuffer: true,
    source: "rgba-packed-window-depth",
  };
  const exrArtifact: DirectorShotPackageArtifactInput = {
    id: "depth-exr-000012",
    kind: "render-pass",
    renderPass: "depth",
    frame: 12,
    path: "passes/depth/frame-000012.exr",
    mimeType: "image/x-exr",
    content: new Uint8Array([1, 2, 3, 4]),
    encoding: "exr",
    colorSpace: "data",
    depthSemantics,
  };

  it("hashes EXR depth artifacts through the same mechanics and embeds their semantics", async () => {
    const manifest = await buildDirectorShotPackage(createShotIr(), {
      frameStart: 0,
      frameEnd: 24,
      width: 1920,
      height: 1080,
      artifacts: [artifacts[0]!, exrArtifact],
    });

    const entry = manifest.artifacts.find((artifact) => artifact.id === "depth-exr-000012");
    expect(entry).toMatchObject({
      kind: "render-pass",
      renderPass: "depth",
      path: "passes/depth/frame-000012.exr",
      mimeType: "image/x-exr",
      byteLength: 4,
      encoding: "exr",
      colorSpace: "data",
      depthSemantics,
    });
    expect(entry?.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    const pngEntry = manifest.artifacts.find((artifact) => artifact.id === "clean-12");
    expect(pngEntry && "encoding" in pngEntry).toBe(false);
  });

  it("binds the package fingerprint to the depth semantics", async () => {
    const options = { frameStart: 0, frameEnd: 24, width: 1920, height: 1080 };
    const base = await buildDirectorShotPackage(createShotIr(), { ...options, artifacts: [exrArtifact] });
    const changed = await buildDirectorShotPackage(createShotIr(), {
      ...options,
      artifacts: [{ ...exrArtifact, depthSemantics: { ...depthSemantics, farM: 500 } }],
    });
    expect(changed.packageFingerprint).not.toBe(base.packageFingerprint);
  });

  it("rejects inconsistent EXR artifact metadata", async () => {
    const options = { frameStart: 0, frameEnd: 24, width: 1920, height: 1080 };
    const build = (artifact: DirectorShotPackageArtifactInput) =>
      buildDirectorShotPackage(createShotIr(), { ...options, artifacts: [artifact] });

    await expect(build({ ...exrArtifact, colorSpace: undefined })).rejects.toThrow(
      "must declare encoding and colorSpace together",
    );
    await expect(build({ ...exrArtifact, mimeType: "image/png" })).rejects.toThrow('must use mimeType "image/x-exr"');
    await expect(
      build({ ...exrArtifact, kind: "metadata", renderPass: undefined, depthSemantics: undefined }),
    ).rejects.toThrow("must be a render-pass artifact");
    await expect(build({ ...exrArtifact, renderPass: "clean", path: "passes/clean/frame-000012.exr" })).rejects.toThrow(
      "only valid on an EXR depth render pass",
    );
    await expect(build({ ...exrArtifact, depthSemantics: { ...depthSemantics, nearM: 0 } })).rejects.toThrow(
      "requires 0 < nearM < farM",
    );
  });

  it("rejects helper-bearing or incomplete render-pass contracts", async () => {
    await expect(
      buildDirectorShotPackage(createShotIr(), {
        frameStart: 12,
        frameEnd: 12,
        width: 1920,
        height: 1080,
        renderPasses: [
          {
            ...DEFAULT_DIRECTOR_SHOT_RENDER_PASSES[0]!,
            includesHelpers: true as false,
          },
        ],
      }),
    ).rejects.toThrow('Render pass "clean" must exclude editor helpers.');

    await expect(
      buildDirectorShotPackage(createShotIr(), {
        frameStart: 12,
        frameEnd: 12,
        width: 1920,
        height: 1080,
        renderPasses: [{ ...DEFAULT_DIRECTOR_SHOT_RENDER_PASSES[0]!, pathTemplate: "passes/clean.png" }],
      }),
    ).rejects.toThrow("pathTemplate must contain {frame:06}");
  });
});
