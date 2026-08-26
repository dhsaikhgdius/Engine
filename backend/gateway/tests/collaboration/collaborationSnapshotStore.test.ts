// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { CollaborationSnapshotStore, validateYjsUpdate } from "../../collaboration/collaborationSnapshotStore";
import { DirectorCollaborationWebSocketHub } from "../../collaborationWebSocketHub";
import { encodeDirectorCollaborationGatewayPayload } from "../../../../packages/protocol/src/directorCollaborationGatewayProtocol";
import { WebSocket } from "ws";

const directories: string[] = [];

function tempStore(options: { compactAfterUpdates?: number; maxQuarantinedUpdates?: number } = {}) {
  const directory = mkdtempSync(resolve(tmpdir(), "director-collab-snapshots-"));
  directories.push(directory);
  return { directory, store: new CollaborationSnapshotStore(directory, options) };
}

function docUpdate(mutate: (doc: Y.Doc) => void, base?: Uint8Array) {
  const doc = new Y.Doc();
  if (base) Y.applyUpdate(doc, base);
  const before = Y.encodeStateVector(doc);
  mutate(doc);
  const update = Y.encodeStateAsUpdate(doc, before);
  doc.destroy();
  return update;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("validateYjsUpdate", () => {
  it("accepts a real Yjs update and rejects garbage bytes", () => {
    const update = docUpdate((doc) => doc.getMap("scene").set("title", "shot"));
    expect(validateYjsUpdate(update)).toEqual({ ok: true });
    expect(validateYjsUpdate(new Uint8Array([255, 254, 253, 7, 9]))).toMatchObject({ ok: false });
    expect(validateYjsUpdate(new Uint8Array())).toMatchObject({ ok: false, reason: "empty update payload" });
  });
});

describe("CollaborationSnapshotStore", () => {
  it("appends valid updates and reloads the merged room state across store instances", async () => {
    const { directory, store } = tempStore();
    const first = docUpdate((doc) => doc.getMap("scene").set("title", "Durable shot"));
    const second = docUpdate((doc) => doc.getMap("scene").set("lens", "50mm"), first);
    expect(await store.appendUpdate("room-a", first)).toMatchObject({ accepted: true, pendingUpdates: 1 });
    expect(await store.appendUpdate("room-a", second)).toMatchObject({ accepted: true, pendingUpdates: 2 });

    // A fresh store instance simulates a gateway restart.
    const reopened = new CollaborationSnapshotStore(directory);
    const snapshot = await reopened.loadSnapshot("room-a");
    expect(snapshot).not.toBeNull();
    const doc = new Y.Doc();
    Y.applyUpdate(doc, snapshot!);
    expect(doc.getMap("scene").get("title")).toBe("Durable shot");
    expect(doc.getMap("scene").get("lens")).toBe("50mm");
    doc.destroy();
  });

  it("compacts pending updates into one canonical snapshot at the threshold", async () => {
    const { store } = tempStore({ compactAfterUpdates: 3 });
    let base: Uint8Array | undefined;
    const results = [];
    for (let index = 0; index < 3; index += 1) {
      const update = docUpdate((doc) => doc.getMap("scene").set(`key-${index}`, index), base);
      base = base ? Y.mergeUpdates([base, update]) : update;
      results.push(await store.appendUpdate("room-b", update));
    }
    expect(results[0]).toMatchObject({ accepted: true, compacted: false });
    expect(results[1]).toMatchObject({ accepted: true, compacted: false });
    expect(results[2]).toMatchObject({ accepted: true, compacted: true, pendingUpdates: 0 });

    const status = await store.status("room-b");
    expect(status.pendingUpdates).toBe(0);
    expect(status.snapshotBytes).toBeGreaterThan(0);
    expect(status.lastCompactedAt).not.toBeNull();

    const snapshot = await store.loadSnapshot("room-b");
    const doc = new Y.Doc();
    Y.applyUpdate(doc, snapshot!);
    expect(doc.getMap("scene").get("key-0")).toBe(0);
    expect(doc.getMap("scene").get("key-2")).toBe(2);
    doc.destroy();
  });

  it("supports explicit compaction and keeps subsequent updates applied on top", async () => {
    const { store } = tempStore({ compactAfterUpdates: 1_000 });
    const first = docUpdate((doc) => doc.getMap("scene").set("title", "v1"));
    await store.appendUpdate("room-c", first);
    const compaction = await store.compact("room-c");
    expect(compaction.mergedUpdates).toBe(1);
    expect(compaction.snapshotBytes).toBeGreaterThan(0);

    const second = docUpdate((doc) => doc.getMap("scene").set("title", "v2"), first);
    await store.appendUpdate("room-c", second);
    const snapshot = await store.loadSnapshot("room-c");
    const doc = new Y.Doc();
    Y.applyUpdate(doc, snapshot!);
    expect(doc.getMap("scene").get("title")).toBe("v2");
    doc.destroy();
  });

  it("quarantines corrupt updates with hashes instead of poisoning the snapshot chain", async () => {
    const { store } = tempStore();
    const valid = docUpdate((doc) => doc.getMap("scene").set("title", "clean"));
    await store.appendUpdate("room-d", valid);

    const corrupt = new Uint8Array([9, 9, 9, 200, 201, 202]);
    const result = await store.appendUpdate("room-d", corrupt);
    expect(result.accepted).toBe(false);
    if (result.accepted) throw new Error("expected quarantine");
    expect(result.quarantine).toMatchObject({ room: "room-d", byteLength: corrupt.byteLength });
    expect(result.quarantine.sha256).toMatch(/^[0-9a-f]{64}$/);

    const quarantined = await store.listQuarantined("room-d");
    expect(quarantined).toHaveLength(1);
    expect((await store.status("room-d")).quarantinedUpdates).toBe(1);

    // The corrupt update never reached the snapshot chain.
    const snapshot = await store.loadSnapshot("room-d");
    const doc = new Y.Doc();
    Y.applyUpdate(doc, snapshot!);
    expect(doc.getMap("scene").get("title")).toBe("clean");
    doc.destroy();
  });

  it("bounds the quarantine index to the configured maximum", async () => {
    const { store } = tempStore({ maxQuarantinedUpdates: 2 });
    for (let index = 0; index < 4; index += 1) {
      await store.appendUpdate("room-e", new Uint8Array([250, 251, 252, index]));
    }
    const quarantined = await store.listQuarantined("room-e");
    expect(quarantined).toHaveLength(2);
  });

  it("lists every persisted room with snapshot age metadata", async () => {
    const { store } = tempStore({ compactAfterUpdates: 1 });
    await store.appendUpdate(
      "rooms/alpha",
      docUpdate((doc) => doc.getMap("scene").set("a", 1)),
    );
    await store.appendUpdate(
      "rooms/beta",
      docUpdate((doc) => doc.getMap("scene").set("b", 2)),
    );

    const rooms = await store.listRooms();
    expect(rooms.map((status) => status.room)).toEqual(["rooms/alpha", "rooms/beta"]);
    for (const status of rooms) {
      expect(status.snapshotBytes).toBeGreaterThan(0);
      expect(status.snapshotUpdatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(status.pendingUpdates).toBe(0);
      expect(status.lastCompactedAt).not.toBeNull();
    }
  });

  it("archives a room's durable history so later joins start from an empty document", async () => {
    const { directory, store } = tempStore({ compactAfterUpdates: 1 });
    await store.appendUpdate(
      "archive-me",
      docUpdate((doc) => doc.getMap("scene").set("title", "old cut")),
    );
    expect(await store.loadSnapshot("archive-me")).not.toBeNull();

    const outcome = await store.archiveRoom("archive-me");
    expect(outcome.archived).toBe(true);
    expect(outcome.archivedAs).toBeTruthy();
    expect(await store.loadSnapshot("archive-me")).toBeNull();
    expect(await store.listRooms()).toEqual([]);
    // The archived bytes were moved aside, not deleted.
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(resolve(directory, "collaboration-rooms-archive"))).toHaveLength(1);

    // Archiving a room that has no durable history reports a non-archival.
    expect(await store.archiveRoom("never-existed")).toEqual({ archived: false, archivedAs: null });
  });
});

describe("hub persistence wiring", () => {
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

  it("persists routed document updates and seeds new rooms from the durable snapshot", async () => {
    const { store } = tempStore();
    const hub = new DirectorCollaborationWebSocketHub({ persistence: store });
    const writer = socket();
    hub.handle(writer, { type: "collab.join", room: "durable-room", awareness_client_id: 61 });
    const update = docUpdate((doc) => doc.getMap("scene").set("title", "Persisted shot"));
    hub.handle(writer, {
      type: "collab.document-update",
      room: "durable-room",
      payload: encodeDirectorCollaborationGatewayPayload(update)!,
    });
    hub.destroy();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    const persisted = await store.loadSnapshot("durable-room");
    expect(persisted).not.toBeNull();

    // A second hub (gateway restart) recovers the room from the snapshot store.
    const restartedHub = new DirectorCollaborationWebSocketHub({ persistence: store });
    const reader = socket();
    restartedHub.handle(reader, { type: "collab.join", room: "durable-room", awareness_client_id: 62 });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    const seeded = reader.sent
      .map((value) => JSON.parse(value) as { type: string; payload?: string })
      .filter((message) => message.type === "collab.document-update")
      .at(-1);
    expect(seeded?.payload).toBeTruthy();
    restartedHub.destroy();
  });

  it("quarantines a corrupt inbound update through the hub", async () => {
    const { store } = tempStore();
    const hub = new DirectorCollaborationWebSocketHub({ persistence: store });
    const writer = socket();
    hub.handle(writer, { type: "collab.join", room: "quarantine-room", awareness_client_id: 71 });
    hub.handle(writer, {
      type: "collab.document-update",
      room: "quarantine-room",
      payload: encodeDirectorCollaborationGatewayPayload(new Uint8Array([200, 100, 42, 13, 99]))!,
    });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    expect(await store.listQuarantined("quarantine-room")).toHaveLength(1);
    hub.destroy();
  });
});
