import type { DirectorWorkbenchOperation } from "@director/agent-engine";
import { directorWorkbenchOperationSchema } from "@director/agent-engine";
import { asRecord } from "../../packages/protocol/src/primitives";

type DirectorAuthorOperation = Extract<DirectorWorkbenchOperation, { op: "author" }>;
type DirectorDeliverOperation = Extract<DirectorWorkbenchOperation, { op: "deliver" }>;

/** Result of building an automatic delivery operation from an author response. */
export type AutomaticDeliveryBuildResult =
  { success: true; operation: DirectorDeliverOperation } | { success: false; error: string };

/**
 * Converts an explicit author delivery request into a delivery operation.
 *
 * Extracts the committed project revision from the author result and constructs
 * a `deliver` operation with the caller's delivery profile (quality, resolution,
 * render passes). Falls back to cinematic defaults when no profile is provided.
 *
 * @param author - The author operation that triggered the delivery.
 * @param authorResult - The raw result payload from the author execution.
 * @returns Either a valid delivery operation or an error describing the failure.
 */
export function buildAutomaticDeliveryOperation(
  author: DirectorAuthorOperation,
  authorResult: unknown,
): AutomaticDeliveryBuildResult {
  const projectRevision = asRecord(authorResult)?.project_revision;
  if (typeof projectRevision !== "string" || !projectRevision.trim()) {
    return {
      success: false,
      error: "Workbench author response did not include the committed project_revision required for delivery.",
    };
  }

  const deliveryProfile = author.delivery;

  const parsed = directorWorkbenchOperationSchema.safeParse({
    op: "deliver",
    expected_revision: projectRevision,
    quality_profile: deliveryProfile?.quality_profile ?? "cinematic",
    ...(author.camera_id ? { camera_id: author.camera_id } : {}),
    ...(author.subject_id ? { subject_id: author.subject_id } : {}),
    width: deliveryProfile?.width ?? 1280,
    height: deliveryProfile?.height ?? 720,
    render_passes: deliveryProfile?.render_passes ?? ["clean", "depth", "normal", "object-id", "mask"],
  });
  if (!parsed.success || parsed.data.op !== "deliver") {
    return {
      success: false,
      error: `Workbench author returned an invalid project_revision: ${parsed.error?.issues[0]?.message ?? "invalid value"}`,
    };
  }
  return { success: true, operation: parsed.data };
}
