/**
 * Blender long-tail policy on top of the live kernel.
 *
 * Typed operations remain the preferred Agent surface. `invoke_operator`,
 * `set_rna_property`, and `execute_code` are long-tail escapes. Policy is a
 * small denylist (quit Blender, console/help/preferences/screen/workspace),
 * not a modeling-only allowlist. Keep the Python copy in
 * integrations/blender/live/addons/worldengine_studio/kernel_policy.py in sync.
 */

import {
  BLENDER_LONGTAIL_OPERATION_NAMES,
  BLENDER_TYPED_OPERATION_NAMES,
} from "./blenderOperationManifest";

/** Error code returned when a Blender operator is denied by the kernel policy. */
export const BLENDER_KERNEL_POLICY_CODE = "blender_operator_denied" as const;

/** All typed operations the kernel surface exposes; every operation has a typed schema in the live protocol. */
export const BLENDER_KERNEL_TYPED_OPERATION_NAMES = BLENDER_TYPED_OPERATION_NAMES;

/** Long-tail escape hatches: raw Blender operator invocation, RNA writes, and Python exec. */
export const BLENDER_KERNEL_LONGTAIL_OPERATION_NAMES = BLENDER_LONGTAIL_OPERATION_NAMES;

/** Blender operator categories denied even when the rest of bpy.ops is open. */
export const BLENDER_INVOKE_OPERATOR_CATEGORY_DENYLIST = [
  "console",
  "help",
  "preferences",
  "screen",
  "workspace",
] as const;

/** Specific operator IDs denied regardless of category membership. */
export const BLENDER_INVOKE_OPERATOR_ID_DENYLIST = ["wm.quit_blender", "wm.window_close"] as const;

/** RNA target kinds allowed for `set_rna_property` writes. */
export const BLENDER_RNA_TARGET_KIND_ALLOWLIST = [
  "object",
  "object_data",
  "modifier",
  "constraint",
  "material",
  "collection",
  "scene",
  "world",
] as const;

const RNA_PATH_DENY = /^(library|script|expression)$/i;

/** Error thrown when a Blender operation violates the kernel policy. */
export class BlenderKernelPolicyError extends Error {
  readonly code = BLENDER_KERNEL_POLICY_CODE;

  constructor(message: string) {
    super(message);
    this.name = "BlenderKernelPolicyError";
  }
}

/**
 * Extracts the Blender operator category from a dotted operator identifier
 * (e.g. `"mesh.primitive_cube_add"` → `"mesh"`).
 *
 * @param identifier - The full operator identifier string.
 * @returns The lowercase category prefix, or null if the identifier is not a valid dotted name.
 */
export function blenderOperatorCategory(identifier: string): string | null {
  const match = identifier.trim().match(/^([a-z][a-z0-9_]*)\.[a-z][a-z0-9_]*$/i);
  return match?.[1]?.toLowerCase() ?? null;
}

/**
 * Checks whether a Blender operator is allowed by the kernel policy.
 *
 * Any valid dotted bpy.ops identifier is permitted unless its category or
 * specific id is denylisted.
 *
 * @param identifier - The full operator identifier string.
 * @returns `true` when the operator is permitted.
 */
export function isAllowedBlenderOperator(identifier: string): boolean {
  const category = blenderOperatorCategory(identifier);
  if (!category) return false;
  if ((BLENDER_INVOKE_OPERATOR_CATEGORY_DENYLIST as readonly string[]).includes(category)) {
    return false;
  }
  if ((BLENDER_INVOKE_OPERATOR_ID_DENYLIST as readonly string[]).includes(identifier.trim().toLowerCase())) {
    return false;
  }
  return true;
}

/**
 * Checks whether an RNA property write is allowed by the kernel policy.
 *
 * The target kind must be in the allowlist and no path segment may match
 * the deny pattern (libraries, scripts, expressions).
 *
 * @param operation - The RNA write operation with target kind and property path.
 * @returns `true` when the write is permitted.
 */
export function isAllowedBlenderRnaWrite(operation: {
  target?: { kind?: string };
  path?: Array<string | number>;
}): boolean {
  const kind = operation.target?.kind;
  if (!kind || !(BLENDER_RNA_TARGET_KIND_ALLOWLIST as readonly string[]).includes(kind)) {
    return false;
  }
  return !(operation.path ?? []).some((segment) => typeof segment === "string" && RNA_PATH_DENY.test(segment));
}

/**
 * Asserts that every operation in a batch conforms to the kernel policy.
 *
 * Validates `invoke_operator` and `describe_operator` against the operator
 * denylist, and `set_rna_property` against the RNA target and path rules.
 * `execute_code` is unrestricted Python (same class of capability as blender-mcp).
 *
 * @param operations - The operations to validate.
 * @throws {@link BlenderKernelPolicyError} When any operation violates the policy.
 */
export function assertBlenderKernelPolicy(
  operations: readonly ({ op: string } & Record<string, unknown>)[],
): void {
  for (const operation of operations) {
    if (operation.op === "invoke_operator" || operation.op === "describe_operator") {
      const operator = "operator" in operation && typeof operation.operator === "string" ? operation.operator : null;
      if (!operator || !isAllowedBlenderOperator(operator)) {
        throw new BlenderKernelPolicyError(
          `Blender operator is outside the Director modeling kernel: ${operator ?? "(missing)"}`,
        );
      }
    }
    if (
      operation.op === "set_rna_property" &&
      !isAllowedBlenderRnaWrite(operation as { target?: { kind?: string }; path?: Array<string | number> })
    ) {
      throw new BlenderKernelPolicyError(
        "RNA writes are limited to object, mesh, modifier, constraint, material, collection, scene, and world properties.",
      );
    }
  }
}
