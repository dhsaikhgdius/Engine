import { z } from "zod";
import type {
  DirectorObject,
  DirectorPbrMaterial,
  DirectorPlacementMode,
  DirectorProject,
  DirectorReferenceBinding,
  DirectorTransform,
} from "@director/project-schema";
import {
  DIRECTOR_PROCEDURAL_MAX_OUTPUTS,
  directorProceduralOperationSchema,
  directorProceduralRecipeSchema,
  type DirectorProceduralOperation,
  type DirectorProceduralRecipe,
} from "@director/protocol/directorProceduralProtocol";
import { strictAction } from "@director/protocol/strictProtocolVariant";

/** Reusable ID validator for procedural recipe and action identifiers. */
const proceduralId = z.string().trim().min(1).max(200);

/**
 * Validates an `apply_procedural` authoring action: a recipe ID, display name,
 * creation timestamp, and the procedural operation to execute.
 */
export const directorApplyProceduralActionSchema = strictAction("apply_procedural", {
  recipe_id: proceduralId,
  name: z.string().trim().min(1).max(240),
  created_at: z.string().datetime({ offset: true }),
  operation: directorProceduralOperationSchema,
});

/** An authoring action that applies a procedural recipe to generate scene objects. */
export type DirectorApplyProceduralAction = z.infer<typeof directorApplyProceduralActionSchema>;

/**
 * Low-level scene mutation produced by a procedural recipe: either add a new
 * object (prop or scene) or delete one or more existing objects.
 */
export type DirectorProceduralLowLevelAction =
  | {
      action: "add_object";
      id: string;
      name: string;
      kind: "prop" | "scene";
      transform: DirectorTransform;
      color?: string;
      material?: DirectorPbrMaterial;
      asset_id?: string;
      geometry_type?: DirectorObject["geometryType"];
      placement_mode?: DirectorPlacementMode;
      parent_id?: string;
      reference_bindings?: DirectorReferenceBinding[];
      locked?: boolean;
    }
  | {
      action: "delete_objects";
      object_ids: string[];
      cascade?: boolean;
      force?: boolean;
    };

/** Full preview of a procedural recipe: the action, resolved recipe, generated
 *  low-level actions, and a summary of output objects. */
export interface DirectorProceduralPreview {
  /** The validated apply_procedural action that triggered the preview. */
  action: DirectorApplyProceduralAction;
  /** The resolved procedural recipe with metadata, source IDs, and warnings. */
  recipe: DirectorProceduralRecipe;
  /** The concrete low-level actions the recipe would produce. */
  actions: DirectorProceduralLowLevelAction[];
  /** Lightweight summary of each output object for UI display. */
  outputObjects: Array<{
    id: string;
    name: string;
    geometryType: DirectorObject["geometryType"];
    transform: DirectorTransform;
  }>;
}

/**
 * Type guard that checks whether an authoring action value is a procedural
 * apply action.
 *
 * @param value - An action-like object with at least an `action` string property.
 * @returns True when the action is `"apply_procedural"`.
 */
export function isDirectorProceduralAuthoringAction(value: { action: string }): value is DirectorApplyProceduralAction {
  return value.action === "apply_procedural";
}

// Round a value to 6 decimal places for deterministic position and scale output.
function rounded(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

// Create a rounded 3D vector from a readonly array, defaulting missing
// components to 0.
function vec3(values: readonly number[]): [number, number, number] {
  return [rounded(values[0] ?? 0), rounded(values[1] ?? 0), rounded(values[2] ?? 0)];
}

// Derive a safe, URL-friendly token from a recipe ID for use in generated
// object IDs. Falls back to "procedural" when the ID has no alphanumeric content.
function recipeToken(recipeId: string) {
  const readable = recipeId
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return readable || "procedural";
}

// Generate a deterministic output object ID from the recipe ID and a 0-based
// index, clamped to 200 characters.
function outputId(recipeId: string, index: number) {
  return `proc-${recipeToken(recipeId)}-${String(index + 1).padStart(3, "0")}`.slice(0, 200);
}

// Generate a human-readable output name from a prefix, a label, and a 1-based
// index, clamped to 240 characters.
function outputName(prefix: string, label: string, index: number) {
  return `${prefix} · ${label} ${index + 1}`.slice(0, 240);
}

// Look up a source object in the project, enforcing that it is a prop or scene
// object with geometry (either a primitive or a model asset).
function sourceObject(project: DirectorProject, objectId: string) {
  const object = project.objects.find((candidate) => candidate.id === objectId);
  if (!object) throw new Error(`No object with id "${objectId}" exists.`);
  if (object.kind !== "prop" && object.kind !== "scene") {
    throw new Error("Procedural source objects must be props or scene objects.");
  }
  if (object.isCompositeParent) throw new Error("A composite parent cannot be used as a procedural source.");
  if (!object.geometryType && !object.assetRefId) {
    throw new Error(`Procedural source object "${objectId}" has no primitive geometry or model asset.`);
  }
  return object as DirectorObject & { kind: "prop" | "scene" };
}

// Build a reference binding that links an output object back to the procedural
// recipe that created it, for UI provenance display.
function actionBinding(recipe: DirectorApplyProceduralAction): DirectorReferenceBinding {
  return {
    id: `${recipeToken(recipe.recipe_id)}-binding`.slice(0, 200),
    kind: "action",
    label: `Procedural · ${recipe.name}`,
    ref: recipe.recipe_id,
    showInViewport: false,
  };
}

// Merge the source object's existing reference bindings (keeping at most the
// last 31) with a new procedural action binding.
function bindingsFor(source: DirectorObject | null, recipe: DirectorApplyProceduralAction) {
  return [...(source?.referenceBindings ?? []).slice(-31), actionBinding(recipe)];
}

// Create an add_object action that copies a source object's kind, color,
// material, asset, geometry, and placement mode, with a new transform and
// procedural reference bindings.
function copyAction(
  source: DirectorObject & { kind: "prop" | "scene" },
  recipe: DirectorApplyProceduralAction,
  id: string,
  name: string,
  transform: DirectorTransform,
  placementMode = source.placementMode,
): DirectorProceduralLowLevelAction {
  return {
    action: "add_object",
    id,
    name,
    kind: source.kind,
    transform,
    ...(source.color ? { color: source.color } : {}),
    ...(source.material ? { material: structuredClone(source.material) } : {}),
    ...(source.assetRefId ? { asset_id: source.assetRefId } : {}),
    ...(source.geometryType ? { geometry_type: source.geometryType } : {}),
    ...(placementMode ? { placement_mode: placementMode } : {}),
    reference_bindings: bindingsFor(source, recipe),
    locked: false,
  };
}

// Create an add_object action for a primitive geometry (box, cylinder, sphere)
// with an explicit material, placement mode, and optional parent.
function primitiveAction(
  recipe: DirectorApplyProceduralAction,
  id: string,
  name: string,
  geometryType: NonNullable<DirectorObject["geometryType"]>,
  transform: DirectorTransform,
  material: DirectorPbrMaterial,
  placementMode: DirectorPlacementMode,
  parentId?: string,
): DirectorProceduralLowLevelAction {
  return {
    action: "add_object",
    id,
    name,
    kind: "prop",
    geometry_type: geometryType,
    transform,
    color: material.baseColor,
    material,
    placement_mode: placementMode,
    ...(parentId ? { parent_id: parentId } : {}),
    reference_bindings: bindingsFor(null, recipe),
    locked: false,
  };
}

// Mulberry32 PRNG: a fast, seedable 32-bit generator with good distribution
// for procedural placements. Not cryptographically secure.
function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

// 2D value noise with smoothstep interpolation between lattice points.
// Used as the basis for fractal Brownian motion terrain generation.
function valueNoise2d(x: number, y: number, seed: number) {
  const latticeValue = (ix: number, iy: number) => {
    let value = Math.imul(ix, 374_761_393) + Math.imul(iy, 668_265_263) + Math.imul(seed, 1_442_695_041);
    value = Math.imul(value ^ (value >>> 13), 1_274_126_177);
    return ((value ^ (value >>> 16)) >>> 0) / 4_294_967_295;
  };
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = (x - x0) ** 2 * (3 - 2 * (x - x0));
  const fy = (y - y0) ** 2 * (3 - 2 * (y - y0));
  const nx0 = latticeValue(x0, y0) * (1 - fx) + latticeValue(x0 + 1, y0) * fx;
  const nx1 = latticeValue(x0, y0 + 1) * (1 - fx) + latticeValue(x0 + 1, y0 + 1) * fx;
  return nx0 * (1 - fy) + nx1 * fy;
}

// Fractal Brownian motion: sums octaves of value noise, each at half amplitude
// and double frequency, normalized by the total amplitude.
function fbm(x: number, y: number, octaves: number, seed: number) {
  let total = 0;
  let amplitude = 1;
  let frequency = 1;
  let maximum = 0;
  for (let octave = 0; octave < octaves; octave += 1) {
    total += valueNoise2d(x * frequency, y * frequency, seed + octave * 101) * amplitude;
    maximum += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return maximum ? total / maximum : 0;
}

// Convert a direction vector to Euler rotation angles for a cylinder primitive
// so it aligns with the branch direction in the L-system.
function branchRotation(direction: [number, number, number]): [number, number, number] {
  return vec3([Math.asin(Math.max(-1, Math.min(1, direction[2]))), 0, Math.atan2(-direction[0], direction[1])]);
}

// Extract source object IDs from a procedural operation for the recipe's
// sourceObjectIds metadata field.
function operationSourceIds(operation: DirectorProceduralOperation) {
  return "sourceObjectId" in operation ? [operation.sourceObjectId] : [];
}

// Return human-readable warnings about the limitations of each procedural
// operation kind, surfaced in the recipe for agent and UI consumption.
function warningsFor(operation: DirectorProceduralOperation) {
  switch (operation.kind) {
    case "terrain":
      return ["Terrain is an editable primitive-cell height field, not a welded production mesh."];
    case "l-system":
      return [
        "The L-system result is an editable primitive branch scaffold; use DCC exchange for botanical final geometry.",
      ];
    case "fragment-scaffold":
      return ["Fragments are deterministic blocking boxes, not a geometric Voronoi boolean result."];
    case "mirror":
      return operation.mirrorGeometry
        ? ["Mirrored geometry uses a negative scale axis; downstream formats may bake or reject handedness."]
        : [];
    case "staircase":
      return operation.shape === "spiral" && !operation.includePillar
        ? ["Spiral steps without a pillar are marked floating and require an authored support before final delivery."]
        : [];
    default:
      return [];
  }
}

// Build the full list of low-level actions for a procedural operation.
// Dispatches to the appropriate builder for each operation kind (linear-array,
// radial-array, mirror, scatter, staircase, terrain, l-system, fragment-scaffold)
// and validates the output count against DIRECTOR_PROCEDURAL_MAX_OUTPUTS.
function buildActions(project: DirectorProject, recipe: DirectorApplyProceduralAction) {
  const operation = recipe.operation;
  const actions: DirectorProceduralLowLevelAction[] = [];
  const ids: string[] = [];
  const add = (action: DirectorProceduralLowLevelAction) => {
    if (action.action === "add_object") ids.push(action.id);
    actions.push(action);
  };

  if (operation.kind === "linear-array") {
    const source = sourceObject(project, operation.sourceObjectId);
    for (let index = 0; index < operation.copies; index += 1) {
      const id = outputId(recipe.recipe_id, index);
      add(
        copyAction(source, recipe, id, outputName(source.name, "Linear", index), {
          ...structuredClone(source.transform),
          position: vec3(source.transform.position.map((value, axis) => value + operation.offset[axis]! * (index + 1))),
        }),
      );
    }
  } else if (operation.kind === "radial-array") {
    const source = sourceObject(project, operation.sourceObjectId);
    const fullCircle = Math.abs(operation.arcDegrees) >= 359.999;
    for (let index = 0; index < operation.copies; index += 1) {
      const progress = fullCircle ? index / operation.copies : index / Math.max(1, operation.copies - 1);
      const angle = ((operation.startAngleDegrees + operation.arcDegrees * progress) * Math.PI) / 180;
      let yaw = source.transform.rotation[1];
      if (operation.orientation === "outward") yaw = Math.atan2(Math.sin(angle), Math.cos(angle));
      else if (operation.orientation === "inward") yaw = Math.atan2(-Math.sin(angle), -Math.cos(angle));
      else if (operation.orientation === "tangent") yaw = angle + Math.PI / 2;
      const id = outputId(recipe.recipe_id, index);
      add(
        copyAction(source, recipe, id, outputName(source.name, "Radial", index), {
          ...structuredClone(source.transform),
          position: vec3([
            operation.center[0] + Math.sin(angle) * operation.radius,
            operation.center[1],
            operation.center[2] + Math.cos(angle) * operation.radius,
          ]),
          rotation: vec3([source.transform.rotation[0], yaw, source.transform.rotation[2]]),
        }),
      );
    }
  } else if (operation.kind === "mirror") {
    const source = sourceObject(project, operation.sourceObjectId);
    const axis = operation.axis === "x" ? 0 : operation.axis === "y" ? 1 : 2;
    const position = [...source.transform.position] as [number, number, number];
    position[axis] = operation.pivot * 2 - position[axis];
    const scale = [...source.transform.scale] as [number, number, number];
    if (operation.mirrorGeometry) scale[axis] *= -1;
    add(
      copyAction(source, recipe, outputId(recipe.recipe_id, 0), `${source.name} · Mirror`.slice(0, 240), {
        ...structuredClone(source.transform),
        position: vec3(position),
        scale: vec3(scale),
      }),
    );
  } else if (operation.kind === "scatter") {
    const source = sourceObject(project, operation.sourceObjectId);
    const random = mulberry32(operation.seed);
    for (let index = 0; index < operation.copies; index += 1) {
      const scaleFactor = operation.scaleMin + random() * (operation.scaleMax - operation.scaleMin);
      const yOffset = (random() * 2 - 1) * operation.heightJitter;
      const yaw = source.transform.rotation[1] + ((random() * 2 - 1) * operation.yawDegrees * Math.PI) / 180;
      const id = outputId(recipe.recipe_id, index);
      add(
        copyAction(
          source,
          recipe,
          id,
          outputName(source.name, "Scatter", index),
          {
            position: vec3([
              operation.center[0] + (random() - 0.5) * operation.size[0],
              operation.center[1] + yOffset,
              operation.center[2] + (random() - 0.5) * operation.size[1],
            ]),
            rotation: vec3([source.transform.rotation[0], yaw, source.transform.rotation[2]]),
            scale: vec3(source.transform.scale.map((value) => value * scaleFactor)),
          },
          operation.heightJitter > 0 ? "floating" : source.placementMode,
        ),
      );
    }
  } else if (operation.kind === "staircase") {
    const stepMaterial: DirectorPbrMaterial = {
      baseColor: operation.stepColor,
      roughness: 0.65,
      metalness: 0.05,
      opacity: 1,
    };
    let pillarId: string | undefined;
    if (operation.shape === "spiral" && operation.includePillar) {
      pillarId = outputId(recipe.recipe_id, 0);
      add(
        primitiveAction(
          recipe,
          pillarId,
          `${recipe.name} · Pillar`.slice(0, 240),
          "cylinder",
          {
            position: vec3(operation.center),
            rotation: [0, 0, 0],
            scale: vec3([
              Math.max(0.1, operation.depth * 0.45),
              operation.steps * operation.risePerStep,
              Math.max(0.1, operation.depth * 0.45),
            ]),
          },
          { baseColor: operation.pillarColor, roughness: 0.55, metalness: 0.1, opacity: 1 },
          "grounded",
        ),
      );
    }
    for (let index = 0; index < operation.steps; index += 1) {
      const id = outputId(recipe.recipe_id, ids.length);
      if (operation.shape === "straight") {
        add(
          primitiveAction(
            recipe,
            id,
            outputName(recipe.name, "Step", index),
            "box",
            {
              position: vec3([
                operation.center[0],
                operation.center[1],
                operation.center[2] + index * operation.runPerStep,
              ]),
              rotation: [0, 0, 0],
              scale: vec3([operation.width, (index + 1) * operation.risePerStep, operation.depth]),
            },
            stepMaterial,
            "grounded",
          ),
        );
      } else {
        const angle = (index / Math.max(1, operation.steps - 1)) * operation.turns * Math.PI * 2;
        add(
          primitiveAction(
            recipe,
            id,
            outputName(recipe.name, "Step", index),
            "box",
            {
              position: vec3([
                operation.center[0] + Math.sin(angle) * operation.radius * 0.5,
                operation.center[1] + index * operation.risePerStep,
                operation.center[2] + Math.cos(angle) * operation.radius * 0.5,
              ]),
              rotation: vec3([0, angle, 0]),
              scale: vec3([operation.radius, Math.max(0.05, operation.risePerStep * 0.25), operation.depth]),
            },
            stepMaterial,
            pillarId ? "attached" : "floating",
            pillarId,
          ),
        );
      }
    }
  } else if (operation.kind === "terrain") {
    const cell = operation.size / operation.resolution;
    for (let row = 0; row < operation.resolution; row += 1) {
      for (let column = 0; column < operation.resolution; column += 1) {
        const index = ids.length;
        const height = Math.max(
          0.05,
          fbm(
            (column / operation.resolution) * 4,
            (row / operation.resolution) * 4,
            operation.octaves,
            operation.seed,
          ) * operation.heightScale,
        );
        add(
          primitiveAction(
            recipe,
            outputId(recipe.recipe_id, index),
            `${recipe.name} · Cell ${row + 1}.${column + 1}`.slice(0, 240),
            "box",
            {
              position: vec3([
                operation.center[0] - operation.size / 2 + (column + 0.5) * cell,
                operation.center[1],
                operation.center[2] - operation.size / 2 + (row + 0.5) * cell,
              ]),
              rotation: [0, 0, 0],
              scale: vec3([cell, height, cell]),
            },
            { baseColor: operation.color, roughness: 0.9, metalness: 0, opacity: 1 },
            "grounded",
          ),
        );
      }
    }
  } else if (operation.kind === "l-system") {
    const random = mulberry32(operation.seed);
    type Branch = {
      start: [number, number, number];
      direction: [number, number, number];
      length: number;
      radius: number;
      depth: number;
      parentId?: string;
    };
    const queue: Branch[] = [
      {
        start: vec3(operation.center),
        direction: [0, 1, 0],
        length: operation.branchLength,
        radius: operation.branchRadius,
        depth: 0,
      },
    ];
    const terminalBranches: Array<{ end: [number, number, number]; parentId: string }> = [];
    while (queue.length) {
      const branch = queue.shift()!;
      const id = outputId(recipe.recipe_id, ids.length);
      const end = vec3(branch.start.map((value, axis) => value + branch.direction[axis]! * branch.length));
      add(
        primitiveAction(
          recipe,
          id,
          outputName(recipe.name, "Branch", ids.length),
          "cylinder",
          {
            position: branch.start,
            rotation: branchRotation(branch.direction),
            scale: vec3([branch.radius * 2, branch.length, branch.radius * 2]),
          },
          { baseColor: operation.trunkColor, roughness: 0.9, metalness: 0, opacity: 1 },
          branch.parentId ? "attached" : "grounded",
          branch.parentId,
        ),
      );
      if (branch.depth >= operation.iterations) {
        terminalBranches.push({ end, parentId: id });
        continue;
      }
      const angle = (operation.angleDegrees * Math.PI) / 180;
      for (let child = 0; child < operation.branches; child += 1) {
        const yaw = ((child + random() * 0.35) / operation.branches) * Math.PI * 2 + branch.depth * 0.65;
        queue.push({
          start: end,
          direction: vec3([Math.sin(angle) * Math.cos(yaw), Math.cos(angle), Math.sin(angle) * Math.sin(yaw)]),
          length: branch.length * operation.lengthDecay,
          radius: Math.max(0.01, branch.radius * operation.lengthDecay),
          depth: branch.depth + 1,
          parentId: id,
        });
      }
    }
    terminalBranches.forEach((terminal, index) => {
      const diameter = Math.max(0.12, operation.branchLength * operation.lengthDecay ** operation.iterations * 0.8);
      add(
        primitiveAction(
          recipe,
          outputId(recipe.recipe_id, ids.length),
          outputName(recipe.name, "Foliage", index),
          "sphere",
          {
            position: vec3([terminal.end[0], terminal.end[1] - diameter / 2, terminal.end[2]]),
            rotation: [0, 0, 0],
            scale: vec3([diameter, diameter, diameter]),
          },
          { baseColor: operation.foliageColor, roughness: 0.85, metalness: 0, opacity: 1 },
          "attached",
          terminal.parentId,
        ),
      );
    });
  } else {
    const source = sourceObject(project, operation.sourceObjectId);
    const random = mulberry32(operation.seed);
    const sourceSize = source.transform.scale.map((value) => Math.max(0.05, Math.abs(value))) as [
      number,
      number,
      number,
    ];
    const divisor = Math.cbrt(operation.fragments);
    for (let index = 0; index < operation.fragments; index += 1) {
      const local = vec3([
        (random() - 0.5) * sourceSize[0],
        random() * sourceSize[1],
        (random() - 0.5) * sourceSize[2],
      ]);
      const length = Math.hypot(local[0], local[1], local[2]) || 1;
      const fragmentScale = vec3(sourceSize.map((value) => (value / divisor) * (0.6 + random() * 0.4)));
      add(
        primitiveAction(
          recipe,
          outputId(recipe.recipe_id, index),
          outputName(source.name, "Fragment", index),
          "box",
          {
            position: vec3([
              source.transform.position[0] + local[0] + (local[0] / length) * operation.spread,
              source.transform.position[1] + local[1] + (local[1] / length) * operation.spread,
              source.transform.position[2] + local[2] + (local[2] / length) * operation.spread,
            ]),
            rotation: vec3([(random() - 0.5) * 0.8, (random() - 0.5) * 0.8, (random() - 0.5) * 0.8]),
            scale: fragmentScale,
          },
          source.material
            ? structuredClone(source.material)
            : { baseColor: source.color ?? "#aab4c0", roughness: 0.7, opacity: 1 },
          "floating",
        ),
      );
    }
    if (operation.deleteSource) {
      actions.push({ action: "delete_objects", object_ids: [source.id], cascade: false, force: false });
    }
  }

  if (!ids.length || ids.length > DIRECTOR_PROCEDURAL_MAX_OUTPUTS) {
    throw new Error(`Procedural operation must create between 1 and ${DIRECTOR_PROCEDURAL_MAX_OUTPUTS} objects.`);
  }
  return { actions, ids };
}

/**
 * Previews a procedural recipe by building the low-level actions it would
 * produce without persisting them. Validates the action, checks for recipe ID
 * and output ID collisions, builds the recipe metadata, and returns a full
 * preview with actions and output object summaries.
 *
 * @param project - The Director project to build against (for source object lookup).
 * @param rawAction - The apply_procedural action to preview.
 * @returns A preview containing the validated action, resolved recipe, low-level
 *          actions, and output object summaries.
 * @throws If the recipe ID already exists, an output ID collides, or the
 *         operation produces an invalid number of objects.
 */
export function previewDirectorProceduralRecipe(
  project: DirectorProject,
  rawAction: DirectorApplyProceduralAction,
): DirectorProceduralPreview {
  const action = directorApplyProceduralActionSchema.parse(rawAction);
  if (project.proceduralRecipes?.some((recipe) => recipe.id === action.recipe_id)) {
    throw new Error(`Procedural recipe id "${action.recipe_id}" already exists.`);
  }
  const built = buildActions(project, action);
  const existingIds = new Set(project.objects.map((object) => object.id));
  const duplicateId = built.ids.find((id) => existingIds.has(id));
  if (duplicateId) throw new Error(`Procedural output id "${duplicateId}" already exists.`);
  const recipe = directorProceduralRecipeSchema.parse({
    version: 1,
    id: action.recipe_id,
    name: action.name,
    createdAt: action.created_at,
    operation: action.operation,
    sourceObjectIds: operationSourceIds(action.operation),
    outputObjectIds: built.ids,
    warnings: warningsFor(action.operation),
  });
  return {
    action,
    recipe,
    actions: built.actions,
    outputObjects: built.actions.flatMap((entry) =>
      entry.action === "add_object"
        ? [{ id: entry.id, name: entry.name, geometryType: entry.geometry_type, transform: entry.transform }]
        : [],
    ),
  };
}
