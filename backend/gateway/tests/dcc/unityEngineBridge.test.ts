import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import type { DirectorDccExchangePackageResult } from "@director/dcc-protocol";
import {
  createDirectorDccEngineBridge,
  DIRECTOR_ENGINE_BINARY_ENV,
  DIRECTOR_ENGINE_PROJECT_ENV,
} from "../../dcc/engineBridge";
import { createTestDirectorProject } from "../fixtures/createTestDirectorProject";

/** The real repository root, so tests validate the committed connector sources. */
const repositoryRoot = resolve(__dirname, "..", "..", "..", "..");

const CONNECTOR_VERSION = (
  JSON.parse(readFileSync(resolve(repositoryRoot, "integrations", "unity", "connector.json"), "utf8")) as {
    version: string;
  }
).version;

const REVISION = `director-project-revision:v1:sha256:${"e".repeat(64)}`;

async function unitySetup() {
  const root = await mkdtemp(resolve(tmpdir(), "director-unity-bridge-"));
  const dataDirectory = resolve(root, "data");
  const executable = resolve(root, "bin", "Unity");
  await mkdir(dirname(executable), { recursive: true });
  await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const projectDirectory = resolve(root, "project");
  await mkdir(resolve(projectDirectory, "ProjectSettings"), { recursive: true });
  await writeFile(
    resolve(projectDirectory, "ProjectSettings", "ProjectVersion.txt"),
    "m_EditorVersion: 2022.3.62f1\n",
    "utf8",
  );
  await mkdir(resolve(projectDirectory, "Packages", "com.director.bridge"), { recursive: true });
  await writeFile(
    resolve(projectDirectory, "Packages", "com.director.bridge", "package.json"),
    JSON.stringify({ name: "com.director.bridge", version: CONNECTOR_VERSION }),
    "utf8",
  );
  const environment: NodeJS.ProcessEnv = {
    PATH: "",
    [DIRECTOR_ENGINE_BINARY_ENV.unity]: executable,
    [DIRECTOR_ENGINE_PROJECT_ENV.unity]: projectDirectory,
  };
  return { root, dataDirectory, executable, projectDirectory, environment };
}

async function createUnitySendHarness(unityExtras: Record<string, unknown> = {}) {
  const setup = await unitySetup();
  const jobId = randomUUID();
  const packageDirectory = resolve(setup.dataDirectory, "dcc-jobs", "exchange", "unity", jobId);
  await mkdir(packageDirectory, { recursive: true });
  const exchangeResult: DirectorDccExchangePackageResult = {
    contract: "director-dcc-exchange-result-v1",
    jobId,
    provider: "unity",
    packagePath: packageDirectory,
    manifestPath: resolve(packageDirectory, "manifest.json"),
    manifestSha256: "a".repeat(64),
    packageDigest: "b".repeat(64),
    sourceRevision: REVISION,
    formats: [],
    assets: [],
    warnings: [],
  };
  const runProcess = vi.fn(async (_executable: string, args: string[]) => {
    const reportPath = args[args.indexOf("-directorReport") + 1]!;
    await mkdir(resolve(dirname(reportPath), "return"), { recursive: true });
    await writeFile(
      reportPath,
      JSON.stringify({
        ok: true,
        contract: "director-dcc-engine-report-v1",
        provider: "unity",
        hostVersion: "Unity 2022.3.62f1",
        connectorVersion: CONNECTOR_VERSION,
        packageId: jobId,
        sourceRevision: REVISION,
        importedObjectCount: 1,
        importedCameraCount: 0,
        scenePath: "Assets/Director/Scenes/Director_fixture.unity",
        returnPackageDir: "return",
        warnings: [],
        unity: {
          timelinePath: null,
          renderPipeline: "urp",
          gltfImporterAvailable: true,
          importedLightCount: 0,
          bakedAnimationClipCount: 0,
          humanoidAvatarCount: 0,
          genericAvatarCount: 0,
          materialFallbackCount: 0,
          appliedTextureCount: 0,
          ...unityExtras,
        },
      }),
      "utf8",
    );
    return { stdout: "", stderr: "" };
  });
  const bridge = createDirectorDccEngineBridge({
    workspaceRoot: repositoryRoot,
    dataDirectory: setup.dataDirectory,
    exchangePackager: { exportPackage: vi.fn().mockResolvedValue(exchangeResult) },
    environment: setup.environment,
    probeHostVersion: async () => "Unity 2022.3.62f1",
    runProcess,
    healthTtlMs: 0,
  });
  return { bridge };
}

describe("engine bridge Unity omittedMaterials honesty", () => {
  it("returns typed omittedMaterials (no_mesh_target / unsupported_channels) on the Unity send receipt", async () => {
    const { bridge } = await createUnitySendHarness({
      materialFallbackCount: 1,
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
          renderPipeline: "urp",
          reason:
            "Object prop-glass: Director material channels transmission, clearcoat have no faithful URP/Built-in Lit binding; omitted (warn-and-omit code: unsupported_channels).",
        },
      ],
    });
    const result = await bridge.send(createTestDirectorProject(), { provider: "unity" });
    expect(result.report.unity?.materialFallbackCount).toBe(1);
    expect(result.report.unity?.omittedMaterialCount).toBe(2);
    expect(result.report.unity?.omittedMaterials).toEqual([
      expect.objectContaining({ directorId: "prop-empty", code: "no_mesh_target", renderPipeline: "urp" }),
      expect.objectContaining({ directorId: "prop-glass", code: "unsupported_channels", renderPipeline: "urp" }),
    ]);
  });

  it("fails the job when omittedMaterials length disagrees with omittedMaterialCount", async () => {
    const { bridge } = await createUnitySendHarness({
      omittedMaterialCount: 0,
      omittedMaterials: [
        {
          directorId: "prop-x",
          code: "no_mesh_target",
          renderPipeline: "urp",
          reason:
            "Object prop-x: a Director material was authored but the payload has no mesh Renderer to apply it to (warn-and-omit code: no_mesh_target).",
        },
      ],
    });
    await expect(bridge.send(createTestDirectorProject(), { provider: "unity" })).rejects.toMatchObject({
      code: "engine_report_invalid",
    });
  });

  it("fails the job when the connector reports a malformed omitted-material record", async () => {
    const { bridge } = await createUnitySendHarness({
      omittedMaterialCount: 1,
      omittedMaterials: [
        {
          directorId: "prop-x",
          code: "parent_unavailable",
          renderPipeline: "urp",
          reason: "Object prop-x: not a Unity material omit code.",
        },
      ],
    });
    await expect(bridge.send(createTestDirectorProject(), { provider: "unity" })).rejects.toMatchObject({
      code: "engine_report_invalid",
    });
  });
});
