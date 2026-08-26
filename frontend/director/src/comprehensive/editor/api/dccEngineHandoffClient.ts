import { z } from "zod";
import {
  directorDccEngineHealthSchema,
  type DirectorDccEngineHealth,
} from "../../../dcc/directorDccEngineContract";
import { directorDccEngineIdSchema, type DirectorDccEngineId } from "../../../dcc/directorDccEngineSpace";
import {
  directorGodotLiveLinkPreviewSchema,
  type DirectorGodotLiveLinkPreview,
} from "../../../dcc/directorGodotLiveLinkContract";
import {
  directorUnityLiveLinkSessionGrantSchema,
  directorUnityLiveLinkSessionStatusSchema,
  type DirectorUnityLiveLinkSessionGrant,
  type DirectorUnityLiveLinkSessionStatus,
} from "../../../dcc/directorUnityLiveLinkContract";
import { directorControlPlaneFetch } from "./directorControlPlaneClient";

const engineHealthResponseSchema = z.strictObject({
  success: z.literal(true),
  result: directorDccEngineHealthSchema,
});

const unitySessionListResponseSchema = z.strictObject({
  success: z.literal(true),
  result: z.strictObject({ sessions: z.array(directorUnityLiveLinkSessionStatusSchema) }),
});

const unitySessionGrantResponseSchema = z.strictObject({
  success: z.literal(true),
  result: directorUnityLiveLinkSessionGrantSchema,
});

const unitySessionCloseResponseSchema = z.strictObject({
  success: z.literal(true),
  result: z.strictObject({ sessionId: z.string(), closed: z.literal(true) }),
});

const godotPreviewResponseSchema = z.strictObject({
  success: z.literal(true),
  result: directorGodotLiveLinkPreviewSchema,
});

const gatewayErrorSchema = z.looseObject({
  code: z.string().trim().min(1).optional(),
  error: z.string().trim().min(1).optional(),
});

/** Error thrown when the gateway rejects an engine handoff observation call. */
export class DirectorDccEngineHandoffClientError extends Error {
  /** HTTP status code from the gateway response. */
  readonly status: number;
  /** Machine-readable error code from the gateway. */
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "DirectorDccEngineHandoffClientError";
    this.status = status;
    this.code = code;
  }
}

async function responseJson(response: Response): Promise<unknown> {
  return response.json().catch(() => ({}));
}

function throwGatewayError(response: Response, body: unknown, fallback: string): never {
  const parsed = gatewayErrorSchema.safeParse(body);
  if (parsed.success && (parsed.data.error || parsed.data.code)) {
    throw new DirectorDccEngineHandoffClientError(parsed.data.error ?? fallback, response.status, parsed.data.code);
  }
  throw new DirectorDccEngineHandoffClientError(
    `${fallback}: gateway response did not match the Director DCC contract`,
    response.ok ? 502 : response.status,
    "invalid_response",
  );
}

/**
 * Reads the versioned engine connector health probe for one engine — the
 * same probe that gates `send_to_engine` — so the editor can render the
 * connector version, per-check details, warnings, and recovery steps without
 * triggering a failing send.
 *
 * @param provider - The engine connector to probe ("unreal", "unity", or "godot").
 * @param options - Optional abort signal for cancellation.
 * @returns The validated engine connector health result.
 */
export async function fetchDirectorDccEngineHealth(
  provider: DirectorDccEngineId,
  options: { signal?: AbortSignal } = {},
): Promise<DirectorDccEngineHealth> {
  const engine = directorDccEngineIdSchema.parse(provider);
  const response = await directorControlPlaneFetch(`/api/dcc/engines/${engine}/health`, { signal: options.signal });
  const body = await responseJson(response);
  const parsed = engineHealthResponseSchema.safeParse(body);
  if (parsed.success && response.ok) return parsed.data.result;
  return throwGatewayError(response, body, "Engine connector health probe failed");
}

/**
 * Lists Director-side Unity live-link preview sessions. Session summaries
 * never include the bearer token; the raw secret exists only in the one-time
 * creation grant.
 *
 * @param options - Optional abort signal for cancellation.
 * @returns The current session summaries (tokens are never included).
 */
export async function listDirectorUnityLiveLinkSessions(
  options: { signal?: AbortSignal } = {},
): Promise<DirectorUnityLiveLinkSessionStatus[]> {
  const response = await directorControlPlaneFetch("/api/dcc/unity/live-link/sessions", { signal: options.signal });
  const body = await responseJson(response);
  const parsed = unitySessionListResponseSchema.safeParse(body);
  if (parsed.success && response.ok) return parsed.data.result.sessions;
  return throwGatewayError(response, body, "Unity live-link session listing failed");
}

/**
 * Mints a new Unity live-link preview session. The returned grant carries the
 * scoped bearer token exactly once — hand it to the Unity Editor window and
 * never render it again; subsequent listings only expose session summaries.
 *
 * @param label - Optional human-readable session label.
 * @returns The one-time session grant with the scoped bearer token.
 */
export async function createDirectorUnityLiveLinkSession(label?: string): Promise<DirectorUnityLiveLinkSessionGrant> {
  const response = await directorControlPlaneFetch("/api/dcc/unity/live-link/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(label?.trim() ? { label: label.trim() } : {}),
  });
  const body = await responseJson(response);
  const parsed = unitySessionGrantResponseSchema.safeParse(body);
  if (parsed.success && response.ok) return parsed.data.result;
  return throwGatewayError(response, body, "Unity live-link session creation failed");
}

/**
 * Closes one Unity live-link preview session and wakes any pending poll.
 *
 * @param sessionId - The session to close.
 * @returns True when the session existed and is now closed.
 */
export async function closeDirectorUnityLiveLinkSession(sessionId: string): Promise<boolean> {
  const response = await directorControlPlaneFetch(
    `/api/dcc/unity/live-link/sessions/${encodeURIComponent(sessionId)}`,
    { method: "DELETE" },
  );
  const body = await responseJson(response);
  const parsed = unitySessionCloseResponseSchema.safeParse(body);
  if (parsed.success && response.ok) return true;
  return throwGatewayError(response, body, "Unity live-link session close failed");
}

/**
 * Reads the Gateway's in-memory Godot live-link preview snapshot. The
 * transport is outbound-only (Godot never listens on a port) and the snapshot
 * is pinned non-authoritative on the wire: it never mutates the project.
 *
 * @param options - Optional abort signal for cancellation.
 * @returns The validated preview snapshot with current sessions.
 */
export async function fetchDirectorGodotLiveLinkPreview(
  options: { signal?: AbortSignal } = {},
): Promise<DirectorGodotLiveLinkPreview> {
  const response = await directorControlPlaneFetch("/api/dcc/live-link/godot/preview", { signal: options.signal });
  const body = await responseJson(response);
  const parsed = godotPreviewResponseSchema.safeParse(body);
  if (parsed.success && response.ok) return parsed.data.result;
  return throwGatewayError(response, body, "Godot live-link preview read failed");
}
