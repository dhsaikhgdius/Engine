import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  agentProfileIdSchema,
  agentRoleProfileMapSchema,
  hostedAgentDriverSchema,
  modelCapabilitiesSchema,
  type AgentRoleProfileMap,
  type HostedAgentDriver,
  type ModelCapabilities,
} from "@director/agent-engine";
import {
  ANTHROPIC_PROFILE,
  OPENAI_PROFILE,
  findBuiltinModelDescriptor,
} from "@director/model-provider/builtinProviders";
import {
  comfyNodeDefinitionSchema,
  type ComfyNodeDefinition,
} from "../../../packages/protocol/src/comfyGenerationProtocol";

export { agentRoleProfileMapSchema };
export type { AgentRoleProfileMap };

const optionalText = z.string().trim().min(1).optional();
const optionalHttpUrl = z
  .string()
  .trim()
  .url()
  .refine((value) => value.startsWith("http://") || value.startsWith("https://"), "must be an HTTP(S) URL")
  .optional();

const environmentSchema = z.looseObject({
  STAGE_GATEWAY_HOST: optionalText,
  STAGE_GATEWAY_PORT: optionalText,
  DIRECTOR_DATA_DIRECTORY: optionalText,
  DIRECTOR_BLENDER_URL: optionalHttpUrl,
  DIRECTOR_BLENDER_TOKEN: optionalText,
  DIRECTOR_BLENDER_TIMEOUT_MS: optionalText,
  DIRECTOR_AGENT_API_BASE_URL: optionalHttpUrl,
  DIRECTOR_AGENT_API_KEY: optionalText,
  DIRECTOR_AGENT_API_MODEL: optionalText,
  DIRECTOR_AGENT_API_LABEL: optionalText,
  DIRECTOR_AGENT_API_MAX_TOOL_ROUNDS: optionalText,
  DIRECTOR_AGENT_PROFILES_JSON: z.string().trim().min(1).max(262_144).optional(),
  DIRECTOR_AGENT_ROLE_PROFILES_JSON: z.string().trim().min(1).max(65_536).optional(),
  OPENAI_API_KEY: optionalText,
  OPENAI_BASE_URL: optionalHttpUrl,
  DIRECTOR_TRANSCRIPTION_BASE_URL: optionalHttpUrl,
  DIRECTOR_TRANSCRIPTION_API_KEY: optionalText,
  DIRECTOR_TRANSCRIPTION_MODEL: optionalText,
  DIRECTOR_TRANSCRIPTION_MAX_BYTES: optionalText,
  DIRECTOR_TRANSCRIPTION_TIMEOUT_MS: optionalText,
  DIRECTOR_TRANSCRIPTION_CHUNK_THRESHOLD_SECONDS: optionalText,
  DIRECTOR_TRANSCRIPTION_CHUNK_SECONDS: optionalText,
  DIRECTOR_TRANSCRIPTION_CHUNK_CONCURRENCY: optionalText,
  DIRECTOR_FFMPEG_PATH: optionalText,
  ANTHROPIC_API_KEY: optionalText,
  ANTHROPIC_BASE_URL: optionalHttpUrl,
  DIRECTOR_VIDEO_PROVIDER: z.enum(["comfyui", "ltx-2.3", "minimax-h3"]).optional(),
  DIRECTOR_ACCEPT_LTX2_LICENSE: optionalText,
  DIRECTOR_LTX2_SOURCE_DIR: optionalText,
  DIRECTOR_LTX23_MODEL: optionalText,
  DIRECTOR_LTX23_TIMEOUT_MS: optionalText,
  DIRECTOR_UV_BIN: optionalText,
  LTX23_DISTILLED_CHECKPOINT_PATH: optionalText,
  LTX23_SPATIAL_UPSAMPLER_PATH: optionalText,
  LTX23_GEMMA_ROOT: optionalText,
  LTX23_DEVICE: optionalText,
  LTX23_QUANTIZATION: optionalText,
  LTX23_OFFLOAD: optionalText,
  DIRECTOR_MINIMAX_API_KEY: optionalText,
  DIRECTOR_MINIMAX_BASE_URL: optionalHttpUrl,
  DIRECTOR_MINIMAX_VIDEO_MODEL: optionalText,
  DIRECTOR_ARDY_REPO: optionalText,
  DIRECTOR_ARDY_PYTHON: optionalText,
  DIRECTOR_ARDY_SSH_HOST: optionalText,
  DIRECTOR_ARDY_MODEL: optionalText,
  DIRECTOR_ARDY_TIMEOUT_MS: optionalText,
  COMFYUI_URL: optionalHttpUrl,
  COMFYUI_NODES_JSON: z.string().trim().min(1).max(262_144).optional(),
  COMFYUI_IMAGE_WORKFLOW_PATH: optionalText,
  COMFYUI_VIDEO_WORKFLOW_PATH: optionalText,
  COMFYUI_AUDIO_WORKFLOW_PATH: optionalText,
  DIRECTOR_GENERATION_POLL_MS: optionalText,
  DIRECTOR_GENERATION_TIMEOUT_MS: optionalText,
  DIRECTOR_3D_PROVIDER: z.enum(["meshy", "tripo", "infinigen"]).optional(),
  DIRECTOR_MESHY_API_KEY: optionalText,
  DIRECTOR_MESHY_BASE_URL: optionalHttpUrl,
  DIRECTOR_MESHY_MODEL: optionalText,
  DIRECTOR_TRIPO_API_KEY: optionalText,
  DIRECTOR_TRIPO_BASE_URL: optionalHttpUrl,
  DIRECTOR_TRIPO_MODEL: optionalText,
  DIRECTOR_INFINIGEN_PYTHON: optionalText,
  DIRECTOR_INFINIGEN_WORKDIR: optionalText,
  DIRECTOR_INFINIGEN_TEXTURE_RES: optionalText,
  DIRECTOR_SCENERECON_PYTHON: optionalText,
  DIRECTOR_SCENERECON_TIMEOUT_MS: optionalText,
  DIRECTOR_3D_POLL_MS: optionalText,
  DIRECTOR_3D_TIMEOUT_MS: optionalText,
  DIRECTOR_FILM_LLM_DRIVER: z.enum(["openai", "anthropic"]).optional(),
  DIRECTOR_FILM_LLM_BASE_URL: optionalHttpUrl,
  DIRECTOR_FILM_LLM_API_KEY: optionalText,
  DIRECTOR_FILM_LLM_MODEL: optionalText,
  DIRECTOR_FILM_IMAGE_BASE_URL: optionalHttpUrl,
  DIRECTOR_FILM_IMAGE_API_KEY: optionalText,
  DIRECTOR_FILM_IMAGE_MODEL: optionalText,
  DIRECTOR_FILM_VIDEO_BASE_URL: optionalHttpUrl,
  DIRECTOR_FILM_VIDEO_API_KEY: optionalText,
  DIRECTOR_FILM_VIDEO_MODEL: optionalText,
  DIRECTOR_FILM_IMAGE_CONCURRENCY: optionalText,
  DIRECTOR_FILM_VIDEO_CONCURRENCY: optionalText,
  DIRECTOR_FILM_VIDEO_TIMEOUT_MS: optionalText,
  DIRECTOR_FILM_VIDEO_POLL_MS: optionalText,
  DIRECTOR_FILM_TTS_BASE_URL: optionalHttpUrl,
  DIRECTOR_FILM_TTS_API_KEY: optionalText,
  DIRECTOR_FILM_TTS_MODEL: optionalText,
  DIRECTOR_FFPROBE_PATH: optionalText,
});

export { hostedAgentDriverSchema };
export type { HostedAgentDriver };

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const defaultArdyCheckout = join(repositoryRoot, "vendor/ardy");
const defaultLtx2Checkout = join(repositoryRoot, "vendor/ltx-2");
const ltx23GenerateScript = join(repositoryRoot, "tools/scripts/ltx23-generate.py");

/** Local ARDY submodule path when `scripts/generate.py` is present. SSH mode never uses this default. */
export function resolveDefaultArdyRepo(options: { sshHost?: string; checkout?: string } = {}): string | undefined {
  if (options.sshHost) return undefined;
  const checkout = options.checkout ?? defaultArdyCheckout;
  return existsSync(join(checkout, "scripts", "generate.py")) ? checkout : undefined;
}

/** Local LTX-2 submodule path when the official pipelines package is present. */
export function resolveDefaultLtx2Source(options: { checkout?: string } = {}): string | undefined {
  const checkout = options.checkout ?? defaultLtx2Checkout;
  return existsSync(join(checkout, "packages", "ltx-pipelines", "src", "ltx_pipelines")) ? checkout : undefined;
}

function existingPath(value: string | undefined, kind: "file" | "directory"): string | undefined {
  if (!value) return undefined;
  const path = resolve(value);
  try {
    const info = statSync(path);
    if (kind === "file" ? info.isFile() : info.isDirectory()) return path;
  } catch {
    return undefined;
  }
  return undefined;
}

function readLtx2LockMeta() {
  try {
    const lock = JSON.parse(readFileSync(join(repositoryRoot, "vendor/ltx-2.lock.json"), "utf8")) as {
      repository?: unknown;
      commit?: unknown;
      packages?: { "ltx-pipelines"?: unknown };
    };
    if (typeof lock.repository !== "string" || typeof lock.commit !== "string" || !/^[a-f0-9]{40}$/.test(lock.commit)) {
      return undefined;
    }
    return {
      repository: lock.repository,
      commit: lock.commit,
      pipelineVersion: typeof lock.packages?.["ltx-pipelines"] === "string" ? lock.packages["ltx-pipelines"] : undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * Default maximum number of tool-call round-trips a hosted agent may
 * execute before the harness forces a final response.
 */
export const DEFAULT_AGENT_MAX_TOOL_ROUNDS = 24;

/**
 * A partial role override table. Missing roles deliberately fall back to the
 * profile selected by the production run (and ultimately `api-default`).
 * Profile existence and availability are runtime concerns because credentials
 * and local provider health can change after configuration is parsed.
 */
const environmentVariableNameSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be an environment variable name")
  .max(160);

const hostedAgentProfileInputSchema = z.strictObject({
  id: agentProfileIdSchema,
  label: z.string().trim().min(1).max(160),
  driver: hostedAgentDriverSchema,
  baseUrl: optionalHttpUrl,
  model: z.string().trim().min(1).max(240),
  apiKeyEnv: environmentVariableNameSchema.optional(),
  maxToolRounds: z.number().int().min(1).max(48).optional(),
  capabilities: modelCapabilitiesSchema.partial().strict().optional(),
});

const hostedAgentProfilesInputSchema = z.array(hostedAgentProfileInputSchema).max(64);

/** Profile ids reserved for local CLIs and the legacy `api-default` slot. */
export const RESERVED_AGENT_PROFILE_IDS = new Set(["api-default", "codex-local", "claude-local"]);

const hostedAgentRuntimeSchema = z.enum(["native-openai", "native-anthropic", "native-openai-compatible"]);

/** Concrete runtime adapter bound to a {@link HostedAgentDriver} at config load time. */
export type HostedAgentRuntime = z.infer<typeof hostedAgentRuntimeSchema>;

/**
 * Fully resolved configuration for one hosted agent profile.
 *
 * Derived from user-supplied input merged with per-driver defaults —
 * base URLs are resolved, secrets are read from the environment, and
 * capabilities are layered so that profile overrides win over driver defaults.
 */
export type HostedAgentProfileConfig = {
  id: string;
  label: string;
  driver: HostedAgentDriver;
  runtime: HostedAgentRuntime;
  baseUrl: string;
  model: string;
  apiKey: string | undefined;
  apiKeyEnv: string;
  maxToolRounds: number;
  capabilities: ModelCapabilities;
};

const HOSTED_AGENT_DEFAULTS = {
  openai: {
    runtime: "native-openai",
    baseUrl: OPENAI_PROFILE.defaultBaseUrl,
    apiKeyEnv: OPENAI_PROFILE.apiKeyEnvironmentVariable,
    capabilities: {
      streaming: true,
      tools: true,
      parallelToolCalls: true,
      vision: true,
      jsonSchema: true,
      maxContextTokens: null,
      maxOutputTokens: null,
    },
  },
  anthropic: {
    runtime: "native-anthropic",
    baseUrl: ANTHROPIC_PROFILE.defaultBaseUrl,
    apiKeyEnv: ANTHROPIC_PROFILE.apiKeyEnvironmentVariable,
    capabilities: {
      streaming: true,
      tools: true,
      parallelToolCalls: true,
      vision: true,
      jsonSchema: false,
      maxContextTokens: null,
      maxOutputTokens: null,
    },
  },
  "openai-compatible": {
    runtime: "native-openai-compatible",
    baseUrl: "",
    apiKeyEnv: "DIRECTOR_AGENT_API_KEY",
    capabilities: {
      streaming: true,
      tools: true,
      parallelToolCalls: false,
      vision: false,
      jsonSchema: false,
      maxContextTokens: null,
      maxOutputTokens: null,
    },
  },
} satisfies Record<
  HostedAgentDriver,
  {
    runtime: HostedAgentRuntime;
    baseUrl: string;
    apiKeyEnv: string;
    capabilities: ModelCapabilities;
  }
>;

function resolveHostedModelCapabilities(
  driver: HostedAgentDriver,
  model: string,
  overrides: Partial<ModelCapabilities> | undefined,
): ModelCapabilities {
  const defaults = HOSTED_AGENT_DEFAULTS[driver].capabilities;
  const providerId = driver === "openai" ? "openai" : driver === "anthropic" ? "anthropic" : undefined;
  const descriptor = findBuiltinModelDescriptor(model, providerId);
  const known = descriptor?.capabilities;
  return modelCapabilitiesSchema.parse({
    ...defaults,
    ...(known
      ? {
          streaming: known.streaming,
          tools: known.tools,
          vision: known.images,
          maxContextTokens: known.maxContextTokens || null,
          maxOutputTokens: known.maxOutputTokens || null,
        }
      : {}),
    ...overrides,
  });
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function stripTrailingSlash(value: string | undefined) {
  return value?.replace(/\/+$/, "");
}

/**
 * Resolves a hosted Agent profile from an explicit base URL and optional API key.
 *
 * Used by both environment-backed `DIRECTOR_AGENT_PROFILES_JSON` entries and
 * user-configured providers persisted in the data directory.
 *
 * @param input - Driver, endpoint, model, and optional credential.
 * @returns A fully resolved {@link HostedAgentProfileConfig}.
 */
export function resolveHostedAgentProfileConfig(input: {
  id: string;
  label: string;
  driver: HostedAgentDriver;
  baseUrl: string;
  model: string;
  apiKey?: string;
  apiKeyEnv?: string;
  maxToolRounds?: number;
  capabilities?: Partial<ModelCapabilities>;
}): HostedAgentProfileConfig {
  const defaults = HOSTED_AGENT_DEFAULTS[input.driver];
  const baseUrl = stripTrailingSlash(input.baseUrl);
  if (!baseUrl) {
    throw new Error(`Hosted Agent profile ${input.id} requires baseUrl`);
  }
  return {
    id: input.id,
    label: input.label,
    driver: input.driver,
    runtime: defaults.runtime,
    baseUrl,
    model: input.model,
    apiKey: input.apiKey?.trim() || undefined,
    apiKeyEnv: input.apiKeyEnv ?? defaults.apiKeyEnv,
    maxToolRounds: input.maxToolRounds ?? DEFAULT_AGENT_MAX_TOOL_ROUNDS,
    capabilities: resolveHostedModelCapabilities(input.driver, input.model, input.capabilities),
  };
}

function readEnvironmentSecret(environment: NodeJS.ProcessEnv, name: string) {
  if (!Object.prototype.hasOwnProperty.call(environment, name)) return undefined;
  const value = environment[name];
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function parseComfyNodes(raw: string | undefined, fallbackBaseUrl: string | undefined): ComfyNodeDefinition[] {
  if (!raw) {
    return fallbackBaseUrl
      ? [
          comfyNodeDefinitionSchema.parse({
            id: "comfy-default",
            label: "ComfyUI",
            baseUrl: fallbackBaseUrl,
            enabled: true,
            maxConcurrent: 1,
          }),
        ]
      : [];
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (error) {
    throw new Error(`COMFYUI_NODES_JSON is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = z.array(comfyNodeDefinitionSchema).min(1).max(64).safeParse(decoded);
  if (!parsed.success) throw new Error(`COMFYUI_NODES_JSON is invalid: ${z.prettifyError(parsed.error)}`);
  const ids = new Set<string>();
  return parsed.data.map((node) => {
    if (ids.has(node.id)) throw new Error(`COMFYUI_NODES_JSON contains duplicate node id ${node.id}`);
    ids.add(node.id);
    return { ...node, baseUrl: stripTrailingSlash(node.baseUrl)! };
  });
}

function parseHostedAgentProfiles(raw: string | undefined, environment: NodeJS.ProcessEnv): HostedAgentProfileConfig[] {
  if (!raw) return [];
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `DIRECTOR_AGENT_PROFILES_JSON is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = hostedAgentProfilesInputSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new Error(`DIRECTOR_AGENT_PROFILES_JSON is invalid: ${z.prettifyError(parsed.error)}`);
  }
  const ids = new Set<string>();
  return parsed.data.map((profile) => {
    if (RESERVED_AGENT_PROFILE_IDS.has(profile.id)) {
      throw new Error(`DIRECTOR_AGENT_PROFILES_JSON profile id ${profile.id} is reserved`);
    }
    if (ids.has(profile.id)) {
      throw new Error(`DIRECTOR_AGENT_PROFILES_JSON contains duplicate profile id ${profile.id}`);
    }
    ids.add(profile.id);
    const defaults = HOSTED_AGENT_DEFAULTS[profile.driver];
    const configuredBaseUrl =
      profile.baseUrl ??
      (profile.driver === "openai"
        ? environment.OPENAI_BASE_URL?.trim()
        : profile.driver === "anthropic"
          ? environment.ANTHROPIC_BASE_URL?.trim()
          : undefined) ??
      defaults.baseUrl;
    if (!configuredBaseUrl) {
      throw new Error(`DIRECTOR_AGENT_PROFILES_JSON profile ${profile.id} requires baseUrl`);
    }
    const apiKeyEnv = profile.apiKeyEnv ?? defaults.apiKeyEnv;
    const apiKey = readEnvironmentSecret(environment, apiKeyEnv);
    return resolveHostedAgentProfileConfig({
      id: profile.id,
      label: profile.label,
      driver: profile.driver,
      baseUrl: configuredBaseUrl,
      model: profile.model,
      apiKey,
      apiKeyEnv,
      maxToolRounds: profile.maxToolRounds,
      capabilities: profile.capabilities,
    });
  });
}

/**
 * Parses the per-role agent profile mapping from the
 * {@code DIRECTOR_AGENT_ROLE_PROFILES_JSON} environment variable.
 *
 * Roles not listed here fall back to the profile selected by the
 * production run. This is a partial override table, not a complete
 * assignment.
 *
 * @param raw - The raw JSON string from the environment, or undefined.
 * @returns A validated {@link AgentRoleProfileMap} (empty object when no
 *          override is configured).
 * @throws {Error} When the JSON is malformed or fails schema validation.
 */
export function parseAgentRoleProfileMap(raw: string | undefined): AgentRoleProfileMap {
  if (!raw) return {};
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `DIRECTOR_AGENT_ROLE_PROFILES_JSON is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = agentRoleProfileMapSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new Error(`DIRECTOR_AGENT_ROLE_PROFILES_JSON is invalid: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/**
 * The complete, validated Director control-plane configuration.
 *
 * Every backend integration setting flows through this single struct so
 * that UI code never reads provider secrets and backend services do not
 * reach into {@code process.env} independently.
 */
export type DirectorControlPlaneConfig = ReturnType<typeof loadDirectorControlPlaneConfig>;

/**
 * Parses every backend integration setting once. UI code never reads provider
 * secrets and backend services do not reach into `process.env` independently.
 */
export function loadDirectorControlPlaneConfig(workspaceRoot: string, environment: NodeJS.ProcessEnv = process.env) {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) {
    throw new Error(`Director control-plane configuration is invalid: ${z.prettifyError(parsed.error)}`);
  }
  const values = parsed.data;
  const host = values.STAGE_GATEWAY_HOST ?? "127.0.0.1";
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(host)) {
    throw new Error(
      `Refusing to expose the Director control plane on non-loopback host ${host}; configure a real authenticated reverse proxy instead.`,
    );
  }

  const ltxLicenseAccepted = values.DIRECTOR_ACCEPT_LTX2_LICENSE === "1";
  const ltx2SourceRoot = ltxLicenseAccepted
    ? (existingPath(values.DIRECTOR_LTX2_SOURCE_DIR, "directory") ?? resolveDefaultLtx2Source())
    : undefined;
  const ltx23 = {
    sourceRoot: ltx2SourceRoot,
    distilledCheckpointPath: existingPath(values.LTX23_DISTILLED_CHECKPOINT_PATH, "file"),
    spatialUpsamplerPath: existingPath(values.LTX23_SPATIAL_UPSAMPLER_PATH, "file"),
    gemmaRoot: existingPath(values.LTX23_GEMMA_ROOT, "directory"),
    generateScript: ltx23GenerateScript,
    uvBinary: values.DIRECTOR_UV_BIN ?? "uv",
    model: values.DIRECTOR_LTX23_MODEL ?? "ltx-2.3-22b",
    timeoutMs: boundedInteger(values.DIRECTOR_LTX23_TIMEOUT_MS, 60 * 60_000, 30_000, 6 * 60 * 60_000),
    device: values.LTX23_DEVICE,
    quantization: values.LTX23_QUANTIZATION,
    offload: values.LTX23_OFFLOAD ?? "none",
    ...readLtx2LockMeta(),
  };
  const ltx23Configured = Boolean(
    ltx23.sourceRoot && ltx23.distilledCheckpointPath && ltx23.spatialUpsamplerPath && ltx23.gemmaRoot,
  );
  const comfyBaseUrl = stripTrailingSlash(values.COMFYUI_URL);
  const comfyNodes = parseComfyNodes(values.COMFYUI_NODES_JSON, comfyBaseUrl);
  const transcriptionApiKey = values.DIRECTOR_TRANSCRIPTION_API_KEY ?? values.OPENAI_API_KEY;
  const transcriptionBaseUrl = stripTrailingSlash(
    values.DIRECTOR_TRANSCRIPTION_BASE_URL ??
      values.OPENAI_BASE_URL ??
      (transcriptionApiKey ? "https://api.openai.com/v1" : undefined),
  );
  const configuredDefault = values.DIRECTOR_VIDEO_PROVIDER;
  const defaultVideoProvider =
    configuredDefault ?? (ltx23Configured ? "ltx-2.3" : values.DIRECTOR_MINIMAX_API_KEY ? "minimax-h3" : "comfyui");
  const legacyAgentApi = {
    baseUrl: stripTrailingSlash(values.DIRECTOR_AGENT_API_BASE_URL),
    apiKey: values.DIRECTOR_AGENT_API_KEY,
    model: values.DIRECTOR_AGENT_API_MODEL,
    label: values.DIRECTOR_AGENT_API_LABEL ?? "OpenAI-compatible API",
    maxToolRounds: boundedInteger(values.DIRECTOR_AGENT_API_MAX_TOOL_ROUNDS, DEFAULT_AGENT_MAX_TOOL_ROUNDS, 1, 48),
  };
  const hostedProfiles = parseHostedAgentProfiles(values.DIRECTOR_AGENT_PROFILES_JSON, environment);
  const roleProfiles = parseAgentRoleProfileMap(values.DIRECTOR_AGENT_ROLE_PROFILES_JSON);
  const defaultGenerated3DProvider = values.DIRECTOR_3D_PROVIDER ?? (values.DIRECTOR_MESHY_API_KEY ? "meshy" : "tripo");

  // Film pipeline provider fallbacks: one OpenRouter-style key can drive
  // planning, image and video generation from a single account.
  const filmLlmDriver = values.DIRECTOR_FILM_LLM_DRIVER ?? "openai";
  const filmLlmApiKey =
    values.DIRECTOR_FILM_LLM_API_KEY ??
    (filmLlmDriver === "anthropic" ? values.ANTHROPIC_API_KEY : values.OPENAI_API_KEY);
  const filmLlmBaseUrl = stripTrailingSlash(
    values.DIRECTOR_FILM_LLM_BASE_URL ??
      (filmLlmDriver === "anthropic"
        ? (values.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com")
        : (values.OPENAI_BASE_URL ?? (filmLlmApiKey ? "https://api.openai.com/v1" : undefined))),
  );
  const filmImageApiKey = values.DIRECTOR_FILM_IMAGE_API_KEY ?? values.DIRECTOR_FILM_LLM_API_KEY;
  const filmImageBaseUrl = stripTrailingSlash(
    values.DIRECTOR_FILM_IMAGE_BASE_URL ?? (filmImageApiKey ? "https://openrouter.ai/api/v1" : undefined),
  );
  const filmVideoApiKey = values.DIRECTOR_FILM_VIDEO_API_KEY ?? values.DIRECTOR_FILM_LLM_API_KEY;
  const filmVideoBaseUrl = stripTrailingSlash(
    values.DIRECTOR_FILM_VIDEO_BASE_URL ?? (filmVideoApiKey ? "https://openrouter.ai/api/v1" : undefined),
  );
  // Dialogue TTS is optional; it falls back to the OpenAI credentials that
  // already drive transcription so one key can cover speech both ways.
  const filmTtsApiKey = values.DIRECTOR_FILM_TTS_API_KEY ?? values.OPENAI_API_KEY;
  const filmTtsBaseUrl = stripTrailingSlash(
    values.DIRECTOR_FILM_TTS_BASE_URL ??
      values.OPENAI_BASE_URL ??
      (filmTtsApiKey ? "https://api.openai.com/v1" : undefined),
  );

  return {
    workspaceRoot: resolve(workspaceRoot),
    dataDirectory: resolve(workspaceRoot, values.DIRECTOR_DATA_DIRECTORY ?? "data"),
    http: {
      host,
      port: boundedInteger(values.STAGE_GATEWAY_PORT, 8787, 1, 65_535),
    },
    agents: {
      api: legacyAgentApi,
      profiles: hostedProfiles,
      roleProfiles,
    },
    dcc: {
      blender: {
        baseUrl: stripTrailingSlash(values.DIRECTOR_BLENDER_URL) ?? "http://127.0.0.1:8791",
        token: values.DIRECTOR_BLENDER_TOKEN,
        timeoutMs: boundedInteger(values.DIRECTOR_BLENDER_TIMEOUT_MS, 4_000, 250, 60_000),
      },
    },
    video: {
      defaultProvider: defaultVideoProvider,
      ltx23,
      comfyui: {
        baseUrl: comfyBaseUrl,
        workflowPath: values.COMFYUI_VIDEO_WORKFLOW_PATH,
      },
      minimax: {
        baseUrl: stripTrailingSlash(values.DIRECTOR_MINIMAX_BASE_URL) ?? "https://api.minimax.io",
        apiKey: values.DIRECTOR_MINIMAX_API_KEY,
        model: values.DIRECTOR_MINIMAX_VIDEO_MODEL ?? "MiniMax-H3",
      },
    },
    motion: {
      ardy: {
        repo: values.DIRECTOR_ARDY_REPO ?? resolveDefaultArdyRepo({ sshHost: values.DIRECTOR_ARDY_SSH_HOST }),
        python: values.DIRECTOR_ARDY_PYTHON ?? "python3",
        sshHost: values.DIRECTOR_ARDY_SSH_HOST,
        model: values.DIRECTOR_ARDY_MODEL ?? "core8",
        timeoutMs: boundedInteger(values.DIRECTOR_ARDY_TIMEOUT_MS, 10 * 60_000, 30_000, 60 * 60_000),
      },
    },
    transcription: {
      provider: "openai-compatible" as const,
      baseUrl: transcriptionBaseUrl,
      apiKey: transcriptionApiKey,
      model: values.DIRECTOR_TRANSCRIPTION_MODEL ?? "whisper-1",
      maxInputBytes: boundedInteger(
        values.DIRECTOR_TRANSCRIPTION_MAX_BYTES,
        100 * 1024 * 1024,
        64 * 1024,
        1024 * 1024 * 1024,
      ),
      timeoutMs: boundedInteger(values.DIRECTOR_TRANSCRIPTION_TIMEOUT_MS, 30 * 60_000, 10_000, 2 * 60 * 60_000),
      chunkThresholdSec: boundedInteger(
        values.DIRECTOR_TRANSCRIPTION_CHUNK_THRESHOLD_SECONDS,
        15 * 60,
        60,
        24 * 60 * 60,
      ),
      chunkDurationSec: boundedInteger(values.DIRECTOR_TRANSCRIPTION_CHUNK_SECONDS, 10 * 60, 60, 30 * 60),
      chunkConcurrency: boundedInteger(values.DIRECTOR_TRANSCRIPTION_CHUNK_CONCURRENCY, 2, 1, 4),
      ffmpegPath: values.DIRECTOR_FFMPEG_PATH ?? "ffmpeg",
    },
    generation: {
      comfyui: {
        nodes: comfyNodes,
        imageWorkflowPath: values.COMFYUI_IMAGE_WORKFLOW_PATH,
        videoWorkflowPath: values.COMFYUI_VIDEO_WORKFLOW_PATH,
        audioWorkflowPath: values.COMFYUI_AUDIO_WORKFLOW_PATH,
        pollIntervalMs: boundedInteger(values.DIRECTOR_GENERATION_POLL_MS, 750, 100, 10_000),
        timeoutMs: boundedInteger(values.DIRECTOR_GENERATION_TIMEOUT_MS, 30 * 60_000, 10_000, 24 * 60 * 60_000),
      },
      generated3d: {
        defaultProvider: defaultGenerated3DProvider,
        pollIntervalMs: boundedInteger(values.DIRECTOR_3D_POLL_MS, 2_000, 250, 30_000),
        timeoutMs: boundedInteger(values.DIRECTOR_3D_TIMEOUT_MS, 30 * 60_000, 10_000, 24 * 60 * 60_000),
        providers: {
          meshy: {
            id: "meshy",
            label: "Meshy",
            baseUrl: stripTrailingSlash(values.DIRECTOR_MESHY_BASE_URL) ?? "https://api.meshy.ai",
            apiKey: values.DIRECTOR_MESHY_API_KEY,
            modelVersion: values.DIRECTOR_MESHY_MODEL ?? "latest",
          },
          tripo: {
            id: "tripo",
            label: "Tripo",
            baseUrl: stripTrailingSlash(values.DIRECTOR_TRIPO_BASE_URL) ?? "https://api.tripo3d.ai/v2/openapi",
            apiKey: values.DIRECTOR_TRIPO_API_KEY,
            modelVersion: values.DIRECTOR_TRIPO_MODEL ?? null,
          },
          infinigen: {
            id: "infinigen",
            label: "Infinigen（本地程序化）",
            pythonBin: values.DIRECTOR_INFINIGEN_PYTHON,
            workDir: resolve(
              workspaceRoot,
              values.DIRECTOR_INFINIGEN_WORKDIR ?? resolve(values.DIRECTOR_DATA_DIRECTORY ?? "data", "infinigen-jobs"),
            ),
            textureResolution: boundedInteger(values.DIRECTOR_INFINIGEN_TEXTURE_RES, 1_024, 128, 4_096),
            runnerScript: resolve(workspaceRoot, "integrations", "infinigen", "director_infinigen_runner.py"),
            catalogPath: resolve(workspaceRoot, "integrations", "infinigen", "factory_catalog.json"),
          },
        },
      },
    },
    film: {
      llm: {
        driver: filmLlmDriver,
        baseUrl: filmLlmBaseUrl,
        apiKey: filmLlmApiKey,
        model: values.DIRECTOR_FILM_LLM_MODEL ?? values.DIRECTOR_AGENT_API_MODEL,
      },
      image: {
        baseUrl: filmImageBaseUrl,
        apiKey: filmImageApiKey,
        model: values.DIRECTOR_FILM_IMAGE_MODEL ?? "openai/gpt-image-2",
      },
      video: {
        baseUrl: filmVideoBaseUrl,
        apiKey: filmVideoApiKey,
        model: values.DIRECTOR_FILM_VIDEO_MODEL ?? "google/veo-3.1-lite",
      },
      imageConcurrency: boundedInteger(values.DIRECTOR_FILM_IMAGE_CONCURRENCY, 4, 1, 16),
      videoConcurrency: boundedInteger(values.DIRECTOR_FILM_VIDEO_CONCURRENCY, 2, 1, 8),
      videoTimeoutMs: boundedInteger(values.DIRECTOR_FILM_VIDEO_TIMEOUT_MS, 20 * 60_000, 60_000, 4 * 60 * 60_000),
      videoPollMs: boundedInteger(values.DIRECTOR_FILM_VIDEO_POLL_MS, 10_000, 1_000, 120_000),
      ffmpegPath: values.DIRECTOR_FFMPEG_PATH ?? "ffmpeg",
      ffprobePath: values.DIRECTOR_FFPROBE_PATH ?? "ffprobe",
      tts: {
        baseUrl: filmTtsBaseUrl,
        apiKey: filmTtsApiKey,
        model: values.DIRECTOR_FILM_TTS_MODEL ?? "gpt-4o-mini-tts",
      },
    },
    reconstruction: {
      pythonBin: values.DIRECTOR_SCENERECON_PYTHON ?? "python3",
      workerDir: resolve(workspaceRoot, "backend", "inference", "scenerecon", "src"),
      timeoutMs: boundedInteger(values.DIRECTOR_SCENERECON_TIMEOUT_MS, 10 * 60_000, 60_000, 2 * 60 * 60_000),
    },
  } as const;
}

/**
 * Derives a public-facing capabilities map from the full control-plane
 * configuration, stripping every secret and credential.
 *
 * The returned value is safe to expose over the HTTP API and to the
 * browser UI for capability discovery and provider status display.
 *
 * @param config - The full control-plane configuration returned by
 *   {@link loadDirectorControlPlaneConfig}.
 * @returns A versioned, read-only capabilities object with no secrets.
 */
export function publicControlPlaneCapabilities(config: DirectorControlPlaneConfig) {
  return {
    version: 1,
    agents: {
      api: {
        configured: Boolean(config.agents.api.baseUrl && config.agents.api.model),
        label: config.agents.api.label,
        model: config.agents.api.model ?? null,
      },
      profiles: config.agents.profiles.map((profile) => ({
        id: profile.id,
        label: profile.label,
        driver: profile.driver,
        model: profile.model,
        endpointHost: new URL(profile.baseUrl).host,
        credentialConfigured: Boolean(profile.apiKey),
        capabilities: profile.capabilities,
      })),
    },
    video: {
      defaultProvider: config.video.defaultProvider,
      providers: {
        "ltx-2.3": {
          configured: Boolean(
            config.video.ltx23.sourceRoot &&
              config.video.ltx23.distilledCheckpointPath &&
              config.video.ltx23.spatialUpsamplerPath &&
              config.video.ltx23.gemmaRoot,
          ),
          model: config.video.ltx23.model,
        },
        comfyui: {
          configured: Boolean(config.video.comfyui.baseUrl && config.video.comfyui.workflowPath),
        },
        "minimax-h3": {
          configured: Boolean(config.video.minimax.apiKey),
          model: config.video.minimax.model,
          endpointHost: new URL(config.video.minimax.baseUrl).host,
        },
      },
    },
    motion: {
      ardy: {
        configured: Boolean(config.motion.ardy.repo),
        model: config.motion.ardy.model,
        remote: Boolean(config.motion.ardy.sshHost),
      },
    },
    transcription: {
      configured: Boolean(config.transcription.baseUrl),
      provider: config.transcription.provider,
      model: config.transcription.model,
      endpointHost: config.transcription.baseUrl ? new URL(config.transcription.baseUrl).host : null,
      credentialConfigured: Boolean(config.transcription.apiKey),
      maxInputBytes: config.transcription.maxInputBytes,
      supportsSegments: true,
      supportsVtt: true,
      supportsLongMedia: true,
      longMediaStrategy: "adaptive-chunking",
      chunkThresholdSec: config.transcription.chunkThresholdSec,
      chunkDurationSec: config.transcription.chunkDurationSec,
      chunkConcurrency: config.transcription.chunkConcurrency,
    },
    dcc: {
      blender: {
        configured: Boolean(config.dcc.blender.baseUrl),
        endpointHost: new URL(config.dcc.blender.baseUrl).host,
      },
    },
    generation: {
      comfyui: {
        configured: config.generation.comfyui.nodes.length > 0,
        nodeCount: config.generation.comfyui.nodes.length,
        imageWorkflowConfigured: Boolean(config.generation.comfyui.imageWorkflowPath),
        videoWorkflowConfigured: Boolean(config.generation.comfyui.videoWorkflowPath),
        audioWorkflowConfigured: Boolean(config.generation.comfyui.audioWorkflowPath),
      },
      generated3d: {
        defaultProvider: config.generation.generated3d.defaultProvider,
        providers: Object.values(config.generation.generated3d.providers).map((provider) => ({
          id: provider.id,
          label: provider.label,
          configured: "apiKey" in provider ? Boolean(provider.apiKey) : Boolean(provider.pythonBin),
          modelVersion: "modelVersion" in provider ? provider.modelVersion : null,
        })),
      },
    },
    film: {
      configured:
        Boolean(config.film.llm.baseUrl && config.film.llm.model) &&
        Boolean(config.film.image.baseUrl) &&
        Boolean(config.film.video.baseUrl),
      llm: {
        driver: config.film.llm.driver,
        model: config.film.llm.model ?? null,
        endpointHost: config.film.llm.baseUrl ? new URL(config.film.llm.baseUrl).host : null,
        credentialConfigured: Boolean(config.film.llm.apiKey),
      },
      image: {
        model: config.film.image.model,
        endpointHost: config.film.image.baseUrl ? new URL(config.film.image.baseUrl).host : null,
        credentialConfigured: Boolean(config.film.image.apiKey),
      },
      video: {
        model: config.film.video.model,
        endpointHost: config.film.video.baseUrl ? new URL(config.film.video.baseUrl).host : null,
        credentialConfigured: Boolean(config.film.video.apiKey),
      },
      tts: {
        configured: Boolean(config.film.tts.baseUrl),
        model: config.film.tts.model,
        endpointHost: config.film.tts.baseUrl ? new URL(config.film.tts.baseUrl).host : null,
        credentialConfigured: Boolean(config.film.tts.apiKey),
      },
    },
  } as const;
}
