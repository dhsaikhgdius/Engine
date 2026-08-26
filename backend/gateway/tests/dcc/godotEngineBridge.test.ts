import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import type { DirectorDccExchangePackageResult } from "@director/dcc-protocol";
import {
  createDirectorDccEngineBridge,
  DirectorDccEngineBridgeError,
  DIRECTOR_ENGINE_BINARY_ENV,
  DIRECTOR_ENGINE_PROJECT_ENV,
  MAX_ENGINE_REPORT_BYTES,
} from "../../dcc/engineBridge";
import {
  checkGodotAddonEnabled,
  GODOT_DEFAULT_EXECUTABLE_PATHS,
  GODOT_HEADLESS_ENTRY,
  godotHealthProbeArguments,
  parseGodotMajorVersion,
  probeGodotConnectorHealth,
} from "../../dcc/godotProbe";
import { createTestDirectorProject } from "../fixtures/createTestDirectorProject";

/** The real repository root, so tests validate the committed connector sources. */
const repositoryRoot = resolve(__dirname, "..", "..", "..", "..");

const CONNECTOR_VERSION = (
  JSON.parse(readFileSync(resolve(repositoryRoot, "integrations", "godot", "connector.json"), "utf8")) as {
    version: string;
  }
).version;

const REVISION = `director-project-revision:v1:sha256:${"d".repeat(64)}`;

const ENABLED_PROJECT_GODOT = [
  "config_version=5",
  "",
  "[editor_plugins]",
  "",
  'enabled=PackedStringArray("res://addons/director_bridge/plugin.cfg")',
  "",
].join("\n");

function healthLine(overrides: Partial<Record<"hostVersion" | "connectorVersion", string>> = {}) {
  return JSON.stringify({
    ok: true,
    provider: "godot",
    hostVersion: overrides.hostVersion ?? "4.3.stable.official.77dcf97d8",
    connectorVersion: overrides.connectorVersion ?? CONNECTOR_VERSION,
  });
}

async function godotSetup(options: { projectGodot?: string } = {}) {
  const root = await mkdtemp(resolve(tmpdir(), "director-godot-bridge-"));
  const dataDirectory = resolve(root, "data");
  const executable = resolve(root, "bin", "godot4");
  await mkdir(dirname(executable), { recursive: true });
  await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const projectDirectory = resolve(root, "project");
  await mkdir(resolve(projectDirectory, "addons", "director_bridge"), { recursive: true });
  await writeFile(resolve(projectDirectory, "project.godot"), options.projectGodot ?? ENABLED_PROJECT_GODOT, "utf8");
  await writeFile(resolve(projectDirectory, "addons", "director_bridge", "plugin.cfg"), "fixture", "utf8");
  await writeFile(resolve(projectDirectory, "addons", "director_bridge", "director_headless.gd"), "fixture", "utf8");
  const environment: NodeJS.ProcessEnv = {
    PATH: "",
    [DIRECTOR_ENGINE_BINARY_ENV.godot]: executable,
    [DIRECTOR_ENGINE_PROJECT_ENV.godot]: projectDirectory,
  };
  return { root, dataDirectory, executable, projectDirectory, environment };
}

describe("godotProbe helpers", () => {
  it("parses Godot major versions from raw --version output and health strings", () => {
    expect(parseGodotMajorVersion("4.3.stable.official.77dcf97d8")).toBe(4);
    expect(parseGodotMajorVersion("Godot 4.2.2")).toBe(4);
    expect(parseGodotMajorVersion("Godot Engine v4.5.beta1")).toBe(4);
    expect(parseGodotMajorVersion("3.6.stable")).toBe(3);
    expect(parseGodotMajorVersion("no version here")).toBeNull();
  });

  it("ships Linux and Windows probe locations, not just macOS", () => {
    const paths = GODOT_DEFAULT_EXECUTABLE_PATHS.join("\n");
    expect(paths).toContain("/usr/bin/godot");
    expect(paths).toContain("/var/lib/flatpak/exports/bin/org.godotengine.Godot");
    expect(paths).toContain("/snap/bin/godot");
    expect(paths).toContain("C:\\Program Files\\Godot");
    expect(paths).toContain("/Applications/Godot.app");
  });

  it("builds the fixed health probe argv around the committed headless entry", () => {
    expect(godotHealthProbeArguments("/projects/film")).toEqual([
      "--headless",
      "--path",
      "/projects/film",
      "--script",
      GODOT_HEADLESS_ENTRY,
      "--",
      "--mode",
      "health",
    ]);
    expect(GODOT_HEADLESS_ENTRY).toBe("res://addons/director_bridge/director_headless.gd");
  });

  it("detects the enabled addon only through project.godot [editor_plugins]", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "director-godot-addon-"));
    await writeFile(resolve(root, "project.godot"), ENABLED_PROJECT_GODOT, "utf8");
    expect((await checkGodotAddonEnabled(root)).ok).toBe(true);

    await writeFile(resolve(root, "project.godot"), "config_version=5\n", "utf8");
    const disabled = await checkGodotAddonEnabled(root);
    expect(disabled.ok).toBe(false);
    expect(disabled.detail).toMatch(/not enabled/);

    const missing = await checkGodotAddonEnabled(resolve(root, "does-not-exist"));
    expect(missing.ok).toBe(false);
  });

  it("validates the health JSON line and enforces the Godot 4.x gate", async () => {
    const okProbe = await probeGodotConnectorHealth({
      executable: "/usr/bin/godot4",
      projectDirectory: "/projects/film",
      expectedConnectorVersion: CONNECTOR_VERSION,
      runProcess: async () => ({
        // Engine banners and driver noise precede the connector's JSON line.
        stdout: `Godot Engine v4.3.stable.official\nVulkan 1.3 something\n${healthLine()}\n`,
        stderr: "",
      }),
    });
    expect(okProbe.ok).toBe(true);
    expect(okProbe.health?.connectorVersion).toBe(CONNECTOR_VERSION);

    const godot3 = await probeGodotConnectorHealth({
      executable: "/usr/bin/godot",
      projectDirectory: "/projects/film",
      expectedConnectorVersion: CONNECTOR_VERSION,
      runProcess: async () => ({ stdout: `${healthLine({ hostVersion: "3.6.stable" })}\n`, stderr: "" }),
    });
    expect(godot3.ok).toBe(false);
    expect(godot3.detail).toMatch(/Godot 4\.x/);

    const staleAddon = await probeGodotConnectorHealth({
      executable: "/usr/bin/godot4",
      projectDirectory: "/projects/film",
      expectedConnectorVersion: CONNECTOR_VERSION,
      runProcess: async () => ({ stdout: `${healthLine({ connectorVersion: "0.0.1" })}\n`, stderr: "" }),
    });
    expect(staleAddon.ok).toBe(false);
    expect(staleAddon.detail).toMatch(/update the addon copy/);

    const noJson = await probeGodotConnectorHealth({
      executable: "/usr/bin/godot4",
      projectDirectory: "/projects/film",
      expectedConnectorVersion: CONNECTOR_VERSION,
      runProcess: async () => ({ stdout: "Godot Engine v4.3\n", stderr: "" }),
    });
    expect(noJson.ok).toBe(false);

    const crashed = await probeGodotConnectorHealth({
      executable: "/usr/bin/godot4",
      projectDirectory: "/projects/film",
      expectedConnectorVersion: CONNECTOR_VERSION,
      runProcess: async () => {
        throw new Error("spawn failure fixture");
      },
    });
    expect(crashed.ok).toBe(false);
    expect(crashed.detail).toMatch(/spawn failure fixture/);
  });

  it("hard-fails a hypothetical Godot 5 host: the gate is 4.x exactly, not 4.x-or-newer", async () => {
    const godot5 = await probeGodotConnectorHealth({
      executable: "/usr/bin/godot5",
      projectDirectory: "/projects/film",
      expectedConnectorVersion: CONNECTOR_VERSION,
      runProcess: async () => ({ stdout: `${healthLine({ hostVersion: "Godot 5.0.1" })}\n`, stderr: "" }),
    });
    expect(godot5.ok).toBe(false);
    expect(godot5.detail).toMatch(/Godot 4\.x/);
  });

  it("survives corrupted health output: broken JSON lines are skipped, an earlier valid line still counts", async () => {
    const recovered = await probeGodotConnectorHealth({
      executable: "/usr/bin/godot4",
      projectDirectory: "/projects/film",
      expectedConnectorVersion: CONNECTOR_VERSION,
      runProcess: async () => ({
        stdout: `${healthLine()}\n{this is not: json}\n{"ok": "also-not-a-health-line"}\n`,
        stderr: "",
      }),
    });
    expect(recovered.ok).toBe(true);

    const onlyBroken = await probeGodotConnectorHealth({
      executable: "/usr/bin/godot4",
      projectDirectory: "/projects/film",
      expectedConnectorVersion: CONNECTOR_VERSION,
      runProcess: async () => ({ stdout: '{"ok": tru\n{,}\n', stderr: "" }),
    });
    expect(onlyBroken.ok).toBe(false);
    expect(onlyBroken.detail).toMatch(/did not print a valid health JSON line/);
  });

  it("refuses an absurdly oversized health JSON line instead of parsing it", async () => {
    const padding = `"padding": "${"x".repeat(64 * 1024)}", `;
    const oversized = `{${padding}"ok": true, "provider": "godot", "hostVersion": "Godot 4.3.0", "connectorVersion": "${CONNECTOR_VERSION}"}`;
    const flooded = await probeGodotConnectorHealth({
      executable: "/usr/bin/godot4",
      projectDirectory: "/projects/film",
      expectedConnectorVersion: CONNECTOR_VERSION,
      runProcess: async () => ({ stdout: `${oversized}\n`, stderr: "" }),
    });
    expect(flooded.ok).toBe(false);
    expect(flooded.detail).toMatch(/did not print a valid health JSON line/);
  });
});

describe("engine bridge Godot readiness", () => {
  it("fails project_plugin_enabled when the addon files exist but the plugin is disabled", async () => {
    const setup = await godotSetup({ projectGodot: "config_version=5\n" });
    const bridge = createDirectorDccEngineBridge({
      workspaceRoot: repositoryRoot,
      dataDirectory: setup.dataDirectory,
      exchangePackager: { exportPackage: vi.fn() },
      environment: setup.environment,
      probeHostVersion: async () => "4.3.stable.official.77dcf97d8",
      healthTtlMs: 0,
    });
    const health = await bridge.health("godot");
    expect(health.ready).toBe(false);
    expect(health.checks).toContainEqual(expect.objectContaining({ id: "project_connector", ok: true }));
    expect(health.checks).toContainEqual(expect.objectContaining({ id: "project_plugin_enabled", ok: false }));
    expect(health.recovery.join("\n")).toMatch(/Project Settings → Plugins/);
  });

  it("fails connector_health (and readiness) when the health probe rejects", async () => {
    const setup = await godotSetup();
    const bridge = createDirectorDccEngineBridge({
      workspaceRoot: repositoryRoot,
      dataDirectory: setup.dataDirectory,
      exchangePackager: { exportPackage: vi.fn() },
      environment: setup.environment,
      probeHostVersion: async () => "4.3.stable.official.77dcf97d8",
      probeConnectorHealth: async () => ({ ok: false, detail: "health probe fixture failure", health: null }),
      healthTtlMs: 0,
    });
    const health = await bridge.health("godot");
    expect(health.ready).toBe(false);
    expect(health.checks).toContainEqual(expect.objectContaining({ id: "project_plugin_enabled", ok: true }));
    expect(health.checks).toContainEqual(
      expect.objectContaining({ id: "connector_health", ok: false, detail: "health probe fixture failure" }),
    );
    expect(health.recovery.join("\n")).toMatch(/--mode health/);
  });

  it("reports ready when connector, executable, enabled addon, and health JSON all pass", async () => {
    const setup = await godotSetup();
    const probeConnectorHealth = vi.fn().mockResolvedValue({
      ok: true,
      detail: "Connector health OK (4.3, connector fixture).",
      health: {
        ok: true,
        provider: "godot",
        hostVersion: "4.3.stable.official.77dcf97d8",
        connectorVersion: CONNECTOR_VERSION,
      },
    });
    const bridge = createDirectorDccEngineBridge({
      workspaceRoot: repositoryRoot,
      dataDirectory: setup.dataDirectory,
      exchangePackager: { exportPackage: vi.fn() },
      environment: setup.environment,
      probeHostVersion: async () => "4.3.stable.official.77dcf97d8",
      probeConnectorHealth,
      healthTtlMs: 0,
    });
    const health = await bridge.health("godot");
    expect(health.ready).toBe(true);
    expect(probeConnectorHealth).toHaveBeenCalledWith(
      "godot",
      expect.objectContaining({
        executable: setup.executable,
        projectDirectory: setup.projectDirectory,
        expectedConnectorVersion: CONNECTOR_VERSION,
      }),
    );
  });
});

describe("engine bridge Godot animation bake wiring", () => {
  it("hash-pins the bake sidecar into the fixed import argv and merges bake warnings", async () => {
    const setup = await godotSetup();
    const jobId = randomUUID();
    const packageDirectory = resolve(setup.dataDirectory, "dcc-jobs", "exchange", "godot", jobId);
    await mkdir(packageDirectory, { recursive: true });
    const exchangeResult: DirectorDccExchangePackageResult = {
      contract: "director-dcc-exchange-result-v1",
      jobId,
      provider: "godot",
      packagePath: packageDirectory,
      manifestPath: resolve(packageDirectory, "manifest.json"),
      manifestSha256: "a".repeat(64),
      packageDigest: "b".repeat(64),
      sourceRevision: REVISION,
      formats: [],
      assets: [],
      warnings: [],
    };
    const observedArguments: string[][] = [];
    const runProcess = vi.fn(async (_executable: string, args: string[]) => {
      observedArguments.push(args);
      const reportPath = args[args.indexOf("--report") + 1]!;
      await mkdir(resolve(dirname(reportPath), "return"), { recursive: true });
      await writeFile(
        reportPath,
        JSON.stringify({
          ok: true,
          contract: "director-dcc-engine-report-v1",
          provider: "godot",
          hostVersion: "4.3.stable.official.77dcf97d8",
          connectorVersion: CONNECTOR_VERSION,
          packageId: jobId,
          sourceRevision: REVISION,
          importedObjectCount: 1,
          importedCameraCount: 0,
          scenePath: "res://director/scenes/fixture.tscn",
          returnPackageDir: "return",
          warnings: [],
          godot: {
            animationPlayerPath: "res://director/scenes/fixture.tscn",
            animationLibrary: "director",
            displayRate: "24000/1001",
            bakedKeyCount: 75,
            transformTrackCount: 1,
            fovTrackCount: 0,
            shotCutTrackCount: 0,
            mappedShotCount: 0,
            payloadAnimationPlayerCount: 0,
            importedSkeletonCount: 0,
            importedLightCount: 0,
            worldEnvironmentAmbient: false,
            worldEnvironmentCount: 0,
            omittedLightCount: 0,
            appliedMaterialCount: 0,
            externalizedTextureCount: 0,
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
      probeHostVersion: async () => "4.3.stable.official.77dcf97d8",
      probeConnectorHealth: async () => ({ ok: true, detail: "fixture", health: null }),
      runProcess,
      healthTtlMs: 0,
    });

    const project = createTestDirectorProject();
    project.scene.timeline = {
      version: 1,
      fps: 23.976,
      timebase: {
        rate: { numerator: 24000, denominator: 1001 },
        dropFrame: false,
        startTimecode: "00:00:00:00",
      },
      frameStart: 0,
      frameEnd: 24,
      currentFrame: 0,
      loop: false,
    };
    project.objects = [
      {
        id: "obj-anim",
        name: "Prop",
        kind: "prop",
        visible: true,
        locked: false,
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        animation: {
          version: 1,
          keyframes: [
            { frame: 0, transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
            { frame: 24, transform: { position: [2, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
          ],
        },
      },
    ];

    const result = await bridge.send(project, { provider: "godot" });
    expect(observedArguments).toHaveLength(1);
    const args = observedArguments[0]!;
    expect(args[args.indexOf("--script") + 1]).toBe(GODOT_HEADLESS_ENTRY);

    const bakePath = args[args.indexOf("--animation") + 1]!;
    const pinnedSha = args[args.indexOf("--animation-sha256") + 1]!;
    expect(bakePath.endsWith("animation.json")).toBe(true);
    const bakeBytes = await readFile(bakePath);
    expect(createHash("sha256").update(bakeBytes).digest("hex")).toBe(pinnedSha);

    expect(result.report.godot?.animationLibrary).toBe("director");
    expect(result.report.godot?.displayRate).toBe("24000/1001");
  });
});

describe("engine bridge Godot job stress (hostile or broken connector outputs)", () => {
  /**
   * Builds a ready Godot bridge whose fake connector run writes whatever the
   * test dictates into the private job directory, so every hostile output
   * shape can be exercised without a real host.
   */
  async function stressBridge(
    writeJobFiles: (jobDirectory: string, reportPath: string, jobId: string) => Promise<void>,
  ) {
    const setup = await godotSetup();
    const jobId = randomUUID();
    const packageDirectory = resolve(setup.dataDirectory, "dcc-jobs", "exchange", "godot", jobId);
    await mkdir(packageDirectory, { recursive: true });
    const exchangeResult: DirectorDccExchangePackageResult = {
      contract: "director-dcc-exchange-result-v1",
      jobId,
      provider: "godot",
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
      const reportPath = args[args.indexOf("--report") + 1]!;
      await writeJobFiles(dirname(reportPath), reportPath, jobId);
      return { stdout: "", stderr: "" };
    });
    const bridge = createDirectorDccEngineBridge({
      workspaceRoot: repositoryRoot,
      dataDirectory: setup.dataDirectory,
      exchangePackager: { exportPackage: vi.fn().mockResolvedValue(exchangeResult) },
      environment: setup.environment,
      probeHostVersion: async () => "4.3.stable.official.77dcf97d8",
      probeConnectorHealth: async () => ({ ok: true, detail: "fixture", health: null }),
      runProcess,
      healthTtlMs: 0,
    });
    return { bridge, jobId };
  }

  function okReport(jobId: string, overrides: Record<string, unknown> = {}) {
    return {
      ok: true,
      contract: "director-dcc-engine-report-v1",
      provider: "godot",
      hostVersion: "4.3.stable.official.77dcf97d8",
      connectorVersion: CONNECTOR_VERSION,
      packageId: jobId,
      sourceRevision: REVISION,
      importedObjectCount: 0,
      importedCameraCount: 0,
      scenePath: null,
      returnPackageDir: null,
      warnings: [],
      ...overrides,
    };
  }

  async function expectBridgeError(
    action: Promise<unknown>,
    code: "engine_job_failed" | "engine_report_invalid",
    pattern: RegExp,
  ) {
    const failure = await action.then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(DirectorDccEngineBridgeError);
    expect((failure as DirectorDccEngineBridgeError).code).toBe(code);
    expect((failure as DirectorDccEngineBridgeError).message).toMatch(pattern);
  }

  it("hard-fails the job when the connector reports a tampered animation sidecar", async () => {
    // This is the host-free mirror of the connector's SHA-256 refusal: the
    // connector writes ok:false with the mismatch reason, and the bridge must
    // surface it as a hard engine_job_failed, never as a degraded success.
    const { bridge } = await stressBridge(async (_jobDirectory, reportPath) => {
      await writeFile(
        reportPath,
        JSON.stringify({ ok: false, error: "Animation bake SHA-256 mismatch: expected ab12, found cd34." }),
        "utf8",
      );
    });
    await expectBridgeError(
      bridge.send(createTestDirectorProject(), { provider: "godot" }),
      "engine_job_failed",
      /SHA-256 mismatch/,
    );
  });

  it("rejects an oversized report.json unread", async () => {
    const { bridge } = await stressBridge(async (_jobDirectory, reportPath) => {
      await writeFile(reportPath, `{"ok": true, "padding": "${"x".repeat(MAX_ENGINE_REPORT_BYTES)}"}`, "utf8");
    });
    await expectBridgeError(
      bridge.send(createTestDirectorProject(), { provider: "godot" }),
      "engine_report_invalid",
      /oversized report\.json/,
    );
  });

  it("rejects unreadable and non-JSON reports", async () => {
    const { bridge: missing } = await stressBridge(async () => {
      // The connector wrote nothing at all.
    });
    await expectBridgeError(
      missing.send(createTestDirectorProject(), { provider: "godot" }),
      "engine_report_invalid",
      /did not write a readable report\.json/,
    );

    const { bridge: garbled } = await stressBridge(async (_jobDirectory, reportPath) => {
      await writeFile(reportPath, "this is not json {", "utf8");
    });
    await expectBridgeError(
      garbled.send(createTestDirectorProject(), { provider: "godot" }),
      "engine_report_invalid",
      /did not write a readable report\.json/,
    );
  });

  it("rejects a report whose identity does not match the exchange package", async () => {
    const { bridge: wrongPackage } = await stressBridge(async (_jobDirectory, reportPath) => {
      await writeFile(reportPath, JSON.stringify(okReport(randomUUID())), "utf8");
    });
    await expectBridgeError(
      wrongPackage.send(createTestDirectorProject(), { provider: "godot" }),
      "engine_report_invalid",
      /does not match the exchange package/,
    );

    const { bridge: wrongRevision } = await stressBridge(async (_jobDirectory, reportPath, jobId) => {
      await writeFile(
        reportPath,
        JSON.stringify(okReport(jobId, { sourceRevision: `director-project-revision:v1:sha256:${"e".repeat(64)}` })),
        "utf8",
      );
    });
    await expectBridgeError(
      wrongRevision.send(createTestDirectorProject(), { provider: "godot" }),
      "engine_report_invalid",
      /different source revision/,
    );
  });

  it("never resolves a return package directory that escapes the private job directory", async () => {
    // A hostile connector claims its return package lives outside the job:
    // the report schema itself rejects the traversal path outright.
    const { bridge: escaping } = await stressBridge(async (jobDirectory, reportPath, jobId) => {
      await mkdir(resolve(jobDirectory, "..", "escaped-return"), { recursive: true });
      await writeFile(reportPath, JSON.stringify(okReport(jobId, { returnPackageDir: "../escaped-return" })), "utf8");
    });
    await expectBridgeError(
      escaping.send(createTestDirectorProject(), { provider: "godot" }),
      "engine_report_invalid",
      /failed validation/,
    );

    const { bridge: absolute } = await stressBridge(async (_jobDirectory, reportPath, jobId) => {
      await writeFile(reportPath, JSON.stringify(okReport(jobId, { returnPackageDir: "/tmp/escaped" })), "utf8");
    });
    await expectBridgeError(
      absolute.send(createTestDirectorProject(), { provider: "godot" }),
      "engine_report_invalid",
      /failed validation/,
    );

    // Defense in depth: a schema-safe name that simply does not exist inside
    // the job directory resolves to null instead of a dangling path.
    const { bridge: missing } = await stressBridge(async (_jobDirectory, reportPath, jobId) => {
      await writeFile(
        reportPath,
        JSON.stringify(okReport(jobId, { returnPackageDir: "return-that-never-was" })),
        "utf8",
      );
    });
    const result = await missing.send(createTestDirectorProject(), { provider: "godot" });
    expect(result.returnPackagePath).toBeNull();
  });
});
