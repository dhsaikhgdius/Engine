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
  appliedTextureCount: 2,
  posedCharacterCount: 1,
  omittedLightCount: 1,
  omittedLights: [
    {
      directorId: "light-weird",
      code: "light_type_unknown" as const,
      lightType: "portal",
      reason: 'Light light-weird: unknown light type "portal"; omitted (warn-and-omit code: light_type_unknown).',
    },
  ],
  omittedMaterialCount: 1,
  omittedMaterials: [
    {
      directorId: "prop-hdrp",
      code: "pipeline_unsupported" as const,
      renderPipeline: "hdrp" as const,
      reason:
        "Object prop-hdrp: Director PBR fallback supports URP and Built-in; the active hdrp pipeline uses an unsupported material graph, so the override was omitted (warn-and-omit code: pipeline_unsupported). GLB payload materials still import through the glTF importer.",
    },
  ],
  mappedShotCount: 2,
  omittedShotCount: 1,
  omittedShots: [
    {
      shotId: "shot-unbound",
      code: "shot_no_camera_binding" as const,
      cameraDirectorId: null,
      reason:
        "Shot shot-unbound has no camera binding; no ActivationTrack camera cut was created (warn-and-omit code: shot_no_camera_binding).",
    },
  ],
  omittedChannels: [
    {
      directorId: "hero-1",
      channel: "motionBlocks" as const,
      reason: "Skeletal motion blocks play packaged clip GLBs that are not part of the exchange package.",
    },
  ],
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

  it("keeps pose fields optional so 0.2.x connector reports still validate", () => {
    const {
      posedCharacterCount: _count,
      omittedChannels: _channels,
      omittedLightCount: _omitCount,
      omittedLights: _omitLights,
      omittedMaterialCount: _omitMatCount,
      omittedMaterials: _omitMats,
      mappedShotCount: _mappedShots,
      omittedShotCount: _omitShotCount,
      omittedShots: _omitShots,
      ...legacyDetails
    } = UNITY_DETAILS;
    const parsed = directorDccUnityEngineReportDetailsSchema.parse(legacyDetails);
    expect(parsed.posedCharacterCount).toBeUndefined();
    expect(parsed.omittedChannels).toBeUndefined();
    expect(parsed.omittedLights).toBeUndefined();
    expect(parsed.omittedMaterials).toBeUndefined();
    expect(parsed.mappedShotCount).toBeUndefined();
    expect(parsed.omittedShots).toBeUndefined();
  });

  it("rejects omittedLights whose length disagrees with omittedLightCount", () => {
    expect(
      directorDccUnityEngineReportDetailsSchema.safeParse({
        ...UNITY_DETAILS,
        omittedLightCount: 0,
      }).success,
    ).toBe(false);
    expect(
      directorDccUnityEngineReportDetailsSchema.safeParse({
        ...UNITY_DETAILS,
        omittedLightCount: undefined,
      }).success,
    ).toBe(false);
  });

  it("rejects omittedMaterials whose length disagrees with omittedMaterialCount", () => {
    expect(
      directorDccUnityEngineReportDetailsSchema.safeParse({
        ...UNITY_DETAILS,
        omittedMaterialCount: 0,
      }).success,
    ).toBe(false);
    expect(
      directorDccUnityEngineReportDetailsSchema.safeParse({
        ...UNITY_DETAILS,
        omittedMaterialCount: undefined,
      }).success,
    ).toBe(false);
  });

  it("accepts no_mesh_target and unsupported_channels material omit codes (connector ≥0.3.4)", () => {
    expect(
      directorDccUnityEngineReportDetailsSchema.safeParse({
        ...UNITY_DETAILS,
        omittedMaterialCount: 2,
        omittedMaterials: [
          {
            directorId: "prop-empty",
            code: "no_mesh_target",
            renderPipeline: "urp",
            reason:
              "Object prop-empty: a Director material was authored but the payload has no mesh Renderer to apply it to (warn-and-omit code: no_mesh_target).",
          },
          {
            directorId: "prop-glass",
            code: "unsupported_channels",
            renderPipeline: "built-in",
            reason:
              "Object prop-glass: Director material channels transmission have no faithful URP/Built-in Lit binding; omitted (warn-and-omit code: unsupported_channels).",
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("rejects unknown omitted-material codes and extra omitted-material fields", () => {
    expect(
      directorDccUnityEngineReportDetailsSchema.safeParse({
        ...UNITY_DETAILS,
        omittedMaterials: [
          {
            directorId: "prop-x",
            code: "parent_unavailable",
            renderPipeline: "urp",
            reason: "not a code the Unity material path owns",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      directorDccUnityEngineReportDetailsSchema.safeParse({
        ...UNITY_DETAILS,
        omittedMaterials: [
          {
            directorId: "prop-hdrp",
            code: "pipeline_unsupported",
            renderPipeline: "hdrp",
            reason: "HDRP unsupported",
            severity: "warning",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      directorDccUnityEngineReportDetailsSchema.safeParse({
        ...UNITY_DETAILS,
        omittedMaterials: [
          { directorId: "", code: "no_mesh_target", renderPipeline: "urp", reason: "empty id must fail" },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects omittedShots whose length disagrees with omittedShotCount", () => {
    expect(
      directorDccUnityEngineReportDetailsSchema.safeParse({
        ...UNITY_DETAILS,
        omittedShotCount: 0,
      }).success,
    ).toBe(false);
    expect(
      directorDccUnityEngineReportDetailsSchema.safeParse({
        ...UNITY_DETAILS,
        omittedShotCount: undefined,
      }).success,
    ).toBe(false);
  });

  it("rejects unknown omitted-shot codes and extra omitted-shot fields", () => {
    expect(
      directorDccUnityEngineReportDetailsSchema.safeParse({
        ...UNITY_DETAILS,
        omittedShots: [
          {
            shotId: "shot-1",
            code: "shot_outside_playback",
            cameraDirectorId: "cam-1",
            reason: "not a code the Unity shot mapper owns",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      directorDccUnityEngineReportDetailsSchema.safeParse({
        ...UNITY_DETAILS,
        omittedShots: [
          {
            shotId: "shot-unbound",
            code: "shot_no_camera_binding",
            cameraDirectorId: null,
            reason: "no camera binding",
            severity: "warning",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      directorDccUnityEngineReportDetailsSchema.safeParse({
        ...UNITY_DETAILS,
        omittedShots: [{ shotId: "", code: "shot_no_camera_binding", cameraDirectorId: null, reason: "empty id" }],
      }).success,
    ).toBe(false);
  });

  it("keeps cameraDirectorId nullable only for missing bindings and requires a nonnegative mapped count", () => {
    expect(
      directorDccUnityEngineReportDetailsSchema.safeParse({
        ...UNITY_DETAILS,
        omittedShots: [
          {
            shotId: "shot-ghost",
            code: "shot_camera_not_imported",
            cameraDirectorId: "cam-ghost",
            reason:
              "Shot shot-ghost references camera cam-ghost which was not imported; its cut was skipped (warn-and-omit code: shot_camera_not_imported).",
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      directorDccUnityEngineReportDetailsSchema.safeParse({
        ...UNITY_DETAILS,
        mappedShotCount: -1,
      }).success,
    ).toBe(false);
    expect(
      directorDccUnityEngineReportDetailsSchema.safeParse({
        ...UNITY_DETAILS,
        mappedShotCount: 1.5,
      }).success,
    ).toBe(false);
  });

  it("rejects unknown omitted-channel ids and unknown omission fields", () => {
    expect(
      directorDccUnityEngineReportDetailsSchema.safeParse({
        ...UNITY_DETAILS,
        omittedChannels: [{ directorId: "hero-1", channel: "physics", reason: "not a channel this connector owns" }],
      }).success,
    ).toBe(false);
    expect(
      directorDccUnityEngineReportDetailsSchema.safeParse({
        ...UNITY_DETAILS,
        omittedChannels: [
          { directorId: "hero-1", channel: "poseValues", reason: "non-mixamo rig", severity: "warning" },
        ],
      }).success,
    ).toBe(false);
    expect(
      directorDccUnityEngineReportDetailsSchema.safeParse({
        ...UNITY_DETAILS,
        omittedChannels: [{ directorId: "", channel: "ik", reason: "empty director id must fail" }],
      }).success,
    ).toBe(false);
  });
});
