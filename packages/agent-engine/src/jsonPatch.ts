/**
 * Minimal, hardened JSON Patch (RFC 6902 subset) applier for workbench diffs.
 *
 * `director_workbench` author responses describe every mutation as a list of
 * add/replace/remove patches ({@link DirectorWorkbenchPatch}); this module is
 * the only code that materializes those patches into a project document, on
 * both the gateway and the browser. It deliberately supports only the three
 * ops the contract emits, never mutates the source document (deep clone
 * first), and throws — rather than silently skipping — on invalid pointers,
 * out-of-bounds indices, or prototype-pollution segments so a bad patch can
 * never half-apply.
 *
 * @module jsonPatch
 */

import type { DirectorWorkbenchPatch } from "./directorWorkbenchContract";

// Prototype-pollution guard: block keys that could mutate Object.prototype.
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function decodePointer(path: string) {
  // RFC 6901 JSON Pointer decoding: unescape ~1 → / and ~0 → ~,
  // then reject reserved and empty segments.
  return path
    .slice(1)
    .split("/")
    .map((segment) => {
      const decoded = segment.replace(/~1/g, "/").replace(/~0/g, "~");
      if (!decoded || FORBIDDEN_KEYS.has(decoded)) throw new Error(`Unsafe or empty JSON pointer segment in ${path}`);
      return decoded;
    });
}

function arrayIndex(segment: string, length: number, allowAppend: boolean) {
  // "-" means append (only for add); otherwise validate integer bounds.
  if (allowAppend && segment === "-") return length;
  if (!/^(0|[1-9]\d*)$/.test(segment)) throw new Error(`Invalid array index "${segment}"`);
  const index = Number(segment);
  if (index < 0 || index > length || (!allowAppend && index === length))
    throw new Error(`Array index ${index} is out of bounds`);
  return index;
}

function getParent(document: unknown, path: string) {
  const segments = decodePointer(path);
  const key = segments.pop();
  if (!key) throw new Error("Root replacement is not supported");
  let parent: unknown = document;
  for (const segment of segments) {
    if (Array.isArray(parent)) {
      parent = parent[arrayIndex(segment, parent.length, false)];
    } else if (parent && typeof parent === "object" && Object.prototype.hasOwnProperty.call(parent, segment)) {
      parent = (parent as Record<string, unknown>)[segment];
    } else {
      throw new Error(`JSON pointer parent does not exist: ${path}`);
    }
  }
  if (!parent || typeof parent !== "object") throw new Error(`JSON pointer parent is not a container: ${path}`);
  return { key, parent };
}

/**
 * Applies a sequence of RFC 6902-style JSON patches to a source document.
 *
 * Each patch is applied in order to a deep clone of the source. Array indices
 * are validated for bounds, prototype-pollution keys are rejected, and
 * add/replace/remove semantics follow the JSON Patch spec.
 *
 * @param source - The original document to patch.
 * @param patches - Ordered list of patches to apply.
 * @returns A new document with all patches applied.
 * @throws When a JSON pointer is invalid, out of bounds, or targets a forbidden key.
 */
export function applyDirectorJsonPatches<T>(source: T, patches: DirectorWorkbenchPatch[]): T {
  const document = structuredClone(source) as unknown;
  for (const patch of patches) {
    const { key, parent } = getParent(document, patch.path);
    if (Array.isArray(parent)) {
      const index = arrayIndex(key, parent.length, patch.op === "add");
      if (patch.op === "add") parent.splice(index, 0, structuredClone(patch.value));
      else if (patch.op === "replace") parent[index] = structuredClone(patch.value);
      else parent.splice(index, 1);
      continue;
    }
    const record = parent as Record<string, unknown>;
    const exists = Object.prototype.hasOwnProperty.call(record, key);
    if (patch.op !== "add" && !exists) throw new Error(`JSON pointer does not exist: ${patch.path}`);
    if (patch.op === "remove") delete record[key];
    else record[key] = structuredClone(patch.value);
  }
  return document as T;
}
