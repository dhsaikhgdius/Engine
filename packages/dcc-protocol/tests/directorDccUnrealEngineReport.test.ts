import { describe, expect, it } from "vitest";
import {
  directorDccEngineReportSchema,
  directorUnrealOmittedMaterialSchema,
} from "../src/directorDccEngineContract";

const REVISION = `director-project-revision:v1:sha256:${"d".repeat(64)}`;

function unrealReport(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    contract: "director-dcc-engine-report-v1",
    provider: "unreal",
    hostVersion: "UE 5.4.4-release",
    connectorVersion: "0.4.4",
    packageId: "7a1c2e3b-4d5f-6789-abcd-ef0123456789",
    sourceRevision: REVISION,
    importedObjectCount: 2,
    importedCameraCount: 1,
    scenePath: "/Game/Director/Maps/Director_7a1c2e3b",
    returnPackageDir: "return",
    warnings: [],
    ...overrides,
  };
}

describe("Director Unreal engine report omittedMaterials honesty", () => {
  it("accepts texture_import_failed alongside the legacy material omit codes", () => {
    const omittedMaterials = [
      {
        directorId: "prop-glass",
        code: "unsupported_channels" as const,
        reason:
          "Object prop-glass: Director material channels transmission have no faithful Director parent mapping; omitted (warn-and-omit code: unsupported_channels).",
      },
      {
        directorId: "prop-crate",
        code: "texture_import_failed" as const,
        reason:
          "Object prop-crate: bundled texture parameter(s) BaseColorMap failed to import into Unreal; the MaterialInstance stays unbound for those slots (warn-and-omit code: texture_import_failed).",
      },
      {
        directorId: "prop-empty",
        code: "no_mesh_target" as const,
        reason:
          "Object prop-empty has a Director material but no mesh component; the material was not applied (warn-and-omit code: no_mesh_target).",
      },
    ];
    const parsed = directorDccEngineReportSchema.parse(
      unrealReport({
        appliedMaterialCount: 1,
        appliedTextureCount: 0,
        omittedMaterialCount: 3,
        omittedMaterials,
      }),
    );
    expect(parsed.omittedMaterialCount).toBe(3);
    expect(parsed.omittedMaterials).toEqual(omittedMaterials);
  });

  it("keeps omittedMaterials optional so connectors before 0.4.1 still validate", () => {
    const parsed = directorDccEngineReportSchema.parse(unrealReport());
    expect(parsed.omittedMaterials).toBeUndefined();
    expect(parsed.omittedMaterialCount).toBeUndefined();
  });

  it("rejects omittedMaterials whose length disagrees with omittedMaterialCount", () => {
    const entry = {
      directorId: "prop-crate",
      code: "texture_import_failed" as const,
      reason:
        "Object prop-crate: bundled texture parameter(s) BaseColorMap failed to import into Unreal; the MaterialInstance stays unbound for those slots (warn-and-omit code: texture_import_failed).",
    };
    expect(
      directorDccEngineReportSchema.safeParse(
        unrealReport({ omittedMaterialCount: 0, omittedMaterials: [entry] }),
      ).success,
    ).toBe(false);
    expect(
      directorDccEngineReportSchema.safeParse(unrealReport({ omittedMaterials: [entry] })).success,
    ).toBe(false);
  });

  it("rejects unknown omitted-material codes and extra omitted-material fields", () => {
    expect(
      directorUnrealOmittedMaterialSchema.safeParse({
        directorId: "prop-x",
        code: "shader_graph_missing",
        reason: "not an Unreal material omit code",
      }).success,
    ).toBe(false);
    expect(
      directorUnrealOmittedMaterialSchema.safeParse({
        directorId: "prop-crate",
        code: "texture_import_failed",
        reason:
          "Object prop-crate: bundled texture parameter(s) BaseColorMap failed to import into Unreal; the MaterialInstance stays unbound for those slots (warn-and-omit code: texture_import_failed).",
        severity: "warning",
      }).success,
    ).toBe(false);
    expect(
      directorDccEngineReportSchema.safeParse(
        unrealReport({
          omittedMaterialCount: 1,
          omittedMaterials: [
            {
              directorId: "prop-x",
              code: "shader_graph_missing",
              reason: "not an Unreal material omit code",
            },
          ],
        }),
      ).success,
    ).toBe(false);
  });
});
