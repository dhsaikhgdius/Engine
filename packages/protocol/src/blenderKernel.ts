/**
 * Blender long-tail policy on top of the live kernel.
 *
 * Typed operations remain the preferred Agent surface. `invoke_operator`,
 * `set_rna_property`, and `execute_code` are long-tail escapes. Policy is a
 * small denylist (quit Blender, console/help/preferences/screen/workspace),
 * not a modeling-only allowlist. Keep the Python copy in
 * integrations/blender/live/addons/worldengine_studio/kernel_policy.py in sync.
 */

import { BLENDER_LONGTAIL_OPERATION_NAMES, BLENDER_TYPED_OPERATION_NAMES } from "./blenderOperationManifest";

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

/**
 * Specific operator IDs denied regardless of category membership.
 * Beyond quitting Blender, replacing the loaded mainfile (open/revert/recover/
 * factory reset) destroys the live scene epoch and every pending native job,
 * so those loads are denied on the same "session-destroying" grounds. Saving
 * (`wm.save_as_mainfile`) stays allowed: it never invalidates the session.
 */
export const BLENDER_INVOKE_OPERATOR_ID_DENYLIST = [
  "wm.quit_blender",
  "wm.window_close",
  "wm.open_mainfile",
  "wm.revert_mainfile",
  "wm.read_homefile",
  "wm.read_factory_settings",
  "wm.recover_last_session",
  "wm.recover_auto_save",
] as const;

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

/**
 * Typed modeling surfaces (modifier and geometry-node property records) never
 * take file-system paths, so path-like property names are denied by name
 * before dispatch. `set_rna_property` keeps the narrower {@link RNA_PATH_DENY}
 * so explicit render output filepaths stay writable, and `invoke_operator`
 * properties stay open for import/export operators. Mirrors
 * `_TYPED_PROPERTY_DENY` in the Blender kernel policy Python copy.
 */
const TYPED_PROPERTY_DENY = /^(library|script|expression|filepath|filename|directory)$/i;

/** Operations whose free-form property records are guarded by the typed-property denylist. */
const TYPED_PROPERTY_RECORD_FIELDS: Readonly<Record<string, string>> = {
  add_modifier: "properties",
  set_modifier: "properties",
  create_geometry_node: "nodeProperties",
};

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
 * Checks whether a typed modifier/geometry-node property name is allowed.
 *
 * Path-like names (`filepath`, `filename`, `directory`) and code-carrying
 * names (`library`, `script`, `expression`) are denied on typed modeling
 * surfaces; the Blender-side kernel enforces the same rule.
 *
 * @param name - The property name from a typed operation's property record.
 * @returns `true` when the property may be forwarded to Blender.
 */
export function isAllowedBlenderTypedPropertyName(name: string): boolean {
  return !TYPED_PROPERTY_DENY.test(name);
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
export function assertBlenderKernelPolicy(operations: readonly ({ op: string } & Record<string, unknown>)[]): void {
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
    const recordField = TYPED_PROPERTY_RECORD_FIELDS[operation.op];
    if (recordField) {
      const record = operation[recordField];
      const keys = record && typeof record === "object" && !Array.isArray(record) ? Object.keys(record) : [];
      const denied = keys.find((key) => !isAllowedBlenderTypedPropertyName(key));
      if (denied !== undefined) {
        throw new BlenderKernelPolicyError(
          `Typed ${operation.op} property is outside the Director modeling kernel: ${denied}. ` +
            "Path-like and code-carrying property names are rejected on typed modeling surfaces.",
        );
      }
    }
  }
}
