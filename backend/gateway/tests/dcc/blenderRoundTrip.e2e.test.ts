import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { directorDccScenePackageSchema } from "@director/dcc-protocol";
import { directorDccReturnManifestSchema } from "@director/dcc-protocol";
import { createTestDirectorProject } from "../fixtures/createTestDirectorProject";
import { createBlenderBridge, discoverBlenderExecutable } from "../../dcc/blenderBridge";
import { createBlenderReturnImporter } from "../../dcc/blenderReturnImport";

const PROCESS_TIMEOUT_MS = 240_000;
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const forced = process.env.DIRECTOR_BLENDER_E2E === "1";
const blenderExecutable = await discoverBlenderExecutable();
const blenderTest = blenderExecutable || forced ? test : test.skip;

function runBlender(executable: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveProcess, rejectProcess) => {
    execFile(
      executable,
      args,
      { timeout: PROCESS_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          rejectProcess(
            new Error(`Blender E2E process failed: ${error.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`, {
              cause: error,
            }),
          );
          return;
        }
        resolveProcess({ stdout, stderr });
      },
    );
  });
}

function parseMarkedJson(stdout: string, marker: string): Record<string, unknown> {
  const line = stdout.split(/\r?\n/).find((candidate) => candidate.startsWith(marker));
  if (!line) throw new Error(`Blender output did not contain ${marker}.\n${stdout}`);
  return JSON.parse(line.slice(marker.length)) as Record<string, unknown>;
}

blenderTest(
  "round-trips an untouched transformed primitive and camera without changes while preserving exact timebase",
  async () => {
    if (!blenderExecutable) {
      throw new Error("DIRECTOR_BLENDER_E2E=1 requires Blender. Set DIRECTOR_BLENDER_BIN or install Blender.app.");
    }

    const temporaryRoot = await mkdtemp(resolve(tmpdir(), "director-blender-roundtrip-e2e-"));
    try {
      const dataDirectory = resolve(temporaryRoot, "data");
      const project = createTestDirectorProject();
      project.scene.timeline = {
        version: 1,
        fps: 30_000 / 1_001,
        timebase: {
          rate: { numerator: 30_000, denominator: 1_001 },
          dropFrame: true,
          startTimecode: "01:00:00;00",
        },
        frameStart: 0,
        frameEnd: 48,
        currentFrame: 17,
        loop: false,
      };
      project.objects.push({
        id: "primitive-e2e",
        name: "Transformed primitive",
        kind: "prop",
        visible: true,
        locked: false,
        geometryType: "box",
        color: "#B78B42",
        transform: {
          position: [1.25, 2.5, -3.75],
          rotation: [0.2, -0.35, 0.5],
          scale: [1.25, 0.75, 1.5],
        },
      });
      project.cameras.push({
        id: "camera-e2e",
        name: "Target-authoritative camera",
        fov: 42,
        focalLengthMm: 47,
        apertureFStop: 2.8,
        focusDistanceM: 6.5,
        shutterAngle: 172.8,
        iso: 640,
        nearClipM: 0.1,
        farClipM: 500,
        anamorphicSqueeze: 1,
        aspectRatio: "16:9",
        transform: {
          position: [4.5, 3.25, 6.75],
          rotation: [0.31, -0.47, 0.22],
          scale: [1, 1, 1],
        },
        targetMode: "manual",
        // Deliberately inconsistent with rotation: the bridge evaluates the
        // target once, then must baseline that result instead of returning a
        // false-positive camera transform on an untouched round trip.
        target: [-8, 1.25, 2.5],
      });
      project.activeCameraId = "camera-e2e";

      const bridge = createBlenderBridge({
        workspaceRoot,
        dataDirectory,
        blenderExecutable,
        timeoutMs: PROCESS_TIMEOUT_MS,
      });
      const exported = await bridge.exportBlend(project, {
        renderPreview: true,
        cameraId: "camera-e2e",
        frame: 17,
      });

      expect(exported.objectCount).toBe(1);
      expect(exported.cameraCount).toBe(1);
      expect(exported.previewPath).not.toBeNull();
      const blendStat = await stat(exported.blendPath);
      expect(blendStat.isFile()).toBe(true);
      expect(blendStat.size).toBeGreaterThan(0);
      expect((await stat(exported.previewPath!)).size).toBeGreaterThan(0);

      const scenePackage = directorDccScenePackageSchema.parse(
        JSON.parse(await readFile(exported.packagePath, "utf8")) as unknown,
      );
      expect(scenePackage.timeline.timebase).toEqual({
        rate: { numerator: 30_000, denominator: 1_001 },
        dropFrame: true,
        startTimecode: "01:00:00;00",
      });

      const inspectMarker = "DIRECTOR_BLENDER_E2E_TIMEBASE:";
      const inspectExpression = [
        "import bpy,json",
        "s=bpy.context.scene",
        `print(${JSON.stringify(inspectMarker)}+json.dumps({'fps':s.render.fps,'fps_base':s.render.fps_base,` +
          "'numerator':s.get('director_timebase_numerator'),'denominator':s.get('director_timebase_denominator')," +
          "'drop_frame':s.get('director_timebase_drop_frame')," +
          "'start_timecode':s.get('director_timebase_start_timecode')},sort_keys=True))",
      ].join(";");
      const inspected = parseMarkedJson(
        (await runBlender(blenderExecutable, ["--background", exported.blendPath, "--python-expr", inspectExpression]))
          .stdout,
        inspectMarker,
      );
      expect(inspected).toMatchObject({
        fps: 30,
        numerator: 30_000,
        denominator: 1_001,
        drop_frame: true,
        start_timecode: "01:00:00;00",
      });
      expect(inspected.fps_base).toBeCloseTo(1.001, 6);
      // Blender stores fps_base as a 32-bit float; the exact ratio remains in
      // the integer scene properties above while playback stays 29.97, not 30.
      expect(Number(inspected.fps) / Number(inspected.fps_base)).toBeCloseTo(30_000 / 1_001, 5);

      const returnDirectory = resolve(dirname(exported.blendPath), "return-package");
      const returnReport = resolve(returnDirectory, "report.json");
      const returnScript = resolve(
        workspaceRoot,
        "integrations",
        "blender",
        "interchange",
        "director_return_export.py",
      );
      await runBlender(blenderExecutable, [
        "--background",
        exported.blendPath,
        "--python",
        returnScript,
        "--",
        "--source-manifest",
        exported.packagePath,
        "--output-dir",
        returnDirectory,
        "--report",
        returnReport,
      ]);

      const returnManifest = directorDccReturnManifestSchema.parse(
        JSON.parse(await readFile(resolve(returnDirectory, "manifest.json"), "utf8")) as unknown,
      );
      expect(returnManifest.sourcePackageId).toBe(scenePackage.packageId);
      expect(returnManifest.sourceRevision).toBe(exported.sourceRevision);
      expect(returnManifest.changes).toEqual([]);
      expect(returnManifest.fileHashes).toEqual({});
      expect(returnManifest.changes.some((change) => change.entityType === "camera")).toBe(false);

      const importer = createBlenderReturnImporter({ workspaceRoot, dataDirectory });
      const plan = await importer.buildImportPlan(returnDirectory, project);
      expect(plan).toMatchObject({ ready: true, operations: [], conflicts: [] });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  },
  PROCESS_TIMEOUT_MS,
);
