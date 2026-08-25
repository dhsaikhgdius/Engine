import { Camera, Document, WebIO, type GLTF, type JSONDocument } from "@gltf-transform/core";
import { Euler, MathUtils, Quaternion } from "three";
import { isRecord } from "@director/protocol/primitives";
import type {
  DirectorCameraAspectRatio,
  DirectorObject,
  DirectorProject,
  DirectorTransform,
} from "@director/project-schema";
import {
  DIRECTOR_INTERCHANGE_CONTRACT,
  DIRECTOR_INTERCHANGE_COORDINATE_SYSTEM,
  assertDirectorInterchangeCharacterAssets,
  createDirectorInterchangeManifest,
  createEmptyDirectorInterchangeProject,
  parseDirectorInterchangeManifest,
  readInterchangeBytes,
  stableDirectorInterchangeId,
  type DirectorInterchangeImportResult,
  type DirectorInterchangeManifest,
} from "./contract";
import {
  directorCameraLookQuaternion,
  directorCameraTargetDistance,
  directorCameraTargetFromQuaternion,
} from "./cameraOrientation";

/** Adapter identifier for the Director glTF bridge. */
export const DIRECTOR_GLTF_ADAPTER = "director-gltf-v1" as const;

/** MIME type for glTF JSON documents. */
export const DIRECTOR_GLTF_MIME_TYPE = "model/gltf+json";

/** MIME type for glTF Binary (GLB) documents. */
export const DIRECTOR_GLB_MIME_TYPE = "model/gltf-binary";

/** Maximum allowed size for a glTF/GLB document in bytes (128 MiB). */
export const DIRECTOR_GLTF_MAX_BYTES = 128 * 1024 * 1024;

/** Metadata attached to the glTF root node, carrying the full interchange manifest. */
export interface DirectorGltfMetadata {
  adapter: typeof DIRECTOR_GLTF_ADAPTER;
  contract: typeof DIRECTOR_INTERCHANGE_CONTRACT;
  coordinateSystem: typeof DIRECTOR_INTERCHANGE_COORDINATE_SYSTEM;
  manifest: DirectorInterchangeManifest;
}

/** Per-entity metadata attached to glTF nodes, identifying the Director entity type and stable ID. */
export interface DirectorGltfEntityMetadata {
  adapter: typeof DIRECTOR_GLTF_ADAPTER;
  contract: typeof DIRECTOR_INTERCHANGE_CONTRACT;
  stableId: string;
  entityType: "object" | "camera";
  kind?: DirectorObject["kind"];
  assetRefId?: string;
  parentObjectId?: string;
}

/** A glTF document in parsed JSON form, as produced by @gltf-transform/core. */
export type DirectorGltfDocument = JSONDocument;

/** Options for importing a glTF document into a Director project. */
export interface ImportDirectorGltfOptions {
  baseProject?: DirectorProject;
}

function eulerToQuaternion(rotation: DirectorTransform["rotation"]): [number, number, number, number] {
  const quaternion = new Quaternion().setFromEuler(new Euler(rotation[0], rotation[1], rotation[2], "XYZ"));
  return [quaternion.x, quaternion.y, quaternion.z, quaternion.w];
}

function quaternionToEuler(rotation: readonly number[]): DirectorTransform["rotation"] {
  const quaternion = new Quaternion(
    Number(rotation[0]) || 0,
    Number(rotation[1]) || 0,
    Number(rotation[2]) || 0,
    Number.isFinite(rotation[3]) ? Number(rotation[3]) : 1,
  ).normalize();
  const euler = new Euler().setFromQuaternion(quaternion, "XYZ");
  return [euler.x, euler.y, euler.z];
}

function aspectRatioValue(aspect: DirectorCameraAspectRatio | undefined) {
  switch (aspect) {
    case "9:16":
      return 9 / 16;
    case "1:1":
      return 1;
    case "4:3":
      return 4 / 3;
    case "1.85:1":
      return 1.85;
    case "2.39:1":
      return 2.39;
    default:
      return 16 / 9;
  }
}

function closestAspectRatio(value: number | null): DirectorCameraAspectRatio {
  if (!value || !Number.isFinite(value)) return "16:9";
  const entries: Array<[DirectorCameraAspectRatio, number]> = [
    ["9:16", 9 / 16],
    ["1:1", 1],
    ["4:3", 4 / 3],
    ["16:9", 16 / 9],
    ["1.85:1", 1.85],
    ["2.39:1", 2.39],
  ];
  return entries.sort((left, right) => Math.abs(left[1] - value) - Math.abs(right[1] - value))[0]![0];
}

function entityMetadata(value: unknown): DirectorGltfEntityMetadata | null {
  if (!isRecord(value) || !isRecord(value.director)) return null;
  const director = value.director;
  if (
    director.adapter !== DIRECTOR_GLTF_ADAPTER ||
    director.contract !== DIRECTOR_INTERCHANGE_CONTRACT ||
    typeof director.stableId !== "string" ||
    (director.entityType !== "object" && director.entityType !== "camera")
  )
    return null;
  return director as unknown as DirectorGltfEntityMetadata;
}

/**
 * Create a glTF document from a Director project, encoding all objects and
 * cameras as glTF nodes with Director metadata in extras. The project is
 * wrapped in an interchange manifest stored on the root node.
 *
 * @param project - The Director project to convert.
 * @returns A @gltf-transform Document ready for serialization.
 */
export function createDirectorGltfDocument(project: DirectorProject) {
  const document = new Document();
  const scene = document.createScene(project.storyboard?.title || "Director Scene");
  document.getRoot().setDefaultScene(scene);
  const rootMetadata: DirectorGltfMetadata = {
    adapter: DIRECTOR_GLTF_ADAPTER,
    contract: DIRECTOR_INTERCHANGE_CONTRACT,
    coordinateSystem: { ...DIRECTOR_INTERCHANGE_COORDINATE_SYSTEM },
    manifest: createDirectorInterchangeManifest(project),
  };
  document.getRoot().setExtras({ director: rootMetadata });
  scene.setExtras({
    director: {
      contract: DIRECTOR_INTERCHANGE_CONTRACT,
      coordinateSystem: { ...DIRECTOR_INTERCHANGE_COORDINATE_SYSTEM },
    },
  });

  project.objects.forEach((object) => {
    const metadata: DirectorGltfEntityMetadata = {
      adapter: DIRECTOR_GLTF_ADAPTER,
      contract: DIRECTOR_INTERCHANGE_CONTRACT,
      stableId: object.id || stableDirectorInterchangeId("object", object.name),
      entityType: "object",
      kind: object.kind,
      ...(object.assetRefId ? { assetRefId: object.assetRefId } : {}),
      ...(object.parentObjectId ? { parentObjectId: object.parentObjectId } : {}),
    };
    scene.addChild(
      document
        .createNode(object.name)
        .setTranslation([...object.transform.position])
        .setRotation(eulerToQuaternion(object.transform.rotation))
        .setScale([...object.transform.scale])
        .setExtras({ director: metadata }),
    );
  });

  project.cameras.forEach((camera) => {
    const metadata: DirectorGltfEntityMetadata = {
      adapter: DIRECTOR_GLTF_ADAPTER,
      contract: DIRECTOR_INTERCHANGE_CONTRACT,
      stableId: camera.id || stableDirectorInterchangeId("camera", camera.name),
      entityType: "camera",
    };
    const gltfCamera = document
      .createCamera(camera.name)
      .setType(Camera.Type.PERSPECTIVE)
      .setYFov(MathUtils.degToRad(camera.fov))
      .setAspectRatio(aspectRatioValue(camera.aspectRatio))
      .setZNear(camera.nearClipM ?? 0.01)
      .setZFar(camera.farClipM ?? 10_000)
      .setExtras({
        director: {
          stableId: metadata.stableId,
          focalLengthMm: camera.focalLengthMm ?? null,
          sensorFormat: camera.sensorFormat ?? null,
          apertureFStop: camera.apertureFStop ?? null,
          focusDistanceM: camera.focusDistanceM ?? null,
        },
      });
    scene.addChild(
      document
        .createNode(camera.name)
        .setTranslation([...camera.transform.position])
        .setRotation(directorCameraLookQuaternion(camera))
        .setScale([...camera.transform.scale])
        .setCamera(gltfCamera)
        .setExtras({ director: metadata }),
    );
  });
  return document;
}

/**
 * Export a Director project to a glTF JSON document.
 *
 * @param project - The Director project to export.
 * @returns A parsed glTF JSON document with Director metadata.
 */
export async function exportDirectorProjectToGltf(project: DirectorProject): Promise<DirectorGltfDocument> {
  return new WebIO().writeJSON(createDirectorGltfDocument(project));
}

/** Alias emphasizing that this is a lightweight scene manifest, not baked proxy geometry. */
export const exportDirectorProjectToGltfManifest = exportDirectorProjectToGltf;

/**
 * Serialize a Director project to a formatted glTF JSON string.
 *
 * @param project - The Director project to serialize.
 * @param pretty - Whether to pretty-print the JSON (default true).
 * @returns A glTF JSON string with trailing newline.
 */
export async function serializeDirectorProjectToGltf(project: DirectorProject, pretty = true) {
  const output = await exportDirectorProjectToGltf(project);
  return `${JSON.stringify(output.json, null, pretty ? 2 : undefined)}\n`;
}

/**
 * Export a Director project to a GLB binary buffer.
 *
 * @param project - The Director project to export.
 * @returns A Uint8Array containing the GLB binary.
 */
export async function exportDirectorProjectToGlb(project: DirectorProject) {
  return new WebIO().writeBinary(createDirectorGltfDocument(project));
}

function parseGltfJson(source: string | GLTF.IGLTF | JSONDocument): JSONDocument {
  if (typeof source === "string") {
    if (new TextEncoder().encode(source).byteLength > DIRECTOR_GLTF_MAX_BYTES) {
      throw new Error("glTF manifest exceeds the Director interchange size limit");
    }
    try {
      return { json: JSON.parse(source) as GLTF.IGLTF, resources: {} };
    } catch {
      throw new Error("glTF JSON could not be parsed");
    }
  }
  if (isRecord(source) && isRecord(source.json) && isRecord(source.resources)) return source as JSONDocument;
  return { json: source as GLTF.IGLTF, resources: {} };
}

async function importDirectorGltfDocument(document: Document, options: ImportDirectorGltfOptions) {
  const warnings: string[] = [];
  const rootExtras = document.getRoot().getExtras();
  const rootDirector = isRecord(rootExtras.director) ? rootExtras.director : null;
  let embeddedProject: DirectorProject | null = null;
  if (rootDirector?.manifest !== undefined) {
    try {
      embeddedProject = parseDirectorInterchangeManifest(rootDirector.manifest).project;
    } catch (error) {
      warnings.push(`Embedded Director project was ignored: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (rootDirector && rootDirector.coordinateSystem !== undefined) {
    const coordinate = rootDirector.coordinateSystem;
    if (
      !isRecord(coordinate) ||
      coordinate.metersPerUnit !== 1 ||
      coordinate.upAxis !== "Y" ||
      coordinate.handedness !== "right"
    )
      throw new Error("glTF Director manifest is not metres/Y-up/right-handed");
  }
  const project = structuredClone(embeddedProject ?? options.baseProject ?? createEmptyDirectorInterchangeProject());
  const importedIds = new Set<string>();

  document
    .getRoot()
    .listNodes()
    .forEach((node) => {
      const metadata = entityMetadata(node.getExtras());
      if (!metadata) return;
      if (importedIds.has(metadata.stableId)) {
        warnings.push(`Duplicate glTF stable ID ${metadata.stableId} was ignored.`);
        return;
      }
      importedIds.add(metadata.stableId);
      const transform: DirectorTransform = {
        position: [...node.getTranslation()] as DirectorTransform["position"],
        rotation: quaternionToEuler(node.getRotation()),
        scale: [...node.getScale()] as DirectorTransform["scale"],
      };
      if (metadata.entityType === "object") {
        const existing = project.objects.find((object) => object.id === metadata.stableId);
        if (existing) {
          existing.name = node.getName() || existing.name;
          existing.transform = transform;
          if (metadata.parentObjectId) existing.parentObjectId = metadata.parentObjectId;
        } else {
          project.objects.push({
            id: metadata.stableId,
            name: node.getName() || metadata.stableId,
            kind: normalizeObjectKind(metadata.kind),
            visible: true,
            locked: false,
            transform,
            ...(metadata.assetRefId ? { assetRefId: metadata.assetRefId } : {}),
            ...(metadata.parentObjectId ? { parentObjectId: metadata.parentObjectId } : {}),
          });
        }
        return;
      }
      const gltfCamera = node.getCamera();
      const existing = project.cameras.find((camera) => camera.id === metadata.stableId);
      const cameraExtras = gltfCamera?.getExtras();
      const cameraDirector = cameraExtras && isRecord(cameraExtras.director) ? cameraExtras.director : null;
      const externalFocusDistance =
        cameraDirector &&
        typeof cameraDirector.focusDistanceM === "number" &&
        Number.isFinite(cameraDirector.focusDistanceM)
          ? cameraDirector.focusDistanceM
          : 1;
      const targetDistance = existing
        ? directorCameraTargetDistance(existing.transform.position, existing.target, externalFocusDistance)
        : externalFocusDistance;
      const target = directorCameraTargetFromQuaternion(transform.position, node.getRotation(), targetDistance);
      if (existing) {
        existing.name = node.getName() || existing.name;
        existing.transform = transform;
        existing.target = target;
        if (gltfCamera) {
          existing.fov = MathUtils.radToDeg(gltfCamera.getYFov());
          existing.nearClipM = gltfCamera.getZNear();
          existing.farClipM = gltfCamera.getZFar();
          existing.aspectRatio = closestAspectRatio(gltfCamera.getAspectRatio());
        }
      } else {
        project.cameras.push({
          id: metadata.stableId,
          name: node.getName() || metadata.stableId,
          fov: gltfCamera ? MathUtils.radToDeg(gltfCamera.getYFov()) : 50,
          nearClipM: gltfCamera?.getZNear() ?? 0.01,
          farClipM: gltfCamera?.getZFar() ?? 10_000,
          aspectRatio: closestAspectRatio(gltfCamera?.getAspectRatio() ?? null),
          transform,
          targetMode: "manual",
          target,
        });
      }
    });
  if (!embeddedProject && !options.baseProject && importedIds.size === 0) {
    warnings.push("glTF contains no Director entity metadata; an empty project was created.");
  }
  if (!project.activeCameraId || !project.cameras.some((camera) => camera.id === project.activeCameraId)) {
    project.activeCameraId = project.cameras[0]?.id ?? null;
  }
  assertDirectorInterchangeCharacterAssets(project);
  return { project, warnings } satisfies DirectorInterchangeImportResult;
}

function normalizeObjectKind(value: unknown): DirectorObject["kind"] {
  return value === "character" || value === "scene" || value === "prop" || value === "camera" || value === "panorama"
    ? value
    : "prop";
}

/**
 * Import a Director project from a glTF JSON document (string, IGLTF, or JSONDocument).
 * Extracts Director metadata from node extras and reconstructs the project,
 * falling back to an embedded manifest or the provided base project.
 *
 * @param source - The glTF source to import.
 * @param options - Optional base project and import options.
 * @returns The imported project and any warnings.
 */
export async function importDirectorProjectFromGltf(
  source: string | GLTF.IGLTF | JSONDocument,
  options: ImportDirectorGltfOptions = {},
) {
  const document = await new WebIO().readJSON(parseGltfJson(source));
  return importDirectorGltfDocument(document, options);
}

export const importDirectorProjectFromGltfManifest = importDirectorProjectFromGltf;

/**
 * Import a Director project from a GLB binary buffer.
 * Validates the size limit, parses the binary, and extracts Director metadata.
 *
 * @param source - The GLB data as Uint8Array, ArrayBuffer, or Blob.
 * @param options - Optional base project and import options.
 * @returns The imported project and any warnings.
 * @throws If the GLB exceeds the size limit or cannot be parsed.
 */
export async function importDirectorProjectFromGlb(
  source: Uint8Array | ArrayBuffer | Blob,
  options: ImportDirectorGltfOptions = {},
) {
  const bytes = await readInterchangeBytes(source);
  if (bytes.byteLength > DIRECTOR_GLTF_MAX_BYTES) throw new Error("GLB exceeds the Director interchange size limit");
  let document: Document;
  try {
    document = await new WebIO().readBinary(bytes);
  } catch {
    throw new Error("GLB could not be parsed");
  }
  return importDirectorGltfDocument(document, options);
}
