/**
 * Redacted collaboration deployment flags for the unauthenticated `/health`
 * probe. Counts and policy only — never room ids, tokens, or filesystem paths.
 *
 * @module collaborationHealth
 */

/** Live room row fields required to compute active vs retained counts. */
export type CollaborationHealthRoomRow = {
  /** True when the in-memory room is empty but still held by empty-room TTL. */
  retained: boolean;
};

/** Inputs for the public collaboration health stanza. */
export type CollaborationHealthInput = {
  /** Effective room auth mode (`local-trust` or `invite-required`). */
  mode: string;
  /** Whether durable snapshots / invite revocations are persisted. */
  persistence: boolean;
  /** Configured empty-room retention in seconds (0 = immediate destroy). */
  emptyRoomTtlSeconds: number;
  /** Configured invite mint/revoke limit per minute (0 = unlimited / off). */
  inviteRateLimitPerMinute: number;
  /** Current in-memory rooms from the hub (redacted rows only). */
  liveRooms: readonly CollaborationHealthRoomRow[];
};

/**
 * Machine-readable transport limits of the in-process Yjs hub. These are
 * fixed deployment facts (not toggles): the gateway binds loopback, does not
 * terminate TLS for collab WebSockets, does not shard rooms across nodes, and
 * never maps OS/user accounts onto room members — invite capabilities are the
 * only optional identity surface when room auth is required.
 */
export type CollaborationHealthTransportLimits = {
  /** Gateway collab WS is intended for loopback / reverse-proxy frontends. */
  loopback_binding: true;
  /** This process does not terminate TLS for `/api/collab` WebSockets. */
  tls_termination: false;
  /** Rooms live in one gateway process; no multi-node room cluster. */
  multi_node: false;
  /**
   * How members are identified: invite JWT capability when
   * `mode === "invite-required"`, otherwise local-trust with no per-user id.
   */
  member_identity: "invite-capability" | "local-trust";
};

/** Public `/health.collaboration` payload. */
export type CollaborationHealthStanza = {
  mode: string;
  persistence: boolean;
  empty_room_ttl_seconds: number;
  invite_rate_limit_per_minute: number;
  active_rooms: number;
  retained_rooms: number;
  /** Fixed Limited-boundary transport facts for operators and agents. */
  transport: CollaborationHealthTransportLimits;
};

/**
 * Builds the redacted collaboration stanza for `GET /health` so operators can
 * confirm team-mode flags without authenticating or calling `/api/collab/*`.
 */
export function buildCollaborationHealthStanza(input: CollaborationHealthInput): CollaborationHealthStanza {
  let activeRooms = 0;
  let retainedRooms = 0;
  for (const room of input.liveRooms) {
    if (room.retained) retainedRooms += 1;
    else activeRooms += 1;
  }
  return {
    mode: input.mode,
    persistence: input.persistence,
    empty_room_ttl_seconds: input.emptyRoomTtlSeconds,
    invite_rate_limit_per_minute: input.inviteRateLimitPerMinute,
    active_rooms: activeRooms,
    retained_rooms: retainedRooms,
    transport: {
      loopback_binding: true,
      tls_termination: false,
      multi_node: false,
      member_identity: input.mode === "invite-required" ? "invite-capability" : "local-trust",
    },
  };
}
