/**
 * The canonical catalog of Blender live operations, loaded from the JSON
 * manifest that protocol, gateway, and the Blender kernel all share. Each
 * entry declares its `surface` (typed apply op, longtail escape hatch, or
 * internal-only) and its transaction `effect`, which is what decides whether
 * a batch containing the op must pin the scene-epoch concurrency guard.
 * Keeping this in data (not code) lets the Python kernel consume the same
 * source of truth, and `assertBlenderOperationManifestCoverage` makes the
 * Zod union fail at module load if the two ever diverge.
 */
import { z } from "zod";
import manifestJson from "./blenderOperationManifest.json";

const operationSurfaceSchema = z.enum(["typed", "longtail", "internal"]);
const operationEffectSchema = z.enum(["read", "selection", "frame", "transform", "content", "history", "project"]);
const operationManifestSchema = z
  .strictObject({
    contract: z.literal("worldengine-blender-live-v1"),
    operations: z.array(
      z.strictObject({
        op: z.string().trim().min(1),
        surface: operationSurfaceSchema,
        effect: operationEffectSchema,
      }),
    ),
  })
  .superRefine((manifest, context) => {
    const names = new Set<string>();
    manifest.operations.forEach((operation, index) => {
      if (names.has(operation.op)) {
        context.addIssue({ code: "custom", path: ["operations", index, "op"], message: "Duplicate operation" });
      }
      names.add(operation.op);
    });
  });

/** Canonical Blender operation catalog shared by protocol, gateway, and Blender. */
export const blenderOperationManifest = operationManifestSchema.parse(manifestJson);

export type BlenderOperationSurface = z.infer<typeof operationSurfaceSchema>;
export type BlenderManifestOperationEffect = z.infer<typeof operationEffectSchema>;
export type BlenderOperationManifestEntry = (typeof blenderOperationManifest.operations)[number];

const operationByName = new Map(blenderOperationManifest.operations.map((operation) => [operation.op, operation]));
const operationNames = (predicate: (operation: BlenderOperationManifestEntry) => boolean) =>
  blenderOperationManifest.operations.filter(predicate).map((operation) => operation.op);

export const BLENDER_OPERATION_NAMES = operationNames(() => true);
export const BLENDER_AGENT_OPERATION_NAMES = operationNames((operation) => operation.surface !== "internal");
export const BLENDER_TYPED_OPERATION_NAMES = operationNames((operation) => operation.surface === "typed");
export const BLENDER_LONGTAIL_OPERATION_NAMES = operationNames((operation) => operation.surface === "longtail");
export const BLENDER_READ_OPERATION_NAMES = operationNames((operation) => operation.effect === "read");
export const BLENDER_SELECTION_OPERATION_NAMES = operationNames((operation) => operation.effect === "selection");
export const BLENDER_FRAME_OPERATION_NAMES = operationNames((operation) => operation.effect === "frame");
export const BLENDER_TRANSFORM_OPERATION_NAMES = operationNames((operation) => operation.effect === "transform");
export const BLENDER_HISTORY_OPERATION_NAMES = operationNames((operation) => operation.effect === "history");
export const BLENDER_PROJECT_OPERATION_NAMES = operationNames((operation) => operation.effect === "project");

/** Returns the declared transaction effect for a known operation. */
export function blenderOperationEffect(operation: string): BlenderManifestOperationEffect | undefined {
  return operationByName.get(operation)?.effect;
}

/** Unknown operations fail closed and require scene concurrency guards. */
export function blenderOperationRequiresSceneGuard(operation: string): boolean {
  const effect = blenderOperationEffect(operation);
  return effect !== "read" && effect !== "project";
}

/** Ensures the executable Zod union and the canonical catalog stay in exact lockstep. */
export function assertBlenderOperationManifestCoverage(schemaOperationNames: readonly string[]): void {
  if (
    schemaOperationNames.length !== BLENDER_OPERATION_NAMES.length ||
    schemaOperationNames.some((operation, index) => operation !== BLENDER_OPERATION_NAMES[index])
  ) {
    throw new Error("Blender operation schemas do not match blenderOperationManifest.json.");
  }
}
