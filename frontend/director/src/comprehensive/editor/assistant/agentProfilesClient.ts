import { publicAgentProfileSchema, type PublicAgentProfile } from "@director/agent-engine";
import { directorControlPlaneFetch, resetDirectorControlPlaneCredentials } from "../api/directorControlPlaneClient";

/**
 * List public agent profiles available for reconstruction and film planning.
 *
 * @returns An array of public agent profiles, parsed and validated.
 */
export async function listAgentProfiles(retryUnauthorized = true): Promise<PublicAgentProfile[]> {
  const response = await directorControlPlaneFetch("/api/agent/profiles");
  if (response.status === 401 && retryUnauthorized) {
    resetDirectorControlPlaneCredentials();
    return listAgentProfiles(false);
  }
  const value = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || !Array.isArray(value.profiles)) return [];
  const profiles: PublicAgentProfile[] = [];
  for (const profile of value.profiles) {
    const parsed = publicAgentProfileSchema.safeParse(profile);
    if (parsed.success) profiles.push(parsed.data);
  }
  return profiles;
}
