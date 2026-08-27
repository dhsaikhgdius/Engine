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
import {
  collaborationInviteRateLimitKeyFromAuthorization,
  type CollaborationInviteRateLimiter,
} from "../collaboration/collaborationInviteRateLimit";
import type { DirectorCollaborationWebSocketHub } from "../collaborationWebSocketHub";
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
  /** The live room hub; a revocation ejects joined peers holding the revoked invite. */
  hub: Pick<DirectorCollaborationWebSocketHub, "enforceInviteRevocations">;
  /**
   * Optional sliding-window limiter for mint/revoke. When omitted or disabled,
   * local trust mode stays unbounded.
   */
  rateLimiter?: CollaborationInviteRateLimiter;
  /** Configured invite mint/revoke limit per minute (0 = unlimited / off). */
  inviteRateLimitPerMinute: number;
};

function rejectIfRateLimited(
  request: IncomingMessage,
  response: ServerResponse,
  json: JsonWriter,
  rateLimiter: CollaborationInviteRateLimiter | undefined,
): boolean {
  if (!rateLimiter?.enabled) return false;
  const authorizationHeader = request.headers.authorization;
  const authorization = Array.isArray(authorizationHeader) ? authorizationHeader[0] : authorizationHeader;
  const verdict = rateLimiter.check(collaborationInviteRateLimitKeyFromAuthorization(authorization));
  if (verdict.allowed) return false;
  response.setHeader("Retry-After", String(verdict.retryAfterSeconds));
  json(response, 429, {
    error: "协作邀请操作过于频繁，请稍后重试",
    code: "invite_rate_limited",
    retry_after_seconds: verdict.retryAfterSeconds,
    limit_per_minute: verdict.limitPerMinute,
  });
  return true;
}

/**
 * Handles HTTP routes for collaboration room invites. All routes sit behind
 * the master gateway token like every other `/api/` route, so only operators
 * and trusted agents can mint or revoke capabilities. Responses carry
 * no-store/no-referrer hardening because they transport capability tokens.
 *
 * Routes:
 * - `GET /api/collab/auth` — report the room authorization mode and invite
 *   mint/revoke rate-limit policy (`invite_rate_limit_per_minute`, 0 = off).
 * - `POST /api/collab/invites` — mint a signed invite capability token.
 * - `POST /api/collab/invites/revoke` — revoke one invite by token, or every
 *   invite for a room scope that was minted before now. Successful responses
 *   carry `persistence_enabled` (a durable revocation file is configured) and
 *   `persisted` (this revocation reached it), so callers never treat a
 *   process-local revocation — which dies with the gateway process — as one
 *   that survives a restart. A revocation also ends live sessions: peers
 *   already joined with the revoked invite are ejected with a permanent
 *   `unauthorized` error, and the response reports `disconnected_peers` and
 *   `disconnected_rooms` so a revoke is never mistaken for ending access it
 *   left running.
 *
 * @returns True if the route was handled, false otherwise.
 */
export async function handleCollaborationInviteRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  dependencies: CollaborationInviteRouteDependencies,
) {
  const { readBody, json, authorizer, inviteSecret, revocations, hub, rateLimiter, inviteRateLimitPerMinute } =
    dependencies;
  if (request.method === "GET" && url.pathname === "/api/collab/auth") {
    applyCollaborationResponseHardening(response);
    json(response, 200, { mode: authorizer.mode, invite_rate_limit_per_minute: inviteRateLimitPerMinute });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/collab/invites") {
    applyCollaborationResponseHardening(response);
    if (rejectIfRateLimited(request, response, json, rateLimiter)) return true;
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
    if (rejectIfRateLimited(request, response, json, rateLimiter)) return true;
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
      if (!outcome.revoked) {
        json(response, 200, { revoked: false, reason: outcome.reason });
        return true;
      }
      const enforcement = hub.enforceInviteRevocations(revocations);
      json(response, 200, {
        revoked: true,
        jti: outcome.jti,
        room: outcome.room,
        expires_at: outcome.expiresAt,
        persisted: outcome.persisted,
        persistence_enabled: revocations.persistenceEnabled,
        disconnected_peers: enforcement.disconnectedPeers,
        disconnected_rooms: enforcement.rooms,
      });
      return true;
    }
    const scope = parsed.data.room!;
    const outcome = await revocations.revokeRoomScope(scope);
    const enforcement = hub.enforceInviteRevocations(revocations);
    json(response, 200, {
      revoked: true,
      room: outcome.room,
      cutoff: outcome.cutoff,
      persisted: outcome.persisted,
      persistence_enabled: revocations.persistenceEnabled,
      disconnected_peers: enforcement.disconnectedPeers,
      disconnected_rooms: enforcement.rooms,
    });
    return true;
  }
  return false;
}
