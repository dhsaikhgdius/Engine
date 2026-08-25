/** Browser-safe provider identifiers shared by UI, gateway schemas, and planners. */
export const DIRECTOR_AGENT_IDS = ["codex", "claude"] as const;

/** A provider identifier drawn from the canonical agent list. */
export type DirectorAgentId = (typeof DIRECTOR_AGENT_IDS)[number];

/**
 * Durable Agent Session providers. The API harness is deliberately not part of
 * `DIRECTOR_AGENT_IDS`: that older list also drives interactive PTYs and the
 * legacy JSON planner, both of which require a locally installed CLI.
 */
export const DIRECTOR_SESSION_PROVIDER_IDS = [...DIRECTOR_AGENT_IDS, "api"] as const;

/** A durable session provider identifier, including the API harness not in the legacy agent list. */
export type DirectorSessionProviderId = (typeof DIRECTOR_SESSION_PROVIDER_IDS)[number];
