import { z } from "zod";
import { directorControlPlaneFetch, resetDirectorControlPlaneCredentials } from "../api/directorControlPlaneClient";

/** One live agent session as exposed by `GET /api/agent/sessions`. */
export const publicAgentSessionSchema = z.object({
  id: z.string().min(1),
  tool: z.string().min(1),
  status: z.enum(["active", "idle"]),
  last_active_at: z.string().min(1),
});

export type PublicAgentSession = z.infer<typeof publicAgentSessionSchema>;

/**
 * List agent sessions that recently drove the Director workbench, so the
 * character inspector can offer them for binding without hand-typed ids.
 *
 * @returns An array of live agent sessions, parsed and validated.
 */
export async function listAgentSessions(retryUnauthorized = true): Promise<PublicAgentSession[]> {
  const response = await directorControlPlaneFetch("/api/agent/sessions");
  if (response.status === 401 && retryUnauthorized) {
    resetDirectorControlPlaneCredentials();
    return listAgentSessions(false);
  }
  const value = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || !Array.isArray(value.sessions)) return [];
  const sessions: PublicAgentSession[] = [];
  for (const session of value.sessions) {
    const parsed = publicAgentSessionSchema.safeParse(session);
    if (parsed.success) sessions.push(parsed.data);
  }
  return sessions;
}
