import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(),
}));

vi.mock("../../../../src/comprehensive/editor/api/directorControlPlaneClient", () => ({
  directorControlPlaneFetch: mocks.fetch,
}));

import { CollaborationRoomsSection } from "../../../../src/comprehensive/app/tasks/CollaborationRoomsSection";
import {
  fetchCollaborationRoomQuarantine,
  fetchCollaborationRooms,
} from "../../../../src/comprehensive/app/tasks/collaborationRoomsClient";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function roomRow(overrides: Record<string, unknown> = {}) {
  return {
    room: "ops/live-room",
    active: true,
    peers: 3,
    editors: 2,
    viewers: 1,
    retained: false,
    created_at: "2026-08-27T03:00:00.000Z",
    last_activity_at: new Date().toISOString(),
    snapshot_bytes: 0,
    snapshot_updated_at: null,
    snapshot_age_seconds: null,
    pending_updates: 0,
    quarantined_updates: 0,
    last_compacted_at: null,
    ...overrides,
  };
}

function roomsBody(overrides: Record<string, unknown> = {}) {
  return {
    mode: "invite-required",
    persistence: true,
    empty_room_ttl_seconds: 120,
    invite_rate_limit_per_minute: 30,
    invite_revocations: { revoked_tokens: 2, room_cutoffs: 1, durable: true },
    rooms: [
      roomRow(),
      roomRow({
        room: "ops/idle-room",
        active: false,
        peers: 0,
        editors: 0,
        viewers: 0,
        created_at: null,
        last_activity_at: null,
        snapshot_bytes: 2048,
        snapshot_updated_at: new Date().toISOString(),
        snapshot_age_seconds: 30,
        pending_updates: 2,
        quarantined_updates: 1,
        last_compacted_at: "2026-08-27T02:00:00.000Z",
      }),
    ],
    ...overrides,
  };
}

function quarantineBody() {
  return {
    room: "ops/idle-room",
    records: [
      {
        id: "20260827T030000-abcdef",
        sha256: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
        byte_length: 512,
        reason: "empty update payload",
        quarantined_at: new Date().toISOString(),
      },
    ],
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("collaborationRoomsClient", () => {
  it("fetches and validates the rooms report", async () => {
    mocks.fetch.mockResolvedValueOnce(jsonResponse(200, roomsBody()));
    const report = await fetchCollaborationRooms();
    expect(mocks.fetch).toHaveBeenCalledWith("/api/collab/rooms", { signal: undefined });
    expect(report.mode).toBe("invite-required");
    expect(report.persistence).toBe(true);
    expect(report.invite_revocations).toEqual({ revoked_tokens: 2, room_cutoffs: 1, durable: true });
    expect(report.rooms).toHaveLength(2);
    expect(report.rooms[1]).toMatchObject({
      room: "ops/idle-room",
      active: false,
      snapshot_bytes: 2048,
      pending_updates: 2,
      quarantined_updates: 1,
    });
  });

  it("rejects malformed rooms reports at the boundary", async () => {
    mocks.fetch.mockResolvedValueOnce(
      jsonResponse(200, roomsBody({ invite_revocations: { revoked_tokens: -1, room_cutoffs: 0, durable: true } })),
    );
    await expect(fetchCollaborationRooms()).rejects.toThrow();

    mocks.fetch.mockResolvedValueOnce(jsonResponse(200, roomsBody({ rooms: [{ room: "x" }] })));
    await expect(fetchCollaborationRooms()).rejects.toThrow();
  });

  it("surfaces gateway refusal text from the error field", async () => {
    mocks.fetch.mockResolvedValueOnce(
      jsonResponse(409, { error: "协作持久化未启用，无隔离区可查询", code: "collab_persistence_disabled" }),
    );
    await expect(fetchCollaborationRoomQuarantine("ops/idle-room")).rejects.toThrow(
      "协作持久化未启用，无隔离区可查询",
    );
  });

  it("fetches and validates the quarantine index with an encoded room id", async () => {
    mocks.fetch.mockResolvedValueOnce(jsonResponse(200, quarantineBody()));
    const report = await fetchCollaborationRoomQuarantine("ops/idle-room");
    expect(mocks.fetch).toHaveBeenCalledWith("/api/collab/rooms/quarantine?room=ops%2Fidle-room", {
      signal: undefined,
    });
    expect(report.room).toBe("ops/idle-room");
    expect(report.records[0]).toMatchObject({ byte_length: 512, reason: "empty update payload" });
  });
});

describe("CollaborationRoomsSection", () => {
  it("renders policy, revocation durability counts, and merged room rows read-only", async () => {
    mocks.fetch.mockImplementation(async (path) => {
      if (path === "/api/collab/rooms") return jsonResponse(200, roomsBody());
      throw new Error(`Unexpected path ${path}`);
    });
    render(<CollaborationRoomsSection />);

    expect(await screen.findByText("需邀请 · 持久化已启用")).toBeTruthy();
    expect(screen.getByText("已吊销邀请")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("房间级吊销截止")).toBeTruthy();
    expect(screen.getByText("已持久化")).toBeTruthy();

    // Live room: member breakdown mirrors the API counts.
    expect(screen.getByText("ops/live-room")).toBeTruthy();
    expect(screen.getByText("活跃")).toBeTruthy();
    expect(screen.getByText(/在线 3（编辑 2 · 只读 1）/)).toBeTruthy();

    // Durable-history-only room: snapshot size, pending, and quarantine counts.
    expect(screen.getByText("ops/idle-room")).toBeTruthy();
    expect(screen.getByText("仅持久化")).toBeTruthy();
    expect(screen.getByText(/快照 2\.0 KB · .+ · 待压缩 2 · 隔离 1/)).toBeTruthy();

    // Read-only: the section never issues a mutation.
    for (const [, init] of mocks.fetch.mock.calls) {
      expect(init?.method ?? "GET").toBe("GET");
    }
  });

  it("marks non-durable revocations with live counts as at risk", async () => {
    mocks.fetch.mockImplementation(async () =>
      jsonResponse(200, roomsBody({ invite_revocations: { revoked_tokens: 1, room_cutoffs: 0, durable: false } })),
    );
    render(<CollaborationRoomsSection />);
    const durability = await screen.findByText("仅进程内（重启即失效）");
    expect(durability.className).toContain("is-error");
  });

  it("does not flag durability when nothing has been revoked", async () => {
    mocks.fetch.mockImplementation(async () =>
      jsonResponse(200, roomsBody({ invite_revocations: { revoked_tokens: 0, room_cutoffs: 0, durable: false } })),
    );
    render(<CollaborationRoomsSection />);
    const durability = await screen.findByText("仅进程内（重启即失效）");
    expect(durability.className).not.toContain("is-error");
  });

  it("peeks and hides the quarantine index for one room", async () => {
    const user = userEvent.setup();
    mocks.fetch.mockImplementation(async (path) => {
      if (path === "/api/collab/rooms") return jsonResponse(200, roomsBody());
      if (path.startsWith("/api/collab/rooms/quarantine")) {
        expect(path).toBe("/api/collab/rooms/quarantine?room=ops%2Fidle-room");
        return jsonResponse(200, quarantineBody());
      }
      throw new Error(`Unexpected path ${path}`);
    });
    render(<CollaborationRoomsSection />);

    await user.click(await screen.findByRole("button", { name: "查看隔离区" }));
    const record = await screen.findByText(/a1b2c3d4e5f6 · 512 B/);
    expect(record.getAttribute("title")).toBe("empty update payload");

    await user.click(screen.getByRole("button", { name: "收起隔离区" }));
    expect(screen.queryByText(/a1b2c3d4e5f6/)).toBeNull();
  });

  it("hides the quarantine peek when persistence is off", async () => {
    mocks.fetch.mockImplementation(async () =>
      jsonResponse(
        200,
        roomsBody({
          persistence: false,
          rooms: [roomRow({ room: "ops/idle-room", quarantined_updates: 1 })],
        }),
      ),
    );
    render(<CollaborationRoomsSection />);
    await screen.findByText("ops/idle-room");
    expect(screen.queryByRole("button", { name: "查看隔离区" })).toBeNull();
  });

  it("shows the empty state when no rooms are live or persisted", async () => {
    mocks.fetch.mockImplementation(async () => jsonResponse(200, roomsBody({ rooms: [] })));
    render(<CollaborationRoomsSection />);
    expect(await screen.findByText("暂无活跃或持久化的协作房间")).toBeTruthy();
  });

  it("shows gateway refusals inline and recovers on refresh", async () => {
    const user = userEvent.setup();
    let calls = 0;
    mocks.fetch.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return jsonResponse(500, { error: "协作房间状态读取失败", code: "rooms_failed" });
      return jsonResponse(200, roomsBody());
    });
    render(<CollaborationRoomsSection />);
    expect(await screen.findByText("协作房间状态读取失败")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "刷新" }));
    expect(await screen.findByText("需邀请 · 持久化已启用")).toBeTruthy();
    expect(screen.queryByText("协作房间状态读取失败")).toBeNull();
  });
});
