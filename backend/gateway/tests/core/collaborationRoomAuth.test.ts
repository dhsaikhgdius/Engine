// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  collaborationRoomAuthRequired,
  createCollaborationRoomAuthorizer,
  decodeCollaborationInvitePayload,
  mintCollaborationInviteToken,
  verifyCollaborationInviteToken,
} from "../../collaborationRoomAuth";
import { CollaborationInviteRevocationRegistry } from "../../collaboration/collaborationInviteRevocationRegistry";

const SECRET = "test-collaboration-invite-secret";

describe("collaboration invite tokens", () => {
  it("mints and verifies a room-scoped editor invite", () => {
    const invite = mintCollaborationInviteToken({ secret: SECRET, room: "scene-alpha", role: "editor" });
    expect(invite.token.startsWith("dcr1.")).toBe(true);
    expect(verifyCollaborationInviteToken({ secret: SECRET, token: invite.token, roomId: "scene-alpha" })).toEqual({
      ok: true,
      role: "editor",
    });
  });

  it("rejects missing, malformed, and foreign-signature tokens with structured reasons", () => {
    const invite = mintCollaborationInviteToken({ secret: SECRET, room: "scene-alpha", role: "viewer" });
    expect(verifyCollaborationInviteToken({ secret: SECRET, token: undefined, roomId: "scene-alpha" })).toEqual({
      ok: false,
      reason: "missing_token",
    });
    expect(
      verifyCollaborationInviteToken({ secret: SECRET, token: "not-a-real-token", roomId: "scene-alpha" }),
    ).toEqual({ ok: false, reason: "malformed_token" });
    expect(
      verifyCollaborationInviteToken({ secret: "another-secret", token: invite.token, roomId: "scene-alpha" }),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects tampered payloads even when they decode as valid JSON", () => {
    const invite = mintCollaborationInviteToken({ secret: SECRET, room: "scene-alpha", role: "viewer" });
    const [prefix, , signature] = invite.token.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({ room: "scene-alpha", role: "editor", exp: Date.now() + 60_000 }),
      "utf8",
    ).toString("base64url");
    const result = verifyCollaborationInviteToken({
      secret: SECRET,
      token: `${prefix}.${forgedPayload}.${signature}`,
      roomId: "scene-alpha",
    });
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("expires invites and scopes them to the exact room or prefix capability", () => {
    const clock = { value: 1_000_000 };
    const now = () => clock.value;
    const invite = mintCollaborationInviteToken({
      secret: SECRET,
      room: "scene-alpha",
      role: "editor",
      ttlSeconds: 60,
      now,
    });
    expect(verifyCollaborationInviteToken({ secret: SECRET, token: invite.token, roomId: "scene-beta", now })).toEqual({
      ok: false,
      reason: "room_mismatch",
    });
    clock.value += 61_000;
    expect(verifyCollaborationInviteToken({ secret: SECRET, token: invite.token, roomId: "scene-alpha", now })).toEqual(
      { ok: false, reason: "expired" },
    );

    const prefixInvite = mintCollaborationInviteToken({
      secret: SECRET,
      room: "project-a/*",
      role: "viewer",
      now,
    });
    expect(
      verifyCollaborationInviteToken({ secret: SECRET, token: prefixInvite.token, roomId: "project-a/scene-1", now }),
    ).toEqual({ ok: true, role: "viewer" });
    expect(
      verifyCollaborationInviteToken({ secret: SECRET, token: prefixInvite.token, roomId: "project-b/scene-1", now }),
    ).toEqual({ ok: false, reason: "room_mismatch" });
  });
});

describe("collaboration invite revocation", () => {
  it("mints revocable invites carrying a unique jti and an issue timestamp", () => {
    const invite = mintCollaborationInviteToken({ secret: SECRET, room: "scene-alpha", role: "editor" });
    expect(invite.jti).toMatch(/^dci-/);
    const payload = decodeCollaborationInvitePayload(invite.token);
    expect(payload).toMatchObject({ room: "scene-alpha", role: "editor", jti: invite.jti });
    expect(typeof payload?.iat).toBe("number");
    expect(decodeCollaborationInvitePayload("garbage")).toBeNull();
  });

  it("denies an exact invite after it is revoked by token, without touching sibling invites", async () => {
    const registry = new CollaborationInviteRevocationRegistry();
    const revokedInvite = mintCollaborationInviteToken({ secret: SECRET, room: "scene-alpha", role: "editor" });
    const survivingInvite = mintCollaborationInviteToken({ secret: SECRET, room: "scene-alpha", role: "editor" });
    const outcome = await registry.revokeToken(revokedInvite.token);
    expect(outcome).toMatchObject({ revoked: true, jti: revokedInvite.jti, room: "scene-alpha" });

    const verify = (token: string) =>
      verifyCollaborationInviteToken({ secret: SECRET, token, roomId: "scene-alpha", revocations: registry });
    expect(verify(revokedInvite.token)).toEqual({ ok: false, reason: "revoked" });
    expect(verify(survivingInvite.token)).toEqual({ ok: true, role: "editor" });
  });

  it("revokes every older invite for a room scope while invites minted afterwards stay valid", async () => {
    const clock = { value: 5_000_000 };
    const now = () => clock.value;
    const registry = new CollaborationInviteRevocationRegistry({ now });
    const oldExact = mintCollaborationInviteToken({ secret: SECRET, room: "project-a/scene-1", role: "editor", now });
    const oldPrefix = mintCollaborationInviteToken({ secret: SECRET, room: "project-a/*", role: "viewer", now });
    clock.value += 1_000;
    await registry.revokeRoomScope("project-a/*");
    clock.value += 1_000;
    const fresh = mintCollaborationInviteToken({ secret: SECRET, room: "project-a/scene-1", role: "editor", now });

    const verify = (token: string, roomId: string) =>
      verifyCollaborationInviteToken({ secret: SECRET, token, roomId, now, revocations: registry });
    expect(verify(oldExact.token, "project-a/scene-1")).toEqual({ ok: false, reason: "revoked" });
    expect(verify(oldPrefix.token, "project-a/scene-2")).toEqual({ ok: false, reason: "revoked" });
    expect(verify(fresh.token, "project-a/scene-1")).toEqual({ ok: true, role: "editor" });
    // A different project's rooms are untouched by the cutoff.
    const otherProject = mintCollaborationInviteToken({
      secret: SECRET,
      room: "project-b/scene-1",
      role: "editor",
      now: () => 5_000_000,
    });
    expect(verify(otherProject.token, "project-b/scene-1")).toEqual({ ok: true, role: "editor" });
  });

  it("reports non-revocable and already-expired tokens with structured outcomes", async () => {
    const registry = new CollaborationInviteRevocationRegistry();
    expect(await registry.revokeToken("not-a-token")).toEqual({ revoked: false, reason: "malformed_token" });

    // A legacy token without jti/iat claims cannot be revoked individually.
    const legacyPayload = Buffer.from(
      JSON.stringify({ room: "scene-alpha", role: "editor", exp: Date.now() + 60_000 }),
      "utf8",
    ).toString("base64url");
    expect(await registry.revokeToken(`dcr1.${legacyPayload}.signature`)).toEqual({
      revoked: false,
      reason: "not_revocable",
    });

    const clock = { value: 1_000_000 };
    const expiringRegistry = new CollaborationInviteRevocationRegistry({ now: () => clock.value });
    const expired = mintCollaborationInviteToken({
      secret: SECRET,
      room: "scene-alpha",
      role: "editor",
      ttlSeconds: 60,
      now: () => clock.value,
    });
    clock.value += 61_000;
    expect(await expiringRegistry.revokeToken(expired.token)).toEqual({ revoked: false, reason: "already_expired" });
  });

  it("treats legacy tokens without an issue timestamp as covered by any room cutoff", async () => {
    const registry = new CollaborationInviteRevocationRegistry();
    await registry.revokeRoomScope("scene-alpha");
    expect(registry.isRevoked({ room: "scene-alpha", exp: Date.now() + 60_000 }, "scene-alpha")).toBe(true);
  });
});

describe("createCollaborationRoomAuthorizer", () => {
  it("defaults to local trust mode that admits every socket as an editor", () => {
    const authorizer = createCollaborationRoomAuthorizer({ secret: SECRET, mode: undefined });
    expect(authorizer.mode).toBe("local-trust");
    expect(authorizer.authorize("any-room", undefined)).toEqual({ ok: true, role: "editor" });
  });

  it("enforces invite tokens when room auth is required", () => {
    const authorizer = createCollaborationRoomAuthorizer({ secret: SECRET, mode: "required" });
    expect(authorizer.mode).toBe("invite-required");
    expect(authorizer.authorize("scene-alpha", undefined)).toEqual({ ok: false, reason: "missing_token" });
    const invite = mintCollaborationInviteToken({ secret: SECRET, room: "scene-alpha", role: "viewer" });
    expect(authorizer.authorize("scene-alpha", invite.token)).toEqual({ ok: true, role: "viewer" });
  });

  it("parses the documented mode values", () => {
    expect(collaborationRoomAuthRequired(undefined)).toBe(false);
    expect(collaborationRoomAuthRequired("")).toBe(false);
    expect(collaborationRoomAuthRequired("off")).toBe(false);
    expect(collaborationRoomAuthRequired("required")).toBe(true);
    expect(collaborationRoomAuthRequired("invite-required")).toBe(true);
    expect(collaborationRoomAuthRequired("1")).toBe(true);
    expect(collaborationRoomAuthRequired("true")).toBe(true);
  });
});
