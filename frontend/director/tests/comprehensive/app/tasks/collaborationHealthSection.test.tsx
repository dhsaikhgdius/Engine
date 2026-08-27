import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(),
}));

vi.mock("../../../../src/comprehensive/editor/api/directorControlPlaneClient", () => ({
  directorControlPlaneFetch: mocks.fetch,
}));

import { CollaborationHealthSection } from "../../../../src/comprehensive/app/tasks/CollaborationHealthSection";
import {
  collaborationHealthStanzaSchema,
  fetchCollaborationHealth,
} from "../../../../src/comprehensive/app/tasks/collaborationHealthClient";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function collaborationStanza(overrides: Record<string, unknown> = {}) {
  return {
    mode: "invite-required",
    persistence: true,
    empty_room_ttl_seconds: 120,
    invite_rate_limit_per_minute: 30,
    active_rooms: 2,
    retained_rooms: 1,
    transport: {
      loopback_binding: true,
      tls_termination: false,
      multi_node: false,
      member_identity: "invite-capability",
    },
    ...overrides,
  };
}

function healthBody(collaboration: Record<string, unknown> = collaborationStanza()) {
  return {
    ok: true,
    service: "director-stage-gateway",
    clients: 3,
    sceneRecovery: null,
    collaboration,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("collaborationHealthClient", () => {
  it("fetches /health and validates only the collaboration stanza", async () => {
    mocks.fetch.mockResolvedValueOnce(jsonResponse(200, healthBody()));
    const health = await fetchCollaborationHealth();
    expect(mocks.fetch).toHaveBeenCalledWith("/health", { signal: undefined });
    expect(health).toEqual(collaborationStanza());
  });

  it("ignores unrelated health fields and still parses collaboration", async () => {
    mocks.fetch.mockResolvedValueOnce(
      jsonResponse(200, {
        ...healthBody(),
        extra_probe: { noisy: true },
        liveLink: { seq: 9 },
      }),
    );
    const health = await fetchCollaborationHealth();
    expect(health.mode).toBe("invite-required");
    expect(health.transport.multi_node).toBe(false);
    expect(health.transport.tls_termination).toBe(false);
  });

  it("parses local-trust defaults with rate limit and TTL off", async () => {
    mocks.fetch.mockResolvedValueOnce(
      jsonResponse(
        200,
        healthBody(
          collaborationStanza({
            mode: "local-trust",
            persistence: false,
            empty_room_ttl_seconds: 0,
            invite_rate_limit_per_minute: 0,
            active_rooms: 0,
            retained_rooms: 0,
            transport: {
              loopback_binding: true,
              tls_termination: false,
              multi_node: false,
              member_identity: "local-trust",
            },
          }),
        ),
      ),
    );
    const health = await fetchCollaborationHealth();
    expect(health.mode).toBe("local-trust");
    expect(health.invite_rate_limit_per_minute).toBe(0);
    expect(health.transport.member_identity).toBe("local-trust");
  });

  it("rejects an unknown collaboration field under strict parsing", () => {
    expect(() => collaborationHealthStanzaSchema.parse(collaborationStanza({ room_ids: ["scene/secret"] }))).toThrow(
      ZodError,
    );
  });

  it("surfaces gateway error messages", async () => {
    mocks.fetch.mockResolvedValueOnce(jsonResponse(503, { message: "网关不可用" }));
    await expect(fetchCollaborationHealth()).rejects.toThrow("网关不可用");
  });
});

describe("CollaborationHealthSection", () => {
  it("renders team-mode flags and transport honesty without claiming multi-node or TLS", async () => {
    mocks.fetch.mockResolvedValue(jsonResponse(200, healthBody()));
    render(<CollaborationHealthSection />);

    expect(await screen.findByText("协作健康")).toBeTruthy();
    expect(screen.getByText("鉴权模式")).toBeTruthy();
    expect(screen.getAllByText("需邀请").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("持久化")).toBeTruthy();
    expect(screen.getByText("已启用")).toBeTruthy();
    expect(screen.getByText("空房间 TTL")).toBeTruthy();
    expect(screen.getByText("120 秒")).toBeTruthy();
    expect(screen.getByText("邀请速率限制")).toBeTruthy();
    expect(screen.getByText("30 / 分钟")).toBeTruthy();
    expect(screen.getByText("活跃房间")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("保留房间")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getByText("传输绑定")).toBeTruthy();
    expect(screen.getByText("仅 loopback")).toBeTruthy();
    expect(screen.getByText("TLS 终结")).toBeTruthy();
    expect(screen.getByText("不终结 TLS")).toBeTruthy();
    expect(screen.getByText("多节点房间")).toBeTruthy();
    // Stanza says false — UI must not claim multi-node clustering.
    expect(screen.getByText("单进程（无多节点）")).toBeTruthy();
    expect(screen.queryByText("多节点集群")).toBeNull();
    expect(screen.queryByText("已终结 TLS")).toBeNull();
    expect(screen.getByText("成员身份")).toBeTruthy();
    expect(screen.getByText("邀请 capability")).toBeTruthy();
  });

  it("renders local-trust off flags and refreshes on demand", async () => {
    const user = userEvent.setup();
    mocks.fetch.mockResolvedValue(
      jsonResponse(
        200,
        healthBody(
          collaborationStanza({
            mode: "local-trust",
            persistence: false,
            empty_room_ttl_seconds: 0,
            invite_rate_limit_per_minute: 0,
            active_rooms: 0,
            retained_rooms: 0,
            transport: {
              loopback_binding: true,
              tls_termination: false,
              multi_node: false,
              member_identity: "local-trust",
            },
          }),
        ),
      ),
    );
    render(<CollaborationHealthSection />);
    expect(await screen.findByText("协作健康")).toBeTruthy();
    expect(screen.getAllByText("本地信任").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("未启用")).toBeTruthy();
    expect(screen.getByText("立即销毁")).toBeTruthy();
    expect(screen.getByText("未限制")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "刷新" }));
    expect(mocks.fetch.mock.calls.filter(([path]) => path === "/health").length).toBeGreaterThanOrEqual(2);
  });

  it("shows fetch failures inline", async () => {
    mocks.fetch.mockResolvedValueOnce(jsonResponse(503, { message: "协作健康不可用" }));
    render(<CollaborationHealthSection />);
    expect(await screen.findByText("协作健康不可用")).toBeTruthy();
  });
});
