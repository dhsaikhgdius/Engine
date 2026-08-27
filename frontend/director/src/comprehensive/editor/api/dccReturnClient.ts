/**
 * Typed HTTP client for the DCC "return trip": after a scene edited in an
 * external tool comes back, previews the diff-based import plan (operation /
 * skip / conflict counts) and applies it to the project. Preview is always a
 * dry run on the server; apply is the only mutating call, and both responses
 * are Zod-validated against the shared return contract.
 */
import { z } from "zod";
import { directorDccImportPlanSchema, type DirectorDccImportPlanV1 } from "../../../dcc/directorDccReturnContract";
import type { DirectorDccConnectorProviderId } from "../../../dcc/directorDccEngineSpace";
import { directorControlPlaneFetch } from "./directorControlPlaneClient";

const summarySchema = z.strictObject({
  operation_count: z.number().int().nonnegative(),
  skipped_count: z.number().int().nonnegative(),
  conflict_count: z.number().int().nonnegative(),
  warning_count: z.number().int().nonnegative(),
});

const previewResponseSchema = z.looseObject({
  success: z.boolean(),
  code: z.string().optional(),
  result: z.strictObject({
    ready: z.boolean(),
    provider: z.string().optional(),
    dry_run: z.boolean(),
    include_new_objects: z.boolean().optional(),
    summary: summarySchema,
    plan: directorDccImportPlanSchema,
  }),
});

const applyResponseSchema = z.strictObject({
  success: z.literal(true),
  result: z.strictObject({
    provider: z.string().optional(),
    plan: directorDccImportPlanSchema,
    authoring: z.unknown().nullable(),
    copiedAssets: z.array(z.strictObject({ assetId: z.string(), url: z.string(), hash: z.string() })),
  }),
});

const errorResponseSchema = z.looseObject({
  error: z.string().optional(),
  code: z.string().optional(),
  recovery: z.string().optional(),
});

/** Error thrown by DCC return API calls when the gateway rejects the request. */
export class DirectorDccReturnClientError extends Error {
  /** HTTP status code from the gateway response. */
  readonly status: number;
  /** Machine-readable error code from the gateway. */
  readonly code?: string;
  /** Optional recovery hint from the gateway. */
  readonly recovery?: string;

  constructor(message: string, status: number, code?: string, recovery?: string) {
    super(message);
    this.name = "DirectorDccReturnClientError";
    this.status = status;
    this.code = code;
    this.recovery = recovery;
  }
}

async function json(response: Response): Promise<unknown> {
  return response.json().catch(() => ({}));
}

function throwGatewayError(response: Response, body: unknown): never {
  const parsed = errorResponseSchema.safeParse(body);
  throw new DirectorDccReturnClientError(
    parsed.success ? parsed.data.error || "DCC return request failed" : "DCC return response is invalid",
    response.status,
    parsed.success ? parsed.data.code : undefined,
    parsed.success ? parsed.data.recovery : undefined,
  );
}

/**
 * Previews a DCC return package import without applying it.
 *
 * Performs a dry run of the import to surface conflicts, operation counts,
 * and the import plan before committing changes. Blender packages go through
 * `import_return_package`; engine packages go through `receive_from_engine`
 * so the gateway resolves them against the correct connector job root.
 *
 * @param packageDir - The gateway-side package directory path.
 * @param provider - The connector that produced the package (defaults to Blender).
 * @param options - Opt in to planning `object_addition` changes (objects that
 *   gained a fresh director_id in the DCC after the export snapshot). Off by
 *   default so Director never auto-imports new DCC objects without review.
 * @returns The preview result with the import plan and summary.
 */
export async function previewDirectorDccReturnPackage(
  packageDir: string,
  provider: DirectorDccConnectorProviderId = "blender",
  options: { includeNewObjects?: boolean } = {},
) {
  const includeNewObjects = options.includeNewObjects ? { include_new_objects: true } : {};
  const input =
    provider === "blender"
      ? { op: "import_return_package", package_dir: packageDir, dry_run: true, ...includeNewObjects }
      : { op: "receive_from_engine", provider, package_dir: packageDir, dry_run: true, ...includeNewObjects };
  const response = await directorControlPlaneFetch("/api/tools/director_dcc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input }),
  });
  const body = await json(response);
  const parsed = previewResponseSchema.safeParse(body);
  if (parsed.success) return parsed.data.result;
  return throwGatewayError(response, body);
}

/**
 * Applies a DCC import plan to the current project.
 *
 * Commits the changes described by the import plan, including copying assets
 * and applying authoring operations. An idempotency key prevents duplicate
 * application.
 *
 * @param plan - The import plan to apply.
 * @param provider - The connector whose job root holds the package (defaults to Blender).
 * @param idempotencyKey - A unique key to prevent duplicate application.
 * @returns The apply result with copied assets and authoring data.
 */
export async function applyDirectorDccImportPlan(
  plan: DirectorDccImportPlanV1,
  provider: DirectorDccConnectorProviderId = "blender",
  idempotencyKey = `${provider}-return-${plan.packageId}-${plan.manifestHash.slice(0, 12)}`,
) {
  const response = await directorControlPlaneFetch("/api/tools/director_dcc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input: {
        op: "apply_import_plan",
        plan,
        ...(provider === "blender" ? {} : { provider }),
        expected_revision: plan.targetRevision,
        idempotency_key: idempotencyKey,
      },
    }),
  });
  const body = await json(response);
  const parsed = applyResponseSchema.safeParse(body);
  if (parsed.success) return parsed.data.result;
  return throwGatewayError(response, body);
}
