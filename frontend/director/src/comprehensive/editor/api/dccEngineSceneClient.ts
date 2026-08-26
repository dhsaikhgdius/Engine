import { z } from "zod";
import {
  directorEngineSceneImportPlanSchema,
  directorEngineSceneManifestSchema,
  directorEngineSceneProviderSchema,
  type DirectorEngineSceneImportPlanV1,
  type DirectorEngineSceneImportSelection,
  type DirectorEngineSceneManifestV1,
  type DirectorEngineSceneProvider,
} from "../../../dcc/directorEngineSceneImportContract";
import { directorControlPlaneFetch } from "./directorControlPlaneClient";

/** One ingested engine scene package with its initial import plan. */
export interface DirectorEngineSceneUpload {
  jobId: string;
  provider: DirectorEngineSceneProvider;
  packagePath: string;
  manifest: DirectorEngineSceneManifestV1;
  plan: DirectorEngineSceneImportPlanV1;
}

const uploadResponseSchema = z.strictObject({
  success: z.literal(true),
  result: z.looseObject({
    jobId: z.string().trim().min(1),
    provider: directorEngineSceneProviderSchema,
    packagePath: z.string().trim().min(1),
    manifest: directorEngineSceneManifestSchema,
    plan: directorEngineSceneImportPlanSchema,
  }),
});

/** Preview responses carry the plan even on 409 so conflicts stay reviewable. */
const previewResponseSchema = z.looseObject({
  success: z.boolean(),
  result: z.strictObject({ plan: directorEngineSceneImportPlanSchema }),
});

const applyResponseSchema = z.strictObject({
  success: z.literal(true),
  result: z.looseObject({
    plan: directorEngineSceneImportPlanSchema,
    copiedAssets: z.array(z.looseObject({ assetId: z.string(), url: z.string() })),
  }),
});

const gatewayErrorSchema = z.looseObject({
  code: z.string().trim().min(1).optional(),
  error: z.string().trim().min(1).optional(),
  recovery: z.string().trim().min(1).optional(),
});

/** Error thrown when the gateway rejects an engine scene import call. */
export class DirectorEngineSceneClientError extends Error {
  /** HTTP status code from the gateway response. */
  readonly status: number;
  /** Machine-readable error code from the gateway. */
  readonly code?: string;
  /** Human-readable recovery hint from the gateway. */
  readonly recovery?: string;

  constructor(message: string, status: number, code?: string, recovery?: string) {
    super(message);
    this.name = "DirectorEngineSceneClientError";
    this.status = status;
    this.code = code;
    this.recovery = recovery;
  }
}

async function responseJson(response: Response): Promise<unknown> {
  return response.json().catch(() => ({}));
}

function throwGatewayError(response: Response, body: unknown, fallback: string): never {
  const parsed = gatewayErrorSchema.safeParse(body);
  if (parsed.success && (parsed.data.error || parsed.data.code)) {
    throw new DirectorEngineSceneClientError(
      parsed.data.error ?? fallback,
      response.status,
      parsed.data.code,
      parsed.data.recovery,
    );
  }
  throw new DirectorEngineSceneClientError(
    `${fallback}: gateway response did not match the Director engine scene contract`,
    response.ok ? 502 : response.status,
    "invalid_response",
  );
}

/**
 * Uploads a `director-engine-scene-v1` `.zip` package (exported inside
 * Unreal, Unity, or Godot) for hash-verified extraction; returns the
 * validated manifest and an initial import plan.
 *
 * @param provider - The engine that produced the package.
 * @param file - The `.zip` package file.
 * @returns The ingested package with manifest and plan.
 */
export async function uploadDirectorEngineScenePackage(
  provider: DirectorEngineSceneProvider,
  file: File,
): Promise<DirectorEngineSceneUpload> {
  const engine = directorEngineSceneProviderSchema.parse(provider);
  const query = new URLSearchParams({ provider: engine, filename: file.name || "director-engine-scene.zip" });
  const response = await directorControlPlaneFetch(`/api/dcc/engine-scene/uploads?${query.toString()}`, {
    method: "POST",
    headers: { "Content-Type": "application/zip" },
    body: file,
  });
  const body = await responseJson(response);
  const parsed = uploadResponseSchema.safeParse(body);
  if (parsed.success && response.ok) return parsed.data.result;
  return throwGatewayError(response, body, "Engine scene package upload failed");
}

/**
 * Rebuilds the engine scene import plan against the live project with an
 * explicit selection (scene bundle, cameras, lights). A conflicted plan comes
 * back readable instead of throwing, so the review UI can show the conflicts.
 *
 * @param provider - The engine that produced the package.
 * @param packageDir - The `packagePath` returned by the upload.
 * @param selection - Which scene elements to import.
 * @returns The rebuilt (possibly conflicted) import plan.
 */
export async function previewDirectorEngineSceneImport(
  provider: DirectorEngineSceneProvider,
  packageDir: string,
  selection: DirectorEngineSceneImportSelection,
): Promise<DirectorEngineSceneImportPlanV1> {
  const engine = directorEngineSceneProviderSchema.parse(provider);
  const response = await directorControlPlaneFetch("/api/tools/director_dcc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input: { op: "preview_engine_scene_import", provider: engine, package_dir: packageDir, selection },
    }),
  });
  const body = await responseJson(response);
  const parsed = previewResponseSchema.safeParse(body);
  if (parsed.success && (response.ok || response.status === 409)) return parsed.data.result.plan;
  return throwGatewayError(response, body, "Engine scene import preview failed");
}

/**
 * Applies a previewed engine scene import plan as one revision-guarded,
 * idempotent authoring mutation.
 *
 * @param plan - The plan returned by the upload or preview.
 * @returns The applied plan and the content-addressed copied assets.
 */
export async function applyDirectorEngineSceneImport(
  plan: DirectorEngineSceneImportPlanV1,
): Promise<{ plan: DirectorEngineSceneImportPlanV1; copiedAssets: Array<{ assetId: string; url: string }> }> {
  const response = await directorControlPlaneFetch("/api/tools/director_dcc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input: {
        op: "apply_engine_scene_import",
        plan_id: plan.planId,
        expected_revision: plan.targetRevision,
        idempotency_key: `engine-scene-${crypto.randomUUID()}`,
      },
    }),
  });
  const body = await responseJson(response);
  const parsed = applyResponseSchema.safeParse(body);
  if (parsed.success && response.ok) return parsed.data.result;
  return throwGatewayError(response, body, "Engine scene import apply failed");
}
