import { describe, expect, it } from "vitest";
import { safeParseDirectorProject } from "@director/project-schema";
import { createDefaultDirectorProject } from "../src/directorDefaultProject";
import { applyDirectorAuthoringActions, directorAuthoringActionSchema } from "../src/directorAuthoring";
import { previewDirectorProceduralRecipe, type DirectorApplyProceduralAction } from "../src/directorProceduralAuthoring";

const createdAt = "2026-08-07T01:00:00.000Z";

function sourceProject() {
  return applyDirectorAuthoringActions(createDefaultDirectorProject(), [
    {
      action: "add_object",
      id: "procedural-source",
      name: "Source crate",
      kind: "prop",
      geometry_type: "box",
      placement_mode: "grounded",
      color: "#7799bb",
      material: { baseColor: "#7799bb", roughness: 0.7, metalness: 0.1, opacity: 1 },
      transform: { position: [1, 0, 2], rotation: [0, 0.2, 0], scale: [2, 1, 3] },
    },
  ]).project;
}

function action(
  operation: DirectorApplyProceduralAction["operation"],
  recipeId = `recipe-${operation.kind}`,
): DirectorApplyProceduralAction {
  return {
    action: "apply_procedural",
    recipe_id: recipeId,
    name: `Test ${operation.kind}`,
    created_at: createdAt,
    operation,
  };
}

describe("Director procedural authoring", () => {
  it("validates bounded operations at the shared Agent boundary", () => {
    expect(
      directorAuthoringActionSchema.safeParse(
        action({
          kind: "terrain",
          center: [0, 0, 0],
          size: 20,
          resolution: 13,
          heightScale: 2,
          octaves: 4,
          seed: 1,
          color: "#557744",
        }),
      ).success,
    ).toBe(false);
    expect(
      directorAuthoringActionSchema.safeParse(
        action({
          kind: "scatter",
          sourceObjectId: "procedural-source",
          copies: 4,
          center: [0, 0, 0],
          size: [4, 4],
          heightJitter: 0,
          yawDegrees: 20,
          scaleMin: 2,
          scaleMax: 1,
          seed: 9,
        }),
      ).success,
    ).toBe(false);
  });

  it("applies a linear array with durable recipe and per-object provenance", () => {
    const result = applyDirectorAuthoringActions(sourceProject(), [
      action({ kind: "linear-array", sourceObjectId: "procedural-source", copies: 3, offset: [2, 0, -1] }),
    ]);
    const recipe = result.project.proceduralRecipes?.[0];
    expect(recipe).toMatchObject({
      id: "recipe-linear-array",
      operation: { kind: "linear-array", copies: 3 },
      sourceObjectIds: ["procedural-source"],
    });
    expect(recipe?.outputObjectIds).toHaveLength(3);
    const copies = result.project.objects.filter((object) => recipe?.outputObjectIds.includes(object.id));
    expect(copies.map((object) => object.transform.position)).toEqual([
      [3, 0, 1],
      [5, 0, 0],
      [7, 0, -1],
    ]);
    expect(copies[0]?.referenceBindings?.at(-1)).toMatchObject({
      kind: "action",
      ref: "recipe-linear-array",
    });
    expect(safeParseDirectorProject(result.project).success).toBe(true);
  });

  it("produces byte-for-byte deterministic scatter previews for the same seed", () => {
    const request = action({
      kind: "scatter",
      sourceObjectId: "procedural-source",
      copies: 8,
      center: [0, 0, 0],
      size: [12, 9],
      heightJitter: 0.5,
      yawDegrees: 90,
      scaleMin: 0.7,
      scaleMax: 1.3,
      seed: 42,
    });
    const first = previewDirectorProceduralRecipe(sourceProject(), request);
    const second = previewDirectorProceduralRecipe(sourceProject(), request);
    expect(second.outputObjects).toEqual(first.outputObjects);

    if (request.operation.kind !== "scatter") throw new Error("test fixture must remain a scatter operation");
    const changed = previewDirectorProceduralRecipe(sourceProject(), {
      ...request,
      recipe_id: "recipe-scatter-other",
      operation: { ...request.operation, seed: 43 },
    });
    expect(changed.outputObjects.map((object) => object.transform)).not.toEqual(
      first.outputObjects.map((object) => object.transform),
    );
  });

  it("builds bounded terrain and L-system primitive plans without mutating preview input", () => {
    const project = sourceProject();
    const original = structuredClone(project);
    const terrain = previewDirectorProceduralRecipe(
      project,
      action({
        kind: "terrain",
        center: [0, 0, 0],
        size: 8,
        resolution: 6,
        heightScale: 2,
        octaves: 3,
        seed: 7,
        color: "#557744",
      }),
    );
    const plant = previewDirectorProceduralRecipe(
      project,
      action(
        {
          kind: "l-system",
          center: [0, 0, 0],
          iterations: 3,
          branches: 2,
          branchLength: 1,
          lengthDecay: 0.7,
          branchRadius: 0.12,
          angleDegrees: 35,
          seed: 11,
          trunkColor: "#5a3a1a",
          foliageColor: "#2d8a3e",
        },
        "recipe-plant",
      ),
    );
    expect(terrain.outputObjects).toHaveLength(36);
    expect(terrain.recipe.warnings.join(" ")).toContain("primitive-cell");
    expect(plant.outputObjects.length).toBeGreaterThan(15);
    expect(plant.outputObjects.length).toBeLessThanOrEqual(256);
    expect(project).toEqual(original);
  });

  it("keeps destructive fragment replacement atomic and lock-aware", () => {
    const project = sourceProject();
    project.objects.find((object) => object.id === "procedural-source")!.locked = true;
    const request = action({
      kind: "fragment-scaffold",
      sourceObjectId: "procedural-source",
      fragments: 5,
      spread: 1,
      seed: 5,
      deleteSource: true,
    });
    expect(() => applyDirectorAuthoringActions(project, [request])).toThrow(/locked/i);
    expect(project.objects.some((object) => object.id === "procedural-source")).toBe(true);
    expect(project.proceduralRecipes).toBeUndefined();
  });
});
