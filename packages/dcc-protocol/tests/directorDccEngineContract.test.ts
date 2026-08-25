import { describe, expect, it } from "vitest";
import {
  DIRECTOR_DCC_CONNECTOR_MANIFEST_CONTRACT,
  DIRECTOR_DCC_ENGINE_HEALTH_CONTRACT,
  DIRECTOR_DCC_ENGINE_REPORT_CONTRACT,
  DIRECTOR_DCC_ENGINE_SEND_CONTRACT,
  directorDccConnectorManifestSchema,
  directorDccEngineDiagnosticsSchema,
  directorDccEngineHealthSchema,
  directorDccEngineReportSchema,
  directorDccEngineSendResultSchema,
} from "../src/directorDccEngineContract";

const REVISION = `director-project-revision:v1:sha256:${"a".repeat(64)}`;

function connectorManifest() {
  return {
    contract: DIRECTOR_DCC_CONNECTOR_MANIFEST_CONTRACT,
    provider: "godot" as const,
    version: "0.1.0",
    entryPoints: {
      health: "addons/director_bridge/director_headless.gd",
      import: "addons/director_bridge/director_headless.gd",
      export: "addons/director_bridge/director_headless.gd",
    },
    hostRequirement: "Godot 4.2+",
  };
}

function engineReport() {
  return {
    ok: true as const,
    contract: DIRECTOR_DCC_ENGINE_REPORT_CONTRACT,
    provider: "unity" as const,
    hostVersion: "6000.0.32f1",
    connectorVersion: "0.1.0",
    packageId: "5f6b0f1e-8a4e-4f57-9d2b-0f30a1b2c3d4",
    sourceRevision: REVISION,
    importedObjectCount: 12,
    importedCameraCount: 2,
    scenePath: "Assets/Director/DirectorScene.unity",
    returnPackageDir: "return",
    warnings: [],
  };
}

describe("Director DCC engine contract", () => {
  it("validates connector manifests and rejects unsafe entry points", () => {
    const manifest = connectorManifest();
    expect(directorDccConnectorManifestSchema.parse(manifest)).toEqual(manifest);

    expect(
      directorDccConnectorManifestSchema.safeParse({
        ...manifest,
        entryPoints: { ...manifest.entryPoints, import: "/etc/passwd" },
      }).success,
    ).toBe(false);
    expect(
      directorDccConnectorManifestSchema.safeParse({
        ...manifest,
        entryPoints: { ...manifest.entryPoints, import: "../outside.gd" },
      }).success,
    ).toBe(false);
    expect(directorDccConnectorManifestSchema.safeParse({ ...manifest, provider: "blender" }).success).toBe(false);
    expect(directorDccConnectorManifestSchema.safeParse({ ...manifest, command: ["sh"] }).success).toBe(false);
  });

  it("validates engine run reports and refuses ok:false payloads", () => {
    const report = engineReport();
    expect(directorDccEngineReportSchema.parse(report)).toEqual(report);
    expect(directorDccEngineReportSchema.safeParse({ ...report, ok: false }).success).toBe(false);
    expect(directorDccEngineReportSchema.safeParse({ ...report, returnPackageDir: "../escape" }).success).toBe(false);
    expect(directorDccEngineReportSchema.safeParse({ ...report, importedObjectCount: -1 }).success).toBe(false);
  });

  it("validates health results with per-check detail and recovery guidance", () => {
    const health = {
      contract: DIRECTOR_DCC_ENGINE_HEALTH_CONTRACT,
      provider: "unreal" as const,
      ready: false,
      executable: null,
      hostVersion: null,
      connectorVersion: "0.1.0",
      connectorDirectory: "integrations/unreal",
      projectPath: null,
      checks: [
        { id: "executable" as const, ok: false, detail: "UnrealEditor-Cmd was not found." },
        { id: "connector_manifest" as const, ok: true, detail: "connector.json 0.1.0" },
      ],
      warnings: ["Unreal Engine executable was not detected."],
      recovery: ["Set DIRECTOR_UNREAL_EDITOR_BIN to the UnrealEditor-Cmd binary."],
    };
    expect(directorDccEngineHealthSchema.parse(health)).toEqual(health);
    expect(
      directorDccEngineHealthSchema.safeParse({
        ...health,
        checks: [{ id: "made_up_check", ok: true, detail: "" }],
      }).success,
    ).toBe(false);
  });

  it("validates structured not-ready diagnostics", () => {
    const diagnostics = {
      provider: "godot" as const,
      mode: "native" as const,
      ready: false,
      warnings: ["Godot executable was not detected."],
      recovery: ["Set DIRECTOR_GODOT_BIN.", "Retry as GLB exchange."],
    };
    expect(directorDccEngineDiagnosticsSchema.parse(diagnostics)).toEqual(diagnostics);
    expect(directorDccEngineDiagnosticsSchema.safeParse({ ...diagnostics, mode: "live" }).success).toBe(false);
  });

  it("validates the headless send result including the embedded host report", () => {
    const result = {
      contract: DIRECTOR_DCC_ENGINE_SEND_CONTRACT,
      jobId: "5f6b0f1e-8a4e-4f57-9d2b-0f30a1b2c3d4",
      provider: "unity" as const,
      packagePath: "/data/dcc-jobs/exchange/unity/job",
      manifestPath: "/data/dcc-jobs/exchange/unity/job/manifest.json",
      manifestSha256: "b".repeat(64),
      packageDigest: "c".repeat(64),
      sourceRevision: REVISION,
      reportPath: "/data/dcc-jobs/unity/job/report.json",
      report: engineReport(),
      returnPackagePath: "/data/dcc-jobs/unity/job/return",
      warnings: [],
    };
    expect(directorDccEngineSendResultSchema.parse(result)).toEqual(result);
    expect(
      directorDccEngineSendResultSchema.safeParse({ ...result, report: { ...engineReport(), ok: false } }).success,
    ).toBe(false);
  });
});
