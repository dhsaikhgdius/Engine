import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { directorBlendSceneManifestSchema } from "../../../frontend/director/src/dcc/directorBlendSceneImportContract";

const execFileAsync = promisify(execFile);
const directory = dirname(fileURLToPath(import.meta.url));
const script = resolve(directory, "director_scene_export.py");
const PROCESS_TIMEOUT_MS = 180_000;

async function executable(path: string) {
  try {
    await access(path);
    return path;
  } catch {
    return null;
  }
}

const blenderExecutable =
  (process.env.DIRECTOR_BLENDER_BIN ? await executable(process.env.DIRECTOR_BLENDER_BIN) : null) ??
  (await executable("/Applications/Blender.app/Contents/MacOS/Blender"));
const blenderTest = blenderExecutable ? test : test.skip;

function runBlender(args: string[]) {
  if (!blenderExecutable) throw new Error("Blender is unavailable");
  return execFileAsync(blenderExecutable, args, {
    timeout: PROCESS_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    encoding: "utf8",
  });
}

function glbJson(bytes: Buffer) {
  expect(bytes.subarray(0, 4).toString("utf8")).toBe("glTF");
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32LE(offset);
    const type = bytes.readUInt32LE(offset + 4);
    if (type === 0x4e4f534a) {
      return JSON.parse(
        bytes
          .subarray(offset + 8, offset + 8 + length)
          .toString("utf8")
          .trim(),
      ) as {
        nodes?: Array<{ name?: string; scale?: number[]; children?: number[] }>;
        scenes?: Array<{ nodes?: number[] }>;
        animations?: unknown[];
        materials?: unknown[];
      };
    }
    offset += 8 + length;
  }
  throw new Error("GLB JSON chunk is missing");
}

describe("arbitrary Blender scene exporter", () => {
  it("is import-safe without bpy and documents the server CLI", async () => {
    const { stdout } = await execFileAsync("python3", [script, "--", "--help"]);
    expect(stdout).toContain("--source-blend");
    expect(stdout).toContain("--output-dir");
    expect(stdout).toContain("--report");

    const source = await readFile(script, "utf8");
    expect(source).toContain('CONTRACT = "director-blend-scene-v1"');
    expect(source).toContain("apply_meter_root");
    expect(source).not.toMatch(/\b(?:eval|exec)\s*\(/);
    expect(source).not.toMatch(/\b(?:requests|urllib)\b/);
  });

  blenderTest(
    "exports a metre-normalized scene bundle, animation, cameras, optics, and unsupported notices",
    async () => {
      const temporaryRoot = await mkdtemp(resolve(tmpdir(), "director-blend-scene-export-"));
      try {
        const sourceBlend = resolve(temporaryRoot, "source.blend");
        const outputDirectory = resolve(temporaryRoot, "package");
        const reportPath = resolve(temporaryRoot, "report.json");
        const fixtureExpression = [
          "import bpy",
          "bpy.ops.object.select_all(action='SELECT')",
          "bpy.ops.object.delete(use_global=False)",
          "s=bpy.context.scene",
          "s.unit_settings.system='METRIC'",
          "s.unit_settings.scale_length=0.01",
          "s.frame_start=1",
          "s.frame_end=48",
          "s.frame_set(12)",
          "s.render.fps=30",
          "s.render.fps_base=1.001",
          "s.render.resolution_x=2048",
          "s.render.resolution_y=858",
          "bpy.ops.mesh.primitive_cube_add(size=200,location=(100,0,100))",
          "o=bpy.context.object",
          "o.name='StageCube'",
          "m=bpy.data.materials.new('StageMaterial')",
          "m.diffuse_color=(0.2,0.4,0.8,1)",
          "o.data.materials.append(m)",
          "o.location.x=100",
          "o.keyframe_insert(data_path='location',frame=1)",
          "o.location.x=200",
          "o.keyframe_insert(data_path='location',frame=48)",
          "d=bpy.data.cameras.new('CameraData')",
          "d.lens=50",
          "d.sensor_width=36",
          "d.sensor_height=24",
          "d.dof.aperture_fstop=2.8",
          "d.dof.focus_distance=500",
          "d.clip_start=10",
          "d.clip_end=100000",
          "c=bpy.data.objects.new('CameraA',d)",
          "s.collection.objects.link(c)",
          "c.location=(200,-500,200)",
          "c.keyframe_insert(data_path='location',frame=1)",
          "c.keyframe_insert(data_path='location',frame=48)",
          "ld=bpy.data.lights.new('KeyData','POINT')",
          "l=bpy.data.objects.new('KeyLight',ld)",
          "s.collection.objects.link(l)",
          `bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(sourceBlend)})`,
        ].join(";");
        await runBlender([
          "--background",
          "--factory-startup",
          "--disable-autoexec",
          "--python-exit-code",
          "23",
          "--python-expr",
          fixtureExpression,
        ]);

        const { stdout } = await runBlender([
          "--background",
          "--factory-startup",
          "--disable-autoexec",
          "--disable-liboverride-auto-resync",
          sourceBlend,
          "--python-exit-code",
          "23",
          "--python",
          script,
          "--",
          "--source-blend",
          sourceBlend,
          "--output-dir",
          outputDirectory,
          "--report",
          reportPath,
        ]);
        expect(stdout).toContain("DIRECTOR_BLEND_SCENE_RESULT:");

        const manifest = directorBlendSceneManifestSchema.parse(
          JSON.parse(await readFile(resolve(outputDirectory, "manifest.json"), "utf8")) as unknown,
        );
        expect(manifest.scene).toMatchObject({
          bundleFile: "assets/scene.glb",
          objectCount: 1,
          meshCount: 1,
          materialCount: 1,
          actionCount: 1,
        });
        expect(manifest.timeline.timebase.rate).toEqual({ numerator: 30_000, denominator: 1_001 });
        expect(manifest.timeline.currentFrame).toBe(12);
        expect(manifest.timeline.fps).toBeCloseTo(30_000 / 1_001, 8);
        expect(manifest.cameras).toHaveLength(1);
        expect(manifest.cameras[0]).toMatchObject({
          name: "CameraA",
          focalLengthMm: 50,
          sensorWidthMm: 36,
          sensorHeightMm: 24,
          sensorFit: "auto",
          renderAspectRatio: 2048 / 858,
        });
        expect(manifest.cameras[0]!.transform.location[0]).toBeCloseTo(2, 5);
        expect(manifest.cameras[0]!.transform.location[1]).toBeCloseTo(-5, 5);
        expect(manifest.cameras[0]!.transform.location[2]).toBeCloseTo(2, 5);
        expect(manifest.cameras[0]!.focusDistanceM).toBeCloseTo(5, 5);
        expect(manifest.cameras[0]!.nearClipM).toBeCloseTo(0.1, 5);
        expect(manifest.cameras[0]!.farClipM).toBeCloseTo(1_000, 4);
        expect(manifest.unsupported).toContainEqual(expect.objectContaining({ kind: "light", name: "KeyLight" }));
        expect(manifest.warnings.join("\n")).toMatch(/scale_length=.*applied/);
        expect(manifest.warnings.join("\n")).toMatch(/CameraA animation is flattened/);

        const bundlePath = resolve(outputDirectory, "assets", "scene.glb");
        const bundle = await readFile(bundlePath);
        expect(manifest.fileHashes["assets/scene.glb"]).toBe(createHash("sha256").update(bundle).digest("hex"));
        const document = glbJson(bundle);
        expect(document.animations?.length).toBeGreaterThan(0);
        expect(document.materials?.length).toBe(1);
        expect(document.nodes?.some((node) => node.name === "CameraA" || node.name === "KeyLight")).toBe(false);
        const metreRoot = document.nodes?.find((node) => node.name === "Director_Meter_Root_1");
        expect(metreRoot?.scale?.[0]).toBeCloseTo(0.01, 8);
        expect(metreRoot?.children?.length).toBeGreaterThan(0);
        expect(document.scenes?.[0]?.nodes).toEqual([document.nodes!.indexOf(metreRoot!)]);

        const report = JSON.parse(await readFile(reportPath, "utf8")) as Record<string, unknown>;
        expect(report).toMatchObject({ ok: true, contract: "director-blend-scene-v1", objectCount: 1, cameraCount: 1 });
        expect((await stat(bundlePath)).size).toBeGreaterThan(0);
      } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    },
    PROCESS_TIMEOUT_MS,
  );
});
