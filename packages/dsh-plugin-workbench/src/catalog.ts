import { z } from "zod";
import {
  directorObjectSpatialQuerySchema,
  directorWorkbenchCatalogIdSchema,
  directorWorkbenchOperationSchema,
} from "@director/agent-engine";
import { directorDccOperationSchema } from "@director/dcc-protocol";
import { creativeWorkspaceAgentRequestSchema } from "@director/protocol/creative-workspace";
import { blenderNativeToolRequestSchema } from "@director/protocol/blender-live";
import { videoModelOperationSchema, videoProviderIdSchema } from "@director/protocol/video-generation";
import { directorGameOperationSchema } from "@director/protocol/director-game";
import { gameSliceGenreSchema, gameSliceIdSchema } from "@director/protocol/game-slice";

type OperationUnionSchema = {
  options: ReadonlyArray<{ shape: { op: { value: string } } }>;
};

type JsonSchemaRecord = Record<string, unknown>;

function jsonSchemaRecord(value: unknown): JsonSchemaRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonSchemaRecord) : undefined;
}

function dshSchemaNode(value: unknown): JsonSchemaRecord {
  const source = jsonSchemaRecord(value);
  if (!source) return {};
  const result: JsonSchemaRecord = {};
  for (const annotation of ["description", "title", "default", "examples"] as const) {
    if (source[annotation] !== undefined) result[annotation] = source[annotation];
  }
  if (Array.isArray(source.oneOf)) {
    result.oneOf = source.oneOf.map(dshSchemaNode);
    return result;
  }
  if (typeof source.type !== "string") return result;
  result.type = source.type;
  if (Array.isArray(source.enum)) result.enum = source.enum;
  if (source.const !== undefined) result.const = source.const;
  if (source.type === "object") {
    const properties = jsonSchemaRecord(source.properties);
    result.properties = Object.fromEntries(
      Object.entries(properties ?? {}).map(([key, schema]) => [key, dshSchemaNode(schema)]),
    );
    if (Array.isArray(source.required)) result.required = source.required;
    result.additionalProperties = source.additionalProperties === false ? false : true;
  }
  if (source.type === "array") {
    const itemSchema = source.items ?? (Array.isArray(source.prefixItems) ? source.prefixItems[0] : undefined);
    if (itemSchema !== undefined) result.items = dshSchemaNode(itemSchema);
  }
  return result;
}

/** Projects Zod JSON Schema into the smaller JSON Schema subset enforced by DSH. */
export function dshToolParameters(inputSchema: unknown): JsonSchemaRecord {
  const parameters = dshSchemaNode(inputSchema);
  if (parameters.type !== "object") throw new Error("Director DSH tool parameters must use an object root");
  return parameters;
}

/** Returns the operation names from a Zod discriminated union. */
export function operationNames(schema: OperationUnionSchema): [string, ...string[]] {
  return schema.options.map((option) => option.shape.op.value) as [string, ...string[]];
}

/**
 * Creates the compact model-facing envelope for a domain tool. The Gateway
 * still validates every call against the complete strict operation schema;
 * `describe` and `capabilities` fill in fields that are not already on this envelope.
 */
export function compactWireSchema(schema: OperationUnionSchema, description: string) {
  return z.looseObject({ op: z.enum(operationNames(schema)).describe(description) });
}

const directorWorkbenchWireSchema = compactWireSchema(
  directorWorkbenchOperationSchema,
  'Operation. Use {"op":"describe","target":"<op>"}, target "author.<action>", or target "author.evidence" when exact fields are unknown. Other fields ride alongside op and are strictly validated by the Gateway.',
).extend({
  // pilot reuses target as an [x,y,z] look-at point; the union keeps that valid.
  target: z
    .union([z.string(), z.array(z.number())])
    .optional()
    .describe(
      'Required for op="describe": the operation or author action to reflect, e.g. "capture", "author.add_object", or "author.evidence". (op="pilot" set_view instead uses target as an [x,y,z] look-at point.)',
    ),
  catalog: directorWorkbenchCatalogIdSchema
    .optional()
    .describe('Required for op="catalog". Use catalog, never target, collection, source, or catalog_type.'),
  query: z
    .string()
    .optional()
    .describe('Search text for op="catalog"; Chinese matches indexed names, aliases, and tags.'),
  spatial: directorObjectSpatialQuerySchema.optional().describe('Selector for op="query_objects".'),
  name_pattern: z
    .string()
    .optional()
    .describe(
      'Top-level selector for op="query_objects": case-insensitive substring of the object name or id (Chinese ok, e.g. "门" matches "木门").',
    ),
  kind: z
    .enum(["character", "scene", "prop", "camera", "panorama"])
    .optional()
    .describe('Top-level object-kind selector for op="query_objects"; also the asset-kind filter for op="catalog".'),
  max_results: z.number().int().min(1).max(200).optional().describe('Result bound for op="query_objects".'),
  actions: z
    .array(z.looseObject({ action: z.string().min(1) }))
    .optional()
    .describe('Required for op="author". Deletion is delete_objects with object_ids (remove_object + id is accepted).'),
  evidence: z
    .looseObject({})
    .optional()
    .describe(
      'Optional post-commit visual proof for op="author". An object, never a boolean: {} captures a clean 640x360 frame through the active camera. Optional fields via {"op":"describe","target":"author.evidence"}.',
    ),
  fields: z.array(z.string()).optional().describe("Optional observe fields, e.g. counts, ui, objects."),
  since_revision: z
    .string()
    .optional()
    .describe(
      'For op="observe": return only persisted changes since this project_revision from a recent response (excludes ui).',
    ),
  object_mode: z
    .enum(["flat", "hierarchy"])
    .optional()
    .describe('For op="observe" with fields ["objects"]: "hierarchy" returns the parent-child scene graph.'),
  max_objects: z.number().int().min(1).max(500).optional().describe('Object bound for op="observe".'),
  max_changes: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe('Per-collection change bound for op="observe" with since_revision.'),
  entity: z
    .enum([
      "object",
      "light",
      "camera",
      "asset",
      "catalog_asset",
      "storyboard_shot",
      "performance_take",
      "coverage_sequence",
      "coverage_shot",
    ])
    .optional()
    .describe('Required with id for op="inspect", e.g. {"op":"inspect","entity":"object","id":"door-1"}.'),
  object_id: z.string().optional().describe("Object id for inspect or a single-object author action."),
  id: z.string().optional(),
  camera_id: z.string().optional(),
  frame: z.number().int().optional(),
});

const directorCreativeWireSchema = compactWireSchema(
  creativeWorkspaceAgentRequestSchema,
  'Operation. Use {"op":"describe","target":"interchange"} when a request shape is unknown. Other fields ride alongside op and are strictly validated by the Gateway.',
).extend({
  target: z.string().trim().min(1).max(200).optional().describe('Required for op="describe".'),
  operation: z
    .looseObject({ op: z.string().min(1) })
    .optional()
    .describe('Required for op="execute".'),
  steps: z
    .array(z.looseObject({ operation: z.looseObject({ op: z.string().min(1) }).optional() }))
    .optional()
    .describe('Required for op="execute_batch".'),
  request: z
    .looseObject({ action: z.string().min(1) })
    .optional()
    .describe(
      'Required for op="interchange", "collaboration", and "pipeline": the action envelope, e.g. {"op":"interchange","request":{"action":"capabilities"}}. Exact fields via {"op":"describe","target":"interchange"}.',
    ),
});

export const DIRECTOR_AGENT_WIRE_SCHEMAS = {
  director_workbench: directorWorkbenchWireSchema.superRefine((value, context) => {
    if (value.op === "catalog" && value.catalog === undefined) {
      context.addIssue({ code: "custom", path: ["catalog"], message: 'catalog is required when op is "catalog"' });
    }
  }),
  director_creative: directorCreativeWireSchema.superRefine((value, context) => {
    if (value.op === "describe" && value.target === undefined) {
      context.addIssue({ code: "custom", path: ["target"], message: 'target is required when op is "describe"' });
    }
  }),
  stage_video: compactWireSchema(
    videoModelOperationSchema,
    "Operation. Use capabilities for providers and parameters; prepare validates, submit starts a durable job, and status polls it.",
  ).extend({
    prompt: z.string().optional().describe("Prompt for prepare/submit when the provider needs one."),
    job_id: z
      .string()
      .optional()
      .describe('Required for op="submit", "status", and "cancel": the video-… job id returned by prepare.'),
    provider: videoProviderIdSchema
      .optional()
      .describe('Provider for op="prepare"/"render"; omit to use the default provider from capabilities.'),
    duration_s: z.number().optional().describe("Clip length in seconds (0.5-30) for prepare/render."),
    width: z
      .number()
      .int()
      .optional()
      .describe("Output width in pixels (256-4096) for prepare/render; the gateway snaps provider multiples."),
    height: z
      .number()
      .int()
      .optional()
      .describe("Output height in pixels (256-4096) for prepare/render; the gateway snaps provider multiples."),
  }),
  blender_native: compactWireSchema(
    blenderNativeToolRequestSchema,
    'Operation. apply executes typed ops including polyhaven_import and sketchfab_import; {"op":"query","query":"清华"} finds Blender objects by name; polyhaven_search/sketchfab_search list CC0 or Sketchfab models; capture and capture_render take a native still; scene reads native state; {"op":"describe","target":"create_primitive"} reflects typed apply schemas without a live kernel.',
  ).extend({
    operations: z
      .array(z.looseObject({ op: z.string().min(1) }))
      .optional()
      .describe(
        'Required for op="apply". Typed ops include create_blockout (white-box shells: presets floor/wall/room/corridor/stairs, metres), create_opening (door/window holes), create_primitive (dimensions + grounded), polyhaven_import, sketchfab_import, execute_code.',
      ),
    operator: z.string().optional().describe('RNA id for op="describe", e.g. mesh.bevel.'),
    target: z
      .string()
      .optional()
      .describe('Typed apply op for op="describe", e.g. create_primitive or polyhaven_import.'),
    query: z
      .string()
      .optional()
      .describe(
        'When op="query", Blender object name substring (e.g. "清华"). Also search text for catalog, polyhaven_search, and sketchfab_search.',
      ),
    name_pattern: z
      .string()
      .optional()
      .describe('Accepted alias of query for op="query": object name substring lifted to a NAME query.'),
    queries: z
      .array(z.looseObject({ kind: z.string().min(1) }))
      .optional()
      .describe('Spatial or NAME queries for op="query". Prefer query:"清华" for a name search.'),
    id: z.string().optional().describe('Object id for op="inspect".'),
    cameraId: z.string().optional().describe('Camera id for op="capture" or capture_render.'),
    width: z.number().int().optional(),
    height: z.number().int().optional(),
    assetType: z.enum(["hdris", "textures", "models", "all"]).optional().describe('For op="polyhaven_search".'),
    uid: z.string().optional().describe("Sketchfab model uid for sketchfab_import."),
  }),
  director_dcc: compactWireSchema(
    directorDccOperationSchema,
    'Operation. Call {"op":"discover"} first: it reports installed, exchangeReady, nativeReady, and capability maturity per provider. Other fields ride alongside op and are strictly validated by the Gateway.',
  ).extend({
    provider: z
      .string()
      .optional()
      .describe(
        "Provider id. send_to_engine / receive_from_engine / extract_engine_scene use unreal, unity, or godot; apply_import_plan also accepts blender (its default); status and export_exchange_package accept any discovered provider id.",
      ),
    package_dir: z
      .string()
      .optional()
      .describe(
        'Required for receive_from_engine and import_return_package: the return package directory from the send receipt (e.g. "JOB_ID/return").',
      ),
    project_dir: z
      .string()
      .optional()
      .describe(
        "Required for extract_engine_scene: the engine project directory inside the workspace or DIRECTOR_ENGINE_PROJECT_ROOT.",
      ),
    scene: z
      .string()
      .optional()
      .describe(
        'Optional scene for extract_engine_scene: "/Game/Maps/Set" (unreal), "Assets/Scenes/Main.unity" (unity), or "res://scenes/main.tscn" (godot).',
      ),
    plan_id: z
      .string()
      .optional()
      .describe("Required for apply_engine_scene_import and apply_blend_scene_import: the planId from the preview."),
    expected_revision: z
      .string()
      .optional()
      .describe("Revision guard for apply operations: the project_revision the plan was built against."),
    idempotency_key: z
      .string()
      .optional()
      .describe("Apply operations: a unique key for this intent; reuse it only to replay the identical apply."),
    clean_frame: z
      .boolean()
      .optional()
      .describe("send_to_engine, Unreal only: also render one clean still (no gizmos) and attach its receipt."),
    headless: z
      .boolean()
      .optional()
      .describe("run_engine_project: run without a window; the bounded debug-output capture is unchanged."),
    label: z.string().optional().describe("start_engine_session: optional engine workshop label."),
    port: z.number().int().optional().describe("start_engine_session, Unreal only: live-preview listener port."),
    allow_code: z
      .boolean()
      .optional()
      .describe("start_engine_session: explicit local grant for C#, GDScript, or Editor Python execute_code."),
    authority: z
      .enum(["director", "engine"])
      .optional()
      .describe("start_engine_session: engine enables repeated engine → Director review sync."),
    session_id: z.string().optional().describe("Engine session id returned by start_engine_session."),
    command: z
      .enum(["capture_frame", "execute_code", "sync_scene"])
      .optional()
      .describe("engine_session_command: capture, execute, or snapshot the already-open editor."),
    code: z
      .string()
      .optional()
      .describe("execute_code: C# for Unity, GDScript for Godot, or Editor Python for Unreal."),
    command_id: z.string().optional().describe("engine_session_command_status: id returned by engine_session_command."),
    camera: z.string().optional().describe("render_engine_frame or capture_frame: camera name/id."),
    width: z.number().int().optional(),
    height: z.number().int().optional(),
  }),
  director_game: compactWireSchema(
    directorGameOperationSchema,
    'Operation. Use {"op":"capabilities"} or {"op":"describe","target":"plan"} when fields are unknown. Stage is the first playable runtime; engine export is director_dcc after a playable receipt.',
  ).extend({
    target: z.string().optional().describe('Required for op="describe", e.g. "plan" or "playtest".'),
    slice_id: gameSliceIdSchema
      .optional()
      .describe("Existing slice id for observe/bind/playtest/evaluate/export_slice."),
    brief: z
      .looseObject({ requirement: z.string().min(1), genre: gameSliceGenreSchema })
      .optional()
      .describe('Required for op="plan": requirement plus genre. Exact fields via describe target "plan".'),
    bindings: z
      .array(z.looseObject({ role_id: z.string().min(1) }))
      .optional()
      .describe('Required for op="bind": role_id plus object_id from the Stage scene.'),
    script: z
      .looseObject({ steps: z.array(z.looseObject({})).min(1) })
      .optional()
      .describe('Required for op="playtest": held-input tape. A compile is not a playtest.'),
    trace: z.looseObject({}).optional().describe("Optional host-free playtest samples when no Stage tab is attached."),
    provider: z
      .enum(["godot", "unity", "unreal"])
      .optional()
      .describe('For op="export_slice": godot, unity, or unreal. "stage" is not an export provider.'),
  }),
} as const;

/** Director-owned tools mounted onto DeepSeek Harness. Generic coding/web/job tools stay in DSH. */
export const DIRECTOR_WORKBENCH_PLUGIN_TOOLS = [
  {
    type: "function" as const,
    name: "director_creative",
    description:
      'Control Canvas, generation pipelines, Video Editor, interchange, collaboration comments, and versions. Observe current IDs and state with exactly {"op":"observe"}; it does not accept fields. Describe an unfamiliar request when its fields are unknown, for example {"op":"describe","target":"interchange"}.',
    inputSchema: z.toJSONSchema(DIRECTOR_AGENT_WIRE_SCHEMAS.director_creative),
    dshParameters: dshToolParameters(z.toJSONSchema(DIRECTOR_AGENT_WIRE_SCHEMAS.director_creative)),
  },
  {
    type: "function" as const,
    name: "director_workbench",
    description:
      'Control the live Director 3D workbench. Do not assemble scenes from geometry_type primitives; instance catalog or project_assets meshes, model unique geometry with blender_native, or generate with generated_3d. Catalog exactly with {"op":"catalog","catalog":"assets"}; catalog is assets, character_assets, character_motions, or project_assets and never uses target. For active camera and totals, call observe with fields ["counts","ui"] and copy result.counts verbatim. For bounded camera context, call query_objects with spatial {"mode":"frustum","camera_id":"..."} and max_results (1-200). Common edits: update_object is {"action":"update_object","object_id":"...","patch":{...}}; update_camera also puts fields in patch; compose_blocking spacing_m is 0.9-8. Use author for scene edits and call describe when an action\'s exact fields are unknown; describe author.evidence for inline visual proof. Capture, delivery, and diagnostics are available when the user asks for them.',
    inputSchema: z.toJSONSchema(directorWorkbenchWireSchema),
    dshParameters: dshToolParameters(z.toJSONSchema(directorWorkbenchWireSchema)),
  },
  {
    type: "function" as const,
    name: "stage_video",
    description:
      "Discover video providers or prepare, submit, inspect and cancel a durable video-generation job. Prefer capabilities first; LTX-2.3 spatial and temporal constraints are resolved by the gateway.",
    inputSchema: z.toJSONSchema(DIRECTOR_AGENT_WIRE_SCHEMAS.stage_video),
    dshParameters: dshToolParameters(z.toJSONSchema(DIRECTOR_AGENT_WIRE_SCHEMAS.stage_video)),
  },
  {
    type: "function" as const,
    name: "blender_native",
    description:
      'Operate Blender\'s native modeling and rig surface in the same Director project. Use this for unique architecture and set pieces that are not in the catalog; successful edits synchronize automatically, never via GLB re-import. White-box shells use apply create_blockout (presets floor/wall/room/corridor/stairs, metric metres, stable ids "<idPrefix>:1..n"); door/window holes use create_opening on the wall, never a darker box. Call scene when object IDs are unknown. Search CC0 assets with {"op":"polyhaven_search","assetType":"models","query":"chair"} then apply polyhaven_import. Sketchfab needs SKETCHFAB_API_TOKEN. Native stills are {"op":"capture"} or the alias {"op":"capture_render"}. Describe typed apply ops with {"op":"describe","target":"create_blockout"} when a field is unknown. invoke_operator covers most Blender RNA; execute_code runs Python when that is not enough. Missing scene epoch, revision, and intent id are filled by the gateway.',
    inputSchema: z.toJSONSchema(DIRECTOR_AGENT_WIRE_SCHEMAS.blender_native),
    dshParameters: dshToolParameters(z.toJSONSchema(DIRECTOR_AGENT_WIRE_SCHEMAS.blender_native)),
  },
  {
    type: "function" as const,
    name: "director_game",
    description:
      'Plan and playtest a typed game slice on the live Director Stage. Start with {"op":"capabilities"} or {"op":"describe","target":"plan"}; bind Stage object ids before playtest; a scripted input tape is playability evidence, not a compile. Engine export is director_dcc after status playable — do not dump engine source.',
    inputSchema: z.toJSONSchema(DIRECTOR_AGENT_WIRE_SCHEMAS.director_game),
    dshParameters: dshToolParameters(z.toJSONSchema(DIRECTOR_AGENT_WIRE_SCHEMAS.director_game)),
  },
  {
    type: "function" as const,
    name: "director_dcc",
    description:
      "Use discover first, then hand Director projects to Blender or a game engine. render_engine_frame gives Unreal, Unity, and Godot independent visual feedback. start_engine_session reuses open editors for opt-in execute_code and engine-owned sync_scene; Unity and Godot also serve hot capture_frame, while Unreal uses render_engine_frame. sync_engine_session_to_director updates the stable-id review view while native game state stays in the engine. Live Blender modeling stays on blender_native; film handoff keeps the reviewed send/receive path.",
    inputSchema: z.toJSONSchema(DIRECTOR_AGENT_WIRE_SCHEMAS.director_dcc),
    dshParameters: dshToolParameters(z.toJSONSchema(DIRECTOR_AGENT_WIRE_SCHEMAS.director_dcc)),
  },
] as const;

export type DirectorWorkbenchPluginToolName = (typeof DIRECTOR_WORKBENCH_PLUGIN_TOOLS)[number]["name"];

export const DIRECTOR_WORKBENCH_PLUGIN_TOOL_NAMES = DIRECTOR_WORKBENCH_PLUGIN_TOOLS.map((tool) => tool.name);

export function isDirectorWorkbenchPluginTool(tool: string): tool is DirectorWorkbenchPluginToolName {
  return (DIRECTOR_WORKBENCH_PLUGIN_TOOL_NAMES as readonly string[]).includes(tool);
}
