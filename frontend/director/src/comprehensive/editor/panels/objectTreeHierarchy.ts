/** Scene object names use a middle-dot path: `大厅·立柱1`, `摄影棚·主景·地面`. */
export const OBJECT_TREE_HIERARCHY_SEPARATOR = "·";

/** A node in the scene-object hierarchy tree, generic over its nested children shape. */
export type ObjectTreeHierarchyNode<TNested = unknown> = {
  id: string;
  name: string;
  icon: string;
  objectIds: string[];
  object?: { id: string; parentObjectId?: string };
  listKind?: string;
  nestedItems?: TNested[];
  displayName?: string;
};

/**
 * A concrete hierarchy node whose nested children are themselves
 * {@link ObjectTreeHierarchyItem}s.
 */
export interface ObjectTreeHierarchyItem extends ObjectTreeHierarchyNode<ObjectTreeHierarchyItem> {}

/**
 * Splits a hierarchy-qualified name into its dot-separated segments.
 *
 * Leading/trailing whitespace on each segment is trimmed and
 * empty segments are discarded.
 *
 * @param name - The hierarchy-qualified name to split.
 * @returns The ordered non-empty segments of the name.
 */
export function splitObjectTreeHierarchyName(name: string): string[] {
  return name
    .split(OBJECT_TREE_HIERARCHY_SEPARATOR)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Derives the display name to show at a given level of the hierarchy.
 *
 * When the qualified name has more segments than the current path depth,
 * only the remaining suffix is returned; otherwise the last segment
 * (or the original name) is used as a fallback.
 *
 * @param name - The full hierarchy-qualified name.
 * @param path - The ancestor segments already consumed by the tree.
 * @returns The display label for this hierarchy level.
 */
export function objectTreeHierarchyDisplayName(name: string, path: readonly string[]): string {
  const segments = splitObjectTreeHierarchyName(name);
  if (segments.length <= path.length) return segments[segments.length - 1] ?? name;
  const rest = segments.slice(path.length).join(OBJECT_TREE_HIERARCHY_SEPARATOR);
  return rest || name;
}

/**
 * Counts the distinct scene objects referenced across a tree of items.
 *
 * @param items - The root items of the tree to count over.
 * @returns The number of unique object IDs across all nested items.
 */
export function countSceneTreeObjects<T extends { objectIds: readonly string[]; nestedItems?: readonly T[] }>(
  items: readonly T[],
): number {
  const ids = new Set<string>();
  const walk = (nodes: readonly T[]) => {
    for (const node of nodes) {
      for (const id of node.objectIds) ids.add(id);
      if (node.nestedItems?.length) walk(node.nestedItems);
    }
  };
  walk(items);
  return ids.size;
}

/**
 * Collects the IDs of every tree node that can be expanded.
 *
 * A node is expandable when it carries a {@link listKind} or has nested children.
 *
 * @param items - The root items of the tree to walk.
 * @returns The ordered list of expandable node IDs in discovery order.
 */
export function collectExpandableSceneTreeIds<T extends { id: string; listKind?: string; nestedItems?: readonly T[] }>(
  items: readonly T[],
): string[] {
  const ids: string[] = [];
  const walk = (nodes: readonly T[]) => {
    for (const node of nodes) {
      if (node.listKind || node.nestedItems?.length) ids.push(node.id);
      if (node.nestedItems?.length) walk(node.nestedItems);
    }
  };
  walk(items);
  return ids;
}

/**
 * Collects every distinct scene-object ID reachable from the given tree.
 *
 * @param items - The root items of the tree to walk.
 * @returns The ordered list of unique object IDs in discovery order.
 */
export function collectSceneTreeObjectIds<T extends { objectIds: readonly string[]; nestedItems?: readonly T[] }>(
  items: readonly T[],
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const walk = (nodes: readonly T[]) => {
    for (const node of nodes) {
      for (const id of node.objectIds) {
        if (seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
      }
      if (node.nestedItems?.length) walk(node.nestedItems);
    }
  };
  walk(items);
  return ids;
}

/**
 * Filters a tree of scene items to those matching a free-text query.
 *
 * An item is kept when its own name or display name matches, or when any
 * descendant or preview child matches. When only descendants match, the
 * item's nested children are pruned to the matching subset; otherwise the
 * original children are preserved.
 *
 * @param items - The root items to filter.
 * @param query - The free-text substring to match against.
 * @returns A new tree containing only the matching items and their
 *   matching subtrees. An empty query returns a shallow copy of the
 *   original array.
 */
export function filterSceneTreeItems<
  T extends {
    name: string;
    displayName?: string;
    nestedItems?: T[];
    previewChildren?: Array<{ name: string }>;
  },
>(items: readonly T[], query: string): T[] {
  if (!query) return [...items];

  const result: T[] = [];
  for (const item of items) {
    const nested = item.nestedItems ? filterSceneTreeItems(item.nestedItems, query) : [];
    const matchedPreview = item.previewChildren?.filter((child) => child.name.includes(query)) ?? [];
    const selfMatch = item.name.includes(query) || Boolean(item.displayName?.includes(query));
    if (!selfMatch && nested.length === 0 && matchedPreview.length === 0) continue;

    result.push({
      ...item,
      ...(item.nestedItems ? { nestedItems: selfMatch ? item.nestedItems : nested } : {}),
      ...(matchedPreview.length && !selfMatch && item.previewChildren ? { previewChildren: matchedPreview } : {}),
    });
  }
  return result;
}

/**
 * Finds the ancestor chain needed to reveal a target object or crowd in
 * the tree, and returns the matching leaf item's ID.
 *
 * @param items - The root items of the tree to search.
 * @param target - The target to locate, identified by {@link objectId}
 *   or {@link crowdId}.
 * @returns The ancestor IDs and the matching item ID, or `null` when
 *   the target is not found in the tree.
 */
export function collectSceneTreeRevealPath<
  T extends {
    id: string;
    crowdId?: string;
    objectIds?: readonly string[];
    object?: { id: string };
    nestedItems?: readonly T[];
  },
>(
  items: readonly T[],
  target: { objectId?: string | null; crowdId?: string | null },
): { ancestors: string[]; itemId: string } | null {
  const matchesExact = (node: T) =>
    Boolean(target.crowdId && node.crowdId === target.crowdId) ||
    Boolean(
      target.objectId && (node.id === target.objectId || node.object?.id === target.objectId),
    );

  const matchesContained = (node: T) => Boolean(target.objectId && node.objectIds?.includes(target.objectId));

  const walk = (nodes: readonly T[], ancestors: string[]): { ancestors: string[]; itemId: string } | null => {
    for (const node of nodes) {
      const childPath = node.nestedItems?.length ? walk(node.nestedItems, [...ancestors, node.id]) : null;
      if (childPath) return childPath;
      if (matchesExact(node)) return { ancestors, itemId: node.id };
      if (matchesContained(node)) return { ancestors: [...ancestors, node.id], itemId: node.id };
    }
    return null;
  };

  return walk(items, []);
}

/**
 * Flattens the tree into a depth-annotated list, respecting the current
 * expansion state.
 *
 * @param items - The root items of the tree to flatten.
 * @param expandedIds - The set of item IDs that are currently expanded.
 * @param options - Optional overrides; pass `{ expandAll: true }` to
 *   ignore the expanded set and flatten every level.
 * @returns The flat list of visible rows, each annotated with its
 *   nesting depth.
 */
export function flattenVisibleSceneTree<T extends { id: string; nestedItems?: readonly T[] }>(
  items: readonly T[],
  expandedIds: ReadonlySet<string>,
  options?: { expandAll?: boolean },
): Array<T & { depth: number }> {
  const rows: Array<T & { depth: number }> = [];
  const visit = (nodes: readonly T[], depth: number) => {
    for (const item of nodes) {
      rows.push({ ...item, depth });
      if (!item.nestedItems?.length) continue;
      if (options?.expandAll || expandedIds.has(item.id)) visit(item.nestedItems, depth + 1);
    }
  };
  visit(items, 0);
  return rows;
}

/**
 * Nests flat scene-tree items using their backing object's parent-child
 * relationships.
 *
 * Items whose {@link object.parentObjectId} points to another item's
 * {@link object.id} are moved into that parent's {@link nestedItems}.
 * Items that cannot be parented are left at the root.
 *
 * @param items - The flat list of scene-tree items.
 * @returns A new array where child items are nested under their parents.
 */
export function nestSceneTreeItemsByParent<
  T extends {
    id: string;
    object?: { id: string; parentObjectId?: string };
    nestedItems?: T[];
  },
>(items: readonly T[]): T[] {
  const byObjectId = new Map<string, T>();
  for (const item of items) {
    if (item.object?.id) byObjectId.set(item.object.id, item);
  }

  const nestedIds = new Set<string>();
  const childrenByParent = new Map<string, T[]>();
  for (const item of items) {
    const parentId = item.object?.parentObjectId;
    if (!parentId || !item.object || parentId === item.object.id) continue;
    const parent = byObjectId.get(parentId);
    if (!parent) continue;
    nestedIds.add(item.id);
    childrenByParent.set(parent.id, [...(childrenByParent.get(parent.id) ?? []), item]);
  }

  if (nestedIds.size === 0) return [...items];

  return items
    .filter((item) => !nestedIds.has(item.id))
    .map((item) => {
      const children = childrenByParent.get(item.id);
      if (!children?.length) return item;
      return { ...item, nestedItems: [...(item.nestedItems ?? []), ...children] };
    });
}

function createPrefixFolderId(groupKey: string, path: readonly string[]): string {
  return `prefix:${groupKey}:${path.map((part) => encodeURIComponent(part)).join("/")}`;
}

function withHierarchyDisplayName<T extends ObjectTreeHierarchyNode<T>>(item: T, path: readonly string[]): T {
  if (!path.length) {
    if (!item.displayName) return item;
    return { ...item, displayName: undefined };
  }
  return { ...item, displayName: objectTreeHierarchyDisplayName(item.name, path) };
}

/**
 * Nests flat scene-tree items by their hierarchy-qualified names.
 *
 * The hierarchy separator in each item's name is used to infer a folder
 * structure. When an item's name exactly matches a prefix path, it
 * becomes the folder container; otherwise a synthetic folder node is
 * created.
 *
 * @param items - The flat list of scene-tree items.
 * @param groupKey - A stable key used to derive synthetic folder IDs.
 * @returns A new nested tree grouped by name hierarchy.
 */
export function nestSceneTreeItemsByName<T extends ObjectTreeHierarchyNode<T>>(
  items: readonly T[],
  groupKey: string,
): T[] {
  type Node = {
    items: T[];
    children: Map<string, Node>;
  };

  const root: Node = { items: [], children: new Map() };
  for (const item of items) {
    const segments = splitObjectTreeHierarchyName(item.name);
    if (segments.length === 0) {
      root.items.push(item);
      continue;
    }
    let node = root;
    for (const segment of segments) {
      let next = node.children.get(segment);
      if (!next) {
        next = { items: [], children: new Map() };
        node.children.set(segment, next);
      }
      node = next;
    }
    node.items.push(item);
  }

  const materialize = (node: Node, path: readonly string[]): T[] => {
    const childRows: T[] = [];
    for (const [segment, child] of node.children) {
      childRows.push(...materialize(child, [...path, segment]));
    }

    if (path.length === 0) return [...node.items, ...childRows];

    const prefixName = path.join(OBJECT_TREE_HIERARCHY_SEPARATOR);
    const displayName = path[path.length - 1]!;
    const localItems = node.items.map((item) => withHierarchyDisplayName(item, path));
    if (node.children.size === 0) return localItems;

    const parentItem = localItems.find((item) => item.name === prefixName);
    const otherLocals = localItems.filter((item) => item !== parentItem);
    const nestedItems = [...otherLocals, ...childRows];

    if (parentItem) {
      return [
        {
          ...parentItem,
          displayName,
          nestedItems: [...(parentItem.nestedItems ?? []), ...nestedItems],
        },
      ];
    }

    if (nestedItems.length < 2) {
      const parentPath = path.slice(0, -1);
      return nestedItems.map((item) => withHierarchyDisplayName(item, parentPath));
    }

    const template = nestedItems[0]!;
    return [
      {
        ...template,
        id: createPrefixFolderId(groupKey, path),
        name: prefixName,
        displayName,
        icon: "folder",
        listKind: "prefix",
        objectIds: collectSceneTreeObjectIds(nestedItems),
        nestedItems,
        object: undefined,
      },
    ];
  };

  return materialize(root, []);
}

/**
 * Full nesting pipeline: parent-object relationships first, then
 * name-based hierarchy grouping.
 *
 * @param items - The flat list of scene-tree items.
 * @param groupKey - A stable key used to derive synthetic folder IDs
 *   during name-based nesting.
 * @returns A fully nested tree.
 */
export function nestSceneTreeItems<T extends ObjectTreeHierarchyNode<T>>(items: readonly T[], groupKey: string): T[] {
  return nestSceneTreeItemsByName(nestSceneTreeItemsByParent(items), groupKey);
}