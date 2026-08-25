import type { AgentProvider } from "@director/agent-engine";
import {
  publicAgentProfileSchema,
  type AgentRuntimeKind,
  type ModelCapabilities,
  type PublicAgentProfile,
} from "@director/agent-engine";
import {
  resolveHostedAgentProfileConfig,
  type DirectorControlPlaneConfig,
  type HostedAgentProfileConfig,
} from "../controlPlane/controlPlaneConfig";

/**
 * A fully resolved agent profile that pairs public metadata with the internal
 * provider binding and optional hosted configuration.
 */
export type ResolvedAgentProfile = {
  /** Public-facing profile sent to the UI. */
  public: PublicAgentProfile;
  /** The provider key used to select the adapter. */
  provider: AgentProvider;
  /** Server-side hosted configuration when the profile is API-backed. */
  hostedConfig?: HostedAgentProfileConfig;
};

/** Default capabilities for local (non-hosted) agent profiles. */
const LOCAL_CAPABILITIES: ModelCapabilities = {
  streaming: true,
  tools: true,
  parallelToolCalls: false,
  vision: true,
  jsonSchema: true,
  maxContextTokens: null,
  maxOutputTokens: null,
};

/**
 * Extracts the hostname from a URL string.
 *
 * @returns The hostname, or `null` when the value is not a valid URL.
 */
function hostFromUrl(value: string | undefined) {
  if (!value) return null;
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

/**
 * Returns whether the profile may be used without an API key — only
 * localhost-like endpoints are allowed to skip credentials.
 */
function permitsCredentiallessAccess(profile: HostedAgentProfileConfig) {
  if (profile.driver !== "openai-compatible") return false;
  try {
    return new Set(["127.0.0.1", "localhost", "::1", "[::1]"]).has(new URL(profile.baseUrl).hostname);
  } catch {
    return false;
  }
}

/**
 * Resolves a hosted profile into a {@link ResolvedAgentProfile} with
 * validated public metadata.
 */
function hostedProfile(profile: HostedAgentProfileConfig): ResolvedAgentProfile {
  const credentialConfigured = Boolean(profile.apiKey);
  return {
    provider: "api",
    hostedConfig: profile,
    public: publicAgentProfileSchema.parse({
      id: profile.id,
      label: profile.label,
      runtime: profile.runtime,
      model: profile.model,
      endpointHost: hostFromUrl(profile.baseUrl),
      credentialConfigured,
      available: credentialConfigured || permitsCredentiallessAccess(profile),
      capabilities: profile.capabilities,
    }),
  };
}

/**
 * Resolves a local agent runtime into a {@link ResolvedAgentProfile}.
 */
function localProfile(
  id: string,
  label: string,
  runtime: AgentRuntimeKind,
  provider: AgentProvider,
  available: boolean,
): ResolvedAgentProfile {
  return {
    provider,
    public: publicAgentProfileSchema.parse({
      id,
      label,
      runtime,
      model: null,
      endpointHost: null,
      credentialConfigured: true,
      available,
      capabilities: LOCAL_CAPABILITIES,
    }),
  };
}

/**
 * Server-owned model/runtime profile registry.
 *
 * No API secret is represented in the public metadata returned to callers;
 * credential fields are only used internally to determine availability.
 */
export class AgentProfileRegistry {
  /** All profiles keyed by their stable public id. */
  private readonly profiles = new Map<string, ResolvedAgentProfile>();

  /**
   * @param config - The Director control-plane configuration.
   * @param availability - Snapshot of which local CLIs are on PATH (`probeLocalAgentCliAvailability`).
   */
  constructor(config: DirectorControlPlaneConfig, availability: Record<AgentProvider, boolean>) {
    for (const profile of [
      localProfile("codex-local", "Codex · Local", "codex-app-server", "codex", availability.codex),
      localProfile("claude-local", "Claude · Local", "claude-stream-json", "claude", availability.claude),
    ]) {
      this.profiles.set(profile.public.id, profile);
    }
    // Legacy single-API config — kept for backward compatibility with older
    // control-plane files that only define a single `api` block.
    const legacyBaseUrl = config.agents.api.baseUrl;
    const legacyApiConfig = resolveHostedAgentProfileConfig({
      id: "api-default",
      label: config.agents.api.label,
      driver: "openai-compatible",
      baseUrl: legacyBaseUrl ?? "http://127.0.0.1",
      model: config.agents.api.model ?? "",
      apiKey: config.agents.api.apiKey,
      apiKeyEnv: "DIRECTOR_AGENT_API_KEY",
      maxToolRounds: config.agents.api.maxToolRounds,
    });
    const apiProfile = hostedProfile(legacyApiConfig);
    // Override the public profile computed by hostedProfile — the legacy path
    // uses a different availability heuristic based on model presence.
    apiProfile.public = publicAgentProfileSchema.parse({
      ...apiProfile.public,
      model: config.agents.api.model ?? null,
      endpointHost: hostFromUrl(legacyBaseUrl),
      available: Boolean(legacyBaseUrl && config.agents.api.model),
    });
    this.profiles.set(apiProfile.public.id, apiProfile);
    for (const profile of config.agents.profiles) {
      const entry = hostedProfile(profile);
      this.profiles.set(entry.public.id, entry);
    }
  }

  /**
   * Returns all public profiles.
   *
   * @returns An array of {@link PublicAgentProfile} — no server secrets are included.
   */
  list() {
    return [...this.profiles.values()].map((entry) => entry.public);
  }

  /**
   * Looks up a single profile by id.
   *
   * @param id - The stable profile id.
   * @returns The resolved profile, or `null` when not found.
   */
  get(id: string) {
    return this.profiles.get(id) ?? null;
  }

  /**
   * Replaces extra hosted profiles (everything except local CLIs and `api-default`).
   *
   * Used when the Agent workspace saves API providers at runtime so the
   * picker and session create path see the new models without a restart.
   *
   * @param profiles - Merged environment + user hosted profiles.
   */
  replaceExtraHostedProfiles(profiles: readonly HostedAgentProfileConfig[]) {
    for (const [id, entry] of [...this.profiles.entries()]) {
      if (entry.hostedConfig && id !== "api-default") this.profiles.delete(id);
    }
    for (const profile of profiles) {
      if (profile.id === "api-default") continue;
      this.profiles.set(profile.id, hostedProfile(profile));
    }
  }
}
