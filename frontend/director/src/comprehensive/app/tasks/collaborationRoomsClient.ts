import { z } from "zod";
import { directorControlPlaneFetch } from "../../editor/api/directorControlPlaneClient";

/**
 * Minimal read-only client for the collaboration room ops surface:
 * `GET /api/collab/rooms` (merged live + durable room status, invite
 * revocation durability counts, lifecycle policy) and the per-room
 * quarantine peek `GET /api/collab/rooms/quarantine?room=`. Both endpoints
 * return counts, hashes, and timestamps only — never document content or
 * invite tokens — and this client performs no mutations.
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

async function readJson(response: Response, fallbackMessage: string): Promise<Record<string, unknown>> {
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    // Collaboration room routes report refusals as { error, code }.
    const message = typeof body.error === "string" ? body.error : typeof body.message === "string" ? body.message : null;
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
