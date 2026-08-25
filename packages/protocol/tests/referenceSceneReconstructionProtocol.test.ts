import { describe, expect, it } from "vitest";
import {
  DIRECTOR_REFERENCE_SCENE_MAX_OBJECTS,
  referenceSceneAnalysisRequestSchema,
  referenceSceneReconstructionPlanSchema,
  referenceSceneVisionOutputSchema,
} from "../src/referenceSceneReconstructionProtocol";

const metrics = {
  width: 1280,
  height: 720,
  palette: ["#102030", "#d0b080"],
  meanLuminance: 0.42,
  edgeDensity: 0.18,
  foregroundCoverage: 0.54,
};

const visionObject = {
  name: "Foreground plinth",
  geometryType: "box" as const,
  position: [0, 0.5, 0] as [number, number, number],
  rotationDegrees: [0, 20, 0] as [number, number, number],
  scale: [2, 1, 1] as [number, number, number],
  grounded: true,
  material: {
    baseColor: "#d0b080",
    metalness: 0.1,
    roughness: 0.65,
    emissiveColor: "#000000",
    emissiveIntensity: 0,
    opacity: 1,
  },
  confidence: 0.8,
  rationale: "Large rectangular silhouette in the lower half.",
};

it("bounds uploaded reference images and project revision intent", () => {
  expect(
    referenceSceneAnalysisRequestSchema.parse({
      version: 1,
      projectRevision: `director-project-revision:v1:sha256:${"a".repeat(64)}`,
      prompt: "Rebuild the visible blocking.",
      applyMode: "append",
      analysisMode: "auto",
      profileId: null,
      maxObjects: 8,
      image: {
        fileName: "reference.jpg",
        mimeType: "image/jpeg",
        base64: "aW1hZ2UtYnl0ZXM=",
        sha256: "b".repeat(64),
        metrics,
      },
    }),
  ).toMatchObject({ maxObjects: 8, image: { metrics } });

  expect(
    referenceSceneAnalysisRequestSchema.safeParse({
      version: 1,
      projectRevision: "revision",
      prompt: "",
      applyMode: "append",
      analysisMode: "vision",
      profileId: null,
      maxObjects: 99,
      image: {
        fileName: "bad.svg",
        mimeType: "image/svg+xml",
        base64: "PHN2Zz48L3N2Zz4=",
        sha256: "b".repeat(64),
        metrics,
      },
    }).success,
  ).toBe(false);
});

describe("referenceSceneVisionOutputSchema", () => {
  it("accepts only the bounded primitive and lighting vocabulary", () => {
    const parsed = referenceSceneVisionOutputSchema.parse({
      summary: "A warm plinth against a dark wall.",
      confidence: 0.78,
      backgroundColor: "#102030",
      objects: [visionObject],
      lights: [
        {
          name: "Soft key",
          type: "rect-area",
          color: "#fff1dc",
          intensity: 4,
          position: [3, 5, 4],
          target: [0, 0.5, 0],
          castShadow: false,
          rationale: "Broad highlight on camera left.",
        },
      ],
      warnings: ["Depth is inferred from one view."],
    });
    expect(parsed.objects[0]?.geometryType).toBe("box");

    const tooMany = Array.from({ length: DIRECTOR_REFERENCE_SCENE_MAX_OBJECTS + 1 }, () => visionObject);
    expect(referenceSceneVisionOutputSchema.safeParse({ ...parsed, objects: tooMany }).success).toBe(false);
    expect(
      referenceSceneVisionOutputSchema.safeParse({
        ...parsed,
        objects: [{ ...visionObject, geometryType: "plane" }],
      }).success,
    ).toBe(false);
  });
});

it("stores an applied plan without storing image bytes", () => {
  const plan = referenceSceneReconstructionPlanSchema.parse({
    version: 1,
    id: "reference-plan-1",
    status: "applied",
    createdAt: "2026-08-07T00:00:00.000Z",
    expectedProjectRevision: `director-project-revision:v1:sha256:${"a".repeat(64)}`,
    prompt: "Rebuild the visible blocking.",
    applyMode: "append",
    source: { fileName: "reference.jpg", mimeType: "image/jpeg", sha256: "b".repeat(64), metrics },
    analysis: {
      status: "ready",
      mode: "vision",
      profileId: "vision-primary",
      model: "vision-model",
      summary: "A warm plinth against a dark wall.",
      confidence: 0.78,
      warnings: ["Depth is inferred from one view."],
      usage: { inputTokens: 300, outputTokens: 80, totalTokens: 380 },
    },
    backgroundColor: "#102030",
    objects: [
      {
        id: "reference-object-1",
        enabled: true,
        name: visionObject.name,
        geometryType: visionObject.geometryType,
        transform: { position: visionObject.position, rotation: [0, 0.349, 0], scale: visionObject.scale },
        placementMode: "grounded",
        material: visionObject.material,
        confidence: visionObject.confidence,
        rationale: visionObject.rationale,
      },
    ],
    lights: [],
    application: {
      appliedAt: "2026-08-07T00:01:00.000Z",
      sourceAssetId: "reference-image-bbbbbbbbbbbb",
      objectIds: ["reference-object-1"],
      lightIds: [],
    },
  });

  expect(JSON.stringify(plan)).not.toContain("base64");
  expect(plan.application?.sourceAssetId).toBe("reference-image-bbbbbbbbbbbb");
});
