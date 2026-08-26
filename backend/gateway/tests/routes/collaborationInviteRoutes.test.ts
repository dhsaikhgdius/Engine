// @vitest-environment node

import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { CollaborationInviteRevocationRegistry } from "../../collaboration/collaborationInviteRevocationRegistry";
import {
  createCollaborationRoomAuthorizer,
  mintCollaborationInviteToken,
  verifyCollaborationInviteToken,
} from "../../collaborationRoomAuth";
import {
  handleCollaborationInviteRoute,
  type CollaborationInviteRouteDependencies,
} from "../../routes/collaborationInviteRoutes";

const SECRET = "invite-routes-test-secret";

type FakeResponse = ServerResponse & { headers: Map<string, string> };

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

function dependencies(overrides: Partial<CollaborationInviteRouteDependencies> = {}) {
  const json = vi.fn();
  const revocations = new CollaborationInviteRevocationRegistry();
  const deps: CollaborationInviteRouteDependencies = {
    readBody: vi.fn().mockResolvedValue({}),
    json,
    authorizer: createCollaborationRoomAuthorizer({ secret: SECRET, mode: "required", revocations }),
    inviteSecret: SECRET,
    revocations,
    ...overrides,
  };
  return { deps, json, revocations };
}

function lastJsonCall(json: ReturnType<typeof vi.fn>) {
  const call = json.mock.calls.at(-1)!;
  return { status: call[1] as number, body: call[2] as Record<string, unknown> };
}

describe("handleCollaborationInviteRoute", () => {
  it("reports the auth mode with capability-hardening headers", async () => {
    const { deps, json } = dependencies();
    const res = response();
    const handled = await handleCollaborationInviteRoute(
      request("GET"),
      res,
      new URL("http://gateway.local/api/collab/auth"),
      deps,
    );
    expect(handled).toBe(true);
    expect(lastJsonCall(json)).toMatchObject({ status: 200, body: { mode: "invite-required" } });
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("mints invites that now carry a revocable jti", async () => {
    const { deps, json } = dependencies({
      readBody: vi.fn().mockResolvedValue({ room: "scene-alpha", role: "viewer", ttl_seconds: 3_600 }),
    });
    await handleCollaborationInviteRoute(
      request("POST"),
      response(),
      new URL("http://gateway.local/api/collab/invites"),
      deps,
    );
    const { status, body } = lastJsonCall(json);
    expect(status).toBe(201);
    const invite = body.invite as Record<string, string>;
    expect(invite.jti).toMatch(/^dci-/);
    expect(
      verifyCollaborationInviteToken({ secret: SECRET, token: invite.token, roomId: "scene-alpha" }),
    ).toEqual({ ok: true, role: "viewer" });
  });

  it("revokes one invite by token so later joins are denied", async () => {
    const invite = mintCollaborationInviteToken({ secret: SECRET, room: "scene-alpha", role: "editor" });
    const { deps, json, revocations } = dependencies({
      readBody: vi.fn().mockResolvedValue({ token: invite.token }),
    });
    await handleCollaborationInviteRoute(
      request("POST"),
      response(),
      new URL("http://gateway.local/api/collab/invites/revoke"),
      deps,
    );
    expect(lastJsonCall(json)).toMatchObject({
      status: 200,
      body: { revoked: true, jti: invite.jti, room: "scene-alpha" },
    });
    expect(
      verifyCollaborationInviteToken({
        secret: SECRET,
        token: invite.token,
        roomId: "scene-alpha",
        revocations,
      }),
    ).toEqual({ ok: false, reason: "revoked" });
  });

  it("revokes a room scope's older invites with a cutoff", async () => {
    const invite = mintCollaborationInviteToken({ secret: SECRET, room: "project-a/*", role: "editor" });
    const { deps, json, revocations } = dependencies({
      readBody: vi.fn().mockResolvedValue({ room: "project-a/*" }),
    });
    await handleCollaborationInviteRoute(
      request("POST"),
      response(),
      new URL("http://gateway.local/api/collab/invites/revoke"),
      deps,
    );
    expect(lastJsonCall(json)).toMatchObject({ status: 200, body: { revoked: true, room: "project-a/*" } });
    expect(
      verifyCollaborationInviteToken({
        secret: SECRET,
        token: invite.token,
        roomId: "project-a/scene-1",
        revocations,
      }),
    ).toEqual({ ok: false, reason: "revoked" });
  });

  it("rejects revoke requests that provide both or neither selector", async () => {
    const both = dependencies({
      readBody: vi.fn().mockResolvedValue({ token: "dcr1.payload.signature-0123", room: "scene-alpha" }),
    });
    await handleCollaborationInviteRoute(
      request("POST"),
      response(),
      new URL("http://gateway.local/api/collab/invites/revoke"),
      both.deps,
    );
    expect(lastJsonCall(both.json)).toMatchObject({ status: 400, body: { code: "invalid_request" } });

    const neither = dependencies({ readBody: vi.fn().mockResolvedValue({}) });
    await handleCollaborationInviteRoute(
      request("POST"),
      response(),
      new URL("http://gateway.local/api/collab/invites/revoke"),
      neither.deps,
    );
    expect(lastJsonCall(neither.json)).toMatchObject({ status: 400, body: { code: "invalid_request" } });
  });

  it("explains that legacy invites without a jti need a room-scope revocation", async () => {
    const legacyPayload = Buffer.from(
      JSON.stringify({ room: "scene-alpha", role: "editor", exp: Date.now() + 60_000 }),
      "utf8",
    ).toString("base64url");
    const { deps, json } = dependencies({
      readBody: vi.fn().mockResolvedValue({ token: `dcr1.${legacyPayload}.signature` }),
    });
    await handleCollaborationInviteRoute(
      request("POST"),
      response(),
      new URL("http://gateway.local/api/collab/invites/revoke"),
      deps,
    );
    expect(lastJsonCall(json)).toMatchObject({ status: 409, body: { code: "invite_not_revocable" } });
  });
});
