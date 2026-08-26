import { useSyncExternalStore } from "react";
import { dispatchCreativeWorkspaceOperations } from "../../../agent/dispatchCreativeWorkspaceOperations";
import {
  getDirectorCreativeWorkspaceScope,
  subscribeDirectorCreativeWorkspaceScope,
  useDirectorCreativeWorkspaceStore,
  type DirectorGalleryMediaRecord,
} from "./directorWorkspaceStore";
import { normalizeDirectorGalleryTag } from "./directorGallery";

/** Legacy mirror retained for one-way migration and old project compatibility. */
export const DIRECTOR_MEDIA_REVIEW_STORAGE_PREFIX = "director.media-reviews.v1";

/** Maximum number of tags allowed on a single media review. */
export const DIRECTOR_MEDIA_REVIEW_MAX_TAGS = 12;

/** Maximum character length of a single normalized media review tag. */
export const DIRECTOR_MEDIA_REVIEW_MAX_TAG_LENGTH = 28;

/** A user's rating and tags for a single gallery media item. */
export interface DirectorMediaReview {
  /** Star rating from 0 (unrated) to 5. */
  rating: number;
  /** Normalized, deduplicated tags applied to this media item. */
  tags: readonly string[];
}

/** Immutable snapshot of all media reviews in the current scope, keyed by media ID. */
export type DirectorMediaReviewSnapshot = Readonly<Record<string, Readonly<DirectorMediaReview>>>;

const EMPTY_SNAPSHOT: DirectorMediaReviewSnapshot = Object.freeze({});
let cachedGalleryRecords: readonly DirectorGalleryMediaRecord[] | null = null;
let cachedGallerySnapshot: DirectorMediaReviewSnapshot = EMPTY_SNAPSHOT;
const migratedScopes = new Set<string>();
const legacySnapshotCache = new Map<string, DirectorMediaReviewSnapshot>();

function normalizeScope(scopeId: string) {
  const safe = scopeId
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 128);
  return safe || "local";
}

function storageKey(scopeId: string) {
  return `${DIRECTOR_MEDIA_REVIEW_STORAGE_PREFIX}.${normalizeScope(scopeId)}`;
}

function getStorage() {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function normalizeRating(value: unknown) {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.min(5, Math.max(0, Math.round(numeric)));
}

/**
 * Normalize a raw tag string for media review storage.
 *
 * Delegates to the shared gallery tag normalization so review tags and
 * gallery tags follow the same rules.
 *
 * @param value - The raw tag string to normalize.
 * @returns The normalized tag string, or an empty string if the input is invalid.
 */
export function normalizeDirectorMediaTag(value: string) {
  return normalizeDirectorGalleryTag(value);
}

function normalizeTags(value: unknown) {
  if (!Array.isArray(value)) return [];
  const tags: string[] = [];
  const keys = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== "string") continue;
    const tag = normalizeDirectorMediaTag(candidate);
    const key = tag.toLocaleLowerCase();
    if (!tag || keys.has(key)) continue;
    tags.push(tag);
    keys.add(key);
    if (tags.length >= DIRECTOR_MEDIA_REVIEW_MAX_TAGS) break;
  }
  return tags;
}

function freezeSnapshot(records: Record<string, DirectorMediaReview>): DirectorMediaReviewSnapshot {
  for (const review of Object.values(records)) {
    Object.freeze(review.tags);
    Object.freeze(review);
  }
  return Object.freeze(records);
}

/**
 * Parse a serialized media review snapshot from localStorage.
 *
 * Accepts both the legacy `{ version, reviews }` envelope and a flat
 * `{ mediaId: review }` shape. Invalid or empty payloads return an
 * empty frozen snapshot.
 *
 * @param serialized - The raw JSON string from localStorage, or null.
 * @returns An immutable snapshot of the parsed reviews.
 */
export function parseDirectorMediaReviewSnapshot(serialized: string | null): DirectorMediaReviewSnapshot {
  if (!serialized) return EMPTY_SNAPSHOT;
  try {
    const parsed = JSON.parse(serialized) as unknown;
    if (!parsed || typeof parsed !== "object") return EMPTY_SNAPSHOT;
    const root = parsed as Record<string, unknown>;
    const source = root.reviews && typeof root.reviews === "object" ? root.reviews : root;
    const records: Record<string, DirectorMediaReview> = {};
    for (const [mediaId, candidate] of Object.entries(source as Record<string, unknown>)) {
      if (!mediaId || mediaId === "__proto__" || mediaId === "constructor" || mediaId === "prototype") continue;
      if (!candidate || typeof candidate !== "object") continue;
      const review = candidate as Record<string, unknown>;
      const rating = normalizeRating(review.rating);
      const tags = normalizeTags(review.tags);
      if (rating === 0 && tags.length === 0) continue;
      records[mediaId.slice(0, 500)] = { rating, tags };
    }
    return Object.keys(records).length > 0 ? freezeSnapshot(records) : EMPTY_SNAPSHOT;
  } catch {
    return EMPTY_SNAPSHOT;
  }
}

function snapshotFromGalleryRecords(records: readonly DirectorGalleryMediaRecord[]) {
  if (records === cachedGalleryRecords) return cachedGallerySnapshot;
  const reviews: Record<string, DirectorMediaReview> = {};
  records.forEach((record) => {
    if (record.rating > 0 || record.tags.length > 0) {
      reviews[record.mediaId] = { rating: record.rating, tags: [...record.tags] };
    }
  });
  cachedGalleryRecords = records;
  cachedGallerySnapshot = Object.keys(reviews).length > 0 ? freezeSnapshot(reviews) : EMPTY_SNAPSHOT;
  return cachedGallerySnapshot;
}

function legacySnapshot(scopeId = getDirectorCreativeWorkspaceScope()) {
  const scope = normalizeScope(scopeId);
  const cached = legacySnapshotCache.get(scope);
  if (cached) return cached;
  const snapshot = parseDirectorMediaReviewSnapshot(getStorage()?.getItem(storageKey(scope)) ?? null);
  legacySnapshotCache.set(scope, snapshot);
  return snapshot;
}

function ensureLegacyReviewsMigrated() {
  const scope = normalizeScope(getDirectorCreativeWorkspaceScope());
  if (migratedScopes.has(scope)) return;
  migratedScopes.add(scope);
  const legacy = legacySnapshot(scope);
  if (Object.keys(legacy).length === 0) return;
  const state = useDirectorCreativeWorkspaceStore.getState();
  const merged = new Map(state.galleryMedia.map((record) => [record.mediaId, record]));
  Object.entries(legacy).forEach(([mediaId, review]) => {
    const current = merged.get(mediaId);
    if (current && (current.rating > 0 || current.tags.length > 0)) return;
    state.updateGalleryMedia(mediaId, { rating: review.rating, tags: [...review.tags] });
  });
}

function persistLegacyMirror(snapshot: DirectorMediaReviewSnapshot) {
  const storage = getStorage();
  if (!storage) return;
  const key = storageKey(getDirectorCreativeWorkspaceScope());
  try {
    if (Object.keys(snapshot).length === 0) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify({ version: 1, reviews: snapshot }));
    legacySnapshotCache.set(normalizeScope(getDirectorCreativeWorkspaceScope()), snapshot);
  } catch {
    // The project workspace remains authoritative when legacy mirroring is blocked.
  }
}

function currentProjectSnapshot() {
  const snapshot = snapshotFromGalleryRecords(useDirectorCreativeWorkspaceStore.getState().galleryMedia);
  return Object.keys(snapshot).length > 0 ? snapshot : legacySnapshot();
}

function updateReview(mediaId: string, update: (current: DirectorMediaReview) => DirectorMediaReview) {
  const id = mediaId.trim().slice(0, 500);
  if (!id) return;
  ensureLegacyReviewsMigrated();
  const state = useDirectorCreativeWorkspaceStore.getState();
  const currentRecord = state.galleryMedia.find((record) => record.mediaId === id);
  const current: DirectorMediaReview = {
    rating: currentRecord?.rating ?? 0,
    tags: currentRecord?.tags ?? [],
  };
  const candidate = update({ rating: current.rating, tags: [...current.tags] });
  const nextReview: DirectorMediaReview = {
    rating: normalizeRating(candidate.rating),
    tags: normalizeTags(candidate.tags),
  };
  if (
    nextReview.rating === current.rating &&
    nextReview.tags.length === current.tags.length &&
    nextReview.tags.every((tag, index) => tag === current.tags[index])
  ) {
    return;
  }
  // Review edits dispatch through the shared agent contract so they produce
  // the same revision and receipts as agent-side gallery updates. Media the
  // contract does not know (legacy mirror entries whose assets are gone)
  // falls back to the direct upsert the store has always provided.
  const dispatched = dispatchCreativeWorkspaceOperations({
    op: "gallery.media.update",
    media_id: id,
    patch: { rating: nextReview.rating, tags: [...nextReview.tags] },
  });
  if (!dispatched.ok && dispatched.code === "not_found") {
    state.updateGalleryMedia(id, { rating: nextReview.rating, tags: [...nextReview.tags] });
  }
  persistLegacyMirror(snapshotFromGalleryRecords(useDirectorCreativeWorkspaceStore.getState().galleryMedia));
}

/**
 * Return the current media review snapshot for the active workspace scope.
 *
 * Prefers the authoritative project gallery state; falls back to the
 * legacy localStorage mirror when the project has no reviews yet.
 *
 * @returns An immutable snapshot of all media reviews in the current scope.
 */
export function getDirectorMediaReviewSnapshot() {
  return currentProjectSnapshot();
}

/**
 * Set the star rating for a media item.
 *
 * Values are clamped to the 0–5 integer range. A rating of 0 is treated
 * as unrated.
 *
 * @param mediaId - The media item to rate.
 * @param rating - The star rating to apply, from 0 to 5.
 */
export function setDirectorMediaRating(mediaId: string, rating: number) {
  updateReview(mediaId, (current) => ({ ...current, rating }));
}

/**
 * Add a tag to a media item.
 *
 * The tag is normalized before storage. Duplicate and empty tags are
 * silently ignored; the tag cap is enforced.
 *
 * @param mediaId - The media item to tag.
 * @param tag - The raw tag string to add.
 */
export function addDirectorMediaTag(mediaId: string, tag: string) {
  const normalized = normalizeDirectorMediaTag(tag);
  if (!normalized) return;
  updateReview(mediaId, (current) => ({ ...current, tags: [...current.tags, normalized] }));
}

/**
 * Remove a tag from a media item by case-insensitive match.
 *
 * @param mediaId - The media item to modify.
 * @param tag - The tag to remove (matched case-insensitively).
 */
export function removeDirectorMediaTag(mediaId: string, tag: string) {
  const key = normalizeDirectorMediaTag(tag).toLocaleLowerCase();
  if (!key) return;
  updateReview(mediaId, (current) => ({
    ...current,
    tags: current.tags.filter((candidate) => candidate.toLocaleLowerCase() !== key),
  }));
}

/**
 * Clear all media reviews for a given scope.
 *
 * When the scope matches the active workspace, project gallery ratings
 * and tags are also reset to zero / empty.
 *
 * @param scopeId - The workspace scope to clear. Defaults to the current scope.
 */
export function clearDirectorMediaReviews(scopeId = getDirectorCreativeWorkspaceScope()) {
  const scope = normalizeScope(scopeId);
  migratedScopes.add(scope);
  if (scope === normalizeScope(getDirectorCreativeWorkspaceScope())) {
    const state = useDirectorCreativeWorkspaceStore.getState();
    state.replaceGalleryMedia(
      state.galleryMedia.map((record) => ({
        ...record,
        rating: 0,
        tags: [],
      })),
    );
  }
  try {
    getStorage()?.removeItem(storageKey(scope));
    legacySnapshotCache.set(scope, EMPTY_SNAPSHOT);
  } catch {
    // Clearing project metadata still succeeds when the compatibility mirror is blocked.
  }
}

/**
 * Subscribe to media review changes across the workspace store and scope.
 *
 * @param listener - Callback invoked when reviews may have changed.
 * @returns An unsubscribe function that removes both underlying subscriptions.
 */
export function subscribeDirectorMediaReviews(listener: () => void) {
  const unsubscribeStore = useDirectorCreativeWorkspaceStore.subscribe(listener);
  const unsubscribeScope = subscribeDirectorCreativeWorkspaceScope(listener);
  return () => {
    unsubscribeStore();
    unsubscribeScope();
  };
}

/**
 * React hook that returns the current media review snapshot for the
 * active workspace, re-rendering when reviews change.
 *
 * @returns An immutable snapshot of all media reviews in the current scope.
 */
export function useDirectorMediaReviews() {
  return useSyncExternalStore(subscribeDirectorMediaReviews, getDirectorMediaReviewSnapshot, () => EMPTY_SNAPSHOT);
}
