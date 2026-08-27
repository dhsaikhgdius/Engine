// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { CollaborationInviteRateLimiter } from "../../collaboration/collaborationInviteRateLimit";
import { CollaborationInviteRevocationRegistry } from "../../collaboration/collaborationInviteRevocationRegistry";
import { DirectorCollaborationWebSocketHub } from "../../collaborationWebSocketHub";
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

type FakeSocket = WebSocket & { sent: string[] };

function peerSocket(): FakeSocket {
  const sent: string[] = [];
  return {
    readyState: 1,
    sent,
    send(value: string) {
      sent.push(value);
    },
  } as unknown as FakeSocket;
}

function request(method: string, headers: Record<string, string> = {}) {
  return { method, headers } as IncomingMessage;
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
  const authorizer = createCollaborationRoomAuthorizer({ secret: SECRET, mode: "required", revocations });
  const hub = new DirectorCollaborationWebSocketHub({ authorizer });
  const deps: CollaborationInviteRouteDependencies = {
    readBody: vi.fn().mockResolvedValue({}),
    json,
    authorizer,
    inviteSecret: SECRET,
    revocations,
    hub,
    inviteRateLimitPerMinute: 0,
    ...overrides,
  };
  return { deps, json, revocations, hub };
}

function lastJsonCall(json: ReturnType<typeof vi.fn>) {
  const call = json.mock.calls.at(-1)!;
  return { status: call[1] as number, body: call[2] as Record<string, unknown> };
}

describe("handleCollaborationInviteRoute", () => {
  it("reports the auth mode and invite rate-limit policy with capability-hardening headers", async () => {
    const { deps, json } = dependencies({ inviteRateLimitPerMinute: 30 });
    const res = response();
    const handled = await handleCollaborationInviteRoute(
      request("GET"),
      res,
      new URL("http://gateway.local/api/collab/auth"),
      deps,
    );
    expect(handled).toBe(true);
    expect(lastJsonCall(json)).toMatchObject({
      status: 200,
      body: { mode: "invite-required", invite_rate_limit_per_minute: 30 },
    });
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
    ).toMatchObject({ ok: true, role: "viewer" });
  });

  it("revokes one invite by token so later joins are denied, without overclaiming durability", async () => {
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
    // The default registry is process-local, so the response must say the
    // revocation is neither persisted nor backed by a durable file. With no
    // live peer holding the invite, the eject report is honestly zero.
    expect(lastJsonCall(json)).toMatchObject({
      status: 200,
      body: {
        revoked: true,
        jti: invite.jti,
        room: "scene-alpha",
        persisted: false,
        persistence_enabled: false,
        disconnected_peers: 0,
        disconnected_rooms: [],
      },
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
    expect(lastJsonCall(json)).toMatchObject({
      status: 200,
      body: { revoked: true, room: "project-a/*", persisted: false, persistence_enabled: false },
    });
    expect(
      verifyCollaborationInviteToken({
        secret: SECRET,
        token: invite.token,
        roomId: "project-a/scene-1",
        revocations,
      }),
    ).toEqual({ ok: false, reason: "revoked" });
  });

  it("ejects live peers holding a token-revoked invite and reports the disconnect honestly", async () => {
    const revokedInvite = mintCollaborationInviteToken({ secret: SECRET, room: "scene-alpha", role: "editor" });
    const survivingInvite = mintCollaborationInviteToken({ secret: SECRET, room: "scene-alpha", role: "editor" });
    const { deps, json, hub } = dependencies({ readBody: vi.fn().mockResolvedValue({ token: revokedInvite.token }) });
    const revokedPeer = peerSocket();
    const survivor = peerSocket();
    hub.handle(revokedPeer, {
      type: "collab.join",
      room: "scene-alpha",
      awareness_client_id: 61,
      invite_token: revokedInvite.token,
    });
    hub.handle(survivor, {
      type: "collab.join",
      room: "scene-alpha",
      awareness_client_id: 62,
      invite_token: survivingInvite.token,
    });
    revokedPeer.sent.length = 0;

    await handleCollaborationInviteRoute(
      request("POST"),
      response(),
      new URL("http://gateway.local/api/collab/invites/revoke"),
      deps,
    );
    expect(lastJsonCall(json)).toMatchObject({
      status: 200,
      body: { revoked: true, jti: revokedInvite.jti, disconnected_peers: 1, disconnected_rooms: ["scene-alpha"] },
    });
    expect(JSON.parse(revokedPeer.sent.at(-1)!)).toMatchObject({
      type: "collab.error",
      code: "unauthorized",
      room: "scene-alpha",
      message: "The collaboration invite token has been revoked.",
    });
    expect(hub.peerCount("scene-alpha")).toBe(1);
    hub.destroy();
  });

  it("ejects joined peers across every room a scope revocation covers", async () => {
    const invite = mintCollaborationInviteToken({ secret: SECRET, room: "project-a/*", role: "editor" });
    const { deps, json, hub } = dependencies({ readBody: vi.fn().mockResolvedValue({ room: "project-a/*" }) });
    const sceneOne = peerSocket();
    const sceneTwo = peerSocket();
    hub.handle(sceneOne, {
      type: "collab.join",
      room: "project-a/scene-1",
      awareness_client_id: 63,
      invite_token: invite.token,
    });
    hub.handle(sceneTwo, {
      type: "collab.join",
      room: "project-a/scene-2",
      awareness_client_id: 64,
      invite_token: invite.token,
    });

    await handleCollaborationInviteRoute(
      request("POST"),
      response(),
      new URL("http://gateway.local/api/collab/invites/revoke"),
      deps,
    );
    expect(lastJsonCall(json)).toMatchObject({
      status: 200,
      body: {
        revoked: true,
        room: "project-a/*",
        disconnected_peers: 2,
        disconnected_rooms: ["project-a/scene-1", "project-a/scene-2"],
      },
    });
    expect(hub.peerCount("project-a/scene-1")).toBe(0);
    expect(hub.peerCount("project-a/scene-2")).toBe(0);
    hub.destroy();
  });

  it("reports persisted: true when the revocation reached a durable registry file", async () => {
    const directory = mkdtempSync(resolve(tmpdir(), "director-collab-invite-routes-"));
    try {
      const revocations = new CollaborationInviteRevocationRegistry({
        persistPath: resolve(directory, "collaboration-invite-revocations.json"),
      });
      const { deps, json } = dependencies({
        revocations,
        readBody: vi.fn().mockResolvedValue({ room: "project-a/*" }),
      });
      await handleCollaborationInviteRoute(
        request("POST"),
        response(),
        new URL("http://gateway.local/api/collab/invites/revoke"),
        deps,
      );
      expect(lastJsonCall(json)).toMatchObject({
        status: 200,
        body: { revoked: true, room: "project-a/*", persisted: true, persistence_enabled: true },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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

  it("returns invite_rate_limited with Retry-After when the mint/revoke budget is exhausted", async () => {
    const rateLimiter = new CollaborationInviteRateLimiter(1);
    const { deps, json } = dependencies({
      rateLimiter,
      readBody: vi.fn().mockResolvedValue({ room: "scene-alpha", role: "editor" }),
    });
    const first = response();
    await handleCollaborationInviteRoute(
      request("POST", { authorization: "Bearer operator-token" }),
      first,
      new URL("http://gateway.local/api/collab/invites"),
      deps,
    );
    expect(lastJsonCall(json).status).toBe(201);

    const second = response();
    await handleCollaborationInviteRoute(
      request("POST", { authorization: "Bearer operator-token" }),
      second,
      new URL("http://gateway.local/api/collab/invites"),
      deps,
    );
    expect(lastJsonCall(json)).toMatchObject({
      status: 429,
      body: { code: "invite_rate_limited", limit_per_minute: 1 },
    });
    expect(second.headers.get("retry-after")).toMatch(/^\d+$/);

    // Mint and revoke share one budget for the same Authorization fingerprint.
    const revoke = response();
    await handleCollaborationInviteRoute(
      request("POST", { authorization: "Bearer operator-token" }),
      revoke,
      new URL("http://gateway.local/api/collab/invites/revoke"),
      { ...deps, readBody: vi.fn().mockResolvedValue({ room: "scene-alpha" }) },
    );
    expect(lastJsonCall(json)).toMatchObject({ status: 429, body: { code: "invite_rate_limited" } });
  });
});
