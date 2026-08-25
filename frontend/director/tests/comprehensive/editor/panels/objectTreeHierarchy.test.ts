import { describe, expect, it } from "vitest";
import {
  collectExpandableSceneTreeIds,
  collectSceneTreeRevealPath,
  countSceneTreeObjects,
  filterSceneTreeItems,
  flattenVisibleSceneTree,
  nestSceneTreeItems,
  nestSceneTreeItemsByName,
  nestSceneTreeItemsByParent,
  objectTreeHierarchyDisplayName,
  splitObjectTreeHierarchyName,
  type ObjectTreeHierarchyItem,
} from "../../../../src/comprehensive/editor/panels/objectTreeHierarchy";

function item(id: string, name: string, extra: Partial<ObjectTreeHierarchyItem> = {}): ObjectTreeHierarchyItem {
  return {
    id,
    name,
    icon: "geometry",
    objectIds: [id],
    object: { id, parentObjectId: extra.object?.parentObjectId },
    ...extra,
  };
}

describe("object tree name hierarchy", () => {
  it("splits middle-dot object names into path segments", () => {
    expect(splitObjectTreeHierarchyName("摄影棚·主景·地面1")).toEqual(["摄影棚", "主景", "地面1"]);
    expect(objectTreeHierarchyDisplayName("摄影棚·主景·地面1", ["摄影棚"])).toBe("主景·地面1");
    expect(objectTreeHierarchyDisplayName("摄影棚·主景·地面1", ["摄影棚", "主景"])).toBe("地面1");
  });

  it("groups sibling parts under a shared virtual folder", () => {
    const nested = nestSceneTreeItemsByName(
      [item("a", "塔楼A·台座"), item("b", "塔楼A·屋身"), item("c", "塔楼A·装饰件"), item("ground", "广场地面")],
      "geometry",
    );

    expect(nested.map((entry) => entry.name)).toEqual(["塔楼A", "广场地面"]);
    const folder = nested[0]!;
    expect(folder).toMatchObject({
      listKind: "prefix",
      icon: "folder",
      displayName: "塔楼A",
      objectIds: ["a", "b", "c"],
      object: undefined,
    });
    expect(folder.nestedItems?.map((entry) => [entry.displayName, entry.name])).toEqual([
      ["台座", "塔楼A·台座"],
      ["屋身", "塔楼A·屋身"],
      ["装饰件", "塔楼A·装饰件"],
    ]);
  });

  it("nests dotted children under an existing parent object instead of a virtual folder", () => {
    const nested = nestSceneTreeItemsByName([item("wall", "东围墙"), item("trim", "东围墙·顶沿")], "geometry");

    expect(nested).toHaveLength(1);
    expect(nested[0]).toMatchObject({
      id: "wall",
      name: "东围墙",
      objectIds: ["wall"],
    });
    expect(nested[0]?.listKind).toBeUndefined();
    expect(nested[0]?.nestedItems).toEqual([
      expect.objectContaining({ id: "trim", displayName: "顶沿", name: "东围墙·顶沿" }),
    ]);
  });

  it("keeps a second path level when a building has named wings", () => {
    const nested = nestSceneTreeItemsByName(
      [
        item("a", "入口·东北亭·屋顶"),
        item("b", "入口·东北亭·顶饰"),
        item("c", "入口·基座"),
        item("d", "入口·西北亭·屋顶"),
        item("e", "入口·西北亭·顶饰"),
      ],
      "geometry",
    );

    expect(nested).toHaveLength(1);
    expect(nested[0]).toMatchObject({ name: "入口", listKind: "prefix" });
    expect(nested[0]?.nestedItems?.map((entry) => entry.displayName)).toEqual(["东北亭", "基座", "西北亭"]);
    expect(nested[0]?.nestedItems?.[0]).toMatchObject({
      name: "入口·东北亭",
      listKind: "prefix",
      displayName: "东北亭",
    });
    expect(nested[0]?.nestedItems?.[0]?.nestedItems?.map((entry) => entry.displayName)).toEqual(["屋顶", "顶饰"]);
  });

  it("does not wrap a unique dotted name in a singleton folder", () => {
    const nested = nestSceneTreeItemsByName([item("a", "塔楼A·台座"), item("b", "广场地面")], "geometry");
    expect(nested.map((entry) => entry.name)).toEqual(["塔楼A·台座", "广场地面"]);
    expect(nested[0]?.listKind).toBeUndefined();
    expect(nested[0]?.displayName).toBeUndefined();
  });

  it("nests transform children under their parent object", () => {
    const nested = nestSceneTreeItemsByParent([
      item("chair", "课堂椅子"),
      item("seat", "椅面", { object: { id: "seat", parentObjectId: "chair" } }),
    ]);

    expect(nested).toHaveLength(1);
    expect(nested[0]?.id).toBe("chair");
    expect(nested[0]?.nestedItems?.map((entry) => entry.id)).toEqual(["seat"]);
  });

  it("applies parent links before name folders", () => {
    const nested = nestSceneTreeItems(
      [
        item("studio", "摄影棚·主景"),
        item("tile", "摄影棚·主景·地面1", { object: { id: "tile", parentObjectId: "studio" } }),
        item("wall", "摄影棚·南墙"),
      ],
      "geometry",
    );

    expect(nested).toHaveLength(1);
    expect(nested[0]).toMatchObject({ name: "摄影棚", listKind: "prefix" });
    expect(nested[0]?.nestedItems?.map((entry) => entry.displayName)).toEqual(["主景", "南墙"]);
    expect(nested[0]?.nestedItems?.[0]?.nestedItems?.map((entry) => entry.id)).toEqual(["tile"]);
  });

  it("flattens only expanded folders and counts descendant objects once", () => {
    const tree = nestSceneTreeItemsByName(
      [item("a", "塔楼A·台座"), item("b", "塔楼A·屋身"), item("c", "广场地面")],
      "geometry",
    );
    const folderId = tree[0]!.id;

    expect(countSceneTreeObjects(tree)).toBe(3);
    expect(flattenVisibleSceneTree(tree, new Set()).map((row) => [row.displayName ?? row.name, row.depth])).toEqual([
      ["塔楼A", 0],
      ["广场地面", 0],
    ]);
    expect(
      flattenVisibleSceneTree(tree, new Set([folderId])).map((row) => [row.displayName ?? row.name, row.depth]),
    ).toEqual([
      ["塔楼A", 0],
      ["台座", 1],
      ["屋身", 1],
      ["广场地面", 0],
    ]);
    expect(collectExpandableSceneTreeIds(tree)).toEqual([folderId]);
  });

  it("collects ancestor folders so a viewport selection can open the outliner path", () => {
    const tree = nestSceneTreeItemsByName(
      [item("a", "大厅·台座"), item("b", "大厅·屋身"), item("c", "侧厅·立柱1")],
      "geometry",
    );
    const path = collectSceneTreeRevealPath(tree, { objectId: "b" });

    expect(path?.itemId).toBe("b");
    expect(path?.ancestors).toEqual([tree[0]!.id]);
    expect(tree[0]?.name).toBe("大厅");
  });

  it("collects every ancestor folder for a two-level name path", () => {
    const tree = nestSceneTreeItemsByName(
      [
        item("a", "入口·东北亭·屋顶"),
        item("b", "入口·东北亭·顶饰"),
        item("c", "入口·基座"),
        item("d", "入口·西北亭·屋顶"),
        item("e", "入口·西北亭·顶饰"),
      ],
      "geometry",
    );
    const path = collectSceneTreeRevealPath(tree, { objectId: "a" });
    const gate = tree[0]!;
    const pavilion = gate.nestedItems?.[0];

    expect(path?.itemId).toBe("a");
    expect(path?.ancestors).toEqual([gate.id, pavilion?.id]);
  });

  it("opens a list row that contains the selected object", () => {
    const tree = [
      item("list", "卫兵", {
        listKind: "automatic",
        objectIds: ["guard_a", "guard_b"],
      }),
    ];
    const path = collectSceneTreeRevealPath(tree, { objectId: "guard_b" });

    expect(path).toEqual({ ancestors: ["list"], itemId: "list" });
  });

  it("keeps matching ancestors visible while searching nested names", () => {
    const tree = nestSceneTreeItemsByName(
      [item("a", "塔楼A·台座"), item("b", "塔楼A·装饰件"), item("c", "侧厅·立柱1")],
      "geometry",
    );
    const filtered = filterSceneTreeItems(tree, "装饰");

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.name).toBe("塔楼A");
    expect(filtered[0]?.nestedItems?.map((entry) => entry.displayName)).toEqual(["装饰件"]);
  });
});
