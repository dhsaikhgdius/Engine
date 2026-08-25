import { z } from "zod";
import { assertBlenderOperationManifestCoverage, blenderOperationRequiresSceneGuard } from "./blenderOperationManifest";

/** Protocol version contract stamped on every Blender live message. */
export const BLENDER_LIVE_CONTRACT = "worldengine-blender-live-v1" as const;

const finite = z.number().finite();
const identifier = z.string().trim().min(1).max(160);
const vec2 = z.tuple([finite, finite]);
const vec3 = z.tuple([finite, finite, finite]);
const localBounds = z
  .strictObject({ min: vec3, max: vec3 })
  .refine(
    (bounds) =>
      bounds.max.every((value, axis) => value >= bounds.min[axis]) &&
      bounds.max.some((value, axis) => value > bounds.min[axis]),
    { message: "local bounds max must not precede min and at least one axis must have extent" },
  );
const rgb = z.tuple([finite.min(0).max(1), finite.min(0).max(1), finite.min(0).max(1)]);
const sceneEpoch = z.string().uuid();

/** Optional position, rotation, and scale transform for a 3D object. */
export const blenderTransformSchema = z.strictObject({
  position: vec3.optional(),
  rotation: vec3.optional(),
  scale: vec3.optional(),
});
const blenderPlacementTransformSchema = z.strictObject({
  position: vec3.optional(),
  rotation: vec3.optional(),
});

const primitiveSchema = z.enum([
  "cube",
  "floor",
  "wall",
  "sphere",
  "uv_sphere",
  "ico_sphere",
  "cylinder",
  "cone",
  "plane",
]);
const blockoutPresetSchema = z.enum(["floor", "wall", "room", "corridor", "stairs"]);
const lightKindSchema = z.enum(["area", "point", "sun", "spot"]);
const openingKindSchema = z.enum(["door", "window"]);
const constraintKindSchema = z.enum(["track_to", "copy_location", "copy_rotation", "copy_transforms"]);
const operatorIdentifier = z.string().trim().min(1).max(240);
const blenderMode = z.string().trim().min(1).max(80);
const materialName = z.string().trim().min(1).max(240);
const actionName = z.string().trim().min(1).max(240);
const motionId = z.string().regex(/^[a-z0-9-]+$/);
const nlaName = z.string().trim().min(1).max(240);
const nlaBlendMode = z.enum(["REPLACE", "ADD", "COMBINE"]);
const quaternion = z.tuple([finite, finite, finite, finite]);
const sceneFrame = z.number().int().min(-1_048_574).max(1_048_574);
const poseChannelSchema = z.enum(["LOCATION", "ROTATION", "SCALE"]);
const poseBoneLocalTransformSchema = z
  .strictObject({
    location: vec3.optional(),
    rotationQuaternion: quaternion.optional(),
    scale: vec3.optional(),
  })
  .refine(
    (value) => value.location !== undefined || value.rotationQuaternion !== undefined || value.scale !== undefined,
    "At least one local pose transform channel is required",
  );
/** Material shader node types supported by the typed material graph API. */
export const blenderMaterialNodeTypeSchema = z.enum([
  "PRINCIPLED_BSDF",
  "MATERIAL_OUTPUT",
  "MIX_COLOR",
  "NORMAL_MAP",
  "BUMP",
  "TEX_COORD",
  "MAPPING",
  "NOISE_TEXTURE",
]);
/** Geometry node types supported by the typed geometry nodes API. */
export const blenderGeometryNodeTypeSchema = z.enum([
  "GROUP_INPUT",
  "GROUP_OUTPUT",
  "TRANSFORM_GEOMETRY",
  "SET_POSITION",
  "SUBDIVISION_SURFACE",
  "JOIN_GEOMETRY",
  "MESH_CUBE",
  "MESH_CYLINDER",
  "MESH_UV_SPHERE",
  "MESH_ICO_SPHERE",
  "MESH_CONE",
  "MESH_GRID",
  "MESH_CIRCLE",
  "CURVE_CIRCLE",
  "CURVE_QUADRILATERAL",
  "CURVE_TO_MESH",
  "FILL_CURVE",
  "INSTANCE_ON_POINTS",
  "REALIZE_INSTANCES",
  "EXTRUDE_MESH",
  "MESH_BOOLEAN",
  "DUPLICATE_ELEMENTS",
  "TRANSLATE_INSTANCES",
  "SET_MATERIAL",
  "SET_SHADE_SMOOTH",
  "INPUT_POSITION",
  "INPUT_NORMAL",
  "INPUT_INDEX",
  "MATH",
  "VECTOR_MATH",
  "COMBINE_XYZ",
  "SEPARATE_XYZ",
  "MAP_RANGE",
  "NOISE_TEXTURE",
  "RANDOM_VALUE",
  "VALUE",
]);
// Scalar ENUM/BOOLEAN/INT/FLOAT RNA properties applied on node creation
// (e.g. Math.operation, MeshBoolean.operation, MapRange.data_type).
/** Scalar properties applied on geometry node creation (e.g. Math.operation, MeshBoolean.operation). */
export const blenderGeometryNodePropertiesSchema = z.record(
  z.string().min(1).max(240),
  z.union([z.string().max(240), z.boolean(), finite]),
);
/** Value types accepted as material and geometry node input values. */
export const blenderMaterialNodeInputValueSchema = z.union([
  finite,
  z.boolean(),
  vec2,
  vec3,
  z.tuple([finite, finite, finite, finite]),
]);
const materialNodeEndpointSchema = z.strictObject({
  nodeRef: identifier,
  socketRef: z.string().trim().min(1).max(240),
});
const geometryNodeEndpointSchema = z.strictObject({
  nodeRef: identifier,
  socketRef: z.string().trim().min(1).max(240),
});
const curvePoints = z.array(vec3).min(2).max(4_096);
const curveType = z.enum(["POLY", "BEZIER"]);
const textAlignX = z.enum(["LEFT", "CENTER", "RIGHT"]);
const textAlignY = z.enum(["TOP_BASELINE", "CENTER", "BOTTOM"]);
const geometryModifierName = z.string().trim().min(1).max(240).default("WorldEngine Geometry");
const operatorProperties = z.record(z.string(), z.json());
const operatorSearchFields = {
  query: z.string().trim().max(240).default(""),
  category: z.string().trim().min(1).max(120).optional(),
  scope: z.enum(["modeling", "all"]).default("modeling"),
  availableOnly: z.boolean().default(false),
  limit: z.number().int().min(1).max(500).default(80),
};
const operatorContextSchema = z.strictObject({
  selectedIds: z.array(identifier).default([]),
  activeId: identifier.optional(),
  mode: blenderMode.default("OBJECT"),
});
const rnaTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.enum(["object", "object_data"]),
    objectId: identifier,
  }),
  z.strictObject({
    kind: z.enum(["modifier", "constraint"]),
    objectId: identifier,
    name: z.string().trim().min(1).max(240),
  }),
  z.strictObject({
    kind: z.enum(["material", "collection"]),
    name: z.string().trim().min(1).max(240),
  }),
  z.strictObject({
    kind: z.literal("scene"),
  }),
  z.strictObject({
    kind: z.literal("world"),
  }),
]);

const spatialQueryExcludeIds = z.array(identifier).max(64);
const spatialQuerySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("RAYCAST"),
    origin: vec3,
    direction: vec3.refine(
      (value) => value.some((component) => component !== 0),
      "direction must be a non-zero vector",
    ),
    maxDistance: finite.positive().max(100_000).default(1_000),
    excludeIds: spatialQueryExcludeIds.optional(),
  }),
  z.strictObject({
    kind: z.literal("CLOSEST_POINT"),
    point: vec3,
    targetId: identifier,
  }),
  z.strictObject({
    kind: z.literal("OVERLAP"),
    idA: identifier,
    idB: identifier,
  }),
  z.strictObject({
    kind: z.literal("GROUND"),
    id: identifier,
    excludeIds: spatialQueryExcludeIds.optional(),
  }),
  z.strictObject({
    kind: z.literal("NAME"),
    namePattern: z.string().trim().min(1).max(120),
    maxResults: z.number().int().min(1).max(200).default(50),
  }),
]);
const spatialQueriesSchema = z.array(spatialQuerySchema).min(1).max(32);

const agentOperationSchemas = [
  z.strictObject({
    op: z.literal("import_asset"),
    id: identifier,
    directorId: identifier,
    assetId: z.string().trim().min(1).max(240),
    sourceUrl: z.string().url().max(8_192),
    fileName: z.string().trim().min(1).max(240),
    name: z.string().trim().min(1).max(240),
    kind: z.enum(["prop", "character", "scene"]),
    normalization: z.enum(["auto", "preserve"]).default("auto"),
    grounded: z.boolean().default(false),
    targetHeightM: finite.positive().max(10_000).optional(),
    transform: blenderTransformSchema.optional(),
  }),
  z.strictObject({
    op: z.literal("create_primitive"),
    id: identifier,
    directorId: identifier.optional(),
    primitive: primitiveSchema,
    name: z.string().trim().min(1).max(240).optional(),
    // Dimensions are the sole metric size; scale here used to overwrite them.
    transform: blenderPlacementTransformSchema.optional(),
    dimensions: vec3.optional(),
    grounded: z.boolean().optional(),
    // Sphere/cylinder/cone family only; for ico_sphere segments selects the
    // subdivision level. The kernel wire parser enforces per-primitive rules.
    segments: z.number().int().min(3).max(256).optional(),
    rings: z.number().int().min(3).max(128).optional(),
  }),
  z.strictObject({
    op: z.literal("create_curve"),
    id: identifier,
    name: z.string().trim().min(1).max(240).optional(),
    curveType: curveType.default("POLY"),
    points: curvePoints,
    cyclic: z.boolean().default(false),
    bevelDepth: finite.nonnegative().default(0),
    bevelResolution: z.number().int().min(0).max(32).default(0),
    transform: blenderTransformSchema.optional(),
  }),
  z.strictObject({
    op: z.literal("set_curve_data"),
    id: identifier,
    curveType: curveType.default("POLY"),
    points: curvePoints,
    cyclic: z.boolean().optional(),
    bevelDepth: finite.nonnegative().optional(),
    bevelResolution: z.number().int().min(0).max(32).optional(),
  }),
  z.strictObject({
    op: z.literal("create_text"),
    id: identifier,
    name: z.string().trim().min(1).max(240).optional(),
    text: z.string().max(16_384),
    size: finite.positive().default(1),
    extrude: finite.nonnegative().default(0),
    bevelDepth: finite.nonnegative().default(0),
    alignX: textAlignX.default("LEFT"),
    alignY: textAlignY.default("TOP_BASELINE"),
    transform: blenderTransformSchema.optional(),
  }),
  z.strictObject({
    op: z.literal("set_text_data"),
    id: identifier,
    text: z.string().max(16_384),
    size: finite.positive().optional(),
    extrude: finite.nonnegative().optional(),
    bevelDepth: finite.nonnegative().optional(),
    alignX: textAlignX.optional(),
    alignY: textAlignY.optional(),
  }),
  z.strictObject({
    op: z.literal("update_transform"),
    id: identifier,
    transform: blenderTransformSchema,
  }),
  z.strictObject({
    op: z.literal("set_object_name"),
    id: identifier,
    name: z.string().trim().min(1).max(240),
  }),
  z.strictObject({
    op: z.literal("set_object_visibility"),
    id: identifier,
    visible: z.boolean(),
  }),
  z.strictObject({
    op: z.literal("delete_object"),
    id: identifier,
  }),
  z.strictObject({
    op: z.literal("duplicate_object"),
    id: identifier,
    newId: identifier,
    name: z.string().trim().min(1).max(240).optional(),
    transform: blenderTransformSchema.optional(),
  }),
  z.strictObject({
    op: z.literal("create_camera"),
    id: identifier,
    name: z.string().trim().min(1).max(240).optional(),
    position: vec3,
    target: vec3,
    focalLengthMm: finite.positive().min(1).max(1_000).default(35),
    sensorWidthMm: finite.positive().min(1).max(100).default(36),
  }),
  z
    .strictObject({
      op: z.literal("set_camera_data"),
      id: identifier,
      projectionType: z.enum(["PERSPECTIVE", "ORTHOGRAPHIC"]),
      focalLengthMm: finite.positive().min(1).max(1_000),
      sensorFit: z.enum(["AUTO", "HORIZONTAL", "VERTICAL"]),
      sensorWidthMm: finite.positive().min(1).max(100),
      sensorHeightMm: finite.positive().min(1).max(100),
      shiftX: finite,
      shiftY: finite,
      clipStart: finite.positive(),
      clipEnd: finite.positive(),
      orthographicScale: finite.positive(),
    })
    .refine((camera) => camera.clipEnd > camera.clipStart, {
      path: ["clipEnd"],
      message: "clipEnd must be greater than clipStart",
    }),
  z.strictObject({
    op: z.literal("set_active_camera"),
    id: identifier,
  }),
  z.strictObject({
    op: z.literal("set_world_environment"),
    color: rgb.optional(),
    strength: finite.nonnegative().max(1_000).optional(),
  }),
  z.strictObject({
    op: z.literal("create_light"),
    id: identifier,
    kind: lightKindSchema.default("area"),
    name: z.string().trim().min(1).max(240).optional(),
    position: vec3,
    target: vec3.default([0, 1.5, 0]),
    color: vec3.default([1, 0.94, 0.86]),
    energy: finite.nonnegative().default(1_000),
    size: finite.positive().default(4),
  }),
  z.strictObject({
    op: z.literal("set_light_data"),
    id: identifier,
    kind: lightKindSchema,
    color: rgb,
    energy: finite.nonnegative(),
    size: finite.nonnegative(),
  }),
  z.strictObject({
    op: z.literal("create_opening"),
    id: identifier,
    targetId: identifier,
    kind: openingKindSchema.default("door"),
    name: z.string().trim().min(1).max(240).optional(),
    width: finite.positive().default(0.9),
    height: finite.positive().default(2.1),
    sillHeight: finite.nonnegative().default(0),
    offset: finite.default(0),
  }),
  z.strictObject({
    op: z.literal("move_to_collection"),
    ids: z.array(identifier).min(1).max(256),
    collection: z.string().trim().min(1).max(240),
  }),
  z.strictObject({
    op: z.literal("set_parent"),
    id: identifier,
    parentId: identifier.nullable(),
    keepWorldTransform: z.boolean().default(true),
  }),
  z.strictObject({
    op: z.literal("add_constraint"),
    id: identifier,
    targetId: identifier,
    kind: constraintKindSchema,
    influence: finite.min(0).max(1).default(1),
  }),
  z.strictObject({
    op: z.literal("remove_constraint"),
    id: identifier,
    constraintName: z.string().trim().min(1).max(240),
  }),
  z.strictObject({
    op: z.literal("create_blockout"),
    preset: blockoutPresetSchema,
    idPrefix: identifier,
    origin: vec3.default([0, 0, 0]),
    width: finite.positive().min(0.05).max(10_000).default(8),
    depth: finite.positive().min(0.05).max(10_000).default(6),
    height: finite.positive().min(0.05).max(10_000).default(3),
    wallThickness: finite.positive().min(0.01).max(10).default(0.18),
    stepCount: z.number().int().min(1).max(256).default(12),
  }),
  z.strictObject({
    op: z.literal("discover_operators"),
    ...operatorSearchFields,
  }),
  z.strictObject({
    op: z.literal("describe_operator"),
    operator: operatorIdentifier,
  }),
  z.strictObject({
    op: z.literal("inspect_object"),
    id: identifier,
  }),
  z.strictObject({
    op: z.literal("set_selection"),
    selectedIds: z.array(identifier).default([]),
    activeId: identifier.optional(),
    mode: blenderMode.default("OBJECT"),
  }),
  z.strictObject({
    op: z.literal("select_mesh_elements"),
    id: identifier,
    domain: z.enum(["VERTEX", "EDGE", "FACE"]).default("FACE"),
    indices: z.array(z.number().int().nonnegative()).default([]),
    action: z.enum(["SET", "ADD", "SUBTRACT", "ALL", "NONE", "INVERT"]).default("SET"),
  }),
  z.strictObject({
    op: z.literal("assign_material"),
    id: identifier,
    materialName,
    /** Omitted creates a Principled material. `false` skips a still-missing name instead of aborting the batch. */
    createIfMissing: z.boolean().default(true),
    faceScope: z.enum(["PRESERVE", "ALL", "SELECTED"]).default("ALL"),
    parameters: z
      .strictObject({
        baseColor: rgb.optional(),
        roughness: finite.min(0).max(1).optional(),
        metallic: finite.min(0).max(1).optional(),
        alpha: finite.min(0).max(1).optional(),
      })
      .default({}),
  }),
  z.strictObject({
    op: z.literal("project_uv"),
    id: identifier,
    method: z.enum(["SMART", "UNWRAP", "CUBE"]).default("SMART"),
    uvLayerName: z.string().trim().min(1).max(240).default("UVMap"),
    replaceExisting: z.boolean().default(false),
  }),
  z.strictObject({
    op: z.literal("create_material_node"),
    id: identifier,
    materialName,
    nodeRef: identifier,
    nodeType: blenderMaterialNodeTypeSchema,
    location: vec2.optional(),
    label: z.string().trim().max(240).optional(),
  }),
  z.strictObject({
    op: z.literal("delete_material_node"),
    id: identifier,
    materialName,
    nodeRef: identifier,
  }),
  z.strictObject({
    op: z.literal("set_material_node_input"),
    id: identifier,
    materialName,
    nodeRef: identifier,
    inputSocketRef: z.string().trim().min(1).max(240),
    value: blenderMaterialNodeInputValueSchema,
  }),
  z.strictObject({
    op: z.literal("connect_material_nodes"),
    id: identifier,
    materialName,
    from: materialNodeEndpointSchema,
    to: materialNodeEndpointSchema,
  }),
  z.strictObject({
    op: z.literal("disconnect_material_node_input"),
    id: identifier,
    materialName,
    nodeRef: identifier,
    inputSocketRef: z.string().trim().min(1).max(240),
  }),
  z.strictObject({
    op: z.literal("ensure_geometry_nodes"),
    id: identifier,
    modifierName: geometryModifierName,
  }),
  z.strictObject({
    op: z.literal("create_geometry_node"),
    id: identifier,
    modifierName: geometryModifierName,
    nodeRef: identifier,
    nodeType: blenderGeometryNodeTypeSchema,
    location: vec2.optional(),
    label: z.string().trim().max(240).optional(),
    nodeProperties: blenderGeometryNodePropertiesSchema.optional(),
  }),
  z.strictObject({
    op: z.literal("delete_geometry_node"),
    id: identifier,
    modifierName: geometryModifierName,
    nodeRef: identifier,
  }),
  z.strictObject({
    op: z.literal("set_geometry_node_input"),
    id: identifier,
    modifierName: geometryModifierName,
    nodeRef: identifier,
    inputSocketRef: z.string().trim().min(1).max(240),
    value: blenderMaterialNodeInputValueSchema,
  }),
  z.strictObject({
    op: z.literal("connect_geometry_nodes"),
    id: identifier,
    modifierName: geometryModifierName,
    from: geometryNodeEndpointSchema,
    to: geometryNodeEndpointSchema,
  }),
  z.strictObject({
    op: z.literal("disconnect_geometry_node_input"),
    id: identifier,
    modifierName: geometryModifierName,
    nodeRef: identifier,
    inputSocketRef: z.string().trim().min(1).max(240),
  }),
  z.strictObject({
    op: z.literal("select_pose_bones"),
    id: identifier,
    boneRefs: z.array(identifier).max(512).default([]),
    activeBoneRef: identifier.optional(),
    action: z.enum(["SET", "ADD", "SUBTRACT", "ALL", "NONE"]).default("SET"),
  }),
  z.strictObject({
    op: z.literal("set_pose_bone_transform"),
    id: identifier,
    boneRef: identifier,
    local: poseBoneLocalTransformSchema,
  }),
  z.strictObject({
    op: z.literal("apply_pose_offsets"),
    id: identifier,
    stateToken: z.string().min(1).max(20_000),
    resetPose: z.boolean().default(false),
    bones: z
      .array(
        z.strictObject({
          boneRef: identifier,
          rotationOffsetQuaternion: quaternion,
          locationOffset: vec3.optional(),
        }),
      )
      .min(1)
      .max(128),
  }),
  z.strictObject({
    op: z.literal("create_action"),
    id: identifier,
    actionName,
  }),
  z.strictObject({
    op: z.literal("set_active_action"),
    id: identifier,
    actionName,
  }),
  z.strictObject({
    op: z.literal("set_scene_frame"),
    frame: sceneFrame,
  }),
  z.strictObject({
    op: z.literal("insert_pose_keyframes"),
    id: identifier,
    actionName,
    frame: sceneFrame,
    boneRefs: z.array(identifier).min(1).max(512),
    channels: z.array(poseChannelSchema).min(1).max(3),
    interpolation: z.enum(["CONSTANT", "LINEAR", "BEZIER"]).default("BEZIER"),
  }),
  z.strictObject({
    op: z.literal("delete_pose_keyframes"),
    id: identifier,
    actionName,
    frame: sceneFrame,
    boneRefs: z.array(identifier).min(1).max(512),
    channels: z.array(poseChannelSchema).min(1).max(3),
  }),
  z.strictObject({
    op: z.literal("import_mixamo_action"),
    id: identifier,
    motionId,
    actionName: actionName.optional(),
    rootMotion: z.enum(["IN_PLACE", "AUTHORED"]).default("IN_PLACE"),
    replaceExisting: z.boolean().default(false),
  }),
  z.strictObject({
    op: z.literal("create_nla_track"),
    id: identifier,
    trackName: nlaName,
  }),
  z.strictObject({
    op: z.literal("add_nla_strip"),
    id: identifier,
    trackName: nlaName,
    stripName: nlaName,
    actionName,
    startFrame: sceneFrame,
    blendMode: nlaBlendMode.default("REPLACE"),
    influence: finite.min(0).max(1).default(1),
    repeat: finite.positive().max(1_000).default(1),
    scale: finite.positive().max(10).default(1),
  }),
  z.strictObject({
    op: z.literal("update_nla_strip"),
    id: identifier,
    trackName: nlaName,
    stripName: nlaName,
    blendMode: nlaBlendMode.optional(),
    influence: finite.min(0).max(1).optional(),
    repeat: finite.positive().max(1_000).optional(),
    scale: finite.positive().max(10).optional(),
  }),
  z.strictObject({
    op: z.literal("remove_nla_strip"),
    id: identifier,
    trackName: nlaName,
    stripName: nlaName,
  }),
  z.strictObject({
    op: z.literal("invoke_operator"),
    operator: operatorIdentifier,
    properties: operatorProperties.default({}),
    context: operatorContextSchema.optional(),
  }),
  z.strictObject({
    op: z.literal("set_rna_property"),
    target: rnaTargetSchema,
    path: z.array(z.union([z.string().trim().min(1).max(240), z.number().int()])).min(1),
    value: z.json(),
  }),
  z.strictObject({
    op: z.literal("execute_code"),
    code: z
      .string()
      .min(1)
      .max(100_000)
      .refine((value) => value.trim().length > 0, "code must not be empty"),
  }),
  z.strictObject({
    op: z.literal("polyhaven_search"),
    assetType: z.enum(["hdris", "textures", "models", "all"]).default("models"),
    categories: z.string().trim().min(1).max(240).optional(),
    query: z.string().trim().max(240).default(""),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  z.strictObject({
    op: z.literal("polyhaven_import"),
    assetId: z.string().trim().min(1).max(240),
    assetType: z.enum(["hdris", "textures", "models"]),
    resolution: z.enum(["1k", "2k", "4k"]).default("1k"),
    fileFormat: z.string().trim().min(1).max(40).optional(),
    objectId: identifier.optional(),
    targetHeightM: finite.positive().max(10_000).optional(),
  }),
  z.strictObject({
    op: z.literal("sketchfab_search"),
    query: z.string().trim().min(1).max(240),
    count: z.number().int().min(1).max(24).default(5),
  }),
  z.strictObject({
    op: z.literal("sketchfab_import"),
    uid: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{8,64}$/, "uid must be a Sketchfab model id"),
    objectId: identifier.optional(),
    targetSizeM: finite.positive().max(50).default(1),
  }),
  z.strictObject({ op: z.literal("undo_scene") }),
  z.strictObject({ op: z.literal("redo_scene") }),
  z.strictObject({
    op: z.literal("capture_render"),
    cameraId: identifier.optional(),
    width: z.number().int().min(64).max(2_048).default(640),
    height: z.number().int().min(64).max(2_048).default(360),
    transparent: z.boolean().default(false),
  }),
  z.strictObject({
    op: z.literal("add_modifier"),
    id: identifier,
    modifierName: z.string().trim().min(1).max(240),
    modifierType: z.enum([
      "SOLIDIFY",
      "BEVEL",
      "ARRAY",
      "MIRROR",
      "BOOLEAN",
      "SUBSURF",
      "DECIMATE",
      "DISPLACE",
      "TRIANGULATE",
      "WELD",
      "WIREFRAME",
      "SCREW",
      "SIMPLE_DEFORM",
      "SMOOTH",
      "CAST",
      "SHRINKWRAP",
    ]),
    properties: z.record(z.string().trim().min(1).max(240), z.json()).default({}),
  }),
  z.strictObject({
    op: z.literal("set_modifier"),
    id: identifier,
    modifierName: z.string().trim().min(1).max(240),
    properties: z
      .record(z.string().trim().min(1).max(240), z.json())
      .refine((value) => Object.keys(value).length > 0, "set_modifier requires at least one property"),
  }),
  z.strictObject({
    op: z.literal("remove_modifier"),
    id: identifier,
    modifierName: z.string().trim().min(1).max(240),
  }),
  z.strictObject({
    op: z.literal("reorder_modifier"),
    id: identifier,
    modifierName: z.string().trim().min(1).max(240),
    index: z.number().int().min(0).max(127),
  }),
  z.strictObject({
    op: z.literal("apply_modifier"),
    id: identifier,
    modifierName: z.string().trim().min(1).max(240),
  }),
  z.strictObject({
    op: z.literal("query_spatial"),
    queries: spatialQueriesSchema,
  }),
  z.strictObject({
    op: z.literal("set_geometry_modifier_input"),
    id: identifier,
    modifierName: geometryModifierName,
    inputRef: z.string().trim().min(1).max(240),
    value: z.union([finite, z.boolean()]),
  }),
  z.strictObject({
    op: z.literal("assign_geometry_node_group"),
    id: identifier,
    modifierName: geometryModifierName,
    nodeGroupName: z.string().trim().min(1).max(240),
  }),
] as const;

const exportScenePreviewOperationSchema = z.strictObject({
  op: z.literal("export_scene_preview"),
});

const bindDirectorProjectOperationSchema = z.strictObject({
  op: z.literal("bind_director_project"),
  projectId: identifier,
});

assertBlenderOperationManifestCoverage([
  ...agentOperationSchemas.map((schema) => schema.shape.op.value),
  exportScenePreviewOperationSchema.shape.op.value,
  bindDirectorProjectOperationSchema.shape.op.value,
]);

/** Discriminated union of all agent-facing typed operations on the Blender live kernel. */
export const blenderAgentOperationSchema = z.discriminatedUnion("op", agentOperationSchemas);
/** Typed apply operation names derived from the agent-facing Blender operation union. */
export const blenderAgentOperationNames = blenderAgentOperationSchema.options.map((option) => option.shape.op.value);
/** `blender_native` describe accepts RNA `operator` or a typed apply `target`, never both. */
export const BLENDER_NATIVE_DESCRIBE_XOR_MESSAGE =
  'describe requires exactly one of operator (Blender RNA, e.g. "mesh.bevel") or target (typed apply op, e.g. "apply" or "create_primitive")';
/** Discriminated union of all live operations, including export and project binding. */
export const blenderLiveOperationSchema = z.discriminatedUnion("op", [
  ...agentOperationSchemas,
  exportScenePreviewOperationSchema,
  bindDirectorProjectOperationSchema,
]);

/** A batch of live operations with contract, request id, and optional epoch guarding against concurrent edits. */
export const blenderLiveCommandBatchSchema = z
  .strictObject({
    contract: z.literal(BLENDER_LIVE_CONTRACT).default(BLENDER_LIVE_CONTRACT),
    requestId: z.string().uuid(),
    expectedSceneEpoch: sceneEpoch.optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
    operations: z.array(blenderLiveOperationSchema).min(1).max(128),
  })
  .superRefine((batch, context) => {
    const hasSceneWrite = batch.operations.some((operation) => blenderOperationRequiresSceneGuard(operation.op));
    if (hasSceneWrite && !batch.expectedSceneEpoch) {
      context.addIssue({
        code: "custom",
        path: ["expectedSceneEpoch"],
        message: "expectedSceneEpoch is required for public Blender command batches",
      });
    }
  });

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function nameQueryFromText(value: string) {
  return { kind: "NAME" as const, namePattern: value };
}

function liftQueryList(value: unknown): unknown[] | undefined {
  if (Array.isArray(value) && value.length > 0) {
    return value.map((item) => (typeof item === "string" && item.trim() ? nameQueryFromText(item.trim()) : item));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) return [value];
  return undefined;
}

/**
 * Agents often send blender_native `{op:"query", query:"清华"}` because the compact
 * tool schema exposes a string `query` field. Lift that into a NAME object search.
 */
export function liftBlenderNativeToolRequest(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const record = input as Record<string, unknown>;
  if (record.op !== "query") return input;
  const next = { ...record };
  const namedPattern =
    asNonEmptyString(next.name_pattern) ?? asNonEmptyString(next.namePattern) ?? asNonEmptyString(next.query);
  const queries =
    liftQueryList(next.queries) ??
    liftQueryList(typeof next.query === "string" ? undefined : next.query) ??
    (namedPattern ? [nameQueryFromText(namedPattern)] : undefined);
  if (!queries) return input;
  delete next.query;
  delete next.name_pattern;
  delete next.namePattern;
  next.queries = queries;
  return next;
}

/** Native tool request surface: status, scene, catalog, describe, inspect, capture, capture_render, query, live_link, library search, and apply. */
export const blenderNativeToolRequestSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("status") }),
  z.strictObject({ op: z.literal("scene") }),
  z.strictObject({
    op: z.literal("catalog"),
    ...operatorSearchFields,
  }),
  z
    .strictObject({
      op: z.literal("describe"),
      operator: operatorIdentifier.optional(),
      target: z.string().trim().min(1).max(200).optional(),
    })
    .superRefine((value, ctx) => {
      if (Boolean(value.operator) === Boolean(value.target)) {
        ctx.addIssue({ code: "custom", message: BLENDER_NATIVE_DESCRIBE_XOR_MESSAGE });
      }
    }),
  z.strictObject({
    op: z.literal("inspect"),
    id: identifier,
    expectedSceneEpoch: sceneEpoch.optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({
    op: z.literal("capture"),
    cameraId: identifier.optional(),
    width: z.number().int().min(64).max(2_048).default(640),
    height: z.number().int().min(64).max(2_048).default(360),
    transparent: z.boolean().default(false),
  }),
  z.strictObject({
    op: z.literal("capture_render"),
    cameraId: identifier.optional(),
    width: z.number().int().min(64).max(2_048).default(640),
    height: z.number().int().min(64).max(2_048).default(360),
    transparent: z.boolean().default(false),
  }),
  z.strictObject({
    op: z.literal("query"),
    queries: spatialQueriesSchema,
  }),
  z.strictObject({
    /** Poll the preview-only live-link delta feed. Never authoritative. */
    op: z.literal("live_link"),
    sceneEpoch: sceneEpoch.optional(),
    since: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({
    op: z.literal("polyhaven_search"),
    assetType: z.enum(["hdris", "textures", "models", "all"]).default("models"),
    categories: z.string().trim().min(1).max(240).optional(),
    query: z.string().trim().max(240).default(""),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  z.strictObject({
    op: z.literal("sketchfab_search"),
    query: z.string().trim().min(1).max(240),
    count: z.number().int().min(1).max(24).default(5),
  }),
  z.strictObject({
    op: z.literal("apply"),
    expectedSceneEpoch: sceneEpoch.optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
    intentId: z.string().uuid().optional(),
    operations: z.array(blenderAgentOperationSchema).min(1).max(128),
  }),
]);

/** Agent-facing parse of blender_native, including `{op:"query", query:"清华"}` name search. */
export const blenderNativeToolRequestInputSchema = z.preprocess(
  liftBlenderNativeToolRequest,
  blenderNativeToolRequestSchema,
);

/** Native tool operations that are read-only and do not modify the scene. */
export const blenderNativeReadOperationNames = [
  "status",
  "scene",
  "catalog",
  "describe",
  "inspect",
  "capture",
  "capture_render",
  "query",
  "live_link",
  "polyhaven_search",
  "sketchfab_search",
] as const;

/** Live operations that are read-only and do not modify the scene. */
export const blenderLiveReadOperationNames = [
  "discover_operators",
  "describe_operator",
  "inspect_object",
  "capture_render",
  "export_scene_preview",
  "query_spatial",
  "polyhaven_search",
  "sketchfab_search",
] as const;

/** A 3D object in the Blender scene snapshot, with world and local transforms, dimensions, collections, and constraints. */
export const blenderObjectSchema = z.strictObject({
  id: identifier,
  directorId: identifier.nullable().optional(),
  name: z.string(),
  type: z.string(),
  kind: z.string().default("object"),
  position: vec3,
  rotation: vec3,
  scale: vec3,
  localTransform: z.strictObject({
    position: vec3,
    rotation: vec3,
    scale: vec3,
  }),
  dimensions: vec3,
  localBounds: localBounds.nullable().optional(),
  visible: z.boolean(),
  collections: z.array(z.string()),
  parentId: identifier.nullable().default(null),
  modifierCount: z.number().int().nonnegative().default(0),
  constraints: z
    .array(
      z.strictObject({
        name: z.string(),
        kind: z.string(),
        targetId: identifier.nullable(),
        influence: finite.min(0).max(1),
        enabled: z.boolean(),
      }),
    )
    .default([]),
});

/** A camera in the Blender scene, with projection type, focal length, sensor, clipping, and active flag. */
export const blenderCameraSchema = z.strictObject({
  id: identifier,
  name: z.string(),
  position: vec3,
  rotation: vec3,
  projectionType: z.enum(["PERSPECTIVE", "ORTHOGRAPHIC"]),
  focalLengthMm: finite.positive(),
  sensorFit: z.enum(["AUTO", "HORIZONTAL", "VERTICAL"]),
  sensorWidthMm: finite.positive(),
  sensorHeightMm: finite.positive(),
  shiftX: finite,
  shiftY: finite,
  clipStart: finite.positive(),
  clipEnd: finite.positive(),
  orthographicScale: finite.positive(),
  active: z.boolean(),
});

/** A light in the Blender scene, with kind, position, color, energy, and size. */
export const blenderLightSchema = z.strictObject({
  id: identifier,
  name: z.string(),
  kind: lightKindSchema,
  position: vec3,
  rotation: vec3,
  color: vec3,
  energy: finite.nonnegative(),
  size: finite.nonnegative(),
  visible: z.boolean(),
});

/** Health stanza reported by the live kernel for the preview-only live-link delta feed. */
export const blenderLiveLinkHealthSchema = z.strictObject({
  seq: z.number().int().nonnegative(),
  bufferedFrames: z.number().int().nonnegative(),
  capacity: z.number().int().positive(),
});

/** A parsed live-link health stanza. */
export type BlenderLiveLinkHealth = z.infer<typeof blenderLiveLinkHealthSchema>;

/** Health check response from the Blender live kernel: contract, scene epoch, revision, busy flag, and live-link feed state. */
export const blenderLiveHealthSchema = z.strictObject({
  ok: z.literal(true),
  contract: z.literal(BLENDER_LIVE_CONTRACT),
  projectId: identifier.nullable().optional(),
  sceneEpoch,
  blenderVersion: z.string(),
  revision: z.number().int().nonnegative(),
  contentRevision: z.number().int().nonnegative().optional(),
  busy: z.boolean(),
  /** Preview-only live-link delta feed state; optional for older kernels without the feed. */
  liveLink: blenderLiveLinkHealthSchema.optional(),
});

/** Status of the Blender live kernel: healthy with metadata, or unavailable with a reason. */
export const blenderLiveStatusSchema = z.discriminatedUnion("available", [
  blenderLiveHealthSchema.extend({ available: z.literal(true) }),
  z.strictObject({
    available: z.literal(false),
    contract: z.literal(BLENDER_LIVE_CONTRACT),
    reason: z.string(),
  }),
]);

/** Full snapshot of the Blender scene: objects, cameras, lights, selection, and coordinate system metadata. */
export const blenderLiveSceneSnapshotSchema = z.strictObject({
  contract: z.literal(BLENDER_LIVE_CONTRACT),
  projectId: identifier.nullable().optional(),
  sceneEpoch,
  revision: z.number().int().nonnegative(),
  contentRevision: z.number().int().nonnegative().optional(),
  sceneName: z.string(),
  frame: z.number().int(),
  unit: z.literal("meter"),
  coordinateSystem: z.literal("right-handed-y-up-negative-z-forward"),
  objects: z.array(blenderObjectSchema),
  cameras: z.array(blenderCameraSchema),
  lights: z.array(blenderLightSchema).default([]),
  selectedObjectIds: z.array(identifier).default([]),
  activeObjectId: identifier.nullable().default(null),
});

/** A glTF binary export preview of the Blender scene, with metadata detached server-side. */
export const blenderScenePreviewSchema = z.strictObject({
  contract: z.literal(BLENDER_LIVE_CONTRACT),
  sceneEpoch,
  revision: z.number().int().nonnegative(),
  mimeType: z.literal("model/gltf-binary"),
  // The native operation result keeps returning dataBase64 on the wire, but the
  // session detaches it server-side; polled job records carry metadata only.
  dataBase64: z.string().min(1).optional(),
  byteLength: z.number().int().positive(),
});

const compactCountMap = z.record(z.string(), z.number().int().nonnegative());
const boundedSelectionSample = z.strictObject({
  count: z.number().int().nonnegative(),
  sample: z.array(z.number().int().nonnegative()).max(64),
});

const materialNodeSocketInspectionSchema = z.strictObject({
  socketRef: z.string(),
  name: z.string(),
  type: z.string(),
  linked: z.boolean(),
  enabled: z.boolean(),
  multiInput: z.boolean(),
  defaultValue: z.json().optional(),
});

/** Full material node graph for one material: nodes, links, and active output. */
export const blenderMaterialGraphSchema = z.strictObject({
  materialName: z.string(),
  objectIds: z.array(identifier),
  activeOutputNodeRef: identifier.nullable(),
  nodes: z.array(
    z.strictObject({
      nodeRef: identifier,
      name: z.string(),
      label: z.string(),
      nodeType: blenderMaterialNodeTypeSchema.or(z.literal("CUSTOM")),
      blenderType: z.string(),
      activeOutput: z.boolean(),
      location: vec2,
      inputs: z.array(materialNodeSocketInspectionSchema),
      outputs: z.array(materialNodeSocketInspectionSchema),
    }),
  ),
  links: z.array(
    z.strictObject({
      from: materialNodeEndpointSchema,
      to: materialNodeEndpointSchema,
    }),
  ),
});

/** Full geometry node graph for one object's modifier: nodes, links, modifier inputs, and node group name. */
export const blenderGeometryGraphSchema = z.strictObject({
  objectId: identifier,
  modifierName: z.string(),
  nodeGroupName: z.string(),
  modifierInputs: z
    .array(
      z.strictObject({
        identifier: z.string(),
        name: z.string(),
        socketType: z.string(),
        value: z.json(),
      }),
    )
    .default([]),
  nodes: z.array(
    z.strictObject({
      nodeRef: identifier,
      name: z.string(),
      label: z.string(),
      nodeType: blenderGeometryNodeTypeSchema.or(z.literal("CUSTOM")),
      blenderType: z.string(),
      location: vec2,
      inputs: z.array(materialNodeSocketInspectionSchema),
      outputs: z.array(materialNodeSocketInspectionSchema),
      properties: blenderGeometryNodePropertiesSchema.optional(),
    }),
  ),
  links: z.array(
    z.strictObject({
      from: geometryNodeEndpointSchema,
      to: geometryNodeEndpointSchema,
    }),
  ),
});

const blenderBoneTransformSchema = z.strictObject({
  location: vec3,
  rotationQuaternion: quaternion,
  scale: vec3,
});

const blenderActionSummarySchema = z.strictObject({
  actionName: z.string(),
  active: z.boolean(),
  frameRange: z.tuple([finite, finite]),
  fCurveCount: z.number().int().nonnegative(),
  keyframeCount: z.number().int().nonnegative(),
  keyedFrames: z.array(finite),
});

/** Deep inspection of a single 3D object: mesh, curve, text, materials, rig, animation, and warnings. */
export const blenderObjectInspectionSchema = z.looseObject({
  id: identifier,
  name: z.string(),
  type: z.string(),
  mode: blenderMode,
  dimensions: vec3,
  position: vec3.optional(),
  evaluatedBounds: z.strictObject({
    min: vec3,
    max: vec3,
    center: vec3,
    size: vec3,
  }),
  selection: z.strictObject({
    selected: z.boolean(),
    active: z.boolean(),
  }),
  mesh: z
    .looseObject({
      vertices: z.number().int().nonnegative(),
      edges: z.number().int().nonnegative(),
      faces: z.number().int().nonnegative(),
      triangles: z.number().int().nonnegative(),
      looseVertices: z.number().int().nonnegative(),
      boundaryEdges: z.number().int().nonnegative(),
      nonManifoldEdges: z.number().int().nonnegative(),
      materialSlots: z.number().int().nonnegative(),
      selection: z
        .strictObject({
          vertices: boundedSelectionSample,
          edges: boundedSelectionSample,
          faces: boundedSelectionSample,
        })
        .optional(),
      uvLayers: z.array(z.string()),
      uvLayerDetails: z
        .array(
          z.strictObject({
            name: z.string(),
            active: z.boolean(),
            activeRender: z.boolean(),
            loopCount: z.number().int().nonnegative(),
            coordinateBounds: z.strictObject({ min: vec2, max: vec2 }),
          }),
        )
        .default([]),
      colorAttributes: z.array(z.string()),
      shapeKeys: z.array(z.string()),
    })
    .optional(),
  curve: z
    .strictObject({
      bevelDepth: finite.nonnegative(),
      bevelResolution: z.number().int().nonnegative(),
      splines: z.array(
        z.strictObject({
          type: curveType.or(z.string()),
          cyclic: z.boolean(),
          points: z.array(vec3),
        }),
      ),
    })
    .optional(),
  text: z
    .strictObject({
      text: z.string(),
      size: finite.positive(),
      extrude: finite.nonnegative(),
      bevelDepth: finite.nonnegative(),
      alignX: z.string(),
      alignY: z.string(),
    })
    .optional(),
  materialNodes: z
    .array(
      z.strictObject({
        material: z.string(),
        useNodes: z.boolean(),
        nodeCount: z.number().int().nonnegative(),
        linkCount: z.number().int().nonnegative(),
        nodeTypes: compactCountMap,
        principled: z
          .strictObject({
            baseColor: rgb,
            roughness: finite.min(0).max(1),
            metallic: finite.min(0).max(1),
            alpha: finite.min(0).max(1),
          })
          .nullable()
          .default(null),
      }),
    )
    .default([]),
  materialSlots: z
    .array(
      z.strictObject({
        index: z.number().int().nonnegative(),
        name: z.string(),
        link: z.enum(["DATA", "OBJECT"]),
        resolvedMaterial: z.string().nullable(),
        dataMaterial: z.string().nullable(),
      }),
    )
    .default([]),
  materialGraphs: z.array(blenderMaterialGraphSchema).default([]),
  geometryGraphs: z.array(blenderGeometryGraphSchema).default([]),
  rig: z
    .strictObject({
      boneCount: z.number().int().nonnegative(),
      poseBoneCount: z.number().int().nonnegative(),
      deformBoneCount: z.number().int().nonnegative(),
      constraintCount: z.number().int().nonnegative(),
      activeBoneRef: identifier.nullable().default(null),
      selectedBoneRefs: z.array(identifier).default([]),
      directorStateToken: z.string().default(""),
      bones: z
        .array(
          z.strictObject({
            boneRef: identifier,
            parentRef: identifier.nullable(),
            deform: z.boolean(),
            selected: z.boolean(),
            local: blenderBoneTransformSchema,
            restLocal: blenderBoneTransformSchema,
          }),
        )
        .default([]),
      mixamoCompatibility: z
        .strictObject({
          compatible: z.boolean(),
          missingBoneRoles: z.array(z.string()),
          mappedBoneCount: z.number().int().nonnegative(),
        })
        .optional(),
    })
    .optional(),
  animation: z.strictObject({
    action: z.string().nullable(),
    activeAction: blenderActionSummarySchema.nullable().default(null),
    actions: z.array(blenderActionSummarySchema).default([]),
    fCurveCount: z.number().int().nonnegative(),
    keyframeCount: z.number().int().nonnegative(),
    driverCount: z.number().int().nonnegative(),
    nlaTrackCount: z.number().int().nonnegative(),
    nlaStripCount: z.number().int().nonnegative(),
    nlaTracks: z
      .array(
        z.strictObject({
          name: z.string(),
          mute: z.boolean(),
          solo: z.boolean(),
          strips: z.array(
            z.strictObject({
              name: z.string(),
              actionName: z.string().nullable(),
              frameStart: finite,
              frameEnd: finite,
              actionFrameStart: finite,
              actionFrameEnd: finite,
              blendMode: nlaBlendMode,
              influence: finite.min(0).max(1),
              repeat: finite.positive(),
              scale: finite.positive(),
            }),
          ),
        }),
      )
      .default([]),
  }),
  warnings: z.array(z.string()).default([]),
});

/** Current selection state: mode, active object, and selected object ids. */
export const blenderSelectionEvidenceSchema = z.strictObject({
  mode: blenderMode,
  activeObjectId: identifier.nullable(),
  selectedObjectIds: z.array(identifier),
});

/** Counts of scene entities: total objects, cameras, and lights. */
export const blenderSceneMetricsSchema = z.strictObject({
  entities: z.number().int().nonnegative(),
  objects: z.number().int().nonnegative(),
  cameras: z.number().int().nonnegative(),
  lights: z.number().int().nonnegative(),
});

/** Per-operation effect record: created, changed, deleted, and dirty object ids, plus selection and metrics. */
export const blenderOperationEffectSchema = z.strictObject({
  index: z.number().int().nonnegative(),
  op: z.string().trim().min(1),
  createdObjectIds: z.array(identifier),
  changedObjectIds: z.array(identifier),
  deletedObjectIds: z.array(identifier),
  dirtyObjectIds: z.array(identifier),
  mode: blenderMode,
  selectedObjectIds: z.array(identifier),
  activeObjectId: identifier.nullable(),
  metrics: compactCountMap,
  warnings: z.array(z.string()),
});

/** Receipt for a batch of operations: scene epoch, revision before/after, affected objects, selection, metrics, and warnings. */
export const blenderEffectReceiptSchema = z.strictObject({
  contract: z.literal(BLENDER_LIVE_CONTRACT),
  sceneEpoch,
  requestId: z.string().uuid(),
  revisionBefore: z.number().int().nonnegative(),
  revisionAfter: z.number().int().nonnegative(),
  createdObjectIds: z.array(identifier),
  changedObjectIds: z.array(identifier),
  deletedObjectIds: z.array(identifier),
  dirtyObjectIds: z.array(identifier),
  selection: blenderSelectionEvidenceSchema,
  metrics: z.strictObject({
    before: blenderSceneMetricsSchema,
    after: blenderSceneMetricsSchema,
  }),
  operations: z.array(blenderOperationEffectSchema),
  warnings: z.array(z.string()),
});

/** Focused evidence: a subset of the scene containing only the objects, cameras, and lights affected by a batch. */
export const blenderFocusedEvidenceSchema = z.strictObject({
  sceneEpoch,
  revision: z.number().int().nonnegative(),
  objects: z.array(blenderObjectSchema),
  cameras: z.array(blenderCameraSchema),
  lights: z.array(blenderLightSchema),
});

/** Acknowledgment that a live command batch was accepted and queued. */
export const blenderLiveJobAcceptedSchema = z.strictObject({
  contract: z.literal(BLENDER_LIVE_CONTRACT),
  jobId: z.string().uuid(),
  requestId: z.string().uuid(),
  status: z.literal("queued"),
});

/** Polled job status for a live command batch: queued, running, succeeded, or failed with optional result. */
export const blenderLiveJobSchema = z.strictObject({
  contract: z.literal(BLENDER_LIVE_CONTRACT),
  jobId: z.string().uuid(),
  requestId: z.string().uuid(),
  status: z.enum(["queued", "running", "succeeded", "failed"]),
  revision: z.number().int().nonnegative().nullable(),
  result: z.unknown().optional(),
  code: z.string().trim().min(1).nullable().optional(),
  error: z.string().nullable(),
});

/** Result of a native apply operation: scene epoch, job, receipt, and focused evidence. */
export const blenderNativeApplyResultSchema = z.strictObject({
  sceneEpoch,
  job: blenderLiveJobSchema,
  receipt: blenderEffectReceiptSchema,
  evidence: blenderFocusedEvidenceSchema,
});

/** A parsed live operation. */
export type BlenderLiveOperation = z.infer<typeof blenderLiveOperationSchema>;
/** A parsed agent-facing operation. */
export type BlenderAgentOperation = z.infer<typeof blenderAgentOperationSchema>;
/** A parsed native tool request. */
export type BlenderNativeToolRequest = z.infer<typeof blenderNativeToolRequestSchema>;
/** A parsed live command batch. */
export type BlenderLiveCommandBatch = z.infer<typeof blenderLiveCommandBatchSchema>;
/** Input shape for a live command batch. */
export type BlenderLiveCommandBatchInput = z.input<typeof blenderLiveCommandBatchSchema>;
/** Parsed health check response. */
export type BlenderLiveHealth = z.infer<typeof blenderLiveHealthSchema>;
/** Parsed live kernel status. */
export type BlenderLiveStatus = z.infer<typeof blenderLiveStatusSchema>;
/** Parsed scene snapshot. */
export type BlenderLiveSceneSnapshot = z.infer<typeof blenderLiveSceneSnapshotSchema>;
/** Parsed scene preview metadata. */
export type BlenderScenePreview = z.infer<typeof blenderScenePreviewSchema>;
/** Parsed deep object inspection. */
export type BlenderObjectInspection = z.infer<typeof blenderObjectInspectionSchema>;
/** Parsed material node graph. */
export type BlenderMaterialGraph = z.infer<typeof blenderMaterialGraphSchema>;
/** Parsed geometry node graph. */
export type BlenderGeometryGraph = z.infer<typeof blenderGeometryGraphSchema>;
/** Parsed per-operation effect record. */
export type BlenderOperationEffect = z.infer<typeof blenderOperationEffectSchema>;
/** Parsed batch effect receipt. */
export type BlenderEffectReceipt = z.infer<typeof blenderEffectReceiptSchema>;
/** Parsed focused evidence. */
export type BlenderFocusedEvidence = z.infer<typeof blenderFocusedEvidenceSchema>;
/** Parsed job accepted acknowledgment. */
export type BlenderLiveJobAccepted = z.infer<typeof blenderLiveJobAcceptedSchema>;
/** Parsed live job status. */
export type BlenderLiveJob = z.infer<typeof blenderLiveJobSchema>;
/** Parsed native apply result. */
export type BlenderNativeApplyResult = z.infer<typeof blenderNativeApplyResultSchema>;
