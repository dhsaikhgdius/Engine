import { afterEach, describe, expect, it, vi } from "vitest";

const controlPlaneMocks = vi.hoisted(() => ({
  directorControlPlaneFetch: vi.fn(),
  resetDirectorControlPlaneCredentials: vi.fn(),
}));

vi.mock("../../../../src/comprehensive/editor/api/directorControlPlaneClient", () => controlPlaneMocks);

import { listAgentSessions } from "../../../../src/comprehensive/editor/assistant/agentSessionsClient";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => vi.clearAllMocks());

describe("agentSessionsClient", () => {
  it("returns validated live sessions and drops malformed entries", async () => {
    controlPlaneMocks.directorControlPlaneFetch.mockResolvedValue(
      jsonResponse(200, {
        sessions: [
          {
            id: "dsh-abc123",
            tool: "director_workbench",
            status: "active",
            last_active_at: "2026-08-25T10:19:00.000Z",
          },
          { id: "dsh-idle", tool: "director_workbench", status: "idle", last_active_at: "2026-08-25T09:00:00.000Z" },
          { id: "", tool: "director_workbench", status: "active", last_active_at: "2026-08-25T10:19:00.000Z" },
          {
            id: "dsh-bad-status",
            tool: "director_workbench",
            status: "??",
            last_active_at: "2026-08-25T10:19:00.000Z",
          },
        ],
      }),
    );

    await expect(listAgentSessions()).resolves.toEqual([
      { id: "dsh-abc123", tool: "director_workbench", status: "active", last_active_at: "2026-08-25T10:19:00.000Z" },
      { id: "dsh-idle", tool: "director_workbench", status: "idle", last_active_at: "2026-08-25T09:00:00.000Z" },
    ]);
    expect(controlPlaneMocks.directorControlPlaneFetch).toHaveBeenCalledWith("/api/agent/sessions");
  });

  it("returns an empty list for gateway failures and non-list bodies", async () => {
    controlPlaneMocks.directorControlPlaneFetch.mockResolvedValueOnce(jsonResponse(503, { error: "offline" }));
    await expect(listAgentSessions()).resolves.toEqual([]);

    controlPlaneMocks.directorControlPlaneFetch.mockResolvedValueOnce(jsonResponse(200, { sessions: "nope" }));
    await expect(listAgentSessions()).resolves.toEqual([]);
  });

  it("rotates credentials and retries exactly once on 401", async () => {
    controlPlaneMocks.directorControlPlaneFetch.mockResolvedValueOnce(jsonResponse(401, {})).mockResolvedValueOnce(
      jsonResponse(200, {
        sessions: [
          { id: "dsh-retry", tool: "director_workbench", status: "active", last_active_at: "2026-08-25T10:19:00.000Z" },
        ],
      }),
    );

    await expect(listAgentSessions()).resolves.toEqual([
      { id: "dsh-retry", tool: "director_workbench", status: "active", last_active_at: "2026-08-25T10:19:00.000Z" },
    ]);
    expect(controlPlaneMocks.resetDirectorControlPlaneCredentials).toHaveBeenCalledOnce();
    expect(controlPlaneMocks.directorControlPlaneFetch).toHaveBeenCalledTimes(2);

    controlPlaneMocks.directorControlPlaneFetch.mockResolvedValue(jsonResponse(401, {}));
    await expect(listAgentSessions()).resolves.toEqual([]);
  });
});
