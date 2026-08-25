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
import type { CollaborationRoomAuthorizer, CollaborationRoomDenialReason } from "./collaborationRoomAuth";

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
};

type ClientMembership = {
  roomId: string;
  awarenessClientId: number;
  role: DirectorCollaborationRoomRole;
};

/**
 * Optional durable room operations consumed by the hub: seed snapshots,
 * append valid updates, and quarantine corrupt ones.
 */
export type CollaborationRoomPersistence = {
  loadSnapshot(room: string): Promise<Uint8Array | null>;
  appendUpdate(room: string, update: Uint8Array): Promise<unknown>;
  quarantine(room: string, update: Uint8Array, reason: string): Promise<unknown>;
};

type CollaborationRoom = {
  doc: Y.Doc;
  awareness: Awareness;
  clients: Set<WebSocket>;
  awarenessOwners: Map<number, WebSocket>;
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
 * This class deliberately has no knowledge of terminal, Stage, or Agent
 * messages.
 */
export class DirectorCollaborationWebSocketHub {
  private readonly rooms = new Map<string, CollaborationRoom>();
  private readonly memberships = new Map<WebSocket, ClientMembership>();
  private readonly authorizer: CollaborationRoomAuthorizer;
  private readonly persistence: CollaborationRoomPersistence | null;

  constructor(options: { authorizer?: CollaborationRoomAuthorizer; persistence?: CollaborationRoomPersistence } = {}) {
    this.authorizer = options.authorizer ?? { mode: "local-trust", authorize: () => ({ ok: true, role: "editor" }) };
    this.persistence = options.persistence ?? null;
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
          void this.persistence.quarantine(membership.roomId, payload, "document update failed to apply").catch(
            () => undefined,
          );
        }
        this.error(client, "invalid_payload", "The document update is not a valid Yjs update.", message.room);
        return;
      }
      if (this.persistence) {
        void this.persistence.appendUpdate(membership.roomId, payload).catch(() => undefined);
      }
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
    if (room.clients.size === 0) {
      room.awareness.destroy();
      room.doc.destroy();
      this.rooms.delete(membership.roomId);
    }
  }

  /** Disconnects all clients and destroys all rooms. */
  destroy() {
    for (const client of [...this.memberships.keys()]) this.disconnect(client);
    this.memberships.clear();
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
      send(client, { type: "collab.ready", room: roomId, role: authorization.role });
      return;
    }
    if (current) this.disconnect(client);
    let room = this.rooms.get(roomId);
    if (!room) {
      if (this.rooms.size >= MAX_ROOMS) {
        this.error(client, "room_full", "The collaboration gateway has reached its room limit.", roomId);
        return;
      }
      const doc = new Y.Doc();
      const awareness = new Awareness(doc);
      awareness.setLocalState(null);
      room = { doc, awareness, clients: new Set(), awarenessOwners: new Map() };
      this.rooms.set(roomId, room);
      this.seedPersistedSnapshot(roomId, room);
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
    this.memberships.set(client, { roomId, awarenessClientId, role: authorization.role });
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
