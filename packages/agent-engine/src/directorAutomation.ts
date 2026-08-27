/**
 * The Director automation library: reusable macros and durable memory facts.
 *
 * A macro is a named, parameterized bundle of author actions (validated
 * against the real authoring grammar at save time); a memory fact is a
 * pinned piece of agent knowledge scoped globally or to one scene. The
 * library is persisted in browser localStorage under a versioned key, with
 * a change event so concurrent tabs stay coherent. `director_workbench`
 * `op:"macro"` / `op:"memory"` and the Automation panel share these schemas,
 * limits, and (de)serialization helpers, so an agent-saved macro is exactly
 * what the UI shows and runs.
 *
 * @module directorAutomation
 */

import { z } from "zod";
import { stableLexicalJson } from "@director/protocol/stableJson";
import { directorAuthoringActionSchema, type DirectorAuthoringAction } from "./directorAuthoring";

/** localStorage key for the serialized automation library (versioned). */
export const DIRECTOR_AUTOMATION_STORAGE_KEY = "director.automation-library.v1";
/** Custom DOM event dispatched when the automation library is written, so concurrent tabs can refresh. */
export const DIRECTOR_AUTOMATION_CHANGE_EVENT = "director-automation-library-changed";
/** Maximum number of macros allowed in a single library. */
export const DIRECTOR_AUTOMATION_MAX_MACROS = 128;
/** Maximum number of memory facts allowed in a single library. */
export const DIRECTOR_AUTOMATION_MAX_MEMORIES = 256;

/**
 * A scalar value accepted as a macro parameter or default: a bounded string,
 * a finite number, or a boolean.
 */
export const directorMacroScalarSchema = z.union([z.string().max(4_000), z.number().finite(), z.boolean()]);

/**
 * A single typed macro parameter with a name, label, description, type, and
 * default value. The default must match the declared type.
 */
export const directorMacroParameterSchema = z
  .strictObject({
    name: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[A-Za-z][A-Za-z0-9_]*$/),
    label: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).default(""),
    type: z.enum(["string", "number", "boolean"]),
    default: directorMacroScalarSchema,
  })
  .superRefine((parameter, context) => {
    if (typeof parameter.default !== parameter.type) {
      context.addIssue({
        code: "custom",
        path: ["default"],
        message: `default must be a ${parameter.type}`,
      });
    }
  });

// Shared shape for both the draft (user-editable) and persisted macro schemas.
const directorMacroDraftShape = {
  id: z
    .string()
    .trim()
    .min(2)
    .max(120)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]+$/),
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(1_000).default(""),
  parameters: z.array(directorMacroParameterSchema).max(32).default([]),
  actions: z.array(z.unknown()).min(1).max(128),
} as const;

// Validates that macro parameter names are unique; used as a superRefine
// refinement on both the draft and persisted schemas.
function macroParametersAreUnique(macro: { parameters: DirectorMacroParameter[] }, context: z.RefinementCtx) {
  const names = new Set<string>();
  macro.parameters.forEach((parameter, index) => {
    if (names.has(parameter.name)) {
      context.addIssue({ code: "custom", path: ["parameters", index, "name"], message: "duplicate parameter" });
    }
    names.add(parameter.name);
  });
}

/**
 * Validates a user-editable macro draft before it is persisted.
 * Actions are validated as unknown at this stage; resolution happens at save time.
 */
export const directorMacroDraftSchema = z.strictObject(directorMacroDraftShape).superRefine((macro, context) => {
  macroParametersAreUnique(macro, context);
});

/**
 * Validates a fully persisted macro, including version, timestamps, and creator
 * provenance fields.
 */
export const directorMacroSchema = z
  .strictObject({
    ...directorMacroDraftShape,
    version: z.literal(1),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    createdBy: z.enum(["human", "agent", "builtin", "import"]),
  })
  .superRefine((macro, context) => macroParametersAreUnique(macro, context));

/**
 * Validates a memory fact: a scoped, tagged text record pinned by a human or
 * agent for later recall. Scene-scoped facts must carry a sceneId; global
 * facts must not.
 */
export const directorMemoryFactSchema = z
  .strictObject({
    id: z
      .string()
      .trim()
      .min(2)
      .max(120)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]+$/),
    text: z.string().trim().min(1).max(4_000),
    category: z.string().trim().min(1).max(80).default("general"),
    tags: z.array(z.string().trim().min(1).max(80)).max(16).default([]),
    scope: z.enum(["global", "scene"]),
    sceneId: z.string().trim().min(1).max(200).nullable(),
    createdAt: z.string().datetime(),
    createdBy: z.enum(["human", "agent", "import"]),
  })
  .superRefine((fact, context) => {
    if ((fact.scope === "scene") !== Boolean(fact.sceneId)) {
      context.addIssue({
        code: "custom",
        path: ["sceneId"],
        message: "scene-scoped memory requires sceneId; global memory must not set sceneId",
      });
    }
    if (new Set(fact.tags).size !== fact.tags.length) {
      context.addIssue({ code: "custom", path: ["tags"], message: "tags must be unique" });
    }
  });

/**
 * Validates the top-level automation library: a versioned collection of macros
 * and memories with hard caps on each.
 */
export const directorAutomationLibrarySchema = z.strictObject({
  version: z.literal(1),
  macros: z.array(directorMacroSchema).max(DIRECTOR_AUTOMATION_MAX_MACROS),
  memories: z.array(directorMemoryFactSchema).max(DIRECTOR_AUTOMATION_MAX_MEMORIES),
});

/** A single scalar value usable as a macro parameter (string, number, or boolean). */
export type DirectorMacroScalar = z.infer<typeof directorMacroScalarSchema>;
/** A typed macro parameter definition with a name, default, and metadata. */
export type DirectorMacroParameter = z.infer<typeof directorMacroParameterSchema>;
/** A user-editable macro draft before persistence. */
export type DirectorMacroDraft = z.infer<typeof directorMacroDraftSchema>;
/** A fully persisted macro with version, timestamps, and provenance. */
export type DirectorMacro = z.infer<typeof directorMacroSchema>;
/** A scoped, tagged memory fact pinned for later recall. */
export type DirectorMemoryFact = z.infer<typeof directorMemoryFactSchema>;
/** The top-level automation library containing macros and memory facts. */
export type DirectorAutomationLibrary = z.infer<typeof directorAutomationLibrarySchema>;

/** Minimal storage interface needed for persistence; satisfies both localStorage and in-memory fakes. */
type StorageLike = Pick<Storage, "getItem" | "setItem">;

// Fixed timestamp for all built-in macros so they sort deterministically
// and are clearly distinguishable from user-created entries.
const BUILTIN_CREATED_AT = "2026-08-07T00:00:00.000Z";
// Built-in macros shipped with every library. They are seeded on first read
// and never overwritten by the user unless explicitly edited.
const BUILTIN_MACROS: DirectorMacro[] = [
  directorMacroSchema.parse({
    version: 1,
    id: "reset-transform",
    name: "重置对象变换",
    description: "把指定对象的位置、旋转和缩放重置为场景原点、零旋转与单位缩放。",
    parameters: [
      {
        name: "object_id",
        label: "对象 ID",
        description: "使用 observe 返回的真实对象 ID。",
        type: "string",
        default: "object-id",
      },
    ],
    actions: [
      {
        action: "update_object",
        object_id: { $param: "object_id" },
        patch: { transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
      },
    ],
    createdAt: BUILTIN_CREATED_AT,
    updatedAt: BUILTIN_CREATED_AT,
    createdBy: "builtin",
  }),
  directorMacroSchema.parse({
    version: 1,
    id: "warm-three-point-lighting",
    name: "暖色三点布光",
    description: "添加主光、冷色补光和轮廓光；prefix 可避免与已有灯光 ID 冲突。",
    parameters: [
      {
        name: "prefix",
        label: "灯光 ID 前缀",
        description: "再次运行时请换一个唯一前缀。",
        type: "string",
        default: "macro-light",
      },
    ],
    actions: [
      {
        action: "add_light",
        light: {
          id: "${prefix}-key",
          name: "暖色主光",
          type: "directional",
          visible: true,
          locked: false,
          color: "#ffe1b8",
          intensity: 2.4,
          position: [4, 6, 4],
          target: [0, 1, 0],
          castShadow: true,
        },
      },
      {
        action: "add_light",
        light: {
          id: "${prefix}-fill",
          name: "冷色补光",
          type: "rect-area",
          visible: true,
          locked: false,
          color: "#b8d8ff",
          intensity: 1.2,
          position: [-4, 3, 2],
          target: [0, 1, 0],
          width: 3,
          height: 3,
        },
      },
      {
        action: "add_light",
        light: {
          id: "${prefix}-rim",
          name: "暖色轮廓光",
          type: "spot",
          visible: true,
          locked: false,
          color: "#fff0dc",
          intensity: 1.8,
          position: [0, 5, -4],
          target: [0, 1, 0],
          distance: 0,
          decay: 2,
          angle: 0.55,
          penumbra: 0.5,
          castShadow: true,
        },
      },
    ],
    createdAt: BUILTIN_CREATED_AT,
    updatedAt: BUILTIN_CREATED_AT,
    createdBy: "builtin",
  }),
];

// Resolve the storage backend: use an explicit override when provided,
// otherwise fall back to globalThis.localStorage, returning null when
// unavailable (SSR, sandboxed iframe, etc.).
function resolveStorage(storage?: StorageLike | null): StorageLike | null {
  if (storage !== undefined) return storage;
  try {
    return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

// Return a fresh library seeded with the built-in macros and an empty memory list.
// Uses structuredClone so callers can mutate the result without affecting the source.
function defaultLibrary(): DirectorAutomationLibrary {
  return { version: 1, macros: structuredClone(BUILTIN_MACROS), memories: [] };
}

// Dispatch a custom DOM event so other tabs or UI components can react to
// library changes without polling.
function notifyChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(DIRECTOR_AUTOMATION_CHANGE_EVENT));
}

// Validate, serialize, and persist the library to storage. Enforces the 1 MB
// size cap before writing, then dispatches a change notification.
function writeLibrary(library: DirectorAutomationLibrary, storage?: StorageLike | null) {
  const parsed = directorAutomationLibrarySchema.parse(library);
  const serialized = stableLexicalJson(parsed);
  if (serialized.length > 1_000_000) throw new Error("Automation library exceeds the 1 MB browser storage contract.");
  const target = resolveStorage(storage);
  if (!target) throw new Error("Persistent browser storage is unavailable.");
  target.setItem(DIRECTOR_AUTOMATION_STORAGE_KEY, serialized);
  notifyChanged();
  return parsed;
}

/**
 * Reads the automation library from persistent storage, falling back to a
 * default library seeded with built-in macros when storage is unavailable
 * or the stored data is corrupt.
 *
 * @param storage - Optional storage override (defaults to localStorage).
 * @returns The current automation library.
 */
export function readDirectorAutomationLibrary(storage?: StorageLike | null): DirectorAutomationLibrary {
  const target = resolveStorage(storage);
  if (!target) return defaultLibrary();
  try {
    const serialized = target.getItem(DIRECTOR_AUTOMATION_STORAGE_KEY);
    if (!serialized) return defaultLibrary();
    return directorAutomationLibrarySchema.parse(JSON.parse(serialized));
  } catch {
    return defaultLibrary();
  }
}

// Measure the serialized size of a value to enforce template size limits.
function templateSize(value: unknown) {
  try {
    return JSON.stringify(value).length;
  } catch {
    throw new Error("Macro actions must be acyclic JSON values.");
  }
}

// Check that a supplied scalar value's runtime type matches the parameter's
// declared type (string, number, or boolean).
function valueMatchesParameter(value: DirectorMacroScalar, parameter: DirectorMacroParameter) {
  return typeof value === parameter.type;
}

// Recursively resolve `${param}` placeholders and `{ "$param": "name" }` objects
// in a macro action template against the supplied parameter map. Depth is capped
// at 32 to guard against infinite recursion from malformed templates.
function resolveTemplateValue(
  value: unknown,
  parameters: ReadonlyMap<string, DirectorMacroScalar>,
  depth = 0,
): unknown {
  if (depth > 32) throw new Error("Macro action template exceeds the maximum depth of 32.");
  if (typeof value === "string") {
    const exact = value.match(/^\$\{([A-Za-z][A-Za-z0-9_]*)\}$/);
    if (exact) {
      if (!parameters.has(exact[1]!)) throw new Error(`Unknown macro parameter "${exact[1]}".`);
      return parameters.get(exact[1]!)!;
    }
    return value.replace(/\$\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
      if (!parameters.has(name)) throw new Error(`Unknown macro parameter "${name}".`);
      return String(parameters.get(name));
    });
  }
  if (Array.isArray(value)) return value.map((entry) => resolveTemplateValue(entry, parameters, depth + 1));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 1 && keys[0] === "$param") {
      const name = record.$param;
      if (typeof name !== "string" || !parameters.has(name)) {
        throw new Error(`Unknown macro parameter "${String(name)}".`);
      }
      return parameters.get(name)!;
    }
    return Object.fromEntries(keys.map((key) => [key, resolveTemplateValue(record[key], parameters, depth + 1)]));
  }
  return value;
}

/**
 * Resolves a macro's action template into concrete authoring actions by
 * substituting supplied parameter values and filling in defaults.
 *
 * Throws if the action template exceeds 160 KB, if an unknown parameter is
 * supplied, or if a parameter value does not match its declared type.
 *
 * @param macroInput - A macro or draft whose actions contain `${param}` or
 *                     `{ "$param": "name" }` placeholders.
 * @param supplied - Optional parameter overrides keyed by parameter name.
 * @returns The resolved array of authoring actions, validated against the
 *          authoring action schema.
 * @throws When template size, unknown parameters, or type mismatches are detected.
 */
export function resolveDirectorMacroActions(
  macroInput: DirectorMacro | DirectorMacroDraft,
  supplied: Record<string, DirectorMacroScalar> = {},
): DirectorAuthoringAction[] {
  const macro = directorMacroDraftSchema.parse({
    id: macroInput.id,
    name: macroInput.name,
    description: macroInput.description,
    parameters: macroInput.parameters,
    actions: macroInput.actions,
  });
  if (templateSize(macro.actions) > 160_000) throw new Error("Macro action template exceeds 160 KB.");
  const parameterByName = new Map(macro.parameters.map((parameter) => [parameter.name, parameter]));
  for (const suppliedName of Object.keys(supplied)) {
    if (!parameterByName.has(suppliedName)) throw new Error(`Unknown macro parameter "${suppliedName}".`);
  }
  const resolved = new Map<string, DirectorMacroScalar>();
  for (const parameter of macro.parameters) {
    const value = Object.prototype.hasOwnProperty.call(supplied, parameter.name)
      ? supplied[parameter.name]!
      : parameter.default;
    if (!valueMatchesParameter(value, parameter)) {
      throw new Error(`Macro parameter "${parameter.name}" must be a ${parameter.type}.`);
    }
    resolved.set(parameter.name, value);
  }
  return z.array(directorAuthoringActionSchema).min(1).max(128).parse(resolveTemplateValue(macro.actions, resolved));
}

/**
 * Saves a macro draft to the automation library, creating or overwriting an
 * entry. Idempotent when the draft is byte-identical to an existing macro.
 *
 * @param draftInput - The macro draft to persist.
 * @param options - Overwrite policy, creator provenance, and storage override.
 * @returns The persisted macro.
 * @throws If the macro already exists and `overwrite` is not set, or if the
 *         library is at capacity.
 */
export function saveDirectorMacro(
  draftInput: DirectorMacroDraft,
  options: { overwrite?: boolean; createdBy?: DirectorMacro["createdBy"]; storage?: StorageLike | null } = {},
) {
  const draft = directorMacroDraftSchema.parse(draftInput);
  resolveDirectorMacroActions(draft);
  const library = readDirectorAutomationLibrary(options.storage);
  const existing = library.macros.find((macro) => macro.id === draft.id);
  if (existing && !options.overwrite) {
    const existingDraft = directorMacroDraftSchema.parse({
      id: existing.id,
      name: existing.name,
      description: existing.description,
      parameters: existing.parameters,
      actions: existing.actions,
    });
    if (stableLexicalJson(existingDraft) === stableLexicalJson(draft)) return existing;
    throw new Error(`Macro "${draft.id}" already exists.`);
  }
  if (!existing && library.macros.length >= DIRECTOR_AUTOMATION_MAX_MACROS) {
    throw new Error(`Macro library is at its ${DIRECTOR_AUTOMATION_MAX_MACROS}-item capacity.`);
  }
  const now = new Date().toISOString();
  const macro = directorMacroSchema.parse({
    ...draft,
    version: 1,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    createdBy: existing?.createdBy ?? options.createdBy ?? "human",
  });
  writeLibrary(
    { ...library, macros: [...library.macros.filter((entry) => entry.id !== macro.id), macro] },
    options.storage,
  );
  return macro;
}

/**
 * Removes a macro from the automation library by its ID.
 *
 * @param id - The macro ID to remove.
 * @param storage - Optional storage override.
 * @returns The removed macro, or null if no macro with that ID exists.
 */
export function removeDirectorMacro(id: string, storage?: StorageLike | null) {
  const library = readDirectorAutomationLibrary(storage);
  const macro = library.macros.find((entry) => entry.id === id);
  if (!macro) return null;
  writeLibrary({ ...library, macros: library.macros.filter((entry) => entry.id !== id) }, storage);
  return macro;
}

/**
 * Pins a memory fact to the automation library, creating or overwriting an
 * entry. Idempotent when the fact is byte-identical (excluding createdAt) to
 * an existing one.
 *
 * @param input - The memory fact fields (createdAt defaults to now).
 * @param options - Overwrite policy and storage override.
 * @returns The persisted memory fact.
 * @throws If the fact already exists and `overwrite` is not set, or if the
 *         library is at capacity.
 */
export function pinDirectorMemory(
  input: Omit<DirectorMemoryFact, "createdAt"> & { createdAt?: string },
  options: { overwrite?: boolean; storage?: StorageLike | null } = {},
) {
  const fact = directorMemoryFactSchema.parse({ ...input, createdAt: input.createdAt ?? new Date().toISOString() });
  const library = readDirectorAutomationLibrary(options.storage);
  const existing = library.memories.find((entry) => entry.id === fact.id);
  if (existing && !options.overwrite) {
    const comparable = ({ createdAt: _createdAt, ...value }: DirectorMemoryFact) => value;
    if (stableLexicalJson(comparable(existing)) === stableLexicalJson(comparable(fact))) return existing;
    throw new Error(`Memory "${fact.id}" already exists.`);
  }
  if (!existing && library.memories.length >= DIRECTOR_AUTOMATION_MAX_MEMORIES) {
    throw new Error(`Memory library is at its ${DIRECTOR_AUTOMATION_MAX_MEMORIES}-item capacity.`);
  }
  writeLibrary(
    { ...library, memories: [...library.memories.filter((entry) => entry.id !== fact.id), fact] },
    options.storage,
  );
  return fact;
}

/**
 * Removes a memory fact from the automation library by its ID.
 *
 * @param id - The memory fact ID to remove.
 * @param storage - Optional storage override.
 * @returns The removed memory fact, or null if no fact with that ID exists.
 */
export function forgetDirectorMemory(id: string, storage?: StorageLike | null) {
  const library = readDirectorAutomationLibrary(storage);
  const fact = library.memories.find((entry) => entry.id === id);
  if (!fact) return null;
  writeLibrary({ ...library, memories: library.memories.filter((entry) => entry.id !== id) }, storage);
  return fact;
}

/**
 * Recalls memory facts from the automation library, filtered by an optional
 * query string, scope, scene ID, and category. Results are sorted newest-first
 * and capped at the given limit.
 *
 * @param input - Filter criteria: query (substring search), scope, sceneId,
 *                category, and limit (1–100, default 50).
 * @param storage - Optional storage override.
 * @returns Matching memory facts sorted by createdAt descending, then by id.
 */
export function recallDirectorMemories(
  input: {
    query?: string;
    scope?: "all" | "global" | "scene";
    sceneId?: string;
    category?: string;
    limit?: number;
  } = {},
  storage?: StorageLike | null,
) {
  const query = input.query?.trim().toLocaleLowerCase() ?? "";
  const scope = input.scope ?? "all";
  const limit = Math.max(1, Math.min(100, input.limit ?? 50));
  return readDirectorAutomationLibrary(storage)
    .memories.filter((fact) => {
      if (scope === "global" && fact.scope !== "global") return false;
      if (scope === "scene" && (fact.scope !== "scene" || fact.sceneId !== input.sceneId)) return false;
      if (input.category && fact.category !== input.category) return false;
      if (!query) return true;
      return [fact.text, fact.category, ...fact.tags].some((value) => value.toLocaleLowerCase().includes(query));
    })
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id))
    .slice(0, limit);
}

/**
 * Exports the entire automation library as a portable JSON payload with a
 * versioned contract identifier, timestamp, and byte count.
 *
 * @param storage - Optional storage override.
 * @returns An export envelope with the contract, creation timestamp, byte
 *          length, and stable-serialized content.
 */
export function exportDirectorAutomationLibrary(storage?: StorageLike | null) {
  const library = readDirectorAutomationLibrary(storage);
  const content = stableLexicalJson(library);
  return {
    contract: "director-automation-export:v1" as const,
    created_at: new Date().toISOString(),
    bytes: new TextEncoder().encode(content).byteLength,
    content,
  };
}
