// @vitest-environment node

import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import {
  decodeDirectorCollaborationGatewayPayload,
  encodeDirectorCollaborationGatewayPayload,
  type DirectorCollaborationGatewayClientMessage,
  type DirectorCollaborationGatewayServerMessage,
} from "../../../../packages/protocol/src/directorCollaborationGatewayProtocol";
import { DirectorCollaborationWebSocketHub } from "../../collaborationWebSocketHub";
import { createCollaborationRoomAuthorizer, mintCollaborationInviteToken } from "../../collaborationRoomAuth";
import { CollaborationInviteRevocationRegistry } from "../../collaboration/collaborationInviteRevocationRegistry";

type FakeSocket = WebSocket & { sent: string[] };

function socket(): FakeSocket {
  const sent: string[] = [];
  return {
    readyState: WebSocket.OPEN,
    sent,
    send(value: string) {
      sent.push(value);
    },
  } as unknown as FakeSocket;
}

function messages(client: FakeSocket) {
  return client.sent.map((value) => JSON.parse(value) as DirectorCollaborationGatewayServerMessage);
}

function binaryMessage(
  type: "collab.document-update" | "collab.awareness-update" | "collab.sync-request",
  room: string,
  payload: Uint8Array,
): DirectorCollaborationGatewayClientMessage {
  return { type, room, payload: encodeDirectorCollaborationGatewayPayload(payload)! };
}

function fakeTimers() {
  const pending = new Map<number, () => void>();
  let nextId = 1;
  return {
    pending,
    setTimer(callback: () => void) {
      const id = nextId++;
      pending.set(id, callback);
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer(timer: ReturnType<typeof setTimeout>) {
      pending.delete(timer as unknown as number);
    },
    fire() {
      for (const [id, callback] of [...pending]) {
        pending.delete(id);
        callback();
      }
    },
  };
}

describe("DirectorCollaborationWebSocketHub", () => {
  it("routes Yjs updates only to peers in the same room and never echoes to the sender", () => {
    const hub = new DirectorCollaborationWebSocketHub();
    const roomA1 = socket();
    const roomA2 = socket();
    const roomB = socket();
    hub.handle(roomA1, { type: "collab.join", room: "room-a", awareness_client_id: 101 });
    hub.handle(roomA2, { type: "collab.join", room: "room-a", awareness_client_id: 102 });
    hub.handle(roomB, { type: "collab.join", room: "room-b", awareness_client_id: 201 });
    roomA1.sent.length = 0;
    roomA2.sent.length = 0;
    roomB.sent.length = 0;

    const source = new Y.Doc();
    source.getMap("scene").set("title", "Shared shot");
    hub.handle(roomA1, binaryMessage("collab.document-update", "room-a", Y.encodeStateAsUpdate(source)));

    expect(messages(roomA1)).toHaveLength(0);
    expect(messages(roomB)).toHaveLength(0);
    const routed = messages(roomA2);
    expect(routed).toHaveLength(1);
    expect(routed[0]?.type).toBe("collab.document-update");
    const destination = new Y.Doc();
    const routedPayload = decodeDirectorCollaborationGatewayPayload(
      (routed[0] as Extract<DirectorCollaborationGatewayServerMessage, { type: "collab.document-update" }>).payload,
    )!;
    Y.applyUpdate(destination, routedPayload);
    expect(destination.getMap("scene").get("title")).toBe("Shared shot");

    source.destroy();
    destination.destroy();
    hub.destroy();
  });

  it("removes disconnected awareness immediately and broadcasts a standard null-state update", () => {
    const hub = new DirectorCollaborationWebSocketHub();
    const first = socket();
    const second = socket();
    const sourceDoc = new Y.Doc();
    const sourceAwareness = new Awareness(sourceDoc);
    const sourceId = sourceDoc.clientID;
    const receiverDoc = new Y.Doc();
    const receiverAwareness = new Awareness(receiverDoc);
    hub.handle(first, { type: "collab.join", room: "review", awareness_client_id: sourceId });
    hub.handle(second, { type: "collab.join", room: "review", awareness_client_id: receiverDoc.clientID });
    first.sent.length = 0;
    second.sent.length = 0;

    sourceAwareness.setLocalState({ director: { name: "Remote reviewer" } });
    hub.handle(
      first,
      binaryMessage("collab.awareness-update", "review", encodeAwarenessUpdate(sourceAwareness, [sourceId])),
    );
    const presence = messages(second).at(-1) as Extract<
      DirectorCollaborationGatewayServerMessage,
      { type: "collab.awareness-update" }
    >;
    applyAwarenessUpdate(receiverAwareness, decodeDirectorCollaborationGatewayPayload(presence.payload)!, "gateway");
    expect(receiverAwareness.getStates().get(sourceId)).toMatchObject({
      director: { name: "Remote reviewer" },
    });

    second.sent.length = 0;
    hub.disconnect(first);
    const cleanup = messages(second).at(-1) as Extract<
      DirectorCollaborationGatewayServerMessage,
      { type: "collab.awareness-update" }
    >;
    applyAwarenessUpdate(receiverAwareness, decodeDirectorCollaborationGatewayPayload(cleanup.payload)!, "gateway");
    expect(receiverAwareness.getStates().has(sourceId)).toBe(false);
    expect(hub.peerCount("review")).toBe(1);

    hub.disconnect(second);
    expect(hub.peerCount("review")).toBe(0);

    sourceAwareness.destroy();
    sourceDoc.destroy();
    receiverAwareness.destroy();
    receiverDoc.destroy();
    hub.destroy();
  });

  it("destroys an empty room so a later join starts from a fresh document", () => {
    const hub = new DirectorCollaborationWebSocketHub();
    const first = socket();
    hub.handle(first, { type: "collab.join", room: "lifecycle", awareness_client_id: 11 });
    const seed = new Y.Doc();
    seed.getMap("scene").set("title", "Transient");
    hub.handle(first, binaryMessage("collab.document-update", "lifecycle", Y.encodeStateAsUpdate(seed)));
    hub.disconnect(first);
    expect(hub.peerCount("lifecycle")).toBe(0);

    const rejoined = socket();
    hub.handle(rejoined, { type: "collab.join", room: "lifecycle", awareness_client_id: 12 });
    rejoined.sent.length = 0;
    hub.handle(rejoined, { type: "collab.sync-request", room: "lifecycle", payload: "" });
    const sync = messages(rejoined).find((message) => message.type === "collab.document-update") as
      Extract<DirectorCollaborationGatewayServerMessage, { type: "collab.document-update" }> | undefined;
    const restored = new Y.Doc();
    if (sync) Y.applyUpdate(restored, decodeDirectorCollaborationGatewayPayload(sync.payload)!);
    expect(restored.getMap("scene").get("title")).toBeUndefined();

    seed.destroy();
    restored.destroy();
    hub.destroy();
  });

  it("rejects room hopping and awareness identity spoofing", () => {
    const hub = new DirectorCollaborationWebSocketHub();
    const first = socket();
    const second = socket();
    const attackerDoc = new Y.Doc();
    const attackerAwareness = new Awareness(attackerDoc);
    hub.handle(first, { type: "collab.join", room: "safe-room", awareness_client_id: 11 });
    hub.handle(second, { type: "collab.join", room: "safe-room", awareness_client_id: 12 });
    first.sent.length = 0;
    second.sent.length = 0;

    const updateDoc = new Y.Doc();
    updateDoc.getMap("scene").set("unsafe", true);
    hub.handle(first, binaryMessage("collab.document-update", "another-room", Y.encodeStateAsUpdate(updateDoc)));
    expect(messages(first).at(-1)).toMatchObject({ type: "collab.error", code: "room_mismatch" });
    expect(messages(second)).toHaveLength(0);

    attackerAwareness.setLocalState({ director: { name: "Spoofed" } });
    hub.handle(
      first,
      binaryMessage(
        "collab.awareness-update",
        "safe-room",
        encodeAwarenessUpdate(attackerAwareness, [attackerDoc.clientID]),
      ),
    );
    expect(messages(first).at(-1)).toMatchObject({ type: "collab.error", code: "invalid_payload" });
    expect(messages(second)).toHaveLength(0);

    attackerAwareness.destroy();
    attackerDoc.destroy();
    updateDoc.destroy();
    hub.destroy();
  });
});

describe("DirectorCollaborationWebSocketHub room lifecycle policy", () => {
  it("closes a room explicitly: peers receive room_closed, memberships end, and the document is destroyed", () => {
    const hub = new DirectorCollaborationWebSocketHub();
    const first = socket();
    const second = socket();
    hub.handle(first, { type: "collab.join", room: "wrap-party", awareness_client_id: 81 });
    hub.handle(second, { type: "collab.join", room: "wrap-party", awareness_client_id: 82 });
    first.sent.length = 0;
    second.sent.length = 0;

    const result = hub.closeRoom("wrap-party");
    expect(result).toEqual({ closed: true, disconnectedPeers: 2 });
    expect(messages(first).at(-1)).toMatchObject({ type: "collab.error", code: "room_closed", room: "wrap-party" });
    expect(messages(second).at(-1)).toMatchObject({ type: "collab.error", code: "room_closed", room: "wrap-party" });
    expect(hub.peerCount("wrap-party")).toBe(0);
    expect(hub.roomCount).toBe(0);
    expect(hub.closeRoom("wrap-party")).toEqual({ closed: false, disconnectedPeers: 0 });

    // A member that keeps writing after the close needs a fresh join.
    const doc = new Y.Doc();
    doc.getMap("scene").set("late", true);
    hub.handle(first, binaryMessage("collab.document-update", "wrap-party", Y.encodeStateAsUpdate(doc)));
    expect(messages(first).at(-1)).toMatchObject({ type: "collab.error", code: "join_required" });
    doc.destroy();
    hub.destroy();
  });

  it("retains an empty room for the configured TTL so a quick rejoin keeps the document", () => {
    const timers = fakeTimers();
    const hub = new DirectorCollaborationWebSocketHub({
      emptyRoomRetentionMs: 60_000,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    const first = socket();
    hub.handle(first, { type: "collab.join", room: "held-room", awareness_client_id: 91 });
    const seed = new Y.Doc();
    seed.getMap("scene").set("title", "Kept alive");
    hub.handle(first, binaryMessage("collab.document-update", "held-room", Y.encodeStateAsUpdate(seed)));
    hub.disconnect(first);

    // The room is empty but retained in memory.
    expect(hub.peerCount("held-room")).toBe(0);
    expect(hub.roomCount).toBe(1);
    expect(hub.listRoomStatuses()).toMatchObject([{ room: "held-room", peers: 0, retained: true }]);

    // A rejoin inside the TTL cancels the destroy timer and keeps the content.
    const rejoined = socket();
    hub.handle(rejoined, { type: "collab.join", room: "held-room", awareness_client_id: 92 });
    expect(timers.pending.size).toBe(0);
    const synced = messages(rejoined).find((message) => message.type === "collab.document-update") as
      Extract<DirectorCollaborationGatewayServerMessage, { type: "collab.document-update" }> | undefined;
    const restored = new Y.Doc();
    Y.applyUpdate(restored, decodeDirectorCollaborationGatewayPayload(synced!.payload)!);
    expect(restored.getMap("scene").get("title")).toBe("Kept alive");

    // After the TTL fires on an empty room, the next join starts fresh.
    hub.disconnect(rejoined);
    expect(hub.roomCount).toBe(1);
    timers.fire();
    expect(hub.roomCount).toBe(0);

    seed.destroy();
    restored.destroy();
    hub.destroy();
  });

  it("evicts the least-recently-active retained empty room instead of denying a new room at the cap", () => {
    const timers = fakeTimers();
    const clock = { value: 1_700_000_000_000 };
    const hub = new DirectorCollaborationWebSocketHub({
      emptyRoomRetentionMs: 60_000,
      maxRooms: 2,
      now: () => clock.value,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    const first = socket();
    hub.handle(first, { type: "collab.join", room: "older-retained", awareness_client_id: 61 });
    hub.disconnect(first);
    clock.value += 1_000;
    const second = socket();
    hub.handle(second, { type: "collab.join", room: "newer-retained", awareness_client_id: 62 });
    hub.disconnect(second);
    expect(hub.roomCount).toBe(2);

    // Both slots hold retained empty rooms; a new room reclaims the older one.
    clock.value += 1_000;
    const third = socket();
    hub.handle(third, { type: "collab.join", room: "fresh-room", awareness_client_id: 63 });
    expect(messages(third).at(0)).toMatchObject({ type: "collab.ready", room: "fresh-room" });
    expect(hub.roomCount).toBe(2);
    const rooms = hub.listRoomStatuses().map((status) => status.room);
    expect(rooms).toEqual(["fresh-room", "newer-retained"]);

    // With every room occupied by live peers the cap still denies a new room.
    const fourth = socket();
    hub.handle(fourth, { type: "collab.join", room: "newer-retained", awareness_client_id: 64 });
    expect(messages(fourth).at(0)).toMatchObject({ type: "collab.ready", room: "newer-retained" });
    const fifth = socket();
    hub.handle(fifth, { type: "collab.join", room: "denied-room", awareness_client_id: 65 });
    expect(messages(fifth).at(-1)).toMatchObject({ type: "collab.error", code: "room_full", room: "denied-room" });
    hub.destroy();
  });

  it("flushes pending durable updates into the snapshot when a room empties or closes", async () => {
    const compacted: string[] = [];
    const persistence = {
      loadSnapshot: async () => null,
      appendUpdate: async () => undefined,
      quarantine: async () => undefined,
      compact: async (room: string) => {
        compacted.push(room);
      },
    };
    const hub = new DirectorCollaborationWebSocketHub({ persistence });
    const leaver = socket();
    hub.handle(leaver, { type: "collab.join", room: "flush-on-empty", awareness_client_id: 95 });
    hub.disconnect(leaver);
    const closer = socket();
    hub.handle(closer, { type: "collab.join", room: "flush-on-close", awareness_client_id: 96 });
    hub.closeRoom("flush-on-close");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    expect(compacted).toEqual(["flush-on-empty", "flush-on-close"]);
    hub.destroy();
  });

  it("reports redacted per-room status with role counts and timestamps only", () => {
    const clock = { value: 1_700_000_000_000 };
    const hub = new DirectorCollaborationWebSocketHub({
      authorizer: createCollaborationRoomAuthorizer({ secret: "status-secret", mode: "required" }),
      now: () => clock.value,
    });
    const editor = socket();
    const viewer = socket();
    hub.handle(editor, {
      type: "collab.join",
      room: "status-room",
      awareness_client_id: 97,
      invite_token: mintCollaborationInviteToken({ secret: "status-secret", room: "status-room", role: "editor" })
        .token,
    });
    clock.value += 5_000;
    hub.handle(viewer, {
      type: "collab.join",
      room: "status-room",
      awareness_client_id: 98,
      invite_token: mintCollaborationInviteToken({ secret: "status-secret", room: "status-room", role: "viewer" })
        .token,
    });
    const statuses = hub.listRoomStatuses();
    expect(statuses).toEqual([
      {
        room: "status-room",
        peers: 2,
        editors: 1,
        viewers: 1,
        createdAt: new Date(1_700_000_000_000).toISOString(),
        lastActivityAt: new Date(1_700_000_005_000).toISOString(),
        retained: false,
      },
    ]);
    hub.destroy();
  });
});

describe("DirectorCollaborationWebSocketHub room authorization", () => {
  const SECRET = "room-auth-hub-secret";

  function inviteRequiredHub() {
    return new DirectorCollaborationWebSocketHub({
      authorizer: createCollaborationRoomAuthorizer({ secret: SECRET, mode: "required" }),
    });
  }

  it("keeps the backward-compatible local trust mode when no authorizer is configured", () => {
    const hub = new DirectorCollaborationWebSocketHub();
    expect(hub.authMode).toBe("local-trust");
    const client = socket();
    hub.handle(client, { type: "collab.join", room: "trusted-room", awareness_client_id: 7 });
    expect(messages(client)[0]).toMatchObject({ type: "collab.ready", room: "trusted-room", role: "editor" });
    expect(hub.peerCount("trusted-room")).toBe(1);
    hub.destroy();
  });

  it("rejects an unauthenticated join when invite auth is required", () => {
    const hub = inviteRequiredHub();
    expect(hub.authMode).toBe("invite-required");
    const intruder = socket();
    hub.handle(intruder, { type: "collab.join", room: "secure-room", awareness_client_id: 41 });
    expect(messages(intruder)).toEqual([
      {
        type: "collab.error",
        code: "unauthorized",
        room: "secure-room",
        message: "This gateway requires a collaboration invite token to join a room.",
      },
    ]);
    expect(hub.peerCount("secure-room")).toBe(0);
    expect(hub.roomCount).toBe(0);
    hub.destroy();
  });

  it("rejects forged, expired, and wrong-room invite tokens", () => {
    const hub = inviteRequiredHub();
    const forged = socket();
    hub.handle(forged, {
      type: "collab.join",
      room: "secure-room",
      awareness_client_id: 42,
      invite_token: mintCollaborationInviteToken({ secret: "wrong-secret", room: "secure-room", role: "editor" }).token,
    });
    expect(messages(forged).at(-1)).toMatchObject({ type: "collab.error", code: "unauthorized" });

    const wrongRoom = socket();
    hub.handle(wrongRoom, {
      type: "collab.join",
      room: "secure-room",
      awareness_client_id: 43,
      invite_token: mintCollaborationInviteToken({ secret: SECRET, room: "another-room", role: "editor" }).token,
    });
    expect(messages(wrongRoom).at(-1)).toMatchObject({ type: "collab.error", code: "unauthorized" });
    expect(hub.peerCount("secure-room")).toBe(0);
    hub.destroy();
  });

  it("rejects a revoked invite with the corrective denial message", async () => {
    const revocations = new CollaborationInviteRevocationRegistry();
    const hub = new DirectorCollaborationWebSocketHub({
      authorizer: createCollaborationRoomAuthorizer({ secret: SECRET, mode: "required", revocations }),
    });
    const invite = mintCollaborationInviteToken({ secret: SECRET, room: "secure-room", role: "editor" });
    await revocations.revokeToken(invite.token);
    const client = socket();
    hub.handle(client, {
      type: "collab.join",
      room: "secure-room",
      awareness_client_id: 44,
      invite_token: invite.token,
    });
    expect(messages(client).at(-1)).toMatchObject({
      type: "collab.error",
      code: "unauthorized",
      message: "The collaboration invite token has been revoked.",
    });
    expect(hub.peerCount("secure-room")).toBe(0);
    hub.destroy();
  });

  it("ejects only the live peers whose invite was revoked by token, mirroring the rejoin denial", async () => {
    const revocations = new CollaborationInviteRevocationRegistry();
    const hub = new DirectorCollaborationWebSocketHub({
      authorizer: createCollaborationRoomAuthorizer({ secret: SECRET, mode: "required", revocations }),
    });
    const revokedInvite = mintCollaborationInviteToken({ secret: SECRET, room: "secure-room", role: "editor" });
    const survivingInvite = mintCollaborationInviteToken({ secret: SECRET, room: "secure-room", role: "editor" });
    const revokedPeer = socket();
    const survivor = socket();
    hub.handle(revokedPeer, {
      type: "collab.join",
      room: "secure-room",
      awareness_client_id: 71,
      invite_token: revokedInvite.token,
    });
    hub.handle(survivor, {
      type: "collab.join",
      room: "secure-room",
      awareness_client_id: 72,
      invite_token: survivingInvite.token,
    });
    revokedPeer.sent.length = 0;

    await revocations.revokeToken(revokedInvite.token);
    expect(hub.enforceInviteRevocations(revocations)).toEqual({ disconnectedPeers: 1, rooms: ["secure-room"] });
    expect(messages(revokedPeer).at(-1)).toMatchObject({
      type: "collab.error",
      code: "unauthorized",
      room: "secure-room",
      message: "The collaboration invite token has been revoked.",
    });
    expect(hub.peerCount("secure-room")).toBe(1);

    // The ejected peer lost its membership and must present a fresh invite.
    const doc = new Y.Doc();
    doc.getMap("scene").set("late", true);
    hub.handle(revokedPeer, binaryMessage("collab.document-update", "secure-room", Y.encodeStateAsUpdate(doc)));
    expect(messages(revokedPeer).at(-1)).toMatchObject({ type: "collab.error", code: "join_required" });

    // Enforcement is idempotent and never touches the surviving invite's peer.
    expect(hub.enforceInviteRevocations(revocations)).toEqual({ disconnectedPeers: 0, rooms: [] });
    expect(hub.peerCount("secure-room")).toBe(1);
    doc.destroy();
    hub.destroy();
  });

  it("scope revocation ejects older-invite peers across matching rooms while fresh invites stay live", async () => {
    const clock = { value: 1_700_000_000_000 };
    const now = () => clock.value;
    const revocations = new CollaborationInviteRevocationRegistry({ now });
    const hub = new DirectorCollaborationWebSocketHub({
      authorizer: createCollaborationRoomAuthorizer({ secret: SECRET, mode: "required", revocations, now }),
      now,
    });
    const oldInvite = mintCollaborationInviteToken({ secret: SECRET, room: "project-a/*", role: "editor", now });
    const otherProjectInvite = mintCollaborationInviteToken({
      secret: SECRET,
      room: "project-b/scene-1",
      role: "editor",
      now,
    });
    const oldScene1 = socket();
    const oldScene2 = socket();
    const otherProject = socket();
    hub.handle(oldScene1, {
      type: "collab.join",
      room: "project-a/scene-1",
      awareness_client_id: 73,
      invite_token: oldInvite.token,
    });
    hub.handle(oldScene2, {
      type: "collab.join",
      room: "project-a/scene-2",
      awareness_client_id: 74,
      invite_token: oldInvite.token,
    });
    hub.handle(otherProject, {
      type: "collab.join",
      room: "project-b/scene-1",
      awareness_client_id: 75,
      invite_token: otherProjectInvite.token,
    });

    clock.value += 1_000;
    await revocations.revokeRoomScope("project-a/*");
    clock.value += 1_000;
    const freshInvite = mintCollaborationInviteToken({ secret: SECRET, room: "project-a/*", role: "editor", now });
    const freshPeer = socket();
    hub.handle(freshPeer, {
      type: "collab.join",
      room: "project-a/scene-1",
      awareness_client_id: 76,
      invite_token: freshInvite.token,
    });

    expect(hub.enforceInviteRevocations(revocations)).toEqual({
      disconnectedPeers: 2,
      rooms: ["project-a/scene-1", "project-a/scene-2"],
    });
    expect(hub.peerCount("project-a/scene-1")).toBe(1);
    expect(hub.peerCount("project-a/scene-2")).toBe(0);
    expect(hub.peerCount("project-b/scene-1")).toBe(1);
    hub.destroy();
  });

  it("never ejects local-trust memberships, which carry no invite subject", async () => {
    const revocations = new CollaborationInviteRevocationRegistry();
    const hub = new DirectorCollaborationWebSocketHub();
    const peer = socket();
    hub.handle(peer, { type: "collab.join", room: "trusted-room", awareness_client_id: 77 });
    await revocations.revokeRoomScope("trusted-room");
    expect(hub.enforceInviteRevocations(revocations)).toEqual({ disconnectedPeers: 0, rooms: [] });
    expect(hub.peerCount("trusted-room")).toBe(1);
    hub.destroy();
  });

  it("admits a valid invite, reports the granted role, and gates writes by capability", () => {
    const hub = inviteRequiredHub();
    const editor = socket();
    const viewer = socket();
    hub.handle(editor, {
      type: "collab.join",
      room: "secure-room",
      awareness_client_id: 51,
      invite_token: mintCollaborationInviteToken({ secret: SECRET, room: "secure-room", role: "editor" }).token,
    });
    hub.handle(viewer, {
      type: "collab.join",
      room: "secure-room",
      awareness_client_id: 52,
      invite_token: mintCollaborationInviteToken({ secret: SECRET, room: "secure-room", role: "viewer" }).token,
    });
    expect(messages(editor)[0]).toMatchObject({ type: "collab.ready", role: "editor" });
    expect(messages(viewer)[0]).toMatchObject({ type: "collab.ready", role: "viewer" });
    editor.sent.length = 0;
    viewer.sent.length = 0;

    // A viewer must not be able to mutate the shared document.
    const viewerDoc = new Y.Doc();
    viewerDoc.getMap("scene").set("hijacked", true);
    hub.handle(viewer, binaryMessage("collab.document-update", "secure-room", Y.encodeStateAsUpdate(viewerDoc)));
    expect(messages(viewer).at(-1)).toMatchObject({ type: "collab.error", code: "forbidden" });
    expect(messages(editor)).toHaveLength(0);

    // The editor writes and the viewer still receives the update.
    viewer.sent.length = 0;
    const editorDoc = new Y.Doc();
    editorDoc.getMap("scene").set("title", "Secured shot");
    hub.handle(editor, binaryMessage("collab.document-update", "secure-room", Y.encodeStateAsUpdate(editorDoc)));
    const routed = messages(viewer).at(-1) as Extract<
      DirectorCollaborationGatewayServerMessage,
      { type: "collab.document-update" }
    >;
    expect(routed.type).toBe("collab.document-update");
    const received = new Y.Doc();
    Y.applyUpdate(received, decodeDirectorCollaborationGatewayPayload(routed.payload)!);
    expect(received.getMap("scene").get("title")).toBe("Secured shot");

    viewerDoc.destroy();
    editorDoc.destroy();
    received.destroy();
    hub.destroy();
  });
});

describe("DirectorCollaborationWebSocketHub invite expiry enforcement", () => {
  const SECRET = "invite-expiry-hub-secret";

  function expiryHub(clock: { value: number }, timers: ReturnType<typeof fakeTimers>) {
    const now = () => clock.value;
    return new DirectorCollaborationWebSocketHub({
      authorizer: createCollaborationRoomAuthorizer({ secret: SECRET, mode: "required", now }),
      now,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
  }

  it("ejects a live peer the moment its invite expires, mirroring the rejoin denial", () => {
    const clock = { value: 1_700_000_000_000 };
    const timers = fakeTimers();
    const hub = expiryHub(clock, timers);
    const now = () => clock.value;
    const shortLived = socket();
    const survivor = socket();
    hub.handle(shortLived, {
      type: "collab.join",
      room: "timed-room",
      awareness_client_id: 111,
      invite_token: mintCollaborationInviteToken({
        secret: SECRET,
        room: "timed-room",
        role: "editor",
        ttlSeconds: 60,
        now,
      }).token,
    });
    hub.handle(survivor, {
      type: "collab.join",
      room: "timed-room",
      awareness_client_id: 112,
      invite_token: mintCollaborationInviteToken({
        secret: SECRET,
        room: "timed-room",
        role: "editor",
        ttlSeconds: 3_600,
        now,
      }).token,
    });
    shortLived.sent.length = 0;
    survivor.sent.length = 0;
    // One deadline timer covers the earliest live expiry.
    expect(timers.pending.size).toBe(1);

    clock.value += 60_001;
    timers.fire();
    expect(messages(shortLived).at(-1)).toMatchObject({
      type: "collab.error",
      code: "unauthorized",
      room: "timed-room",
      message: "The collaboration invite token has expired.",
    });
    expect(hub.peerCount("timed-room")).toBe(1);
    expect(messages(survivor)).toHaveLength(0);

    // The ejected peer lost its membership and must present a fresh invite.
    const doc = new Y.Doc();
    doc.getMap("scene").set("late", true);
    hub.handle(shortLived, binaryMessage("collab.document-update", "timed-room", Y.encodeStateAsUpdate(doc)));
    expect(messages(shortLived).at(-1)).toMatchObject({ type: "collab.error", code: "join_required" });

    // The timer re-arms for the surviving invite and clears when it leaves.
    expect(timers.pending.size).toBe(1);
    hub.disconnect(survivor);
    expect(timers.pending.size).toBe(0);
    doc.destroy();
    hub.destroy();
  });

  it("an early enforcement pass ejects nothing and stays armed for the real expiry", () => {
    const clock = { value: 1_700_000_000_000 };
    const timers = fakeTimers();
    const hub = expiryHub(clock, timers);
    const peer = socket();
    hub.handle(peer, {
      type: "collab.join",
      room: "timed-room",
      awareness_client_id: 113,
      invite_token: mintCollaborationInviteToken({
        secret: SECRET,
        room: "timed-room",
        role: "editor",
        ttlSeconds: 60,
        now: () => clock.value,
      }).token,
    });
    clock.value += 30_000;
    expect(hub.enforceInviteExpiries()).toEqual({ disconnectedPeers: 0, rooms: [] });
    expect(hub.peerCount("timed-room")).toBe(1);
    expect(timers.pending.size).toBe(1);
    clock.value += 30_001;
    expect(hub.enforceInviteExpiries()).toEqual({ disconnectedPeers: 1, rooms: ["timed-room"] });
    expect(hub.peerCount("timed-room")).toBe(0);
    hub.destroy();
  });

  it("a same-socket rejoin with a fresh invite extends the live session past the original expiry", () => {
    const clock = { value: 1_700_000_000_000 };
    const timers = fakeTimers();
    const hub = expiryHub(clock, timers);
    const now = () => clock.value;
    const peer = socket();
    hub.handle(peer, {
      type: "collab.join",
      room: "timed-room",
      awareness_client_id: 114,
      invite_token: mintCollaborationInviteToken({
        secret: SECRET,
        room: "timed-room",
        role: "editor",
        ttlSeconds: 60,
        now,
      }).token,
    });
    hub.handle(peer, {
      type: "collab.join",
      room: "timed-room",
      awareness_client_id: 114,
      invite_token: mintCollaborationInviteToken({
        secret: SECRET,
        room: "timed-room",
        role: "editor",
        ttlSeconds: 3_600,
        now,
      }).token,
    });
    peer.sent.length = 0;

    clock.value += 60_001;
    timers.fire();
    expect(messages(peer)).toHaveLength(0);
    expect(hub.peerCount("timed-room")).toBe(1);
    // The early fire re-armed for the refreshed invite's expiry.
    expect(timers.pending.size).toBe(1);
    hub.destroy();
  });

  it("never expires local-trust memberships and arms no timer for them", () => {
    const timers = fakeTimers();
    const hub = new DirectorCollaborationWebSocketHub({ setTimer: timers.setTimer, clearTimer: timers.clearTimer });
    const peer = socket();
    hub.handle(peer, { type: "collab.join", room: "trusted-room", awareness_client_id: 115 });
    expect(timers.pending.size).toBe(0);
    expect(hub.enforceInviteExpiries()).toEqual({ disconnectedPeers: 0, rooms: [] });
    expect(hub.peerCount("trusted-room")).toBe(1);
    hub.destroy();
  });

  it("chains expiries beyond the 32-bit timer cap without ejecting early", () => {
    const clock = { value: 1_700_000_000_000 };
    const timers = fakeTimers();
    const hub = expiryHub(clock, timers);
    const peer = socket();
    hub.handle(peer, {
      type: "collab.join",
      room: "timed-room",
      awareness_client_id: 116,
      invite_token: mintCollaborationInviteToken({
        secret: SECRET,
        room: "timed-room",
        role: "editor",
        ttlSeconds: 30 * 24 * 60 * 60,
        now: () => clock.value,
      }).token,
    });
    // The clamped timer fires before the real expiry, ejects nothing, and re-arms.
    timers.fire();
    expect(hub.peerCount("timed-room")).toBe(1);
    expect(timers.pending.size).toBe(1);
    hub.destroy();
  });
});
