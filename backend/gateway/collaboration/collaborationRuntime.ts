import { resolve } from "node:path";
import { createCollaborationRoomAuthorizer, type CollaborationRoomAuthorizer } from "../collaborationRoomAuth";
import { DirectorCollaborationWebSocketHub } from "../collaborationWebSocketHub";
import { CollaborationInviteRevocationRegistry } from "./collaborationInviteRevocationRegistry";
import {
  CollaborationInviteRateLimiter,
  parseCollaborationInviteRateLimitPerMinute,
} from "./collaborationInviteRateLimit";
import { CollaborationSnapshotStore } from "./collaborationSnapshotStore";

const MAX_EMPTY_ROOM_TTL_SECONDS = 24 * 60 * 60;

/** Every collaboration service the gateway wires together, built once per process. */
export type DirectorCollaborationRuntime = {
  /** The secret signing invite capability tokens. */
  inviteSecret: string;
  /** The room join authorizer (local trust or invite required). */
  authorizer: CollaborationRoomAuthorizer;
  /** Invite revocation registry (persisted when room persistence is on). */
  revocations: CollaborationInviteRevocationRegistry;
  /** Sliding-window limiter for invite mint/revoke (disabled when limit is 0). */
  inviteRateLimiter: CollaborationInviteRateLimiter;
  /** Durable room snapshot store, or null when persistence is off. */
  snapshotStore: CollaborationSnapshotStore | null;
  /** The WebSocket room hub. */
  hub: DirectorCollaborationWebSocketHub;
  /** The configured empty-room retention, in seconds (0 = immediate destroy). */
  emptyRoomTtlSeconds: number;
  /** Configured invite mint/revoke limit per minute (0 = unlimited). */
  inviteRateLimitPerMinute: number;
};

/** Parses `DIRECTOR_COLLAB_EMPTY_ROOM_TTL_SECONDS`: a positive integer clamped to 24 hours, else 0. */
export function parseCollaborationEmptyRoomTtlSeconds(configured: string | undefined) {
  const parsed = Number.parseInt(configured?.trim() ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(parsed, MAX_EMPTY_ROOM_TTL_SECONDS);
}

/**
 * Builds the collaboration boundary from environment configuration. Shared by
 * the gateway entry point and the bootstrap context so both wire identical
 * defaults: local trust auth, in-memory rooms, and immediate empty-room
 * destruction unless the operator opts in via environment variables.
 */
export function createCollaborationRuntime(options: {
  dataDirectory: string;
  gatewaySecret: string;
  env?: NodeJS.ProcessEnv;
}): DirectorCollaborationRuntime {
  const env = options.env ?? process.env;
  const inviteSecret = env.DIRECTOR_COLLAB_INVITE_SECRET?.trim() || options.gatewaySecret;
  const persistenceEnabled = env.DIRECTOR_COLLAB_PERSISTENCE?.trim() === "1";
  const snapshotStore = persistenceEnabled ? new CollaborationSnapshotStore(options.dataDirectory) : null;
  const revocations = new CollaborationInviteRevocationRegistry(
    persistenceEnabled ? { persistPath: resolve(options.dataDirectory, "collaboration-invite-revocations.json") } : {},
  );
  void revocations.load();
  // An explicit empty mode keeps the factory bound to the provided env
  // instead of silently falling back to process.env inside the authorizer.
  const authorizer = createCollaborationRoomAuthorizer({
    secret: inviteSecret,
    mode: env.DIRECTOR_COLLAB_ROOM_AUTH ?? "",
    revocations,
  });
  const emptyRoomTtlSeconds = parseCollaborationEmptyRoomTtlSeconds(env.DIRECTOR_COLLAB_EMPTY_ROOM_TTL_SECONDS);
  const inviteRateLimitPerMinute = parseCollaborationInviteRateLimitPerMinute(
    env.DIRECTOR_COLLAB_INVITE_RATE_LIMIT_PER_MINUTE,
  );
  const inviteRateLimiter = new CollaborationInviteRateLimiter(inviteRateLimitPerMinute);
  const hub = new DirectorCollaborationWebSocketHub({
    authorizer,
    ...(snapshotStore ? { persistence: snapshotStore } : {}),
    emptyRoomRetentionMs: emptyRoomTtlSeconds * 1_000,
  });
  return {
    inviteSecret,
    authorizer,
    revocations,
    inviteRateLimiter,
    snapshotStore,
    hub,
    emptyRoomTtlSeconds,
    inviteRateLimitPerMinute,
  };
}
