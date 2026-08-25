import { describe, expect, it } from "vitest";
import { backfillDirectorAssetMetricScale } from "../../../../src/comprehensive/editor/store/directorScaleMigration";
import type { DirectorAssetRef, DirectorProject } from "../../../../src/comprehensive/editor/schema/directorProject";
import { safeParseDirectorProject } from "../../../../src/comprehensive/editor/schema/directorProjectSchema";

function createLegacyProject(assets: DirectorAssetRef[]): DirectorProject {
  return {
    version: 1,
    scene: {
      scale: 1,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      backgroundColor: "#c9cdd3",
      panoramaYaw: 0,
      panoramaRadius: 50,
      showLabels: true,
      snapToGrid: false,
      showGround: true,
      groundOpacity: 0.6,
      groundHeight: 0,
    },
    assets,
    objects: [],
    cameras: [],
    activeCameraId: null,
    panoramaAssetId: null,
  };
}

function backfillAsset(asset: DirectorAssetRef) {
  return backfillDirectorAssetMetricScale(createLegacyProject([asset])).assets[0]!;
}

describe("backfillDirectorAssetMetricScale", () => {
  it("prefers the exact catalog identity over the asset URL", () => {
    expect(
      backfillAsset({
        id: "flick:animals:cat.glb",
        kind: "prop",
        sourceType: "model",
        fileName: "cat.glb",
        name: "Cat",
        url: "/flick-stage-props/trains/cat.glb",
        assetSource: "library",
      }),
    ).toMatchObject({ realWorldSizeM: 0.6, sizeSource: "catalog" });
  });

  it("matches a renamed catalog asset by its model URL", () => {
    expect(
      backfillAsset({
        id: "asset_4",
        kind: "prop",
        sourceType: "model",
        fileName: "ATM_low.fbx",
        name: "ATM",
        url: "/model-library/便利生活/ATM_low.fbx",
      }),
    ).toMatchObject({ realWorldSizeM: 1.8, sizeSource: "catalog" });
  });

  it("falls back to the category default of the packaged URL convention", () => {
    expect(
      backfillAsset({
        id: "asset_7",
        kind: "prop",
        sourceType: "model",
        fileName: "legacy-locomotive.glb",
        url: "/flick-stage-props/trains/legacy-locomotive.glb",
      }),
    ).toMatchObject({ realWorldSizeM: 20, sizeSource: "catalog" });
  });

  it("records the existing 2 m display fallback for otherwise unsized models", () => {
    const localAsset: DirectorAssetRef = {
      id: "asset_2",
      kind: "prop",
      sourceType: "model",
      fileName: "hand-authored.glb",
      name: "自制道具",
      url: "blob:http://localhost:5175/9f1c0f6a",
      assetSource: "local",
    };
    const unknownCategoryAsset: DirectorAssetRef = {
      id: "asset_3",
      kind: "prop",
      sourceType: "model",
      fileName: "mystery.glb",
      url: "/flick-stage-props/other/mystery.glb",
    };

    expect(backfillAsset(localAsset)).toMatchObject({ realWorldSizeM: 2, sizeSource: "estimated" });
    expect(backfillAsset(unknownCategoryAsset)).toMatchObject({ realWorldSizeM: 2, sizeSource: "estimated" });
  });

  it("leaves assets that already carry a metric scale untouched", () => {
    const userSizedAsset: DirectorAssetRef = {
      id: "flick:animals:cat.glb",
      kind: "prop",
      sourceType: "model",
      fileName: "cat.glb",
      url: "/flick-stage-props/animals/cat.glb",
      assetSource: "library",
      realWorldSizeM: 3,
      sizeSource: "user",
    };

    expect(backfillAsset(userSizedAsset)).toEqual(userSizedAsset);
  });

  it("refreshes stale catalog sizes without overriding user-authored sizes", () => {
    const staleCatalogAsset: DirectorAssetRef = {
      id: "flick:furniture:lounge_sofa_long.glb",
      kind: "prop",
      sourceType: "model",
      fileName: "lounge_sofa_long.glb",
      url: "/flick-stage-props/furniture/lounge_sofa_long.glb",
      assetSource: "library",
      realWorldSizeM: 1.2,
      sizeSource: "catalog",
    };
    const userSizedAsset: DirectorAssetRef = {
      ...staleCatalogAsset,
      realWorldSizeM: 3,
      sizeSource: "user",
    };

    expect(backfillAsset(staleCatalogAsset)).toMatchObject({ realWorldSizeM: 2.4, sizeSource: "catalog" });
    expect(backfillAsset(userSizedAsset)).toEqual(userSizedAsset);
  });

  it("leaves server-normalized preserve assets untouched", () => {
    const preservedAsset: DirectorAssetRef = {
      id: "asset_5",
      kind: "scene",
      sourceType: "model",
      fileName: "castle.glb",
      url: "/flick-stage-props/medieval/castle.glb",
      modelNormalization: "preserve",
    };

    expect(backfillAsset(preservedAsset)).toEqual(preservedAsset);
  });

  it("leaves characters, panoramas, and images untouched", () => {
    const characterAsset: DirectorAssetRef = {
      id: "mixamo:x-bot",
      kind: "character",
      sourceType: "model",
      fileName: "x-bot.glb",
      name: "X Bot",
      url: "/mixamo-characters/models/x-bot.glb",
      assetSource: "library",
    };
    const panoramaAsset: DirectorAssetRef = {
      id: "asset_6",
      kind: "panorama",
      sourceType: "model",
      fileName: "sky.glb",
      url: "/flick-stage-props/nature/sky.glb",
    };
    const imageAsset: DirectorAssetRef = {
      id: "asset_8",
      kind: "prop",
      sourceType: "image",
      fileName: "wood.png",
      url: "/textures/wood.png",
    };

    expect(backfillAsset(characterAsset)).toEqual(characterAsset);
    expect(backfillAsset(panoramaAsset)).toEqual(panoramaAsset);
    expect(backfillAsset(imageAsset)).toEqual(imageAsset);
  });

  it("is pure, deterministic, and keeps the project reference when nothing is backfilled", () => {
    const legacyProject = createLegacyProject([
      {
        id: "flick:animals:cat.glb",
        kind: "prop",
        sourceType: "model",
        fileName: "cat.glb",
        url: "/flick-stage-props/animals/cat.glb",
        assetSource: "library",
      },
      {
        id: "asset_2",
        kind: "prop",
        sourceType: "model",
        fileName: "hand-authored.glb",
        url: "blob:http://localhost:5175/9f1c0f6a",
        assetSource: "local",
      },
    ]);
    const snapshot = structuredClone(legacyProject);

    const backfilled = backfillDirectorAssetMetricScale(legacyProject);
    expect(legacyProject).toEqual(snapshot);
    expect(backfilled).toEqual(backfillDirectorAssetMetricScale(structuredClone(legacyProject)));
    expect(safeParseDirectorProject(backfilled).success).toBe(true);
    expect(backfillDirectorAssetMetricScale(backfilled)).toBe(backfilled);
  });
});
