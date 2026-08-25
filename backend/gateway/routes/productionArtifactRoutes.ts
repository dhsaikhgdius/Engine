import type { IncomingMessage, ServerResponse } from "node:http";

import { z } from "zod";

import {
  productionApprovalInputSchema,
  productionArtifactPromotionRequestSchema,
  productionArtifactVersionInputSchema,
  productionPromotionTargetSchema,
} from "../../../packages/protocol/src/productionArtifactProtocol";
import {
  ProductionArtifactConflictError,
  ProductionArtifactValidationError,
  type ProductionArtifactStore,
} from "../artifacts/productionArtifactStore";

type JsonWriter = (response: ServerResponse, status: number, body: unknown) => void;

/** Dependencies required by the production artifact HTTP route handler. */
export interface ProductionArtifactRouteDependencies {
  /** Parses the request body into a JSON-compatible value. */
  readonly readBody: (request: IncomingMessage) => Promise<unknown>;
  /** Writes a JSON response with the given status code. */
  readonly json: JsonWriter;
  /** The production artifact store for persistence. */
  readonly store: ProductionArtifactStore;
  /** Clock that returns ISO 8601 timestamps. */
  readonly now: () => string;
}

const putVersionRequestSchema = z.strictObject({ version: productionArtifactVersionInputSchema });
const putApprovalRequestSchema = z.strictObject({ approval: productionApprovalInputSchema });
const routeIdSchema = z.string().trim().min(1).max(240);

function decodedRouteId(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix)) return null;
  const remainder = pathname.slice(prefix.length);
  if (!remainder || remainder.includes("/")) return null;
  try {
    return routeIdSchema.safeParse(decodeURIComponent(remainder)).data ?? null;
  } catch {
    return null;
  }
}

async function writeStoreMutation<Result extends { replayed: boolean }>(
  response: ServerResponse,
  json: JsonWriter,
  action: () => Promise<Result>,
  validationCode?: string,
) {
  try {
    const result = await action();
    json(response, result.replayed ? 200 : 201, result);
  } catch (error) {
    if (error instanceof ProductionArtifactConflictError) {
      json(response, 409, { code: error.code, message: error.message });
    } else if (error instanceof ProductionArtifactValidationError) {
      json(response, 422, { code: validationCode ?? error.code, message: error.message });
    } else {
      throw error;
    }
  }
}

/**
 * Handles HTTP requests for production artifact versions, approvals, and
 * promotions.
 *
 * Routes:
 * - `POST /api/production/artifact-versions` — create a new artifact version.
 * - `GET /api/production/artifact-versions` — list versions, optionally filtered by `artifact_id`.
 * - `GET /api/production/artifact-versions/:id` — get a single version.
 * - `POST /api/production/approvals` — create a new approval.
 * - `GET /api/production/approvals/:id` — get a single approval.
 * - `POST /api/production/promotions` — promote an artifact.
 * - `GET /api/production/promotions/current` — get the current promotion for a target.
 *
 * @param request - The incoming HTTP request.
 * @param response - The outgoing HTTP response.
 * @param url - The parsed request URL.
 * @param dependencies - The route dependencies.
 * @returns True if the route was handled, false otherwise.
 */
export async function handleProductionArtifactRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  dependencies: ProductionArtifactRouteDependencies,
): Promise<boolean> {
  const { json, store } = dependencies;

  if (url.pathname === "/api/production/artifact-versions" && request.method === "POST") {
    const parsed = putVersionRequestSchema.safeParse(await dependencies.readBody(request));
    if (!parsed.success) {
      json(response, 400, { code: "invalid_artifact_version", issues: parsed.error.issues });
      return true;
    }
    await writeStoreMutation(response, json, () => store.putVersion(parsed.data.version));
    return true;
  }

  if (url.pathname === "/api/production/artifact-versions" && request.method === "GET") {
    const rawArtifactId = url.searchParams.get("artifact_id");
    const parsedArtifactId = rawArtifactId === null ? undefined : routeIdSchema.safeParse(rawArtifactId);
    if (parsedArtifactId !== undefined && !parsedArtifactId.success) {
      json(response, 400, { code: "invalid_artifact_id", issues: parsedArtifactId.error.issues });
      return true;
    }
    const artifactId = parsedArtifactId?.data;
    json(response, 200, { versions: await store.listVersions(artifactId) });
    return true;
  }

  const versionId = decodedRouteId(url.pathname, "/api/production/artifact-versions/");
  if (versionId && request.method === "GET") {
    const version = await store.getVersion(versionId);
    if (!version) json(response, 404, { code: "artifact_version_not_found" });
    else json(response, 200, { version });
    return true;
  }

  if (url.pathname === "/api/production/approvals" && request.method === "POST") {
    const parsed = putApprovalRequestSchema.safeParse(await dependencies.readBody(request));
    if (!parsed.success) {
      json(response, 400, { code: "invalid_production_approval", issues: parsed.error.issues });
      return true;
    }
    await writeStoreMutation(response, json, () => store.putApproval(parsed.data.approval));
    return true;
  }

  const approvalId = decodedRouteId(url.pathname, "/api/production/approvals/");
  if (approvalId && request.method === "GET") {
    const approval = await store.getApproval(approvalId);
    if (!approval) json(response, 404, { code: "production_approval_not_found" });
    else json(response, 200, { approval });
    return true;
  }

  if (url.pathname === "/api/production/promotions" && request.method === "POST") {
    const parsed = productionArtifactPromotionRequestSchema.safeParse(await dependencies.readBody(request));
    if (!parsed.success) {
      json(response, 400, { code: "invalid_artifact_promotion", issues: parsed.error.issues });
      return true;
    }
    await writeStoreMutation(
      response,
      json,
      () => store.promote({ ...parsed.data, promotedAt: dependencies.now() }),
      "artifact_promotion_rejected",
    );
    return true;
  }

  if (url.pathname === "/api/production/promotions/current" && request.method === "GET") {
    const parsed = productionPromotionTargetSchema.safeParse({
      workspace: url.searchParams.get("workspace"),
      ownerId: url.searchParams.get("owner_id"),
      slot: url.searchParams.get("slot"),
    });
    if (!parsed.success) {
      json(response, 400, { code: "invalid_promotion_target", issues: parsed.error.issues });
      return true;
    }
    json(response, 200, { promotion: await store.getCurrentPromotion(parsed.data) });
    return true;
  }

  return false;
}
