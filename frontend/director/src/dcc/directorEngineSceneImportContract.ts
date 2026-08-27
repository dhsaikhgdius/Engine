import { z } from "zod";
import { DIRECTOR_PROJECT_REVISION_PATTERN } from "../comprehensive/editor/schema/directorProjectRevision";
import { directorTransformSchema } from "../comprehensive/editor/schema/directorProjectSchema";
import { DIRECTOR_LIGHT_TYPES } from "../comprehensive/editor/schema/directorProject";
import { directorCameraAspectRatioSchema } from "../../../../packages/protocol/src/directorCameraProtocol";
import { strictOperation } from "../../../../packages/protocol/src/strictProtocolVariant";
import { directorDccVec3Schema } from "./directorDccSharedContract";

/**
 * Game-engine → Director scene import vocabulary: the scene manifest an
 * engine connector exports (Unreal / Unity / Godot), the reviewable import
 * plan the gateway derives from it, and the selection the human confirms
 * before anything is applied. Mirrors the Blender scene-import contract so
 * every host import flows through the same manifest → plan → confirm shape.
 */

/** Contract identifier for the game-engine scene export manifest (Unreal / Unity / Godot). */
export const DIRECTOR_ENGINE_SCENE_CONTRACT = "director-engine-scene-v1" as const;

/** Contract identifier for the game-engine scene import plan. */
export const DIRECTOR_ENGINE_SCENE_IMPORT_PLAN_CONTRACT = "director-engine-scene-import-plan-v1" as const;

/** Engine providers that can produce a director-engine-scene-v1 package. */
export const directorEngineSceneProviderSchema = z.enum(["unreal", "unity", "godot"]);

/** An engine provider id that can produce an engine scene package. */
export type DirectorEngineSceneProvider = z.infer<typeof directorEngineSceneProviderSchema>;

const nonEmpty = z.string().trim().min(1);
const finite = z.number().finite();
const sha256 = z.string().regex(/^[0-9a-f]{64}$/, "expected lowercase SHA-256 hex");
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "expected #rrggbb hex color");
const safeRelativePath = z
  .string()
  .trim()
  .min(1)
  .max(1_024)
  .refine((value) => !value.startsWith("/") && !value.startsWith("\\") && !/^[A-Za-z]:/.test(value), {
    message: "path must be relative",
  })
  .refine((value) => !value.includes("\\"), { message: "path must use forward slashes" })
  .refine((value) => value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== ".."), {
    message: "path cannot contain empty, dot, or parent segments",
  });

/**
 * Source coordinate conventions per engine provider. Exporters convert every
 * transform into Director's destination convention (right-handed, Y-up,
 * -Z forward, meters) before writing the manifest; this table documents the
 * exact linear map they applied so packages remain auditable.
 */
export const DIRECTOR_ENGINE_COORDINATE_SYSTEMS = Object.freeze({
  unreal: {
    source: "left-handed-z-up-x-forward-centimeter",
    destination: "right-handed-y-up-negative-z-forward",
    unit: "meter",
    linearMap: "(x,y,z)->(y,z,-x)*0.01",
  },
  unity: {
    source: "left-handed-y-up-z-forward-meter",
    destination: "right-handed-y-up-negative-z-forward",
    unit: "meter",
    linearMap: "(x,y,z)->(-x,y,z)",
  },
  // Godot 4 already authors in Director's convention; the exporter still
  // declares the identity map so packages stay auditable.
  godot: {
    source: "right-handed-y-up-negative-z-forward-meter",
    destination: "right-handed-y-up-negative-z-forward",
    unit: "meter",
    linearMap: "(x,y,z)->(x,y,z)",
  },
} as const) satisfies Record<
  DirectorEngineSceneProvider,
  { source: string; destination: string; unit: string; linearMap: string }
>;

const engineCoordinateSystemSchema = z.strictObject({
  source: z.enum([
    DIRECTOR_ENGINE_COORDINATE_SYSTEMS.unreal.source,
    DIRECTOR_ENGINE_COORDINATE_SYSTEMS.unity.source,
    DIRECTOR_ENGINE_COORDINATE_SYSTEMS.godot.source,
  ]),
  destination: z.literal("right-handed-y-up-negative-z-forward"),
  unit: z.literal("meter"),
  linearMap: z.enum([
    DIRECTOR_ENGINE_COORDINATE_SYSTEMS.unreal.linearMap,
    DIRECTOR_ENGINE_COORDINATE_SYSTEMS.unity.linearMap,
    DIRECTOR_ENGINE_COORDINATE_SYSTEMS.godot.linearMap,
  ]),
});

/** The kinds of engine scene nodes recorded in the hierarchy snapshot. */
export const directorEngineSceneNodeKindSchema = z.enum(["mesh", "skinned-mesh", "camera", "light", "group", "other"]);

const engineNodeSchema = z.strictObject({
  sourceId: nonEmpty.max(240),
  name: nonEmpty.max(240),
  parentSourceId: nonEmpty.max(240).optional(),
  kind: directorEngineSceneNodeKindSchema,
  /** Director-space TRS (meters, Y-up, XYZ Euler radians). */
  transform: directorTransformSchema,
});

const engineCameraSchema = z
  .strictObject({
    sourceId: nonEmpty.max(240),
    name: nonEmpty.max(240),
    /** Director-space world position in meters. */
    position: directorDccVec3Schema,
    /** Director-space world look target in meters. */
    lookTarget: directorDccVec3Schema,
    verticalFovDegrees: finite.positive().max(179),
    sensorWidthMm: finite.positive().max(1_000).optional(),
    sensorHeightMm: finite.positive().max(1_000).optional(),
    apertureFStop: finite.positive().max(256).optional(),
    focusDistanceM: finite.positive().max(1_000_000).optional(),
    nearClipM: finite.positive().max(100_000),
    farClipM: finite.positive().max(10_000_000),
    renderAspectRatio: finite.positive().max(20),
  })
  .superRefine((camera, context) => {
    if (camera.farClipM <= camera.nearClipM) {
      context.addIssue({ code: "custom", path: ["farClipM"], message: "far clip must exceed near clip" });
    }
    const [px, py, pz] = camera.position;
    const [tx, ty, tz] = camera.lookTarget;
    if (Math.hypot(tx - px, ty - py, tz - pz) < 1e-6) {
      context.addIssue({
        code: "custom",
        path: ["lookTarget"],
        message: "camera look target cannot coincide with its position",
      });
    }
  });

const engineLightTypeSchema = z.enum(DIRECTOR_LIGHT_TYPES);

const engineLightSchema = z
  .strictObject({
    sourceId: nonEmpty.max(240),
    name: nonEmpty.max(240),
    type: engineLightTypeSchema,
    color: hexColor,
    /** Director-normalized intensity (0..100); exporters document their mapping. */
    intensity: finite.min(0).max(100),
    /** Director-space world position in meters (omitted for ambient light). */
    position: directorDccVec3Schema.optional(),
    /** Director-space world aim point for directional / spot / rect-area lights. */
    target: directorDccVec3Schema.optional(),
    rangeM: finite.positive().max(1_000_000).optional(),
    angleDegrees: finite.positive().max(179).optional(),
    penumbra: finite.min(0).max(1).optional(),
    widthM: finite.positive().max(1_000_000).optional(),
    heightM: finite.positive().max(1_000_000).optional(),
    castShadow: z.boolean().optional(),
  })
  .superRefine((light, context) => {
    if (light.type !== "ambient" && light.type !== "hemisphere" && !light.position) {
      context.addIssue({
        code: "custom",
        path: ["position"],
        message: `${light.type} lights must carry a world position`,
      });
    }
    if ((light.type === "directional" || light.type === "spot" || light.type === "rect-area") && !light.target) {
      context.addIssue({
        code: "custom",
        path: ["target"],
        message: `${light.type} lights must carry an aim target`,
      });
    }
    if (light.type === "spot" && light.angleDegrees === undefined) {
      context.addIssue({ code: "custom", path: ["angleDegrees"], message: "spot lights must carry a cone angle" });
    }
    if (light.type === "rect-area" && (light.widthM === undefined || light.heightM === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["widthM"],
        message: "rect-area lights must carry width and height",
      });
    }
  });

/**
 * The manifest for a game-engine scene export (Unreal Engine, Unity, or
 * Godot), describing the source project, timeline, hierarchy snapshot,
 * cameras, lights, animation clips, and a GLB bundle for renderable geometry.
 *
 * Unlike the Blender manifest, every transform is already expressed in
 * Director's convention: the engine-side exporter owns the coordinate
 * conversion because it has access to the engine's own transform APIs.
 */
export const directorEngineSceneManifestSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    contract: z.literal(DIRECTOR_ENGINE_SCENE_CONTRACT),
    packageId: nonEmpty.max(240),
    provider: directorEngineSceneProviderSchema,
    exportedAt: z.string().datetime({ offset: true }),
    engineVersion: nonEmpty.max(200),
    exporter: z.strictObject({
      name: nonEmpty.max(120),
      version: nonEmpty.max(60),
    }),
    source: z.strictObject({
      projectName: nonEmpty.max(240),
      sceneName: nonEmpty.max(240),
    }),
    coordinateSystem: engineCoordinateSystemSchema,
    timeline: z.strictObject({
      frameStart: finite,
      frameEnd: finite,
      currentFrame: finite,
      fps: finite.positive().max(1_000),
    }),
    scene: z.strictObject({
      name: nonEmpty.max(240),
      bundleFile: safeRelativePath.nullable(),
      nodeCount: z.number().int().nonnegative().max(1_000_000),
      meshCount: z.number().int().nonnegative().max(1_000_000),
      skinnedMeshCount: z.number().int().nonnegative().max(1_000_000),
      materialCount: z.number().int().nonnegative().max(1_000_000),
      animationClipCount: z.number().int().nonnegative().max(1_000_000),
    }),
    nodes: z.array(engineNodeSchema).max(20_000),
    cameras: z.array(engineCameraSchema).max(512),
    lights: z.array(engineLightSchema).max(1_024),
    animationClips: z
      .array(
        z.strictObject({
          name: nonEmpty.max(240),
          durationSeconds: finite.nonnegative().max(1_000_000).optional(),
        }),
      )
      .max(512),
    unsupported: z
      .array(
        z.strictObject({
          kind: nonEmpty.max(120),
          name: nonEmpty.max(240),
          reason: nonEmpty.max(2_000),
        }),
      )
      .max(20_000),
    warnings: z.array(z.string().max(2_000)).max(20_000),
    fileHashes: z.record(safeRelativePath, sha256),
  })
  .superRefine((manifest, context) => {
    const expected = DIRECTOR_ENGINE_COORDINATE_SYSTEMS[manifest.provider];
    if (manifest.coordinateSystem.source !== expected.source) {
      context.addIssue({
        code: "custom",
        path: ["coordinateSystem", "source"],
        message: `${manifest.provider} packages must declare the ${expected.source} source convention`,
      });
    }
    if (manifest.coordinateSystem.linearMap !== expected.linearMap) {
      context.addIssue({
        code: "custom",
        path: ["coordinateSystem", "linearMap"],
        message: `${manifest.provider} packages must declare the ${expected.linearMap} linear map`,
      });
    }
    if (manifest.scene.bundleFile && manifest.fileHashes[manifest.scene.bundleFile] === undefined) {
      context.addIssue({
        code: "custom",
        path: ["scene", "bundleFile"],
        message: "scene bundle must have a manifest SHA-256 entry",
      });
    }
    if ((manifest.scene.meshCount > 0 || manifest.scene.skinnedMeshCount > 0) && !manifest.scene.bundleFile) {
      context.addIssue({
        code: "custom",
        path: ["scene", "bundleFile"],
        message: "a scene with renderable geometry must provide a GLB bundle",
      });
    }
    if (manifest.nodes.length > manifest.scene.nodeCount) {
      context.addIssue({
        code: "custom",
        path: ["scene", "nodeCount"],
        message: "nodeCount cannot be smaller than the recorded hierarchy snapshot",
      });
    }
    const nodeIds = new Set<string>();
    manifest.nodes.forEach((node, index) => {
      if (nodeIds.has(node.sourceId)) {
        context.addIssue({ code: "custom", path: ["nodes", index, "sourceId"], message: "duplicate node sourceId" });
      }
      nodeIds.add(node.sourceId);
      if (node.parentSourceId === node.sourceId) {
        context.addIssue({
          code: "custom",
          path: ["nodes", index, "parentSourceId"],
          message: "a node cannot parent itself",
        });
      }
    });
    manifest.nodes.forEach((node, index) => {
      if (node.parentSourceId && !nodeIds.has(node.parentSourceId)) {
        context.addIssue({
          code: "custom",
          path: ["nodes", index, "parentSourceId"],
          message: `parent ${node.parentSourceId} is not in the hierarchy snapshot`,
        });
      }
    });
    const cameraIds = new Set<string>();
    manifest.cameras.forEach((camera, index) => {
      if (cameraIds.has(camera.sourceId)) {
        context.addIssue({
          code: "custom",
          path: ["cameras", index, "sourceId"],
          message: "duplicate camera sourceId",
        });
      }
      cameraIds.add(camera.sourceId);
    });
    const lightIds = new Set<string>();
    manifest.lights.forEach((light, index) => {
      if (lightIds.has(light.sourceId)) {
        context.addIssue({
          code: "custom",
          path: ["lights", index, "sourceId"],
          message: "duplicate light sourceId",
        });
      }
      lightIds.add(light.sourceId);
    });
  });

const importOperationSchema = z.discriminatedUnion("op", [
  strictOperation("create_scene_asset", {
    assetId: nonEmpty.max(240),
    label: nonEmpty.max(240),
    glbPath: safeRelativePath,
    hash: sha256,
  }),
  strictOperation("create_scene_object", {
    objectId: nonEmpty.max(240),
    name: nonEmpty.max(240),
    assetId: nonEmpty.max(240),
    transform: directorTransformSchema,
  }),
  strictOperation("create_camera", {
    sourceId: nonEmpty.max(240),
    cameraId: nonEmpty.max(240),
    objectId: nonEmpty.max(240),
    name: nonEmpty.max(240),
    position: z.tuple([finite, finite, finite]),
    target: z.tuple([finite, finite, finite]),
    focalLengthMm: finite.min(12).max(200),
    sensorFormat: z.enum(["super16", "super35", "fullFrame", "imax65"]),
    apertureFStop: finite.min(0.7).max(64),
    focusDistanceM: finite.min(0.01).max(10_000),
    nearClipM: finite.min(0.001).max(100),
    farClipM: finite.min(1).max(1_000_000),
    aspectRatio: directorCameraAspectRatioSchema,
  }),
  strictOperation("create_light", {
    sourceId: nonEmpty.max(240),
    lightId: nonEmpty.max(200),
    name: nonEmpty.max(240),
    type: engineLightTypeSchema,
    color: hexColor,
    intensity: finite.min(0).max(100),
    position: z.tuple([finite, finite, finite]).optional(),
    target: z.tuple([finite, finite, finite]).optional(),
    distance: finite.min(0).max(1_000_000).optional(),
    angle: finite
      .min(0.001)
      .max(Math.PI / 2)
      .optional(),
    penumbra: finite.min(0).max(1).optional(),
    width: finite.positive().max(1_000_000).optional(),
    height: finite.positive().max(1_000_000).optional(),
    castShadow: z.boolean().optional(),
  }),
  strictOperation("skip", { sourceId: nonEmpty.max(240), reason: nonEmpty.max(2_000) }),
  strictOperation("warn", { message: nonEmpty.max(2_000) }),
]);

/** User selection of which engine scene elements to import. */
export const directorEngineSceneImportSelectionSchema = z.strictObject({
  includeScene: z.boolean(),
  cameraSourceIds: z.array(nonEmpty.max(240)).max(512),
  lightSourceIds: z.array(nonEmpty.max(240)).max(1_024),
});

/** Typed warn-and-omit codes for engine scene data an import plan leaves behind. */
export const DIRECTOR_ENGINE_SCENE_OMITTED_CODES = [
  "unsupported_object",
  "hierarchy_flattened",
  "animation_clips",
  "skinned_mesh_rigs",
  "camera_roll",
] as const;

/**
 * Typed warn-and-omit record for engine scene data the import plan leaves
 * behind. Free-text `warnings` stay for humans; agents should read this array
 * (mirrors the Blender scene import `omitted` and the DCC return plan
 * `omittedOptics` / `omittedAdditions`).
 *
 * - `unsupported_object`: the exporter skipped a scene element it cannot carry (`kind` carries the engine type).
 * - `hierarchy_flattened`: the scene imports as one flattened Director scene object; per-node edits need the planned engine round trip.
 * - `animation_clips`: engine animation clips stay embedded in the GLB and are not mapped onto Director's editable timeline.
 * - `skinned_mesh_rigs`: skinned-mesh skeletons stay inside the GLB and are not rebound to Director's character rig system.
 * - `camera_roll`: engine camera roll cannot be expressed by Director's target-based camera model.
 */
export const directorEngineSceneOmittedSchema = z.strictObject({
  sourceId: nonEmpty.max(240),
  /** Engine element kind for `unsupported_object` records. */
  kind: nonEmpty.max(120).optional(),
  code: z.enum(DIRECTOR_ENGINE_SCENE_OMITTED_CODES),
  reason: nonEmpty.max(2_000),
});

/** A validated engine scene import omitted record. */
export type DirectorEngineSceneOmitted = z.infer<typeof directorEngineSceneOmittedSchema>;

/** A typed warn-and-omit code on an engine scene import plan. */
export type DirectorEngineSceneOmittedCode = DirectorEngineSceneOmitted["code"];

/**
 * An import plan generated from an engine scene manifest.
 * Contains the concrete operations Director will execute to import the scene,
 * plus any conflicts that prevent the plan from being ready.
 */
export const directorEngineSceneImportPlanSchema = z
  .strictObject({
    contract: z.literal(DIRECTOR_ENGINE_SCENE_IMPORT_PLAN_CONTRACT),
    planId: safeRelativePath,
    ready: z.boolean(),
    provider: directorEngineSceneProviderSchema,
    packageId: nonEmpty.max(240),
    packageDir: safeRelativePath,
    manifestHash: sha256,
    targetRevision: z.string().regex(DIRECTOR_PROJECT_REVISION_PATTERN),
    selection: directorEngineSceneImportSelectionSchema,
    operations: z.array(importOperationSchema).max(4_000),
    conflicts: z
      .array(
        z.strictObject({
          sourceId: nonEmpty.max(240),
          code: z.enum(["id_collision", "empty_selection", "unsupported_scene"]),
          reason: nonEmpty.max(2_000),
        }),
      )
      .max(4_000),
    warnings: z.array(z.string().max(2_000)).max(20_000),
    /**
     * Count of typed omitted records. Optional for plans persisted before
     * typed omits; when omitted is present, length must equal this count.
     */
    omittedCount: z.number().int().nonnegative().max(100_000).optional(),
    /**
     * Typed warn-and-omit records for engine scene data the plan leaves
     * behind. Optional for older stored plans; when present, length must
     * equal omittedCount. The cap covers the manifest `unsupported` cap plus
     * per-camera and per-scene records.
     */
    omitted: z.array(directorEngineSceneOmittedSchema).max(21_000).optional(),
  })
  .superRefine((plan, context) => {
    if (plan.ready && plan.conflicts.length > 0) {
      context.addIssue({ code: "custom", path: ["ready"], message: "ready plans cannot contain conflicts" });
    }
    if (new Set(plan.selection.cameraSourceIds).size !== plan.selection.cameraSourceIds.length) {
      context.addIssue({
        code: "custom",
        path: ["selection", "cameraSourceIds"],
        message: "camera selection must be unique",
      });
    }
    if (new Set(plan.selection.lightSourceIds).size !== plan.selection.lightSourceIds.length) {
      context.addIssue({
        code: "custom",
        path: ["selection", "lightSourceIds"],
        message: "light selection must be unique",
      });
    }
    if (plan.omitted !== undefined) {
      if (plan.omittedCount === undefined) {
        context.addIssue({
          code: "custom",
          path: ["omittedCount"],
          message: "omittedCount is required when omitted is present",
        });
      } else if (plan.omitted.length !== plan.omittedCount) {
        context.addIssue({
          code: "custom",
          path: ["omitted"],
          message: "omitted length must equal omittedCount",
        });
      }
    }
  });

/** A game-engine scene export manifest (v1). */
export type DirectorEngineSceneManifestV1 = z.infer<typeof directorEngineSceneManifestSchema>;

/** User selection of elements to import from an engine scene. */
export type DirectorEngineSceneImportSelection = z.infer<typeof directorEngineSceneImportSelectionSchema>;

/** An import plan derived from an engine scene manifest (v1). */
export type DirectorEngineSceneImportPlanV1 = z.infer<typeof directorEngineSceneImportPlanSchema>;

/** A single operation within an engine scene import plan. */
export type DirectorEngineSceneImportOperation = DirectorEngineSceneImportPlanV1["operations"][number];

/** A single camera record inside an engine scene manifest. */
export type DirectorEngineSceneCamera = DirectorEngineSceneManifestV1["cameras"][number];

/** A single light record inside an engine scene manifest. */
export type DirectorEngineSceneLight = DirectorEngineSceneManifestV1["lights"][number];

/** A single hierarchy node record inside an engine scene manifest. */
export type DirectorEngineSceneNode = DirectorEngineSceneManifestV1["nodes"][number];
