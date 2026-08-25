import { z } from "zod";
import {
  blenderAgentOperationNames,
  blenderAgentOperationSchema,
  blenderNativeToolRequestSchema,
} from "./blenderLiveProtocol";

/** Largest JSON Schema (serialized bytes) describe embeds before degrading to a field summary. */
const DESCRIBE_SCHEMA_BUDGET_BYTES = 20_000;

const JSON_SCHEMA_OPTIONS = {
  unrepresentable: "any",
  cycles: "ref",
  reused: "inline",
  io: "input",
} as const;

/**
 * Local contract reflection for `blender_native` typed apply ops.
 *
 * RNA `operator` describe still goes through the live kernel. This path answers
 * `{"op":"describe","target":"apply"}` or `{"op":"describe","target":"create_primitive"}`
 * from the TypeScript schema and does not require a mounted Blender session.
 */
export interface BlenderNativeDescribeResult {
  /** Canonical target, e.g. `"apply"` or `"apply.create_primitive"`. */
  target: string;
  /** Whether this describes the apply envelope or one typed operation. */
  kind: "operation" | "apply_operation";
  /** Full JSON Schema of the target; omitted when it exceeds the describe budget. */
  json_schema?: unknown;
  /** Top-level parameter names, returned when the full schema is over budget. */
  fields?: string[];
  /** Typed apply operation names; returned for target `"apply"`. */
  operations?: string[];
  /** Human-readable hint for how to send the described payload. */
  note?: string;
}

function serializedJsonSchema(schema: z.ZodType): { json: string; parsed: unknown } {
  const parsed = z.toJSONSchema(schema, JSON_SCHEMA_OPTIONS);
  return { json: JSON.stringify(parsed), parsed };
}

function normalizeApplyTarget(rawTarget: string): string {
  const target = rawTarget.trim();
  return target.startsWith("apply.") ? target.slice("apply.".length) : target;
}

type ApplyTargetAlias = {
  op: string;
  note: string;
};

const BOOLEAN_MODIFIER_NOTE =
  'There is no typed op named "{requested}". Wall/window/door holes use create_opening. Mesh boolean uses add_modifier with modifierType "BOOLEAN", then set_modifier properties {operation:"DIFFERENCE"|"UNION"|"INTERSECT", object:"<cutter id>"}.';

/** Common hallucinated or authoring-style names → canonical typed apply ops. */
function applyOperationNote(operationName: string): string {
  if (operationName === "assign_material") {
    return 'Reuse existing materials by exact, case, or separator-insensitive name. Omitted createIfMissing creates a Principled material. createIfMissing:false skips a still-missing name; the rest of the batch still applies. inspect lists sceneMaterials.';
  }
  if (operationName === "create_blockout") {
    return 'White-box architecture shells in metric metres: preset room = floor + 4 walls, corridor = floor + 2 walls, stairs = one flight (depth is total run, height total rise, stepCount steps), wall/floor = one slab. Created objects get stable ids "<idPrefix>:1..n" (room: 1 floor, then north/south/east/west walls) with a neutral clay material. Prefer one preset over hand-placing several create_primitive cubes; cut doors/windows afterwards with create_opening on a returned wall id.';
  }
  if (operationName === "create_opening") {
    return 'Cuts a real door or window hole through an existing mesh wall with an editable BOOLEAN modifier. width/height/sillHeight/offset are metres; sillHeight lifts a window above the wall base; offset slides the opening along the wall. Never fake an opening with a darker box on the wall.';
  }
  if (operationName === "create_primitive") {
    return 'dimensions is the only metric size (transform has no scale) and grounded:true puts the local origin at the floor-centre pivot. For a room, corridor, stair flight, or single wall/floor slab prefer create_blockout instead of assembling cubes.';
  }
  return 'Use this object inside blender_native {"op":"apply","operations":[...]}.';
}

const BLOCKOUT_ALIAS_NOTE =
  '"{requested}" is not a typed op. Architecture shells use create_blockout with preset floor/wall/room/corridor/stairs (metric metres, stable ids "<idPrefix>:1..n"). Cut doors/windows afterwards with create_opening.';
const OPENING_ALIAS_NOTE =
  '"{requested}" is not a typed op. Door and window holes use create_opening on an existing mesh wall (width/height/sillHeight/offset in metres); custom cutters use add_modifier with modifierType "BOOLEAN" then set_modifier {operation:"DIFFERENCE", object:"<cutter id>"}.';

const APPLY_TARGET_ALIASES: Record<string, ApplyTargetAlias> = {
  query: {
    op: "query_spatial",
    note: 'Top-level blender_native {"op":"query","query":"<name>"} finds objects by substring. Spatial batches use {"op":"query","queries":[{kind:"NAME"|"RAYCAST"|"CLOSEST_POINT"|"OVERLAP"|"GROUND",...}]}.',
  },
  add_camera: {
    op: "create_camera",
    note: '"{requested}" is an authoring-style name. Use canonical Blender operation "create_camera" inside blender_native {"op":"apply","operations":[...]}.',
  },
  boolean_difference: {
    op: "add_modifier",
    note: BOOLEAN_MODIFIER_NOTE,
  },
  boolean_union: {
    op: "add_modifier",
    note: BOOLEAN_MODIFIER_NOTE,
  },
  boolean_intersect: {
    op: "add_modifier",
    note: BOOLEAN_MODIFIER_NOTE,
  },
  boolean_intersection: {
    op: "add_modifier",
    note: BOOLEAN_MODIFIER_NOTE,
  },
  mesh_boolean: {
    op: "add_modifier",
    note: BOOLEAN_MODIFIER_NOTE,
  },
  boolean: {
    op: "add_modifier",
    note: BOOLEAN_MODIFIER_NOTE,
  },
  blockout: {
    op: "create_blockout",
    note: BLOCKOUT_ALIAS_NOTE,
  },
  create_room: {
    op: "create_blockout",
    note: BLOCKOUT_ALIAS_NOTE,
  },
  create_corridor: {
    op: "create_blockout",
    note: BLOCKOUT_ALIAS_NOTE,
  },
  create_stairs: {
    op: "create_blockout",
    note: BLOCKOUT_ALIAS_NOTE,
  },
  create_wall: {
    op: "create_blockout",
    note: BLOCKOUT_ALIAS_NOTE,
  },
  create_floor: {
    op: "create_blockout",
    note: BLOCKOUT_ALIAS_NOTE,
  },
  opening: {
    op: "create_opening",
    note: OPENING_ALIAS_NOTE,
  },
  add_opening: {
    op: "create_opening",
    note: OPENING_ALIAS_NOTE,
  },
  cut_opening: {
    op: "create_opening",
    note: OPENING_ALIAS_NOTE,
  },
  create_door: {
    op: "create_opening",
    note: OPENING_ALIAS_NOTE,
  },
  create_window: {
    op: "create_opening",
    note: OPENING_ALIAS_NOTE,
  },
};

function applyTargetAlias(target: string): ApplyTargetAlias | undefined {
  return APPLY_TARGET_ALIASES[target.toLowerCase().replace(/-/g, "_")];
}

function aliasNote(requested: string, alias: ApplyTargetAlias): string {
  return alias.note.replaceAll("{requested}", requested);
}

/**
 * Resolves a typed apply target to its JSON Schema without talking to Blender.
 *
 * Accepts `"apply"`, `"create_primitive"`, or `"apply.create_primitive"`.
 */
export function describeBlenderNativeTarget(
  rawTarget: string,
): { success: true; result: BlenderNativeDescribeResult } | { success: false; error: string } {
  const target = rawTarget.trim();
  if (!target) {
    return {
      success: false,
      error: `Unknown blender_native describe target "". ${typedApplyDescribeHint()}`,
    };
  }
  if (target === "apply") {
    const applyOption = blenderNativeToolRequestSchema.options.find(
      (candidate) => candidate.shape.op.value === "apply",
    );
    if (!applyOption) {
      return { success: false, error: `Unknown blender_native describe target "apply". ${typedApplyDescribeHint()}` };
    }
    const serialized = serializedJsonSchema(applyOption);
    return {
      success: true,
      result: {
        target: "apply",
        kind: "operation",
        json_schema: serialized.parsed,
        operations: [...blenderAgentOperationNames],
        note: 'Send blender_native {"op":"apply","operations":[...]}. director_workbench has no apply op. Describe one typed op with {"op":"describe","target":"create_primitive"}.',
      },
    };
  }

  const requestedOperationName = normalizeApplyTarget(target);
  const alias = applyTargetAlias(requestedOperationName);
  const operationName = alias?.op ?? requestedOperationName;
  const option = blenderAgentOperationSchema.options.find((candidate) => candidate.shape.op.value === operationName);
  if (!option) {
    return {
      success: false,
      error: `Unknown blender_native describe target "${target}". ${typedApplyDescribeHint(requestedOperationName)}`,
    };
  }

  const canonical = `apply.${operationName}`;
  const serialized = serializedJsonSchema(option);
  const note = alias ? aliasNote(requestedOperationName, alias) : applyOperationNote(operationName);
  if (serialized.json.length <= DESCRIBE_SCHEMA_BUDGET_BYTES) {
    return {
      success: true,
      result: {
        target: canonical,
        kind: "apply_operation",
        json_schema: serialized.parsed,
        note,
      },
    };
  }
  return {
    success: true,
    result: {
      target: canonical,
      kind: "apply_operation",
      fields: Object.keys(option.shape),
      note: `${note} The full schema exceeds the describe budget; fields lists the top-level parameters.`,
    },
  };
}

function typedApplyDescribeHint(requested?: string): string {
  const preview = blenderAgentOperationNames.slice(0, 12).join(", ");
  const booleanHint =
    requested && /boolean|difference|union|intersect/i.test(requested)
      ? ' There is no boolean_difference op: describe create_opening for wall holes, or add_modifier (modifierType "BOOLEAN") then set_modifier.'
      : "";
  return `Use {"op":"describe","operator":"mesh.bevel"} for Blender RNA, or {"op":"describe","target":"apply"} / {"op":"describe","target":"create_primitive"} for typed apply ops.${booleanHint} Valid typed ops include ${preview}, …`;
}
