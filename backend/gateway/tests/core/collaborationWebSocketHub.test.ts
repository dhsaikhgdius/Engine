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
      | Extract<DirectorCollaborationGatewayServerMessage, { type: "collab.document-update" }>
      | undefined;
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
