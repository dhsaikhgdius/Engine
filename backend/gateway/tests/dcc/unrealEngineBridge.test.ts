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
  for (const file of [
    "Project.uproject",
    "Plugins/DirectorBridge/DirectorBridge.uplugin",
    "Plugins/DirectorBridge/Content/Python/director_headless.py",
  ]) {
    const path = resolve(projectDirectory, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "fixture", "utf8");
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
}

async function createSendHarness(reportExtras: Record<string, unknown> = {}): Promise<SendHarness> {
  const setup = await temporaryUnrealSetup();
  const jobId = randomUUID();
  const packageDirectory = resolve(setup.dataDirectory, "dcc-jobs", "exchange", "unreal", jobId);
  await mkdir(packageDirectory, { recursive: true });
  const exportPackage = vi.fn().mockResolvedValue(fakeExchangeResult(packageDirectory, jobId));
  const observed: string[][] = [];
  const version = await connectorVersion();

  const runProcess = vi.fn(async (_executable: string, args: string[]) => {
    observed.push(args);
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
    send: () => bridge.send(animatedProject(), { provider: "unreal", formats: ["usda"] }),
    observedScriptArguments: () => observed[0]!.find((argument) => argument.startsWith("-ExecutePythonScript="))!,
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
    });
    const result = await harness.send();
    expect(result.report.sequencer).toEqual(SEQUENCER_RECEIPT);
    expect(result.report.importedSkeletalMeshCount).toBe(1);
    expect(result.report.appliedMaterialCount).toBe(3);
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
