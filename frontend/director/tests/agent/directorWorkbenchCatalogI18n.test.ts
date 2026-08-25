import { beforeEach, describe, expect, it } from "vitest";
import {
  createDefaultDirectorProject,
  useDirectorStore,
} from "../../src/comprehensive/editor/store/directorStore";
import { executeDirectorWorkbenchOperation, resetDirectorWorkbenchRuntimeForTests } from "../../src/agent/directorWorkbenchExecutor";

// The generated flick metadata.i18n.json overlay and the model-library
// catalog.v2.json are wired into the aggregated Agent catalog at module init
// (see DIRECTOR_AGENT_FLICK_METADATA_OVERLAY / DIRECTOR_AGENT_V2_LIBRARIES in
// directorAgentAssetCatalog.ts), so these assertions exercise the real
// shipped data end to end through the workbench executor.
function runCatalogQuery(query: string) {
  return executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
    op: "catalog",
    catalog: "assets",
    query,
    offset: 0,
    limit: 5,
  });
}

describe("Director workbench catalog with generated i18n overlay and v2 library wired", () => {
  beforeEach(() => {
    resetDirectorWorkbenchRuntimeForTests();
    useDirectorStore.getState().replaceProject(createDefaultDirectorProject());
  });

  it("finds a flick prop by its merged Chinese alias, name, and tag", () => {
    const byAlias = runCatalogQuery("猫咪");
    expect(byAlias.success).toBe(true);
    const aliasItems = (byAlias as { result: { items: Array<Record<string, unknown>> } }).result.items;
    expect(aliasItems[0]).toMatchObject({
      id: "flick:animals:cat.glb",
      name_zh: "猫",
      aliases: expect.arrayContaining(["猫咪", "小猫", "cat"]),
      tags: expect.arrayContaining(["animal", "pet", "feline"]),
      spatial: expect.objectContaining({ bounds_m: expect.any(Array), ground_offset_y: expect.any(Number) }),
      asset: expect.objectContaining({ realWorldSizeM: 0.6, sizeSource: "catalog" }),
    });

    const byName = runCatalogQuery("猫");
    expect(byName.success).toBe(true);
    expect((byName as { result: { items: Array<{ id: string }> } }).result.items[0]?.id).toBe("flick:animals:cat.glb");

    const byTag = runCatalogQuery("feline");
    expect(byTag.success).toBe(true);
    const taggedIds = (byTag as { result: { items: Array<{ id: string }> } }).result.items.map((item) => item.id);
    expect(taggedIds).toContain("flick:animals:cat.glb");
  });

  it("finds an aggregated v2 model-library item by its Chinese name and returns its authoring payload", () => {
    const catalog = runCatalogQuery("自动取款机");
    expect(catalog).toMatchObject({
      success: true,
      result: {
        total: 1,
        items: [
          expect.objectContaining({
            id: "model-library:atm",
            name: "ATM",
            name_zh: "自动取款机",
            category: "structure",
            kind: "prop",
            aliases: expect.arrayContaining(["取款机"]),
            source: expect.objectContaining({ provenance: "bundled" }),
            spatial: expect.objectContaining({ bounds_m: [1.09, 1.8, 0.77], ground_offset_y: 0 }),
            asset: expect.objectContaining({ realWorldSizeM: 1.8, sizeSource: "catalog" }),
            authoring: expect.objectContaining({
              actions: [
                expect.objectContaining({ action: "upsert_asset" }),
                expect.objectContaining({ action: "add_object", asset_id: "model-library:atm" }),
              ],
            }),
          }),
        ],
      },
    });
  });
});
