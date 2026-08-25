import { z } from "zod";
import { FILM_ROLE_IDS, type FilmRoleId } from "@director/protocol/filmRoles";

const nonEmptyText = (maximum: number) => z.string().trim().min(1).max(maximum);

/** Filesystem-safe profile identifier: alphanumeric start, dots, dashes, and underscores allowed. */
export const agentProfileIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

/** Supported agent runtime backends — each maps to a distinct harness implementation. */
export const agentRuntimeKindSchema = z.enum([
  "codex-app-server",
  "claude-stream-json",
  "native-openai",
  "native-anthropic",
  "native-openai-compatible",
]);

/** A film production role id drawn from the shared film role registry. */
export const filmRoleIdSchema = z.enum(FILM_ROLE_IDS);
export type { FilmRoleId };

const agentRoleProfileMapShape = Object.fromEntries(
  filmRoleIdSchema.options.map((roleId) => [roleId, agentProfileIdSchema.optional()]),
) as Record<FilmRoleId, z.ZodOptional<typeof agentProfileIdSchema>>;

/** One shared strict contract for server config, API requests, and durable runs. */
export const agentRoleProfileMapSchema = z.strictObject(agentRoleProfileMapShape);

/** Capabilities a model advertises, used to route feature-gated tool calls. */
export const modelCapabilitiesSchema = z.strictObject({
  streaming: z.boolean(),
  tools: z.boolean(),
  parallelToolCalls: z.boolean(),
  vision: z.boolean(),
  jsonSchema: z.boolean(),
  maxContextTokens: z.number().int().positive().nullable(),
  maxOutputTokens: z.number().int().positive().nullable(),
});

/** Public profile metadata. Credentials and raw secret references never cross this boundary. */
export const publicAgentProfileSchema = z.strictObject({
  id: agentProfileIdSchema,
  label: nonEmptyText(160),
  runtime: agentRuntimeKindSchema,
  model: z.string().nullable(),
  endpointHost: z.string().nullable(),
  credentialConfigured: z.boolean(),
  available: z.boolean(),
  capabilities: modelCapabilitiesSchema,
});

/** Wire-visible runtime kind for a profile. */
export type AgentRuntimeKind = z.infer<typeof agentRuntimeKindSchema>;

/** Role-to-profile routing map as exposed on the wire. */
export type AgentRoleProfileMap = z.infer<typeof agentRoleProfileMapSchema>;

/** Model capabilities snapshot. */
export type ModelCapabilities = z.infer<typeof modelCapabilitiesSchema>;

/** Public profile payload — no credentials or raw secrets cross this boundary. */
export type PublicAgentProfile = z.infer<typeof publicAgentProfileSchema>;

/** Native HTTP driver used by hosted Agent API providers. */
export const hostedAgentDriverSchema = z.enum(["openai", "anthropic", "openai-compatible"]);

/** One model exposed by a user-configured API provider. */
export const publicAgentApiProviderModelSchema = z.strictObject({
  profileId: agentProfileIdSchema,
  model: nonEmptyText(240),
});

/**
 * Public API-provider record returned to the browser.
 * Base URL is shown so the user can edit it; credentials never cross this boundary.
 */
export const MAX_AGENT_API_PROVIDER_MODELS = 128;

export const publicAgentApiProviderSchema = z.strictObject({
  id: agentProfileIdSchema,
  label: nonEmptyText(160),
  driver: hostedAgentDriverSchema,
  baseUrl: z
    .string()
    .trim()
    .url()
    .refine((value) => value.startsWith("http://") || value.startsWith("https://"), "must be an HTTP(S) URL"),
  credentialConfigured: z.boolean(),
  models: z.array(publicAgentApiProviderModelSchema).max(MAX_AGENT_API_PROVIDER_MODELS),
});

/** Native HTTP driver identifier for a hosted Agent API. */
export type HostedAgentDriver = z.infer<typeof hostedAgentDriverSchema>;

/** One public model row under an API provider. */
export type PublicAgentApiProviderModel = z.infer<typeof publicAgentApiProviderModelSchema>;

/** Public API-provider payload — no credentials or raw secrets. */
export type PublicAgentApiProvider = z.infer<typeof publicAgentApiProviderSchema>;
