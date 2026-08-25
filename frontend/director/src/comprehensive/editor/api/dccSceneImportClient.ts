import { z } from "zod";
import { DIRECTOR_PROJECT_REVISION_PATTERN } from "../schema/directorProjectRevision";
import {
  directorBlendSceneImportPlanSchema,
  directorBlendSceneImportSelectionSchema,
  directorBlendSceneManifestSchema,
  type DirectorBlendSceneImportPlanV1,
  type DirectorBlendSceneImportSelection,
} from "../../../dcc/directorBlendSceneImportContract";
import { directorControlPlaneFetch } from "./directorControlPlaneClient";

const copiedAssetSchema = z.strictObject({
  assetId: z.string().trim().min(1),
  url: z.string().trim().min(1),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
});

const uploadResponseSchema = z.strictObject({
  success: z.literal(true),
  result: z.strictObject({
    jobId: z.string().trim().min(1),
    packagePath: z.string().trim().min(1),
    manifest: directorBlendSceneManifestSchema,
    plan: directorBlendSceneImportPlanSchema,
  }),
});

const previewResponseSchema = z.looseObject({
  success: z.boolean(),
  result: z.strictObject({ plan: directorBlendSceneImportPlanSchema }),
});

const applyResponseSchema = z.strictObject({
  success: z.literal(true),
  result: z.strictObject({
    plan: directorBlendSceneImportPlanSchema,
    authoring: z.unknown().nullable(),
    copiedAssets: z.array(copiedAssetSchema),
  }),
});

const errorResponseSchema = z.looseObject({
  success: z.literal(false).optional(),
  error: z.string().trim().min(1).optional(),
  code: z.string().trim().min(1).optional(),
  recovery: z.string().trim().min(1).optional(),
});

const packageDirSchema = z.string().trim().min(1).max(2_048);
const planIdSchema = z.string().trim().min(1).max(1_024);
const revisionSchema = z.string().regex(DIRECTOR_PROJECT_REVISION_PATTERN);
const idempotencyKeySchema = z.string().trim().min(1).max(240);

/** Error thrown by Blender scene import API calls when the gateway rejects the request. */
export class DirectorBlendSceneImportClientError extends Error {
  /** HTTP status code from the gateway response. */
  readonly status: number;
  /** Machine-readable error code from the gateway. */
  readonly code?: string;
  /** Optional recovery hint from the gateway. */
  readonly recovery?: string;

  constructor(message: string, status: number, code?: string, recovery?: string) {
    super(message);
    this.name = "DirectorBlendSceneImportClientError";
    this.status = status;
    this.code = code;
    this.recovery = recovery;
  }
}

async function responseJson(response: Response): Promise<unknown> {
  return response.json().catch(() => ({}));
}

function throwGatewayError(response: Response, body: unknown, fallback: string): never {
  const parsed = errorResponseSchema.safeParse(body);
  if (parsed.success && (parsed.data.error || parsed.data.code)) {
    throw new DirectorBlendSceneImportClientError(
      parsed.data.error || fallback,
      response.status,
      parsed.data.code,
      parsed.data.recovery,
    );
  }
  throw new DirectorBlendSceneImportClientError(
    `${fallback}: gateway response did not match the Director Blender scene contract`,
    response.ok ? 502 : response.status,
    "invalid_response",
  );
}

function defaultImportIdempotencyKey(planId: string, targetRevision: string): string {
  const planKey = planId
    .normalize("NFKC")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(-120);
  const revisionKey = targetRevision.slice(-12);
  return `blender-scene-import-${planKey || "plan"}-${revisionKey}`;
}

/**
 * Uploads a .blend file to the gateway for scene import.
 *
 * The gateway returns a manifest, an import plan, and a package path for
 * subsequent preview and apply steps.
 *
 * @param file - The .blend file to upload.
 * @returns The upload result with job id, package path, manifest, and plan.
 */
export async function uploadDirectorBlendScene(file: File) {
  const response = await directorControlPlaneFetch(
    `/api/dcc/blender-scene/uploads?filename=${encodeURIComponent(file.name)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-blender" },
      body: file,
    },
  );
  const body = await responseJson(response);
  const parsed = uploadResponseSchema.safeParse(body);
  if (parsed.success && response.ok) return parsed.data.result;
  return throwGatewayError(response, body, "Blender scene upload failed");
}

/**
 * Previews a Blender scene import with the given selection.
 *
 * Performs a dry run that surfaces conflicts. A conflict-bearing plan
 * intentionally arrives with HTTP 409 and success:false — it is still the
 * actionable dry-run result the UI needs.
 *
 * @param packageDir - The gateway-side package directory path.
 * @param selection - Which objects, collections, and materials to import.
 * @returns The import plan, including any conflicts.
 */
export async function previewDirectorBlendSceneImport(
  packageDir: string,
  selection: DirectorBlendSceneImportSelection,
): Promise<DirectorBlendSceneImportPlanV1> {
  const normalizedPackageDir = packageDirSchema.parse(packageDir);
  const normalizedSelection = directorBlendSceneImportSelectionSchema.parse(selection);
  const response = await directorControlPlaneFetch("/api/tools/director_dcc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input: {
        op: "preview_blend_scene_import",
        package_dir: normalizedPackageDir,
        selection: normalizedSelection,
      },
    }),
  });
  const body = await responseJson(response);
  const parsed = previewResponseSchema.safeParse(body);
  // A conflict-bearing plan intentionally arrives with HTTP 409 and
  // success:false. It is still the actionable dry-run result the UI needs.
  if (parsed.success && ((parsed.data.success && response.ok) || (!parsed.data.success && response.status === 409))) {
    return parsed.data.result.plan;
  }
  return throwGatewayError(response, body, "Blender scene import preview failed");
}

/**
 * Applies a Blender scene import plan to the current project.
 *
 * Commits the import, copying assets and applying authoring operations.
 * An idempotency key prevents duplicate application.
 *
 * @param planId - The import plan id.
 * @param targetRevision - The expected project revision for optimistic concurrency.
 * @param idempotencyKey - Optional unique key to prevent duplicate application.
 * @returns The apply result with copied assets and authoring data.
 */
export async function applyDirectorBlendSceneImport(planId: string, targetRevision: string, idempotencyKey?: string) {
  const normalizedPlanId = planIdSchema.parse(planId);
  const normalizedRevision = revisionSchema.parse(targetRevision);
  const normalizedIdempotencyKey = idempotencyKeySchema.parse(
    idempotencyKey ?? defaultImportIdempotencyKey(normalizedPlanId, normalizedRevision),
  );
  const response = await directorControlPlaneFetch("/api/tools/director_dcc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input: {
        op: "apply_blend_scene_import",
        plan_id: normalizedPlanId,
        expected_revision: normalizedRevision,
        idempotency_key: normalizedIdempotencyKey,
      },
    }),
  });
  const body = await responseJson(response);
  const parsed = applyResponseSchema.safeParse(body);
  if (parsed.success && response.ok) return parsed.data.result;
  return throwGatewayError(response, body, "Blender scene import apply failed");
}
