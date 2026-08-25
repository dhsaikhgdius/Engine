import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { Matrix4, Quaternion, Vector3 } from "three";
import {
  directorDccEngineReportSchema,
  directorDccExchangePackageManifestSchema,
  directorDccReturnManifestSchema,
  directorTransformToCanonicalDcc,
  type DirectorDccTransform,
} from "@director/dcc-protocol";
import type { DirectorProject } from "@director/project-schema";
import { writeGodotAnimationBake } from "../../dcc/godotAnimationBake";
import { createTestDirectorProject } from "../fixtures/createTestDirectorProject";

const execFileAsync = promisify(execFile);

const repositoryRoot = resolve(__dirname, "..", "..", "..", "..");
const addonSource = resolve(repositoryRoot, "integrations", "godot", "addons");
const fixtureGeneratorSource = resolve(repositoryRoot, "backend", "gateway", "tests", "fixtures", "godot");
const CONNECTOR_VERSION = (
  JSON.parse(readFileSync(resolve(repositoryRoot, "integrations", "godot", "connector.json"), "utf8")) as {
    version: string;
  }
).version;

/**
 * Real host roundtrip: runs the committed connector inside an actual Godot 4
 * binary. Enable with DIRECTOR_GODOT_BIN=/path/to/godot4; skipped otherwise so
 * host-free environments stay green. Everything the test asserts is read back
 * from connector outputs (report receipt, saved scene, return packages).
 */
const godotBin = process.env.DIRECTOR_GODOT_BIN;
const hasGodot = Boolean(godotBin && existsSync(godotBin));

const PACKAGE_ID = randomUUID();
const REVISION = `director-project-revision:v1:sha256:${"d".repeat(64)}`;

const CHILD_TRANSFORM = {
  // Mirrored: negative X scale with a non-trivial rotation.
  position: [1.5, 0.5, -2] as [number, number, number],
  rotation: [0.3, 0.5, -0.2] as [number, number, number],
  scale: [-1, 1, 1] as [number, number, number],
};

function buildFixtureProject(): DirectorProject {
  const project = createTestDirectorProject();
  project.scene.timeline = {
    version: 1,
    fps: 23.976,
    timebase: { rate: { numerator: 24000, denominator: 1001 }, dropFrame: false, startTimecode: "00:00:00:00" },
    frameStart: 0,
    frameEnd: 24,
    currentFrame: 0,
    loop: false,
  };
  project.assets = [
    { id: "asset-fixture", kind: "prop", sourceType: "model", fileName: "box.glb", url: "assets/box.glb" },
  ];
  project.objects = [
    {
      id: "obj-box",
      name: "Fixture Box",
      kind: "prop",
      visible: true,
      locked: false,
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      assetRefId: "asset-fixture",
      material: { baseColor: "#3366ff", metalness: 0.5, roughness: 0.25, transmission: 0.5 },
      animation: {
        version: 1,
        keyframes: [
          { frame: 0, transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
          { frame: 24, transform: { position: [2, 0, 0], rotation: [0, Math.PI / 2, 0], scale: [1, 1, 1] } },
        ],
      },
    },
    {
      id: "obj-child",
      name: "Mirrored Child",
      kind: "prop",
      visible: true,
      locked: false,
      parentObjectId: "obj-box",
      transform: CHILD_TRANSFORM,
    },
  ];
  project.cameras = [
    {
      id: "cam-main",
      name: "Main Camera",
      fov: 40,
      transform: { position: [0, 2, 8], rotation: [0, 0, 0], scale: [1, 1, 1] },
      targetMode: "manual",
      target: [0, 1, 0],
      animation: {
        version: 1,
        keyframes: [
          { frame: 0, fov: 40 },
          { frame: 24, fov: 60 },
        ],
      },
    },
  ];
  project.lights = [
    {
      id: "light-key",
      name: "Key",
      type: "point",
      visible: true,
      locked: false,
      color: "#ffffff",
      intensity: 2,
      position: [3, 4, 2],
      distance: 30,
      decay: 2,
    },
    {
      id: "light-spot",
      name: "Spot",
      type: "spot",
      visible: true,
      locked: false,
      color: "#ffddaa",
      intensity: 3,
      position: [0, 5, 0],
      target: [0, 0, 0],
      angle: 0.6,
      penumbra: 0.4,
    },
    {
      id: "light-sun",
      name: "Sun",
      type: "directional",
      visible: true,
      locked: false,
      color: "#fff4e0",
      intensity: 1.2,
      position: [10, 10, 10],
      target: [0, 0, 0],
    },
    {
      id: "light-amb",
      name: "Ambient",
      type: "ambient",
      visible: true,
      locked: false,
      color: "#334455",
      intensity: 0.4,
    },
    {
      id: "light-rect",
      name: "Rect fill",
      type: "rect-area",
      visible: true,
      locked: false,
      color: "#ffffff",
      intensity: 1,
      position: [0, 2, -3],
      width: 2,
      height: 1,
    },
  ];
  project.storyboard = {
    version: 1,
    title: "Fixture board",
    logline: "Camera cuts for the roundtrip fixture.",
    shots: [
      {
        id: "shot-1",
        title: "Opening",
        cameraId: "cam-main",
        frameStart: 0,
        frameEnd: 12,
        shotSize: "wide",
        movement: "static",
        action: "Box slides in.",
      },
      {
        id: "shot-2",
        title: "Unbound",
        cameraId: null,
        frameStart: 12,
        frameEnd: 24,
        shotSize: "medium",
        movement: "static",
        action: "No camera bound; must warn-and-omit.",
      },
    ],
  };
  return project;
}

function sha256(bytes: Buffer | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeManifest(packageDirectory: string, project: DirectorProject, glbBytes: Buffer) {
  const manifest = directorDccExchangePackageManifestSchema.parse({
    contract: "director-dcc-exchange-package-v1",
    packageId: PACKAGE_ID,
    provider: "godot",
    sourceRevision: REVISION,
    createdAt: new Date().toISOString(),
    coordinateSystem: { linearUnit: "meter", metersPerUnit: 1, upAxis: "Y", handedness: "right", cameraForward: "-Z" },
    project,
    formats: [],
    assets: [
      {
        assetRefId: "asset-fixture",
        relativePath: "assets/box.glb",
        sha256: sha256(glbBytes),
        byteLength: glbBytes.byteLength,
      },
    ],
    warnings: [],
  });
  await writeFile(resolve(packageDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function matrixOf(transform: DirectorDccTransform): Matrix4 {
  return new Matrix4().compose(
    new Vector3(...transform.location),
    new Quaternion(...transform.rotationQuaternion).normalize(),
    new Vector3(...transform.scale),
  );
}

function expectMatrixClose(actual: Matrix4, expected: Matrix4, tolerance = 1e-4) {
  actual.elements.forEach((element, index) => {
    expect(Math.abs(element - expected.elements[index]!)).toBeLessThanOrEqual(tolerance);
  });
}

async function runGodot(projectDirectory: string, userArgs: string[]) {
  return execFileAsync(
    godotBin!,
    [
      "--headless",
      "--path",
      projectDirectory,
      "--script",
      "res://addons/director_bridge/director_headless.gd",
      "--",
      ...userArgs,
    ],
    { timeout: 120_000 },
  );
}

describe.skipIf(!hasGodot)("Godot headless roundtrip (set DIRECTOR_GODOT_BIN to enable)", () => {
  let projectDirectory: string;
  let packageDirectory: string;
  let jobDirectory: string;
  let reportPath: string;
  let returnDirectory: string;
  let bakePath: string;
  let bakeSha256: string;
  const project = buildFixtureProject();

  beforeAll(async () => {
    const root = await mkdtemp(resolve(tmpdir(), "director-godot-roundtrip-"));
    projectDirectory = resolve(root, "project");
    packageDirectory = resolve(root, "package");
    jobDirectory = resolve(root, "job");
    reportPath = resolve(jobDirectory, "report.json");
    returnDirectory = resolve(jobDirectory, "return");
    await mkdir(resolve(packageDirectory, "assets"), { recursive: true });
    await mkdir(jobDirectory, { recursive: true });
    await mkdir(projectDirectory, { recursive: true });

    await writeFile(
      resolve(projectDirectory, "project.godot"),
      [
        "config_version=5",
        "",
        "[application]",
        "",
        'config/name="DirectorRoundtripFixture"',
        "",
        "[editor_plugins]",
        "",
        'enabled=PackedStringArray("res://addons/director_bridge/plugin.cfg")',
        "",
      ].join("\n"),
      "utf8",
    );
    await cp(addonSource, resolve(projectDirectory, "addons"), { recursive: true });
    await cp(fixtureGeneratorSource, resolve(projectDirectory, "fixtures"), { recursive: true });

    // Generate the payload GLB (textured box + skinned skeleton + payload animation).
    const glbPath = resolve(packageDirectory, "assets", "box.glb");
    await execFileAsync(
      godotBin!,
      [
        "--headless",
        "--path",
        projectDirectory,
        "--script",
        "res://fixtures/generate_fixture_glb.gd",
        "--",
        "--output",
        glbPath,
      ],
      { timeout: 120_000 },
    );
    const glbBytes = await readFile(glbPath);
    expect(glbBytes.byteLength).toBeGreaterThan(0);

    await writeManifest(packageDirectory, project, glbBytes);
    const bake = await writeGodotAnimationBake(project, PACKAGE_ID, REVISION, jobDirectory);
    bakePath = bake.bakePath;
    bakeSha256 = bake.bakeSha256;
  }, 240_000);

  it("connector health responds with a Godot 4.x health JSON line", async () => {
    const { stdout } = await runGodot(projectDirectory, ["--mode", "health"]);
    const line = stdout.split(/\r?\n/).find((candidate) => candidate.trim().startsWith("{"));
    expect(line).toBeDefined();
    expect(JSON.parse(line!)).toMatchObject({ ok: true, provider: "godot", connectorVersion: CONNECTOR_VERSION });
  }, 120_000);

  it("imports scene, hierarchy, lights, materials, skeleton, and baked animation with an honest receipt", async () => {
    await runGodot(projectDirectory, [
      "--mode",
      "import",
      "--package",
      packageDirectory,
      "--report",
      reportPath,
      "--return-dir",
      returnDirectory,
      "--animation",
      bakePath,
      "--animation-sha256",
      bakeSha256,
    ]);
    const report = directorDccEngineReportSchema.parse(JSON.parse(await readFile(reportPath, "utf8")));
    expect(report.provider).toBe("godot");
    expect(report.packageId).toBe(PACKAGE_ID);
    expect(report.importedObjectCount).toBe(2);
    expect(report.importedCameraCount).toBe(1);

    const receipt = report.godot!;
    expect(receipt).toBeDefined();
    expect(receipt.importedLightCount).toBe(3);
    expect(receipt.worldEnvironmentAmbient).toBe(true);
    expect(receipt.omittedLightCount).toBe(1);
    expect(receipt.importedSkeletonCount).toBe(1);
    expect(receipt.appliedMaterialCount).toBe(1);
    expect(receipt.payloadAnimationPlayerCount).toBe(1);
    expect(receipt.externalizedTextureCount).toBeGreaterThanOrEqual(1);
    expect(receipt.transformTrackCount).toBe(2);
    expect(receipt.fovTrackCount).toBe(1);
    expect(receipt.shotCutTrackCount).toBe(1);
    expect(receipt.mappedShotCount).toBe(1);
    // 25 frames x 3 transform keys x 2 entities + 25 fov keys + 1 camera cut.
    expect(receipt.bakedKeyCount).toBe(176);
    expect(receipt.animationLibrary).toBe("director");
    expect(receipt.displayRate).toBe("24000/1001");
    expect(receipt.animationPlayerPath).toBe(report.scenePath);

    // Warn-and-omit honesty: unsupported light, shot, and material channels
    // warn with structured codes.
    expect(report.warnings.join("\n")).toMatch(/light_rect_area_unsupported/);
    expect(report.warnings.join("\n")).toMatch(/shot_no_camera_binding/);
    expect(report.warnings.join("\n")).toMatch(/transmission/);

    const scenePath = report.scenePath!.replace("res://", `${projectDirectory}/`);
    const sceneText = await readFile(scenePath, "utf8");
    expect(sceneText).toContain("DirectorAnimationPlayer");
    expect(sceneText).toContain("DirectorWorldEnvironment");
    expect(sceneText).toContain("res://director/textures/");
    expect(sceneText).toContain("Skeleton3D");
  }, 240_000);

  it("echo return package reproduces the mirrored child's world matrix in canonical space", async () => {
    const returned = directorDccReturnManifestSchema.parse(
      JSON.parse(await readFile(resolve(returnDirectory, "manifest.json"), "utf8")),
    );
    expect(returned.provider).toBe("godot");
    const child = returned.changes.find((change) => change.directorId === "obj-child");
    expect(child).toBeDefined();
    expect(child!.kind).toBe("transform_update");
    const expected = directorTransformToCanonicalDcc(CHILD_TRANSFORM, {
      position: [...project.scene.position] as [number, number, number],
      rotation: [...project.scene.rotation] as [number, number, number],
      scale: [project.scene.scale, project.scene.scale, project.scene.scale],
    });
    // Godot decomposes mirrored transforms differently from three.js
    // (determinant sign spread across all scale axes), so the roundtrip
    // contract is matrix-level equality, not component equality.
    expectMatrixClose(matrixOf((child as { transform: DirectorDccTransform }).transform), matrixOf(expected));
  }, 120_000);

  it("export detects baseline drift for objects only and skips skeleton/light tags", async () => {
    const movedProject = structuredClone(project);
    movedProject.objects[0]!.transform.position = [5, 0, 0];
    const movedPackageDirectory = resolve(jobDirectory, "moved-package");
    await mkdir(resolve(movedPackageDirectory, "assets"), { recursive: true });
    const glbBytes = await readFile(resolve(packageDirectory, "assets", "box.glb"));
    await writeFile(resolve(movedPackageDirectory, "assets", "box.glb"), glbBytes);
    await writeManifest(movedPackageDirectory, movedProject, glbBytes);

    const exportReturnDirectory = resolve(jobDirectory, "export-return");
    const exportReportPath = resolve(jobDirectory, "export-report.json");
    await runGodot(projectDirectory, [
      "--mode",
      "export",
      "--package",
      movedPackageDirectory,
      "--report",
      exportReportPath,
      "--return-dir",
      exportReturnDirectory,
    ]);
    const returned = directorDccReturnManifestSchema.parse(
      JSON.parse(await readFile(resolve(exportReturnDirectory, "manifest.json"), "utf8")),
    );
    // Only obj-box drifted from the moved baseline; the scene still holds
    // the original import. Skeleton and light tags never produce changes.
    expect(returned.changes.map((change) => change.directorId)).toEqual(["obj-box"]);
    const drifted = returned.changes[0] as { transform: DirectorDccTransform };
    const originalWorld = directorTransformToCanonicalDcc(project.objects[0]!.transform, {
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    });
    expectMatrixClose(matrixOf(drifted.transform), matrixOf(originalWorld));
    expect(returned.warnings.join("\n")).not.toMatch(/unknown director_id/);
  }, 240_000);

  it("refuses a tampered animation sidecar", async () => {
    const tamperedReport = resolve(jobDirectory, "tampered-report.json");
    const failure = await runGodot(projectDirectory, [
      "--mode",
      "import",
      "--package",
      packageDirectory,
      "--report",
      tamperedReport,
      "--return-dir",
      resolve(jobDirectory, "tampered-return"),
      "--animation",
      bakePath,
      "--animation-sha256",
      "0".repeat(64),
    ])
      .then(() => null)
      .catch((error: unknown) => error);
    expect(failure).not.toBeNull();
    const report = JSON.parse(await readFile(tamperedReport, "utf8")) as { ok: boolean; error: string };
    expect(report.ok).toBe(false);
    expect(report.error).toMatch(/SHA-256 mismatch/);
  }, 240_000);
});
