import { describe, expect, it } from "vitest";
import {
  directorDccExchangePackageManifestSchema,
  directorDccExchangePackageResultSchema,
  type DirectorDccExchangePackageManifest,
  type DirectorDccExchangePackageResult,
} from "../../src/dcc/directorDccExchangePackageContract";

const hash = "a".repeat(64);
const revision = `director-project-revision:v1:sha256:${"b".repeat(64)}` as const;
const transform = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } as const;

function validManifest(): DirectorDccExchangePackageManifest {
  return directorDccExchangePackageManifestSchema.parse({
    contract: "director-dcc-exchange-package-v1",
    packageId: "550e8400-e29b-41d4-a716-446655440000",
    provider: "maya",
    sourceRevision: revision,
    createdAt: "2026-08-07T00:00:00.000Z",
    coordinateSystem: {
      linearUnit: "meter",
      metersPerUnit: 1,
      upAxis: "Y",
      handedness: "right",
      cameraForward: "-Z",
    },
    project: {
      version: 1,
      scene: {
        scale: 1,
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        backgroundColor: "#182033",
        panoramaYaw: 0,
        panoramaRadius: 60,
        showLabels: true,
        snapToGrid: false,
        showGround: true,
        groundOpacity: 0.9,
        groundHeight: 0,
      },
      assets: [
        { id: "asset-prop", kind: "prop", sourceType: "model", fileName: "prop.glb", url: "/prop.glb" },
        {
          id: "asset-character",
          kind: "character",
          sourceType: "model",
          fileName: "character.glb",
          url: "/character.glb",
        },
        {
          id: "asset-panorama",
          kind: "panorama",
          sourceType: "image",
          fileName: "panorama.hdr",
          url: "/panorama.hdr",
        },
      ],
      objects: [
        {
          id: "object-prop",
          name: "Prop",
          kind: "prop",
          visible: true,
          locked: false,
          assetRefId: "asset-prop",
          transform,
        },
        {
          id: "object-character",
          name: "Character",
          kind: "character",
          visible: true,
          locked: false,
          characterSource: "asset",
          assetRefId: "asset-character",
          transform,
        },
      ],
      cameras: [
        {
          id: "camera-main",
          name: "Main Camera",
          fov: 50,
          transform,
          targetMode: "manual",
          target: [0, 1, 0],
        },
      ],
      activeCameraId: "camera-main",
      panoramaAssetId: "asset-panorama",
    },
    formats: [
      { format: "usda", relativePath: "scene.usda", sha256: hash, byteLength: 100 },
      { format: "glb", relativePath: "scene-layout.glb", sha256: hash, byteLength: 200 },
    ],
    assets: [
      { assetRefId: "asset-prop", relativePath: "assets/prop.glb", sha256: hash, byteLength: 300 },
      {
        assetRefId: "asset-character",
        relativePath: "assets/character.glb",
        sha256: hash,
        byteLength: 400,
      },
    ],
    warnings: [],
  });
}

function validResult(): DirectorDccExchangePackageResult {
  return directorDccExchangePackageResultSchema.parse({
    contract: "director-dcc-exchange-result-v1",
    jobId: "550e8400-e29b-41d4-a716-446655440000",
    provider: "maya",
    packagePath: "/tmp/exchange/maya/job",
    manifestPath: "/tmp/exchange/maya/job/manifest.json",
    manifestSha256: hash,
    packageDigest: hash,
    sourceRevision: revision,
    formats: [
      {
        format: "usda",
        fileName: "scene.usda",
        path: "/tmp/exchange/maya/job/scene.usda",
        mimeType: "model/vnd.usda",
        sha256: hash,
        byteLength: 100,
      },
      {
        format: "glb",
        fileName: "scene-layout.glb",
        path: "/tmp/exchange/maya/job/scene-layout.glb",
        mimeType: "model/gltf-binary",
        sha256: hash,
        byteLength: 200,
      },
    ],
    assets: [
      {
        assetRefId: "asset-prop",
        fileName: "prop.glb",
        path: "/tmp/exchange/maya/job/assets/prop.glb",
        relativePath: "assets/prop.glb",
        sha256: hash,
        byteLength: 300,
      },
      {
        assetRefId: "asset-character",
        fileName: "character.glb",
        path: "/tmp/exchange/maya/job/assets/character.glb",
        relativePath: "assets/character.glb",
        sha256: hash,
        byteLength: 400,
      },
    ],
    warnings: [],
  });
}

describe("Director DCC exchange package contract", () => {
  it("accepts a graph-consistent manifest and result", () => {
    expect(directorDccExchangePackageManifestSchema.parse(validManifest())).toEqual(validManifest());
    expect(directorDccExchangePackageResultSchema.parse(validResult())).toEqual(validResult());
  });

  it.each([
    ["assets", "asset-prop"],
    ["objects", "object-prop"],
    ["cameras", "camera-main"],
  ] as const)("rejects duplicate project %s ids", (collection, duplicateId) => {
    const manifest = validManifest();
    const duplicate = structuredClone(manifest.project[collection][0]);
    duplicate.id = duplicateId;
    manifest.project[collection].push(duplicate as never);

    const parsed = directorDccExchangePackageManifestSchema.safeParse(manifest);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues.some((issue) => issue.message.includes("duplicate id"))).toBe(true);
  });

  it("rejects missing object assets and requires a character model asset", () => {
    const missingProp = validManifest();
    missingProp.project.objects[0]!.assetRefId = "asset-missing";
    expect(directorDccExchangePackageManifestSchema.safeParse(missingProp).success).toBe(false);

    const missingCharacter = validManifest();
    delete missingCharacter.project.objects[1]!.assetRefId;
    expect(directorDccExchangePackageManifestSchema.safeParse(missingCharacter).success).toBe(false);

    const wrongCharacterKind = validManifest();
    wrongCharacterKind.project.objects[1]!.assetRefId = "asset-prop";
    expect(directorDccExchangePackageManifestSchema.safeParse(wrongCharacterKind).success).toBe(false);

    const wrongCharacterSource = validManifest();
    const characterAsset = wrongCharacterSource.project.assets.find((asset) => asset.id === "asset-character")!;
    characterAsset.sourceType = "image";
    expect(directorDccExchangePackageManifestSchema.safeParse(wrongCharacterSource).success).toBe(false);
  });

  it("rejects dangling active camera, panorama, and package asset references", () => {
    const activeCamera = validManifest();
    activeCamera.project.activeCameraId = "camera-missing";
    expect(directorDccExchangePackageManifestSchema.safeParse(activeCamera).success).toBe(false);

    const panorama = validManifest();
    panorama.project.panoramaAssetId = "panorama-missing";
    expect(directorDccExchangePackageManifestSchema.safeParse(panorama).success).toBe(false);

    const wrongPanoramaType = validManifest();
    wrongPanoramaType.project.panoramaAssetId = "asset-prop";
    expect(directorDccExchangePackageManifestSchema.safeParse(wrongPanoramaType).success).toBe(false);

    const packageAsset = validManifest();
    packageAsset.assets[0]!.assetRefId = "asset-missing";
    expect(directorDccExchangePackageManifestSchema.safeParse(packageAsset).success).toBe(false);
  });

  it("rejects duplicate manifest formats, asset references, and package paths", () => {
    const duplicateFormat = validManifest();
    duplicateFormat.formats[1]!.format = "usda";
    expect(directorDccExchangePackageManifestSchema.safeParse(duplicateFormat).success).toBe(false);

    const duplicateAsset = validManifest();
    duplicateAsset.assets[1]!.assetRefId = "asset-prop";
    expect(directorDccExchangePackageManifestSchema.safeParse(duplicateAsset).success).toBe(false);

    const duplicateAssetPath = validManifest();
    duplicateAssetPath.assets[1]!.relativePath = duplicateAssetPath.assets[0]!.relativePath;
    expect(directorDccExchangePackageManifestSchema.safeParse(duplicateAssetPath).success).toBe(false);

    const crossSectionPath = validManifest();
    crossSectionPath.assets[0]!.relativePath = crossSectionPath.formats[0]!.relativePath;
    expect(directorDccExchangePackageManifestSchema.safeParse(crossSectionPath).success).toBe(false);
  });

  it("rejects duplicate result records and format/MIME mismatches", () => {
    const duplicateFormat = validResult();
    duplicateFormat.formats[1]!.format = "usda";
    duplicateFormat.formats[1]!.mimeType = "model/vnd.usda";
    expect(directorDccExchangePackageResultSchema.safeParse(duplicateFormat).success).toBe(false);

    const duplicateAsset = validResult();
    duplicateAsset.assets[1]!.assetRefId = "asset-prop";
    expect(directorDccExchangePackageResultSchema.safeParse(duplicateAsset).success).toBe(false);

    const duplicateRelativePath = validResult();
    duplicateRelativePath.assets[1]!.relativePath = duplicateRelativePath.assets[0]!.relativePath;
    expect(directorDccExchangePackageResultSchema.safeParse(duplicateRelativePath).success).toBe(false);

    const duplicateOutputPath = validResult();
    duplicateOutputPath.assets[0]!.path = duplicateOutputPath.formats[0]!.path;
    expect(directorDccExchangePackageResultSchema.safeParse(duplicateOutputPath).success).toBe(false);

    for (const [format, mimeType] of [
      ["glb", "model/vnd.usda"],
      ["usda", "model/gltf-binary"],
    ] as const) {
      const mismatch = validResult();
      const artifact = mismatch.formats.find((candidate) => candidate.format === format)!;
      artifact.mimeType = mimeType;
      expect(directorDccExchangePackageResultSchema.safeParse(mismatch).success).toBe(false);
    }
  });

  it("uses the canonical Director project revision pattern for manifests and results", () => {
    expect(
      directorDccExchangePackageManifestSchema.safeParse({ ...validManifest(), sourceRevision: "not-a-revision" })
        .success,
    ).toBe(false);
    expect(
      directorDccExchangePackageResultSchema.safeParse({ ...validResult(), sourceRevision: "not-a-revision" }).success,
    ).toBe(false);
  });
});
