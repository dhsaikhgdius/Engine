import { z } from "zod";

/** Hard cap on the number of media records tracked in the gallery. */
export const DIRECTOR_GALLERY_MAX_MEDIA_RECORDS = 5_000;
/** Maximum number of user-defined folders. */
export const DIRECTOR_GALLERY_MAX_FOLDERS = 200;
/** Maximum number of tags per media record. */
export const DIRECTOR_GALLERY_MAX_TAGS = 12;
/** Maximum character length of a single tag. */
export const DIRECTOR_GALLERY_MAX_TAG_LENGTH = 28;

/** Valid color labels for gallery media records. */
export const directorGalleryColorSchema = z.enum(["none", "red", "orange", "yellow", "green", "blue", "purple"]);
/** Gallery layout modes. */
export const directorGalleryViewModeSchema = z.enum(["grid", "masonry", "list", "timeline"]);
/** Sort keys for gallery media. */
export const directorGallerySortBySchema = z.enum(["created", "name", "type", "rating", "duration"]);
/** Sort direction. */
export const directorGallerySortDirectionSchema = z.enum(["asc", "desc"]);

export type DirectorGalleryColor = z.infer<typeof directorGalleryColorSchema>;
export type DirectorGalleryViewMode = z.infer<typeof directorGalleryViewModeSchema>;
export type DirectorGallerySortBy = z.infer<typeof directorGallerySortBySchema>;
export type DirectorGallerySortDirection = z.infer<typeof directorGallerySortDirectionSchema>;

/** Schema for a single gallery media record, including rating, tags, color, and folder assignment. */
export const directorGalleryMediaRecordSchema = z.object({
  mediaId: z.string().trim().min(1).max(512),
  rating: z.number().int().min(0).max(5).default(0),
  tags: z.array(z.string().trim().min(1).max(DIRECTOR_GALLERY_MAX_TAG_LENGTH)).max(DIRECTOR_GALLERY_MAX_TAGS),
  color: directorGalleryColorSchema.default("none"),
  customName: z.string().trim().min(1).max(240).nullable().default(null),
  notes: z.string().max(8_000).default(""),
  folderId: z.string().trim().min(1).max(160).nullable().default(null),
  addedAt: z.string().datetime({ offset: true }).nullable().default(null),
  trashedAt: z.string().datetime({ offset: true }).nullable().default(null),
});

/** Schema for a gallery folder, supporting a flat parent-child hierarchy. */
export const directorGalleryFolderSchema = z.object({
  id: z.string().trim().min(1).max(160),
  name: z.string().trim().min(1).max(120),
  parentId: z.string().trim().min(1).max(160).nullable(),
  createdAt: z.string().datetime({ offset: true }),
});

/** User preferences persisted alongside the gallery. */
export const directorGalleryPrefsSchema = z.object({
  viewMode: directorGalleryViewModeSchema,
  sortBy: directorGallerySortBySchema,
  sortDirection: directorGallerySortDirectionSchema,
  thumbnailSize: z.number().int().min(120).max(360),
  activeFolderId: z.string().trim().min(1).max(160).nullable(),
  includeSubfolders: z.boolean(),
  showTrash: z.boolean(),
});

export type DirectorGalleryMediaRecord = z.infer<typeof directorGalleryMediaRecordSchema>;
export type DirectorGalleryFolder = z.infer<typeof directorGalleryFolderSchema>;
export type DirectorGalleryPrefs = z.infer<typeof directorGalleryPrefsSchema>;

/** Self-contained gallery state slice suitable for persistence. */
export interface DirectorGalleryPersistedState {
  /** Media records tracked in the gallery. */
  galleryMedia: DirectorGalleryMediaRecord[];
  /** User-defined folder hierarchy. */
  galleryFolders: DirectorGalleryFolder[];
  /** User display and sorting preferences. */
  galleryPrefs: DirectorGalleryPrefs;
}

/** Sensible defaults for gallery user preferences. */
export const DEFAULT_DIRECTOR_GALLERY_PREFS: DirectorGalleryPrefs = Object.freeze({
  viewMode: "grid",
  sortBy: "created",
  sortDirection: "desc",
  thumbnailSize: 196,
  activeFolderId: null,
  includeSubfolders: true,
  showTrash: false,
});

/**
 * Returns an empty gallery state with default preferences.
 *
 * @returns A fresh `DirectorGalleryPersistedState` with no media or folders.
 */
export function createDefaultDirectorGalleryState(): DirectorGalleryPersistedState {
  return {
    galleryMedia: [],
    galleryFolders: [],
    galleryPrefs: { ...DEFAULT_DIRECTOR_GALLERY_PREFS },
  };
}

/**
 * Normalizes a single tag by trimming whitespace, collapsing internal
 * whitespace, and clamping to the maximum tag length.
 *
 * @param value - The raw tag string.
 * @returns The normalized tag, or an empty string if the result is blank.
 */
export function normalizeDirectorGalleryTag(value: string) {
  return value.trim().replace(/\s+/g, " ").slice(0, DIRECTOR_GALLERY_MAX_TAG_LENGTH);
}

/**
 * Normalizes a list of tags: deduplicates case-insensitively, normalizes each
 * entry, and caps the result to the maximum tag count.
 *
 * @param value - The raw tag array.
 * @returns A deduplicated, normalized, and bounded array of tags.
 */
export function normalizeDirectorGalleryTags(value: readonly string[]) {
  const tags: string[] = [];
  const keys = new Set<string>();
  for (const candidate of value) {
    const tag = normalizeDirectorGalleryTag(candidate);
    const key = tag.toLocaleLowerCase();
    if (!tag || keys.has(key)) continue;
    tags.push(tag);
    keys.add(key);
    if (tags.length >= DIRECTOR_GALLERY_MAX_TAGS) break;
  }
  return tags;
}

/**
 * Creates a default gallery media record for a given media ID.
 *
 * @param mediaId - The media identifier.
 * @returns A record with all fields set to their defaults.
 */
export function createDefaultDirectorGalleryMediaRecord(mediaId: string): DirectorGalleryMediaRecord {
  return {
    mediaId: mediaId.trim().slice(0, 512),
    rating: 0,
    tags: [],
    color: "none",
    customName: null,
    notes: "",
    folderId: null,
    addedAt: null,
    trashedAt: null,
  };
}

/**
 * Normalizes an existing media record, clamping values to valid ranges and
 * optionally validating that its folder exists in the current folder set.
 *
 * @param candidate - The record to normalize.
 * @param validFolderIds - Optional set of known folder IDs; any folderId not
 *   in this set is reset to null.
 * @returns A fully parsed and normalized `DirectorGalleryMediaRecord`.
 */
export function normalizeDirectorGalleryMediaRecord(
  candidate: DirectorGalleryMediaRecord,
  validFolderIds?: ReadonlySet<string>,
): DirectorGalleryMediaRecord {
  const parsed = directorGalleryMediaRecordSchema.parse({
    ...candidate,
    mediaId: candidate.mediaId.trim().slice(0, 512),
    rating: Math.min(5, Math.max(0, Math.round(candidate.rating))),
    tags: normalizeDirectorGalleryTags(candidate.tags),
    customName: candidate.customName?.trim().slice(0, 240) || null,
    notes: candidate.notes.slice(0, 8_000),
    folderId: candidate.folderId?.trim().slice(0, 160) || null,
  });
  if (validFolderIds && parsed.folderId && !validFolderIds.has(parsed.folderId)) parsed.folderId = null;
  return parsed;
}

/**
 * Returns true when every field of the record is at its default value,
 * indicating the record carries no user-supplied metadata.
 *
 * @param record - The record to check.
 * @returns `true` if the record is indistinguishable from a default record.
 */
export function isDefaultDirectorGalleryMediaRecord(record: DirectorGalleryMediaRecord) {
  return (
    record.rating === 0 &&
    record.tags.length === 0 &&
    record.color === "none" &&
    record.customName === null &&
    record.notes === "" &&
    record.folderId === null &&
    record.addedAt === null &&
    record.trashedAt === null
  );
}

function removeCyclicFolderParents(folders: DirectorGalleryFolder[]) {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  return folders.map((folder) => {
    const visited = new Set([folder.id]);
    let parentId = folder.parentId;
    while (parentId) {
      if (visited.has(parentId)) return { ...folder, parentId: null };
      visited.add(parentId);
      parentId = byId.get(parentId)?.parentId ?? null;
    }
    return folder;
  });
}

/**
 * Normalizes an entire gallery state slice: validates and deduplicates folders
 * and media records, resolves dangling folder references, removes cyclic
 * folder parent chains, and clamps to configured size limits.
 *
 * @param input - A partial gallery state to normalize.
 * @returns A fully valid `DirectorGalleryPersistedState`.
 */
export function normalizeDirectorGalleryState(input: Partial<DirectorGalleryPersistedState>) {
  const folderIds = new Set<string>();
  const folders = removeCyclicFolderParents(
    (input.galleryFolders ?? []).flatMap((candidate) => {
      const parsed = directorGalleryFolderSchema.safeParse(candidate);
      if (!parsed.success || folderIds.has(parsed.data.id)) return [];
      folderIds.add(parsed.data.id);
      return [{ ...parsed.data }];
    }),
  ).map((folder) => ({
    ...folder,
    parentId: folder.parentId && folderIds.has(folder.parentId) ? folder.parentId : null,
  }));
  const validFolderIds = new Set(folders.map((folder) => folder.id));
  const mediaIds = new Set<string>();
  const galleryMedia = (input.galleryMedia ?? []).flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || typeof candidate.mediaId !== "string") return [];
    const mediaId = candidate.mediaId.trim().slice(0, 512);
    if (!mediaId || mediaIds.has(mediaId)) return [];
    mediaIds.add(mediaId);
    const base = createDefaultDirectorGalleryMediaRecord(mediaId);
    const normalized = normalizeDirectorGalleryMediaRecord(
      {
        ...base,
        rating: Number.isFinite(Number(candidate.rating)) ? Number(candidate.rating) : 0,
        tags: Array.isArray(candidate.tags)
          ? candidate.tags.filter((tag): tag is string => typeof tag === "string")
          : [],
        color: directorGalleryColorSchema.catch("none").parse(candidate.color),
        customName: typeof candidate.customName === "string" ? candidate.customName : null,
        notes: typeof candidate.notes === "string" ? candidate.notes : "",
        folderId: typeof candidate.folderId === "string" ? candidate.folderId : null,
        addedAt:
          typeof candidate.addedAt === "string" && !Number.isNaN(Date.parse(candidate.addedAt))
            ? new Date(candidate.addedAt).toISOString()
            : null,
        trashedAt:
          typeof candidate.trashedAt === "string" && !Number.isNaN(Date.parse(candidate.trashedAt))
            ? new Date(candidate.trashedAt).toISOString()
            : null,
      },
      validFolderIds,
    );
    return isDefaultDirectorGalleryMediaRecord(normalized) ? [] : [normalized];
  });
  const prefs = directorGalleryPrefsSchema.catch(DEFAULT_DIRECTOR_GALLERY_PREFS).parse(input.galleryPrefs);
  return {
    galleryMedia: galleryMedia.slice(0, DIRECTOR_GALLERY_MAX_MEDIA_RECORDS),
    galleryFolders: folders.slice(0, DIRECTOR_GALLERY_MAX_FOLDERS),
    galleryPrefs: {
      ...prefs,
      activeFolderId: prefs.activeFolderId && validFolderIds.has(prefs.activeFolderId) ? prefs.activeFolderId : null,
    },
  } satisfies DirectorGalleryPersistedState;
}

/** A media item eligible for batch rename. */
export interface DirectorGalleryRenameSource {
  /** Unique identifier of the media item. */
  id: string;
  /** Current display name. */
  name: string;
  /** Media kind (e.g. "image", "video", "audio"). */
  kind: string;
  /** ISO-8601 creation timestamp, if known. */
  createdAt?: string | null;
}

/** Batch rename strategy: either a template with placeholders or a regex substitution. */
export type DirectorGalleryBatchRenameRule =
  | { mode: "template"; template: string; startIndex?: number }
  | { mode: "regex"; pattern: string; replacement: string; flags?: "" | "g" | "i" | "gi" };

function splitFileName(name: string) {
  const match = name.match(/^(.*?)(\.[a-z0-9]{1,12})$/i);
  return match ? { stem: match[1] || name, extension: match[2] || "" } : { stem: name, extension: "" };
}

/**
 * Previews the result of a batch rename rule without applying it. Supports
 * template-based renaming with `{name}`, `{ext}`, `{type}`, `{date}`, and
 * `{index}` placeholders, and regex-based find-and-replace.
 *
 * @param items - The media items to preview rename for (max 1000).
 * @param rule - The rename strategy to apply.
 * @returns An array of `{ id, before, after }` entries showing the rename result.
 */
export function previewDirectorGalleryBatchRename(
  items: readonly DirectorGalleryRenameSource[],
  rule: DirectorGalleryBatchRenameRule,
) {
  if (items.length > 1_000) throw new Error("一次最多重命名 1000 项素材");
  if (rule.mode === "regex") {
    if (!rule.pattern || rule.pattern.length > 120) throw new Error("正则表达式长度必须为 1–120 个字符");
    let expression: RegExp;
    try {
      expression = new RegExp(rule.pattern, rule.flags ?? "g");
    } catch (error) {
      throw new Error(`正则表达式无效：${error instanceof Error ? error.message : String(error)}`);
    }
    return items.map((item) => ({
      id: item.id,
      before: item.name,
      after: item.name.replace(expression, rule.replacement).trim() || item.name,
    }));
  }

  const template = rule.template.trim();
  if (!template || template.length > 240) throw new Error("命名模板长度必须为 1–240 个字符");
  const startIndex = Math.max(0, Math.floor(rule.startIndex ?? 1));
  return items.map((item, itemIndex) => {
    const { stem, extension } = splitFileName(item.name);
    const date = item.createdAt && !Number.isNaN(Date.parse(item.createdAt)) ? item.createdAt.slice(0, 10) : "undated";
    const after = template
      .replaceAll("{name}", stem)
      .replaceAll("{ext}", extension.replace(/^\./, ""))
      .replaceAll("{type}", item.kind)
      .replaceAll("{date}", date)
      .replaceAll("{index}", String(startIndex + itemIndex).padStart(3, "0"))
      .trim();
    return { id: item.id, before: item.name, after: after || item.name };
  });
}

/** A media item considered for duplicate detection. */
export interface DirectorGalleryDuplicateSource {
  /** Unique identifier of the media item. */
  id: string;
  /** Media kind. */
  kind: string;
  /** Direct URL of the source media, if available. */
  sourceUrl?: string | null;
  /** Content hash for exact-match comparison. */
  contentHash?: string | null;
}

function hashText(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Derives a duplicate-group key from a media item. Items with the same key
 * are considered potential duplicates. Returns `null` when no meaningful key
 * can be derived (e.g. no content hash and no data URI).
 *
 * @param item - The media item to derive a key from.
 * @returns A stable group key, or `null` if the item is not comparable.
 */
export function getDirectorGalleryDuplicateKey(item: DirectorGalleryDuplicateSource) {
  if (item.contentHash) return `${item.kind}:content:${item.contentHash}`;
  const contentMatch = item.id.match(/^creative-media:(image|video|audio):([^:]+:[^:]+|[^:]+)$/);
  if (contentMatch) return `${item.kind}:content:${contentMatch[2]}`;
  if (item.sourceUrl?.startsWith("data:")) return `${item.kind}:data:${hashText(item.sourceUrl)}`;
  return null;
}

/**
 * Groups media items by their duplicate keys, returning only groups that
 * contain two or more entries.
 *
 * @param items - The media items to scan for duplicates.
 * @returns Sorted array of `{ key, ids }` groups, each keyed by its duplicate key.
 */
export function findDirectorGalleryDuplicateGroups(items: readonly DirectorGalleryDuplicateSource[]) {
  const groups = new Map<string, string[]>();
  for (const item of items) {
    const key = getDirectorGalleryDuplicateKey(item);
    if (!key) continue;
    const ids = groups.get(key) ?? [];
    if (!ids.includes(item.id)) ids.push(item.id);
    groups.set(key, ids);
  }
  return [...groups.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([key, ids]) => ({ key, ids }))
    .sort((left, right) => left.key.localeCompare(right.key));
}