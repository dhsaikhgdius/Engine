import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { directorCollaborationRoomRoleSchema } from "../../../packages/protocol/src/directorCollaborationGatewayProtocol";
import {
  collaborationInviteRoomScopeSchema,
  mintCollaborationInviteToken,
  type CollaborationRoomAuthorizer,
} from "../collaborationRoomAuth";

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
};

/**
 * Handles HTTP routes for collaboration room invites. Both routes sit behind
 * the master gateway token like every other `/api/` route, so only operators
 * and trusted agents can mint capabilities.
 *
 * Routes:
 * - `GET /api/collab/auth` — report the room authorization mode.
 * - `POST /api/collab/invites` — mint a signed invite capability token.
 *
 * @returns True if the route was handled, false otherwise.
 */
export async function handleCollaborationInviteRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  dependencies: CollaborationInviteRouteDependencies,
) {
  const { readBody, json, authorizer, inviteSecret } = dependencies;
  if (request.method === "GET" && url.pathname === "/api/collab/auth") {
    json(response, 200, { mode: authorizer.mode });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/collab/invites") {
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
      invite: { token: invite.token, room: invite.room, role: invite.role, expires_at: invite.expiresAt },
      mode: authorizer.mode,
    });
    return true;
  }
  return false;
}
