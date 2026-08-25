import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  Box,
  Camera,
  ChevronDown,
  ChevronRight,
  Crosshair,
  Eye,
  EyeOff,
  Folder,
  Link2,
  Lock,
  MoreHorizontal,
  Pencil,
  Search,
  Trash2,
  Unlock,
  User,
  Users,
} from "lucide-react";
import { ObjectReferenceBindings } from "./ObjectReferenceBindings";
import { VirtualizedObjectList, type VirtualizedObjectRowLayout } from "./VirtualizedObjectList";
import {
  collectExpandableSceneTreeIds,
  collectSceneTreeRevealPath,
  countSceneTreeObjects,
  filterSceneTreeItems,
  flattenVisibleSceneTree,
  nestSceneTreeItems,
} from "./objectTreeHierarchy";
import type { DirectorObject } from "../schema/directorProject";
import { useDirectorStore } from "../store/directorStore";
import { applyDirectorPageEvent } from "../assistant/pageStateBridge";
import { getDirectorObjectFocusSnapshot } from "../canvas/viewportObjectFocus";
import { useLanguage } from "../../i18n/language";

type ObjectTreeIconKind = "character" | "crowd" | "geometry" | "model" | "camera" | "composite" | "folder";
type ObjectTreeGroupKey = "characters" | "crowd" | "geometry" | "my-models" | "composites" | "object-lists" | "cameras";
type ObjectListKind = "crowd" | "manual" | "automatic" | "composite" | "prefix";

type SceneTreePreviewItem = {
  object: ObjectTreeObject;
  name: string;
  icon: ObjectTreeIconKind;
};

type SceneTreeItem = {
  id: string;
  name: string;
  icon: ObjectTreeIconKind;
  object?: ObjectTreeObject;
  objectIds: string[];
  crowdId?: string;
  objectListId?: string;
  compositeParentId?: string;
  listKind?: ObjectListKind;
  previewChildren?: SceneTreePreviewItem[];
  nestedItems?: SceneTreeItem[];
  displayName?: string;
  depth?: number;
};

type ObjectActionMenuState = {
  id: string;
  anchor: HTMLButtonElement;
};

type FloatingMenuPosition = {
  left: number;
  top: number;
};

const FLOATING_MENU_EDGE_GAP = 8;

type ObjectTreeObject = Pick<
  DirectorObject,
  | "id"
  | "name"
  | "kind"
  | "visible"
  | "locked"
  | "layer"
  | "pivot"
  | "assetRefId"
  | "crowdId"
  | "crowdLabel"
  | "parentObjectId"
  | "isCompositeParent"
  | "objectListId"
  | "objectListLabel"
  | "objectListDetached"
  | "linkedCameraId"
>;

const OBJECT_TREE_FIELDS = [
  "id",
  "name",
  "kind",
  "visible",
  "locked",
  "layer",
  "pivot",
  "assetRefId",
  "crowdId",
  "crowdLabel",
  "parentObjectId",
  "isCompositeParent",
  "objectListId",
  "objectListLabel",
  "objectListDetached",
  "linkedCameraId",
] as const satisfies ReadonlyArray<keyof ObjectTreeObject>;

function projectObjectForTree(object: DirectorObject): ObjectTreeObject {
  return Object.fromEntries(OBJECT_TREE_FIELDS.map((field) => [field, object[field]])) as ObjectTreeObject;
}

function objectTreeObjectMatches(object: DirectorObject, projected: ObjectTreeObject) {
  return OBJECT_TREE_FIELDS.every((field) => object[field] === projected[field]);
}

/**
 * Stage transforms update at pointer/animation frequency, but the outliner
 * only consumes identity, grouping, visibility and lock metadata. Preserve
 * the selector result when those fields are unchanged so moving an object
 * does not rebuild every sidebar row.
 */
function createObjectTreeObjectsSelector() {
  let previousSource: DirectorObject[] | null = null;
  let previousResult: ObjectTreeObject[] = [];

  return (state: ReturnType<typeof useDirectorStore.getState>) => {
    const source = state.project.objects;
    if (source === previousSource) return previousResult;
    previousSource = source;

    if (
      source.length === previousResult.length &&
      source.every((object, index) => objectTreeObjectMatches(object, previousResult[index]!))
    ) {
      return previousResult;
    }

    previousResult = source.map(projectObjectForTree);
    return previousResult;
  };
}

function ObjectReferenceBindingsForObject({ objectId }: { objectId: string }) {
  const object = useDirectorStore((state) => state.project.objects.find((item) => item.id === objectId));
  return object ? <ObjectReferenceBindings object={object} /> : null;
}

/**
 * Object-row action menus must not live inside the scrolling sidebar. A menu
 * near its bottom edge otherwise gets cropped even though its trigger remains
 * visible. This portal follows the trigger and flips above it when needed.
 */
function FloatingObjectActionMenu({
  anchor,
  ariaLabel,
  children,
  onDismiss,
  wide = false,
}: {
  anchor: HTMLButtonElement;
  ariaLabel: string;
  children: ReactNode;
  onDismiss: () => void;
  wide?: boolean;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<FloatingMenuPosition | null>(null);

  useLayoutEffect(() => {
    let animationFrame = 0;
    const updatePosition = () => {
      if (!anchor.isConnected) {
        onDismiss();
        return;
      }
      const menu = menuRef.current;
      if (!menu) return;
      const anchorRect = anchor.getBoundingClientRect();
      const menuWidth = menu.offsetWidth;
      const menuHeight = menu.offsetHeight;
      const left = Math.min(
        window.innerWidth - menuWidth - FLOATING_MENU_EDGE_GAP,
        Math.max(FLOATING_MENU_EDGE_GAP, anchorRect.right - menuWidth),
      );
      const below = anchorRect.bottom + FLOATING_MENU_EDGE_GAP;
      const top =
        below + menuHeight <= window.innerHeight - FLOATING_MENU_EDGE_GAP
          ? below
          : Math.max(FLOATING_MENU_EDGE_GAP, anchorRect.top - menuHeight - FLOATING_MENU_EDGE_GAP);
      setPosition({ left, top });
    };
    const schedulePositionUpdate = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(updatePosition);
    };

    updatePosition();
    window.addEventListener("resize", schedulePositionUpdate);
    window.addEventListener("scroll", schedulePositionUpdate, true);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", schedulePositionUpdate);
      window.removeEventListener("scroll", schedulePositionUpdate, true);
    };
  }, [anchor, onDismiss]);

  useEffect(() => {
    const dismissOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && (menuRef.current?.contains(target) || anchor.contains(target))) return;
      onDismiss();
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };
    document.addEventListener("pointerdown", dismissOnOutsidePointer);
    document.addEventListener("keydown", dismissOnEscape);
    return () => {
      document.removeEventListener("pointerdown", dismissOnOutsidePointer);
      document.removeEventListener("keydown", dismissOnEscape);
    };
  }, [anchor, onDismiss]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      aria-label={ariaLabel}
      className={`object-row-action-menu is-floating${wide ? " object-list-action-menu" : ""}${position ? "" : " is-positioning"}`}
      ref={menuRef}
      role="menu"
      style={position ? { left: position.left, top: position.top } : undefined}
    >
      {children}
    </div>,
    document.body,
  );
}

const GROUP_LABELS: Array<{ key: ObjectTreeGroupKey; title: string }> = [
  { key: "characters", title: "角色" },
  { key: "crowd", title: "群众" },
  { key: "geometry", title: "几何体" },
  { key: "my-models", title: "我的模型" },
  { key: "composites", title: "组合对象" },
  { key: "object-lists", title: "对象列表" },
  { key: "cameras", title: "摄像机" },
];

const ObjectKindIcon = memo(function ObjectKindIcon({ icon }: { icon: ObjectTreeIconKind }) {
  const iconProps = { "aria-hidden": true, size: 18, strokeWidth: 1.8 } as const;

  return (
    <span className="object-row-kind-icon" data-testid={`object-row-icon-${icon}`}>
      {icon === "camera" ? <Camera {...iconProps} /> : null}
      {icon === "crowd" ? <Users {...iconProps} /> : null}
      {icon === "folder" ? <Folder {...iconProps} /> : null}
      {icon === "geometry" || icon === "model" || icon === "composite" ? <Box {...iconProps} /> : null}
      {icon === "character" ? <User {...iconProps} /> : null}
    </span>
  );
});

function isEditableKeyboardTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;

  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function createAutomaticListId(groupKey: ObjectTreeGroupKey, name: string) {
  return `automatic:${groupKey}:${encodeURIComponent(name.trim().toLocaleLowerCase())}`;
}

function getObjectListMemberLabel(item: SceneTreeItem, child: SceneTreePreviewItem, index: number) {
  if (item.listKind === "crowd" || item.listKind === "composite") return child.name;

  return `${child.name}（${index + 1}）`;
}

function getSceneTreeItemLabel(item: SceneTreeItem) {
  return item.displayName?.trim() || item.name;
}

export function ObjectTreePanel() {
  const objectTreeScrollRef = useRef<HTMLDivElement>(null);
  const { t } = useLanguage();
  const [query, setQuery] = useState("");
  const [expandedListIds, setExpandedListIds] = useState<string[]>([]);
  const [expandedReferenceIds, setExpandedReferenceIds] = useState<string[]>([]);
  const [collapsedGroupKeys, setCollapsedGroupKeys] = useState<string[]>([]);
  const [revealItemId, setRevealItemId] = useState<string | null>(null);
  const revealedSelectionKeyRef = useRef<string | null>(null);
  const [renamingItemId, setRenamingItemId] = useState<string | null>(null);
  const [openActionMenu, setOpenActionMenu] = useState<ObjectActionMenuState | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const assets = useDirectorStore((state) => state.project.assets);
  const selectObjectTreeObjects = useMemo(createObjectTreeObjectsSelector, []);
  const objects = useDirectorStore(selectObjectTreeObjects);
  const selectedObjectId = useDirectorStore((state) => state.selectedObjectId);
  const selectedObjectIds = useDirectorStore((state) => state.selectedObjectIds);
  const selectedCrowdId = useDirectorStore((state) => state.selectedCrowdId);
  const selectObject = useDirectorStore((state) => state.selectObject);
  const selectCrowd = useDirectorStore((state) => state.selectCrowd);
  const toggleObjectSelection = useDirectorStore((state) => state.toggleObjectSelection);
  const setActiveCamera = useDirectorStore((state) => state.setActiveCamera);
  const toggleObjectVisible = useDirectorStore((state) => state.toggleObjectVisible);
  const toggleObjectLocked = useDirectorStore((state) => state.toggleObjectLocked);
  const deleteSelectedObject = useDirectorStore((state) => state.deleteSelectedObject);
  const deleteObjects = useDirectorStore((state) => state.deleteObjects);
  const updateObjectName = useDirectorStore((state) => state.updateObjectName);
  const updateCrowdLabel = useDirectorStore((state) => state.updateCrowdLabel);
  const createObjectList = useDirectorStore((state) => state.createObjectList);
  const addObjectsToObjectList = useDirectorStore((state) => state.addObjectsToObjectList);
  const removeObjectsFromObjectList = useDirectorStore((state) => state.removeObjectsFromObjectList);
  const updateObjectListLabel = useDirectorStore((state) => state.updateObjectListLabel);
  const addObjectsToComposite = useDirectorStore((state) => state.addObjectsToComposite);
  const removeObjectsFromComposite = useDirectorStore((state) => state.removeObjectsFromComposite);
  const openActionMenuObjectId = openActionMenu?.id ?? null;
  const effectiveSelectedObjectIds = useMemo(
    () => (selectedObjectIds.length ? selectedObjectIds : selectedObjectId ? [selectedObjectId] : []),
    [selectedObjectId, selectedObjectIds],
  );
  const selectedObjectIdSet = useMemo(() => new Set(effectiveSelectedObjectIds), [effectiveSelectedObjectIds]);
  const expandedListIdSet = useMemo(() => new Set(expandedListIds), [expandedListIds]);
  const expandedReferenceIdSet = useMemo(() => new Set(expandedReferenceIds), [expandedReferenceIds]);
  const collapsedGroupKeySet = useMemo(() => new Set(collapsedGroupKeys), [collapsedGroupKeys]);

  function closeActionMenu() {
    setOpenActionMenu(null);
  }

  function toggleActionMenu(id: string, event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    const anchor = event.currentTarget;
    setOpenActionMenu((current) => (current?.id === id ? null : { id, anchor }));
  }

  function focusObjects(objectIds: readonly string[]) {
    const state = useDirectorStore.getState();
    const snapshot = getDirectorObjectFocusSnapshot(state.project, objectIds);
    if (!snapshot) return;
    state.selectObjects([...objectIds]);
    applyDirectorPageEvent({
      sequence: Date.now(),
      sceneId: "human-workbench",
      revision: Date.now(),
      tabId: "director-workbench",
      createdAt: new Date().toISOString(),
      state: { viewportCamera: snapshot },
    });
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      if (isEditableKeyboardTarget(event.target)) return;
      const state = useDirectorStore.getState();
      if (!state.selectedObjectId && state.selectedObjectIds.length === 0) return;

      event.preventDefault();
      deleteSelectedObject();
    }

    document.addEventListener("keydown", handleKeyDown);

    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [deleteSelectedObject]);

  const assetsById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets]);
  const isModelBackedObject = useCallback(
    (object: ObjectTreeObject | undefined) => {
      if (!object?.assetRefId) return false;

      const asset = assetsById.get(object.assetRefId);
      return !asset || asset.sourceType === "model";
    },
    [assetsById],
  );

  const getObjectIcon = useCallback(
    (object: ObjectTreeObject): ObjectTreeIconKind =>
      object.isCompositeParent
        ? "composite"
        : object.kind === "camera"
          ? "camera"
          : object.kind === "character"
            ? "character"
            : isModelBackedObject(object)
              ? "model"
              : "geometry",
    [isModelBackedObject],
  );

  const getObjectGroupKey = useCallback(
    (object: ObjectTreeObject): ObjectTreeGroupKey => {
      if (object.isCompositeParent) return "composites";
      if (object.kind === "character") return "characters";
      if (object.kind === "camera") return "cameras";
      if (isModelBackedObject(object)) return "my-models";
      return "geometry";
    },
    [isModelBackedObject],
  );

  const groupedItems = useMemo(() => {
    const groups: Record<ObjectTreeGroupKey, SceneTreeItem[]> = {
      characters: [],
      crowd: [],
      geometry: [],
      "my-models": [],
      composites: [],
      "object-lists": [],
      cameras: [],
    };
    const crowdItems = new Map<string, SceneTreeItem>();
    const compositeItems = new Map<string, SceneTreeItem>();
    const manualListObjects = new Map<string, ObjectTreeObject[]>();
    const regularObjects: Record<ObjectTreeGroupKey, ObjectTreeObject[]> = {
      characters: [],
      crowd: [],
      geometry: [],
      "my-models": [],
      composites: [],
      "object-lists": [],
      cameras: [],
    };

    objects.forEach((object) => {
      if (!object.isCompositeParent) return;
      compositeItems.set(object.id, {
        id: object.id,
        name: object.name,
        icon: "composite",
        object,
        compositeParentId: object.id,
        listKind: "composite",
        objectIds: [object.id],
        previewChildren: [],
      });
    });

    objects.forEach((object) => {
      if (object.isCompositeParent) return;
      if (object.parentObjectId) {
        const parent = compositeItems.get(object.parentObjectId);
        if (parent) {
          parent.objectIds.push(object.id);
          parent.previewChildren = [
            ...(parent.previewChildren ?? []),
            { object, name: object.name, icon: getObjectIcon(object) },
          ];
          return;
        }
      }
      if (object.kind === "character" && object.crowdId && object.crowdLabel) {
        const existing = crowdItems.get(object.crowdId);
        const child = { object, name: object.name, icon: "character" as const };
        if (existing) {
          existing.objectIds.push(object.id);
          existing.previewChildren = [...(existing.previewChildren ?? []), child];
        } else {
          crowdItems.set(object.crowdId, {
            id: object.crowdId,
            name: object.crowdLabel,
            icon: "crowd",
            crowdId: object.crowdId,
            listKind: "crowd",
            objectIds: [object.id],
            previewChildren: [child],
          });
        }
        return;
      }

      if (object.objectListId) {
        manualListObjects.set(object.objectListId, [...(manualListObjects.get(object.objectListId) ?? []), object]);
        return;
      }

      regularObjects[getObjectGroupKey(object)].push(object);
    });

    groups.crowd = Array.from(crowdItems.values());
    groups.composites = Array.from(compositeItems.values());

    manualListObjects.forEach((listObjects, objectListId) => {
      const keys = Array.from(new Set(listObjects.map((object) => getObjectGroupKey(object))));
      const groupKey = keys.length === 1 ? keys[0]! : "object-lists";
      const first = listObjects[0]!;
      groups[groupKey].push({
        id: objectListId,
        name: first.objectListLabel?.trim() || first.name,
        icon: getObjectIcon(first),
        objectListId,
        listKind: "manual",
        objectIds: listObjects.map((object) => object.id),
        previewChildren: listObjects.map((object) => ({ object, name: object.name, icon: getObjectIcon(object) })),
      });
    });

    (Object.keys(regularObjects) as ObjectTreeGroupKey[]).forEach((groupKey) => {
      const itemsByName = new Map<string, ObjectTreeObject[]>();
      regularObjects[groupKey].forEach((object) => {
        const normalizedName = object.name.trim().toLocaleLowerCase();
        if (object.objectListDetached || !normalizedName) {
          groups[groupKey].push({
            id: object.id,
            name: object.name,
            icon: getObjectIcon(object),
            object,
            objectIds: [object.id],
          });
          return;
        }
        itemsByName.set(normalizedName, [...(itemsByName.get(normalizedName) ?? []), object]);
      });

      itemsByName.forEach((sameNameObjects) => {
        if (sameNameObjects.length === 1) {
          const object = sameNameObjects[0]!;
          groups[groupKey].push({
            id: object.id,
            name: object.name,
            icon: getObjectIcon(object),
            object,
            objectIds: [object.id],
          });
          return;
        }

        const first = sameNameObjects[0]!;
        groups[groupKey].push({
          id: createAutomaticListId(groupKey, first.name),
          name: first.name,
          icon: getObjectIcon(first),
          listKind: "automatic",
          objectIds: sameNameObjects.map((object) => object.id),
          previewChildren: sameNameObjects.map((object) => ({
            object,
            name: object.name,
            icon: getObjectIcon(object),
          })),
        });
      });
    });

    (Object.keys(groups) as ObjectTreeGroupKey[]).forEach((groupKey) => {
      groups[groupKey] = nestSceneTreeItems(groups[groupKey], groupKey);
    });

    return groups;
  }, [getObjectGroupKey, getObjectIcon, objects]);

  useEffect(() => {
    const availableListIds = new Set(collectExpandableSceneTreeIds(Object.values(groupedItems).flat()));
    setExpandedListIds((current) => current.filter((listId) => availableListIds.has(listId)));
  }, [groupedItems]);

  const hasQuery = query.trim().length > 0;
  const filteredGroups = useMemo(
    () =>
      GROUP_LABELS.map((group) => {
        const items = hasQuery ? filterSceneTreeItems(groupedItems[group.key], query) : groupedItems[group.key];
        return { ...group, items, objectCount: countSceneTreeObjects(items) };
      }).filter((group) => group.items.length > 0),
    [groupedItems, hasQuery, query],
  );
  const visibleGroups = useMemo(
    () =>
      filteredGroups.map((group) => ({
        ...group,
        visibleItems: flattenVisibleSceneTree(group.items, expandedListIdSet, { expandAll: hasQuery }),
      })),
    [expandedListIdSet, filteredGroups, hasQuery],
  );
  const hasEmptySearchResult = hasQuery && filteredGroups.length === 0;

  useLayoutEffect(() => {
    if (hasQuery) {
      revealedSelectionKeyRef.current = null;
      return;
    }
    const objectId = selectedObjectId ?? effectiveSelectedObjectIds[effectiveSelectedObjectIds.length - 1] ?? null;
    if (!objectId && !selectedCrowdId) {
      revealedSelectionKeyRef.current = null;
      return;
    }
    const selectionKey = `${selectedCrowdId ?? ""}:${effectiveSelectedObjectIds.join(",")}`;
    if (revealedSelectionKeyRef.current === selectionKey) return;

    for (const group of filteredGroups) {
      const path = collectSceneTreeRevealPath(group.items, { crowdId: selectedCrowdId, objectId });
      if (!path) continue;
      revealedSelectionKeyRef.current = selectionKey;
      setCollapsedGroupKeys((current) => (current.includes(group.key) ? current.filter((key) => key !== group.key) : current));
      if (path.ancestors.length) {
        setExpandedListIds((current) => {
          const next = new Set(current);
          let changed = false;
          for (const id of path.ancestors) {
            if (next.has(id)) continue;
            next.add(id);
            changed = true;
          }
          return changed ? [...next] : current;
        });
      }
      setRevealItemId(path.itemId);
      return;
    }
  }, [effectiveSelectedObjectIds, filteredGroups, hasQuery, selectedCrowdId, selectedObjectId]);

  function selectTreeItem(item: SceneTreeItem, event: MouseEvent<HTMLElement>) {
    if (item.compositeParentId) {
      // A composition row selects its parent transform by default. Children
      // are selected only from their nested rows, mirroring Blender's outliner.
      if (event.shiftKey) {
        toggleObjectSelection(item.compositeParentId);
        return;
      }
      selectObject(item.compositeParentId);
      return;
    }
    if (item.crowdId) {
      if (event.shiftKey) {
        const allSelected = item.objectIds.every((id) => selectedObjectIdSet.has(id));
        item.objectIds.forEach((id) => {
          if (allSelected ? selectedObjectIdSet.has(id) : !selectedObjectIdSet.has(id)) toggleObjectSelection(id);
        });
        return;
      }
      selectCrowd(item.crowdId);
      return;
    }

    if (item.objectIds.length > 1) {
      if (event.shiftKey) {
        const allSelected = item.objectIds.every((id) => selectedObjectIdSet.has(id));
        item.objectIds.forEach((id) => {
          if (allSelected ? selectedObjectIdSet.has(id) : !selectedObjectIdSet.has(id)) toggleObjectSelection(id);
        });
        return;
      }
      const [firstId, ...restIds] = item.objectIds;
      selectObject(firstId ?? null);
      restIds.forEach((id) => toggleObjectSelection(id));
      return;
    }

    if (event.shiftKey) {
      toggleObjectSelection(item.id);
      return;
    }
    if (item.object?.kind === "camera" && item.object.linkedCameraId) {
      setActiveCamera(item.object.linkedCameraId);
      return;
    }
    selectObject(item.id);
  }

  function selectChildObject(child: SceneTreePreviewItem, parent: SceneTreeItem, event: MouseEvent<HTMLElement>) {
    if (parent.crowdId) {
      selectTreeItem(parent, event);
      return;
    }
    selectTreeItem(
      {
        id: child.object.id,
        name: child.object.name,
        icon: child.icon,
        object: child.object,
        objectIds: [child.object.id],
      },
      event,
    );
  }

  function toggleListExpanded(listId: string) {
    setExpandedListIds((current) =>
      current.includes(listId) ? current.filter((item) => item !== listId) : [...current, listId],
    );
  }

  function toggleReferences(objectId: string) {
    // Opening a binding editor is also an object-focused action. Keep the
    // selected-row treatment in sync instead of making the cyan link icon the
    // only indication of which object's references are being edited.
    selectObject(objectId);
    setExpandedReferenceIds((current) =>
      current.includes(objectId) ? current.filter((item) => item !== objectId) : [...current, objectId],
    );
  }

  function toggleGroupCollapsed(groupKey: string) {
    setCollapsedGroupKeys((current) =>
      current.includes(groupKey) ? current.filter((item) => item !== groupKey) : [...current, groupKey],
    );
  }

  function beginRename(item: SceneTreeItem) {
    setRenameDraft(item.name);
    setRenamingItemId(item.id);
  }

  function beginChildRename(child: SceneTreePreviewItem) {
    setRenameDraft(child.object.name);
    setRenamingItemId(child.object.id);
  }

  function commitRename(item: SceneTreeItem) {
    const nextName = renameDraft.trim();
    if (nextName && nextName !== item.name) {
      if (item.crowdId) updateCrowdLabel(item.crowdId, nextName);
      else if (item.listKind === "manual" && item.objectListId) updateObjectListLabel(item.objectListId, nextName);
      else if (item.listKind === "automatic") createObjectList(item.objectIds, nextName);
      else if (item.object) updateObjectName(item.object.id, nextName);
    }
    setRenamingItemId(null);
  }

  function commitChildRename(child: SceneTreePreviewItem) {
    const nextName = renameDraft.trim();
    if (nextName && nextName !== child.object.name) updateObjectName(child.object.id, nextName);
    setRenamingItemId(null);
  }

  function addSelectedObjectsToList(item: SceneTreeItem) {
    const candidateIds = effectiveSelectedObjectIds.filter((id) => !item.objectIds.includes(id));
    if (!candidateIds.length || item.listKind === "crowd") return;

    if (item.listKind === "composite" && item.compositeParentId) {
      addObjectsToComposite(candidateIds, item.compositeParentId);
      return;
    }

    if (item.listKind === "manual" && item.objectListId) {
      addObjectsToObjectList(candidateIds, item.objectListId);
      return;
    }
    if (item.listKind === "automatic" || item.listKind === "prefix") {
      createObjectList([...item.objectIds, ...candidateIds], item.name);
    }
  }

  function renderChildRow(item: SceneTreeItem, child: SceneTreePreviewItem, index: number) {
    const childName = getObjectListMemberLabel(item, child, index);
    const selected = selectedObjectIdSet.has(child.object.id);
    const referencesExpanded = expandedReferenceIdSet.has(child.object.id);
    const actionsExpanded = openActionMenuObjectId === child.object.id;

    return (
      <li key={child.object.id}>
        <div
          className={`object-row object-row-preview${selected ? " is-selected" : ""}`}
          data-i18n-preserve-attributes
          role="treeitem"
          aria-label={childName}
          aria-selected={selected}
          onClick={(event) => selectChildObject(child, item, event)}
        >
          <span className="object-row-preview-spacer" aria-hidden="true" />
          <div className="object-row-main">
            {renamingItemId === child.object.id ? (
              <div className="object-row-name-editor">
                <ObjectKindIcon icon={child.icon} />
                <input
                  aria-label={`编辑 ${childName} 名称`}
                  autoFocus
                  className="object-row-rename-input"
                  maxLength={120}
                  onBlur={() => commitChildRename(child)}
                  onChange={(event) => setRenameDraft(event.target.value)}
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                    if (event.key === "Escape") {
                      setRenameDraft(child.object.name);
                      setRenamingItemId(null);
                    }
                  }}
                  value={renameDraft}
                />
              </div>
            ) : (
              <button className="object-select-button" type="button">
                <ObjectKindIcon icon={child.icon} />
                <span data-i18n-user-content>{t(childName)}</span>
              </button>
            )}
          </div>
          <button
            className="object-flag-button object-icon-flag-button"
            type="button"
            aria-label={`重命名 ${childName}`}
            onClick={(event) => {
              event.stopPropagation();
              beginChildRename(child);
            }}
          >
            <Pencil aria-hidden="true" size={17} strokeWidth={1.9} />
          </button>
          <button
            className={`object-flag-button object-icon-flag-button${referencesExpanded ? " is-active" : ""}`}
            type="button"
            aria-label={`${referencesExpanded ? "收起" : "展开"} ${childName} 参考绑定`}
            onClick={(event) => {
              event.stopPropagation();
              toggleReferences(child.object.id);
            }}
          >
            <Link2 aria-hidden="true" size={17} strokeWidth={1.9} />
          </button>
          <button
            className={`object-flag-button object-icon-flag-button${actionsExpanded ? " is-active" : ""}`}
            type="button"
            aria-label={`打开 ${childName} 对象操作`}
            aria-expanded={actionsExpanded}
            onClick={(event) => toggleActionMenu(child.object.id, event)}
          >
            <MoreHorizontal aria-hidden="true" size={18} strokeWidth={1.9} />
          </button>
        </div>
        {actionsExpanded ? (
          <FloatingObjectActionMenu
            anchor={openActionMenu!.anchor}
            ariaLabel={`${childName} 对象操作`}
            onDismiss={closeActionMenu}
          >
            <button
              role="menuitem"
              type="button"
              aria-label={`在视图中定位 ${childName}`}
              onClick={() => {
                focusObjects([child.object.id]);
                closeActionMenu();
              }}
            >
              <Crosshair aria-hidden size={16} /> 在视图中定位
            </button>
            <button
              role="menuitem"
              type="button"
              aria-label={`${childName} 可见性`}
              onClick={() => {
                toggleObjectVisible(child.object.id);
                closeActionMenu();
              }}
            >
              {child.object.visible ? <Eye aria-hidden size={16} /> : <EyeOff aria-hidden size={16} />}
              {child.object.visible ? "隐藏对象" : "显示对象"}
            </button>
            <button
              role="menuitem"
              type="button"
              aria-label={`${childName} 锁定`}
              onClick={() => {
                toggleObjectLocked(child.object.id);
                closeActionMenu();
              }}
            >
              {child.object.locked ? <Unlock aria-hidden size={16} /> : <Lock aria-hidden size={16} />}
              {child.object.locked ? "解除锁定" : "锁定对象"}
            </button>
            {item.listKind === "composite" ? (
              <button
                role="menuitem"
                type="button"
                aria-label={`移出 ${item.name} 组合`}
                onClick={() => {
                  removeObjectsFromComposite([child.object.id]);
                  closeActionMenu();
                }}
              >
                移出组合
              </button>
            ) : item.listKind !== "crowd" ? (
              <button
                role="menuitem"
                type="button"
                aria-label={`移出 ${item.name} 列表`}
                onClick={() => {
                  removeObjectsFromObjectList([child.object.id]);
                  closeActionMenu();
                }}
              >
                移出列表
              </button>
            ) : null}
            <button
              className="is-danger"
              role="menuitem"
              type="button"
              aria-label={`删除 ${childName}`}
              onClick={() => {
                deleteObjects([child.object.id]);
                closeActionMenu();
              }}
            >
              <Trash2 aria-hidden size={16} /> 删除对象
            </button>
          </FloatingObjectActionMenu>
        ) : null}
        {referencesExpanded ? <ObjectReferenceBindingsForObject objectId={child.object.id} /> : null}
      </li>
    );
  }

  return (
    <section className="panel-card object-tree-panel">
      <h2 className="visually-hidden">场景对象</h2>
      <label className="object-search-field">
        <Search aria-hidden="true" size={16} strokeWidth={1.8} />
        <input
          className="ui-field"
          aria-label="搜索场景内容"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="请输入搜索内容"
        />
      </label>
      {hasEmptySearchResult ? (
        <div className="object-search-empty-state" role="status" aria-label="未搜索到内容">
          <span className="object-search-empty-icon" data-testid="object-search-empty-icon">
            <Search aria-hidden="true" size={16} strokeWidth={1.8} />
          </span>
          <span>未搜索到内容</span>
        </div>
      ) : (
        <div ref={objectTreeScrollRef} className="object-tree-groups" role="tree" aria-label="场景对象列表">
          {visibleGroups.map((group) => (
            <section key={group.key} className="object-tree-group" role="group" aria-label={`${group.title}分组`}>
              <h3>
                <button
                  aria-expanded={hasQuery ? true : !collapsedGroupKeySet.has(group.key)}
                  aria-label={`${hasQuery || !collapsedGroupKeySet.has(group.key) ? "收起" : "展开"} ${group.title}分组`}
                  className="object-tree-group-toggle"
                  onClick={() => toggleGroupCollapsed(group.key)}
                  type="button"
                >
                  {hasQuery || !collapsedGroupKeySet.has(group.key) ? (
                    <ChevronDown aria-hidden="true" size={14} strokeWidth={1.8} />
                  ) : (
                    <ChevronRight aria-hidden="true" size={14} strokeWidth={1.8} />
                  )}
                  <span>{group.title}</span>
                  <small>{group.objectCount}</small>
                </button>
              </h3>
              {hasQuery || !collapsedGroupKeySet.has(group.key) ? (
                <VirtualizedObjectList
                  items={group.visibleItems}
                  scrollRef={objectTreeScrollRef}
                  scrollToId={revealItemId}
                  renderItem={(item, virtualRow?: VirtualizedObjectRowLayout) => {
                    const label = getSceneTreeItemLabel(item);
                    const depth = item.depth ?? 0;
                    const isList = Boolean(item.listKind);
                    const isExpandable = isList || Boolean(item.nestedItems?.length);
                    const isFolderRow = item.listKind === "prefix" || Boolean(item.nestedItems?.length);
                    const nestedCount = item.nestedItems?.length ? countSceneTreeObjects(item.nestedItems) : 0;
                    const selected = item.compositeParentId
                      ? selectedObjectIdSet.has(item.compositeParentId)
                      : item.crowdId
                        ? selectedCrowdId === item.crowdId || item.objectIds.every((id) => selectedObjectIdSet.has(id))
                        : item.objectIds.length > 1
                          ? item.objectIds.every((id) => selectedObjectIdSet.has(id))
                          : selectedObjectIdSet.has(item.id);
                    const expanded = isExpandable && (hasQuery || expandedListIdSet.has(item.id));
                    const referencesExpanded = item.object ? expandedReferenceIdSet.has(item.object.id) : false;
                    const actionsExpanded = openActionMenuObjectId === item.id;
                    const canAddSelectedObjects =
                      actionsExpanded &&
                      item.listKind !== "crowd" &&
                      effectiveSelectedObjectIds.some((id) => !item.objectIds.includes(id));
                    const rowStyle = {
                      "--object-tree-depth": String(depth),
                    } as CSSProperties;

                    return (
                      <li
                        key={item.id}
                        ref={virtualRow?.measureElement}
                        className="object-list-item"
                        data-index={virtualRow?.index}
                        data-object-tree-id={item.id}
                        style={virtualRow?.style}
                      >
                        <div
                          className={`object-row${selected ? " is-selected" : ""}${isList ? " object-row-list" : ""}${isFolderRow ? " is-tree-folder" : ""}`}
                          data-i18n-preserve-attributes
                          data-tree-depth={depth}
                          role="treeitem"
                          aria-label={item.name}
                          aria-level={depth + 1}
                          aria-expanded={isExpandable ? expanded : undefined}
                          aria-selected={selected}
                          style={rowStyle}
                          onClick={(event) => selectTreeItem(item, event)}
                        >
                          <div className="object-row-main">
                            {isExpandable ? (
                              <button
                                aria-label={`${expanded ? "收起" : "展开"} ${label}`}
                                className="object-row-toggle-button"
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  toggleListExpanded(item.id);
                                }}
                              >
                                {expanded ? (
                                  <ChevronDown aria-hidden="true" size={14} strokeWidth={1.8} />
                                ) : (
                                  <ChevronRight aria-hidden="true" size={14} strokeWidth={1.8} />
                                )}
                              </button>
                            ) : (
                              <span className="object-row-toggle-spacer" aria-hidden="true" />
                            )}
                            {renamingItemId === item.id ? (
                              <div className="object-row-name-editor">
                                <ObjectKindIcon icon={item.icon} />
                                <input
                                  aria-label={`编辑 ${label} 名称`}
                                  autoFocus
                                  className="object-row-rename-input"
                                  maxLength={120}
                                  onBlur={() => commitRename(item)}
                                  onChange={(event) => setRenameDraft(event.target.value)}
                                  onClick={(event) => event.stopPropagation()}
                                  onKeyDown={(event) => {
                                    if (event.key === "Enter") event.currentTarget.blur();
                                    if (event.key === "Escape") {
                                      setRenameDraft(item.name);
                                      setRenamingItemId(null);
                                    }
                                  }}
                                  value={renameDraft}
                                />
                              </div>
                            ) : (
                              <button className="object-select-button" type="button">
                                <ObjectKindIcon icon={item.icon} />
                                <span data-i18n-user-content>{t(label)}</span>
                                {nestedCount > 0 ? (
                                  <small aria-hidden="true" className="object-row-count">
                                    {nestedCount}
                                  </small>
                                ) : null}
                              </button>
                            )}
                          </div>
                          {item.listKind === "prefix" ? null : (
                            <button
                              className="object-flag-button object-icon-flag-button"
                              type="button"
                              aria-label={`重命名 ${label}`}
                              onClick={(event) => {
                                event.stopPropagation();
                                beginRename(item);
                              }}
                            >
                              <Pencil aria-hidden="true" size={17} strokeWidth={1.9} />
                            </button>
                          )}
                          {item.object ? (
                            <>
                              {!item.compositeParentId ? (
                                <button
                                  className={`object-flag-button object-icon-flag-button${referencesExpanded ? " is-active" : ""}`}
                                  type="button"
                                  aria-label={`${referencesExpanded ? "收起" : "展开"} ${label} 参考绑定`}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    toggleReferences(item.object!.id);
                                  }}
                                >
                                  <Link2 aria-hidden="true" size={17} strokeWidth={1.9} />
                                </button>
                              ) : null}
                              <button
                                className={`object-flag-button object-icon-flag-button${actionsExpanded ? " is-active" : ""}`}
                                type="button"
                                aria-label={`打开 ${label} 对象操作`}
                                aria-expanded={actionsExpanded}
                                onClick={(event) => toggleActionMenu(item.id, event)}
                              >
                                <MoreHorizontal aria-hidden="true" size={18} strokeWidth={1.9} />
                              </button>
                            </>
                          ) : item.listKind === "crowd" ? (
                            <button
                              className="object-flag-button object-icon-flag-button"
                              type="button"
                              aria-label={`删除 ${label}`}
                              onClick={(event) => {
                                event.stopPropagation();
                                deleteObjects(item.objectIds);
                              }}
                            >
                              <Trash2 aria-hidden="true" size={17} strokeWidth={1.8} />
                            </button>
                          ) : (
                            <button
                              className={`object-flag-button object-icon-flag-button${actionsExpanded ? " is-active" : ""}`}
                              type="button"
                              aria-label={`打开 ${label} 列表操作`}
                              aria-expanded={actionsExpanded}
                              onClick={(event) => toggleActionMenu(item.id, event)}
                            >
                              <MoreHorizontal aria-hidden="true" size={18} strokeWidth={1.9} />
                            </button>
                          )}
                        </div>
                        {item.object && actionsExpanded ? (
                          <FloatingObjectActionMenu
                            anchor={openActionMenu!.anchor}
                            ariaLabel={`${item.name} 对象操作`}
                            onDismiss={closeActionMenu}
                          >
                            {item.compositeParentId ? (
                              <button
                                role="menuitem"
                                type="button"
                                disabled={!canAddSelectedObjects}
                                onClick={() => {
                                  addSelectedObjectsToList(item);
                                  closeActionMenu();
                                }}
                              >
                                将选中对象加入组合
                              </button>
                            ) : null}
                            {item.object.kind !== "camera" ? (
                              <button
                                role="menuitem"
                                type="button"
                                aria-label={`在视图中定位 ${item.name}`}
                                onClick={() => {
                                  focusObjects(item.objectIds);
                                  closeActionMenu();
                                }}
                              >
                                <Crosshair aria-hidden size={16} /> 在视图中定位
                              </button>
                            ) : null}
                            <button
                              role="menuitem"
                              type="button"
                              aria-label={`${item.name} 可见性`}
                              onClick={() => {
                                toggleObjectVisible(item.id);
                                closeActionMenu();
                              }}
                            >
                              {item.object.visible ? <Eye aria-hidden size={16} /> : <EyeOff aria-hidden size={16} />}
                              {item.object.visible ? "隐藏对象" : "显示对象"}
                            </button>
                            <button
                              role="menuitem"
                              type="button"
                              aria-label={`${item.name} 锁定`}
                              onClick={() => {
                                toggleObjectLocked(item.id);
                                closeActionMenu();
                              }}
                            >
                              {item.object.locked ? <Unlock aria-hidden size={16} /> : <Lock aria-hidden size={16} />}
                              {item.object.locked ? "解除锁定" : "锁定对象"}
                            </button>
                            {item.compositeParentId ? (
                              <button
                                className="is-danger"
                                role="menuitem"
                                type="button"
                                aria-label={`解散 ${item.name} 组合`}
                                onClick={() => {
                                  deleteObjects([item.compositeParentId!]);
                                  closeActionMenu();
                                }}
                              >
                                <Trash2 aria-hidden size={16} /> 解散组合（保留子对象）
                              </button>
                            ) : (
                              <button
                                className="is-danger"
                                role="menuitem"
                                type="button"
                                aria-label={`删除 ${item.name}`}
                                onClick={() => {
                                  deleteObjects(item.objectIds);
                                  closeActionMenu();
                                }}
                              >
                                <Trash2 aria-hidden size={16} /> 删除对象
                              </button>
                            )}
                          </FloatingObjectActionMenu>
                        ) : null}
                        {!item.object && actionsExpanded ? (
                          <FloatingObjectActionMenu
                            anchor={openActionMenu!.anchor}
                            ariaLabel={`${item.name} 列表操作`}
                            onDismiss={closeActionMenu}
                            wide
                          >
                            {item.listKind !== "crowd" ? (
                              <>
                                <button
                                  role="menuitem"
                                  type="button"
                                  aria-label={`在视图中定位 ${item.name}`}
                                  onClick={() => {
                                    focusObjects(item.objectIds);
                                    closeActionMenu();
                                  }}
                                >
                                  <Crosshair aria-hidden size={16} /> 在视图中定位
                                </button>
                                <button
                                  role="menuitem"
                                  type="button"
                                  disabled={!canAddSelectedObjects}
                                  onClick={() => {
                                    addSelectedObjectsToList(item);
                                    closeActionMenu();
                                  }}
                                >
                                  将选中对象加入列表
                                </button>
                              </>
                            ) : null}
                            <button
                              className="is-danger"
                              role="menuitem"
                              type="button"
                              aria-label={`删除 ${item.name}`}
                              onClick={() => {
                                deleteObjects(item.objectIds);
                                closeActionMenu();
                              }}
                            >
                              <Trash2 aria-hidden size={16} /> 删除列表内对象
                            </button>
                          </FloatingObjectActionMenu>
                        ) : null}
                        {item.object && referencesExpanded ? (
                          <ObjectReferenceBindingsForObject objectId={item.object.id} />
                        ) : null}
                        {isList && expanded && item.previewChildren?.length ? (
                          <ul className="object-crowd-preview-list" aria-label={`${item.name} 成员预览`}>
                            {item.previewChildren.map((child, index) => renderChildRow(item, child, index))}
                          </ul>
                        ) : null}
                      </li>
                    );
                  }}
                />
              ) : null}
            </section>
          ))}
        </div>
      )}
    </section>
  );
}
