import {
  DIRECTOR_AGENT_WIRE_SCHEMAS,
  DIRECTOR_WORKBENCH_PLUGIN_TOOL_NAMES,
  DIRECTOR_WORKBENCH_PLUGIN_TOOLS,
} from "./catalog";
import { flattenDirectorToolResult } from "./flattenToolResult";
import { dispatchDirectorWorkbenchTool, type DirectorWorkbenchGatewayConfig } from "./gatewayClient";
import { DIRECTOR_AGENT_GUIDANCE } from "./guidance";
import { registerDirectorWorkspacePrompt } from "./workspacePrompt";
import { DIRECTOR_TOOL_TIMEOUT_MS, directorToolIsConcurrencySafe, dynamicToolTimeoutMs } from "./toolPolicy";
import { finalizeDirectorAgentToolEnvelope } from "./toolResultProjection";

type DirectorImageRef = {
  attachmentId: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  bytes: number;
  width: number;
  height: number;
  name?: string;
};

type DirectorContentBlock = { type: "text"; text: string } | { type: "image"; attachment: DirectorImageRef };

type DirectorToolExecution = {
  signal?: AbortSignal;
  agent?: {
    id?: string;
    options?: { provider?: string; model?: string };
    session?: { requestHeader?: () => { config?: { provider?: string; model?: string } } | undefined };
  };
};

type DirectorToolCallView = {
  card: "generic";
  title: string;
  kind?: "read" | "search" | "execute";
};

type DirectorWorkbenchToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  timeoutMs?: number;
  isConcurrencySafe?: (args: unknown) => boolean;
  presentCall?: (args: unknown) => DirectorToolCallView | undefined;
  output: {
    schema: Record<string, unknown>;
    render: (args: unknown, value: unknown) => DirectorContentBlock[];
  };
  execute: (args: unknown, exec?: DirectorToolExecution) => Promise<Record<string, unknown>>;
};

type DirectorAttachmentStore = {
  saveImage(input: {
    data: Uint8Array;
    mediaType: DirectorImageRef["mediaType"];
    name?: string;
  }): Promise<DirectorImageRef>;
};

type DirectorLlmRegistry = {
  listProviders(): readonly { id: string; name: string }[];
  listModels(provider: string): Promise<readonly DirectorLlmModelInfo[]>;
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<DirectorLlmModelInfo>;
};

type DirectorLlmModelInfo = {
  id?: string;
  name?: string;
  inputModalities?: readonly string[];
};

type DirectorSystemPrompt = {
  section(section: { name: string; order: number; text: string }): () => void;
};

type DirectorWebServer = {
  register(route: {
    kind: "exact";
    path: string;
    handler: (
      request: { method?: string },
      response: { writeHead(status: number, headers?: Record<string, string>): void; end(body?: string): void },
    ) => void;
  }): () => void;
};

export type DirectorWorkbenchDefineTool = (options: DirectorWorkbenchToolDefinition) => unknown;

export type DirectorWorkbenchPluginContext = {
  tools: { register: (tool: unknown) => void };
  get?: (service: string) => unknown;
  inject?: (
    services: string[],
    callback: (context: DirectorWorkbenchPluginContext & { webServer: DirectorWebServer }) => void,
  ) => void;
  effect?: (factory: () => () => void, label: string) => void;
  webServer?: DirectorWebServer;
};

export const DIRECTOR_DSH_HEALTH_PATH = "/director/health";
export const DIRECTOR_MODEL_ROUTES_TOOL_NAME = "director_model_routes";
export const DIRECTOR_DSH_TOOL_NAMES = [
  ...DIRECTOR_WORKBENCH_PLUGIN_TOOL_NAMES,
  DIRECTOR_MODEL_ROUTES_TOOL_NAME,
] as const;
export const DIRECTOR_DSH_HEALTH = {
  service: "director-deepseek-harness",
  version: 1,
  tools: DIRECTOR_DSH_TOOL_NAMES,
} as const;

function toolCallTitle(name: string, args: unknown): string {
  const op = args && typeof args === "object" && !Array.isArray(args) && "op" in args ? String(args.op) : "";
  return op ? `${name} ${op}` : name;
}

function presentDirectorCall(name: string, args: unknown): DirectorToolCallView {
  const title = toolCallTitle(name, args);
  const safe = directorToolIsConcurrencySafe(name, args);
  return { card: "generic", title, kind: safe ? "read" : "execute" };
}

const DIRECTOR_TOOL_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: true,
  properties: {
    success: { type: "boolean" },
    counts: { type: "object", additionalProperties: true },
    project_revision: { type: "string" },
    retrieval_hint: { type: "string" },
    receipt: { type: "object", additionalProperties: true },
    capture: { type: "object", additionalProperties: true },
    result: { type: "object", additionalProperties: true },
  },
} as const;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stripEncodedMediaPayloads(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripEncodedMediaPayloads);
  const candidate = record(value);
  if (!candidate) return value;
  const encodedMedia =
    typeof candidate.mimeType === "string" &&
    (typeof candidate.data === "string" || typeof candidate.dataBase64 === "string");
  return Object.fromEntries(
    Object.entries(candidate).flatMap(([key, nested]) =>
      encodedMedia && (key === "data" || key === "dataBase64") ? [] : [[key, stripEncodedMediaPayloads(nested)]],
    ),
  );
}

function imageRef(value: unknown): DirectorImageRef | undefined {
  const candidate = record(value);
  if (
    !candidate ||
    typeof candidate.attachmentId !== "string" ||
    !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(String(candidate.mediaType)) ||
    typeof candidate.bytes !== "number" ||
    typeof candidate.width !== "number" ||
    typeof candidate.height !== "number"
  ) {
    return undefined;
  }
  return candidate as DirectorImageRef;
}

function renderDirectorResult(value: unknown): DirectorContentBlock[] {
  const result = record(value) ?? {};
  const content: DirectorContentBlock[] = [{ type: "text", text: JSON.stringify(result) }];
  const capture = imageRef(result.capture);
  if (capture) content.push({ type: "image", attachment: capture });
  return content;
}

async function routeAcceptsImages(context: DirectorWorkbenchPluginContext, exec?: DirectorToolExecution) {
  const routed = exec?.agent?.session?.requestHeader?.()?.config;
  const provider = routed?.provider ?? exec?.agent?.options?.provider;
  const model = routed?.model ?? exec?.agent?.options?.model;
  const llm = context.get?.("llm") as DirectorLlmRegistry | undefined;
  if (!provider || !model || !llm) return false;
  const info = await llm.resolveModelInfo(provider, model, exec?.signal);
  return info.inputModalities?.includes("image") === true;
}

async function prepareDirectorResult(
  context: DirectorWorkbenchPluginContext,
  tool: string,
  args: unknown,
  body: Record<string, unknown>,
  exec?: DirectorToolExecution,
): Promise<Record<string, unknown>> {
  const capture = record(body.capture);
  const encoded = typeof capture?.data === "string" ? capture.data : capture?.dataBase64;
  let sanitizedBody = stripEncodedMediaPayloads(body) as Record<string, unknown>;
  if (capture && typeof encoded === "string" && typeof capture.mimeType === "string") {
    const data = Uint8Array.from(Buffer.from(encoded, "base64"));
    const mediaType = capture.mimeType;
    const captureSummary = (reason: string) => ({ mediaType, bytes: data.byteLength, image_attached: false, reason });
    if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mediaType)) {
      sanitizedBody = { ...sanitizedBody, capture: captureSummary(`Unsupported capture media type ${mediaType}`) };
    } else {
      const attachments = context.get?.("attachments") as DirectorAttachmentStore | undefined;
      if (!attachments) {
        sanitizedBody = {
          ...sanitizedBody,
          capture: captureSummary("DeepSeek Harness attachment storage is unavailable"),
        };
      } else if (!(await routeAcceptsImages(context, exec))) {
        sanitizedBody = {
          ...sanitizedBody,
          capture: captureSummary("The current model does not declare image input"),
        };
      } else {
        try {
          const attachment = await attachments.saveImage({
            data,
            mediaType: mediaType as DirectorImageRef["mediaType"],
            name: "director-capture.png",
          });
          sanitizedBody = { ...sanitizedBody, capture: attachment };
        } catch (error) {
          sanitizedBody = {
            ...sanitizedBody,
            capture: captureSummary(
              error instanceof Error ? error.message : "DeepSeek Harness could not store the capture",
            ),
          };
        }
      }
    }
  }
  const projected = await finalizeDirectorAgentToolEnvelope({ envelope: sanitizedBody, tool, input: args });
  return flattenDirectorToolResult(projected.envelope);
}

function currentModelRoute(exec?: DirectorToolExecution) {
  const routed = exec?.agent?.session?.requestHeader?.()?.config;
  const provider = routed?.provider ?? exec?.agent?.options?.provider;
  const model = routed?.model ?? exec?.agent?.options?.model;
  return provider && model ? { provider, model } : undefined;
}

function modelView(model: DirectorLlmModelInfo) {
  const inputModalities = model.inputModalities ? [...model.inputModalities] : undefined;
  return {
    id: model.id,
    name: model.name,
    ...(inputModalities ? { input_modalities: inputModalities } : {}),
    image_input: inputModalities?.includes("image") === true,
  };
}

function registerDirectorModelRoutes(context: DirectorWorkbenchPluginContext, defineTool: DirectorWorkbenchDefineTool) {
  context.tools.register(
    defineTool({
      name: DIRECTOR_MODEL_ROUTES_TOOL_NAME,
      description:
        "List exact LLM provider/model routes registered in this DeepSeek Harness process. " +
        "Use this before overriding a workflow or subagent route; omit provider/model to inherit the current route.",
      parameters: {},
      timeoutMs: DIRECTOR_TOOL_TIMEOUT_MS,
      isConcurrencySafe: () => true,
      presentCall: () => ({ card: "generic", title: DIRECTOR_MODEL_ROUTES_TOOL_NAME, kind: "read" }),
      output: {
        schema: { type: "object", additionalProperties: true },
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
      },
      async execute(_args, exec) {
        const llm = context.get?.("llm") as DirectorLlmRegistry | undefined;
        if (!llm) throw new Error("DeepSeek Harness LLM registry is unavailable");

        const providers = await Promise.all(
          llm.listProviders().map(async (provider) => ({
            id: provider.id,
            name: provider.name,
            models: (await llm.listModels(provider.id)).map(modelView),
          })),
        );
        const route = currentModelRoute(exec);
        const current = route
          ? {
              ...route,
              ...modelView(await llm.resolveModelInfo(route.provider, route.model, exec?.signal)),
            }
          : null;
        return {
          current,
          providers,
          guidance: "Omit provider/model to inherit the current route. Never guess provider or model ids.",
        };
      },
    }),
  );
}

function registerDirectorAgentGuidance(context: DirectorWorkbenchPluginContext) {
  const systemPrompt = context.get?.("systemPrompt") as DirectorSystemPrompt | undefined;
  systemPrompt?.section({
    name: "director:workbench",
    order: 113,
    text: DIRECTOR_AGENT_GUIDANCE,
  });
}

/** Registers a readable identity endpoint so Director never embeds an unrelated bare DSH instance. */
export function registerDirectorHarnessHealth(context: DirectorWorkbenchPluginContext) {
  context.inject?.(["webServer"], (httpContext) => {
    httpContext.effect?.(
      () =>
        httpContext.webServer.register({
          kind: "exact",
          path: DIRECTOR_DSH_HEALTH_PATH,
          handler(request, response) {
            if (request.method !== "GET" && request.method !== "HEAD") {
              response.writeHead(405, { "access-control-allow-origin": "*" });
              response.end();
              return;
            }
            response.writeHead(200, {
              "access-control-allow-origin": "*",
              "content-type": "application/json; charset=utf-8",
            });
            response.end(request.method === "HEAD" ? undefined : JSON.stringify(DIRECTOR_DSH_HEALTH));
          },
        }),
      "director-workbench: health route",
    );
  });
}

/**
 * Registers Stage, Canvas/Video, video-generation, and Blender tools on DSH.
 * DSH owns the loop and session; Director only validates and dispatches tools.
 */
export function registerDirectorWorkbenchPlugin(
  context: DirectorWorkbenchPluginContext,
  defineTool: DirectorWorkbenchDefineTool = (definition) => definition,
  config: DirectorWorkbenchGatewayConfig = {},
) {
  for (const tool of DIRECTOR_WORKBENCH_PLUGIN_TOOLS) {
    context.tools.register(
      defineTool({
        name: tool.name,
        description: tool.description,
        parameters: tool.dshParameters,
        timeoutMs: dynamicToolTimeoutMs(
          tool.name,
          tool.name === "director_creative"
            ? { op: "pipeline", request: { action: "start", await_completion: true } }
            : tool.name === "director_dcc"
              ? { op: "send_to_engine" }
              : { op: "observe" },
        ),
        isConcurrencySafe: (callArgs) => directorToolIsConcurrencySafe(tool.name, callArgs),
        presentCall: (callArgs) => presentDirectorCall(tool.name, callArgs),
        output: {
          schema: DIRECTOR_TOOL_OUTPUT_SCHEMA,
          render: (_args, value) => renderDirectorResult(value),
        },
        async execute(args, exec) {
          const parsed = DIRECTOR_AGENT_WIRE_SCHEMAS[tool.name].safeParse(args);
          if (!parsed.success) {
            throw new Error(
              `${tool.name} parameters are invalid: ${parsed.error.issues
                .map((issue) => `${issue.path.map(String).join(".") || "$"}: ${issue.message}`)
                .join("; ")}`,
            );
          }
          const result = await dispatchDirectorWorkbenchTool(
            tool.name,
            parsed.data,
            { ...config, ...(exec?.agent?.id ? { sessionId: exec.agent.id } : {}) },
            exec?.signal,
          );
          if (result.status >= 400 && result.body.success !== true) {
            throw new Error(
              typeof result.body.error === "string"
                ? result.body.error
                : `Director ${tool.name} failed with HTTP ${result.status}`,
            );
          }
          return prepareDirectorResult(context, tool.name, parsed.data, result.body, exec);
        },
      }),
    );
  }
  registerDirectorModelRoutes(context, defineTool);
  registerDirectorAgentGuidance(context);
  registerDirectorWorkspacePrompt(context, config);
  registerDirectorHarnessHealth(context);
}
