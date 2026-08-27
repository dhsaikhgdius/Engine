/**
 * HTTP client for the gateway's production domain: multi-scene production
 * records, scene project snapshots, and editorial shot operations. All calls
 * go through the shared agent-gateway fetch so the UI and agents hit the same
 * endpoints with the same error semantics.
 */
import { directorAgentFetch, getDirectorAgentBasePath } from "../assistant/agentGatewayClient";
import type { DirectorProject } from "../schema/directorProject";
import type {
  DirectorProductionRecord,
  DirectorProductionSceneProjectRecord,
  DirectorProductionSceneSeed,
  EditorialShot,
  ProductionOperation,
  ProductionSceneReference,
} from "../../../../../../packages/protocol/src/directorProductionProtocol";

/** Production protocol types re-exported for convenience. */
export type {
  DirectorProductionRecord,
  DirectorProductionSceneProjectRecord,
  DirectorProductionSceneSeed,
  EditorialShot,
  ProductionOperation,
  ProductionSceneReference,
} from "../../../../../../packages/protocol/src/directorProductionProtocol";

/** A lightweight, read-only snapshot of a scene used to render its visual overview card. */
export type DirectorProductionSceneSnapshot = {
  sceneId: string;
  revision: number;
  scene: {
    scene?: { background?: string; backgroundColor?: string };
    entities?: Array<{ id?: string; type?: string; kind?: string; color?: number | string; visible?: boolean }>;
  };
};

/**
 * Error thrown by production API client methods when an HTTP request fails.
 *
 * Carries the HTTP status code and optional response body for diagnostic use.
 */
export class DirectorProductionClientError extends Error {
  constructor(
    message: string,
    /** The HTTP status code returned by the server. */
    readonly status: number,
    /** The raw response body returned by the server, if any. */
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "DirectorProductionClientError";
  }
}

function directorBasePath() {
  return getDirectorAgentBasePath().replace(/\/agent$/, "");
}

function productionPath(productionId: string, suffix = "") {
  return `${directorBasePath()}/productions/${encodeURIComponent(productionId)}${suffix}`;
}

function scenePath(sceneId: string) {
  return `${directorBasePath()}/scenes/${encodeURIComponent(sceneId)}`;
}

function sceneProjectPath(sceneId: string) {
  return `${scenePath(sceneId)}/project`;
}

async function requestJson<T>(path: string, init: RequestInit = {}) {
  // Production reads and writes both cross the authenticated local boundary;
  // the token is never persisted in project or Production data.
  const response = await directorAgentFetch(path, {
    cache: "no-store",
    ...init,
    headers: {
      Accept: "application/json",
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail =
      body && typeof body === "object" && "message" in body
        ? String((body as { message?: unknown }).message || "")
        : "";
    throw new DirectorProductionClientError(
      detail || `制作项目请求失败（HTTP ${response.status}）`,
      response.status,
      body,
    );
  }
  return body as T;
}

/**
 * Fetches the full production record for a given production.
 *
 * @param productionId - The production identifier (defaults to "main").
 * @param signal - Optional abort signal to cancel the request.
 * @returns A promise resolving to the production record.
 */
export function getDirectorProduction(productionId = "main", signal?: AbortSignal) {
  return requestJson<DirectorProductionRecord>(productionPath(productionId), { signal });
}

/** Read-only, compact source used to render a scene's visual overview card. */
export function getDirectorProductionSceneSnapshot(sceneId: string) {
  return requestJson<DirectorProductionSceneSnapshot>(scenePath(sceneId));
}

/**
 * Fetches the project file associated with a production scene.
 *
 * @param sceneId - The unique identifier of the scene.
 * @param signal - Optional abort signal to cancel the request.
 * @returns A promise resolving to the scene's project record.
 */
export function getDirectorProductionSceneProject(sceneId: string, signal?: AbortSignal) {
  return requestJson<DirectorProductionSceneProjectRecord>(sceneProjectPath(sceneId), { signal });
}

/**
 * Saves a project file for a production scene with optimistic concurrency control.
 *
 * @param input - The save parameters including scene ID, expected revision, project data, and optional actor and signal.
 * @returns A promise resolving to the updated scene project record.
 */
export function saveDirectorProductionSceneProject(input: {
  sceneId: string;
  expectedRevision: number;
  project: DirectorProject;
  actor?: string;
  signal?: AbortSignal;
}) {
  return requestJson<DirectorProductionSceneProjectRecord>(sceneProjectPath(input.sceneId), {
    method: "PUT",
    signal: input.signal,
    body: JSON.stringify({
      expectedRevision: input.expectedRevision,
      project: input.project,
      actor: input.actor ?? "director-desk:scene-project",
    }),
  });
}

/**
 * Applies a batch of atomic operations to a production with optimistic concurrency control.
 *
 * @param productionId - The production identifier.
 * @param expectedRevision - The revision the caller expects to update from.
 * @param operations - The ordered list of production operations to apply.
 * @param actor - An optional actor label for audit trails (defaults to "director-desk:production").
 * @param idempotencyKey - An optional key to ensure the update is applied exactly once.
 * @param sceneSeeds - Optional scene seeds to create alongside the update.
 * @param signal - Optional abort signal to cancel the request.
 * @returns A promise resolving to the updated production record.
 */
export function updateDirectorProduction(
  productionId: string,
  expectedRevision: number,
  operations: ProductionOperation[],
  actor = "director-desk:production",
  idempotencyKey?: string,
  sceneSeeds?: DirectorProductionSceneSeed[],
  signal?: AbortSignal,
) {
  return requestJson<DirectorProductionRecord>(productionPath(productionId), {
    method: "PUT",
    signal,
    body: JSON.stringify({
      expectedRevision,
      operations,
      actor,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(sceneSeeds?.length ? { sceneSeeds } : {}),
    }),
  });
}

/**
 * Creates a new scene within a production.
 *
 * @param input - The creation parameters including production ID, expected revision, scene ID, title,
 *   and optional source scene, project data, activation flag, and idempotency key.
 * @returns A promise resolving to the updated production record.
 */
export function createDirectorProductionScene(input: {
  productionId: string;
  expectedRevision: number;
  sceneId: string;
  title: string;
  sourceSceneId?: string;
  project?: DirectorProject;
  activate?: boolean;
  idempotencyKey?: string;
  signal?: AbortSignal;
}) {
  return requestJson<DirectorProductionRecord>(productionPath(input.productionId, "/scenes"), {
    method: "POST",
    signal: input.signal,
    body: JSON.stringify({
      expectedRevision: input.expectedRevision,
      sceneId: input.sceneId,
      title: input.title,
      ...(input.sourceSceneId ? { sourceSceneId: input.sourceSceneId } : {}),
      ...(input.project ? { project: input.project } : {}),
      ...(input.activate !== undefined ? { activate: input.activate } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      actor: "director-desk:create-production-scene",
    }),
  });
}
