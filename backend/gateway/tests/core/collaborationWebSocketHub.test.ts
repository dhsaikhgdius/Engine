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

    sourceAwareness.destroy();
    receiverAwareness.destroy();
    sourceDoc.destroy();
    receiverDoc.destroy();
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
