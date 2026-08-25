export interface DirectorHierarchyObject {
  id: string;
  parent_id?: string;
}

export type DirectorHierarchyNode<T extends DirectorHierarchyObject> = T & {
  children: Array<DirectorHierarchyNode<T>>;
};

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
