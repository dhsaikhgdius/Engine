import { chmod, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import {
  agentProfileIdSchema,
  hostedAgentDriverSchema,
  MAX_AGENT_API_PROVIDER_MODELS,
  publicAgentApiProviderSchema,
  type PublicAgentApiProvider,
} from "@director/agent-engine";
import { writeJsonAtomic } from "../atomicJsonFile";
import {
  RESERVED_AGENT_PROFILE_IDS,
  resolveHostedAgentProfileConfig,
  type HostedAgentProfileConfig,
} from "../controlPlane/controlPlaneConfig";

const httpUrlSchema = z
  .string()
  .trim()
  .url()
  .refine((value) => value.startsWith("http://") || value.startsWith("https://"), "must be an HTTP(S) URL");

const storedProviderSchema = z.strictObject({
  id: agentProfileIdSchema,
  label: z.string().trim().min(1).max(160),
  driver: hostedAgentDriverSchema,
  baseUrl: httpUrlSchema,
  apiKey: z.string().max(4_096).optional(),
  models: z.array(z.string().trim().min(1).max(240)).min(1).max(MAX_AGENT_API_PROVIDER_MODELS),
});

const storeDocumentSchema = z.strictObject({
  version: z.literal(1),
  providers: z.array(storedProviderSchema).max(16),
});

/** Persistable API provider, including the server-only credential. */
export type StoredAgentApiProvider = z.infer<typeof storedProviderSchema>;

/** Incoming save payload: empty `apiKey` keeps the previously stored credential. */
export const saveAgentApiProviderSchema = storedProviderSchema.extend({
  apiKey: z.string().max(4_096).optional(),
});

/** Full replace payload written by the Agent workspace settings UI. */
export const saveAgentApiProvidersRequestSchema = z.strictObject({
  providers: z.array(saveAgentApiProviderSchema).max(16),
});

const STORE_FILE = "agent-api-providers.json";

/**
 * Builds a filesystem-safe hosted profile id for one `(provider, model)` pair.
 *
 * @param providerId - The user-configured provider id.
 * @param model - The upstream model id, which may contain slashes.
 * @param used - Profile ids already claimed in this expansion.
 * @returns A unique id matching {@link agentProfileIdSchema}.
 */
export function hostedProfileIdForModel(providerId: string, model: string, used: Set<string>) {
  const sanitized =
    model
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "model";
  let base = `${providerId}.${sanitized}`.slice(0, 160);
  if (!/^[A-Za-z0-9]/.test(base)) base = `m.${base}`.slice(0, 160);
  let candidate = base;
  let serial = 2;
  while (used.has(candidate) || RESERVED_AGENT_PROFILE_IDS.has(candidate)) {
    const suffix = `-${serial}`;
    candidate = `${base.slice(0, Math.max(1, 160 - suffix.length))}${suffix}`;
    serial += 1;
  }
  used.add(candidate);
  return candidate;
}

/**
 * Expands saved API providers into one hosted profile per model.
 *
 * @param providers - Stored providers with credentials.
 * @returns Hosted profile configs ready for the registry and API adapter.
 */
export function expandAgentApiProvidersToHostedProfiles(
  providers: readonly StoredAgentApiProvider[],
): HostedAgentProfileConfig[] {
  const used = new Set<string>(RESERVED_AGENT_PROFILE_IDS);
  const profiles: HostedAgentProfileConfig[] = [];
  for (const provider of providers) {
    const models = [...new Set(provider.models.map((model) => model.trim()).filter(Boolean))];
    for (const model of models) {
      profiles.push(
        resolveHostedAgentProfileConfig({
          id: hostedProfileIdForModel(provider.id, model, used),
          label: provider.label,
          driver: provider.driver,
          baseUrl: provider.baseUrl,
          model,
          apiKey: provider.apiKey,
        }),
      );
    }
  }
  return profiles;
}

/**
 * Merges environment-backed hosted profiles with user-configured ones.
 * User profiles win on id collision, except reserved ids which stay env-owned.
 *
 * @param environmentProfiles - Profiles parsed from `DIRECTOR_AGENT_PROFILES_JSON`.
 * @param userProfiles - Profiles expanded from the persisted provider store.
 * @returns Deduplicated hosted profiles, environment first then user overlays.
 */
export function mergeHostedAgentProfiles(
  environmentProfiles: readonly HostedAgentProfileConfig[],
  userProfiles: readonly HostedAgentProfileConfig[],
) {
  const byId = new Map<string, HostedAgentProfileConfig>();
  for (const profile of environmentProfiles) byId.set(profile.id, profile);
  for (const profile of userProfiles) {
    if (RESERVED_AGENT_PROFILE_IDS.has(profile.id)) continue;
    byId.set(profile.id, profile);
  }
  return [...byId.values()];
}

function uniqueProviderIds(providers: readonly { id: string }[]) {
  const ids = new Set<string>();
  for (const provider of providers) {
    if (RESERVED_AGENT_PROFILE_IDS.has(provider.id)) {
      throw new Error(`API provider id ${provider.id} is reserved`);
    }
    if (ids.has(provider.id)) {
      throw new Error(`Duplicate API provider id ${provider.id}`);
    }
    ids.add(provider.id);
  }
}

function toPublicProvider(provider: StoredAgentApiProvider): PublicAgentApiProvider {
  const used = new Set<string>(RESERVED_AGENT_PROFILE_IDS);
  return publicAgentApiProviderSchema.parse({
    id: provider.id,
    label: provider.label,
    driver: provider.driver,
    baseUrl: provider.baseUrl.replace(/\/+$/, ""),
    credentialConfigured: Boolean(provider.apiKey?.trim()),
    models: [...new Set(provider.models.map((model) => model.trim()).filter(Boolean))].map((model) => ({
      profileId: hostedProfileIdForModel(provider.id, model, used),
      model,
    })),
  });
}

function mergeIncomingSecrets(
  incoming: z.infer<typeof saveAgentApiProviderSchema>[],
  existing: readonly StoredAgentApiProvider[],
): StoredAgentApiProvider[] {
  const previous = new Map(existing.map((provider) => [provider.id, provider]));
  return incoming.map((provider) => {
    const apiKey = provider.apiKey?.trim() || previous.get(provider.id)?.apiKey?.trim() || undefined;
    return storedProviderSchema.parse({
      id: provider.id,
      label: provider.label,
      driver: provider.driver,
      baseUrl: provider.baseUrl.replace(/\/+$/, ""),
      ...(apiKey ? { apiKey } : {}),
      models: [...new Set(provider.models.map((model) => model.trim()).filter(Boolean))],
    });
  });
}

/**
 * Durable store for user-configured Agent API providers.
 *
 * Secrets stay on disk under the data directory and are never included in
 * {@link AgentApiProviderStore.listPublic}. Empty `apiKey` on save keeps the
 * previously stored credential.
 */
export class AgentApiProviderStore {
  private providers: StoredAgentApiProvider[] = [];

  /**
   * @param dataDirectory - Director data directory (`DIRECTOR_DATA_DIRECTORY`).
   */
  constructor(private readonly dataDirectory: string) {}

  /** Absolute path of the persisted provider document. */
  get path() {
    return resolve(this.dataDirectory, STORE_FILE);
  }

  /**
   * Loads providers from disk. Missing files start as an empty list.
   *
   * @throws {Error} When the document exists but is not valid JSON or schema.
   */
  async load() {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.providers = [];
        return;
      }
      throw error;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `agent-api-providers.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const parsed = storeDocumentSchema.safeParse(decoded);
    if (!parsed.success) {
      throw new Error(`agent-api-providers.json is invalid: ${z.prettifyError(parsed.error)}`);
    }
    uniqueProviderIds(parsed.data.providers);
    this.providers = parsed.data.providers.map((provider) => ({
      ...provider,
      baseUrl: provider.baseUrl.replace(/\/+$/, ""),
      apiKey: provider.apiKey?.trim() || undefined,
    }));
  }

  /** Server-side snapshot including credentials. */
  list() {
    return this.providers.map((provider) => ({ ...provider, models: [...provider.models] }));
  }

  /** Browser-safe snapshot. Credentials are never included. */
  listPublic() {
    return this.providers.map((provider) => toPublicProvider(provider));
  }

  /**
   * Looks up a stored API key for fetch-models when the UI omits a new secret.
   *
   * @param providerId - The provider id.
   * @returns The stored key, or `undefined`.
   */
  getApiKey(providerId: string) {
    return this.providers.find((provider) => provider.id === providerId)?.apiKey;
  }

  /**
   * Replaces the provider list, keeping previous keys when the incoming key is blank.
   *
   * @param incoming - Providers from the settings UI.
   * @returns The public snapshot after the write.
   */
  async replace(incoming: z.infer<typeof saveAgentApiProviderSchema>[]) {
    uniqueProviderIds(incoming);
    const next = mergeIncomingSecrets(incoming, this.providers);
    await writeJsonAtomic(this.path, { version: 1, providers: next }, { space: 2, trailingNewline: true });
    await chmod(this.path, 0o600).catch(() => undefined);
    this.providers = next;
    return this.listPublic();
  }
}
