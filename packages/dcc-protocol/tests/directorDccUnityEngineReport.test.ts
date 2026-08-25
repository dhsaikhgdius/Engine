import { describe, expect, it } from "vitest";
import {
  directorDccEngineReportSchema,
  directorDccUnityEngineReportDetailsSchema,
} from "../src/directorDccEngineContract";

const REVISION = `director-project-revision:v1:sha256:${"c".repeat(64)}`;

const UNITY_DETAILS = {
  timelinePath: "Assets/Director/Timelines/Director_abc123.playable",
  renderPipeline: "urp" as const,
  gltfImporterAvailable: true,
  importedLightCount: 3,
  bakedAnimationClipCount: 2,
  humanoidAvatarCount: 1,
  genericAvatarCount: 0,
  materialFallbackCount: 4,
};

function unityReport(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    contract: "director-dcc-engine-report-v1",
    provider: "unity",
    hostVersion: "Unity 2022.3.62f1",
    connectorVersion: "0.2.0",
    packageId: "5f0f7f9a-6f34-4bb4-a2f2-3f4b62f1a111",
    sourceRevision: REVISION,
    importedObjectCount: 2,
    importedCameraCount: 1,
    scenePath: "Assets/Director/Scenes/Director_5f0f7f9a.unity",
    returnPackageDir: "return",
    warnings: [],
    ...overrides,
  };
}

describe("Director Unity engine report details", () => {
  it("accepts a unity report with the full details block", () => {
    const parsed = directorDccEngineReportSchema.parse(unityReport({ unity: UNITY_DETAILS }));
    expect(parsed.unity).toEqual(UNITY_DETAILS);
  });

  it("keeps the details block optional so reports from older connector versions still validate", () => {
    const parsed = directorDccEngineReportSchema.parse(unityReport());
    expect(parsed.unity).toBeUndefined();
  });

  it("rejects the unity details block on non-unity reports", () => {
    const result = directorDccEngineReportSchema.safeParse(unityReport({ provider: "godot", unity: UNITY_DETAILS }));
    expect(result.success).toBe(false);
    expect(result.success ? [] : result.error.issues.map((issue) => issue.path.join("."))).toContain("unity");
  });

  it("rejects unknown fields, unknown pipelines, and negative counts inside the details block", () => {
    expect(directorDccUnityEngineReportDetailsSchema.safeParse({ ...UNITY_DETAILS, arbitrary: true }).success).toBe(
      false,
    );
    expect(
      directorDccUnityEngineReportDetailsSchema.safeParse({ ...UNITY_DETAILS, renderPipeline: "vulkan" }).success,
    ).toBe(false);
    expect(
      directorDccUnityEngineReportDetailsSchema.safeParse({ ...UNITY_DETAILS, importedLightCount: -1 }).success,
    ).toBe(false);
    expect(
      directorDccUnityEngineReportDetailsSchema.safeParse({ ...UNITY_DETAILS, bakedAnimationClipCount: 1.5 }).success,
    ).toBe(false);
  });

  it("keeps timelinePath nullable for runs without shots or animation", () => {
    const parsed = directorDccUnityEngineReportDetailsSchema.parse({ ...UNITY_DETAILS, timelinePath: null });
    expect(parsed.timelinePath).toBeNull();
  });
});
