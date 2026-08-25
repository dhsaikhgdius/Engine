import type { IncomingMessage, ServerResponse } from "node:http";
import type { StageScene } from "@director/stage-protocol";
import {
  productionSceneCreateRequestSchema,
  productionSceneProjectUpdateRequestSchema,
  productionUpdateRequestSchema,
  type ProductionRecord,
} from "../gatewaySchemas";
import {
  ProductionMutationError,
  type ProductionMutationRequest,
  type ProductionMutationResult,
} from "../production/productionMutationCoordinator";
import { ProductionStateStoreError, type ProductionSceneProjectRecord } from "../production/productionStateStore";

type JsonWriter = (response: ServerResponse, status: number, body: unknown) => void;

export type ProductionRouteDependencies = {
  readBody: (request: IncomingMessage) => Promise<unknown>;
  json: JsonWriter;
  getProduction: () => ProductionRecord;
  applyProductionUpdate: (request: ProductionMutationRequest) => Promise<ProductionMutationResult>;
  getStageScene: () => StageScene;
  getSceneProject: (sceneId: string) => ProductionSceneProjectRecord | null;
  /**
   * Last complete workbench project persisted by agent edits. Serves as the
   * boot-restore fallback for scenes that never registered a production
   * project document (for example the default local stage scene).
   */
  readWorkbenchProjectFallback?: () => Promise<ProductionSceneProjectRecord["project"] | null>;
  saveSceneProject: (input: {
    sceneId: string;
    expectedRevision: number;
    project: ProductionSceneProjectRecord["project"];
    actor: string;
  }) => Promise<ProductionSceneProjectRecord>;
};

function productionMissing(response: ServerResponse, json: JsonWriter) {
  json(response, 404, { message: "制作项目不存在" });
}

function sceneStoreFailure(response: ServerResponse, json: JsonWriter, error: unknown) {
  if (!(error instanceof ProductionStateStoreError)) return false;
  json(response, error.status, { message: error.message, code: error.code });
  return true;
}

async function applyMutation(
  response: ServerResponse,
  json: JsonWriter,
  applyProductionUpdate: ProductionRouteDependencies["applyProductionUpdate"],
  request: ProductionMutationRequest,
) {
  try {
    const result = await applyProductionUpdate(request);
    json(response, 200, {
      ...result.record,
      mutation: {
        idempotencyReplayed: result.replayed,
      },
    });
  } catch (error) {
    if (!(error instanceof ProductionMutationError)) throw error;
    json(response, error.status, { message: error.message, code: error.code });
  }
}

/** Handles production metadata and scene references as one independently-testable route domain. */
export async function handleProductionRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  dependencies: ProductionRouteDependencies,
): Promise<boolean> {
  const { readBody, json, getProduction, applyProductionUpdate, getStageScene } = dependencies;
  const productionMatch = url.pathname.match(/^\/te-man\/director\/productions\/([^/]+)$/);
  if (request.method === "GET" && productionMatch) {
    const production = getProduction();
    if (decodeURIComponent(productionMatch[1]) !== production.productionId) {
      productionMissing(response, json);
    } else {
      json(response, 200, production);
    }
    return true;
  }
  if (request.method === "PUT" && productionMatch) {
    const production = getProduction();
    if (decodeURIComponent(productionMatch[1]) !== production.productionId) {
      productionMissing(response, json);
      return true;
    }
    const parsedPayload = productionUpdateRequestSchema.safeParse(await readBody(request));
    if (!parsedPayload.success) {
      json(response, 400, { message: "制作项目更新格式无效" });
      return true;
    }
    await applyMutation(response, json, applyProductionUpdate, {
      expectedRevision: parsedPayload.data.expectedRevision,
      operations: parsedPayload.data.operations,
      actor: parsedPayload.data.actor ?? "director-ui",
      idempotencyKey: parsedPayload.data.idempotencyKey,
      sceneSeeds: parsedPayload.data.sceneSeeds,
    });
    return true;
  }

  const productionScenesMatch = url.pathname.match(/^\/te-man\/director\/productions\/([^/]+)\/scenes$/);
  if (request.method === "POST" && productionScenesMatch) {
    const production = getProduction();
    if (decodeURIComponent(productionScenesMatch[1]) !== production.productionId) {
      productionMissing(response, json);
      return true;
    }
    const parsedPayload = productionSceneCreateRequestSchema.safeParse(await readBody(request));
    if (!parsedPayload.success) {
      json(response, 400, { message: "制作场景请求格式无效" });
      return true;
    }
    const payload = parsedPayload.data;
    const sourceProject = payload.sourceSceneId ? dependencies.getSceneProject(payload.sourceSceneId)?.project : null;
    const project = payload.project ?? sourceProject ?? undefined;
    if (!project) {
      json(response, 422, {
        message: payload.sourceSceneId
          ? `Source scene "${payload.sourceSceneId}" has no persisted project document. Save it before duplicating.`
          : "Creating a production scene requires a validated DirectorProject seed.",
        code: payload.sourceSceneId ? "source_scene_document_not_found" : "scene_project_required",
      });
      return true;
    }
    const operations: ProductionMutationRequest["operations"] = [
      { op: "add_scene_reference", sceneId: payload.sceneId, title: payload.title },
    ];
    if (payload.activate !== false) operations.push({ op: "set_active_scene", sceneId: payload.sceneId });
    await applyMutation(response, json, applyProductionUpdate, {
      expectedRevision: payload.expectedRevision,
      operations,
      actor: payload.actor ?? "director-ui",
      idempotencyKey: payload.idempotencyKey,
      sceneSeeds: [{ sceneId: payload.sceneId, project }],
    });
    return true;
  }

  const directorSceneProjectMatch = url.pathname.match(/^\/te-man\/director\/scenes\/([^/]+)\/project$/);
  if (directorSceneProjectMatch) {
    const sceneId = decodeURIComponent(directorSceneProjectMatch[1]);
    if (request.method === "GET") {
      const record = dependencies.getSceneProject(sceneId);
      if (record) {
        json(response, 200, record);
        return true;
      }
      const fallbackProject = await dependencies.readWorkbenchProjectFallback?.();
      if (fallbackProject) {
        json(response, 200, {
          sceneId,
          revision: 0,
          updatedAt: new Date().toISOString(),
          updatedBy: "workbench-fallback",
          project: fallbackProject,
        });
        return true;
      }
      json(response, 404, { message: "场景项目文档不存在", code: "scene_project_not_found" });
      return true;
    }
    if (request.method === "PUT") {
      const parsedPayload = productionSceneProjectUpdateRequestSchema.safeParse(await readBody(request));
      if (!parsedPayload.success) {
        json(response, 400, { message: "场景项目保存格式无效" });
        return true;
      }
      try {
        const record = await dependencies.saveSceneProject({
          sceneId,
          expectedRevision: parsedPayload.data.expectedRevision,
          project: parsedPayload.data.project,
          actor: parsedPayload.data.actor ?? "director-ui:scene-project",
        });
        json(response, 200, record);
      } catch (error) {
        if (!sceneStoreFailure(response, json, error)) throw error;
      }
      return true;
    }
  }

  const directorSceneMatch = url.pathname.match(/^\/te-man\/director\/scenes\/([^/]+)$/);
  if (request.method === "GET" && directorSceneMatch) {
    const sceneId = decodeURIComponent(directorSceneMatch[1]);
    const production = getProduction();
    const sceneProject = dependencies.getSceneProject(sceneId);
    if (sceneProject) {
      json(response, 200, {
        sceneId,
        revision: sceneProject.revision,
        scene: {
          scene: { backgroundColor: sceneProject.project.scene.backgroundColor },
          entities: sceneProject.project.objects
            .filter((object) => object.kind !== "camera")
            .map((object) => ({
              id: object.id,
              type: object.kind,
              color: object.color,
              visible: object.visible,
            })),
        },
      });
      return true;
    }
    const scene = getStageScene();
    json(response, 200, {
      sceneId,
      revision: production.production.scenes.find((entry) => entry.sceneId === sceneId)?.sourceRevision ?? 0,
      scene: {
        scene: { backgroundColor: "#373a40" },
        entities: Object.entries(scene.objects)
          .filter(([, object]) => object.kind !== "target")
          .map(([id, object]) => ({ id, type: object.kind, color: object.color, visible: true })),
      },
    });
    return true;
  }

  return false;
}
