// @vitest-environment node

import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  directorDccExchangePackageManifestSchema,
  directorDccExchangePackageResultSchema,
} from "@director/dcc-protocol";
import { directorDccProviderDescriptorSchema } from "@director/dcc-protocol";
import { getDirectorProjectRevision } from "@director/project-schema";
import { createTestDirectorProject } from "../fixtures/createTestDirectorProject";
import { createDirectorDccExchangePackager, type CreateDirectorDccExchangePackagerOptions } from "../../dcc/dccExchangePackage";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function harness(
  overrides: Omit<Partial<CreateDirectorDccExchangePackagerOptions>, "workspaceRoot" | "dataDirectory"> = {},
) {
  const root = await mkdtemp(resolve(tmpdir(), "director-dcc-exchange-"));
  roots.push(root);
  const workspaceRoot = resolve(root, "workspace");
  const dataDirectory = resolve(root, "data");
  await mkdir(resolve(workspaceRoot, "assets", "library"), { recursive: true });
  await writeFile(resolve(workspaceRoot, "assets", "library", "chair.glb"), Buffer.from("glTF fixture bytes"));
  const project = createTestDirectorProject();
  project.scene.timeline = {
    version: 1,
    fps: 24,
    timebase: {
      rate: { numerator: 24, denominator: 1 },
      dropFrame: false,
      startTimecode: "01:00:00:00",
    },
    frameStart: 0,
    frameEnd: 120,
    currentFrame: 0,
    loop: false,
  };
  project.assets.push({
    id: "asset-chair",
    kind: "prop",
    sourceType: "model",
    fileName: "chair.glb",
    url: "/chair.glb",
  });
  project.objects.push({
    id: "chair-1",
    name: "Chair",
    kind: "prop",
    visible: true,
    locked: false,
    assetRefId: "asset-chair",
    transform: { position: [1, 0, -2], rotation: [0, 0.25, 0], scale: [1, 1, 1] },
  });
  project.cameras.push({
    id: "camera-a",
    name: "Camera A",
    fov: 50,
    focalLengthMm: 35,
    transform: { position: [0, 2, 5], rotation: [0, 0, 0], scale: [1, 1, 1] },
    targetMode: "manual",
    target: [0, 1, 0],
  });
  project.activeCameraId = "camera-a";
  return {
    root,
    workspaceRoot,
    dataDirectory,
    project,
    packager: createDirectorDccExchangePackager({ workspaceRoot, dataDirectory, ...overrides }),
  };
}

async function useExternalBufferGltf(test: Awaited<ReturnType<typeof harness>>, uri = "chair.bin") {
  const positions = Buffer.alloc(3 * 3 * Float32Array.BYTES_PER_ELEMENT);
  await writeFile(resolve(test.workspaceRoot, "assets", "library", "chair.bin"), positions);
  await writeFile(
    resolve(test.workspaceRoot, "assets", "library", "chair.gltf"),
    JSON.stringify({
      asset: { version: "2.0" },
      buffers: [{ uri, byteLength: positions.byteLength }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength, target: 34962 }],
      accessors: [
        {
          bufferView: 0,
          byteOffset: 0,
          componentType: 5126,
          count: 3,
          type: "VEC3",
          min: [0, 0, 0],
          max: [0, 0, 0],
        },
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      nodes: [{ mesh: 0 }],
      scenes: [{ nodes: [0] }],
      scene: 0,
    }),
  );
  test.project.assets[0]!.fileName = "chair.gltf";
  test.project.assets[0]!.url = "/chair.gltf";
}

describe("Director DCC exchange package", () => {
  it("creates a canonical, hashed USD/GLB package with separate model payloads", async () => {
    const test = await harness();
    const result = await test.packager.exportPackage(test.project, { provider: "maya", frame: 24 });

    expect(directorDccExchangePackageResultSchema.parse(result)).toEqual(result);
    expect(result.provider).toBe("maya");
    expect(result.formats.map(({ format }) => format)).toEqual(["usda", "glb"]);
    expect(result.assets).toEqual([
      expect.objectContaining({
        assetRefId: "asset-chair",
        relativePath: expect.stringMatching(/^assets\/001-asset-chair\.glb$/),
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    ]);

    const manifest = directorDccExchangePackageManifestSchema.parse(
      JSON.parse(await readFile(result.manifestPath, "utf8")),
    );
    expect(result.manifestSha256).toBe(
      createHash("sha256")
        .update(await readFile(result.manifestPath))
        .digest("hex"),
    );
    expect(result.packageDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.coordinateSystem).toEqual({
      linearUnit: "meter",
      metersPerUnit: 1,
      upAxis: "Y",
      handedness: "right",
      cameraForward: "-Z",
    });
    expect(manifest.project.scene.timeline?.currentFrame).toBe(24);
    expect(manifest.project.objects[0]?.transform.position).toEqual([1, 0, -2]);
    expect(await readFile(result.assets[0]!.path, "utf8")).toBe("glTF fixture bytes");
    expect(result.warnings.join(" ")).toContain("model payloads remain separate");
  });

  it("bakes the selected frame while retaining the original canonical source revision", async () => {
    const test = await harness();
    const object = test.project.objects[0]!;
    object.animation = {
      version: 1,
      keyframes: [
        { frame: 0, interpolation: "linear", transform: structuredClone(object.transform) },
        {
          frame: 24,
          interpolation: "linear",
          transform: { ...structuredClone(object.transform), position: [5, 0, -2] },
        },
      ],
    };
    const camera = test.project.cameras[0]!;
    camera.animation = {
      version: 1,
      keyframes: [
        {
          frame: 0,
          interpolation: "linear",
          transform: structuredClone(camera.transform),
          lookTarget: structuredClone(camera.target),
          fov: 50,
        },
        {
          frame: 24,
          interpolation: "linear",
          transform: { ...structuredClone(camera.transform), position: [4, 2, 5] },
          lookTarget: [2, 1, 0],
          fov: 70,
        },
      ],
    };
    test.project.cameras.push({ ...structuredClone(camera), id: "camera-b", name: "Camera B" });
    const sourceRevision = getDirectorProjectRevision(test.project);

    const result = await test.packager.exportPackage(test.project, {
      provider: "maya",
      formats: ["usda"],
      cameraId: "camera-b",
      frame: 12,
    });
    const manifest = directorDccExchangePackageManifestSchema.parse(
      JSON.parse(await readFile(result.manifestPath, "utf8")),
    );
    const usda = await readFile(result.formats[0]!.path, "utf8");

    expect(result.sourceRevision).toBe(sourceRevision);
    expect(manifest.sourceRevision).toBe(sourceRevision);
    expect(manifest.project.activeCameraId).toBe("camera-b");
    expect(manifest.project.scene.timeline?.currentFrame).toBe(12);
    expect(manifest.project.objects[0]?.transform.position).toEqual([3, 0, -2]);
    expect(manifest.project.cameras[0]?.transform.position).toEqual([2, 2, 5]);
    expect(manifest.project.cameras[0]?.target).toEqual([1, 1, 0]);
    expect(manifest.project.cameras[0]?.fov).toBe(60);
    expect(usda).toContain("double3 xformOp:translate = (3, 0, -2)");
    expect(usda).toContain("double3 xformOp:translate = (2, 2, 5)");
    expect(test.project.scene.timeline?.currentFrame).toBe(0);
    expect(test.project.objects[0]?.transform.position).toEqual([1, 0, -2]);
    expect(
      directorDccExchangePackageResultSchema.safeParse({ ...result, sourceRevision: "not-a-revision" }).success,
    ).toBe(false);
  });

  it("enforces provider format capabilities and exchange readiness", async () => {
    const test = await harness();
    const usdaOnly = directorDccProviderDescriptorSchema.parse({
      id: "studio.openusd",
      label: "Studio OpenUSD",
      category: "dcc",
      integration: "exchange-package",
      preferredFormat: "usda",
      exchangeFormats: ["usda"],
      capabilities: [{ id: "scene", level: "exchange" }],
      connectorDirectory: "integrations/studio.openusd",
    });
    const blendOnly = directorDccProviderDescriptorSchema.parse({
      ...usdaOnly,
      id: "studio.native",
      label: "Studio Native",
      preferredFormat: "blend",
      exchangeFormats: ["blend"],
      connectorDirectory: "integrations/studio.native",
    });

    await expect(
      test.packager.exportPackage(test.project, {
        provider: usdaOnly.id,
        descriptor: usdaOnly,
        formats: ["glb"],
      }),
    ).rejects.toThrow(/does not advertise portable format glb/i);
    await expect(
      test.packager.exportPackage(test.project, { provider: blendOnly.id, descriptor: blendOnly }),
    ).rejects.toThrow(/does not advertise a portable GLB or USDA/i);
    await expect(test.packager.exportPackage(test.project, { provider: "maya", exchangeReady: false })).rejects.toThrow(
      /portable exchange is not ready/i,
    );
  });

  it("converts external-resource glTF assets into self-contained GLB payloads", async () => {
    const test = await harness();
    await useExternalBufferGltf(test);

    const result = await test.packager.exportPackage(test.project, { provider: "maya", formats: ["usda"] });

    expect(result.assets).toEqual([
      expect.objectContaining({
        assetRefId: "asset-chair",
        relativePath: "assets/001-asset-chair.glb",
      }),
    ]);
    expect((await readFile(result.assets[0]!.path)).subarray(0, 4).toString("utf8")).toBe("glTF");
  });

  it("skips glTF assets with unsafe dependencies instead of publishing a partial payload", async () => {
    const test = await harness();
    await useExternalBufferGltf(test, "../outside.bin");

    const result = await test.packager.exportPackage(test.project, { provider: "maya", formats: ["usda"] });

    expect(result.assets).toEqual([]);
    expect(result.warnings.join(" ")).toMatch(/could not be safely converted.*safe local relative path/i);
  });

  it("supports open third-party providers when the registry supplies a descriptor", async () => {
    const test = await harness();
    const descriptor = directorDccProviderDescriptorSchema.parse({
      id: "studio.openusd",
      label: "Studio OpenUSD",
      category: "dcc",
      integration: "exchange-package",
      preferredFormat: "usda",
      exchangeFormats: ["usda"],
      capabilities: [{ id: "scene", level: "exchange" }],
      connectorDirectory: "integrations/studio.openusd",
    });
    const result = await test.packager.exportPackage(test.project, {
      provider: descriptor.id,
      descriptor,
    });

    expect(result.provider).toBe("studio.openusd");
    expect(result.formats.map(({ format }) => format)).toEqual(["usda"]);
  });

  it("reports missing model payloads without publishing an invalid file reference", async () => {
    const test = await harness();
    test.project.assets[0]!.url = "/missing.glb";
    const result = await test.packager.exportPackage(test.project, { provider: "unreal", formats: ["usda"] });

    expect(result.assets).toEqual([]);
    expect(result.warnings.join(" ")).toContain("missing.glb");
    const manifest = directorDccExchangePackageManifestSchema.parse(
      JSON.parse(await readFile(result.manifestPath, "utf8")),
    );
    expect(manifest.assets).toEqual([]);
  });

  it("enforces asset-count, per-file, and total-package byte budgets", async () => {
    const assetCount = await harness({ budgets: { maxAssets: 1 } });
    assetCount.project.assets.push({
      id: "asset-chair-copy",
      kind: "prop",
      sourceType: "model",
      fileName: "chair.glb",
      url: "/chair.glb",
    });
    assetCount.project.objects.push({
      ...structuredClone(assetCount.project.objects[0]!),
      id: "chair-2",
      name: "Chair 2",
      assetRefId: "asset-chair-copy",
    });
    await expect(
      assetCount.packager.exportPackage(assetCount.project, { provider: "maya", formats: ["usda"] }),
    ).rejects.toThrow(/2 model assets.*limit of 1/i);

    const perFile = await harness({ budgets: { maxFileBytes: 512 * 1024 } });
    await writeFile(resolve(perFile.workspaceRoot, "assets", "library", "chair.glb"), Buffer.alloc(768 * 1024));
    await expect(
      perFile.packager.exportPackage(perFile.project, { provider: "maya", formats: ["usda"] }),
    ).rejects.toThrow(/per-file budget/i);

    const total = await harness({ budgets: { maxPackageBytes: 1 } });
    await expect(total.packager.exportPackage(total.project, { provider: "maya", formats: ["usda"] })).rejects.toThrow(
      /package budget/i,
    );
  });

  it("copies only model assets referenced by exported scene objects", async () => {
    const test = await harness();
    test.project.assets.push({
      id: "asset-unused",
      kind: "prop",
      sourceType: "model",
      fileName: "chair.glb",
      url: "/chair.glb",
    });

    const result = await test.packager.exportPackage(test.project, { provider: "maya", formats: ["usda"] });

    expect(result.assets.map(({ assetRefId }) => assetRefId)).toEqual(["asset-chair"]);
  });

  it("bounds concurrent exports and releases the slot after completion", async () => {
    let releaseConversion!: () => void;
    let announceConversion!: () => void;
    const conversionStarted = new Promise<void>((resolveStarted) => {
      announceConversion = resolveStarted;
    });
    const conversionGate = new Promise<void>((resolveGate) => {
      releaseConversion = resolveGate;
    });
    const test = await harness({
      budgets: { maxConcurrentExports: 1 },
      convertGltfToGlb: async (_inputPath, outputPath) => {
        announceConversion();
        await conversionGate;
        await writeFile(outputPath, Buffer.from("glTF test payload"));
      },
    });
    await useExternalBufferGltf(test);

    const first = test.packager.exportPackage(test.project, { provider: "maya", formats: ["usda"] });
    await conversionStarted;
    await expect(test.packager.exportPackage(test.project, { provider: "maya", formats: ["usda"] })).rejects.toThrow(
      /concurrent export limit of 1/i,
    );
    releaseConversion();
    await expect(first).resolves.toMatchObject({ provider: "maya" });
    await expect(
      test.packager.exportPackage(test.project, { provider: "maya", formats: ["usda"] }),
    ).resolves.toMatchObject({ provider: "maya" });
  });

  it("rejects invalid camera/frame selections and removes staging directories", async () => {
    const test = await harness();
    await expect(
      test.packager.exportPackage(test.project, { provider: "houdini", cameraId: "missing-camera" }),
    ).rejects.toThrow(/does not exist/);
    await expect(test.packager.exportPackage(test.project, { provider: "houdini", frame: 121 })).rejects.toThrow(
      /outside 0-120/,
    );

    const exchangeRoot = resolve(test.dataDirectory, "dcc-jobs", "exchange");
    await expect(readdir(exchangeRoot)).rejects.toThrow();
  });
});
