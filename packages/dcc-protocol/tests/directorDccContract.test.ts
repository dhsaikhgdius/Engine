import { Quaternion } from "three";
import { createDefaultDirectorProject } from "../../../frontend/director/src/comprehensive/editor/store/directorStore";
import {
  blenderPointToDirector,
  buildDirectorDccScenePackage,
  directorDccScenePackageSchema,
  directorPointToBlender,
  directorTransformToBlender,
  directorDccOperationSchema,
} from "../src/directorDccContract";

describe("Director DCC scene contract", () => {
  it("converts Y-up Director points to Z-up Blender points and round-trips", () => {
    expect(directorPointToBlender([2, 3, 4])).toEqual([2, -4, 3]);
    expect(blenderPointToDirector([2, -4, 3])).toEqual([2, 3, 4]);
  });

  it("converts transforms with normalized Blender quaternions", () => {
    const converted = directorTransformToBlender({
      position: [2, 3, 4],
      rotation: [0, Math.PI / 2, 0],
      scale: [1, 2, 3],
    });
    expect(converted.location).toEqual([2, -4, 3]);
    expect(new Quaternion(...converted.rotationQuaternion).length()).toBeCloseTo(1, 8);
    expect(converted.scale).toEqual([1, 3, 2]);
  });

  it("builds a validated package with physical cameras and resolved assets", () => {
    const project = createDefaultDirectorProject();
    project.assets.push({
      id: "asset-prop",
      kind: "prop",
      sourceType: "model",
      fileName: "prop.glb",
      url: "/models/prop.glb",
      assetSource: "library",
    });
    project.objects.push({
      id: "prop-1",
      name: "Prop",
      kind: "prop",
      visible: true,
      locked: false,
      assetRefId: "asset-prop",
      transform: { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] },
    });
    project.cameras[0]!.anamorphicSqueeze = 1.8;
    project.cameras[0]!.animation = {
      version: 1,
      keyframes: [{ frame: 12, fov: 50 }],
    };

    const result = buildDirectorDccScenePackage(project, {
      resolveAsset: () => ({ status: "resolved", sourcePath: "/safe/assets/library/models/prop.glb" }),
    });

    expect(directorDccScenePackageSchema.safeParse(result).success).toBe(true);
    expect(result.objects.find((object) => object.id === "prop-1")).toMatchObject({
      sourcePath: "/safe/assets/library/models/prop.glb",
      transform: { location: [1, -3, 2] },
    });
    expect(result.cameras[0]).toMatchObject({
      focalLengthMm: expect.any(Number),
      sensorWidthMm: expect.any(Number),
      anamorphicSqueeze: 1.8,
      animation: [{ frame: 12, focalLengthMm: expect.any(Number) }],
    });
    expect(result.sourceRevision).toMatch(/^director-project-revision:v1:sha256:[a-f\d]{64}$/);
  });

  it("preserves rational frame rates, drop-frame, and SMPTE start timecode", () => {
    const project = createDefaultDirectorProject();
    project.scene.timeline = {
      version: 1,
      fps: 30_000 / 1_001,
      timebase: {
        rate: { numerator: 30_000, denominator: 1_001 },
        dropFrame: true,
        startTimecode: "01:00:00;00",
      },
      frameStart: 0,
      frameEnd: 1_800,
      currentFrame: 1_800,
      loop: false,
    };

    const result = buildDirectorDccScenePackage(project, {
      resolveAsset: () => ({ status: "resolved", sourcePath: "/safe/x-bot.glb" }),
    });

    expect(result.timeline).toEqual({
      fps: 30_000 / 1_001,
      timebase: {
        rate: { numerator: 30_000, denominator: 1_001 },
        dropFrame: true,
        startTimecode: "01:00:00;00",
      },
      frameStart: 0,
      frameEnd: 1_800,
      currentFrame: 1_800,
    });
    expect(directorDccScenePackageSchema.safeParse(result).success).toBe(true);
  });

  it("reports unresolved assets and rejects unknown cameras", () => {
    const project = createDefaultDirectorProject();
    project.assets.push({
      id: "remote",
      kind: "prop",
      sourceType: "model",
      fileName: "remote.glb",
      url: "https://example.test/x.glb",
    });
    expect(() =>
      buildDirectorDccScenePackage(project, {
        resolveAsset: () => ({ status: "unsupported", message: "remote URL" }),
        cameraId: "missing-camera",
      }),
    ).toThrow('DCC export camera "missing-camera" does not exist.');

    const result = buildDirectorDccScenePackage(project, {
      resolveAsset: () => ({ status: "unsupported", message: "remote URL" }),
    });
    expect(result.assets[0]).toMatchObject({ status: "unsupported", message: "remote URL" });
    expect(result.warnings.join(" ")).toContain("remote.glb");
  });

  it("rejects assetless characters instead of silently substituting a default model", () => {
    const project = createDefaultDirectorProject();
    const character = project.objects.find((object) => object.kind === "character")!;
    delete character.assetRefId;

    expect(() =>
      buildDirectorDccScenePackage(project, {
        resolveAsset: () => ({ status: "resolved", sourcePath: "/safe/x-bot.glb" }),
      }),
    ).toThrow("DCC export rejected invalid character asset bindings");
  });

  it("supports discover-first, open provider ids, and portable exchange formats", () => {
    expect(directorDccOperationSchema.parse({ op: "discover" })).toEqual({ op: "discover" });
    expect(
      directorDccOperationSchema.parse({
        op: "export_exchange_package",
        provider: "studio.openusd-v2",
        formats: ["usda", "glb"],
      }),
    ).toEqual({
      op: "export_exchange_package",
      provider: "studio.openusd-v2",
      formats: ["usda", "glb"],
    });
    expect(
      directorDccOperationSchema.safeParse({
        op: "export_exchange_package",
        provider: "Maya/unsafe",
        formats: ["blend"],
      }).success,
    ).toBe(false);
  });
});
