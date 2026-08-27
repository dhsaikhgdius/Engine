/**
 * Procedural generation recipes for the Stage: bounded, seeded, replayable
 * layout operations (arrays, mirrors, scatter, staircases, terrain,
 * L-systems, fragment scaffolds).
 *
 * Two properties make these safe as an agent surface. Every numeric field is
 * hard-bounded (copy counts, iteration depth, world extents) so a single
 * recipe can never explode the scene — the L-system caps at 4 iterations and
 * 3 branches for the same reason. And every randomized operation takes an
 * explicit int32 `seed`, so a persisted recipe re-runs to the identical
 * output; the recipe record stores both the operation and the produced
 * `outputObjectIds`, making the generation auditable and undoable.
 */
import { z } from "zod";

/** Protocol version for the procedural generation recipe format. */
export const DIRECTOR_PROCEDURAL_PROTOCOL_VERSION = 1 as const;
/** Maximum number of output objects a single procedural recipe may produce. */
export const DIRECTOR_PROCEDURAL_MAX_OUTPUTS = 256;

const finite = z.number().finite();
const id = z.string().trim().min(1).max(200);
const name = z.string().trim().min(1).max(240);
const color = z.string().regex(/^#[0-9a-f]{6}$/i, "must be a six-digit hex color");
const vec3 = z.tuple([finite.min(-1_000).max(1_000), finite.min(-1_000).max(1_000), finite.min(-1_000).max(1_000)]);
const seed = z.number().int().min(-2_147_483_648).max(2_147_483_647);

/** Discriminated union of procedural generation operations: arrays, mirrors, scatter, staircases, terrain, L-systems, and fragments. */
export const directorProceduralOperationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("linear-array"),
    sourceObjectId: id,
    copies: z.number().int().min(1).max(64),
    offset: vec3,
  }),
  z.strictObject({
    kind: z.literal("radial-array"),
    sourceObjectId: id,
    copies: z.number().int().min(1).max(64),
    center: vec3,
    radius: finite.positive().max(1_000),
    startAngleDegrees: finite.min(-360).max(360),
    arcDegrees: finite.min(-360).max(360),
    orientation: z.enum(["preserve", "outward", "inward", "tangent"]),
  }),
  z.strictObject({
    kind: z.literal("mirror"),
    sourceObjectId: id,
    axis: z.enum(["x", "y", "z"]),
    pivot: finite.min(-1_000).max(1_000),
    mirrorGeometry: z.boolean(),
  }),
  z
    .strictObject({
      kind: z.literal("scatter"),
      sourceObjectId: id,
      copies: z.number().int().min(1).max(64),
      center: vec3,
      size: z.tuple([finite.positive().max(1_000), finite.positive().max(1_000)]),
      heightJitter: finite.min(0).max(100),
      yawDegrees: finite.min(0).max(360),
      scaleMin: finite.positive().max(100),
      scaleMax: finite.positive().max(100),
      seed,
    })
    .refine((operation) => operation.scaleMax >= operation.scaleMin, {
      message: "scaleMax must be greater than or equal to scaleMin",
      path: ["scaleMax"],
    }),
  z.strictObject({
    kind: z.literal("staircase"),
    shape: z.enum(["straight", "spiral"]),
    steps: z.number().int().min(3).max(64),
    center: vec3,
    width: finite.positive().max(100),
    depth: finite.positive().max(100),
    risePerStep: finite.positive().max(10),
    runPerStep: finite.positive().max(100),
    radius: finite.positive().max(100),
    turns: finite.positive().max(8),
    includePillar: z.boolean(),
    stepColor: color,
    pillarColor: color,
  }),
  z.strictObject({
    kind: z.literal("terrain"),
    center: vec3,
    size: finite.min(1).max(200),
    resolution: z.number().int().min(2).max(12),
    heightScale: finite.min(0.05).max(50),
    octaves: z.number().int().min(1).max(6),
    seed,
    color,
  }),
  z.strictObject({
    kind: z.literal("l-system"),
    center: vec3,
    iterations: z.number().int().min(1).max(4),
    branches: z.number().int().min(2).max(3),
    branchLength: finite.min(0.1).max(20),
    lengthDecay: finite.min(0.35).max(0.9),
    branchRadius: finite.min(0.01).max(5),
    angleDegrees: finite.min(5).max(75),
    seed,
    trunkColor: color,
    foliageColor: color,
  }),
  z.strictObject({
    kind: z.literal("fragment-scaffold"),
    sourceObjectId: id,
    fragments: z.number().int().min(2).max(30),
    spread: finite.min(0).max(100),
    seed,
    deleteSource: z.boolean(),
  }),
]);

/** A fully-specified procedural recipe: version, id, operation, source objects, and output objects. */
export const directorProceduralRecipeSchema = z.strictObject({
  version: z.literal(DIRECTOR_PROCEDURAL_PROTOCOL_VERSION),
  id,
  name,
  createdAt: z.string().datetime({ offset: true }),
  operation: directorProceduralOperationSchema,
  sourceObjectIds: z.array(id).max(8),
  outputObjectIds: z.array(id).min(1).max(DIRECTOR_PROCEDURAL_MAX_OUTPUTS),
  warnings: z.array(z.string().trim().min(1).max(500)).max(12),
});

/** A parsed procedural generation operation. */
export type DirectorProceduralOperation = z.infer<typeof directorProceduralOperationSchema>;
/** A parsed procedural recipe. */
export type DirectorProceduralRecipe = z.infer<typeof directorProceduralRecipeSchema>;
