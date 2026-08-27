/**
 * Bounded tree view over Director's flat `parent_id` object list.
 *
 * `director_workbench` observe stores objects flat; agents that ask for
 * `layout: "hierarchy"` get this projection instead so parent/child scene
 * structure is readable without a second query. The tree is size-capped and
 * reports truncation explicitly, keeping observe responses within tool-result
 * budgets.
 *
 * @module directorObjectHierarchy
 */

/** Minimal shape a scene object must expose to participate in the tree. */
export interface DirectorHierarchyObject {
  id: string;
  parent_id?: string;
}

/** One tree node: the original object plus its resolved children. */
export type DirectorHierarchyNode<T extends DirectorHierarchyObject> = T & {
  children: Array<DirectorHierarchyNode<T>>;
};

/**
 * Hierarchy projection returned to observe callers. `truncated` is true when
 * the `maxObjects` budget cut nodes; counts let the caller decide whether to
 * re-query with a narrower filter.
 */
export interface DirectorObjectHierarchy<T extends DirectorHierarchyObject> {
  mode: "hierarchy";
  roots: Array<DirectorHierarchyNode<T>>;
  total_count: number;
  returned_count: number;
  truncated: boolean;
}

/** Build a stable, bounded tree from Director's flat parent_id object list. */
export function buildDirectorObjectHierarchy<T extends DirectorHierarchyObject>(
  objects: T[],
  maxObjects: number,
): DirectorObjectHierarchy<T> {
  const byId = new Map(objects.map((object) => [object.id, object]));
  const childIds = new Map<string, string[]>();

  objects.forEach((object) => {
    if (!object.parent_id || !byId.has(object.parent_id)) return;
    const siblings = childIds.get(object.parent_id) ?? [];
    siblings.push(object.id);
    childIds.set(object.parent_id, siblings);
  });

  let returnedCount = 0;
  const buildNode = (id: string): DirectorHierarchyNode<T> | null => {
    if (returnedCount >= maxObjects) return null;
    const object = byId.get(id);
    if (!object) return null;
    returnedCount += 1;
    const children = (childIds.get(id) ?? []).flatMap((childId) => {
      const child = buildNode(childId);
      return child ? [child] : [];
    });
    return { ...object, children };
  };

  // Objects whose parent_id does not resolve are promoted to roots rather
  // than dropped, so a dangling reference never hides a subtree.
  const roots = objects.flatMap((object) => {
    if (object.parent_id && byId.has(object.parent_id)) return [];
    const root = buildNode(object.id);
    return root ? [root] : [];
  });

  return {
    mode: "hierarchy",
    roots,
    total_count: objects.length,
    returned_count: returnedCount,
    truncated: returnedCount < objects.length,
  };
}
