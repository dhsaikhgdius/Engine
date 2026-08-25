import { z } from "zod";
import type { StageCommandToolName } from "@director/stage-protocol";
import { directorCameraAspectRatioSchema as stageAspectSchema } from "@director/protocol/directorCameraProtocol";
import {
  stageCameraActionSchema,
  stageCameraShakeSchema,
  stageLocomotionGaitSchema,
  stageObjectCreateKindSchema,
  stageTurnDirectionSchema,
} from "@director/protocol/stageProtocol";

type JsonObject = Record<string, unknown>;

const finiteNumber = z.number().finite();
const vec3Schema = z.tuple([finiteNumber, finiteNumber, finiteNumber]);
const idSchema = z.string().trim().min(1);
const referenceSchema = { ref: idSchema.optional() };
const operation = <const Operation extends string, const Shape extends z.ZodRawShape>(op: Operation, shape: Shape) =>
  z.strictObject({ ...referenceSchema, op: z.literal(op), ...shape });
const withRequiredOne = <T extends z.ZodObject<z.ZodRawShape>>(schema: T, keys: string[], message: string) =>
  schema.refine((value) => keys.some((key) => value[key] !== undefined), { message });
const withRequiredFieldForKind = <T extends z.ZodObject<z.ZodRawShape>>(
  schema: T,
  kind: string,
  field: string,
  message: string,
) => schema.refine((value) => value.kind !== kind || value[field] !== undefined, { message });

const stageReadOperationSchema = z.discriminatedUnion("op", [
  operation("scene_state", {}),
  operation("observe", {}),
  operation("inspect", { object_id: idSchema }),
  operation("critique", {
    camera_id: idSchema.optional(),
    subject_id: idSchema.optional(),
  }),
  operation("help", {}),
  operation("search_props", {
    query: z.string(),
    category: z.string().optional(),
    limit: finiteNumber.optional(),
  }),
  operation("look_at_scene", { object_id: idSchema.optional() }),
]);

const stageSceneOperationSchema = z.discriminatedUnion("op", [
  withRequiredOne(
    operation("configure", {
      name: idSchema.optional(),
      aspect: stageAspectSchema.optional(),
    }),
    ["name", "aspect"],
    "configure needs name or aspect",
  ),
  operation("reset", {
    name: idSchema.optional(),
    aspect: stageAspectSchema.optional(),
    with_camera: z.boolean().optional(),
  }),
  operation("validate", {}),
]);

const stageObjectOperationSchema = z.discriminatedUnion("op", [
  withRequiredFieldForKind(
    withRequiredFieldForKind(
      operation("create", {
        kind: stageObjectCreateKindSchema,
        name: z.string().optional(),
        position: vec3Schema.optional(),
        rotation: vec3Schema.optional(),
        scale: vec3Schema.optional(),
        color: z.string().optional(),
        pose: z.string().optional(),
        prop_key: idSchema.optional(),
        image_data_url: z.string().startsWith("data:image/").optional(),
        depth: finiteNumber.optional(),
      }),
      "prop",
      "prop_key",
      "prop kind requires prop_key",
    ),
    "image",
    "image_data_url",
    "image kind requires image_data_url",
  ),
  withRequiredOne(
    operation("transform", {
      object_id: idSchema,
      position: vec3Schema.optional(),
      rotation: vec3Schema.optional(),
      scale: vec3Schema.optional(),
      pose: z.string().optional(),
    }),
    ["position", "rotation", "scale", "pose"],
    "transform needs position, rotation, scale, or pose",
  ),
  operation("translate", { object_id: idSchema, delta: vec3Schema }),
  withRequiredOne(
    operation("update", {
      object_id: idSchema,
      name: z.string().optional(),
      color: z.string().optional(),
    }),
    ["name", "color"],
    "update needs a name, a color, or both",
  ),
  operation("delete", { object_ids: z.array(idSchema).min(1) }),
  operation("group", { object_ids: z.array(idSchema).min(2) }),
  operation("place", { object_id: idSchema, on: idSchema }),
]);

const stageCameraOperationSchema = z.discriminatedUnion("op", [
  operation("add", { name: z.string().optional() }),
  withRequiredOne(
    operation("set_shot", {
      object_id: idSchema,
      focal_length_mm: finiteNumber.optional(),
      shake: stageCameraShakeSchema.optional(),
    }),
    ["focal_length_mm", "shake"],
    "set_shot needs focal_length_mm or shake",
  ),
  operation("set_target", { object_id: idSchema, position: vec3Schema }),
  operation("frame", {
    shot: z.enum(["wide", "medium", "closeup"]),
    object_id: idSchema.optional(),
  }),
]);

const cameraActionFields = {
  action: stageCameraActionSchema,
  duration_s: finiteNumber.optional(),
  subject_id: idSchema.optional(),
  object_id: idSchema.optional(),
  direction: stageTurnDirectionSchema.optional(),
  angle_deg: finiteNumber.optional(),
  height_delta: finiteNumber.optional(),
  distance_scale: finiteNumber.optional(),
};

const stageShowOperationSchema = z.discriminatedUnion("op", [
  operation("add_track", { object_id: idSchema }),
  operation("add_transform_item", { track_id: idSchema }),
  operation("add_keyframe", {
    track_id: idSchema,
    item_id: idSchema,
    time_s: finiteNumber,
    position: vec3Schema,
    rotation: vec3Schema,
    scale: vec3Schema,
  }),
  operation("add_clip", {
    track_id: idSchema,
    clip: idSchema,
    loop: z.boolean().optional(),
    duration_s: finiteNumber.optional(),
  }),
  operation("add_camera_action", { track_id: idSchema, ...cameraActionFields }),
  operation("set_camera_action", { track_id: idSchema, item_id: idSchema, ...cameraActionFields }),
  operation("add_path", {
    track_id: idSchema,
    points: z.array(vec3Schema).min(2),
    speed_units_per_s: finiteNumber.optional(),
    gait: stageLocomotionGaitSchema.optional(),
  }),
  operation("remove_item", { track_id: idSchema, item_id: idSchema }),
  operation("remove_track", { track_id: idSchema }),
  operation("play", {}),
]);

/** Per-tool discriminated union schemas covering every stage command operation. */
export const stageCommandOperationSchemas = {
  stage_read: stageReadOperationSchema,
  stage_scene: stageSceneOperationSchema,
  stage_object: stageObjectOperationSchema,
  stage_camera: stageCameraOperationSchema,
  stage_show: stageShowOperationSchema,
} satisfies Record<StageCommandToolName, z.ZodType<JsonObject>>;

/** A stage command operation discriminated by its op field, across any tool. */
export type StageCommandOperation = z.infer<(typeof stageCommandOperationSchemas)[StageCommandToolName]>;

/** A stage command operation narrowed to a specific tool. */
export type StageCommandOperationForTool<T extends StageCommandToolName> = z.infer<
  (typeof stageCommandOperationSchemas)[T]
>;

/**
 * Returns the valid operation names for a stage tool, derived from the discriminated union options.
 *
 * @param tool - The stage tool to inspect.
 * @returns An array of operation name strings for that tool.
 */
export function stageCommandOperationNames(tool: StageCommandToolName) {
  const options = stageCommandOperationSchemas[tool].options as unknown as Array<{ shape: { op: { value: string } } }>;
  return options.map((option) => option.shape.op.value);
}

/**
 * Parses raw stage command input against the tool-specific operation schema.
 *
 * Accepts either a single operation object or a batch envelope `{ ops: [...] }`.
 * Returns parsed operations with a batch flag; on failure returns a localized error.
 *
 * @param tool - The stage tool to validate against.
 * @param input - The raw input (single operation or batch envelope).
 * @returns Parsed operations with batch flag, or an error message.
 */
export function parseStageCommandInput<T extends StageCommandToolName>(
  tool: T,
  input: unknown,
):
  { success: true; operations: StageCommandOperationForTool<T>[]; batch: boolean } | { success: false; error: string } {
  const operationSchema = stageCommandOperationSchemas[tool];
  const batchSchema = z.strictObject({ ops: z.array(operationSchema).min(1) });
  const parsed =
    typeof input === "object" && input !== null && !Array.isArray(input) && "ops" in input
      ? batchSchema.safeParse(input)
      : operationSchema.safeParse(input);
  if (parsed.success) {
    return "ops" in parsed.data
      ? { success: true, operations: parsed.data.ops as StageCommandOperationForTool<T>[], batch: true }
      : { success: true, operations: [parsed.data as StageCommandOperationForTool<T>], batch: false };
  }

  const issue = parsed.error.issues[0];
  const path = issue?.path.length ? issue.path.join(".") : "input";
  return { success: false, error: `${tool} input invalid: ${path} ${issue?.message ?? "malformed input"}` };
}
