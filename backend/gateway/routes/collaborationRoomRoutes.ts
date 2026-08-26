import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { directorCollaborationRoomSchema } from "../../../packages/protocol/src/directorCollaborationGatewayProtocol";
import type { CollaborationRoomAuthorizer } from "../collaborationRoomAuth";
import type { CollaborationInviteRevocationRegistry } from "../collaboration/collaborationInviteRevocationRegistry";
import type {
  CollaborationRoomOpsStatus,
  CollaborationSnapshotStore,
} from "../collaboration/collaborationSnapshotStore";
import type { CollaborationLiveRoomStatus, DirectorCollaborationWebSocketHub } from "../collaborationWebSocketHub";

type JsonWriter = (response: ServerResponse, status: number, body: unknown) => void;

const closeRoomRequestSchema = z.strictObject({
  room: directorCollaborationRoomSchema,
  archive: z.boolean().default(false),
});

/**
 * Hardens collaboration HTTP responses for shared-network deployments:
 * capability tokens and room metadata must never enter shared caches or leak
 * through referrers. The gateway JSON writer already sends
 * `Cache-Control: no-store`; these are explicit defense-in-depth headers.
 */
export function applyCollaborationResponseHardening(response: ServerResponse) {
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  if (!response.getHeader("cache-control")) response.setHeader("cache-control", "no-store");
}

/** One merged room row: live hub state joined with durable snapshot status. */
type MergedRoomStatus = {
  room: string;
  active: boolean;
  peers: number;
  editors: number;
  viewers: number;
  retained: boolean;
  created_at: string | null;
  last_activity_at: string | null;
  snapshot_bytes: number;
  snapshot_updated_at: string | null;
  snapshot_age_seconds: number | null;
  pending_updates: number;
  quarantined_updates: number;
  last_compacted_at: string | null;
};

function mergeRoomStatuses(
  live: CollaborationLiveRoomStatus[],
  persisted: CollaborationRoomOpsStatus[],
  nowMs: number,
): MergedRoomStatus[] {
  const rows = new Map<string, MergedRoomStatus>();
  const emptyRow = (room: string): MergedRoomStatus => ({
    room,
    active: false,
    peers: 0,
    editors: 0,
    viewers: 0,
    retained: false,
    created_at: null,
    last_activity_at: null,
    snapshot_bytes: 0,
    snapshot_updated_at: null,
    snapshot_age_seconds: null,
    pending_updates: 0,
    quarantined_updates: 0,
    last_compacted_at: null,
  });
  for (const status of persisted) {
    const row = rows.get(status.room) ?? emptyRow(status.room);
    row.snapshot_bytes = status.snapshotBytes;
    row.snapshot_updated_at = status.snapshotUpdatedAt;
    row.snapshot_age_seconds = status.snapshotUpdatedAt
      ? Math.max(0, Math.round((nowMs - Date.parse(status.snapshotUpdatedAt)) / 1_000))
      : null;
    row.pending_updates = status.pendingUpdates;
    row.quarantined_updates = status.quarantinedUpdates;
    row.last_compacted_at = status.lastCompactedAt;
    rows.set(status.room, row);
  }
  for (const status of live) {
    const row = rows.get(status.room) ?? emptyRow(status.room);
    row.active = true;
    row.peers = status.peers;
    row.editors = status.editors;
    row.viewers = status.viewers;
    row.retained = status.retained;
    row.created_at = status.createdAt;
    row.last_activity_at = status.lastActivityAt;
    rows.set(status.room, row);
  }
  return [...rows.values()].sort((left, right) => left.room.localeCompare(right.room));
}

/** Dependencies required by the collaboration room lifecycle/ops route handler. */
export type CollaborationRoomRouteDependencies = {
  /** Parses the request body into a JSON-compatible value. */
  readBody: (request: IncomingMessage) => Promise<unknown>;
  /** Writes a JSON response with the given status code. */
  json: JsonWriter;
  /** The live WebSocket room hub. */
  hub: DirectorCollaborationWebSocketHub;
  /** The active room authorizer (reports the effective mode). */
  authorizer: CollaborationRoomAuthorizer;
  /** Durable room snapshot store, or null when persistence is off. */
  snapshotStore: CollaborationSnapshotStore | null;
  /** Invite revocation registry for operational counters. */
  revocations: CollaborationInviteRevocationRegistry;
  /** The configured empty-room retention in seconds (0 = immediate destroy). */
  emptyRoomTtlSeconds: number;
  /** Clock override for tests. */
  now?: () => number;
};

/**
 * Read-mostly operational routes for collaboration room lifecycle. All routes
 * sit behind the master gateway token, respond with counts, timestamps, and
 * hashes only — never document content, invite tokens, prompts, or filesystem
 * paths — and carry no-store/no-referrer hardening headers.
 *
 * Routes:
 * - `GET /api/collab/rooms` — merged live + durable room status (member
 *   counts, snapshot age, quarantine counts, auth mode).
 * - `GET /api/collab/rooms/quarantine?room=<id>` — the bounded quarantine
 *   index for one room (ids, hashes, sizes, reasons).
 * - `POST /api/collab/rooms/close` — explicitly close a live room; with
 *   `archive: true` also move its durable history aside so future joins
 *   start empty.
 *
 * @returns True if the route was handled, false otherwise.
 */
export async function handleCollaborationRoomRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  dependencies: CollaborationRoomRouteDependencies,
) {
  const { readBody, json, hub, authorizer, snapshotStore, revocations, emptyRoomTtlSeconds } = dependencies;
  const now = dependencies.now ?? Date.now;

  if (request.method === "GET" && url.pathname === "/api/collab/rooms") {
    applyCollaborationResponseHardening(response);
    const roomFilterRaw = url.searchParams.get("room");
    let roomFilter: string | null = null;
    if (roomFilterRaw !== null) {
      const parsed = directorCollaborationRoomSchema.safeParse(roomFilterRaw);
      if (!parsed.success) {
        json(response, 400, { error: "协作房间 id 无效", code: "invalid_room" });
        return true;
      }
      roomFilter = parsed.data;
    }
    const persisted = snapshotStore
      ? roomFilter
        ? [await snapshotStore.status(roomFilter)]
        : await snapshotStore.listRooms()
      : [];
    const live = hub.listRoomStatuses().filter((status) => !roomFilter || status.room === roomFilter);
    const rooms = mergeRoomStatuses(live, persisted, now()).filter(
      (row) => row.active || row.snapshot_bytes > 0 || row.pending_updates > 0 || row.quarantined_updates > 0,
    );
    json(response, 200, {
      mode: authorizer.mode,
      persistence: snapshotStore !== null,
      empty_room_ttl_seconds: emptyRoomTtlSeconds,
      invite_revocations: {
        revoked_tokens: revocations.counts().revokedTokens,
        room_cutoffs: revocations.counts().roomCutoffs,
      },
      rooms,
    });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/collab/rooms/quarantine") {
    applyCollaborationResponseHardening(response);
    if (!snapshotStore) {
      json(response, 409, { error: "协作持久化未启用，无隔离区可查询", code: "collab_persistence_disabled" });
      return true;
    }
    const parsed = directorCollaborationRoomSchema.safeParse(url.searchParams.get("room") ?? "");
    if (!parsed.success) {
      json(response, 400, { error: "协作房间 id 无效", code: "invalid_room" });
      return true;
    }
    const records = await snapshotStore.listQuarantined(parsed.data);
    json(response, 200, {
      room: parsed.data,
      records: records.map((record) => ({
        id: record.id,
        sha256: record.sha256,
        byte_length: record.byteLength,
        reason: record.reason,
        quarantined_at: record.quarantinedAt,
      })),
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/collab/rooms/close") {
    applyCollaborationResponseHardening(response);
    const parsed = closeRoomRequestSchema.safeParse(await readBody(request));
    if (!parsed.success) {
      json(response, 400, { error: "协作房间关闭参数无效", code: "invalid_request" });
      return true;
    }
    if (parsed.data.archive && !snapshotStore) {
      json(response, 409, { error: "协作持久化未启用，无法归档房间", code: "collab_persistence_disabled" });
      return true;
    }
    const closed = hub.closeRoom(parsed.data.room);
    let archived: boolean | null = null;
    if (parsed.data.archive && snapshotStore) {
      archived = (await snapshotStore.archiveRoom(parsed.data.room)).archived;
    }
    json(response, 200, {
      room: parsed.data.room,
      closed: closed.closed,
      disconnected_peers: closed.disconnectedPeers,
      archived,
    });
    return true;
  }

  return false;
}
