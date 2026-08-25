import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  directorCollaborationRoomRoleSchema,
  directorCollaborationRoomSchema,
  type DirectorCollaborationRoomRole,
} from "../../packages/protocol/src/directorCollaborationGatewayProtocol";

const INVITE_TOKEN_PREFIX = "dcr1";
const DEFAULT_INVITE_TTL_SECONDS = 24 * 60 * 60;
const MAX_INVITE_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * The room scope of an invite: an exact room id, or a prefix capability such
 * as `project-a/*` that admits every room under that prefix.
 */
export const collaborationInviteRoomScopeSchema = z
  .string()
  .trim()
  .min(1)
  .max(181)
  .refine(
    (scope) => directorCollaborationRoomSchema.safeParse(scope.endsWith("*") ? scope.slice(0, -1) : scope).success,
    { message: "The invite room scope must be a valid room id, optionally ending with * for a prefix capability." },
  );

const invitePayloadSchema = z.strictObject({
  room: collaborationInviteRoomScopeSchema,
  role: directorCollaborationRoomRoleSchema,
  exp: z.number().int().positive(),
});

/** Why a collaboration room join was denied. */
export type CollaborationRoomDenialReason =
  | "missing_token"
  | "malformed_token"
  | "bad_signature"
  | "expired"
  | "room_mismatch";

/** The result of authorizing one join attempt against one room. */
export type CollaborationRoomAuthorization =
  | { ok: true; role: DirectorCollaborationRoomRole }
  | { ok: false; reason: CollaborationRoomDenialReason };

/**
 * Room-level join authorizer consumed by the collaboration hub.
 *
 * - `local-trust` — the default single-machine mode: every already
 *   origin/token-authenticated socket joins as an editor, exactly like the
 *   pre-auth gateway behaved.
 * - `invite-required` — team mode: joins must present a signed invite
 *   capability token scoped to the room; the invite decides the role.
 */
export type CollaborationRoomAuthorizer = {
  mode: "local-trust" | "invite-required";
  authorize(roomId: string, inviteToken: string | undefined): CollaborationRoomAuthorization;
};

function signInvitePayload(secret: string, encodedPayload: string) {
  return createHmac("sha256", secret).update(`${INVITE_TOKEN_PREFIX}.${encodedPayload}`).digest("base64url");
}

function roomMatchesScope(roomId: string, scope: string) {
  if (scope.endsWith("*")) return roomId.startsWith(scope.slice(0, -1));
  return roomId === scope;
}

/**
 * Mints a signed collaboration invite capability token.
 *
 * The token is a compact `dcr1.<payload>.<signature>` envelope carrying the
 * room scope, the capability role, and an absolute expiry. It grants room
 * membership only; the WebSocket upgrade still requires the gateway token.
 *
 * @returns The token together with its resolved expiry timestamp.
 */
export function mintCollaborationInviteToken(input: {
  secret: string;
  room: string;
  role: DirectorCollaborationRoomRole;
  ttlSeconds?: number;
  now?: () => number;
}) {
  const room = collaborationInviteRoomScopeSchema.parse(input.room);
  const role = directorCollaborationRoomRoleSchema.parse(input.role);
  const ttlSeconds = Math.min(
    Math.max(1, Math.floor(input.ttlSeconds ?? DEFAULT_INVITE_TTL_SECONDS)),
    MAX_INVITE_TTL_SECONDS,
  );
  const expiresAtMs = (input.now?.() ?? Date.now()) + ttlSeconds * 1_000;
  const encodedPayload = Buffer.from(JSON.stringify({ room, role, exp: expiresAtMs }), "utf8").toString("base64url");
  return {
    token: `${INVITE_TOKEN_PREFIX}.${encodedPayload}.${signInvitePayload(input.secret, encodedPayload)}`,
    room,
    role,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

/**
 * Verifies one invite token against one room. Signature comparison is
 * timing-safe, and every failure returns a structured denial reason instead
 * of throwing.
 */
export function verifyCollaborationInviteToken(input: {
  secret: string;
  token: string | undefined;
  roomId: string;
  now?: () => number;
}): CollaborationRoomAuthorization {
  const token = input.token?.trim();
  if (!token) return { ok: false, reason: "missing_token" };
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== INVITE_TOKEN_PREFIX || !parts[1] || !parts[2]) {
    return { ok: false, reason: "malformed_token" };
  }
  const expected = Buffer.from(signInvitePayload(input.secret, parts[1]));
  const provided = Buffer.from(parts[2]);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return { ok: false, reason: "bad_signature" };
  }
  let payload: z.infer<typeof invitePayloadSchema>;
  try {
    payload = invitePayloadSchema.parse(JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")));
  } catch {
    return { ok: false, reason: "malformed_token" };
  }
  if (payload.exp <= (input.now?.() ?? Date.now())) return { ok: false, reason: "expired" };
  if (!roomMatchesScope(input.roomId, payload.room)) return { ok: false, reason: "room_mismatch" };
  return { ok: true, role: payload.role };
}

/** Returns whether the configured mode string enables invite-required room auth. */
export function collaborationRoomAuthRequired(configured = process.env.DIRECTOR_COLLAB_ROOM_AUTH) {
  const normalized = configured?.trim().toLowerCase();
  return normalized === "required" || normalized === "invite-required" || normalized === "1" || normalized === "true";
}

/**
 * Builds the room authorizer for the gateway process.
 *
 * When `DIRECTOR_COLLAB_ROOM_AUTH` is unset (the backward-compatible
 * default), the gateway stays in local trust mode and admits every
 * upgrade-authenticated socket as an editor. When set to `required`, joins
 * must carry a valid invite token signed with `DIRECTOR_COLLAB_INVITE_SECRET`
 * (falling back to the process gateway secret, which rotates on restart).
 */
export function createCollaborationRoomAuthorizer(options: {
  secret: string;
  mode?: string;
  now?: () => number;
}): CollaborationRoomAuthorizer {
  if (!collaborationRoomAuthRequired(options.mode ?? process.env.DIRECTOR_COLLAB_ROOM_AUTH)) {
    return { mode: "local-trust", authorize: () => ({ ok: true, role: "editor" }) };
  }
  const secret = options.secret;
  return {
    mode: "invite-required",
    authorize: (roomId, inviteToken) =>
      verifyCollaborationInviteToken({ secret, token: inviteToken, roomId, now: options.now }),
  };
}
