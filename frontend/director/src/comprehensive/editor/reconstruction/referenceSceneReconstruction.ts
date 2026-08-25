import { applyDirectorAuthoringActions, type DirectorAuthoringAction } from "@director/agent-engine";
import {
  referenceSceneAnalysisResponseSchema,
  referenceSceneReconstructionPlanSchema,
  type ReferenceSceneAnalysisRequest,
  type ReferenceSceneReconstructionPlan,
} from "../../../../../../packages/protocol/src/referenceSceneReconstructionProtocol";
import { directorControlPlaneFetch } from "../api/directorControlPlaneClient";
import type { DirectorProject } from "../schema/directorProject";
import { getDirectorProjectRevision } from "../schema/directorProjectRevision";
import { safeParseDirectorProject } from "../schema/directorProjectSchema";

/** Error thrown by the reference scene HTTP client when a request fails. */
export class ReferenceSceneClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ReferenceSceneClientError";
  }
}

/** Error thrown when the project has changed since the reference scene analysis was produced. */
export class ReferenceScenePlanConflictError extends Error {
  readonly code = "stale_project_revision";

  constructor(
    readonly expectedRevision: string,
    readonly actualRevision: string,
  ) {
    super("片场在分析后已经变化，请重新分析参考图后再应用。");
    this.name = "ReferenceScenePlanConflictError";
  }
}

/**
 * Sends a reference image to the gateway for scene analysis and reconstruction
 * planning.
 *
 * @param request - The analysis request containing the reference image, its
 *                   metrics, and the current project revision.
 * @param signal - Optional abort signal for cancellation.
 * @returns A reconstruction plan with objects, lights, and scene settings.
 */
export async function requestReferenceSceneAnalysis(
  request: ReferenceSceneAnalysisRequest,
  signal?: AbortSignal,
): Promise<ReferenceSceneReconstructionPlan> {
  const response = await directorControlPlaneFetch("/api/reconstruction/reference-scene/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new ReferenceSceneClientError(
      typeof body.error === "string" ? body.error : "参考图分析失败",
      response.status,
      typeof body.code === "string" ? body.code : undefined,
    );
  }
  return referenceSceneAnalysisResponseSchema.parse(body).plan;
}

function sourceAssetId(plan: ReferenceSceneReconstructionPlan) {
  return `reference-image-${plan.source.sha256.slice(0, 20)}`;
}

/**
 * Applies a reference scene reconstruction plan to a Director project,
 * authoring objects, lights, scene background color, and reference image
 * bindings. Rejects if the project revision has drifted since analysis.
 *
 * @param source - The current Director project to apply the plan to.
 * @param rawPlan - The reconstruction plan from the gateway (validated on entry).
 * @param sourceDataUrl - The data URL of the reference image to bind as an asset.
 * @param appliedAt - ISO timestamp recorded in the applied plan.
 * @returns The updated project, authored plan, and source asset id.
 */
export function applyReferenceSceneReconstructionPlan(
  source: DirectorProject,
  rawPlan: ReferenceSceneReconstructionPlan,
  sourceDataUrl: string,
  appliedAt = new Date().toISOString(),
) {
  const plan = referenceSceneReconstructionPlanSchema.parse(rawPlan);
  const actualRevision = getDirectorProjectRevision(source);
  if (plan.expectedProjectRevision !== actualRevision) {
    throw new ReferenceScenePlanConflictError(plan.expectedProjectRevision, actualRevision);
  }
  if (!sourceDataUrl.startsWith(`data:${plan.source.mimeType};base64,`)) {
    throw new Error("参考图数据与分析计划的 MIME 类型不一致");
  }

  const assetId = sourceAssetId(plan);
  const enabledObjects = plan.objects.filter((object) => object.enabled);
  const enabledLights = plan.lights.filter((light) => light.enabled);
  if (!enabledObjects.length) throw new Error("至少选择一个重建物体后才能应用");

  const actions: DirectorAuthoringAction[] = [
    {
      action: "upsert_asset",
      asset: {
        id: assetId,
        kind: "prop",
        sourceType: "image",
        fileName: plan.source.fileName,
        name: plan.source.fileName,
        url: sourceDataUrl,
        assetSource: "local",
      },
    },
  ];
  if (plan.applyMode === "replace") {
    const objectIds = source.objects.filter((object) => object.kind !== "camera").map((object) => object.id);
    if (objectIds.length) actions.push({ action: "delete_objects", object_ids: objectIds, cascade: true, force: true });
    const lightIds = (source.lights ?? []).map((light) => light.id);
    if (lightIds.length) actions.push({ action: "delete_lights", light_ids: lightIds, force: true });
  }
  actions.push({ action: "set_scene", patch: { backgroundColor: plan.backgroundColor } });
  enabledObjects.forEach((object) => {
    actions.push({
      action: "add_object",
      id: object.id,
      name: object.name,
      kind: "prop",
      geometry_type: object.geometryType,
      transform: object.transform,
      placement_mode: object.placementMode,
      color: object.material.baseColor,
      material: object.material,
      reference_bindings: [
        {
          id: `${object.id}-reference`,
          kind: "image",
          label: plan.source.fileName,
          ref: assetId,
          showInViewport: false,
        },
      ],
    });
  });
  enabledLights.forEach((light) => {
    actions.push({
      action: "add_light",
      light: {
        id: light.id,
        name: light.name,
        type: light.type,
        visible: true,
        locked: false,
        color: light.color,
        intensity: light.intensity,
        position: light.position,
        target: light.target,
        castShadow: light.castShadow,
      },
    });
  });

  const authored = applyDirectorAuthoringActions(source, actions);
  const appliedPlan = referenceSceneReconstructionPlanSchema.parse({
    ...plan,
    status: "applied",
    application: {
      appliedAt,
      sourceAssetId: assetId,
      objectIds: enabledObjects.map((object) => object.id),
      lightIds: enabledLights.map((light) => light.id),
    },
  });
  authored.project.referenceReconstructions = [
    ...(source.referenceReconstructions ?? []).filter((entry) => entry.id !== appliedPlan.id),
    appliedPlan,
  ].slice(-64);
  const validated = safeParseDirectorProject(authored.project);
  if (!validated.success) throw new Error(validated.error);
  return {
    ...authored,
    project: validated.project,
    plan: appliedPlan,
    sourceAssetId: assetId,
  };
}
