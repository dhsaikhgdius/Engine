import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import { z } from "zod";
import {
  creativeWorkspaceModeSchema,
  creativeWorkspaceReviewStatusSchema,
} from "../../../../../../packages/protocol/src/creativeWorkspaceProtocol";
import { isRecord } from "../../../../../../packages/protocol/src/primitives";
import { getDirectorCharacterAssetBindingIssues } from "../modelLibrary/mixamoCharacterCatalog";
import type { DirectorProject } from "../schema/directorProject";
import { safeParseDirectorProject } from "../schema/directorProjectSchema";
import type {
  DirectorBoardEdge,
  DirectorBoardNode,
  DirectorCreativeWorkspaceState,
  DirectorEditSettings,
  DirectorEditTrack,
} from "../workspaces/directorWorkspaceStore";
import { parseDirectorCreativeWorkspacePersistedState } from "../workspaces/directorWorkspaceStore";

const SHARED_ROOT_KEY = "director.shared.v1";
const REVIEW_ROOT_KEY = "director.reviews.v1";
const VERSION_ROOT_KEY = "director.versions.v1";
const INTERNAL_ORDER_KEY = "__director_order";
const MAX_WIRE_MESSAGE_BYTES = 16 * 1024 * 1024;
const MAX_VERSION_DIFF_ENTRIES = 2_000;
const PERSISTENCE_FORMAT_VERSION = 1;
const MAX_PERSISTENCE_RECORD_CHARS = Math.ceil((MAX_WIRE_MESSAGE_BYTES * 4) / 3) + 1_024;
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonRecord = { [key: string]: JsonValue };

/** The creative workspace slice shared across collaborators: board nodes, edges, edit tracks, and settings. */
export interface DirectorSharedCreativeState {
  boardNodes: DirectorBoardNode[];
  boardEdges: DirectorBoardEdge[];
  editTracks: DirectorEditTrack[];
  editSettings: DirectorEditSettings;
}

/** The complete shared state across collaborators: Stage project and creative workspace. */
export interface DirectorSharedState {
  stage: DirectorProject;
  creative: DirectorSharedCreativeState;
}

export type DirectorReviewAnchor = z.infer<typeof reviewAnchorSchema>;
/** A review comment pinned to a scene, object, or timeline position. */
export type DirectorReviewComment = z.infer<typeof reviewCommentSchema>;
/** The lifecycle status of a review comment. */
export type DirectorReviewStatus = DirectorReviewComment["status"];

/** Filters for querying review comments by scene, status, or anchor. */
export interface DirectorReviewCommentFilter {
  sceneId?: string;
  status?: DirectorReviewStatus;
  anchor?: DirectorReviewAnchor;
}

export type DirectorCollaboratorIdentity = z.infer<typeof identitySchema>;
export type DirectorCollaborationPresence = z.infer<typeof presenceSchema>;

/** A remote presence entry with the client ID and a local flag added at read time. */
export type DirectorRemotePresence = DirectorCollaborationPresence & {
  clientId: number;
  local: boolean;
};

/** A named snapshot of the full shared state at a point in time, stored inside the CRDT for version history. */
export interface DirectorVersionSnapshot {
  id: string;
  name: string;
  author: DirectorCollaboratorIdentity;
  createdAt: string;
  state: DirectorSharedState;
}

/** A single entry in a version diff: the JSON path, the kind of change, and the before/after values. */
export interface DirectorVersionDiffEntry {
  path: string;
  kind: "added" | "removed" | "changed";
  before?: JsonValue;
  after?: JsonValue;
}

/** The result of comparing two shared states: a diff up to MAX_VERSION_DIFF_ENTRIES entries and a summary. */
export interface DirectorVersionComparison {
  versionId: string;
  comparedToVersionId?: string;
  changes: DirectorVersionDiffEntry[];
  truncated: boolean;
  summary: {
    added: number;
    removed: number;
    changed: number;
    stageObjectsBefore: number;
    stageObjectsAfter: number;
    camerasBefore: number;
    camerasAfter: number;
    canvasNodesBefore: number;
    canvasNodesAfter: number;
    videoClipsBefore: number;
    videoClipsAfter: number;
  };
}

/** The three wire message types exchanged over a transport: document updates, awareness updates, and sync requests. */
export type DirectorCollaborationWireMessage =
  | { type: "document-update"; payload: Uint8Array }
  | { type: "awareness-update"; payload: Uint8Array }
  | { type: "sync-request"; payload: Uint8Array };

/** Transport-neutral wire contract. WebSocket, WebRTC and BroadcastChannel providers implement this tiny surface. */
export interface DirectorCollaborationTransport {
  send(message: DirectorCollaborationWireMessage): void;
  subscribe(listener: (message: DirectorCollaborationWireMessage) => void): () => void;
  close?(): void;
  /**
   * When false, document-update sends are skipped (viewer capability). Absent
   * or true means document writes are allowed (BroadcastChannel and editors).
   */
  readonly canWriteDocuments?: boolean;
}

/** Options for creating a collaboration session, with injectable Y.Doc, Awareness, and ID generator. */
export interface DirectorCollaborationSessionOptions {
  doc?: Y.Doc;
  awareness?: Awareness;
  scopeId: string;
  identity: DirectorCollaboratorIdentity;
  now?: () => Date;
  createId?: (prefix: string) => string;
}

/** A partial presence update to merge into the local awareness state. Pass null cursor to clear. */
export type DirectorLocalPresencePatch = Partial<
  Omit<DirectorCollaborationPresence, "user" | "sceneId" | "updatedAt" | "cursor">
> & {
  /** Pass null to explicitly clear a previously published pointer. */
  cursor?: DirectorCollaborationPresence["cursor"] | null;
};

/** A versioned, base64-encoded Yjs update suitable for persistence in localStorage or a server store. */
export interface DirectorCollaborationPersistedUpdate {
  version: typeof PERSISTENCE_FORMAT_VERSION;
  scopeId: string;
  savedAt: string;
  update: Uint8Array;
}

const identitySchema = z.strictObject({
  id: z.string().trim().min(1).max(160),
  name: z.string().trim().min(1).max(120),
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
});

const reviewAnchorSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("scene"), sceneId: z.string().trim().min(1).max(180) }),
  z.strictObject({
    type: z.literal("object"),
    sceneId: z.string().trim().min(1).max(180),
    objectId: z.string().trim().min(1).max(180),
  }),
  z.strictObject({
    type: z.literal("time"),
    sceneId: z.string().trim().min(1).max(180),
    frame: z.number().int().min(-1_000_000).max(1_000_000),
    trackId: z.string().trim().min(1).max(180).optional(),
  }),
]);

const reviewCommentSchema = z.strictObject({
  id: z.string().trim().min(1).max(180),
  anchor: reviewAnchorSchema,
  author: identitySchema,
  body: z.string().trim().min(1).max(8_000),
  status: creativeWorkspaceReviewStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  resolvedAt: z.string().datetime().optional(),
  resolvedBy: identitySchema.optional(),
});

const presenceSchema = z.strictObject({
  user: identitySchema,
  sceneId: z.string().trim().min(1).max(180),
  workspace: creativeWorkspaceModeSchema,
  selectedObjectIds: z.array(z.string().max(180)).max(1_000),
  activeCameraId: z.string().max(180).nullable(),
  frame: z.number().int().min(-1_000_000).max(1_000_000).nullable(),
  playheadSec: z
    .number()
    .finite()
    .min(0)
    .max(24 * 60 * 60)
    .nullable(),
  cursor: z
    .strictObject({
      space: z.enum(["stage", "canvas", "video"]),
      x: z.number().finite().min(-100_000).max(100_000),
      y: z.number().finite().min(-100_000).max(100_000),
    })
    .optional(),
  updatedAt: z.string().datetime(),
});

const versionMetadataSchema = z.strictObject({
  id: z.string().trim().min(1).max(180),
  name: z.string().trim().min(1).max(240),
  author: identitySchema,
  createdAt: z.string().datetime(),
});

const persistedUpdateSchema = z.strictObject({
  version: z.literal(PERSISTENCE_FORMAT_VERSION),
  scopeId: z.string().trim().min(1).max(180),
  savedAt: z.string().datetime(),
  encoding: z.literal("base64"),
  update: z.string().min(1).max(MAX_PERSISTENCE_RECORD_CHARS),
});

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isIdRecordArray(value: readonly JsonValue[]): value is Array<JsonRecord & { id: string }> {
  return value.length > 0 && value.every((item) => isRecord(item) && typeof item.id === "string" && item.id.length > 0);
}

function isLocalOnlyMediaUrl(value: string | null | undefined) {
  if (!value) return false;
  return /^(?:blob:|data:|director-local-media:)/i.test(value);
}

/**
 * Produces a stable string key for a review anchor, used to group comments by their target.
 *
 * @param anchor - The review anchor to encode.
 * @returns A string key like "scene:<id>", "object:<sceneId>:<objectId>", or "time:<sceneId>:<trackId>:<frame>".
 */
export function directorReviewAnchorKey(anchor: DirectorReviewAnchor) {
  const parsed = reviewAnchorSchema.parse(anchor);
  if (parsed.type === "scene") return `scene:${parsed.sceneId}`;
  if (parsed.type === "object") return `object:${parsed.sceneId}:${parsed.objectId}`;
  return `time:${parsed.sceneId}:${parsed.trackId ?? ""}:${parsed.frame}`;
}

function detachedMediaUrl(assetId: string) {
  return `director-local-media://${encodeURIComponent(assetId)}`;
}

/**
 * Produces the Stage projection that is safe to put in a CRDT. Camera pixels
 * and tab-local object URLs stay in the media store; only stable metadata and
 * a deterministic placeholder cross the collaboration boundary.
 */
export function projectForDirectorCollaboration(project: DirectorProject): DirectorProject {
  const projected = cloneJson(project);
  projected.assets = projected.assets.map((asset) => ({
    ...asset,
    url: isLocalOnlyMediaUrl(asset.url) ? detachedMediaUrl(asset.id) : asset.url,
  }));
  projected.cameras = projected.cameras.map((camera) => {
    const withoutPixels = { ...camera };
    delete withoutPixels.captures;
    return {
      ...withoutPixels,
      lastCaptureUrl: isLocalOnlyMediaUrl(camera.lastCaptureUrl) ? null : camera.lastCaptureUrl,
    };
  });
  return projected;
}

/** Reattaches pixels that are present on this client without ever copying them into Y.Doc. */
export function mergeDirectorLocalMedia(remote: DirectorProject, local: DirectorProject): DirectorProject {
  const localAssets = new Map(local.assets.map((asset) => [asset.id, asset]));
  const localCameras = new Map(local.cameras.map((camera) => [camera.id, camera]));
  const merged = cloneJson(remote);
  merged.assets = merged.assets.map((asset) => {
    if (!asset.url.startsWith("director-local-media:")) return asset;
    const localAsset = localAssets.get(asset.id);
    return localAsset && isLocalOnlyMediaUrl(localAsset.url) ? { ...asset, url: localAsset.url } : asset;
  });
  merged.cameras = merged.cameras.map((camera) => {
    const localCamera = localCameras.get(camera.id);
    if (!localCamera) return camera;
    return {
      ...camera,
      lastCaptureUrl: camera.lastCaptureUrl ?? localCamera.lastCaptureUrl,
      captures: localCamera.captures,
    };
  });
  return merged;
}

/**
 * Deep-clones the creative workspace state for sharing across the collaboration boundary.
 * The result is a plain JSON snapshot with no live store references.
 *
 * @param state - The creative workspace state to snapshot.
 * @returns A deep-cloned DirectorSharedCreativeState.
 */
export function snapshotDirectorCreativeWorkspace(
  state: Pick<DirectorCreativeWorkspaceState, "boardNodes" | "boardEdges" | "editTracks" | "editSettings">,
): DirectorSharedCreativeState {
  return cloneJson({
    boardNodes: state.boardNodes,
    boardEdges: state.boardEdges,
    editTracks: state.editTracks,
    editSettings: state.editSettings,
  });
}

function parseSharedCreativeState(value: unknown): DirectorSharedCreativeState | null {
  if (!isRecord(value)) return null;
  const parsed = parseDirectorCreativeWorkspacePersistedState(
    JSON.stringify({
      version: 2,
      state: {
        boardNodes: value.boardNodes,
        boardEdges: value.boardEdges,
        editTracks: value.editTracks,
        editSettings: value.editSettings,
      },
    }),
  );
  if (!parsed.boardNodes || !parsed.boardEdges || !parsed.editTracks || !parsed.editSettings) return null;
  return {
    boardNodes: parsed.boardNodes,
    boardEdges: parsed.boardEdges,
    editTracks: parsed.editTracks,
    editSettings: parsed.editSettings,
  };
}

function readYValue(value: unknown): JsonValue {
  if (value instanceof Y.Text) return value.toString();
  if (value instanceof Y.Map) {
    const result: JsonRecord = {};
    value.forEach((child, key) => {
      if (key !== INTERNAL_ORDER_KEY) result[key] = readYValue(child);
    });
    return result;
  }
  if (value instanceof Y.Array) {
    return value
      .toArray()
      .map((child, physicalIndex) => ({
        child,
        physicalIndex,
        order:
          child instanceof Y.Map && typeof child.get(INTERNAL_ORDER_KEY) === "number"
            ? (child.get(INTERNAL_ORDER_KEY) as number)
            : physicalIndex,
      }))
      .sort((left, right) => left.order - right.order || left.physicalIndex - right.physicalIndex)
      .map(({ child }) => readYValue(child));
  }
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return null;
}

function createYValue(value: JsonValue): JsonPrimitive | Y.Map<unknown> | Y.Array<unknown> {
  if (Array.isArray(value)) {
    const array = new Y.Array<unknown>();
    const orderedById = isIdRecordArray(value);
    const children = value.map((item, order) => {
      const child = createYValue(item);
      if (orderedById && child instanceof Y.Map) child.set(INTERNAL_ORDER_KEY, order);
      return child;
    });
    if (children.length > 0) array.insert(0, children);
    return array;
  }
  if (isRecord(value)) {
    const map = new Y.Map<unknown>();
    Object.entries(value).forEach(([key, child]) => {
      if (child !== undefined) map.set(key, createYValue(child as JsonValue));
    });
    return map;
  }
  return value;
}

function updateYMap(target: Y.Map<unknown>, next: JsonRecord) {
  for (const key of [...target.keys()]) {
    if (key !== INTERNAL_ORDER_KEY && (!(key in next) || next[key] === undefined)) target.delete(key);
  }
  Object.entries(next).forEach(([key, value]) => {
    if (value === undefined) return;
    const current = target.get(key);
    if (Array.isArray(value) && current instanceof Y.Array) {
      updateYArray(current, value);
      return;
    }
    if (isRecord(value) && current instanceof Y.Map) {
      updateYMap(current, value as JsonRecord);
      return;
    }
    if (current instanceof Y.AbstractType || JSON.stringify(current) !== JSON.stringify(value)) {
      target.set(key, createYValue(value));
    }
  });
}

function updateYArray(target: Y.Array<unknown>, next: JsonValue[]) {
  if (isIdRecordArray(next)) {
    const desiredIds = new Set(next.map((item) => item.id));
    const currentItems = target.toArray();
    for (let index = currentItems.length - 1; index >= 0; index -= 1) {
      const item = currentItems[index];
      const id = item instanceof Y.Map ? item.get("id") : null;
      if (typeof id !== "string" || !desiredIds.has(id)) target.delete(index, 1);
    }
    const byId = new Map<string, Y.Map<unknown>>();
    target.toArray().forEach((item) => {
      if (item instanceof Y.Map && typeof item.get("id") === "string") byId.set(item.get("id") as string, item);
    });
    next.forEach((item, order) => {
      let sharedItem = byId.get(item.id);
      if (!sharedItem) {
        sharedItem = new Y.Map<unknown>();
        target.push([sharedItem]);
        byId.set(item.id, sharedItem);
      }
      sharedItem.set(INTERNAL_ORDER_KEY, order);
      updateYMap(sharedItem, item as JsonRecord);
    });
    return;
  }

  const current = readYValue(target);
  if (JSON.stringify(current) === JSON.stringify(next)) return;
  if (target.length > 0) target.delete(0, target.length);
  if (next.length > 0)
    target.insert(
      0,
      next.map((item) => createYValue(item)),
    );
}

function normalizeScopeId(scopeId: string) {
  const value = scopeId.trim().slice(0, 180);
  return value || "local";
}

function countClips(state: DirectorSharedState) {
  return state.creative.editTracks.reduce((total, track) => total + track.clips.length, 0);
}

function appendDiff(
  before: JsonValue | undefined,
  after: JsonValue | undefined,
  path: string,
  output: DirectorVersionDiffEntry[],
) {
  // Keep one sentinel entry past the public cap so exact-cap diffs are not
  // incorrectly reported as truncated.
  if (output.length > MAX_VERSION_DIFF_ENTRIES) return;
  if (before === undefined) {
    output.push({ path, kind: "added", after });
    return;
  }
  if (after === undefined) {
    output.push({ path, kind: "removed", before });
    return;
  }
  if (Object.is(before, after)) return;
  if (Array.isArray(before) && Array.isArray(after)) {
    const beforeById = isIdRecordArray(before) ? new Map(before.map((item) => [item.id, item])) : null;
    const afterById = isIdRecordArray(after) ? new Map(after.map((item) => [item.id, item])) : null;
    if (beforeById && afterById) {
      const ids = [...new Set([...beforeById.keys(), ...afterById.keys()])].sort();
      ids.forEach((id) =>
        appendDiff(beforeById.get(id) as JsonValue, afterById.get(id) as JsonValue, `${path}[${id}]`, output),
      );
      return;
    }
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index += 1) {
      appendDiff(before[index], after[index], `${path}[${index}]`, output);
      if (output.length > MAX_VERSION_DIFF_ENTRIES) return;
    }
    return;
  }
  if (isRecord(before) && isRecord(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    keys.forEach((key) =>
      appendDiff(
        before[key] as JsonValue | undefined,
        after[key] as JsonValue | undefined,
        path ? `${path}.${key}` : key,
        output,
      ),
    );
    return;
  }
  output.push({ path, kind: "changed", before, after });
}

/**
 * Produces a structured diff between two shared states, capped at MAX_VERSION_DIFF_ENTRIES.
 * The diff is a deep JSON comparison that understands id-keyed arrays so reordering
 * does not produce spurious changes.
 *
 * @param before - The earlier shared state.
 * @param after - The later shared state.
 * @param versionId - The version ID for the comparison.
 * @param comparedToVersionId - Optional baseline version ID for two-version comparisons.
 * @returns A version comparison with diff entries and a summary.
 */
export function compareDirectorSharedStates(
  before: DirectorSharedState,
  after: DirectorSharedState,
  versionId = "before",
  comparedToVersionId?: string,
): DirectorVersionComparison {
  const collected: DirectorVersionDiffEntry[] = [];
  appendDiff(before as unknown as JsonValue, after as unknown as JsonValue, "", collected);
  const truncated = collected.length > MAX_VERSION_DIFF_ENTRIES;
  const changes = truncated ? collected.slice(0, MAX_VERSION_DIFF_ENTRIES) : collected;
  return {
    versionId,
    ...(comparedToVersionId ? { comparedToVersionId } : {}),
    changes,
    truncated,
    summary: {
      added: changes.filter((entry) => entry.kind === "added").length,
      removed: changes.filter((entry) => entry.kind === "removed").length,
      changed: changes.filter((entry) => entry.kind === "changed").length,
      stageObjectsBefore: before.stage.objects.length,
      stageObjectsAfter: after.stage.objects.length,
      camerasBefore: before.stage.cameras.length,
      camerasAfter: after.stage.cameras.length,
      canvasNodesBefore: before.creative.boardNodes.length,
      canvasNodesAfter: after.creative.boardNodes.length,
      videoClipsBefore: countClips(before),
      videoClipsAfter: countClips(after),
    },
  };
}

function safeWirePayload(payload: Uint8Array) {
  if (!(payload instanceof Uint8Array)) return null;
  if (payload.byteLength > MAX_WIRE_MESSAGE_BYTES) return null;
  return payload;
}

function bytesToBase64(bytes: Uint8Array) {
  let result = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const packed = (first << 16) | (second << 8) | third;
    result += BASE64_ALPHABET[(packed >>> 18) & 63];
    result += BASE64_ALPHABET[(packed >>> 12) & 63];
    result += index + 1 < bytes.length ? BASE64_ALPHABET[(packed >>> 6) & 63] : "=";
    result += index + 2 < bytes.length ? BASE64_ALPHABET[packed & 63] : "=";
  }
  return result;
}

function base64ToBytes(value: string) {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return null;
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const byteLength = (value.length / 4) * 3 - padding;
  if (byteLength <= 0 || byteLength > MAX_WIRE_MESSAGE_BYTES) return null;
  const result = new Uint8Array(byteLength);
  let outputIndex = 0;
  for (let index = 0; index < value.length; index += 4) {
    const first = BASE64_ALPHABET.indexOf(value[index]!);
    const second = BASE64_ALPHABET.indexOf(value[index + 1]!);
    const third = value[index + 2] === "=" ? 0 : BASE64_ALPHABET.indexOf(value[index + 2]!);
    const fourth = value[index + 3] === "=" ? 0 : BASE64_ALPHABET.indexOf(value[index + 3]!);
    if (first < 0 || second < 0 || third < 0 || fourth < 0) return null;
    const packed = (first << 18) | (second << 12) | (third << 6) | fourth;
    if (outputIndex < byteLength) result[outputIndex++] = (packed >>> 16) & 0xff;
    if (outputIndex < byteLength) result[outputIndex++] = (packed >>> 8) & 0xff;
    if (outputIndex < byteLength) result[outputIndex++] = packed & 0xff;
  }
  return result;
}

function isValidYjsUpdate(update: Uint8Array) {
  const scratch = new Y.Doc();
  try {
    Y.applyUpdate(scratch, update);
    return true;
  } catch {
    return false;
  } finally {
    scratch.destroy();
  }
}

/**
 * Wraps a Yjs update in a versioned JSON/base64 envelope suitable for
 * localStorage, IndexedDB values, object stores, or server persistence.
 * Awareness is deliberately absent because presence is ephemeral.
 */
export function encodeDirectorCollaborationUpdate(input: {
  scopeId: string;
  update: Uint8Array;
  savedAt?: Date | string;
}) {
  const update = safeWirePayload(input.update);
  if (!update || update.byteLength === 0 || !isValidYjsUpdate(update)) {
    throw new Error("Cannot persist an invalid Director collaboration update");
  }
  const savedAt =
    input.savedAt instanceof Date ? input.savedAt.toISOString() : (input.savedAt ?? new Date().toISOString());
  const record = persistedUpdateSchema.parse({
    version: PERSISTENCE_FORMAT_VERSION,
    scopeId: normalizeScopeId(input.scopeId),
    savedAt,
    encoding: "base64",
    update: bytesToBase64(update),
  });
  return JSON.stringify(record);
}

/** Returns null for corrupt, oversized, unsupported, or non-Yjs persistence records. */
export function decodeDirectorCollaborationUpdate(serialized: string): DirectorCollaborationPersistedUpdate | null {
  if (typeof serialized !== "string" || serialized.length === 0 || serialized.length > MAX_PERSISTENCE_RECORD_CHARS) {
    return null;
  }
  try {
    const parsed = persistedUpdateSchema.safeParse(JSON.parse(serialized));
    if (!parsed.success) return null;
    const update = base64ToBytes(parsed.data.update);
    if (!update || !isValidYjsUpdate(update)) return null;
    return {
      version: parsed.data.version,
      scopeId: normalizeScopeId(parsed.data.scopeId),
      savedAt: parsed.data.savedAt,
      update,
    };
  } catch {
    return null;
  }
}

function defaultCreateId(prefix: string) {
  if (typeof globalThis.crypto?.randomUUID === "function") return `${prefix}-${globalThis.crypto.randomUUID()}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export class DirectorCollaborationSession {
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  readonly scopeId: string;
  readonly identity: DirectorCollaboratorIdentity;

  private readonly sharedRoot: Y.Map<unknown>;
  private readonly reviewsRoot: Y.Map<unknown>;
  private readonly versionsRoot: Y.Map<unknown>;
  private readonly now: () => Date;
  private readonly createId: (prefix: string) => string;
  private readonly ownsDoc: boolean;
  private readonly ownsAwareness: boolean;
  private readonly localDocumentOrigin = Symbol("director-local-document");
  private readonly versionRestoreOrigin = Symbol("director-version-restore");
  private readonly persistenceOrigin = Symbol("director-persistence");
  private readonly sharedListeners = new Set<(state: DirectorSharedState) => void>();
  private readonly reviewListeners = new Set<() => void>();
  private readonly versionListeners = new Set<() => void>();
  private readonly presenceListeners = new Set<() => void>();
  private readonly detachTransports = new Set<() => void>();
  private readonly remoteTransportOrigins = new Set<DirectorCollaborationTransport>();
  private destroyed = false;

  private readonly handleSharedChange: Parameters<Y.Map<unknown>["observeDeep"]>[0] = (_events, transaction) => {
    if (transaction.origin === this.localDocumentOrigin) return;
    const state = this.getSharedState();
    if (state) this.sharedListeners.forEach((listener) => listener(state));
  };

  private readonly handleReviewsChange = () => this.reviewListeners.forEach((listener) => listener());
  private readonly handleVersionsChange = () => this.versionListeners.forEach((listener) => listener());
  private readonly handlePresenceChange = () => this.presenceListeners.forEach((listener) => listener());

  constructor(options: DirectorCollaborationSessionOptions) {
    this.scopeId = normalizeScopeId(options.scopeId);
    this.identity = identitySchema.parse(options.identity);
    this.doc = options.doc ?? options.awareness?.doc ?? new Y.Doc();
    if (options.awareness && options.awareness.doc !== this.doc) {
      throw new Error("Director collaboration awareness must belong to the session document");
    }
    this.awareness = options.awareness ?? new Awareness(this.doc);
    this.ownsDoc = !options.doc && !options.awareness;
    this.ownsAwareness = !options.awareness;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? defaultCreateId;
    this.sharedRoot = this.doc.getMap(SHARED_ROOT_KEY);
    this.reviewsRoot = this.doc.getMap(REVIEW_ROOT_KEY);
    this.versionsRoot = this.doc.getMap(VERSION_ROOT_KEY);

    this.sharedRoot.observeDeep(this.handleSharedChange);
    this.reviewsRoot.observeDeep(this.handleReviewsChange);
    this.versionsRoot.observeDeep(this.handleVersionsChange);
    this.awareness.on("change", this.handlePresenceChange);
    this.setLocalPresence({});
  }

  /** Whether the shared root already contains both stage and creative data. */
  hasSharedState() {
    return this.sharedRoot.has("stage") && this.sharedRoot.has("creative");
  }

  /**
   * Replaces the shared state with a new snapshot. Local media URLs are projected
   * to deterministic placeholders before crossing the collaboration boundary.
   */
  setSharedState(state: DirectorSharedState) {
    this.writeSharedState(state, this.localDocumentOrigin);
  }

  private writeSharedState(state: DirectorSharedState, origin: unknown) {
    if (this.destroyed) return false;
    const stage = projectForDirectorCollaboration(state.stage);
    const stageResult = safeParseDirectorProject(stage);
    if (!stageResult.success) throw new Error(stageResult.error);
    const characterBindingIssues = getDirectorCharacterAssetBindingIssues(stageResult.project);
    if (characterBindingIssues.length) {
      throw new Error(`协作工程人物资产绑定无效：${characterBindingIssues.slice(0, 8).join("; ")}`);
    }
    const creative = parseSharedCreativeState(state.creative);
    if (!creative) throw new Error("协作 Canvas/Video 数据无效");
    this.doc.transact(() => {
      const currentStage = this.sharedRoot.get("stage");
      if (currentStage instanceof Y.Map) updateYMap(currentStage, stageResult.project as unknown as JsonRecord);
      else this.sharedRoot.set("stage", createYValue(stageResult.project as unknown as JsonValue));
      const currentCreative = this.sharedRoot.get("creative");
      if (currentCreative instanceof Y.Map) updateYMap(currentCreative, creative as unknown as JsonRecord);
      else this.sharedRoot.set("creative", createYValue(creative as unknown as JsonValue));
    }, origin);
    return true;
  }

  /** Reads the current shared state from the CRDT, or null when the data is incomplete or invalid. */
  getSharedState(): DirectorSharedState | null {
    const stageValue = this.sharedRoot.get("stage");
    const creativeValue = this.sharedRoot.get("creative");
    if (!(stageValue instanceof Y.Map) || !(creativeValue instanceof Y.Map)) return null;
    const stageResult = safeParseDirectorProject(readYValue(stageValue));
    const creative = parseSharedCreativeState(readYValue(creativeValue));
    if (!stageResult.success || !creative || getDirectorCharacterAssetBindingIssues(stageResult.project).length > 0)
      return null;
    return { stage: stageResult.project, creative };
  }

  /**
   * Subscribes to shared state changes from remote peers. Returns an unsubscribe function.
   * Local changes (origin = localDocumentOrigin) do not trigger the listener.
   */
  subscribeSharedState(listener: (state: DirectorSharedState) => void) {
    this.sharedListeners.add(listener);
    return () => this.sharedListeners.delete(listener);
  }

  /** Encodes the current Y.Doc state vector for sync-request handshakes. */
  encodeStateVector() {
    return Y.encodeStateVector(this.doc);
  }

  /** Encodes either a full document update or the delta missing from a peer/persisted state vector. */
  encodeDocumentUpdate(stateVector?: Uint8Array) {
    if (stateVector !== undefined && !safeWirePayload(stateVector)) {
      throw new Error("Cannot encode against an invalid Director collaboration state vector");
    }
    try {
      return stateVector === undefined ? Y.encodeStateAsUpdate(this.doc) : Y.encodeStateAsUpdate(this.doc, stateVector);
    } catch {
      throw new Error("Cannot encode against an invalid Director collaboration state vector");
    }
  }

  /** Applies a validated raw Yjs update and notifies all affected collaboration subscribers. */
  applyDocumentUpdate(update: Uint8Array) {
    if (this.destroyed) return false;
    const payload = safeWirePayload(update);
    if (!payload || payload.byteLength === 0 || !isValidYjsUpdate(payload)) return false;
    try {
      Y.applyUpdate(this.doc, payload, this.persistenceOrigin);
      return true;
    } catch {
      return false;
    }
  }

  /** Serializes the current session state for persistence. The savedAt timestamp defaults to now. */
  encodePersistenceUpdate(savedAt: Date | string = this.now()) {
    return encodeDirectorCollaborationUpdate({
      scopeId: this.scopeId,
      savedAt,
      update: this.encodeDocumentUpdate(),
    });
  }

  /** Merges a persistence record for this exact collaboration scope into the live Y.Doc. */
  applyPersistenceUpdate(serialized: string) {
    const record = decodeDirectorCollaborationUpdate(serialized);
    if (!record || record.scopeId !== this.scopeId) return false;
    return this.applyDocumentUpdate(record.update);
  }

  /**
   * Updates the local user's presence in the awareness set. Only changed fields
   * need to be provided; omitted fields keep their previous values.
   */
  setLocalPresence(patch: DirectorLocalPresencePatch) {
    if (this.destroyed) return;
    const previous = presenceSchema.safeParse(this.awareness.getLocalState()?.director);
    const cursor =
      patch.cursor === null ? undefined : (patch.cursor ?? (previous.success ? previous.data.cursor : undefined));
    const next = presenceSchema.parse({
      user: this.identity,
      sceneId: this.scopeId,
      workspace: patch.workspace ?? (previous.success ? previous.data.workspace : "stage"),
      selectedObjectIds: patch.selectedObjectIds ?? (previous.success ? previous.data.selectedObjectIds : []),
      activeCameraId: patch.activeCameraId ?? (previous.success ? previous.data.activeCameraId : null),
      frame: patch.frame ?? (previous.success ? previous.data.frame : null),
      playheadSec: patch.playheadSec ?? (previous.success ? previous.data.playheadSec : null),
      cursor,
      updatedAt: this.now().toISOString(),
    });
    this.awareness.setLocalStateField("director", next);
  }

  /** Removes the local user's presence from the awareness set. */
  clearLocalPresence() {
    if (this.destroyed) return;
    this.awareness.setLocalState(null);
  }

  /**
   * Returns all remote presences sorted with the local user first, then alphabetically by name.
   * Only entries that pass the presence schema are included.
   */
  getPresences(): DirectorRemotePresence[] {
    const result: DirectorRemotePresence[] = [];
    this.awareness.getStates().forEach((state, clientId) => {
      const parsed = presenceSchema.safeParse(state.director);
      if (parsed.success) result.push({ ...parsed.data, clientId, local: clientId === this.doc.clientID });
    });
    return result.sort(
      (left, right) => Number(right.local) - Number(left.local) || left.user.name.localeCompare(right.user.name),
    );
  }

  /** Subscribes to presence changes. Returns an unsubscribe function. */
  subscribePresence(listener: () => void) {
    this.presenceListeners.add(listener);
    return () => this.presenceListeners.delete(listener);
  }

  /**
   * Adds a new review comment to the shared CRDT. The author defaults to the local identity
   * and the status starts as "open".
   *
   * @returns The created comment with its generated id and timestamps.
   */
  addReviewComment(input: {
    anchor: DirectorReviewAnchor;
    body: string;
    author?: DirectorCollaboratorIdentity;
    id?: string;
  }) {
    if (this.destroyed) throw new Error("协作会话已关闭");
    const timestamp = this.now().toISOString();
    const comment = reviewCommentSchema.parse({
      id: input.id ?? this.createId("review"),
      anchor: input.anchor,
      body: input.body,
      author: input.author ?? this.identity,
      status: "open",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    this.doc.transact(
      () => this.reviewsRoot.set(comment.id, createYValue(comment as unknown as JsonValue)),
      this.localDocumentOrigin,
    );
    return comment;
  }

  /** Updates the body of an existing review comment. Returns false when the comment is not found. */
  updateReviewComment(commentId: string, body: string) {
    if (this.destroyed) return false;
    const current = this.getReviewComments().find((comment) => comment.id === commentId);
    if (!current) return false;
    const next = reviewCommentSchema.parse({ ...current, body, updatedAt: this.now().toISOString() });
    this.doc.transact(() => {
      const value = this.reviewsRoot.get(commentId);
      if (value instanceof Y.Map) updateYMap(value, next as unknown as JsonRecord);
    }, this.localDocumentOrigin);
    return true;
  }

  /**
   * Sets the status of a review comment. When resolving, the current user and timestamp
   * are recorded as the resolver. Returns false when the comment is not found.
   */
  setReviewCommentStatus(commentId: string, status: DirectorReviewStatus) {
    if (this.destroyed) return false;
    const current = this.getReviewComments().find((comment) => comment.id === commentId);
    if (!current) return false;
    const timestamp = this.now().toISOString();
    const next = reviewCommentSchema.parse({
      ...current,
      status,
      updatedAt: timestamp,
      resolvedAt: status === "resolved" ? timestamp : undefined,
      resolvedBy: status === "resolved" ? this.identity : undefined,
    });
    this.doc.transact(() => {
      const value = this.reviewsRoot.get(commentId);
      if (value instanceof Y.Map) updateYMap(value, next as unknown as JsonRecord);
    }, this.localDocumentOrigin);
    return true;
  }

  /** Deletes a review comment. Returns false when the comment is not found. */
  deleteReviewComment(commentId: string) {
    if (this.destroyed) return false;
    if (!this.reviewsRoot.has(commentId)) return false;
    this.doc.transact(() => this.reviewsRoot.delete(commentId), this.localDocumentOrigin);
    return true;
  }

  /**
   * Returns all review comments matching the optional filter, sorted newest-first.
   *
   * @param filter - Optional scene, status, or anchor filter.
   */
  getReviewComments(filter: DirectorReviewCommentFilter = {}) {
    const anchorKey = filter.anchor ? directorReviewAnchorKey(filter.anchor) : null;
    const comments: DirectorReviewComment[] = [];
    this.reviewsRoot.forEach((value) => {
      if (!(value instanceof Y.Map)) return;
      const parsed = reviewCommentSchema.safeParse(readYValue(value));
      if (!parsed.success) return;
      if (filter.sceneId && parsed.data.anchor.sceneId !== filter.sceneId) return;
      if (filter.status && parsed.data.status !== filter.status) return;
      if (anchorKey && directorReviewAnchorKey(parsed.data.anchor) !== anchorKey) return;
      comments.push(parsed.data);
    });
    return comments.sort(
      (left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id),
    );
  }

  /** Subscribes to review comment changes. Returns an unsubscribe function. */
  subscribeReviewComments(listener: () => void) {
    this.reviewListeners.add(listener);
    return () => this.reviewListeners.delete(listener);
  }

  /**
   * Creates a named version snapshot of the current shared state.
   * The name defaults to "Version N" when not provided.
   *
   * @returns The created snapshot with its generated id and timestamp.
   */
  createVersionSnapshot(input: { name: string; author?: DirectorCollaboratorIdentity }) {
    if (this.destroyed) throw new Error("协作会话已关闭");
    const state = this.getSharedState();
    if (!state) throw new Error("协作文档还没有可保存的工程状态");
    const metadata = versionMetadataSchema.parse({
      id: this.createId("version"),
      name: input.name.trim() || `Version ${this.listVersionSnapshots().length + 1}`,
      author: identitySchema.parse(input.author ?? this.identity),
      createdAt: this.now().toISOString(),
    });
    const snapshot: DirectorVersionSnapshot = {
      ...metadata,
      state: cloneJson(state),
    };
    this.doc.transact(
      () => this.versionsRoot.set(snapshot.id, createYValue(snapshot as unknown as JsonValue)),
      this.localDocumentOrigin,
    );
    return snapshot;
  }

  /** Returns all version snapshots sorted newest-first. Invalid entries are silently skipped. */
  listVersionSnapshots() {
    const snapshots: DirectorVersionSnapshot[] = [];
    this.versionsRoot.forEach((value) => {
      if (!(value instanceof Y.Map)) return;
      const raw = readYValue(value);
      if (!isRecord(raw) || !isRecord(raw.state)) return;
      const stageResult = safeParseDirectorProject(raw.state.stage);
      const creative = parseSharedCreativeState(raw.state.creative);
      const metadata = versionMetadataSchema.safeParse({
        id: raw.id,
        name: raw.name,
        createdAt: raw.createdAt,
        author: raw.author,
      });
      if (
        !stageResult.success ||
        !creative ||
        !metadata.success ||
        getDirectorCharacterAssetBindingIssues(stageResult.project).length > 0
      )
        return;
      snapshots.push({
        ...metadata.data,
        state: { stage: stageResult.project, creative },
      });
    });
    return snapshots.sort(
      (left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id),
    );
  }

  /**
   * Compares a version snapshot to the current live shared state.
   *
   * @returns The comparison or null when the version or current state is unavailable.
   */
  compareVersionToCurrent(versionId: string): DirectorVersionComparison | null {
    const version = this.listVersionSnapshots().find((candidate) => candidate.id === versionId);
    const current = this.getSharedState();
    if (!version || !current) return null;
    return compareDirectorSharedStates(version.state, current, versionId);
  }

  /**
   * Compares two version snapshots against each other.
   *
   * @returns The comparison or null when either version is unavailable.
   */
  compareVersionSnapshots(beforeVersionId: string, afterVersionId: string): DirectorVersionComparison | null {
    const snapshots = this.listVersionSnapshots();
    const before = snapshots.find((candidate) => candidate.id === beforeVersionId);
    const after = snapshots.find((candidate) => candidate.id === afterVersionId);
    if (!before || !after) return null;
    return compareDirectorSharedStates(before.state, after.state, beforeVersionId, afterVersionId);
  }

  /**
   * Restores the shared state to a previously saved version snapshot.
   * Returns false when the version is not found.
   */
  restoreVersionSnapshot(versionId: string) {
    const version = this.listVersionSnapshots().find((candidate) => candidate.id === versionId);
    if (!version) return false;
    return this.writeSharedState(version.state, this.versionRestoreOrigin);
  }

  /** Deletes a version snapshot. Returns false when the version is not found. */
  deleteVersionSnapshot(versionId: string) {
    if (this.destroyed || !this.versionsRoot.has(versionId)) return false;
    this.doc.transact(() => this.versionsRoot.delete(versionId), this.localDocumentOrigin);
    return true;
  }

  /** Subscribes to version snapshot changes. Returns an unsubscribe function. */
  subscribeVersionSnapshots(listener: () => void) {
    this.versionListeners.add(listener);
    return () => this.versionListeners.delete(listener);
  }

  /**
   * Attaches a transport to the session, wiring up bidirectional sync.
   * The session sends a sync-request, full document update, and current awareness
   * on attachment. Returns a detach function that unsubscribes and closes the transport.
   */
  attachTransport(transport: DirectorCollaborationTransport) {
    if (this.destroyed) throw new Error("协作会话已关闭");
    const remoteOrigin = transport;
    this.remoteTransportOrigins.add(remoteOrigin);
    const onDocumentUpdate = (update: Uint8Array, origin: unknown) => {
      if (transport.canWriteDocuments === false) return;
      if (!this.remoteTransportOrigins.has(origin as DirectorCollaborationTransport)) {
        transport.send({ type: "document-update", payload: update });
      }
    };
    const onAwarenessUpdate = (change: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (this.remoteTransportOrigins.has(origin as DirectorCollaborationTransport)) return;
      const clients = [...change.added, ...change.updated, ...change.removed];
      if (clients.length > 0)
        transport.send({ type: "awareness-update", payload: encodeAwarenessUpdate(this.awareness, clients) });
    };
    const unsubscribe = transport.subscribe((message) => {
      const payload = safeWirePayload(message.payload);
      if (!payload || this.destroyed) return;
      try {
        if (message.type === "document-update") {
          if (!isValidYjsUpdate(payload)) return;
          Y.applyUpdate(this.doc, payload, remoteOrigin);
        } else if (message.type === "awareness-update") applyAwarenessUpdate(this.awareness, payload, remoteOrigin);
        else if (message.type === "sync-request") {
          if (transport.canWriteDocuments !== false) {
            transport.send({ type: "document-update", payload: Y.encodeStateAsUpdate(this.doc, payload) });
          }
          if (this.awareness.getLocalState()) {
            transport.send({
              type: "awareness-update",
              payload: encodeAwarenessUpdate(this.awareness, [this.doc.clientID]),
            });
          }
        }
      } catch {
        // Providers are an untrusted boundary. A bad packet is ignored without
        // poisoning the current Y.Doc or taking down the editor event loop.
      }
    });
    this.doc.on("update", onDocumentUpdate);
    this.awareness.on("update", onAwarenessUpdate);
    transport.send({ type: "sync-request", payload: Y.encodeStateVector(this.doc) });
    if (transport.canWriteDocuments !== false) {
      transport.send({ type: "document-update", payload: Y.encodeStateAsUpdate(this.doc) });
    }
    const localState = this.awareness.getLocalState();
    if (localState) {
      transport.send({ type: "awareness-update", payload: encodeAwarenessUpdate(this.awareness, [this.doc.clientID]) });
    }

    let detached = false;
    const detach = () => {
      if (detached) return;
      detached = true;
      unsubscribe();
      this.doc.off("update", onDocumentUpdate);
      this.awareness.off("update", onAwarenessUpdate);
      this.detachTransports.delete(detach);
      this.remoteTransportOrigins.delete(remoteOrigin);
      transport.close?.();
    };
    this.detachTransports.add(detach);
    return detach;
  }

  /**
   * Tears down the session: detaches all transports, removes local awareness,
   * unsubscribes all listeners, and destroys owned Yjs resources. Idempotent.
   */
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    removeAwarenessStates(this.awareness, [this.doc.clientID], "session-destroy");
    [...this.detachTransports].forEach((detach) => detach());
    this.sharedRoot.unobserveDeep(this.handleSharedChange);
    this.reviewsRoot.unobserveDeep(this.handleReviewsChange);
    this.versionsRoot.unobserveDeep(this.handleVersionsChange);
    this.awareness.off("change", this.handlePresenceChange);
    this.sharedListeners.clear();
    this.reviewListeners.clear();
    this.versionListeners.clear();
    this.presenceListeners.clear();
    if (this.ownsAwareness) this.awareness.destroy();
    if (this.ownsDoc) this.doc.destroy();
  }
}

interface BroadcastEnvelope {
  room: string;
  sender: string;
  type: DirectorCollaborationWireMessage["type"];
  payload: Uint8Array | ArrayBuffer;
}

/** Same-origin production transport; remote providers can implement the same interface over authenticated WebSocket/WebRTC. */
export class BroadcastChannelDirectorTransport implements DirectorCollaborationTransport {
  private readonly channel: BroadcastChannel;
  private readonly listeners = new Set<(message: DirectorCollaborationWireMessage) => void>();
  private readonly sender = defaultCreateId("peer");
  private closed = false;

  constructor(readonly roomId: string) {
    if (typeof BroadcastChannel === "undefined") throw new Error("BroadcastChannel is not available");
    this.roomId = normalizeScopeId(roomId);
    this.channel = new BroadcastChannel(`director-collaboration:${this.roomId}`);
    this.channel.addEventListener("message", this.handleMessage);
  }

  private readonly handleMessage = (event: MessageEvent<BroadcastEnvelope>) => {
    const envelope = event.data;
    if (!envelope || envelope.room !== this.roomId || envelope.sender === this.sender) return;
    if (!new Set(["document-update", "awareness-update", "sync-request"]).has(envelope.type)) return;
    if (!(envelope.payload instanceof Uint8Array) && !(envelope.payload instanceof ArrayBuffer)) return;
    const payload = envelope.payload instanceof Uint8Array ? envelope.payload : new Uint8Array(envelope.payload);
    if (!safeWirePayload(payload)) return;
    const message = { type: envelope.type, payload } as DirectorCollaborationWireMessage;
    this.listeners.forEach((listener) => listener(message));
  };

  send(message: DirectorCollaborationWireMessage) {
    if (this.closed || !safeWirePayload(message.payload)) return;
    const payload = message.payload.slice();
    this.channel.postMessage({ room: this.roomId, sender: this.sender, type: message.type, payload });
  }

  subscribe(listener: (message: DirectorCollaborationWireMessage) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.channel.removeEventListener("message", this.handleMessage);
    this.channel.close();
    this.listeners.clear();
  }
}

/**
 * Creates a same-origin BroadcastChannel transport for local collaboration.
 * Returns null when BroadcastChannel is unavailable (non-browser or insecure context).
 *
 * @param roomId - The collaboration room identifier.
 * @returns A new BroadcastChannelDirectorTransport or null.
 */
export function createBroadcastChannelDirectorTransport(roomId: string): BroadcastChannelDirectorTransport | null {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return null;
  return new BroadcastChannelDirectorTransport(roomId);
}
