import { afterEach, describe, expect, it, vi } from "vitest";
import {
  approveDirectorAssistantCommand,
  bootstrapDirectorAgent,
  clearDirectorAgentClient,
  directorAgentFetch,
  getDirectorAgentBasePath,
  getDirectorAgentHealth,
  getDirectorAgentTabId,
  getDirectorPageEvents,
  publishDirectorAgentPresence,
  sendDirectorAssistantMessage,
} from "../../../../src/comprehensive/editor/assistant/agentGatewayClient";

afterEach(() => {
  clearDirectorAgentClient();
  vi.unstubAllGlobals();
});

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function bootstrapResponse() {
  return {
    browserToken: "browser-secret",
    service: "comfyui-3d-director-agent-gateway",
    health: {
      gateway: { status: "ready", epoch: "gateway-epoch-0001" },
      codex: { status: "ready", executableAvailable: true, loggedIn: true },
      comfyui: { status: "connected" },
      queue: { active: 0, queued: 0 },
    },
  };
}

describe("agentGatewayClient", () => {
  it("surfaces a safe, specific Codex failure code instead of a generic error", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(bootstrapResponse()))
      .mockResolvedValueOnce(
        response(
          {
            error: "codex_timeout",
            message: "Director command failed",
          },
          504,
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await bootstrapDirectorAgent();
    await expect(
      sendDirectorAssistantMessage({
        sceneId: "shot-a",
        expectedRevision: 7,
        message: "新增角色",
      }),
    ).rejects.toMatchObject({
      code: "codex_timeout",
      message: "Codex 规划超时（codex_timeout，HTTP 504）",
      status: 504,
    });
  });

  it("keeps the browser pairing token in memory and sends the canonical chat schema", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(bootstrapResponse()))
      .mockResolvedValueOnce(
        response({
          requestId: "request-12345678",
          sceneId: "shot-a",
          startingRevision: 7,
          endingRevision: 8,
          summary: "完成",
          status: "completed",
          commands: [
            {
              index: 0,
              tool: "director_add_character",
              status: "success",
              revision: 8,
            },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const health = await bootstrapDirectorAgent();
    const result = await sendDirectorAssistantMessage({
      sceneId: "shot-a",
      expectedRevision: 7,
      message: "新增角色",
    });

    expect(health).toMatchObject({
      gateway: "connected",
      mcp: "connected",
      codex: "ready",
      epoch: "gateway-epoch-0001",
    });
    expect(fetchMock.mock.calls[0][0]).toBe("/te-man/director/agent/bootstrap");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST", body: "{}" });
    expect(fetchMock.mock.calls[1][0]).toBe("/te-man/director/agent/chat");
    const init = fetchMock.mock.calls[1][1] as RequestInit;
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
      "X-Director-Browser-Token": "browser-secret",
    });
    expect(JSON.parse(String(init.body))).toMatchObject({
      sceneId: "shot-a",
      expectedRevision: 7,
      message: "新增角色",
      tabId: expect.stringMatching(/^tab-.{8,}$/),
    });
    expect(JSON.parse(String(init.body))).not.toHaveProperty("messages");
    expect(result).toMatchObject({ revision: 8, status: "completed" });
    expect(result.commands[0]).toMatchObject({ name: "director_add_character", ok: true, revision: 8 });
  });

  it("resumes the exact pending plan after a one-time confirmation without replanning", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(bootstrapResponse()))
      .mockResolvedValueOnce(
        response(
          {
            requestId: "request-abcdefgh",
            sceneId: "shot-a",
            startingRevision: 8,
            endingRevision: 8,
            summary: "需要确认",
            status: "confirmation_required",
            commands: [
              {
                index: 0,
                tool: "director_delete_object",
                status: "confirmation_required",
                revision: 8,
                error: {
                  code: "confirmation_required",
                  message: "confirmation required",
                  requiredConfirmation: {
                    error: "confirmation_required",
                    requiredConfirmation: {
                      sceneId: "shot-a",
                      revision: 8,
                      action: "delete_entity",
                      objectIds: ["char-a"],
                    },
                  },
                },
              },
            ],
            pendingPlan: {
              id: "pending-plan-id-with-more-than-32-characters",
              expiresAt: "2026-07-18T12:00:00.000Z",
              nextCommandIndex: 0,
              tool: "director_delete_object",
            },
          },
          403,
        ),
      )
      .mockResolvedValueOnce(response({ confirmationToken: "one-time-confirmation-token" }, 201))
      .mockResolvedValueOnce(
        response({
          requestId: "request-resume-1234",
          sceneId: "shot-a",
          startingRevision: 8,
          endingRevision: 9,
          summary: "已删除",
          status: "completed",
          commands: [
            {
              index: 0,
              tool: "director_delete_object",
              status: "success",
              revision: 9,
            },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await bootstrapDirectorAgent();
    const planned = await sendDirectorAssistantMessage({
      sceneId: "shot-a",
      expectedRevision: 8,
      message: "删除角色 char-a",
    });
    expect(planned.confirmation).toMatchObject({
      pendingPlanId: "pending-plan-id-with-more-than-32-characters",
      action: "delete_entity",
      objectIds: ["char-a"],
    });

    const executed = await approveDirectorAssistantCommand({ confirmation: planned.confirmation! });
    const confirmationBody = JSON.parse(String((fetchMock.mock.calls[2][1] as RequestInit).body));
    expect(confirmationBody).toEqual({
      sceneId: "shot-a",
      expectedRevision: 8,
      action: "delete_entity",
      objectIds: ["char-a"],
    });
    const executeBody = JSON.parse(String((fetchMock.mock.calls[3][1] as RequestInit).body));
    expect(executeBody).toMatchObject({
      pendingPlanId: "pending-plan-id-with-more-than-32-characters",
      sceneId: "shot-a",
      expectedRevision: 8,
      confirmationToken: "one-time-confirmation-token",
    });
    expect(executeBody).not.toHaveProperty("command");
    expect(executed).toMatchObject({ revision: 9, status: "completed" });
  });

  it("derives an API prefix from a formal ComfyUI base path", () => {
    expect(getDirectorAgentBasePath("/studio/extensions/plugin/director/index.html")).toBe(
      "/studio/te-man/director/agent",
    );
    expect(getDirectorAgentBasePath("/extensions/plugin/director/index.html")).toBe("/te-man/director/agent");
  });

  it("binds presence and transient event polling to one stable tab id", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(bootstrapResponse()))
      .mockResolvedValueOnce(response(null))
      .mockResolvedValueOnce(response({ epoch: "gateway-epoch-0001", events: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await bootstrapDirectorAgent();
    await publishDirectorAgentPresence({ sceneId: "shot-a", revision: 5, visible: true });
    const result = await getDirectorPageEvents({
      sceneId: "shot-a",
      after: 9,
      epoch: "gateway-epoch-old",
    });

    const presenceBody = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    const eventsUrl = String(fetchMock.mock.calls[2][0]);
    expect(presenceBody).toMatchObject({ sceneId: "shot-a", revision: 5, visible: true });
    expect(eventsUrl).toContain(`tabId=${encodeURIComponent(presenceBody.tabId)}`);
    expect(eventsUrl).toContain("sceneId=shot-a");
    expect(eventsUrl).toContain("after=9");
    expect(eventsUrl).toContain("epoch=gateway-epoch-old");
    expect(result).toEqual({ epoch: "gateway-epoch-0001", events: [] });
  });

  it("rejects a bootstrap that does not prove the expected gateway identity", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ browserToken: "x", service: "other" })));
    await expect(bootstrapDirectorAgent()).rejects.toThrow("bootstrap response is invalid");
  });

  it("rejects an unknown chat status instead of casting a malformed gateway response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(bootstrapResponse()))
      .mockResolvedValueOnce(
        response({
          requestId: "request-12345678",
          sceneId: "shot-a",
          startingRevision: 7,
          endingRevision: 8,
          summary: "完成",
          status: "future_status",
          commands: [],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await bootstrapDirectorAgent();
    await expect(
      sendDirectorAssistantMessage({
        sceneId: "shot-a",
        expectedRevision: 7,
        message: "新增角色",
      }),
    ).rejects.toThrow("chat response is invalid");
  });

  it("re-bootstrapstraps after a ComfyUI token rotation without changing the tab identity", async () => {
    const first = bootstrapResponse();
    const second = bootstrapResponse();
    second.browserToken = "browser-secret-rotated";
    second.health.gateway.epoch = "gateway-epoch-0002";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(first))
      .mockResolvedValueOnce(response({ error: "unauthorized" }, 401))
      .mockResolvedValueOnce(response(second))
      .mockResolvedValueOnce(response(null));
    vi.stubGlobal("fetch", fetchMock);

    await bootstrapDirectorAgent();
    const originalTabId = getDirectorAgentTabId();
    const health = await getDirectorAgentHealth();
    await publishDirectorAgentPresence({ sceneId: "shot-a", revision: 5, visible: true });
    const rotatedPresence = JSON.parse(String((fetchMock.mock.calls[3][1] as RequestInit).body));

    expect(health).toMatchObject({ epoch: "gateway-epoch-0002", gateway: "connected" });
    expect(rotatedPresence.tabId).toBe(originalTabId);
    expect(fetchMock.mock.calls[3][1]?.headers).toMatchObject({
      "X-Director-Browser-Token": "browser-secret-rotated",
    });
  });

  it("retries an authenticated gateway fetch once after a process-token rotation", async () => {
    const first = bootstrapResponse();
    const second = bootstrapResponse();
    second.browserToken = "browser-secret-rotated";
    second.health.gateway.epoch = "gateway-epoch-0002";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(first))
      .mockResolvedValueOnce(response({ error: "unauthorized" }, 401))
      .mockResolvedValueOnce(response(second))
      .mockResolvedValueOnce(response({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await directorAgentFetch("http://127.0.0.1:8787/api/stage");

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect((fetchMock.mock.calls[1][1]?.headers as Headers).get("X-Director-Browser-Token")).toBe("browser-secret");
    expect((fetchMock.mock.calls[3][1]?.headers as Headers).get("X-Director-Browser-Token")).toBe(
      "browser-secret-rotated",
    );
  });
});
