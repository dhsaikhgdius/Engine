import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import {
  directorDccEngineHealthSchema,
  directorUnrealSequencerBakeSchema,
  type DirectorDccExchangePackageResult,
} from "@director/dcc-protocol";
import type { DirectorProject } from "@director/project-schema";
import {
  createDirectorDccEngineBridge,
  DIRECTOR_ENGINE_BINARY_ENV,
  DIRECTOR_ENGINE_PROJECT_ENV,
} from "../../dcc/engineBridge";
import { createTestDirectorProject } from "../fixtures/createTestDirectorProject";

/** The real repository root, so tests validate the committed connector sources. */
const repositoryRoot = resolve(__dirname, "..", "..", "..", "..");

const REVISION = `director-project-revision:v1:sha256:${"f".repeat(64)}`;

async function temporaryUnrealSetup() {
  const root = await mkdtemp(resolve(tmpdir(), "director-unreal-bridge-"));
  const dataDirectory = resolve(root, "data");
  const executable = resolve(root, "bin", "UnrealEditor-Cmd");
  await mkdir(dirname(executable), { recursive: true });
  await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const projectDirectory = resolve(root, "project");
  // Health's version-honesty check reads VersionName from the installed
  // .uplugin and requires it to equal the workspace connector manifest.
  const installedUplugin = JSON.stringify({ VersionName: await connectorVersion() });
  for (const file of [
    "Project.uproject",
    "Plugins/DirectorBridge/DirectorBridge.uplugin",
    "Plugins/DirectorBridge/Content/Python/director_headless.py",
  ]) {
    const path = resolve(projectDirectory, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.endsWith(".uplugin") ? installedUplugin : "fixture", "utf8");
  }
  const environment: NodeJS.ProcessEnv = {
    PATH: "",
    [DIRECTOR_ENGINE_BINARY_ENV.unreal]: executable,
    [DIRECTOR_ENGINE_PROJECT_ENV.unreal]: resolve(projectDirectory, "Project.uproject"),
  };
  return { root, dataDirectory, executable, projectDirectory, environment };
}

function animatedProject(): DirectorProject {
  const project = createTestDirectorProject();
  project.scene.timeline = { version: 1, fps: 24, frameStart: 0, frameEnd: 24, currentFrame: 0, loop: false };
  project.objects = [
    {
      id: "hero-crate",
      name: "Hero Crate",
      kind: "prop",
      visible: true,
      locked: false,
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      animation: {
        version: 1,
        keyframes: [
          {
            frame: 0,
            interpolation: "linear",
            transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          },
          {
            frame: 24,
            interpolation: "linear",
            transform: { position: [3, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          },
        ],
      },
    },
  ];
  return project;
}

function fakeExchangeResult(packageDirectory: string, jobId: string): DirectorDccExchangePackageResult {
  return {
    contract: "director-dcc-exchange-result-v1",
    jobId,
    provider: "unreal",
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

const SEQUENCER_RECEIPT = {
  sequencePath: "/Game/Director/Sequences/DirectorSequence",
  displayRate: "24/1",
  tickResolution: "24000/1",
  dropFrame: false,
  startTimecode: "01:00:00:00",
  startFrameOffset: 86_400,
  playbackStart: 86_400,
  playbackEnd: 86_424,
  cameraCutCount: 0,
  transformTrackCount: 1,
  focalLengthTrackCount: 0,
  bakedKeyCount: 225,
};

async function connectorVersion(): Promise<string> {
  const manifest = JSON.parse(
    await readFile(resolve(repositoryRoot, "integrations", "unreal", "connector.json"), "utf8"),
  ) as { version: string };
  return manifest.version;
}

interface SendHarness {
  send: () => Promise<Awaited<ReturnType<ReturnType<typeof createDirectorDccEngineBridge>["send"]>>>;
  observedScriptArguments: () => string;
  observedInvocations: () => string[][];
}

interface SendHarnessOptions {
  /** Project override for the send (defaults to the animated fixture). */
  project?: DirectorProject;
  /** Request the optional Unreal clean frame on the send. */
  cleanFrame?: boolean;
  /** Whether the fake render invocation writes a receipt and image (default true). */
  renderWritesReceipt?: boolean;
}

async function createSendHarness(
  reportExtras: Record<string, unknown> = {},
  options: SendHarnessOptions = {},
): Promise<SendHarness> {
  const setup = await temporaryUnrealSetup();
  const jobId = randomUUID();
  const packageDirectory = resolve(setup.dataDirectory, "dcc-jobs", "exchange", "unreal", jobId);
  await mkdir(packageDirectory, { recursive: true });
  const exportPackage = vi.fn().mockResolvedValue(fakeExchangeResult(packageDirectory, jobId));
  const observed: string[][] = [];
  const version = await connectorVersion();

  const runProcess = vi.fn(async (_executable: string, args: string[]) => {
    observed.push(args);
    const renderArgument = args.find((argument) => argument.startsWith("-ExecCmds=py "));
    if (renderArgument) {
      if (options.renderWritesReceipt !== false) {
        const receiptPath = /--report "([^"]+)"/.exec(renderArgument)![1]!;
        const imagePath = /--render-output "([^"]+)"/.exec(renderArgument)![1]!;
        const imageBytes = Buffer.from("clean-frame-fixture-image", "utf8");
        await writeFile(imagePath, imageBytes);
        await writeFile(
          receiptPath,
          JSON.stringify({
            contract: "director-unreal-clean-frame-v1",
            provider: "unreal",
            status: "rendered",
            packageId: jobId,
            sourceRevision: REVISION,
            levelPath: "/Game/Director/Levels/Director_fixture",
            cameraDirectorId: null,
            frame: 0,
            width: 1_920,
            height: 1_080,
            imagePath: "clean-frame.png",
            imageSha256: createHash("sha256").update(imageBytes).digest("hex"),
            method: "offscreen_high_res_screenshot",
            hostVersion: "5.6.1-fixture",
            warnings: [],
          }),
          "utf8",
        );
      }
      return { stdout: "", stderr: "" };
    }
    const scriptArgument = args.find((argument) => argument.startsWith("-ExecutePythonScript="))!;
    const reportPath = /--report "([^"]+)"/.exec(scriptArgument)![1]!;
    await mkdir(resolve(dirname(reportPath), "return"), { recursive: true });
    await writeFile(
      reportPath,
      JSON.stringify({
        ok: true,
        contract: "director-dcc-engine-report-v1",
        provider: "unreal",
        hostVersion: "5.6.1-fixture",
        connectorVersion: version,
        packageId: jobId,
        sourceRevision: REVISION,
        importedObjectCount: 1,
        importedCameraCount: 0,
        scenePath: "/Game/Director/Scenes/DirectorStage",
        returnPackageDir: "return",
        warnings: [],
        ...reportExtras,
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
    probeHostVersion: async () => "5.6.1-fixture",
    runProcess,
    healthTtlMs: 0,
  });

  return {
    send: () =>
      bridge.send(options.project ?? animatedProject(), {
        provider: "unreal",
        formats: ["usda"],
        ...(options.cleanFrame !== undefined ? { cleanFrame: options.cleanFrame } : {}),
      }),
    observedScriptArguments: () => observed[0]!.find((argument) => argument.startsWith("-ExecutePythonScript="))!,
    observedInvocations: () => observed,
  };
}

describe("Unreal engine bridge Sequencer bake wiring", () => {
  it("writes a hash-pinned animation sidecar into the private job dir and pins it on the argv", async () => {
    const harness = await createSendHarness({ sequencer: SEQUENCER_RECEIPT });
    const result = await harness.send();

    const scriptArgument = harness.observedScriptArguments();
    const bakePath = /--animation "([^"]+)"/.exec(scriptArgument)?.[1];
    const pinnedSha = /--animation-sha256 ([0-9a-f]{64})/.exec(scriptArgument)?.[1];
    expect(bakePath, "the fixed argv must name the bake sidecar").toBeDefined();
    expect(pinnedSha, "the fixed argv must pin the bake SHA-256").toBeDefined();

    // The sidecar lives in the same private job directory as the report.
    const reportPath = /--report "([^"]+)"/.exec(scriptArgument)![1]!;
    expect(dirname(bakePath!)).toBe(dirname(reportPath));

    // The pinned hash covers the exact bytes on disk.
    const body = await readFile(bakePath!);
    expect(createHash("sha256").update(body).digest("hex")).toBe(pinnedSha);

    // The sidecar is a valid bake carrying the animated entity.
    const bake = directorUnrealSequencerBakeSchema.parse(JSON.parse(body.toString("utf8")));
    expect(bake.entities.map(({ directorId }) => directorId)).toEqual(["hero-crate"]);
    expect(bake.entities[0]!.transformSamples).toHaveLength(25);

    expect(result.report.importedObjectCount).toBe(1);
  });

  it("returns the schema-validated Sequencer receipt and host-side counts on the report", async () => {
    const harness = await createSendHarness({
      sequencer: SEQUENCER_RECEIPT,
      importedSkeletalMeshCount: 1,
      appliedMaterialCount: 3,
      appliedTextureCount: 2,
      omittedMaterialCount: 1,
      omittedMaterials: [
        {
          directorId: "prop-glass",
          code: "unsupported_channels",
          reason:
            "Object prop-glass: Director material channels transmission have no faithful Director parent mapping; omitted (warn-and-omit code: unsupported_channels).",
        },
      ],
      importedLightCount: 2,
      omittedLightCount: 1,
      omittedLights: [
        {
          directorId: "light_ambient_1",
          lightType: "ambient",
          reason: "Uniform ambient light has no single-actor Unreal equivalent (warn-and-omit).",
        },
      ],
    });
    const result = await harness.send();
    expect(result.report.sequencer).toEqual(SEQUENCER_RECEIPT);
    expect(result.report.importedSkeletalMeshCount).toBe(1);
    expect(result.report.appliedMaterialCount).toBe(3);
    expect(result.report.appliedTextureCount).toBe(2);
    expect(result.report.omittedMaterialCount).toBe(1);
    expect(result.report.omittedMaterials).toEqual([
      expect.objectContaining({ directorId: "prop-glass", code: "unsupported_channels" }),
    ]);
    expect(result.report.importedLightCount).toBe(2);
    expect(result.report.omittedLightCount).toBe(1);
    expect(result.report.omittedLights).toEqual([
      expect.objectContaining({ directorId: "light_ambient_1", lightType: "ambient" }),
    ]);
  });

  it("returns typed omittedSkeletal records on the Unreal send report", async () => {
    const harness = await createSendHarness({
      omittedSkeletalCount: 2,
      omittedSkeletal: [
        {
          directorId: "hero",
          code: "character_unskinned",
          reason: "Character hero references a GLB without a skin; it was imported without a skeleton (warn-and-omit).",
        },
        {
          directorId: "prop-1",
          code: "empty_actor",
          reason:
            "Object prop-1 references asset asset-missing that is not a GLB payload; spawned as an empty actor (warn-and-omit).",
        },
      ],
    });
    const result = await harness.send();
    expect(result.report.omittedSkeletalCount).toBe(2);
    expect(result.report.omittedSkeletal).toEqual([
      expect.objectContaining({ directorId: "hero", code: "character_unskinned" }),
      expect.objectContaining({ directorId: "prop-1", code: "empty_actor" }),
    ]);
  });

  it("fails the job when omittedMaterials length disagrees with omittedMaterialCount", async () => {
    const harness = await createSendHarness({
      omittedMaterialCount: 0,
      omittedMaterials: [
        {
          directorId: "prop-x",
          code: "no_mesh_target",
          reason: "Object prop-x has a Director material but no mesh component (warn-and-omit code: no_mesh_target).",
        },
      ],
    });
    await expect(harness.send()).rejects.toMatchObject({ code: "engine_report_invalid" });
  });

  it("returns typed omittedShots records on the Unreal send report", async () => {
    const harness = await createSendHarness({
      omittedShotCount: 2,
      omittedShots: [
        {
          shotId: "shot-orphan",
          code: "shot_no_camera_binding",
          cameraDirectorId: null,
          reason:
            "Shot shot-orphan has no camera binding; no camera cut section was added (warn-and-omit code: shot_no_camera_binding).",
        },
        {
          shotId: "shot-ghost",
          code: "shot_camera_not_imported",
          cameraDirectorId: "cam-ghost",
          reason:
            "Shot shot-ghost references camera cam-ghost which was not imported; its cut was skipped (warn-and-omit code: shot_camera_not_imported).",
        },
      ],
    });
    const result = await harness.send();
    expect(result.report.omittedShotCount).toBe(2);
    expect(result.report.omittedShots).toEqual([
      expect.objectContaining({ shotId: "shot-orphan", code: "shot_no_camera_binding", cameraDirectorId: null }),
      expect.objectContaining({ shotId: "shot-ghost", code: "shot_camera_not_imported", cameraDirectorId: "cam-ghost" }),
    ]);
  });

  it("fails the job when omittedShots length disagrees with omittedShotCount", async () => {
    const harness = await createSendHarness({
      omittedShotCount: 0,
      omittedShots: [
        {
          shotId: "shot-orphan",
          code: "shot_no_camera_binding",
          cameraDirectorId: null,
          reason:
            "Shot shot-orphan has no camera binding; no camera cut section was added (warn-and-omit code: shot_no_camera_binding).",
        },
      ],
    });
    await expect(harness.send()).rejects.toMatchObject({ code: "engine_report_invalid" });
  });

  it("fails the job when omittedLights length disagrees with omittedLightCount", async () => {
    const harness = await createSendHarness({
      omittedLightCount: 0,
      omittedLights: [
        {
          directorId: "light_ambient_1",
          lightType: "ambient",
          reason: "Uniform ambient light has no single-actor Unreal equivalent (warn-and-omit).",
        },
      ],
    });
    await expect(harness.send()).rejects.toMatchObject({ code: "engine_report_invalid" });
  });

  it("fails the job when the connector reports a malformed omitted-light record", async () => {
    const harness = await createSendHarness({
      omittedLights: [{ directorId: "light-1", lightType: "laser", reason: "not a Director light type" }],
    });
    await expect(harness.send()).rejects.toMatchObject({ code: "engine_report_invalid" });
  });

  it("keeps the receipt optional so static imports stay valid", async () => {
    const harness = await createSendHarness();
    const result = await harness.send();
    expect(result.report.sequencer).toBeUndefined();
    expect(result.report.importedSkeletalMeshCount).toBeUndefined();
  });

  it("fails the job when the connector returns a malformed Sequencer receipt", async () => {
    const harness = await createSendHarness({
      sequencer: { ...SEQUENCER_RECEIPT, displayRate: "23.976 fps" },
    });
    await expect(harness.send()).rejects.toMatchObject({ code: "engine_report_invalid" });
  });
});

function riggedProject(): DirectorProject {
  const project = animatedProject();
  const [walker] = project.objects;
  walker!.kind = "character";
  walker!.characterRig = { rigType: "mannequin", posePresetId: null, controls: {} };
  walker!.animation!.keyframes[1]!.poseValues = { "arm.L": 0.5 };
  return project;
}

describe("Unreal engine bridge structured pose-channel omissions", () => {
  it("reports omitted Control-Rig-style channels as data on the send result, from the Gateway's own bake", async () => {
    const harness = await createSendHarness({}, { project: riggedProject() });
    const result = await harness.send();
    expect(result.omittedAnimationChannels).toEqual([
      {
        directorId: "hero-crate",
        entityType: "object",
        channels: expect.arrayContaining(["pose_values", "character_rig"]),
        details: expect.arrayContaining([
          expect.objectContaining({ channel: "pose_values", controls: ["arm.L"] }),
          expect.objectContaining({ channel: "character_rig" }),
        ]),
      },
    ]);
    // The prose warning still exists, but the structured field is the contract.
    expect(result.warnings.join("\n")).toMatch(/warn-and-omit/);
  });

  it("omits the structured field entirely when every channel was carried", async () => {
    const harness = await createSendHarness();
    const result = await harness.send();
    expect(result.omittedAnimationChannels).toBeUndefined();
  });

  it("accepts the connector's structured omission echo on the report, including details", async () => {
    const echoed = [
      {
        directorId: "walker-1",
        entityType: "object",
        channels: ["pose_values"],
        details: [
          {
            channel: "pose_values",
            controls: ["arm.L", "arm.R"],
            reason: "Semantic pose keyframes are not carried by the Sequencer bake.",
          },
        ],
      },
    ];
    const harness = await createSendHarness({ omittedAnimationChannels: echoed });
    const result = await harness.send();
    expect(result.report.omittedAnimationChannels).toEqual(echoed);
  });
});

describe("Unreal engine bridge clean-frame wiring", () => {
  it("runs a second offscreen render invocation and attaches the hash-verified receipt", async () => {
    const harness = await createSendHarness({}, { cleanFrame: true });
    const result = await harness.send();

    const invocations = harness.observedInvocations();
    expect(invocations).toHaveLength(2);
    const importArgs = invocations[0]!;
    expect(importArgs).toContain("-nullrhi");
    const renderArgs = invocations[1]!;
    expect(renderArgs).toContain("-RenderOffscreen");
    expect(renderArgs).not.toContain("-nullrhi");
    expect(renderArgs.find((argument) => argument.startsWith("-ExecCmds=py "))).toContain("--mode render");

    expect(result.cleanFrame).toMatchObject({ status: "rendered", imagePath: "clean-frame.png" });
  });

  it("keeps the handoff successful with a skipped receipt when the render produces nothing", async () => {
    const harness = await createSendHarness({}, { cleanFrame: true, renderWritesReceipt: false });
    const result = await harness.send();
    expect(result.report.importedObjectCount).toBe(1);
    expect(result.cleanFrame).toMatchObject({
      status: "skipped",
      skipReason: expect.stringMatching(/readable/i),
    });
    expect(result.warnings.join("\n")).toMatch(/Clean-frame render was skipped/);
  });

  it("runs no render invocation and attaches no receipt when clean_frame is not requested", async () => {
    const harness = await createSendHarness();
    const result = await harness.send();
    expect(harness.observedInvocations()).toHaveLength(1);
    expect(result.cleanFrame).toBeUndefined();
  });
});

describe("Unreal executable probes (macOS/Linux/Windows layouts)", () => {
  it("reads Build.version through the Engine/Binaries/<Platform> layout without booting the editor", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "director-unreal-linux-probe-"));
    const executable = resolve(root, "Engine", "Binaries", "Linux", "UnrealEditor-Cmd");
    await mkdir(dirname(executable), { recursive: true });
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const buildVersion = resolve(root, "Engine", "Build", "Build.version");
    await mkdir(dirname(buildVersion), { recursive: true });
    await writeFile(buildVersion, JSON.stringify({ MajorVersion: 5, MinorVersion: 6, PatchVersion: 1 }), "utf8");

    const bridge = createDirectorDccEngineBridge({
      workspaceRoot: repositoryRoot,
      dataDirectory: resolve(root, "data"),
      exchangePackager: { exportPackage: vi.fn() },
      environment: { PATH: "", [DIRECTOR_ENGINE_BINARY_ENV.unreal]: executable },
      // No probeHostVersion override: the default Build.version reader runs.
      runProcess: vi.fn(async () => ({ stdout: "", stderr: "" })),
      healthTtlMs: 0,
    });
    const health = await bridge.health("unreal");
    expect(health.executable).toBe(executable);
    expect(health.hostVersion).toBe("Unreal Engine 5.6.1");
  });

  it("discovers the Windows UnrealEditor-Cmd.exe command name on PATH", async () => {
    const binDirectory = await mkdtemp(resolve(tmpdir(), "director-unreal-windows-probe-"));
    const executable = resolve(binDirectory, "UnrealEditor-Cmd.exe");
    await writeFile(executable, "fixture", { mode: 0o755 });

    const bridge = createDirectorDccEngineBridge({
      workspaceRoot: repositoryRoot,
      dataDirectory: resolve(binDirectory, "data"),
      exchangePackager: { exportPackage: vi.fn() },
      environment: { PATH: binDirectory },
      probeHostVersion: async () => "Unreal Engine 5.6.1",
      runProcess: vi.fn(async () => ({ stdout: "", stderr: "" })),
      healthTtlMs: 0,
    });
    const health = await bridge.health("unreal");
    expect(health.executable).toBe(executable);
  });
});

const liveUnrealBinary = process.env[DIRECTOR_ENGINE_BINARY_ENV.unreal];

describe.skipIf(!liveUnrealBinary)(
  "live Unreal Editor health probe (skipped: set DIRECTOR_UNREAL_EDITOR_BIN to an UnrealEditor-Cmd binary to enable)",
  () => {
    it("probes the configured editor binary and returns a contract-valid health result", async () => {
      const bridge = createDirectorDccEngineBridge({
        workspaceRoot: repositoryRoot,
        dataDirectory: await mkdtemp(resolve(tmpdir(), "director-unreal-live-")),
        exchangePackager: { exportPackage: vi.fn() },
        healthTtlMs: 0,
      });
      const health = directorDccEngineHealthSchema.parse(await bridge.health("unreal"));
      expect(health.provider).toBe("unreal");
      expect(health.executable).toBeTruthy();
    }, 120_000);
  },
);
