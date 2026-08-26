import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  directorCollaborationInviteTokenSchema,
  directorCollaborationRoomRoleSchema,
} from "../../../packages/protocol/src/directorCollaborationGatewayProtocol";
import {
  collaborationInviteRoomScopeSchema,
  mintCollaborationInviteToken,
  type CollaborationRoomAuthorizer,
} from "../collaborationRoomAuth";
import type { CollaborationInviteRevocationRegistry } from "../collaboration/collaborationInviteRevocationRegistry";
import { applyCollaborationResponseHardening } from "./collaborationRoomRoutes";

type JsonWriter = (response: ServerResponse, status: number, body: unknown) => void;

const createInviteRequestSchema = z.strictObject({
  room: collaborationInviteRoomScopeSchema,
  role: directorCollaborationRoomRoleSchema.default("editor"),
  ttl_seconds: z
    .number()
    .int()
    .min(60)
    .max(30 * 24 * 60 * 60)
    .optional(),
});

/** Exactly one of `token` (revoke one invite) or `room` (revoke a scope's older invites). */
const revokeInviteRequestSchema = z
  .strictObject({
    token: directorCollaborationInviteTokenSchema.optional(),
    room: collaborationInviteRoomScopeSchema.optional(),
  })
  .refine((request) => (request.token === undefined) !== (request.room === undefined), {
    message: "Provide exactly one of token or room.",
  });

/** Dependencies required by the collaboration invite route handler. */
export type CollaborationInviteRouteDependencies = {
  /** Parses the request body into a JSON-compatible value. */
  readBody: (request: IncomingMessage) => Promise<unknown>;
  /** Writes a JSON response with the given status code. */
  json: JsonWriter;
  /** The active room authorizer (reports the effective mode). */
  authorizer: CollaborationRoomAuthorizer;
  /** The secret used to sign invite capability tokens. */
  inviteSecret: string;
  /** Registry consulted on join to deny revoked invites. */
  revocations: CollaborationInviteRevocationRegistry;
};

/**
 * Handles HTTP routes for collaboration room invites. All routes sit behind
 * the master gateway token like every other `/api/` route, so only operators
 * and trusted agents can mint or revoke capabilities. Responses carry
 * no-store/no-referrer hardening because they transport capability tokens.
 *
 * Routes:
 * - `GET /api/collab/auth` — report the room authorization mode.
 * - `POST /api/collab/invites` — mint a signed invite capability token.
 * - `POST /api/collab/invites/revoke` — revoke one invite by token, or every
 *   invite for a room scope that was minted before now.
 *
 * @returns True if the route was handled, false otherwise.
 */
export async function handleCollaborationInviteRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  dependencies: CollaborationInviteRouteDependencies,
) {
  const { readBody, json, authorizer, inviteSecret, revocations } = dependencies;
  if (request.method === "GET" && url.pathname === "/api/collab/auth") {
    applyCollaborationResponseHardening(response);
    json(response, 200, { mode: authorizer.mode });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/collab/invites") {
    applyCollaborationResponseHardening(response);
    const parsed = createInviteRequestSchema.safeParse(await readBody(request));
    if (!parsed.success) {
      json(response, 400, { error: "协作邀请参数无效", code: "invalid_request" });
      return true;
    }
    const invite = mintCollaborationInviteToken({
      secret: inviteSecret,
      room: parsed.data.room,
      role: parsed.data.role,
      ttlSeconds: parsed.data.ttl_seconds,
    });
    json(response, 201, {
      invite: {
        token: invite.token,
        room: invite.room,
        role: invite.role,
        jti: invite.jti,
        expires_at: invite.expiresAt,
      },
      mode: authorizer.mode,
    });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/collab/invites/revoke") {
    applyCollaborationResponseHardening(response);
    const parsed = revokeInviteRequestSchema.safeParse(await readBody(request));
    if (!parsed.success) {
      json(response, 400, { error: "协作邀请吊销参数无效", code: "invalid_request" });
      return true;
    }
    if (parsed.data.token !== undefined) {
      const outcome = await revocations.revokeToken(parsed.data.token);
      if (!outcome.revoked && outcome.reason === "malformed_token") {
        json(response, 400, { error: "协作邀请 token 无法解析", code: "malformed_token" });
        return true;
      }
      if (!outcome.revoked && outcome.reason === "not_revocable") {
        json(response, 409, {
          error: "旧版邀请缺少 jti，无法单独吊销；请改用按房间吊销",
          code: "invite_not_revocable",
        });
        return true;
      }
      json(
        response,
        200,
        outcome.revoked
          ? { revoked: true, jti: outcome.jti, room: outcome.room, expires_at: outcome.expiresAt }
          : { revoked: false, reason: outcome.reason },
      );
      return true;
    }
    const scope = parsed.data.room!;
    const outcome = await revocations.revokeRoomScope(scope);
    json(response, 200, { revoked: true, room: outcome.room, cutoff: outcome.cutoff });
    return true;
  }
  return false;
}
