import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import type { DirectorDccEngineId, DirectorDccExchangePackageResult } from "@director/dcc-protocol";
import { createTestDirectorProject } from "../fixtures/createTestDirectorProject";
import {
  createDirectorDccEngineBridge,
  DirectorDccEngineBridgeError,
  DIRECTOR_ENGINE_BINARY_ENV,
  DIRECTOR_ENGINE_PROJECT_ENV,
} from "../../dcc/engineBridge";
import { createDirectorDccProviderRegistry } from "../../dcc/dccProviderRegistry";
import type { BlenderBridge } from "../../dcc/blenderBridge";

/** The real repository root, so tests validate the committed connector sources. */
const repositoryRoot = resolve(__dirname, "..", "..", "..", "..");

const ENGINE_IDS: DirectorDccEngineId[] = ["unreal", "unity", "godot"];

const PROJECT_MARKERS: Record<DirectorDccEngineId, string[]> = {
  unreal: ["Project.uproject"],
  unity: ["ProjectSettings/ProjectVersion.txt"],
  godot: ["project.godot"],
};

const INSTALLED_CONNECTOR_FILES: Record<DirectorDccEngineId, string[]> = {
  unreal: ["Plugins/DirectorBridge/DirectorBridge.uplugin", "Plugins/DirectorBridge/Content/Python/director_headless.py"],
  unity: ["Packages/com.director.bridge/package.json"],
  godot: ["addons/director_bridge/plugin.cfg", "addons/director_bridge/director_headless.gd"],
};

async function temporaryEngineSetup(provider: DirectorDccEngineId, options: { installConnector?: boolean } = {}) {
  const root = await mkdtemp(resolve(tmpdir(), `director-engine-${provider}-`));
  const dataDirectory = resolve(root, "data");
  const executable = resolve(root, "bin", provider);
  await mkdir(dirname(executable), { recursive: true });
  await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const projectDirectory = resolve(root, "project");
  for (const marker of PROJECT_MARKERS[provider]) {
    const markerPath = resolve(projectDirectory, marker);
    await mkdir(dirname(markerPath), { recursive: true });
    await writeFile(markerPath, "fixture", "utf8");
  }
  if (options.installConnector !== false) {
    for (const connectorFile of INSTALLED_CONNECTOR_FILES[provider]) {
      const filePath = resolve(projectDirectory, connectorFile);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, "fixture", "utf8");
    }
  }
  const environment: NodeJS.ProcessEnv = {
    PATH: "",
    [DIRECTOR_ENGINE_BINARY_ENV[provider]]: executable,
    [DIRECTOR_ENGINE_PROJECT_ENV[provider]]:
      provider === "unreal" ? resolve(projectDirectory, "Project.uproject") : projectDirectory,
  };
  return { root, dataDirectory, executable, projectDirectory, environment };
}

function fakeExchangeResult(
  provider: DirectorDccEngineId,
  packageDirectory: string,
  jobId: string,
  sourceRevision: string,
): DirectorDccExchangePackageResult {
  return {
    contract: "director-dcc-exchange-result-v1",
    jobId,
    provider,
    packagePath: packageDirectory,
    manifestPath: resolve(packageDirectory, "manifest.json"),
    manifestSha256: "a".repeat(64),
    packageDigest: "b".repeat(64),
    sourceRevision,
    formats: [],
    assets: [],
    warnings: ["exchange fixture warning"],
  };
}

const REVISION = `director-project-revision:v1:sha256:${"c".repeat(64)}`;

describe("DirectorDccEngineBridge", () => {
  it.each(ENGINE_IDS)("reports %s not ready without an executable, with recovery steps", async (provider) => {
    const root = await mkdtemp(resolve(tmpdir(), "director-engine-empty-"));
    const bridge = createDirectorDccEngineBridge({
      workspaceRoot: repositoryRoot,
      dataDirectory: resolve(root, "data"),
      exchangePackager: { exportPackage: vi.fn() },
      environment: { PATH: "" },
      healthTtlMs: 0,
    });
    const health = await bridge.health(provider);
    expect(health.ready).toBe(false);
    // The committed Director-authored connector source must validate.
    expect(health.checks).toContainEqual(expect.objectContaining({ id: "connector_manifest", ok: true }));
    expect(health.checks).toContainEqual(expect.objectContaining({ id: "connector_entry", ok: true }));
    expect(health.checks).toContainEqual(expect.objectContaining({ id: "executable", ok: false }));
    expect(health.recovery.join("\n")).toMatch(/exchange remains available/i);

    const diagnostics = await bridge.diagnostics(provider);
    expect(diagnostics).toMatchObject({ provider, mode: "exchange", ready: false });
    expect(diagnostics.recovery.length).toBeGreaterThan(0);
  });

  it.each(ENGINE_IDS)(
    "reports %s ready only when connector, executable, version, project, and installed plugin all pass",
    async (provider) => {
      const setup = await temporaryEngineSetup(provider);
      const bridge = createDirectorDccEngineBridge({
        workspaceRoot: repositoryRoot,
        dataDirectory: setup.dataDirectory,
        exchangePackager: { exportPackage: vi.fn() },
        environment: setup.environment,
        probeHostVersion: async () => `${provider} 9.9 fixture`,
        healthTtlMs: 0,
      });
      const health = await bridge.health(provider);
      expect(health.ready).toBe(true);
      expect(health.hostVersion).toBe(`${provider} 9.9 fixture`);
      expect(health.connectorVersion).toBe("0.1.0");
      expect((await bridge.diagnostics(provider)).mode).toBe("native");
    },
  );

  it("never reports ready from an installed executable alone (no installed project connector)", async () => {
    const setup = await temporaryEngineSetup("godot", { installConnector: false });
    const bridge = createDirectorDccEngineBridge({
      workspaceRoot: repositoryRoot,
      dataDirectory: setup.dataDirectory,
      exchangePackager: { exportPackage: vi.fn() },
      environment: setup.environment,
      probeHostVersion: async () => "Godot 4.4 fixture",
      healthTtlMs: 0,
    });
    const health = await bridge.health("godot");
    expect(health.executable).toBe(setup.executable);
    expect(health.ready).toBe(false);
    expect(health.checks).toContainEqual(expect.objectContaining({ id: "project_connector", ok: false }));
  });

  it("rejects send with structured engine_not_ready diagnostics when the connector is unavailable", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "director-engine-notready-"));
    const exportPackage = vi.fn();
    const bridge = createDirectorDccEngineBridge({
      workspaceRoot: repositoryRoot,
      dataDirectory: resolve(root, "data"),
      exchangePackager: { exportPackage },
      environment: { PATH: "" },
      healthTtlMs: 0,
    });
    const failure = await bridge
      .send(createTestDirectorProject(), { provider: "unity" })
      .then(() => null)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DirectorDccEngineBridgeError);
    expect(failure).toMatchObject({
      code: "engine_not_ready",
      status: 409,
      diagnostics: expect.objectContaining({ provider: "unity", ready: false, mode: "exchange" }),
    });
    expect(exportPackage).not.toHaveBeenCalled();
  });

  it.each([
    ["unreal", (args: string[]) => args.some((argument) => argument.includes("director_headless.py"))],
    ["unity", (args: string[]) => args.includes("Director.Bridge.Editor.DirectorBridgeCli.Import")],
    ["godot", (args: string[]) => args.includes("res://addons/director_bridge/director_headless.gd")],
  ] as Array<[DirectorDccEngineId, (args: string[]) => boolean]>)(
    "sends to %s through the fixed connector entry point and validates the report",
    async (provider, matchesFixedEntry) => {
      const setup = await temporaryEngineSetup(provider);
      const jobId = randomUUID();
      const packageDirectory = resolve(setup.dataDirectory, "dcc-jobs", "exchange", provider, jobId);
      await mkdir(packageDirectory, { recursive: true });
      const exportPackage = vi
        .fn()
        .mockResolvedValue(fakeExchangeResult(provider, packageDirectory, jobId, REVISION));
      const observedArguments: string[][] = [];
      const runProcess = vi.fn(async (executable: string, args: string[]) => {
        observedArguments.push(args);
        expect(executable).toBe(setup.executable);
        const reportPath = args
          .flatMap((argument) => argument.split(/\s+/))
          .map((token) => token.replaceAll('"', ""))
          .find((token) => token.endsWith("report.json"));
        expect(reportPath).toBeDefined();
        const jobDirectory = dirname(reportPath!);
        await mkdir(resolve(jobDirectory, "return"), { recursive: true });
        await writeFile(
          reportPath!,
          JSON.stringify({
            ok: true,
            contract: "director-dcc-engine-report-v1",
            provider,
            hostVersion: `${provider} 9.9 fixture`,
            connectorVersion: "0.1.0",
            packageId: jobId,
            sourceRevision: REVISION,
            importedObjectCount: 2,
            importedCameraCount: 1,
            scenePath: "fixture/scene",
            returnPackageDir: "return",
            warnings: ["connector fixture warning"],
          }),
          "utf8",
        );
        return { stdout: "", stderr: "" };
      });
      const bridge = createDirectorDccEngineBridge({
        workspaceRoot: repositoryRoot,
        dataDirectory: setup.dataDirectory,
        exchangePackager: { exportPackage },
        environment: setup.environment,
        probeHostVersion: async () => `${provider} 9.9 fixture`,
        runProcess,
        healthTtlMs: 0,
      });
      const result = await bridge.send(createTestDirectorProject(), { provider, formats: ["glb"] });
      expect(exportPackage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ provider }));
      expect(observedArguments).toHaveLength(1);
      expect(matchesFixedEntry(observedArguments[0]!)).toBe(true);
      expect(result.report.importedObjectCount).toBe(2);
      expect(result.returnPackagePath).toBe(resolve(bridge.jobRoot(provider), jobId, "return"));
      expect(result.warnings).toEqual(expect.arrayContaining(["exchange fixture warning", "connector fixture warning"]));
    },
  );

  it("fails the job when the connector reports ok:false or a mismatched package identity", async () => {
    const setup = await temporaryEngineSetup("godot");
    const jobId = randomUUID();
    const packageDirectory = resolve(setup.dataDirectory, "dcc-jobs", "exchange", "godot", jobId);
    await mkdir(packageDirectory, { recursive: true });
    const exportPackage = vi.fn().mockResolvedValue(fakeExchangeResult("godot", packageDirectory, jobId, REVISION));
    let reportBody: Record<string, unknown> = { ok: false, error: "fixture connector failure" };
    const runProcess = vi.fn(async (_executable: string, args: string[]) => {
      const reportPath = args.find((argument) => argument.endsWith("report.json"))!;
      await mkdir(dirname(reportPath), { recursive: true });
      await writeFile(reportPath, JSON.stringify(reportBody), "utf8");
      return { stdout: "", stderr: "" };
    });
    const bridge = createDirectorDccEngineBridge({
      workspaceRoot: repositoryRoot,
      dataDirectory: setup.dataDirectory,
      exchangePackager: { exportPackage },
      environment: setup.environment,
      probeHostVersion: async () => "Godot 4.4 fixture",
      runProcess,
      healthTtlMs: 0,
    });
    await expect(bridge.send(createTestDirectorProject(), { provider: "godot" })).rejects.toMatchObject({
      code: "engine_job_failed",
      message: expect.stringContaining("fixture connector failure"),
    });

    reportBody = {
      ok: true,
      contract: "director-dcc-engine-report-v1",
      provider: "godot",
      hostVersion: "Godot 4.4 fixture",
      connectorVersion: "0.1.0",
      packageId: randomUUID(),
      sourceRevision: REVISION,
      importedObjectCount: 0,
      importedCameraCount: 0,
      scenePath: null,
      returnPackageDir: null,
      warnings: [],
    };
    await expect(bridge.send(createTestDirectorProject(), { provider: "godot" })).rejects.toMatchObject({
      code: "engine_report_invalid",
      message: expect.stringContaining("does not match the exchange package"),
    });
  });
});

describe("DCC provider registry with the engine bridge", () => {
  const blenderStub = {
    status: vi.fn().mockResolvedValue({ available: false, reason: "fixture" }),
  } as unknown as BlenderBridge;

  it("keeps nativeReady false without connector health and true only when health passes", async () => {
    const notReady = createDirectorDccProviderRegistry({
      blender: blenderStub,
      engines: {
        health: vi.fn().mockResolvedValue({
          contract: "director-dcc-engine-health-v1",
          provider: "unreal",
          ready: false,
          executable: "/opt/ue/UnrealEditor-Cmd",
          hostVersion: "Unreal Engine 5.6",
          connectorVersion: null,
          connectorDirectory: "integrations/unreal",
          projectPath: null,
          checks: [],
          warnings: ["No Unreal Engine project is configured for the Director connector."],
          recovery: ["Set DIRECTOR_UNREAL_PROJECT to the .uproject file that should receive Director scenes."],
        }),
      },
      environment: { PATH: "" },
    });
    const status = await notReady.status("unreal");
    expect(status).toMatchObject({ installed: true, nativeReady: false, exchangeReady: true });
    expect(status?.reason).toMatch(/No Unreal Engine project/i);

    const ready = createDirectorDccProviderRegistry({
      blender: blenderStub,
      engines: {
        health: vi.fn().mockResolvedValue({
          contract: "director-dcc-engine-health-v1",
          provider: "godot",
          ready: true,
          executable: "/usr/bin/godot4",
          hostVersion: "Godot 4.4.1",
          connectorVersion: "0.1.0",
          connectorDirectory: "integrations/godot",
          projectPath: "/projects/film",
          checks: [],
          warnings: [],
          recovery: [],
        }),
      },
      environment: { PATH: "" },
    });
    const godotStatus = await ready.status("godot");
    expect(godotStatus).toMatchObject({ installed: true, nativeReady: true, version: "Godot 4.4.1" });
  });

  it("falls back to exchange-only status when no engine bridge is provided", async () => {
    const registry = createDirectorDccProviderRegistry({ blender: blenderStub, environment: { PATH: "" } });
    const status = await registry.status("unity");
    expect(status).toMatchObject({ nativeReady: false, exchangeReady: true });
  });
});
