import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { localAssetIt } from "../../../../../../packages/protocol/tests/localAssetTest";
import {
  FLICK_PUBLIC_STAGE_CATALOG_URL,
  getFlickPublicCatalogCategories,
  FLICK_LOCAL_STAGE_CATALOG_URL,
  loadLocalFlickStageCatalog,
  parseLocalFlickStageCatalog,
  parseFlickPublicStageCatalog,
  resetFlickPublicStageCatalogCache,
} from "../../../../src/comprehensive/editor/modelLibrary/flickPublicCatalog";

const FIXTURE = [
  '"https://cdn.flick.art/stage-props/animals/cat.glb"',
  '"https://cdn.flick.art/stage-props/vehicles/taxi.glb"',
  '"https://cdn.flick.art/stage-props/animals/cat.glb"',
  '"https://cdn.flick.art/not-stage-props/animals/not-a-prop.glb"',
].join(";");

afterEach(() => resetFlickPublicStageCatalogCache());

localAssetIt("keeps a real local WebP preview beside every mirrored Stage model", () => {
  const libraryRoot = resolve(process.cwd(), "assets", "library");
  const catalog = JSON.parse(readFileSync(resolve(libraryRoot, "flick-stage-props/catalog.json"), "utf8")) as {
    items: Array<{ category: string; fileName: string; thumbnailUrl: string }>;
  };

  expect(catalog.items).toHaveLength(1_426);
  for (const item of catalog.items) {
    expect(existsSync(resolve(libraryRoot, "flick-stage-props", item.category, item.fileName))).toBe(true);
    expect(item.thumbnailUrl).toBe(
      `/flick-stage-props/thumbnails/${item.category}/${item.fileName.replace(/\.glb$/i, ".webp")}`,
    );
    expect(existsSync(resolve(libraryRoot, item.thumbnailUrl.slice(1)))).toBe(true);
  }
});

it("keeps only unique canonical public Stage GLB entries", () => {
  const items = parseFlickPublicStageCatalog(FIXTURE);

  expect(items).toHaveLength(2);
  expect(items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        assetSource: "remote",
        catalogCategory: "animals",
        fileName: "cat.glb",
        id: "flick:animals:cat.glb",
        thumbnailKind: "image",
        thumbnailUrl: "/flick-stage-props/thumbnails/animals/cat.webp",
        url: "https://cdn.flick.art/stage-props/animals/cat.glb",
      }),
    ]),
  );
  expect(getFlickPublicCatalogCategories(items)).toEqual(["animals", "vehicles"]);
});

it("uses only locally mirrored paths at runtime", () => {
  const items = parseLocalFlickStageCatalog({
    items: [
      {
        category: "animals",
        fileName: "cat.glb",
        sourceUrl: "https://cdn.flick.art/stage-props/animals/cat.glb",
        thumbnailUrl: "/flick-stage-props/thumbnails/animals/cat.webp",
      },
      { category: "animals", fileName: "../escape.glb" },
    ],
  });

  expect(items).toEqual([
    expect.objectContaining({
      assetSource: "library",
      thumbnailKind: "image",
      url: "/flick-stage-props/animals/cat.glb",
      thumbnailUrl: "/flick-stage-props/thumbnails/animals/cat.webp",
    }),
  ]);
});

it("rejects unsafe thumbnail urls and falls back to the local webp path", () => {
  const items = parseLocalFlickStageCatalog({
    items: [
      {
        category: "animals",
        fileName: "cat.glb",
        sourceUrl: "https://cdn.flick.art/stage-props/animals/cat.glb",
        thumbnailUrl: "https://evil.example/thumb.png",
      },
    ],
  });

  expect(items[0]?.thumbnailUrl).toBe("/flick-stage-props/thumbnails/animals/cat.webp");
});

it("loads the local catalog once per session and validates the response", async () => {
  const request = async (url: string) => {
    expect(url).toBe(FLICK_LOCAL_STAGE_CATALOG_URL);
    return new Response(
      JSON.stringify({
        items: [
          {
            category: "animals",
            fileName: "cat.glb",
            sourceUrl: "https://cdn.flick.art/stage-props/animals/cat.glb",
          },
        ],
      }),
      { status: 200 },
    );
  };

  const first = await loadLocalFlickStageCatalog(request as typeof fetch);
  const second = await loadLocalFlickStageCatalog(() => {
    throw new Error("the cached catalog should be reused");
  });

  expect(first).toBe(second);
  expect(first).toHaveLength(1);
});
