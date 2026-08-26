// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { CollaborationInviteRevocationRegistry } from "../../collaboration/collaborationInviteRevocationRegistry";
import { CollaborationSnapshotStore } from "../../collaboration/collaborationSnapshotStore";
import { createCollaborationRoomAuthorizer } from "../../collaborationRoomAuth";
import { DirectorCollaborationWebSocketHub } from "../../collaborationWebSocketHub";
import {
  handleCollaborationRoomRoute,
  type CollaborationRoomRouteDependencies,
} from "../../routes/collaborationRoomRoutes";
import { encodeDirectorCollaborationGatewayPayload } from "../../../../packages/protocol/src/directorCollaborationGatewayProtocol";
import { WebSocket } from "ws";

type FakeSocket = WebSocket & { sent: string[] };
type FakeResponse = ServerResponse & { headers: Map<string, string> };

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempStore(options: { compactAfterUpdates?: number } = {}) {
  const directory = mkdtempSync(resolve(tmpdir(), "director-collab-room-routes-"));
  directories.push(directory);
  return { directory, store: new CollaborationSnapshotStore(directory, options) };
}

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

function request(method: string) {
  return { method } as IncomingMessage;
}

function response(): FakeResponse {
  const headers = new Map<string, string>();
  return {
    headers,
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), String(value));
    },
    getHeader(name: string) {
      return headers.get(name.toLowerCase());
    },
    end: vi.fn(),
  } as unknown as FakeResponse;
}

function docUpdate(mutate: (doc: Y.Doc) => void) {
  const doc = new Y.Doc();
  const before = Y.encodeStateVector(doc);
  mutate(doc);
  const update = Y.encodeStateAsUpdate(doc, before);
  doc.destroy();
  return update;
}

function dependencies(overrides: Partial<CollaborationRoomRouteDependencies> = {}) {
  const json = vi.fn();
  const deps: CollaborationRoomRouteDependencies = {
    readBody: vi.fn().mockResolvedValue({}),
    json,
    hub: new DirectorCollaborationWebSocketHub(),
    authorizer: createCollaborationRoomAuthorizer({ secret: "room-routes-secret", mode: "" }),
    snapshotStore: null,
    revocations: new CollaborationInviteRevocationRegistry(),
    emptyRoomTtlSeconds: 0,
    ...overrides,
  };
  return { deps, json };
}

function lastJsonCall(json: ReturnType<typeof vi.fn>) {
  const call = json.mock.calls.at(-1)!;
  return { status: call[1] as number, body: call[2] as Record<string, unknown> };
}

describe("handleCollaborationRoomRoute /api/collab/rooms", () => {
  it("merges live hub rooms with durable snapshot status and never leaks filesystem paths", async () => {
    const { directory, store } = tempStore({ compactAfterUpdates: 1 });
    const hub = new DirectorCollaborationWebSocketHub({ persistence: store });
    await store.appendUpdate("ops/idle-room", docUpdate((doc) => doc.getMap("scene").set("title", "idle")));
    const peer = socket();
    hub.handle(peer, { type: "collab.join", room: "ops/live-room", awareness_client_id: 21 });

    const { deps, json } = dependencies({ hub, snapshotStore: store, emptyRoomTtlSeconds: 120 });
    const res = response();
    const handled = await handleCollaborationRoomRoute(
      request("GET"),
      res,
      new URL("http://gateway.local/api/collab/rooms"),
      deps,
    );
    expect(handled).toBe(true);

    const { status, body } = lastJsonCall(json);
    expect(status).toBe(200);
    expect(body).toMatchObject({ mode: "local-trust", persistence: true, empty_room_ttl_seconds: 120 });
    expect(body.invite_revocations).toEqual({ revoked_tokens: 0, room_cutoffs: 0 });
    const rooms = body.rooms as Array<Record<string, unknown>>;
    expect(rooms.map((room) => room.room)).toEqual(["ops/idle-room", "ops/live-room"]);
    expect(rooms[0]).toMatchObject({ active: false, peers: 0, pending_updates: 0 });
    expect(rooms[0]!.snapshot_bytes as number).toBeGreaterThan(0);
    expect(typeof rooms[0]!.snapshot_age_seconds).toBe("number");
    expect(rooms[1]).toMatchObject({ active: true, peers: 1, editors: 1, viewers: 0, snapshot_bytes: 0 });

    // Redaction: counts, hashes, and timestamps only — no server paths.
    expect(JSON.stringify(body)).not.toContain(directory);
    expect(JSON.stringify(body)).not.toContain(tmpdir());

    // Hardening headers ride on every collaboration ops response.
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
    hub.destroy();
  });

  it("filters by a validated room id and rejects invalid ids", async () => {
    const { store } = tempStore({ compactAfterUpdates: 1 });
    await store.appendUpdate("ops/idle-room", docUpdate((doc) => doc.getMap("scene").set("title", "idle")));
    const { deps, json } = dependencies({ snapshotStore: store });

    await handleCollaborationRoomRoute(
      request("GET"),
      response(),
      new URL("http://gateway.local/api/collab/rooms?room=ops/idle-room"),
      deps,
    );
    const filtered = lastJsonCall(json);
    expect((filtered.body.rooms as unknown[]).length).toBe(1);

    await handleCollaborationRoomRoute(
      request("GET"),
      response(),
      new URL(`http://gateway.local/api/collab/rooms?room=${encodeURIComponent("bad room?!")}`),
      deps,
    );
    expect(lastJsonCall(json)).toMatchObject({ status: 400, body: { code: "invalid_room" } });
  });
});

describe("handleCollaborationRoomRoute /api/collab/rooms/quarantine", () => {
  it("returns the bounded quarantine index for one room", async () => {
    const { store } = tempStore();
    await store.appendUpdate("quarantined-room", new Uint8Array([9, 9, 9, 200, 201]));
    const { deps, json } = dependencies({ snapshotStore: store });

    await handleCollaborationRoomRoute(
      request("GET"),
      response(),
      new URL("http://gateway.local/api/collab/rooms/quarantine?room=quarantined-room"),
      deps,
    );
    const { status, body } = lastJsonCall(json);
    expect(status).toBe(200);
    expect(body.room).toBe("quarantined-room");
    const records = body.records as Array<Record<string, unknown>>;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ byte_length: 5 });
    expect(records[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(records[0]!.quarantined_at).toMatch(/^\d{4}-/);
  });

  it("reports a structured conflict when persistence is disabled", async () => {
    const { deps, json } = dependencies({ snapshotStore: null });
    await handleCollaborationRoomRoute(
      request("GET"),
      response(),
      new URL("http://gateway.local/api/collab/rooms/quarantine?room=any-room"),
      deps,
    );
    expect(lastJsonCall(json)).toMatchObject({ status: 409, body: { code: "collab_persistence_disabled" } });
  });
});

describe("handleCollaborationRoomRoute /api/collab/rooms/close", () => {
  it("closes a live room and archives its durable history on request", async () => {
    const { store } = tempStore({ compactAfterUpdates: 1 });
    const hub = new DirectorCollaborationWebSocketHub({ persistence: store });
    await store.appendUpdate("wrap/room", docUpdate((doc) => doc.getMap("scene").set("title", "final cut")));
    const peer = socket();
    hub.handle(peer, { type: "collab.join", room: "wrap/room", awareness_client_id: 31 });

    const { deps, json } = dependencies({
      hub,
      snapshotStore: store,
      readBody: vi.fn().mockResolvedValue({ room: "wrap/room", archive: true }),
    });
    await handleCollaborationRoomRoute(
      request("POST"),
      response(),
      new URL("http://gateway.local/api/collab/rooms/close"),
      deps,
    );
    const { status, body } = lastJsonCall(json);
    expect(status).toBe(200);
    expect(body).toEqual({ room: "wrap/room", closed: true, disconnected_peers: 1, archived: true });
    expect(hub.peerCount("wrap/room")).toBe(0);
    expect(await store.loadSnapshot("wrap/room")).toBeNull();
    const closedNotice = peer.sent.map((value) => JSON.parse(value) as { type: string; code?: string }).at(-1);
    expect(closedNotice).toMatchObject({ type: "collab.error", code: "room_closed" });
    hub.destroy();
  });

  it("rejects archive requests when persistence is disabled and validates the body", async () => {
    const { deps, json } = dependencies({
      readBody: vi.fn().mockResolvedValue({ room: "any-room", archive: true }),
    });
    await handleCollaborationRoomRoute(
      request("POST"),
      response(),
      new URL("http://gateway.local/api/collab/rooms/close"),
      deps,
    );
    expect(lastJsonCall(json)).toMatchObject({ status: 409, body: { code: "collab_persistence_disabled" } });

    const invalid = dependencies({ readBody: vi.fn().mockResolvedValue({ room: "bad room?!" }) });
    await handleCollaborationRoomRoute(
      request("POST"),
      response(),
      new URL("http://gateway.local/api/collab/rooms/close"),
      invalid.deps,
    );
    expect(lastJsonCall(invalid.json)).toMatchObject({ status: 400, body: { code: "invalid_request" } });
  });

  it("reports closed: false for a room that is not live, without persistence side effects", async () => {
    const { deps, json } = dependencies({ readBody: vi.fn().mockResolvedValue({ room: "ghost-room" }) });
    await handleCollaborationRoomRoute(
      request("POST"),
      response(),
      new URL("http://gateway.local/api/collab/rooms/close"),
      deps,
    );
    expect(lastJsonCall(json)).toMatchObject({
      status: 200,
      body: { closed: false, disconnected_peers: 0, archived: null },
    });
  });
});
