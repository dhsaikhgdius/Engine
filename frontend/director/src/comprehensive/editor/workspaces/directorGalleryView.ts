import { summarizeDirectorComfyMetadata } from "../media/pngMetadata";
import type {
  DirectorGalleryColor,
  DirectorGalleryFolder,
  DirectorGalleryMediaRecord,
  DirectorGalleryPrefs,
} from "./directorGallery";
import { findDirectorGalleryDuplicateGroups } from "./directorGallery";
import type { DirectorMediaItem, DirectorMediaKind } from "./directorMediaLibrary";

/** The active filter criteria applied to the gallery view. */
export interface DirectorGalleryFilters {
  /** Free-text search query matched against the item's searchable text. */
  query: string;
  /** Filter by media kind or show all kinds. */
  kind: "all" | DirectorMediaKind;
  /** Filter by collection or show all collections. */
  collection: "all" | DirectorMediaItem["collection"];
  /** Minimum rating threshold (inclusive). */
  minimumRating: number;
  /** Exact tag match, or null when no tag filter is active. */
  tag: string | null;
  /** Filter by color label or show all colors. */
  color: "all" | DirectorGalleryColor;
  /** When true, show only items that belong to a duplicate group. */
  duplicatesOnly: boolean;
}

/** A prepared gallery item with precomputed display and search fields. */
export interface DirectorGalleryViewItem {
  /** The underlying media item. */
  item: DirectorMediaItem;
  /** The gallery record for this item, or null when not yet added to the gallery. */
  record: DirectorGalleryMediaRecord | null;
  /** The display name (custom name or fallback). */
  displayName: string;
  /** Precomputed, lowercased concatenation of all searchable fields. */
  searchableText: string;
  /** The date this item was added to the gallery or created, or null when unknown. */
  createdAt: string | null;
  /** The duplicate group key, or null when the item is not part of a duplicate group. */
  duplicateKey: string | null;
}

/** Collect a folder id plus every descendant folder id (the folder's subtree). */
export function collectDirectorGalleryFolderIds(folders: readonly DirectorGalleryFolder[], parentId: string) {
  const ids = new Set([parentId]);
  let changed = true;
  while (changed) {
    changed = false;
    folders.forEach((folder) => {
      if (folder.parentId && ids.has(folder.parentId) && !ids.has(folder.id)) {
        ids.add(folder.id);
        changed = true;
      }
    });
  }
  return ids;
}

function compareNullableText(left: string | null, right: string | null) {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

/**
 * Filter, sort, and project the raw media items and gallery records into a
 * prepared list of view items ready for rendering.
 *
 * @param items - All known media items in the library.
 * @param records - All gallery media records (ratings, tags, folders, etc.).
 * @param folders - The gallery folder tree.
 * @param prefs - Current gallery sort and display preferences.
 * @param filters - Active filter criteria.
 * @returns A sorted array of view items matching the filters, capped by the configured page size.
 */
export function selectDirectorGalleryItems(
  items: readonly DirectorMediaItem[],
  records: readonly DirectorGalleryMediaRecord[],
  folders: readonly DirectorGalleryFolder[],
  prefs: DirectorGalleryPrefs,
  filters: DirectorGalleryFilters,
) {
  const recordById = new Map(records.map((record) => [record.mediaId, record]));
  const duplicateGroups = findDirectorGalleryDuplicateGroups(items);
  const duplicateKeyById = new Map<string, string>();
  duplicateGroups.forEach((group) => group.ids.forEach((id) => duplicateKeyById.set(id, group.key)));
  const folderIds =
    prefs.activeFolderId && prefs.includeSubfolders
      ? collectDirectorGalleryFolderIds(folders, prefs.activeFolderId)
      : prefs.activeFolderId
        ? new Set([prefs.activeFolderId])
        : null;
  const query = filters.query.trim().toLocaleLowerCase();

  const selected = items.flatMap((item): DirectorGalleryViewItem[] => {
    const record = recordById.get(item.id) ?? null;
    if (prefs.showTrash ? !record?.trashedAt : Boolean(record?.trashedAt)) return [];
    if (folderIds && (!record?.folderId || !folderIds.has(record.folderId))) return [];
    if (filters.kind !== "all" && item.kind !== filters.kind) return [];
    if (filters.collection !== "all" && item.collection !== filters.collection) return [];
    if ((record?.rating ?? 0) < filters.minimumRating) return [];
    if (filters.tag && !record?.tags.some((tag) => tag.toLocaleLowerCase() === filters.tag?.toLocaleLowerCase()))
      return [];
    if (filters.color !== "all" && (record?.color ?? "none") !== filters.color) return [];
    const duplicateKey = duplicateKeyById.get(item.id) ?? null;
    if (filters.duplicatesOnly && !duplicateKey) return [];
    const comfy = summarizeDirectorComfyMetadata(item.embeddedMetadata);
    const displayName = record?.customName ?? item.name;
    const searchableText = [
      displayName,
      item.name,
      item.fileName,
      item.subtitle,
      item.mimeType,
      item.source,
      item.id,
      record?.notes,
      ...(record?.tags ?? []),
      comfy.searchableText,
    ]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase();
    if (query && !searchableText.includes(query)) return [];
    return [
      {
        item,
        record,
        displayName,
        searchableText,
        createdAt: record?.addedAt ?? item.createdAt ?? null,
        duplicateKey,
      },
    ];
  });

  const direction = prefs.sortDirection === "asc" ? 1 : -1;
  return selected.sort((left, right) => {
    let order = 0;
    if (prefs.sortBy === "name") order = compareNullableText(left.displayName, right.displayName);
    else if (prefs.sortBy === "type") order = compareNullableText(left.item.kind, right.item.kind);
    else if (prefs.sortBy === "rating") order = (left.record?.rating ?? 0) - (right.record?.rating ?? 0);
    else if (prefs.sortBy === "duration") order = left.item.durationSec - right.item.durationSec;
    else order = compareNullableText(left.createdAt, right.createdAt);
    return order * direction || left.displayName.localeCompare(right.displayName, undefined, { numeric: true });
  });
}

/**
 * Collect every unique tag used across all gallery records, sorted alphabetically.
 *
 * @param records - All gallery media records to scan for tags.
 * @returns A deduplicated, sorted array of tag strings.
 */
export function getDirectorGalleryAvailableTags(records: readonly DirectorGalleryMediaRecord[]) {
  return [...new Set(records.flatMap((record) => record.tags))].sort((left, right) => left.localeCompare(right));
}
