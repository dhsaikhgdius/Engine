/**
 * Applies a capture-reconstruction plan (objects, cameras, fused shell mesh)
 * to a Director project through the same typed authoring actions agents use,
 * so plan application shares validation and provenance with agent edits.
 */
import { applyDirectorAuthoringActions, type DirectorAuthoringAction } from "@director/agent-engine";
import type {
  CapturePlanCamera,
  CaptureReconstructionPlan,
} from "../../../../../../packages/protocol/src/captureReconstructionProtocol";
import { DIRECTOR_CAMERA_ASPECT_RATIOS } from "../../../../../../packages/protocol/src/directorCameraProtocol";
import { getFocalLengthFromVerticalFov } from "../schema/cameraGeometry";
import type { DirectorProject } from "../schema/directorProject";
import { safeParseDirectorProject } from "../schema/directorProjectSchema";

/** Controls how a capture reconstruction plan is applied to the project. */
export type ApplyCaptureReconstructionOptions = {
  mode: "append" | "replace";
  includeCameras: boolean;
  /** Durable model asset for the fused shell mesh, staged by the caller. */
  shellAsset?: { id: string; url: string; fileName: string; realWorldSizeM: number } | null;
  appliedAt?: string;
};

/** Result of applying a capture reconstruction plan to a Director project. */
export type ApplyCaptureReconstructionResult = {
  project: DirectorProject;
  plan: CaptureReconstructionPlan;
  objectIds: string[];
  cameraIds: string[];
  shellObjectId: string | null;
  warnings: string[];
};

const ASPECT_VALUES: Record<(typeof DIRECTOR_CAMERA_ASPECT_RATIOS)[number], number> = {
  "16:9": 16 / 9,
  "9:16": 9 / 16,
  "1:1": 1,
  "4:3": 4 / 3,
  "1.85:1": 1.85,
  "2.39:1": 2.39,
};

function nearestAspectRatio(width: number, height: number) {
  const target = width / Math.max(height, 1);
  return DIRECTOR_CAMERA_ASPECT_RATIOS.reduce((best, candidate) =>
    Math.abs(ASPECT_VALUES[candidate] - target) < Math.abs(ASPECT_VALUES[best] - target) ? candidate : best,
  );
}

function cameraAction(camera: CapturePlanCamera): DirectorAuthoringAction {
  const aspectRatio = nearestAspectRatio(camera.width, camera.height);
  const distance = Math.hypot(
    camera.target[0] - camera.position[0],
    camera.target[1] - camera.position[1],
    camera.target[2] - camera.position[2],
  );
  return {
    action: "add_camera",
    id: camera.id,
    name: camera.name,
    position: [...camera.position],
    target: [...camera.target],
    aspect_ratio: aspectRatio,
    focal_length_mm: getFocalLengthFromVerticalFov(camera.fovYDeg, aspectRatio),
    focus_distance_m: Math.min(Math.max(distance, 0.2), 1_000),
    activate: false,
  };
}

/** Authoring actions and tracking ids produced from a reconstruction plan. */
export type CaptureReconstructionAuthoringBatch = {
  actions: DirectorAuthoringAction[];
  objectIds: string[];
  cameraIds: string[];
  shellObjectId: string | null;
};

/**
 * Turns a capture reconstruction plan into one authoring batch: metric wall
 * segments and floor, swinging door leaves (proximity interactions consumed by
 * Player Mode), translucent window panes, proxy item boxes, key-view cameras
 * for the render-and-compare loop, and optionally the fused shell mesh.
 *
 * `existingObjectIds` drives replace mode: those non-camera objects are
 * deleted before the reconstruction is authored.
 */
export function buildCaptureReconstructionAuthoringActions(
  plan: CaptureReconstructionPlan,
  options: ApplyCaptureReconstructionOptions & { existingObjectIds?: string[] },
): CaptureReconstructionAuthoringBatch {
  const enabled = plan.objects.filter((object) => object.enabled);
  if (!enabled.length) throw new Error("重建计划中没有启用的物体，无法应用");

  const actions: DirectorAuthoringAction[] = [];
  if (options.mode === "replace" && options.existingObjectIds?.length) {
    actions.push({ action: "delete_objects", object_ids: options.existingObjectIds, cascade: true, force: true });
  }

  let shellObjectId: string | null = null;
  if (options.shellAsset) {
    actions.push({
      action: "upsert_asset",
      asset: {
        id: options.shellAsset.id,
        kind: "prop",
        sourceType: "model",
        fileName: options.shellAsset.fileName,
        name: "扫描外壳网格",
        url: options.shellAsset.url,
        assetSource: "local",
        modelNormalization: "preserve",
        realWorldSizeM: Math.min(Math.max(options.shellAsset.realWorldSizeM, 0.001), 10_000),
        sizeSource: "estimated",
      },
    });
    shellObjectId = `${plan.id}-shell`;
    actions.push({
      action: "add_object",
      id: shellObjectId,
      name: "扫描外壳（融合体素）",
      kind: "prop",
      asset_id: options.shellAsset.id,
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      placement_mode: "floating",
    });
  }

  for (const object of enabled) {
    actions.push({
      action: "add_object",
      id: object.id,
      name: object.name,
      kind: "prop",
      geometry_type: object.geometryType,
      transform: {
        position: [...object.transform.position],
        rotation: [...object.transform.rotation],
        scale: [...object.transform.scale],
      },
      // Metric reconstruction is exact: only free-standing items may re-ground.
      placement_mode: object.role === "item" ? "grounded" : "floating",
      color: object.material.baseColor,
      material: object.material,
      ...(object.interaction
        ? {
            interaction: {
              prompt: object.interaction.prompt,
              radius_m: object.interaction.radiusM,
              closed_transform: {
                position: [...object.interaction.closedTransform.position],
                rotation: [...object.interaction.closedTransform.rotation],
                scale: [...object.interaction.closedTransform.scale],
              },
              open_transform: {
                position: [...object.interaction.openTransform.position],
                rotation: [...object.interaction.openTransform.rotation],
                scale: [...object.interaction.openTransform.scale],
              },
            },
          }
        : {}),
    });
  }

  const cameras = options.includeCameras ? plan.cameras : [];
  for (const camera of cameras) actions.push(cameraAction(camera));

  return {
    actions,
    objectIds: enabled.map((object) => object.id),
    cameraIds: cameras.map((camera) => camera.id),
    shellObjectId,
  };
}

/**
 * Direct in-store application used by the human reconstruction dialog.
 *
 * @param source - The current Director project to apply the plan to.
 * @param plan - The capture reconstruction plan produced by the gateway.
 * @param options - Controls append/replace mode, camera inclusion, and shell asset.
 * @returns The updated project, the applied plan, and tracking ids.
 */
export function applyCaptureReconstructionPlan(
  source: DirectorProject,
  plan: CaptureReconstructionPlan,
  options: ApplyCaptureReconstructionOptions,
): ApplyCaptureReconstructionResult {
  const batch = buildCaptureReconstructionAuthoringActions(plan, {
    ...options,
    existingObjectIds:
      options.mode === "replace"
        ? source.objects.filter((object) => object.kind !== "camera").map((object) => object.id)
        : [],
  });
  const authored = applyDirectorAuthoringActions(source, batch.actions);
  const validated = safeParseDirectorProject(authored.project);
  if (!validated.success) throw new Error(validated.error);
  return {
    project: validated.project,
    plan: {
      ...plan,
      status: "applied",
      application: {
        appliedAt: options.appliedAt ?? new Date().toISOString(),
        objectIds: batch.objectIds,
        cameraIds: batch.cameraIds,
        shellObjectId: batch.shellObjectId,
      },
    },
    objectIds: batch.objectIds,
    cameraIds: batch.cameraIds,
    shellObjectId: batch.shellObjectId,
    warnings: plan.analysis.warnings,
  };
}
