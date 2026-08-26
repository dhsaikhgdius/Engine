import { WebSocket } from "ws";
import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import {
  decodeDirectorCollaborationGatewayPayload,
  directorCollaborationGatewayClientMessageSchema,
  encodeDirectorCollaborationGatewayPayload,
  type DirectorCollaborationGatewayClientMessage,
  type DirectorCollaborationGatewayServerMessage,
  type DirectorCollaborationRoomRole,
} from "../../packages/protocol/src/directorCollaborationGatewayProtocol";
import type {
  CollaborationInviteRevocations,
  CollaborationInviteRevocationSubject,
  CollaborationRoomAuthorizer,
  CollaborationRoomDenialReason,
} from "./collaborationRoomAuth";

const MAX_ROOMS = 256;
const MAX_PEERS_PER_ROOM = 64;
const MAX_AWARENESS_PAYLOAD_BYTES = 64 * 1024;
const MAX_AWARENESS_ENTRIES = 8;
const MAX_AWARENESS_STATE_BYTES = 32 * 1024;

const DENIAL_MESSAGES: Record<CollaborationRoomDenialReason, string> = {
  missing_token: "This gateway requires a collaboration invite token to join a room.",
  malformed_token: "The collaboration invite token is malformed.",
  bad_signature: "The collaboration invite token signature is invalid.",
  expired: "The collaboration invite token has expired.",
  room_mismatch: "The collaboration invite token does not grant access to this room.",
  revoked: "The collaboration invite token has been revoked.",
};

type ClientMembership = {
  roomId: string;
  awarenessClientId: number;
  role: DirectorCollaborationRoomRole;
  /** The revocation subject of the invite that admitted this peer; null in local trust mode. */
  inviteSubject: CollaborationInviteRevocationSubject | null;
};

/**
 * Optional durable room operations consumed by the hub: seed snapshots,
 * append valid updates, quarantine corrupt ones, and flush pending updates
 * into the canonical snapshot when a room empties or is closed.
 */
export type CollaborationRoomPersistence = {
  loadSnapshot(room: string): Promise<Uint8Array | null>;
  appendUpdate(room: string, update: Uint8Array): Promise<unknown>;
  quarantine(room: string, update: Uint8Array, reason: string): Promise<unknown>;
  compact?(room: string): Promise<unknown>;
};

type CollaborationRoom = {
  doc: Y.Doc;
  awareness: Awareness;
  clients: Set<WebSocket>;
  awarenessOwners: Map<number, WebSocket>;
  createdAt: number;
  lastActivityAt: number;
  retentionTimer: ReturnType<typeof setTimeout> | null;
};

/** Redacted live status of one collaboration room: counts and timestamps only. */
export type CollaborationLiveRoomStatus = {
  room: string;
  peers: number;
  editors: number;
  viewers: number;
  createdAt: string;
  lastActivityAt: string;
  /** True while an empty room is held in memory by the empty-room TTL. */
  retained: boolean;
};

type AwarenessEntry = {
  clientId: number;
  state: unknown;
};

function readVarUint(payload: Uint8Array, cursor: { value: number }) {
  let value = 0;
  let shift = 0;
  for (let count = 0; count < 5; count += 1) {
    if (cursor.value >= payload.byteLength) throw new RangeError("Unexpected end of varuint");
    const byte = payload[cursor.value++]!;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return value;
    shift += 7;
  }
  throw new RangeError("Varuint exceeds uint32");
}

function decodeAwarenessEntries(payload: Uint8Array): AwarenessEntry[] | null {
  if (payload.byteLength === 0 || payload.byteLength > MAX_AWARENESS_PAYLOAD_BYTES) return null;
  try {
    const cursor = { value: 0 };
    const count = readVarUint(payload, cursor);
    if (count < 1 || count > MAX_AWARENESS_ENTRIES) return null;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const entries: AwarenessEntry[] = [];
    for (let index = 0; index < count; index += 1) {
      const clientId = readVarUint(payload, cursor);
      readVarUint(payload, cursor); // awareness clock
      const byteLength = readVarUint(payload, cursor);
      if (byteLength > MAX_AWARENESS_STATE_BYTES || cursor.value + byteLength > payload.byteLength) return null;
      const serialized = decoder.decode(payload.subarray(cursor.value, cursor.value + byteLength));
      cursor.value += byteLength;
      const state: unknown = JSON.parse(serialized);
      if (state !== null && (typeof state !== "object" || Array.isArray(state))) return null;
      entries.push({ clientId, state });
    }
    return cursor.value === payload.byteLength ? entries : null;
  } catch {
    return null;
  }
}

function send(client: WebSocket, message: DirectorCollaborationGatewayServerMessage) {
  if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
}

function payloadMessage(
  type: "collab.document-update" | "collab.awareness-update" | "collab.sync-request",
  room: string,
  payload: Uint8Array,
): DirectorCollaborationGatewayServerMessage | null {
  const encoded = encodeDirectorCollaborationGatewayPayload(payload);
  return encoded ? { type, room, payload: encoded } : null;
}

/**
 * Authenticated /ws collaboration router.
 *
 * The HTTP upgrade boundary owns origin/token authentication. On top of that,
 * an optional room authorizer enforces per-room invite capabilities: in
 * `invite-required` mode a join must present a valid invite token, and the
 * granted role gates document mutation (`viewer` peers receive updates and
 * share awareness but cannot write). The default authorizer preserves the
 * local trust mode where every authenticated socket is an editor.
 *
 * Room lifecycle policy: by default an empty room is destroyed immediately
 * (the pre-lifecycle behavior). A positive `emptyRoomRetentionMs` keeps the
 * in-memory document alive for that grace period after the last peer leaves,
 * so a quick rejoin does not depend on the persistence round trip. Retention
 * is a convenience, never a capacity claim: when the room cap is reached, the
 * least-recently-active retained empty room is destroyed to admit a new room
 * before a join is denied. Whenever a room empties or is explicitly closed,
 * pending durable updates are flushed into the canonical snapshot
 * (best-effort).
 *
 * This class deliberately has no knowledge of terminal, Stage, or Agent
 * messages.
 */
export class DirectorCollaborationWebSocketHub {
  private readonly rooms = new Map<string, CollaborationRoom>();
  private readonly memberships = new Map<WebSocket, ClientMembership>();
  private readonly authorizer: CollaborationRoomAuthorizer;
  private readonly persistence: CollaborationRoomPersistence | null;
  private readonly emptyRoomRetentionMs: number;
  private readonly maxRooms: number;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;

  constructor(
    options: {
      authorizer?: CollaborationRoomAuthorizer;
      persistence?: CollaborationRoomPersistence;
      /** How long an empty room's in-memory document survives the last peer leaving. Default 0 (immediate destroy). */
      emptyRoomRetentionMs?: number;
      /** Room cap override for tests; production keeps the module default. */
      maxRooms?: number;
      now?: () => number;
      setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
      clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
    } = {},
  ) {
    this.authorizer = options.authorizer ?? { mode: "local-trust", authorize: () => ({ ok: true, role: "editor" }) };
    this.persistence = options.persistence ?? null;
    this.emptyRoomRetentionMs = Math.max(0, options.emptyRoomRetentionMs ?? 0);
    this.maxRooms = Math.max(1, options.maxRooms ?? MAX_ROOMS);
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  /** The active room authorization mode. */
  get authMode() {
    return this.authorizer.mode;
  }

  /** Number of active collaboration rooms. */
  get roomCount() {
    return this.rooms.size;
  }

  /** Number of peers currently connected to a room. */
  peerCount(roomId: string) {
    return this.rooms.get(roomId)?.clients.size ?? 0;
  }

  /** Redacted live status for every in-memory room: role counts and timestamps, never document content. */
  listRoomStatuses(): CollaborationLiveRoomStatus[] {
    const roleCounts = new Map<string, { editors: number; viewers: number }>();
    for (const membership of this.memberships.values()) {
      const counts = roleCounts.get(membership.roomId) ?? { editors: 0, viewers: 0 };
      if (membership.role === "editor") counts.editors += 1;
      else counts.viewers += 1;
      roleCounts.set(membership.roomId, counts);
    }
    return [...this.rooms.entries()]
      .map(([roomId, room]) => ({
        room: roomId,
        peers: room.clients.size,
        editors: roleCounts.get(roomId)?.editors ?? 0,
        viewers: roleCounts.get(roomId)?.viewers ?? 0,
        createdAt: new Date(room.createdAt).toISOString(),
        lastActivityAt: new Date(room.lastActivityAt).toISOString(),
        retained: room.clients.size === 0,
      }))
      .sort((left, right) => left.room.localeCompare(right.room));
  }

  /**
   * Explicitly closes a room: every peer receives a `room_closed` error and
   * loses its membership, the in-memory document is destroyed, and pending
   * durable updates are flushed into the canonical snapshot. A later join
   * recreates the room (seeded from the snapshot unless it was archived).
   */
  closeRoom(roomId: string): { closed: boolean; disconnectedPeers: number } {
    const room = this.rooms.get(roomId);
    if (!room) return { closed: false, disconnectedPeers: 0 };
    const peers = [...room.clients];
    for (const peer of peers) {
      this.error(peer, "room_closed", "This collaboration room was closed by an operator.", roomId);
      this.memberships.delete(peer);
    }
    room.clients.clear();
    this.destroyRoom(roomId, room);
    return { closed: true, disconnectedPeers: peers.length };
  }

  /**
   * Ejects every live peer whose join invite is now revoked, mirroring the
   * denial a rejoin attempt would receive. The invite revocation route calls
   * this right after registering a revocation so revoking a leaked invite
   * ends live sessions instead of only blocking future joins. Peers admitted
   * in local trust mode carry no invite and are never ejected. Each ejected
   * peer receives a permanent `unauthorized` error before losing membership,
   * so compliant clients stop reconnecting.
   */
  enforceInviteRevocations(revocations: CollaborationInviteRevocations): {
    disconnectedPeers: number;
    rooms: string[];
  } {
    const revokedPeers: { client: WebSocket; membership: ClientMembership }[] = [];
    for (const [client, membership] of this.memberships) {
      if (!membership.inviteSubject) continue;
      if (revocations.isRevoked(membership.inviteSubject, membership.roomId)) {
        revokedPeers.push({ client, membership });
      }
    }
    const rooms = new Set<string>();
    for (const { client, membership } of revokedPeers) {
      rooms.add(membership.roomId);
      this.error(client, "unauthorized", DENIAL_MESSAGES.revoked, membership.roomId);
      this.disconnect(client);
    }
    return { disconnectedPeers: revokedPeers.length, rooms: [...rooms].sort() };
  }

  /** Returns whether the input is a valid collaboration client message. */
  accepts(input: unknown) {
    return directorCollaborationGatewayClientMessageSchema.safeParse(input).success;
  }

  /**
   * Routes an incoming message from a connected WebSocket. If the message is
   * a collaboration message, it is handled; otherwise returns `false` so the
   * caller can route it elsewhere.
   *
   * @returns `true` if the message was handled, `false` otherwise.
   */
  handleUnknown(client: WebSocket, input: unknown) {
    const parsed = directorCollaborationGatewayClientMessageSchema.safeParse(input);
    if (!parsed.success) {
      if (
        typeof input === "object" &&
        input !== null &&
        "type" in input &&
        typeof input.type === "string" &&
        input.type.startsWith("collab.")
      ) {
        this.error(client, "invalid_message", "The collaboration message did not match the gateway contract.");
        return true;
      }
      return false;
    }
    this.handle(client, parsed.data);
    return true;
  }

  /**
   * Dispatches a validated collaboration message: join, leave, document update,
   * awareness update, or sync request.
   */
  handle(client: WebSocket, message: DirectorCollaborationGatewayClientMessage) {
    if (message.type === "collab.join") {
      this.join(client, message.room, message.awareness_client_id, message.invite_token);
      return;
    }
    if (message.type === "collab.leave") {
      const membership = this.memberships.get(client);
      if (!membership || membership.roomId !== message.room) {
        this.error(client, "room_mismatch", "The collaboration socket is not joined to this room.", message.room);
        return;
      }
      this.disconnect(client);
      return;
    }

    const membership = this.memberships.get(client);
    if (!membership) {
      this.error(client, "join_required", "Join a collaboration room before sending updates.", message.room);
      return;
    }
    if (membership.roomId !== message.room) {
      this.error(client, "room_mismatch", "Collaboration updates cannot cross room boundaries.", message.room);
      return;
    }
    const room = this.rooms.get(membership.roomId);
    const payload = decodeDirectorCollaborationGatewayPayload(message.payload);
    if (!room || !payload) {
      this.error(
        client,
        "invalid_payload",
        "The collaboration payload is invalid or exceeds its size limit.",
        message.room,
      );
      return;
    }

    if (message.type === "collab.document-update") {
      if (membership.role !== "editor") {
        this.error(client, "forbidden", "This collaboration invite grants view-only access.", message.room);
        return;
      }
      try {
        Y.applyUpdate(room.doc, payload, client);
      } catch {
        if (this.persistence) {
          void this.persistence
            .quarantine(membership.roomId, payload, "document update failed to apply")
            .catch(() => undefined);
        }
        this.error(client, "invalid_payload", "The document update is not a valid Yjs update.", message.room);
        return;
      }
      if (this.persistence) {
        void this.persistence.appendUpdate(membership.roomId, payload).catch(() => undefined);
      }
      room.lastActivityAt = this.now();
      this.broadcast(room, message, client);
      return;
    }

    if (message.type === "collab.awareness-update") {
      const entries = decodeAwarenessEntries(payload);
      if (!entries || entries.some((entry) => entry.clientId !== membership.awarenessClientId)) {
        this.error(
          client,
          "invalid_payload",
          "Awareness updates may only describe the joined Yjs client.",
          message.room,
        );
        return;
      }
      try {
        applyAwarenessUpdate(room.awareness, payload, client);
      } catch {
        this.error(client, "invalid_payload", "The awareness update is invalid.", message.room);
        return;
      }
      if (entries.some((entry) => entry.state !== null)) {
        room.awarenessOwners.set(membership.awarenessClientId, client);
      } else {
        room.awarenessOwners.delete(membership.awarenessClientId);
      }
      room.lastActivityAt = this.now();
      this.broadcast(room, message, client);
      return;
    }

    try {
      const documentUpdate = Y.encodeStateAsUpdate(room.doc, payload);
      const documentMessage = payloadMessage("collab.document-update", message.room, documentUpdate);
      if (documentMessage) send(client, documentMessage);
      const awarenessClientIds = [...room.awareness.getStates().keys()].filter(
        (clientId) => room.awarenessOwners.get(clientId) !== client,
      );
      if (awarenessClientIds.length > 0) {
        const awarenessMessage = payloadMessage(
          "collab.awareness-update",
          message.room,
          encodeAwarenessUpdate(room.awareness, awarenessClientIds),
        );
        if (awarenessMessage) send(client, awarenessMessage);
      }
    } catch {
      this.error(client, "invalid_payload", "The sync request is not a valid Yjs state vector.", message.room);
    }
  }

  /**
   * Removes a client from its room, cleans up awareness state, broadcasts
   * the disconnect, and destroys the room if it becomes empty.
   */
  disconnect(client: WebSocket) {
    const membership = this.memberships.get(client);
    if (!membership) return;
    this.memberships.delete(client);
    const room = this.rooms.get(membership.roomId);
    if (!room) return;
    room.clients.delete(client);
    if (room.awarenessOwners.get(membership.awarenessClientId) === client) {
      room.awarenessOwners.delete(membership.awarenessClientId);
      removeAwarenessStates(room.awareness, [membership.awarenessClientId], "socket-disconnect");
      const cleanup = payloadMessage(
        "collab.awareness-update",
        membership.roomId,
        encodeAwarenessUpdate(room.awareness, [membership.awarenessClientId]),
      );
      if (cleanup) this.broadcast(room, cleanup);
    }
    if (room.clients.size === 0) this.releaseEmptyRoom(membership.roomId, room);
  }

  /** Disconnects all clients and destroys all rooms, including retained empty ones. */
  destroy() {
    for (const client of [...this.memberships.keys()]) this.disconnect(client);
    this.memberships.clear();
    for (const [roomId, room] of [...this.rooms.entries()]) this.destroyRoom(roomId, room);
  }

  /**
   * Applies the empty-room lifecycle policy: flush pending durable updates
   * into the snapshot, then either destroy the in-memory document now
   * (default) or retain it for the configured grace period.
   */
  private releaseEmptyRoom(roomId: string, room: CollaborationRoom) {
    this.flushPersistence(roomId);
    if (this.emptyRoomRetentionMs <= 0) {
      this.destroyRoom(roomId, room, { flush: false });
      return;
    }
    if (room.retentionTimer !== null) this.clearTimer(room.retentionTimer);
    room.retentionTimer = this.setTimer(() => {
      room.retentionTimer = null;
      if (this.rooms.get(roomId) === room && room.clients.size === 0) {
        this.destroyRoom(roomId, room, { flush: false });
      }
    }, this.emptyRoomRetentionMs);
  }

  /** Destroys the least-recently-active retained empty room, if any exists. */
  private evictRetainedEmptyRoom() {
    let victim: { roomId: string; room: CollaborationRoom } | null = null;
    for (const [roomId, room] of this.rooms) {
      if (room.clients.size > 0) continue;
      if (!victim || room.lastActivityAt < victim.room.lastActivityAt) victim = { roomId, room };
    }
    // Pending updates were already flushed when the room emptied and no peer
    // has written since, so this mirrors the retention-timer expiry path.
    if (victim) this.destroyRoom(victim.roomId, victim.room, { flush: false });
  }

  private destroyRoom(roomId: string, room: CollaborationRoom, options: { flush?: boolean } = {}) {
    if (room.retentionTimer !== null) {
      this.clearTimer(room.retentionTimer);
      room.retentionTimer = null;
    }
    room.awareness.destroy();
    room.doc.destroy();
    if (this.rooms.get(roomId) === room) this.rooms.delete(roomId);
    if (options.flush !== false) this.flushPersistence(roomId);
  }

  private flushPersistence(roomId: string) {
    if (!this.persistence?.compact) return;
    void this.persistence.compact(roomId).catch(() => undefined);
  }

  private join(client: WebSocket, roomId: string, awarenessClientId: number, inviteToken?: string) {
    const authorization = this.authorizer.authorize(roomId, inviteToken);
    if (!authorization.ok) {
      this.error(client, "unauthorized", DENIAL_MESSAGES[authorization.reason], roomId);
      return;
    }
    const current = this.memberships.get(client);
    if (current?.roomId === roomId && current.awarenessClientId === awarenessClientId) {
      current.role = authorization.role;
      current.inviteSubject = authorization.subject ?? null;
      send(client, { type: "collab.ready", room: roomId, role: authorization.role });
      return;
    }
    if (current) this.disconnect(client);
    let room = this.rooms.get(roomId);
    if (!room) {
      // Retained empty rooms are a rejoin convenience; they must never deny a
      // new room. Reclaim the least-recently-active one before giving up.
      if (this.rooms.size >= this.maxRooms) this.evictRetainedEmptyRoom();
      if (this.rooms.size >= this.maxRooms) {
        this.error(client, "room_full", "The collaboration gateway has reached its room limit.", roomId);
        return;
      }
      const doc = new Y.Doc();
      const awareness = new Awareness(doc);
      awareness.setLocalState(null);
      const createdAt = this.now();
      room = {
        doc,
        awareness,
        clients: new Set(),
        awarenessOwners: new Map(),
        createdAt,
        lastActivityAt: createdAt,
        retentionTimer: null,
      };
      this.rooms.set(roomId, room);
      this.seedPersistedSnapshot(roomId, room);
    }
    if (room.retentionTimer !== null) {
      this.clearTimer(room.retentionTimer);
      room.retentionTimer = null;
    }
    if (room.clients.size >= MAX_PEERS_PER_ROOM) {
      this.error(client, "room_full", "This collaboration room has reached its peer limit.", roomId);
      return;
    }
    const owner = room.awarenessOwners.get(awarenessClientId);
    if (owner && owner !== client) {
      this.error(client, "client_id_conflict", "This Yjs awareness client is already connected.", roomId);
      return;
    }

    room.clients.add(client);
    room.lastActivityAt = this.now();
    this.memberships.set(client, {
      roomId,
      awarenessClientId,
      role: authorization.role,
      inviteSubject: authorization.subject ?? null,
    });
    send(client, { type: "collab.ready", room: roomId, role: authorization.role });

    const serverDocument = payloadMessage("collab.document-update", roomId, Y.encodeStateAsUpdate(room.doc));
    if (serverDocument) send(client, serverDocument);
    const remoteAwarenessIds = [...room.awareness.getStates().keys()].filter(
      (clientId) => room!.awarenessOwners.get(clientId) !== client,
    );
    if (remoteAwarenessIds.length > 0) {
      const remoteAwareness = payloadMessage(
        "collab.awareness-update",
        roomId,
        encodeAwarenessUpdate(room.awareness, remoteAwarenessIds),
      );
      if (remoteAwareness) send(client, remoteAwareness);
    }
    const syncRequest = payloadMessage("collab.sync-request", roomId, new Uint8Array([0]));
    if (syncRequest) send(client, syncRequest);
  }

  /**
   * Applies the durable room snapshot after room creation and forwards it to
   * every connected peer. Yjs merges are idempotent, so peers that joined
   * before the asynchronous load completes converge on the same state.
   */
  private seedPersistedSnapshot(roomId: string, room: CollaborationRoom) {
    if (!this.persistence) return;
    void this.persistence
      .loadSnapshot(roomId)
      .then((snapshot) => {
        if (!snapshot || this.rooms.get(roomId) !== room) return;
        Y.applyUpdate(room.doc, snapshot, this);
        const seeded = payloadMessage("collab.document-update", roomId, Y.encodeStateAsUpdate(room.doc));
        if (seeded) this.broadcast(room, seeded);
      })
      .catch(() => undefined);
  }

  private broadcast(
    room: CollaborationRoom,
    message: DirectorCollaborationGatewayServerMessage | DirectorCollaborationGatewayClientMessage,
    except?: WebSocket,
  ) {
    for (const peer of room.clients) {
      if (peer !== except) send(peer, message as DirectorCollaborationGatewayServerMessage);
    }
  }

  private error(
    client: WebSocket,
    code: Extract<DirectorCollaborationGatewayServerMessage, { type: "collab.error" }>["code"],
    message: string,
    room?: string,
  ) {
    send(client, { type: "collab.error", code, message, ...(room ? { room } : {}) });
  }
}
