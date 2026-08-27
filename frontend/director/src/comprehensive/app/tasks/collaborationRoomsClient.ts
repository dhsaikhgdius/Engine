import { z } from "zod";
import { directorControlPlaneFetch } from "../../editor/api/directorControlPlaneClient";

/**
 * Minimal client for the collaboration room ops surface:
 * `GET /api/collab/rooms` (merged live + durable room status, invite
 * revocation durability counts, lifecycle policy), the per-room quarantine
 * peek `GET /api/collab/rooms/quarantine?room=`, and the explicitly
 * confirmed `POST /api/collab/rooms/close` (optional `archive: true`). Read
 * endpoints return counts, hashes, and timestamps only — never document
 * content or invite tokens. The close mutation reports typed outcomes
 * honestly: an HTTP 500 `archive_failed` body (room closed, history still in
 * place) is surfaced as a typed result, never as an archive success.
 *
 * @module collaborationRoomsClient
 */

/** One merged live + durable room row from `GET /api/collab/rooms`. */
export const collaborationRoomStatusSchema = z.object({
  room: z.string().min(1),
  active: z.boolean(),
  peers: z.number().int().nonnegative(),
  editors: z.number().int().nonnegative(),
  viewers: z.number().int().nonnegative(),
  retained: z.boolean(),
  created_at: z.string().nullable(),
  last_activity_at: z.string().nullable(),
  snapshot_bytes: z.number().int().nonnegative(),
  snapshot_updated_at: z.string().nullable(),
  snapshot_age_seconds: z.number().int().nonnegative().nullable(),
  pending_updates: z.number().int().nonnegative(),
  quarantined_updates: z.number().int().nonnegative(),
  last_compacted_at: z.string().nullable(),
});

/** One merged live + durable room row. */
export type CollaborationRoomStatus = z.infer<typeof collaborationRoomStatusSchema>;

/**
 * Invite revocation durability counters. `durable: false` means the
 * revocation list is process-local and lost on gateway restart — the section
 * must never present such counts as persisted revokes.
 */
export const collaborationInviteRevocationCountsSchema = z.object({
  revoked_tokens: z.number().int().nonnegative(),
  room_cutoffs: z.number().int().nonnegative(),
  durable: z.boolean(),
});

/** Invite revocation durability counters. */
export type CollaborationInviteRevocationCounts = z.infer<typeof collaborationInviteRevocationCountsSchema>;

/** The full `GET /api/collab/rooms` report the tray section renders. */
export const collaborationRoomsReportSchema = z.object({
  mode: z.string().min(1),
  persistence: z.boolean(),
  empty_room_ttl_seconds: z.number().int().nonnegative(),
  invite_rate_limit_per_minute: z.number().int().nonnegative(),
  invite_revocations: collaborationInviteRevocationCountsSchema,
  rooms: z.array(collaborationRoomStatusSchema),
});

/** The full rooms report. */
export type CollaborationRoomsReport = z.infer<typeof collaborationRoomsReportSchema>;

/** One quarantined-update index record (id, hash, size, reason — no bytes). */
export const collaborationQuarantineRecordSchema = z.object({
  id: z.string().min(1),
  sha256: z.string().min(1),
  byte_length: z.number().int().nonnegative(),
  reason: z.string(),
  quarantined_at: z.string(),
});

/** One quarantined-update index record. */
export type CollaborationQuarantineRecord = z.infer<typeof collaborationQuarantineRecordSchema>;

/** The `GET /api/collab/rooms/quarantine` report for one room. */
export const collaborationRoomQuarantineReportSchema = z.object({
  room: z.string().min(1),
  records: z.array(collaborationQuarantineRecordSchema),
});

/** The quarantine report for one room. */
export type CollaborationRoomQuarantineReport = z.infer<typeof collaborationRoomQuarantineReportSchema>;

/**
 * The HTTP 200 receipt from `POST /api/collab/rooms/close`. `archived` is
 * `null` when no archive was requested, `true` when the durable history was
 * moved aside, and `false` with `archive_reason: "no_durable_history"` for
 * the benign no-op (nothing on disk to move).
 */
export const collaborationRoomCloseReceiptSchema = z.object({
  room: z.string().min(1),
  closed: z.boolean(),
  disconnected_peers: z.number().int().nonnegative(),
  archived: z.boolean().nullable(),
  archive_reason: z.literal("no_durable_history").optional(),
});

/** The HTTP 200 close receipt. */
export type CollaborationRoomCloseReceipt = z.infer<typeof collaborationRoomCloseReceiptSchema>;

/**
 * The HTTP 500 `archive_failed` body from `POST /api/collab/rooms/close`:
 * the room close already happened (peers received `room_closed`), but the
 * filesystem refused the archive rename, so the durable history is still in
 * place. `archive_error_code` carries the errno name, never a path.
 */
export const collaborationRoomArchiveFailureSchema = z.object({
  error: z.string(),
  code: z.literal("archive_failed"),
  room: z.string().min(1),
  closed: z.boolean(),
  disconnected_peers: z.number().int().nonnegative(),
  archived: z.literal(false),
  archive_error_code: z.string().min(1),
});

/** The HTTP 500 archive-failure body. */
export type CollaborationRoomArchiveFailure = z.infer<typeof collaborationRoomArchiveFailureSchema>;

/**
 * The typed outcome of one explicit room close. `archive_failed` is a
 * first-class result (not a thrown error) because it still carries honest
 * close facts — the room is closed, the history is not archived.
 */
export type CollaborationRoomCloseResult =
  | { outcome: "closed"; receipt: CollaborationRoomCloseReceipt }
  | { outcome: "archive_failed"; failure: CollaborationRoomArchiveFailure };

async function readJson(response: Response, fallbackMessage: string): Promise<Record<string, unknown>> {
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    // Collaboration room routes report refusals as { error, code }.
    const message =
      typeof body.error === "string" ? body.error : typeof body.message === "string" ? body.message : null;
    throw new Error(message ?? `${fallbackMessage}（HTTP ${response.status}）`);
  }
  return body;
}

/**
 * Fetches the merged live + durable collaboration room status report.
 *
 * @param signal - Optional AbortSignal for request cancellation.
 */
export async function fetchCollaborationRooms(signal?: AbortSignal): Promise<CollaborationRoomsReport> {
  const response = await directorControlPlaneFetch("/api/collab/rooms", { signal });
  const body = await readJson(response, "协作房间信息请求失败");
  return collaborationRoomsReportSchema.parse(body);
}

/**
 * Fetches the bounded quarantine index for one room (read-only peek).
 *
 * @param room - The collaboration room id.
 * @param signal - Optional AbortSignal for request cancellation.
 */
export async function fetchCollaborationRoomQuarantine(
  room: string,
  signal?: AbortSignal,
): Promise<CollaborationRoomQuarantineReport> {
  const response = await directorControlPlaneFetch(`/api/collab/rooms/quarantine?room=${encodeURIComponent(room)}`, {
    signal,
  });
  const body = await readJson(response, "协作隔离区信息请求失败");
  return collaborationRoomQuarantineReportSchema.parse(body);
}

/**
 * Explicitly closes one collaboration room (every peer receives a
 * `room_closed` error and is disconnected) and optionally archives its
 * durable history. Callers must obtain explicit user confirmation before
 * invoking this — the client never softens outcomes: an HTTP 500
 * `archive_failed` returns a typed failure result, and a 409
 * `collab_persistence_disabled` throws the gateway's refusal label.
 *
 * @param room - The collaboration room id to close.
 * @param options - Set `archive: true` to also move the durable history aside.
 * @param signal - Optional AbortSignal for request cancellation.
 */
export async function closeCollaborationRoom(
  room: string,
  options: { archive?: boolean } = {},
  signal?: AbortSignal,
): Promise<CollaborationRoomCloseResult> {
  const response = await directorControlPlaneFetch("/api/collab/rooms/close", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ room, archive: options.archive === true }),
    signal,
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (response.status === 500 && body.code === "archive_failed") {
    return { outcome: "archive_failed", failure: collaborationRoomArchiveFailureSchema.parse(body) };
  }
  if (!response.ok) {
    const message =
      typeof body.error === "string"
        ? body.error
        : body.code === "collab_persistence_disabled"
          ? "协作持久化未启用，无法归档房间"
          : null;
    throw new Error(message ?? `协作房间关闭请求失败（HTTP ${response.status}）`);
  }
  return { outcome: "closed", receipt: collaborationRoomCloseReceiptSchema.parse(body) };
}
