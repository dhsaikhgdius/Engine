import {
  DIRECTOR_AGENT_WIRE_SCHEMAS,
  DIRECTOR_WORKBENCH_PLUGIN_TOOL_NAMES,
  DIRECTOR_WORKBENCH_PLUGIN_TOOLS,
} from "./catalog";
import { dispatchDirectorWorkbenchTool, type DirectorWorkbenchGatewayConfig } from "./gatewayClient";
import { flattenDirectorToolResult } from "./flattenToolResult";

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

type DirectorWorkbenchToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
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

const DIRECTOR_AGENT_GUIDANCE = `Use Director's typed tools for Stage, Canvas, Video Editor, generation, and Blender work.

- Subagents and workflows inherit the current provider and model when provider/model are omitted. Omit them by default.
- If a different model capability is required, call director_model_routes and copy an exact registered provider/model pair. Never guess route ids.
- A workflow result of null means its child failed; it is not a successful or empty QA result.
- Claim a mutation only when its typed Director or Blender tool returned success in the current run. Shell output, including echo, todo status, plans, and intended calls are never mutation evidence. Report failed calls even when a later retry succeeds.
- Do not mark a creative todo complete until its mutation receipt and requested audit or capture have succeeded. Never claim a workspace was changed without calling its typed operation.
- Stage geometry comes from catalog meshes, blender_native, or generated_3d. Public director_workbench author calls that set geometry_type are rejected; do not assemble a location from Stage boxes.
- White-box is a metric clay look with readable silhouettes, not a modeling method and not a pile of primitives. Search the catalog first and place matches with author.add_object (imported architecture keeps modelNormalization "preserve"). Model missing architecture with blender_native create_blockout (presets floor/wall/room/corridor/stairs, metres, wallThickness; stable ids "<idPrefix>:1..n"); cut doors/windows with create_opening or a BOOLEAN modifier, never a darker box on a wall. In create_primitive, dimensions is the only metric size and grounded:true sets the floor pivot.
- Judge white-box appearance through a named 35-65mm camera at roughly 1.8x subject height distance (pitch under ~15 degrees) with capture or author.evidence, checking massing hierarchy, openings, and ground contact.
- For a new Blender edit, send blender_native apply with operations only; the Gateway supplies the scene epoch, revision, and intent id.
- Prefer typed blender_native ops. {"op":"query","query":"清华"} finds Blender objects by name. polyhaven_search then apply polyhaven_import for CC0 HDRIs, textures, and models. sketchfab_search/sketchfab_import need SKETCHFAB_API_TOKEN. Native stills are blender_native {"op":"capture"} or {"op":"capture_render"}. invoke_operator covers most Blender RNA including import/export/render. execute_code runs Python in the live scene when a typed op or operator is not enough. Do not wrap blender_native inside the code tool. Do not quit Blender.
- Blender is the modeling kernel of the same Director project. Its successful edits synchronize back automatically. Never export GLB/base64 and re-import it through director_creative interchange to "return" Blender work to Director.
- Use director_creative describe before an unfamiliar creative request. Do not guess interchange payload shapes or workspace paths.
- If web_search reports a missing provider credential, do not repeat the same call. Explain that search needs its own configured provider, then use known URLs with web_fetch or continue without search.
- Call Director tools as tools.director_workbench({...}) and tools.blender_native({...}). Do not wrap them in the DSH code tool. Zero-argument tools must be called as tools.get_goal({}) or tools.director_model_routes({}); omitting the argument is not lossless JSON. blender_native apply exposes receipt and metrics on the tool result; never return undefined from the code tool.
- Stage deletion is director_workbench author delete_objects with object_ids. remove_object with id is accepted. Catalog Stage objects remain after Blender execute_code deletes bpy objects.
- If observe/audit reports workbench_connected:false, the Stage tab is gone. Counts may come from the last persisted project or the live Blender kernel. Mutations and capture still need a visible Stage tab. Prefer blender_native scene/inspect for live native geometry.
- assign_material reuses existing Blender materials by exact, case, or separator-insensitive name. Omitted createIfMissing creates a Principled material. createIfMissing:false skips a still-missing name without aborting the batch. inspect lists sceneMaterials.
- Director audit ready=true is structural validation only. A visual claim requires an actual image block returned by capture. If capture reports image_attached=false, no visual inspection occurred.`;

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
  body: Record<string, unknown>,
  exec?: DirectorToolExecution,
): Promise<Record<string, unknown>> {
  const capture = record(body.capture);
  const encoded = typeof capture?.data === "string" ? capture.data : capture?.dataBase64;
  const sanitizedBody = stripEncodedMediaPayloads(body) as Record<string, unknown>;
  if (!capture || typeof encoded !== "string" || typeof capture.mimeType !== "string") {
    return flattenDirectorToolResult(sanitizedBody);
  }
  const data = Uint8Array.from(Buffer.from(encoded, "base64"));
  const mediaType = capture.mimeType;
  const captureSummary = (reason: string) => ({ mediaType, bytes: data.byteLength, image_attached: false, reason });
  if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mediaType)) {
    return flattenDirectorToolResult({
      ...sanitizedBody,
      capture: captureSummary(`Unsupported capture media type ${mediaType}`),
    });
  }
  const attachments = context.get?.("attachments") as DirectorAttachmentStore | undefined;
  if (!attachments) {
    return flattenDirectorToolResult({
      ...sanitizedBody,
      capture: captureSummary("DeepSeek Harness attachment storage is unavailable"),
    });
  }
  if (!(await routeAcceptsImages(context, exec))) {
    return flattenDirectorToolResult({
      ...sanitizedBody,
      capture: captureSummary("The current model does not declare image input"),
    });
  }
  try {
    const attachment = await attachments.saveImage({
      data,
      mediaType: mediaType as DirectorImageRef["mediaType"],
      name: "director-capture.png",
    });
    return flattenDirectorToolResult({ ...sanitizedBody, capture: attachment });
  } catch (error) {
    return flattenDirectorToolResult({
      ...sanitizedBody,
      capture: captureSummary(error instanceof Error ? error.message : "DeepSeek Harness could not store the capture"),
    });
  }
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
        output: {
          schema: { type: "object", additionalProperties: true },
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
          return prepareDirectorResult(context, result.body, exec);
        },
      }),
    );
  }
  registerDirectorModelRoutes(context, defineTool);
  registerDirectorAgentGuidance(context);
  registerDirectorHarnessHealth(context);
}
