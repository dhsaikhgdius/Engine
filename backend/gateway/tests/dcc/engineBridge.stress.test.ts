// @vitest-environment node

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DIRECTOR_DCC_PROVIDERS,
  getDirectorDccProviderDescriptor,
  type DirectorDccEngineId,
  type DirectorDccExchangePackageResult,
} from "@director/dcc-protocol";
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

const REVISION = `director-project-revision:v1:sha256:${"c".repeat(64)}`;

const PROJECT_MARKERS: Record<DirectorDccEngineId, string[]> = {
  unreal: ["Project.uproject"],
  unity: ["ProjectSettings/ProjectVersion.txt"],
  godot: ["project.godot"],
};

const GODOT_PROJECT_FIXTURE = [
  "config_version=5",
  "",
  "[editor_plugins]",
  "",
  'enabled=PackedStringArray("res://addons/director_bridge/plugin.cfg")',
  "",
].join("\n");

const INSTALLED_CONNECTOR_FILES: Record<DirectorDccEngineId, string[]> = {
  unreal: [
    "Plugins/DirectorBridge/DirectorBridge.uplugin",
    "Plugins/DirectorBridge/Content/Python/director_headless.py",
  ],
  unity: ["Packages/com.director.bridge/package.json"],
  godot: ["addons/director_bridge/plugin.cfg", "addons/director_bridge/director_headless.gd"],
};

async function temporaryEngineSetup(provider: DirectorDccEngineId) {
  const root = await mkdtemp(resolve(tmpdir(), `director-engine-stress-${provider}-`));
  const dataDirectory = resolve(root, "data");
  const executable = resolve(root, "bin", provider);
  await mkdir(dirname(executable), { recursive: true });
  await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const projectDirectory = resolve(root, "project");
  for (const marker of PROJECT_MARKERS[provider]) {
    const markerPath = resolve(projectDirectory, marker);
    await mkdir(dirname(markerPath), { recursive: true });
    await writeFile(markerPath, marker === "project.godot" ? GODOT_PROJECT_FIXTURE : "fixture", "utf8");
  }
  for (const connectorFile of INSTALLED_CONNECTOR_FILES[provider]) {
    const filePath = resolve(projectDirectory, connectorFile);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, "fixture", "utf8");
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
): DirectorDccExchangePackageResult {
  return {
    contract: "director-dcc-exchange-result-v1",
    jobId,
    provider,
    packagePath: packageDirectory,
    manifestPath: resolve(packageDirectory, "manifest.json"),
    manifestSha256: "a".repeat(64),
    packageDigest: "b".repeat(64),
    sourceRevision: REVISION,
    formats: [],
    assets: [],
    warnings: [],
  };
}

function validReport(provider: DirectorDccEngineId, jobId: string): Record<string, unknown> {
  return {
    ok: true,
    contract: "director-dcc-engine-report-v1",
    provider,
    hostVersion: `${provider} 9.9 fixture`,
    connectorVersion: "0.1.0",
    packageId: jobId,
    sourceRevision: REVISION,
    importedObjectCount: 1,
    importedCameraCount: 0,
    scenePath: "fixture/scene",
    returnPackageDir: null,
    warnings: [],
  };
}

/** Run one send whose connector writes a mutated report, and return the failure (or result). */
async function sendWithReport(
  provider: DirectorDccEngineId,
  mutateReport: (report: Record<string, unknown>, jobId: string) => Record<string, unknown> | string | null,
): Promise<unknown> {
  const setup = await temporaryEngineSetup(provider);
  const jobId = randomUUID();
  const packageDirectory = resolve(setup.dataDirectory, "dcc-jobs", "exchange", provider, jobId);
  await mkdir(packageDirectory, { recursive: true });
  const exportPackage = vi.fn().mockResolvedValue(fakeExchangeResult(provider, packageDirectory, jobId));
  const runProcess = vi.fn(async (_executable: string, args: string[]) => {
    const reportPath = args
      .flatMap((argument) => argument.split(/\s+/))
      .map((token) => token.replaceAll('"', ""))
      .find((token) => token.endsWith("report.json"))!;
    await mkdir(dirname(reportPath), { recursive: true });
    const mutated = mutateReport(validReport(provider, jobId), jobId);
    if (mutated !== null) {
      await writeFile(reportPath, typeof mutated === "string" ? mutated : JSON.stringify(mutated), "utf8");
    }
    return { stdout: "", stderr: "" };
  });
  const bridge = createDirectorDccEngineBridge({
    workspaceRoot: repositoryRoot,
    dataDirectory: setup.dataDirectory,
    exchangePackager: { exportPackage },
    environment: setup.environment,
    probeHostVersion: async () => `${provider} 9.9 fixture`,
    // Godot readiness additionally gates on a live connector health probe; the
    // report-integrity scenarios stub it so every engine reaches the job stage.
    probeConnectorHealth: async () => ({ ok: true, detail: "stress fixture", health: null }),
    runProcess,
    healthTtlMs: 0,
  });
  return bridge
    .send(createTestDirectorProject(), { provider })
    .catch((error: unknown) => error);
}

describe("engine bridge stress: connector report integrity across all engines", () => {
  it.each(ENGINE_IDS)("%s: rejects a report with a wrong packageId", async (provider) => {
    const failure = await sendWithReport(provider, (report) => ({ ...report, packageId: randomUUID() }));
    expect(failure).toBeInstanceOf(DirectorDccEngineBridgeError);
    expect(failure).toMatchObject({ code: "engine_report_invalid", status: 502 });
  });

  it.each(ENGINE_IDS)("%s: rejects a report with a wrong sourceRevision", async (provider) => {
    const failure = await sendWithReport(provider, (report) => ({
      ...report,
      sourceRevision: `director-project-revision:v1:sha256:${"d".repeat(64)}`,
    }));
    expect(failure).toMatchObject({ code: "engine_report_invalid", status: 502 });
  });

  it.each(ENGINE_IDS)("%s: rejects a report claiming another provider", async (provider) => {
    const failure = await sendWithReport(provider, (report) => ({
      ...report,
      provider: provider === "unity" ? "godot" : "unity",
    }));
    expect(failure).toMatchObject({ code: "engine_report_invalid", status: 502 });
  });

  it.each(ENGINE_IDS)("%s: rejects missing, unreadable, and unknown-field reports", async (provider) => {
    expect(await sendWithReport(provider, () => null)).toMatchObject({
      code: "engine_report_invalid",
      status: 502,
    });
    expect(await sendWithReport(provider, () => "{ not json")).toMatchObject({
      code: "engine_report_invalid",
      status: 502,
    });
    expect(await sendWithReport(provider, (report) => ({ ...report, smuggledField: true }))).toMatchObject({
      code: "engine_report_invalid",
      status: 502,
    });
  });

  it.each(ENGINE_IDS)("%s: surfaces connector ok:false failures as engine_job_failed", async (provider) => {
    const failure = await sendWithReport(provider, () => ({ ok: false, error: "stress fixture failure" }));
    expect(failure).toMatchObject({
      code: "engine_job_failed",
      status: 502,
      message: expect.stringContaining("stress fixture failure"),
    });
  });

  it("rejects NaN/Infinity counts and cross-provider detail blocks in reports", async () => {
    expect(
      await sendWithReport("unity", (report) => ({ ...report, importedObjectCount: Number.NaN })),
    ).toMatchObject({ code: "engine_report_invalid" });
    // A godot report may not carry the unity details block, and vice versa.
    expect(
      await sendWithReport("godot", (report) => ({
        ...report,
        unity: {
          timelinePath: null,
          renderPipeline: "urp",
          gltfImporterAvailable: true,
          importedLightCount: 0,
          bakedAnimationClipCount: 0,
          humanoidAvatarCount: 0,
          genericAvatarCount: 0,
          materialFallbackCount: 0,
        },
      })),
    ).toMatchObject({ code: "engine_report_invalid" });
    // JSON smuggling 1e999 becomes Infinity and must fail the finite schema.
    expect(
      await sendWithReport("unity", (report) =>
        JSON.stringify({ ...report, importedObjectCount: 0 }).replace(
          '"importedObjectCount":0',
          '"importedObjectCount":1e999',
        ),
      ),
    ).toMatchObject({ code: "engine_report_invalid" });
  });

  it("rejects a returnPackageDir that is not a safe relative path", async () => {
    for (const hostile of ["../outside", "/etc", "a\\b", "return/../.."]) {
      expect(await sendWithReport("unity", (report) => ({ ...report, returnPackageDir: hostile }))).toMatchObject({
        code: "engine_report_invalid",
        status: 502,
      });
    }
  });
});

describe("engine bridge stress: provider validation and job isolation", () => {
  it("rejects invalid engine ids with engine_provider_invalid on health, send, and jobRoot", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "director-engine-stress-invalid-"));
    const bridge = createDirectorDccEngineBridge({
      workspaceRoot: repositoryRoot,
      dataDirectory: resolve(root, "data"),
      exchangePackager: { exportPackage: vi.fn() },
      environment: { PATH: "" },
      healthTtlMs: 0,
    });
    for (const provider of ["blender", "maya", "", "../evil", "UNREAL"]) {
      await expect(bridge.health(provider as DirectorDccEngineId)).rejects.toMatchObject({
        name: "DirectorDccEngineBridgeError",
        code: "engine_provider_invalid",
        status: 400,
      });
      await expect(
        bridge.send(createTestDirectorProject(), { provider: provider as DirectorDccEngineId }),
      ).rejects.toMatchObject({ code: "engine_provider_invalid", status: 400 });
      expect(() => bridge.jobRoot(provider as DirectorDccEngineId)).toThrow(DirectorDccEngineBridgeError);
    }
  });

  it("caches health per provider and TTL, and re-probes after expiry", async () => {
    const setup = await temporaryEngineSetup("unity");
    let clock = 1_000;
    const probeHostVersion = vi.fn(
      async (_provider: DirectorDccEngineId, _executable: string) => "unity 9.9 fixture",
    );
    const bridge = createDirectorDccEngineBridge({
      workspaceRoot: repositoryRoot,
      dataDirectory: setup.dataDirectory,
      exchangePackager: { exportPackage: vi.fn() },
      environment: setup.environment,
      probeHostVersion,
      healthTtlMs: 5_000,
      now: () => clock,
    });
    await bridge.health("unity");
    await bridge.health("unity");
    expect(probeHostVersion).toHaveBeenCalledTimes(1);

    // Another provider never reuses this provider's cache entry.
    await bridge.health("godot");
    expect(probeHostVersion.mock.calls.filter(([provider]) => provider === "unity")).toHaveLength(1);

    clock += 5_001;
    await bridge.health("unity");
    expect(probeHostVersion.mock.calls.filter(([provider]) => provider === "unity")).toHaveLength(2);
  });

  it("keeps parallel sends isolated: distinct job ids, report paths, and per-job reports", async () => {
    const setup = await temporaryEngineSetup("unity");
    const exportPackage = vi.fn(async () => {
      const jobId = randomUUID();
      const packageDirectory = resolve(setup.dataDirectory, "dcc-jobs", "exchange", "unity", jobId);
      await mkdir(packageDirectory, { recursive: true });
      return fakeExchangeResult("unity", packageDirectory, jobId);
    });
    const runProcess = vi.fn(async (_executable: string, args: string[]) => {
      const reportPath = args.find((argument) => argument.endsWith("report.json"))!;
      const jobId = dirname(reportPath).split("/").at(-1)!;
      await mkdir(dirname(reportPath), { recursive: true });
      await writeFile(reportPath, JSON.stringify(validReport("unity", jobId)), "utf8");
      return { stdout: "", stderr: "" };
    });
    const bridge = createDirectorDccEngineBridge({
      workspaceRoot: repositoryRoot,
      dataDirectory: setup.dataDirectory,
      exchangePackager: { exportPackage },
      environment: setup.environment,
      probeHostVersion: async () => "unity 9.9 fixture",
      runProcess,
      healthTtlMs: 60_000,
    });
    const results = await Promise.all(
      Array.from({ length: 4 }, () => bridge.send(createTestDirectorProject(), { provider: "unity" })),
    );
    expect(new Set(results.map((result) => result.jobId)).size).toBe(4);
    expect(new Set(results.map((result) => result.reportPath)).size).toBe(4);
    for (const result of results) {
      expect(result.report.packageId).toBe(result.jobId);
      expect(result.reportPath).toBe(resolve(bridge.jobRoot("unity"), result.jobId, "report.json"));
    }
  });

  it("fails jobs whose engine process dies without wedging later sends", async () => {
    const setup = await temporaryEngineSetup("unity");
    const jobs: string[] = [];
    const exportPackage = vi.fn(async () => {
      const jobId = randomUUID();
      jobs.push(jobId);
      const packageDirectory = resolve(setup.dataDirectory, "dcc-jobs", "exchange", "unity", jobId);
      await mkdir(packageDirectory, { recursive: true });
      return fakeExchangeResult("unity", packageDirectory, jobId);
    });
    let crashNext = true;
    const runProcess = vi.fn(async (_executable: string, args: string[]) => {
      if (crashNext) {
        crashNext = false;
        throw new Error("engine crashed with exit code 139");
      }
      const reportPath = args.find((argument) => argument.endsWith("report.json"))!;
      await mkdir(dirname(reportPath), { recursive: true });
      await writeFile(reportPath, JSON.stringify(validReport("unity", jobs.at(-1)!)), "utf8");
      return { stdout: "", stderr: "" };
    });
    const bridge = createDirectorDccEngineBridge({
      workspaceRoot: repositoryRoot,
      dataDirectory: setup.dataDirectory,
      exchangePackager: { exportPackage },
      environment: setup.environment,
      probeHostVersion: async () => "unity 9.9 fixture",
      runProcess,
      healthTtlMs: 60_000,
    });
    await expect(bridge.send(createTestDirectorProject(), { provider: "unity" })).rejects.toMatchObject({
      code: "engine_job_failed",
      status: 502,
      message: expect.stringContaining("exit code 139"),
    });
    await expect(bridge.send(createTestDirectorProject(), { provider: "unity" })).resolves.toMatchObject({
      provider: "unity",
    });
  });
});

describe("provider registry stress: capability honesty", () => {
  const blenderStub = {
    status: vi.fn().mockResolvedValue({ available: false, reason: "fixture" }),
  } as unknown as BlenderBridge;

  it("never lets planned capabilities masquerade: every built-in planned claim sits on the connector layer", () => {
    for (const descriptor of DIRECTOR_DCC_PROVIDERS) {
      for (const capability of descriptor.capabilities) {
        if (capability.level === "planned") {
          expect(capability.layer, `${descriptor.id}.${capability.id}`).toBe("connector");
          expect(capability.formats, `${descriptor.id}.${capability.id}`).toBeUndefined();
        }
        if (capability.level === "native") {
          // Native claims require a Director-authored connector integration.
          expect(
            ["native-roundtrip", "engine-headless"],
            `${descriptor.id}.${capability.id} claims native without a connector integration`,
          ).toContain(descriptor.integration);
        }
        if (capability.layer === "exchange-format") {
          expect(capability.level, `${descriptor.id}.${capability.id}`).toBe("exchange");
          for (const format of capability.formats ?? []) {
            expect(descriptor.exchangeFormats, `${descriptor.id}.${capability.id}`).toContain(format);
          }
        }
      }
      const ids = descriptor.capabilities.map((capability) => capability.id);
      expect(new Set(ids).size, `${descriptor.id} duplicates capabilities`).toBe(ids.length);
    }
  });

  it("keeps installed and nativeReady independent across the full engine health matrix", async () => {
    const matrix: Array<{ executable: string | null; ready: boolean }> = [
      { executable: null, ready: false },
      { executable: "/opt/engine/bin", ready: false },
      { executable: "/opt/engine/bin", ready: true },
    ];
    for (const engine of ENGINE_IDS) {
      for (const combo of matrix) {
        const registry = createDirectorDccProviderRegistry({
          blender: blenderStub,
          engines: {
            health: vi.fn().mockResolvedValue({
              contract: "director-dcc-engine-health-v1",
              provider: engine,
              ready: combo.ready,
              executable: combo.executable,
              hostVersion: combo.executable ? "Engine 1.0" : null,
              connectorVersion: combo.ready ? "0.1.0" : null,
              connectorDirectory: `integrations/${engine}`,
              projectPath: combo.ready ? "/projects/film" : null,
              checks: [],
              warnings: combo.ready ? [] : ["not ready"],
              recovery: combo.ready ? [] : ["configure the connector"],
            }),
          },
          environment: { PATH: "" },
        });
        const status = await registry.status(engine);
        expect(status, `${engine} ${JSON.stringify(combo)}`).toMatchObject({
          installed: Boolean(combo.executable),
          nativeReady: combo.ready,
          exchangeReady: true,
        });
        // An installed executable alone must never surface as nativeReady.
        if (!combo.ready) expect(status?.nativeReady).toBe(false);
      }
    }
  });

  it("keeps engine descriptors on the engine-headless integration and portable exchange formats", () => {
    for (const engine of ENGINE_IDS) {
      const descriptor = getDirectorDccProviderDescriptor(engine);
      expect(descriptor.integration).toBe("engine-headless");
      expect(descriptor.category).toBe("engine");
      expect(descriptor.exchangeFormats.every((format) => format === "glb" || format === "usda")).toBe(true);
      expect(descriptor.exchangeFormats).toContain(descriptor.preferredFormat);
    }
  });

  it("engine adapters degrade to exchange-only without an engine bridge, never inventing readiness", async () => {
    const registry = createDirectorDccProviderRegistry({ blender: blenderStub, environment: { PATH: "" } });
    for (const engine of ENGINE_IDS) {
      const status = await registry.status(engine);
      expect(status).toMatchObject({ nativeReady: false, exchangeReady: true });
    }
  });
});
