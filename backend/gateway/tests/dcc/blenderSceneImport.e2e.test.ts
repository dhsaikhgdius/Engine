import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Vector3 } from "three";
import type { DirectorWorkbenchOperation } from "@director/agent-engine";
import { getCameraViewSnapshotFromShot } from "@director/project-schema";
import { getDirectorProjectRevision } from "@director/project-schema";
import { createTestDirectorProject } from "../fixtures/createTestDirectorProject";
import { discoverBlenderExecutable } from "../../dcc/blenderBridge";
import { createBlenderSceneImporter } from "../../dcc/blenderSceneImport";

const execFileAsync = promisify(execFile);
const PROCESS_TIMEOUT_MS = 240_000;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const blenderExecutable = await discoverBlenderExecutable();
const blenderTest = blenderExecutable ? test : test.skip;

function glbDocument(bytes: Buffer): {
  nodes?: Array<{ name?: string; scale?: number[] }>;
} {
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
      ) as { nodes?: Array<{ name?: string; scale?: number[] }> };
    }
    offset += 8 + length;
  }
  throw new Error("GLB JSON chunk is missing");
}

blenderTest(
  "ingests a real Blender scene through the default extractor and atomically applies its metric set and camera",
  async () => {
    if (!blenderExecutable) throw new Error("Blender is unavailable");

    const temporaryRoot = await mkdtemp(resolve(tmpdir(), "director-blender-scene-import-e2e-"));
    try {
      const workspaceRoot = resolve(temporaryRoot, "workspace");
      const dataDirectory = resolve(temporaryRoot, "data");
      const sourceBlend = resolve(temporaryRoot, "cinematic-set.blend");
      const temporaryExtractorDirectory = resolve(
        workspaceRoot,
        "integrations",
        "blender",
        "interchange",
      );
      await mkdir(temporaryExtractorDirectory, { recursive: true });
      await copyFile(
        resolve(repositoryRoot, "integrations", "blender", "interchange", "director_scene_export.py"),
        resolve(temporaryExtractorDirectory, "director_scene_export.py"),
      );

      const fixtureExpression = [
        "import bpy",
        "from mathutils import Vector",
        "bpy.ops.object.select_all(action='SELECT')",
        "bpy.ops.object.delete(use_global=False)",
        "s=bpy.context.scene",
        "s.name='Cinematic Metric Set'",
        "s.unit_settings.system='METRIC'",
        "s.unit_settings.scale_length=0.01",
        "s.frame_start=1",
        "s.frame_end=48",
        "s.frame_set(12)",
        "s.render.fps=24",
        "s.render.fps_base=1.0",
        "s.render.resolution_x=2048",
        "s.render.resolution_y=858",
        "s.render.resolution_percentage=100",
        "bpy.ops.mesh.primitive_cube_add(size=200,location=(100,0,100))",
        "o=bpy.context.object",
        "o.name='Two Metre Stage Cube'",
        "m=bpy.data.materials.new('Cinematic Blue')",
        "m.diffuse_color=(0.05,0.2,0.8,1.0)",
        "o.data.materials.append(m)",
        "d=bpy.data.cameras.new('Main Camera Data')",
        "d.lens=50",
        "d.sensor_width=36",
        "d.sensor_height=24",
        "d.dof.aperture_fstop=2.8",
        "d.dof.focus_distance=700",
        "d.clip_start=10",
        "d.clip_end=100000",
        "c=bpy.data.objects.new('Cinematic Main Camera',d)",
        "s.collection.objects.link(c)",
        "c.location=(400,-600,250)",
        "c.rotation_euler=(Vector((100,0,100))-c.location).to_track_quat('-Z','Y').to_euler()",
        "s.camera=c",
        `bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(sourceBlend)})`,
      ].join(";");
      await execFileAsync(
        blenderExecutable,
        [
          "--background",
          "--factory-startup",
          "--disable-autoexec",
          "--python-exit-code",
          "23",
          "--python-expr",
          fixtureExpression,
        ],
        { timeout: PROCESS_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
      );

      const project = createTestDirectorProject();
      const importer = createBlenderSceneImporter({
        workspaceRoot,
        dataDirectory,
        blenderExecutable,
        timeoutMs: PROCESS_TIMEOUT_MS,
      });
      const sourceSize = (await stat(sourceBlend)).size;
      const upload = await importer.ingestUpload(
        "cinematic-set.blend",
        createReadStream(sourceBlend),
        project,
        sourceSize,
      );

      expect(upload.plan).toMatchObject({ ready: true, conflicts: [] });
      expect(upload.manifest.coordinateSystem).toMatchObject({
        destination: "right-handed-y-up-negative-z-forward",
        unit: "meter",
        linearMap: "(x,y,z)->(x,z,-y)",
      });
      expect(upload.manifest.scene).toMatchObject({
        name: "Cinematic Metric Set",
        objectCount: 1,
        meshCount: 1,
        materialCount: 1,
      });
      expect(upload.manifest.cameras).toHaveLength(1);
      expect(upload.manifest.cameras[0]).toMatchObject({
        name: "Cinematic Main Camera",
        focalLengthMm: 50,
        renderAspectRatio: 2048 / 858,
      });
      expect(upload.manifest.cameras[0]!.transform.location).toEqual([
        expect.closeTo(4, 5),
        expect.closeTo(-6, 5),
        expect.closeTo(2.5, 5),
      ]);

      const sceneAssetOperation = upload.plan.operations.find((operation) => operation.op === "create_scene_asset");
      const sceneObjectOperation = upload.plan.operations.find((operation) => operation.op === "create_scene_object");
      const cameraOperation = upload.plan.operations.find((operation) => operation.op === "create_camera");
      expect(sceneAssetOperation?.op).toBe("create_scene_asset");
      expect(sceneObjectOperation).toMatchObject({
        op: "create_scene_object",
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      });
      expect(cameraOperation).toMatchObject({
        op: "create_camera",
        name: "Cinematic Main Camera",
        position: [expect.closeTo(4, 5), expect.closeTo(2.5, 5), expect.closeTo(6, 5)],
        focalLengthMm: expect.closeTo(49.936, 3),
        sensorFormat: "fullFrame",
        aspectRatio: "2.39:1",
      });
      if (cameraOperation?.op !== "create_camera") throw new Error("camera operation is missing");
      const importedForward = new Vector3(...cameraOperation.target)
        .sub(new Vector3(...cameraOperation.position))
        .normalize();
      const expectedForward = new Vector3(1, 1, 0).sub(new Vector3(4, 2.5, 6)).normalize();
      expect(importedForward.dot(expectedForward)).toBeCloseTo(1, 6);
      if (sceneAssetOperation?.op !== "create_scene_asset") throw new Error("scene asset operation is missing");

      const packageBundle = await readFile(
        resolve(dataDirectory, "dcc-jobs", "blender-import", upload.packagePath, sceneAssetOperation.glbPath),
      );
      const metreRoot = glbDocument(packageBundle).nodes?.find((node) => node.name === "Director_Meter_Root_1");
      expect(metreRoot?.scale).toEqual([expect.closeTo(0.01, 8), expect.closeTo(0.01, 8), expect.closeTo(0.01, 8)]);

      const revision = getDirectorProjectRevision(project);
      const applyAuthoring = vi.fn(async (_operation: DirectorWorkbenchOperation) => ({
        success: true,
        result: { idempotency: { key: "real-blender-scene-e2e", replayed: false } },
      }));
      const applied = await importer.applyImportPlan(
        upload.plan.planId,
        project,
        revision,
        "real-blender-scene-e2e",
        applyAuthoring,
      );

      expect(applyAuthoring).toHaveBeenCalledTimes(1);
      const operation = applyAuthoring.mock.calls[0]![0];
      expect(operation).toMatchObject({
        op: "replace_project",
        expected_revision: revision,
        idempotency_key: "real-blender-scene-e2e",
      });
      if (operation.op !== "replace_project") throw new Error("expected one atomic replace_project operation");
      const importedAsset = operation.project.assets.find((asset) => asset.id === sceneAssetOperation.assetId);
      expect(importedAsset).toMatchObject({
        kind: "scene",
        sourceType: "model",
        assetSource: "local",
        modelNormalization: "preserve",
        url: applied.copiedAssets[0]?.url,
      });
      expect(operation.project.objects).toContainEqual(
        expect.objectContaining({
          id: sceneObjectOperation?.op === "create_scene_object" ? sceneObjectOperation.objectId : undefined,
          kind: "scene",
          assetRefId: sceneAssetOperation.assetId,
          transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        }),
      );
      const importedCamera = operation.project.cameras.find((camera) => camera.name === "Cinematic Main Camera");
      expect(importedCamera).toMatchObject({
        focalLengthMm: expect.closeTo(49.936, 3),
        aspectRatio: "2.39:1",
      });
      if (!importedCamera) throw new Error("imported camera is missing");
      const importedView = getCameraViewSnapshotFromShot(importedCamera);
      expect(importedView.position).toEqual([expect.closeTo(4, 5), expect.closeTo(2.5, 5), expect.closeTo(6, 5)]);
      expect(
        new Vector3(...importedView.target)
          .sub(new Vector3(...importedView.position))
          .normalize()
          .dot(expectedForward),
      ).toBeCloseTo(1, 6);
      expect(applied.copiedAssets).toHaveLength(1);
      const copiedBundle = await readFile(
        resolve(workspaceRoot, "assets", "generated", applied.copiedAssets[0]!.url.slice(1)),
      );
      expect(copiedBundle).toEqual(packageBundle);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  },
  PROCESS_TIMEOUT_MS,
);
