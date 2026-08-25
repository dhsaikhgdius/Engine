import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { localAssetIt } from "../../../../../../packages/protocol/tests/localAssetTest";
import { createDefaultDirectorProject } from "../../../../src/comprehensive/editor/store/directorStore";
import { createModelLibraryDragPayload, parseModelLibraryDragData } from "../../../../src/comprehensive/editor/modelLibrary/modelLibraryDrag";
import { filterModelLibraryItems, FLICK_STANDARD_CATEGORIES } from "../../../../src/comprehensive/editor/modelLibrary/modelLibraryCatalog";
import {
  getDirectorCharacterAssetBindingIssues,
  loadLocalMixamoCharacterCatalog,
  MIXAMO_CHARACTER_CATALOG_URL,
  parseLocalMixamoCharacterCatalog,
  repairDirectorCharacterAssetBindings,
  resetLocalMixamoCharacterCatalogCache,
} from "../../../../src/comprehensive/editor/modelLibrary/mixamoCharacterCatalog";

const CHARACTER_ENTRY = {
  id: "mixamo:kaya",
  name: "Kaya",
  fileName: "Kaya.glb",
  modelUrl: "models/Kaya.glb",
  thumbnailUrl: "thumbnails/Kaya.webp",
  heightM: 1.72,
  groundOffsetY: 0.04,
  visualCenter: [0, 0.88, 0] as [number, number, number],
  labelAnchorY: 1.86,
  rig: {
    type: "mixamo",
    bonePrefix: "mixamorig7:",
    boneCount: 65,
    boneNames: ["Hips", "Spine", "Head"],
  },
};

afterEach(() => resetLocalMixamoCharacterCatalogCache());

it("parses a packaged Mixamo character into the shared local model library", () => {
  const items = parseLocalMixamoCharacterCatalog({ items: [CHARACTER_ENTRY] });

  expect(items).toEqual([
    expect.objectContaining({
      assetSource: "library",
      catalogCategory: "characters",
      characterMetadata: expect.objectContaining({
        groundOffsetY: 0.04,
        rig: expect.objectContaining({ type: "mixamo", boneCount: 65 }),
      }),
      fileName: "Kaya.glb",
      flickCategory: "characters",
      id: "mixamo:kaya",
      kind: "character",
      thumbnailUrl: "/mixamo-characters/thumbnails/Kaya.webp",
      url: "/mixamo-characters/models/Kaya.glb",
    }),
  ]);
});

it("rejects external, traversing, incomplete, and malformed character records", () => {
  const items = parseLocalMixamoCharacterCatalog({
    items: [
      { ...CHARACTER_ENTRY, modelUrl: "https://example.com/Kaya.glb" },
      { ...CHARACTER_ENTRY, modelUrl: "models/../private.glb" },
      { ...CHARACTER_ENTRY, thumbnailUrl: "../secret.webp" },
      { ...CHARACTER_ENTRY, heightM: -1 },
      { ...CHARACTER_ENTRY, rig: { type: "other", boneCount: 65 } },
      CHARACTER_ENTRY,
      { ...CHARACTER_ENTRY, id: "duplicate", modelUrl: "/mixamo-characters/models/Kaya.glb" },
    ],
  });

  expect(items).toHaveLength(1);
  expect(items[0]?.id).toBe("mixamo:kaya");
});

it("adds the 人物 category and filters Mixamo characters by category and query", () => {
  const items = parseLocalMixamoCharacterCatalog({
    items: [
      CHARACTER_ENTRY,
      {
        ...CHARACTER_ENTRY,
        id: "mixamo:doozy",
        name: "Doozy",
        fileName: "Doozy.glb",
        modelUrl: "models/Doozy.glb",
      },
    ],
  });

  expect(FLICK_STANDARD_CATEGORIES).toContainEqual({ id: "characters", label: "人物" });
  expect(filterModelLibraryItems(items, "characters", "kAy").map((item) => item.name)).toEqual(["Kaya"]);
  expect(filterModelLibraryItems(items, "animals", "")).toEqual([]);
});

it("only flags structurally broken bindings and repairs them to the default character", () => {
  const project = createDefaultDirectorProject();
  const character = project.objects.find((object) => object.kind === "character")!;
  character.assetRefId = "asset_gone";

  expect(getDirectorCharacterAssetBindingIssues(project)).toEqual([
    `${character.id}.assetRefId "asset_gone" does not exist`,
  ]);

  const repaired = repairDirectorCharacterAssetBindings(project);
  expect(repaired.repairs).toHaveLength(1);
  expect(repaired.project.objects.find((object) => object.id === character.id)?.assetRefId).toBe("mixamo:x-bot");
  expect(getDirectorCharacterAssetBindingIssues(repaired.project)).toEqual([]);
});

it("no longer flags packaged assets whose display fields drifted from the catalog", () => {
  const project = createDefaultDirectorProject();
  project.assets = project.assets.map((asset) =>
    asset.id === "mixamo:x-bot" ? { ...asset, name: "自定义主角" } : asset,
  );

  expect(getDirectorCharacterAssetBindingIssues(project)).toEqual([]);
  expect(repairDirectorCharacterAssetBindings(project).repairs).toEqual([]);
});

it("loads and caches the validated local catalog", async () => {
  const request = async (url: string) => {
    expect(url).toBe(MIXAMO_CHARACTER_CATALOG_URL);
    return new Response(JSON.stringify({ items: [CHARACTER_ENTRY] }), { status: 200 });
  };

  const first = await loadLocalMixamoCharacterCatalog(request as typeof fetch);
  const second = await loadLocalMixamoCharacterCatalog(() => {
    throw new Error("cached catalog should be reused");
  });

  expect(first).toBe(second);
  expect(first).toHaveLength(1);
});

localAssetIt("accepts every generated character and resolves each packaged model and thumbnail", () => {
  const libraryRoot = resolve(process.cwd(), "assets", "library");
  const manifest = JSON.parse(readFileSync(resolve(libraryRoot, "mixamo-characters/catalog.json"), "utf8")) as {
    items: unknown[];
  };
  const items = parseLocalMixamoCharacterCatalog(manifest);

  expect(items).toHaveLength(manifest.items.length);
  expect(items.length).toBeGreaterThan(100);
  expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
  expect(new Set(items.map((item) => item.url)).size).toBe(items.length);

  for (const item of items) {
    expect(item).toMatchObject({
      assetSource: "library",
      flickCategory: "characters",
      kind: "character",
      thumbnailKind: "image",
    });
    expect(existsSync(resolve(libraryRoot, item.url.slice(1)))).toBe(true);
    expect(existsSync(resolve(libraryRoot, item.thumbnailUrl!.slice(1)))).toBe(true);

    const dragPayload = parseModelLibraryDragData(JSON.stringify(createModelLibraryDragPayload(item)));
    expect(dragPayload).toMatchObject({
      id: item.id,
      kind: "character",
      url: item.url,
      characterMetadata: item.characterMetadata,
    });
  }
});
