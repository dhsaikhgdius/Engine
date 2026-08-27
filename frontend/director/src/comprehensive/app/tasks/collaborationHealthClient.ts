import { z } from "zod";
import { directorControlPlaneFetch } from "../../editor/api/directorControlPlaneClient";

/**
 * Minimal client for the redacted collaboration stanza on unauthenticated
 * `GET /health`. Parses only `collaboration` with a strict Zod schema and
 * ignores unrelated health fields (ok, service, clients, sceneRecovery, …).
 *
 * @module collaborationHealthClient
 */

/** Fixed Limited-boundary transport facts mirrored from the gateway stanza. */
export const collaborationHealthTransportSchema = z
  .object({
    loopback_binding: z.boolean(),
    tls_termination: z.boolean(),
    multi_node: z.boolean(),
    member_identity: z.enum(["invite-capability", "local-trust"]),
  })
  .strict();

/** Public `/health.collaboration` payload the tray section renders. */
export const collaborationHealthStanzaSchema = z
  .object({
    mode: z.string().min(1),
    persistence: z.boolean(),
    empty_room_ttl_seconds: z.number().int().nonnegative(),
    invite_rate_limit_per_minute: z.number().int().nonnegative(),
    active_rooms: z.number().int().nonnegative(),
    retained_rooms: z.number().int().nonnegative(),
    transport: collaborationHealthTransportSchema,
  })
  .strict();

/** The redacted collaboration stanza. */
export type CollaborationHealthStanza = z.infer<typeof collaborationHealthStanzaSchema>;

/** Outer `/health` envelope: require collaboration, ignore everything else. */
const gatewayHealthCollaborationEnvelopeSchema = z
  .object({
    collaboration: collaborationHealthStanzaSchema,
  })
  .passthrough();

async function readJson(response: Response, fallbackMessage: string): Promise<Record<string, unknown>> {
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(typeof body.message === "string" ? body.message : `${fallbackMessage}（HTTP ${response.status}）`);
  }
  return body;
}

/**
 * Fetches `GET /health` and returns the validated collaboration stanza.
 *
 * @param signal - Optional AbortSignal for request cancellation.
 */
export async function fetchCollaborationHealth(signal?: AbortSignal): Promise<CollaborationHealthStanza> {
  const response = await directorControlPlaneFetch("/health", { signal });
  const body = await readJson(response, "协作健康信息请求失败");
  return gatewayHealthCollaborationEnvelopeSchema.parse(body).collaboration;
}
