import { readFile } from "node:fs/promises";
import { z } from "zod";
import { writeJsonAtomic } from "../atomicJsonFile";
import {
  collaborationRoomScopeMatches,
  decodeCollaborationInvitePayload,
  MAX_COLLABORATION_INVITE_TTL_SECONDS,
  type CollaborationInviteRevocations,
  type CollaborationInviteRevocationSubject,
} from "../collaborationRoomAuth";

const DEFAULT_MAX_REVOKED_TOKENS = 4_096;
const DEFAULT_MAX_ROOM_CUTOFFS = 512;

const persistedStateSchema = z.object({
  revoked_tokens: z.array(z.object({ jti: z.string().min(1).max(64), exp: z.number().int().positive() })).default([]),
  room_cutoffs: z
    .array(z.object({ scope: z.string().min(1).max(181), cutoff: z.number().int().positive() }))
    .default([]),
});

/** The result of revoking one exact invite token. */
export type CollaborationInviteTokenRevocation =
  | { revoked: true; jti: string; room: string; expiresAt: string; persisted: boolean }
  | { revoked: false; reason: "malformed_token" | "not_revocable" | "already_expired" };

/** The result of revoking a room scope's older invites. */
export type CollaborationRoomScopeRevocation = {
  revoked: true;
  room: string;
  cutoff: string;
  /** True only when the revocation reached the durable registry file. */
  persisted: boolean;
};

/**
 * In-memory invite revocation registry with optional JSON persistence.
 *
 * Stateless HMAC invites cannot be individually invalidated without server
 * state, so this registry keeps two bounded structures:
 *
 * - `revokedTokens` — exact invites revoked by their unique `jti`, retained
 *   until the token would have expired anyway.
 * - `roomCutoffs` — per-scope "not before" timestamps: any invite issued at
 *   or before the cutoff is denied when joining a room the scope matches
 *   (same-millisecond ties fail closed). Legacy invites without an `iat`
 *   claim are treated as issued at epoch 0, so a room cutoff always covers
 *   them.
 *
 * When a persist path is provided every mutation is flushed with an atomic
 * write, so revocations survive gateway restarts alongside room snapshots.
 * Without a path the registry is process-local, matching the default invite
 * secret that also rotates on restart. Every revocation outcome reports
 * whether it reached the durable file (`persisted`), so callers never claim
 * restart-surviving revocation when the registry is process-local or the
 * flush failed.
 */
export class CollaborationInviteRevocationRegistry implements CollaborationInviteRevocations {
  private readonly revokedTokens = new Map<string, number>();
  private readonly roomCutoffs = new Map<string, number>();
  private readonly persistPath: string | null;
  private readonly maxRevokedTokens: number;
  private readonly maxRoomCutoffs: number;
  private readonly now: () => number;

  constructor(
    options: {
      persistPath?: string;
      maxRevokedTokens?: number;
      maxRoomCutoffs?: number;
      now?: () => number;
    } = {},
  ) {
    this.persistPath = options.persistPath ?? null;
    this.maxRevokedTokens = Math.max(1, options.maxRevokedTokens ?? DEFAULT_MAX_REVOKED_TOKENS);
    this.maxRoomCutoffs = Math.max(1, options.maxRoomCutoffs ?? DEFAULT_MAX_ROOM_CUTOFFS);
    this.now = options.now ?? Date.now;
  }

  /** True when the registry is configured with a durable persistence file. */
  get persistenceEnabled(): boolean {
    return this.persistPath !== null;
  }

  /** Loads the persisted revocation state, pruning entries that already expired. */
  async load() {
    if (!this.persistPath) return;
    try {
      const parsed = persistedStateSchema.parse(JSON.parse(await readFile(this.persistPath, "utf8")));
      const now = this.now();
      for (const entry of parsed.revoked_tokens) {
        if (entry.exp > now) this.revokedTokens.set(entry.jti, entry.exp);
      }
      for (const entry of parsed.room_cutoffs) this.roomCutoffs.set(entry.scope, entry.cutoff);
      this.prune();
    } catch {
      // A missing or unreadable file starts the registry empty.
    }
  }

  /**
   * Revokes one exact invite by its unsigned payload. Acting on a forged or
   * expired token is harmless because revocation only removes access. Legacy
   * tokens without a `jti` claim report `not_revocable`; use a room-scope
   * revocation to cover them.
   */
  async revokeToken(token: string): Promise<CollaborationInviteTokenRevocation> {
    const payload = decodeCollaborationInvitePayload(token);
    if (!payload) return { revoked: false, reason: "malformed_token" };
    if (!payload.jti) return { revoked: false, reason: "not_revocable" };
    if (payload.exp <= this.now()) return { revoked: false, reason: "already_expired" };
    this.prune();
    this.revokedTokens.set(payload.jti, payload.exp);
    while (this.revokedTokens.size > this.maxRevokedTokens) {
      const oldest = this.revokedTokens.keys().next().value;
      if (oldest === undefined) break;
      this.revokedTokens.delete(oldest);
    }
    const persisted = await this.persist();
    return {
      revoked: true,
      jti: payload.jti,
      room: payload.room,
      expiresAt: new Date(payload.exp).toISOString(),
      persisted,
    };
  }

  /**
   * Revokes every invite for a room scope that was issued at or before now.
   * Invites minted after this call stay valid, so an operator can rotate a
   * leaked invite without locking the room forever.
   */
  async revokeRoomScope(scope: string): Promise<CollaborationRoomScopeRevocation> {
    const cutoff = this.now();
    this.prune();
    // Delete-before-set refreshes the scope's insertion position, so bounded
    // eviction drops the least recently revoked scope, not a just-refreshed one.
    this.roomCutoffs.delete(scope);
    this.roomCutoffs.set(scope, cutoff);
    while (this.roomCutoffs.size > this.maxRoomCutoffs) {
      const oldest = this.roomCutoffs.keys().next().value;
      if (oldest === undefined) break;
      this.roomCutoffs.delete(oldest);
    }
    const persisted = await this.persist();
    return { revoked: true, room: scope, cutoff: new Date(cutoff).toISOString(), persisted };
  }

  /** Consulted by the room authorizer after signature, expiry, and scope checks pass. */
  isRevoked(subject: CollaborationInviteRevocationSubject, roomId: string) {
    if (subject.jti && this.revokedTokens.has(subject.jti)) return true;
    for (const [scope, cutoff] of this.roomCutoffs) {
      if (collaborationRoomScopeMatches(roomId, scope) && (subject.iat ?? 0) <= cutoff) return true;
    }
    return false;
  }

  /** Bounded operational counters, safe to expose on the ops status endpoint. */
  counts() {
    this.prune();
    return { revokedTokens: this.revokedTokens.size, roomCutoffs: this.roomCutoffs.size };
  }

  private prune() {
    const now = this.now();
    for (const [jti, exp] of this.revokedTokens) {
      if (exp <= now) this.revokedTokens.delete(jti);
    }
    // A cutoff older than the maximum invite TTL can never deny a live invite
    // (every invite issued at or before it has already expired), so dropping
    // it keeps dead entries from evicting still-relevant cutoffs at the bound.
    const deadCutoffBefore = now - MAX_COLLABORATION_INVITE_TTL_SECONDS * 1_000;
    for (const [scope, cutoff] of this.roomCutoffs) {
      if (cutoff <= deadCutoffBefore) this.roomCutoffs.delete(scope);
    }
  }

  /**
   * Flushes the registry to its durable file, reporting whether the flush
   * landed. The in-memory registry stays authoritative for this process
   * either way; `false` means the revocation will not survive a restart.
   */
  private async persist(): Promise<boolean> {
    if (!this.persistPath) return false;
    try {
      await writeJsonAtomic(this.persistPath, {
        revoked_tokens: [...this.revokedTokens].map(([jti, exp]) => ({ jti, exp })),
        room_cutoffs: [...this.roomCutoffs].map(([scope, cutoff]) => ({ scope, cutoff })),
      });
      return true;
    } catch {
      return false;
    }
  }
}
