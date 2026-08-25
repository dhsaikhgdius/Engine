import { z } from "zod";
import {
  directorObjectSpatialQuerySchema,
  directorWorkbenchCatalogIdSchema,
  directorWorkbenchOperationSchema,
} from "@director/agent-engine";
import { creativeWorkspaceAgentRequestSchema } from "@director/protocol/creative-workspace";
import { blenderNativeToolRequestSchema } from "@director/protocol/blender-live";
import { videoModelOperationSchema } from "@director/protocol/video-generation";

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
  catalog: directorWorkbenchCatalogIdSchema
    .optional()
    .describe('Required for op="catalog". Use catalog, never target, collection, source, or catalog_type.'),
  spatial: directorObjectSpatialQuerySchema.optional().describe('Selector for op="query_objects".'),
  max_results: z.number().int().min(1).max(200).optional().describe('Result bound for op="query_objects".'),
  actions: z
    .array(z.looseObject({ action: z.string().min(1) }))
    .optional()
    .describe(
      'Required for op="author". Deletion is delete_objects with object_ids (remove_object + id is accepted).',
    ),
  fields: z.array(z.string()).optional().describe('Optional observe fields, e.g. counts, ui, objects.'),
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
  operation: z.looseObject({ op: z.string().min(1) }).optional().describe('Required for op="execute".'),
  steps: z
    .array(z.looseObject({ operation: z.looseObject({ op: z.string().min(1) }).optional() }))
    .optional()
    .describe('Required for op="execute_batch".'),
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
    target: z.string().optional().describe('Typed apply op for op="describe", e.g. create_primitive or polyhaven_import.'),
    query: z.string().optional().describe('When op="query", Blender object name substring (e.g. "清华"). Also search text for catalog, polyhaven_search, and sketchfab_search.'),
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
] as const;

export type DirectorWorkbenchPluginToolName = (typeof DIRECTOR_WORKBENCH_PLUGIN_TOOLS)[number]["name"];

export const DIRECTOR_WORKBENCH_PLUGIN_TOOL_NAMES = DIRECTOR_WORKBENCH_PLUGIN_TOOLS.map((tool) => tool.name);

export function isDirectorWorkbenchPluginTool(tool: string): tool is DirectorWorkbenchPluginToolName {
  return (DIRECTOR_WORKBENCH_PLUGIN_TOOL_NAMES as readonly string[]).includes(tool);
}
