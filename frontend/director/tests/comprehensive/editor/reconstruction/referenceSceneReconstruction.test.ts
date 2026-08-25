import { beforeEach, expect, it } from "vitest";
import type { ReferenceSceneReconstructionPlan } from "../../../../../../packages/protocol/src/referenceSceneReconstructionProtocol";
import { getDirectorProjectRevision } from "../../../../src/comprehensive/editor/schema/directorProjectRevision";
import { createDefaultDirectorProject, createInitialDirectorState, useDirectorStore } from "../../../../src/comprehensive/editor/store/directorStore";
import { ReferenceScenePlanConflictError, applyReferenceSceneReconstructionPlan } from "../../../../src/comprehensive/editor/reconstruction/referenceSceneReconstruction";

function plan(): ReferenceSceneReconstructionPlan {
  const source = createDefaultDirectorProject();
  return {
    version: 1,
    id: "reference-plan-test",
    status: "draft",
    createdAt: "2026-08-07T00:00:00.000Z",
    expectedProjectRevision: getDirectorProjectRevision(source),
    prompt: "Rebuild the plinth.",
    applyMode: "append",
    source: {
      fileName: "reference.jpg",
      mimeType: "image/jpeg",
      sha256: "a".repeat(64),
      metrics: {
        width: 1280,
        height: 720,
        palette: ["#15202b", "#d8af77"],
        meanLuminance: 0.4,
        edgeDensity: 0.2,
        foregroundCoverage: 0.5,
      },
    },
    analysis: {
      status: "ready",
      mode: "vision",
      profileId: "vision-primary",
      model: "vision-model",
      summary: "A product plinth.",
      confidence: 0.8,
      warnings: ["Rear geometry is inferred."],
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    },
    backgroundColor: "#15202b",
    objects: [
      {
        id: "reference-object-test-01",
        enabled: true,
        name: "Product plinth",
        geometryType: "cylinder",
        transform: { position: [0, 0.5, 0], rotation: [0, 0.2, 0], scale: [1.8, 1, 1.8] },
        placementMode: "grounded",
        material: {
          baseColor: "#d8af77",
          metalness: 0.1,
          roughness: 0.6,
          emissiveColor: "#000000",
          emissiveIntensity: 0,
          opacity: 1,
        },
        confidence: 0.85,
        rationale: "Central cylindrical silhouette.",
      },
    ],
    lights: [
      {
        id: "reference-light-test-01",
        enabled: true,
        name: "Reference key",
        type: "rect-area",
        color: "#fff0d8",
        intensity: 4,
        position: [3, 5, 4],
        target: [0, 0.5, 0],
        castShadow: false,
        rationale: "Broad warm key.",
      },
    ],
  };
}

beforeEach(() => {
  window.localStorage.clear();
  useDirectorStore.setState({ ...useDirectorStore.getState(), ...createInitialDirectorState() });
});

it("applies a revision-bound plan atomically with image provenance and undo", () => {
  const source = createDefaultDirectorProject();
  const result = applyReferenceSceneReconstructionPlan(
    source,
    plan(),
    "data:image/jpeg;base64,/9j/2Q==",
    "2026-08-07T00:01:00.000Z",
  );
  const object = result.project.objects.find((entry) => entry.id === "reference-object-test-01");

  expect(result.created.object_ids).toContain("reference-object-test-01");
  expect(result.created.light_ids).toContain("reference-light-test-01");
  expect(object).toMatchObject({
    geometryType: "cylinder",
    referenceBindings: [
      {
        kind: "image",
        ref: "reference-image-aaaaaaaaaaaaaaaaaaaa",
      },
    ],
  });
  expect(result.project.referenceReconstructions?.[0]).toMatchObject({
    status: "applied",
    application: {
      sourceAssetId: "reference-image-aaaaaaaaaaaaaaaaaaaa",
      objectIds: ["reference-object-test-01"],
    },
  });
  expect(JSON.stringify(result.project.referenceReconstructions)).not.toContain("base64");

  useDirectorStore.getState().replaceProject(result.project);
  expect(useDirectorStore.getState().project.objects.some((entry) => entry.id === "reference-object-test-01")).toBe(
    true,
  );
  useDirectorStore.getState().undo();
  expect(useDirectorStore.getState().project.objects.some((entry) => entry.id === "reference-object-test-01")).toBe(
    false,
  );
});

it("rejects a plan after the target project revision changes", () => {
  const changed = createDefaultDirectorProject();
  changed.scene.backgroundColor = "#ffffff";
  expect(() => applyReferenceSceneReconstructionPlan(changed, plan(), "data:image/jpeg;base64,/9j/2Q==")).toThrow(
    ReferenceScenePlanConflictError,
  );
});
