// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  collaborationRoomAuthRequired,
  createCollaborationRoomAuthorizer,
  mintCollaborationInviteToken,
  verifyCollaborationInviteToken,
} from "../../collaborationRoomAuth";

const SECRET = "test-collaboration-invite-secret";

describe("collaboration invite tokens", () => {
  it("mints and verifies a room-scoped editor invite", () => {
    const invite = mintCollaborationInviteToken({ secret: SECRET, room: "scene-alpha", role: "editor" });
    expect(invite.token.startsWith("dcr1.")).toBe(true);
    expect(
      verifyCollaborationInviteToken({ secret: SECRET, token: invite.token, roomId: "scene-alpha" }),
    ).toEqual({ ok: true, role: "editor" });
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
    expect(verifyCollaborationInviteToken({ secret: SECRET, token: invite.token, roomId: "scene-beta", now })).toEqual(
      { ok: false, reason: "room_mismatch" },
    );
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
