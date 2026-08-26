import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import JSZip from "jszip";
import { Euler, MathUtils, Quaternion, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import type { DirectorProject } from "../../../../src/comprehensive/editor/schema/directorProject";
import { DIRECTOR_COMMON_FRAME_RATES } from "../../../../src/comprehensive/editor/timeline/frameRate";
import {
  DIRECTOR_INTERCHANGE_CONTRACT,
  DIRECTOR_INTERCHANGE_COORDINATE_SYSTEM,
  createEmptyDirectorInterchangeProject,
  exportDirectorProjectToFountain,
  exportDirectorProjectToGlb,
  exportDirectorProjectToGltf,
  exportDirectorProjectToOtio,
  exportDirectorProjectToOtioz,
  exportDirectorProjectToUsda,
  exportDirectorProjectToUsdz,
  importDirectorProjectFromFountain,
  importDirectorProjectFromGlb,
  importDirectorProjectFromGltf,
  importDirectorProjectFromOtio,
  importDirectorProjectFromOtioz,
  importDirectorProjectFromUsda,
  importDirectorProjectFromUsdz,
} from "../../../../src/comprehensive/editor/interchange/index";

const fixture = (name: string) =>
  readFileSync(
    resolve(process.cwd(), "frontend/director/src/comprehensive/editor/interchange/__fixtures__", name),
    "utf8",
  );

function projectFixture(): DirectorProject {
  const project = createEmptyDirectorInterchangeProject({
    rate: DIRECTOR_COMMON_FRAME_RATES.ntsc2997,
    dropFrame: true,
    startTimecode: "01:00:00;00",
  });
  project.scene.timeline = {
    version: 1,
    fps: 30_000 / 1_001,
    timebase: {
      rate: { ...DIRECTOR_COMMON_FRAME_RATES.ntsc2997 },
      dropFrame: true,
      startTimecode: "01:00:00;00",
    },
    frameStart: 0,
    frameEnd: 95,
    currentFrame: 12,
    loop: false,
  };
  project.objects.push({
    id: "prop-marker-001",
    name: "Marker",
    kind: "prop",
    visible: true,
    locked: false,
    transform: { position: [1, 2, -3], rotation: [0.1, 0.25, -0.05], scale: [1, 1.5, 1] },
  });
  project.cameras.push({
    id: "camera-main-001",
    name: "Main Camera",
    fov: 42,
    focalLengthMm: 50,
    apertureFStop: 2.8,
    focusDistanceM: 6,
    nearClipM: 0.1,
    farClipM: 1_000,
    aspectRatio: "16:9",
    transform: { position: [0, 2, 6], rotation: [0, 0, 0], scale: [1, 1, 1] },
    targetMode: "manual",
    target: [0, 1, 0],
  });
  project.activeCameraId = "camera-main-001";
  project.storyboard = {
    version: 1,
    title: "Interchange fixture",
    logline: "A stable-ID round trip.",
    shots: [
      {
        id: "shot-opening-001",
        scriptBeatId: "beat-opening-001",
        title: "INT. LAB - DAY",
        cameraId: "camera-main-001",
        frameStart: 12,
        frameEnd: 47,
        shotSize: "wide",
        movement: "push-in",
        action: "The marker comes into view.",
      },
      {
        id: "shot-detail-002",
        scriptBeatId: "beat-detail-002",
        title: "INSERT - MARKER",
        cameraId: "camera-main-001",
        frameStart: 60,
        frameEnd: 95,
        shotSize: "insert",
        movement: "static",
        action: "A serial number catches the light.",
      },
    ],
  };
  return project;
}

function expectCameraDirection(position: readonly number[], target: readonly number[], quaternion: Quaternion) {
  const externalForward = new Vector3(0, 0, -1).applyQuaternion(quaternion).normalize();
  const directorForward = new Vector3(target[0], target[1], target[2])
    .sub(new Vector3(position[0], position[1], position[2]))
    .normalize();
  expect(externalForward.dot(directorForward)).toBeCloseTo(1, 6);
}

function storedZipEntries(bytes: Uint8Array) {
  const entries: Array<{ name: string; method: number; dataOffset: number }> = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset + 30 <= bytes.byteLength && view.getUint32(offset, true) === 0x04034b50) {
    const method = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const dataOffset = nameStart + nameLength + extraLength;
    entries.push({
      name: decoder.decode(bytes.subarray(nameStart, nameStart + nameLength)),
      method,
      dataOffset,
    });
    offset = dataOffset + compressedSize;
  }
  return entries;
}

describe("Director professional interchange fixtures", () => {
  it("imports ordinary Fountain and preserves Director shot/beat IDs on export round-trip", () => {
    const external = importDirectorProjectFromFountain(fixture("screenplay.fountain"));
    expect(external.project.storyboard?.shots.map((shot) => shot.title)).toEqual([
      "INT. STATION HALL - NIGHT",
      "EXT. PLATFORM - NIGHT",
    ]);
    expect(new Set(external.project.storyboard?.shots.map((shot) => shot.scriptBeatId)).size).toBe(2);
    expect(external.omitted ?? []).toEqual([]);

    const project = projectFixture();
    const imported = importDirectorProjectFromFountain(exportDirectorProjectToFountain(project));
    expect(imported.project.storyboard?.shots.map(({ id, scriptBeatId }) => ({ id, scriptBeatId }))).toEqual([
      { id: "shot-opening-001", scriptBeatId: "beat-opening-001" },
      { id: "shot-detail-002", scriptBeatId: "beat-detail-002" },
    ]);
  });

  it("stamps typed Fountain omitted records for dialogue, notes, sections, and title-page fields", () => {
    const source = `Title: Night Run
Author: Ada
Draft date: 2026-08-26
Logline: A courier misses the last train.

# Act One

INT. LOBBY - NIGHT

[[plant the ticket]]

Courier checks the board.

COURIER
Where is platform nine?

CUT TO:

EXT. STREET - NIGHT

Rain hits the pavement.
`;
    const imported = importDirectorProjectFromFountain(source);
    expect(imported.project.storyboard?.shots.map((shot) => shot.title)).toEqual([
      "INT. LOBBY - NIGHT",
      "EXT. STREET - NIGHT",
    ]);
    expect(imported.project.storyboard?.shots[0]?.action).toBe("Courier checks the board.");
    expect(imported.omitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "title_page_field", subject: "Author" }),
        expect.objectContaining({ code: "title_page_field", subject: "Draft date" }),
        expect.objectContaining({ code: "section_heading" }),
        expect.objectContaining({ code: "boneyard_note" }),
        expect.objectContaining({ code: "character_dialogue", subject: "COURIER" }),
        expect.objectContaining({ code: "transition", subject: "CUT TO:" }),
      ]),
    );
    expect(imported.warnings.some((warning) => warning.includes("character_dialogue"))).toBe(true);
  });

  it("imports an external OTIO fixture and round-trips rational timebase through OTIO/OTIOZ", async () => {
    const external = importDirectorProjectFromOtio(fixture("editorial.otio.json"));
    expect(external.project.storyboard?.shots.map((shot) => [shot.title, shot.frameStart, shot.frameEnd])).toEqual([
      ["Arrival", 0, 23],
      ["Departure", 36, 71],
    ]);
    expect(external.project.scene.timeline?.timebase?.startTimecode).toBe("01:00:00:00");

    const project = projectFixture();
    const otio = exportDirectorProjectToOtio(project);
    expect(otio.OTIO_SCHEMA).toBe("Timeline.1");
    expect(otio.metadata.director.frameRate).toEqual({ numerator: 30_000, denominator: 1_001 });
    expect(importDirectorProjectFromOtio(otio).project.storyboard?.shots.map((shot) => shot.id)).toEqual([
      "shot-opening-001",
      "shot-detail-002",
    ]);

    const archive = await exportDirectorProjectToOtioz(project);
    const zip = await JSZip.loadAsync(archive);
    expect(Object.keys(zip.files)).toEqual(expect.arrayContaining(["content.otio", "version.txt"]));
    const imported = await importDirectorProjectFromOtioz(archive);
    expect(imported.project.scene.timeline?.timebase).toEqual(project.scene.timeline?.timebase);
  });

  it("reads content.otio from bulky OTIOZ archives with many sibling media entries", async () => {
    const project = projectFixture();
    const zip = await JSZip.loadAsync(await exportDirectorProjectToOtioz(project));
    for (let index = 0; index < 64; index += 1) {
      zip.file(`media/render pass ${index}/clip-${index}.mov`, new Uint8Array([index % 256, 1, 2, 3]));
    }
    zip.file("media\\windows\\legacy clip.mov", new Uint8Array([7, 7, 7]));
    const bulky = await zip.generateAsync({ type: "uint8array" });

    const imported = await importDirectorProjectFromOtioz(bulky);
    expect(imported.project.storyboard?.shots.map((shot) => shot.id)).toEqual(["shot-opening-001", "shot-detail-002"]);
  });

  it("imports external glTF metadata and round-trips GLB with native coordinates and stable IDs", async () => {
    const external = await importDirectorProjectFromGltf(fixture("scene.gltf.json"));
    expect(external.project.objects[0]).toMatchObject({
      id: "fixture-object-001",
      transform: { position: [1, 2, 3] },
    });
    expect(external.project.cameras[0]).toMatchObject({ id: "fixture-camera-001", aspectRatio: "16:9" });
    expect(external.omitted ?? []).toEqual([]);
    expectCameraDirection(
      external.project.cameras[0]!.transform.position,
      external.project.cameras[0]!.target,
      new Quaternion(0, 0.3826834323650898, 0, 0.9238795325112867),
    );

    const project = projectFixture();
    project.cameras[0]!.transform.rotation = [1.1, -0.7, 0.3];
    const gltf = await exportDirectorProjectToGltf(project);
    expect(gltf.json.extras).toMatchObject({
      director: {
        contract: DIRECTOR_INTERCHANGE_CONTRACT,
        coordinateSystem: DIRECTOR_INTERCHANGE_COORDINATE_SYSTEM,
      },
    });
    const cameraNode = gltf.json.nodes?.find((node) => node.camera !== undefined);
    expect(cameraNode?.rotation).toBeDefined();
    expectCameraDirection(
      project.cameras[0]!.transform.position,
      project.cameras[0]!.target,
      new Quaternion().fromArray(cameraNode!.rotation!),
    );
    const glb = await exportDirectorProjectToGlb(project);
    const imported = await importDirectorProjectFromGlb(glb);
    expect(imported.project.objects[0]).toMatchObject({
      id: "prop-marker-001",
      transform: { position: [1, 2, -3], scale: [1, 1.5, 1] },
    });
    expect(imported.project.cameras[0]?.id).toBe("camera-main-001");
    expect(imported.omitted ?? []).toEqual([]);
    expectCameraDirection(
      imported.project.cameras[0]!.transform.position,
      imported.project.cameras[0]!.target,
      new Quaternion().fromArray(cameraNode!.rotation!),
    );
  });

  it("stamps typed glTF omitted records for duplicate IDs, empty scenes, and invalid manifests", async () => {
    const empty = await importDirectorProjectFromGltf(
      JSON.stringify({
        asset: { version: "2.0" },
        scenes: [{ nodes: [] }],
        scene: 0,
        nodes: [],
      }),
    );
    expect(empty.project.objects).toEqual([]);
    expect(empty.omitted).toEqual([expect.objectContaining({ code: "empty_project_no_metadata", subject: "scene" })]);
    expect(empty.warnings.some((warning) => warning.includes("empty_project_no_metadata"))).toBe(true);

    const duplicate = await importDirectorProjectFromGltf(
      JSON.stringify({
        asset: { version: "2.0" },
        scenes: [{ nodes: [0, 1] }],
        scene: 0,
        nodes: [
          {
            name: "Marker A",
            translation: [1, 0, 0],
            extras: {
              director: {
                adapter: "director-gltf-v1",
                contract: DIRECTOR_INTERCHANGE_CONTRACT,
                stableId: "dup-object-001",
                entityType: "object",
                kind: "prop",
              },
            },
          },
          {
            name: "Marker B",
            translation: [2, 0, 0],
            extras: {
              director: {
                adapter: "director-gltf-v1",
                contract: DIRECTOR_INTERCHANGE_CONTRACT,
                stableId: "dup-object-001",
                entityType: "object",
                kind: "prop",
              },
            },
          },
        ],
      }),
    );
    expect(duplicate.project.objects.map((object) => object.id)).toEqual(["dup-object-001"]);
    expect(duplicate.omitted).toEqual([
      expect.objectContaining({ code: "duplicate_stable_id", subject: "dup-object-001" }),
    ]);

    const invalidManifest = await importDirectorProjectFromGltf(
      JSON.stringify({
        asset: { version: "2.0" },
        extras: {
          director: {
            adapter: "director-gltf-v1",
            contract: DIRECTOR_INTERCHANGE_CONTRACT,
            coordinateSystem: DIRECTOR_INTERCHANGE_COORDINATE_SYSTEM,
            manifest: { contract: "not-a-manifest", version: 1 },
          },
        },
        scenes: [{ nodes: [] }],
        scene: 0,
        nodes: [],
      }),
    );
    expect(invalidManifest.omitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "embedded_manifest_invalid", subject: "extras.director.manifest" }),
        expect.objectContaining({ code: "empty_project_no_metadata" }),
      ]),
    );
  });

  it("imports an external USDA layer and round-trips editable prims through USDA/USDZ", async () => {
    const external = importDirectorProjectFromUsda(fixture("scene.usda"));
    expect(external.project.objects[0]).toMatchObject({
      id: "fixture-usd-object-001",
      name: "USD Marker",
      transform: { position: [2, 1, -3] },
    });
    expect(external.project.objects[0]!.transform.rotation[1]).toBeCloseTo(Math.PI / 2);
    expect(external.project.cameras[0]).toMatchObject({ id: "fixture-usd-camera-001", fov: 42 });
    expect(external.project.cameras[0]?.nearClipM).toBe(0.1);
    expect(external.project.cameras[0]?.farClipM).toBe(1_000);
    expectCameraDirection(
      external.project.cameras[0]!.transform.position,
      external.project.cameras[0]!.target,
      new Quaternion().setFromEuler(new Euler(0, Math.PI / 4, 0, "XYZ")),
    );

    const project = projectFixture();
    project.cameras[0]!.transform.rotation = [1.1, -0.7, 0.3];
    const usda = exportDirectorProjectToUsda(project);
    expect(usda).toContain("metersPerUnit = 1");
    expect(usda).toContain('upAxis = "Y"');
    expect(usda).toContain('directorHandedness = "right"');
    expect(usda).toContain("float2 clippingRange = (0.1, 1000)");
    expect(usda).not.toContain("clippingRange:min");
    const cameraPrim = usda.slice(usda.indexOf("def Camera"));
    const rotationMatch = cameraPrim.match(/xformOp:rotateXYZ\s*=\s*\(([^)]+)\)/);
    expect(rotationMatch).not.toBeNull();
    const rotation = rotationMatch![1].split(",").map((value) => MathUtils.degToRad(Number(value.trim())));
    expectCameraDirection(
      project.cameras[0]!.transform.position,
      project.cameras[0]!.target,
      new Quaternion().setFromEuler(new Euler(rotation[0], rotation[1], rotation[2], "XYZ")),
    );
    expect(importDirectorProjectFromUsda(usda).project.objects[0]?.id).toBe("prop-marker-001");

    const archive = await exportDirectorProjectToUsdz(project);
    const entries = storedZipEntries(archive);
    expect(entries.map((entry) => entry.name)).toEqual(["scene.usda", "director-manifest.json"]);
    expect(entries.every((entry) => entry.method === 0 && entry.dataOffset % 64 === 0)).toBe(true);
    const zip = await JSZip.loadAsync(archive);
    expect(Object.keys(zip.files)).toEqual(expect.arrayContaining(["scene.usda", "director-manifest.json"]));
    expect((await importDirectorProjectFromUsdz(archive)).project.cameras[0]?.id).toBe("camera-main-001");
  });

  it("rejects path traversal in OTIOZ and USDZ before reading archive content", async () => {
    const maliciousOtioz = new JSZip();
    maliciousOtioz.file("../content.otio", "{}", { compression: "STORE" });
    await expect(
      importDirectorProjectFromOtioz(await maliciousOtioz.generateAsync({ type: "uint8array" })),
    ).rejects.toThrow(/Unsafe OTIOZ entry path/);

    const maliciousUsdz = new JSZip();
    maliciousUsdz.file("../scene.usda", "#usda 1.0", { compression: "STORE" });
    await expect(
      importDirectorProjectFromUsdz(await maliciousUsdz.generateAsync({ type: "uint8array" })),
    ).rejects.toThrow(/Unsafe USDZ entry path/);
  });
});
