import JSZip from "jszip";
import {
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  Euler,
  Matrix4,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  type BufferGeometry,
  type Object3D,
} from "three";
import { z } from "zod";
import { isDirectorSplatAssetFileName } from "../loaders/splatFormats";
import type { DirectorAssetRef, DirectorObject, DirectorProject } from "../schema/directorProject";
import { getDirectorProjectRevision } from "../schema/directorProjectRevision";
import { DIRECTOR_INTERCHANGE_CONTRACT, DIRECTOR_INTERCHANGE_COORDINATE_SYSTEM } from "./contract";
import {
  loadDirectorImportedModelObject,
  materializeDirectorImportedModelMesh,
  type DirectorMaterializedModelMesh,
  type DirectorMeshTriangle,
} from "./importedModelMesh";

export const DIRECTOR_MESH_EXPORT_ADAPTER = "director-mesh-export-v1" as const;
/** MIME type for OBJ mesh exports. */
export const DIRECTOR_OBJ_MIME_TYPE = "text/plain;charset=utf-8";
/** MIME type for STL mesh exports. */
export const DIRECTOR_STL_MIME_TYPE = "model/stl";
/** MIME type for the zipped mesh export archive. */
export const DIRECTOR_MESH_EXPORT_ARCHIVE_MIME_TYPE = "application/zip";
/** Maximum number of Stage objects that can be included in a single mesh export. */
export const DIRECTOR_MESH_EXPORT_MAX_OBJECTS = 2_048;
/** Maximum total triangle count across all objects in a single mesh export. */
export const DIRECTOR_MESH_EXPORT_MAX_TRIANGLES = 1_000_000;
/** Maximum number of distinct imported model assets that can be materialized. */
export const DIRECTOR_MESH_EXPORT_MAX_IMPORTED_ASSETS = 64;

/**
 * Structured warn-and-omit codes for OBJ/STL mesh export. Every omitted Stage
 * object carries one typed code; free-text `reason` stays for humans. Agents
 * read `omitted[]` on the loss report and on interchange export receipts.
 */
export const DIRECTOR_MESH_EXPORT_OMITTED_CODES = [
  "hidden_object",
  "unsupported_object_kind",
  "sync_export_requires_archive",
  "degenerate_geometry",
  "asset_not_model",
  "rigged_character_requires_dcc",
  "splat_no_triangle_mesh",
  "imported_asset_limit",
  "model_materialization_failed",
] as const;

/** One mesh export omit code. */
export type DirectorMeshExportOmittedCode = (typeof DIRECTOR_MESH_EXPORT_OMITTED_CODES)[number];

const nonEmpty = z.string().trim().min(1).max(500);

/** The Zod schema for the mesh export provenance report. */
export const directorMeshExportReportSchema = z.strictObject({
  adapter: z.literal(DIRECTOR_MESH_EXPORT_ADAPTER),
  contract: z.literal(DIRECTOR_INTERCHANGE_CONTRACT),
  format: z.enum(["obj", "stl"]),
  exportedAt: z.string().datetime({ offset: true }),
  projectRevision: nonEmpty,
  coordinateSystem: z.strictObject({
    linearUnit: z.literal("meter"),
    metersPerUnit: z.literal(1),
    upAxis: z.literal("Y"),
    handedness: z.literal("right"),
  }),
  scope: z.strictObject({
    mode: z.enum(["all", "selection"]),
    requestedObjectIds: z.array(nonEmpty).max(DIRECTOR_MESH_EXPORT_MAX_OBJECTS),
    includedObjectIds: z.array(nonEmpty).min(1).max(DIRECTOR_MESH_EXPORT_MAX_OBJECTS),
  }),
  objects: z
    .array(
      z.strictObject({
        stableId: nonEmpty,
        name: nonEmpty,
        meshSource: z.enum(["primitive", "imported-model"]),
        primitiveType: z.enum(["box", "sphere", "cylinder", "torus", "cone", "pyramid"]).nullable(),
        assetRefId: nonEmpty.nullable(),
        sourceFileName: nonEmpty.nullable(),
        triangleCount: z.number().int().positive(),
        materialName: nonEmpty.nullable(),
        negativeScaleBaked: z.boolean(),
      }),
    )
    .min(1)
    .max(DIRECTOR_MESH_EXPORT_MAX_OBJECTS),
  omitted: z
    .array(
      z.strictObject({
        stableId: nonEmpty,
        name: nonEmpty,
        code: z.enum(DIRECTOR_MESH_EXPORT_OMITTED_CODES),
        reason: nonEmpty,
      }),
    )
    .max(DIRECTOR_MESH_EXPORT_MAX_OBJECTS),
  triangleCount: z.number().int().positive().max(DIRECTOR_MESH_EXPORT_MAX_TRIANGLES),
  warnings: z.array(nonEmpty).max(64),
  files: z
    .array(
      z.strictObject({
        path: nonEmpty,
        mimeType: nonEmpty,
        byteLength: z.number().int().nonnegative(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
      }),
    )
    .max(4),
});

/** The validated mesh export report type. */
export type DirectorMeshExportReport = z.infer<typeof directorMeshExportReportSchema>;

/** Options controlling mesh export scope and behavior. */
export interface DirectorMeshExportOptions {
  /** Optional list of object IDs to export; exports all visible objects when omitted. */
  objectIds?: readonly string[];
  /** Whether to include hidden objects in the export. */
  includeHidden?: boolean;
  /** ISO 8601 timestamp for the export; defaults to now. */
  exportedAt?: string;
  /** Test/host injection point; production uses extension-specific Three.js loaders. */
  modelLoader?: (asset: DirectorAssetRef) => Promise<Object3D>;
}

interface MeshEntry {
  object: DirectorObject;
  meshSource: "primitive" | "imported-model";
  primitiveType: NonNullable<DirectorObject["geometryType"]> | null;
  assetRefId: string | null;
  sourceFileName: string | null;
  materialName: string;
  triangles: DirectorMeshTriangle[];
  negativeScaleBaked: boolean;
  skinned: boolean;
}

interface MaterializedMeshExportState {
  meshes: Map<string, { asset: DirectorAssetRef; mesh: DirectorMaterializedModelMesh }>;
  failures: Map<string, { code: DirectorMeshExportOmittedCode; reason: string }>;
}

function number(value: number) {
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

function safeName(value: string) {
  const cleaned = value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9_.-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return (cleaned || "director_object").slice(0, 180);
}

function geometryFor(type: NonNullable<DirectorObject["geometryType"]>): BufferGeometry {
  if (type === "sphere") return new SphereGeometry(0.5, 24, 16).translate(0, 0.5, 0);
  if (type === "cylinder") return new CylinderGeometry(0.5, 0.5, 1, 24).translate(0, 0.5, 0);
  if (type === "torus") return new TorusGeometry(0.375, 0.125, 12, 32).rotateX(Math.PI / 2).translate(0, 0.125, 0);
  if (type === "cone") return new ConeGeometry(0.5, 1, 24).translate(0, 0.5, 0);
  if (type === "pyramid") return new ConeGeometry(0.5, 1, 4).translate(0, 0.5, 0);
  return new BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
}

function transformMatrix(position: readonly number[], rotation: readonly number[], scale: readonly number[]) {
  return new Matrix4().compose(
    new Vector3(position[0], position[1], position[2]),
    new Quaternion().setFromEuler(new Euler(rotation[0], rotation[1], rotation[2], "XYZ")),
    new Vector3(scale[0], scale[1], scale[2]),
  );
}

function worldMatrix(project: DirectorProject, object: DirectorObject) {
  const scene = project.scene;
  const sceneMatrix = transformMatrix(scene.position, scene.rotation, [scene.scale, scene.scale, scene.scale]);
  return sceneMatrix.multiply(
    transformMatrix(object.transform.position, object.transform.rotation, object.transform.scale),
  );
}

function trianglesFor(
  project: DirectorProject,
  object: DirectorObject & { geometryType: NonNullable<DirectorObject["geometryType"]> },
) {
  const matrix = worldMatrix(project, object);
  const negativeScaleBaked = matrix.determinant() < 0;
  const geometry = geometryFor(object.geometryType).toNonIndexed().applyMatrix4(matrix);
  const positions = geometry.getAttribute("position");
  const triangles: DirectorMeshTriangle[] = [];
  for (let index = 0; index + 2 < positions.count; index += 3) {
    const a = new Vector3().fromBufferAttribute(positions, index);
    let b = new Vector3().fromBufferAttribute(positions, index + 1);
    let c = new Vector3().fromBufferAttribute(positions, index + 2);
    if (negativeScaleBaked) [b, c] = [c, b];
    const normal = new Vector3().subVectors(b, a).cross(new Vector3().subVectors(c, a));
    if (normal.lengthSq() <= 1e-16) continue;
    normal.normalize();
    triangles.push({
      a: [a.x, a.y, a.z],
      b: [b.x, b.y, b.z],
      c: [c.x, c.y, c.z],
      normal: [normal.x, normal.y, normal.z],
    });
  }
  geometry.dispose();
  return { triangles, negativeScaleBaked };
}

function selectedObjects(project: DirectorProject, options: DirectorMeshExportOptions) {
  if (!options.objectIds) {
    if (project.objects.length > DIRECTOR_MESH_EXPORT_MAX_OBJECTS) {
      throw new Error(`Mesh export is limited to ${DIRECTOR_MESH_EXPORT_MAX_OBJECTS} scoped Stage objects.`);
    }
    return { mode: "all" as const, requestedIds: project.objects.map((object) => object.id), objects: project.objects };
  }
  const requestedIds = [...new Set(options.objectIds)];
  if (!requestedIds.length) throw new Error("Selection mesh export requires at least one selected object.");
  if (requestedIds.length > DIRECTOR_MESH_EXPORT_MAX_OBJECTS) {
    throw new Error(`Mesh export is limited to ${DIRECTOR_MESH_EXPORT_MAX_OBJECTS} scoped Stage objects.`);
  }
  const byId = new Map(project.objects.map((object) => [object.id, object]));
  const missing = requestedIds.filter((id) => !byId.has(id));
  if (missing.length) throw new Error(`Mesh export selection contains unknown object id(s): ${missing.join(", ")}`);
  return { mode: "selection" as const, requestedIds, objects: requestedIds.map((id) => byId.get(id)!) };
}

function boundedModelFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/data:[^\s]+/g, "data:[omitted]").slice(0, 360) || "unknown model materialization error";
}

async function materializeImportedMeshState(
  project: DirectorProject,
  options: DirectorMeshExportOptions,
): Promise<MaterializedMeshExportState> {
  const scope = selectedObjects(project, options);
  const assetsById = new Map(project.assets.map((asset) => [asset.id, asset]));
  const meshes = new Map<string, { asset: DirectorAssetRef; mesh: DirectorMaterializedModelMesh }>();
  const failures: MaterializedMeshExportState["failures"] = new Map();
  const rootPromises = new Map<string, Promise<Object3D>>();
  const admittedAssetIds = new Set<string>();
  const loader = options.modelLoader ?? loadDirectorImportedModelObject;

  for (const object of scope.objects) {
    if ((!object.visible && !options.includeHidden) || object.geometryType || !object.assetRefId) continue;
    const asset = assetsById.get(object.assetRefId);
    if (!asset || asset.sourceType !== "model") {
      failures.set(object.id, {
        code: "asset_not_model",
        reason: `asset reference ${object.assetRefId} does not resolve to a model asset`,
      });
      continue;
    }
    if (object.kind === "character" || asset.kind === "character") {
      failures.set(object.id, {
        code: "rigged_character_requires_dcc",
        reason: "rigged character assets require pose-aware DCC export",
      });
      continue;
    }
    if (isDirectorSplatAssetFileName(asset.fileName)) {
      failures.set(object.id, {
        code: "splat_no_triangle_mesh",
        reason: "gaussian splat captures carry no triangle mesh and cannot be materialized for mesh export",
      });
      continue;
    }
    if (!admittedAssetIds.has(asset.id)) {
      if (admittedAssetIds.size >= DIRECTOR_MESH_EXPORT_MAX_IMPORTED_ASSETS) {
        failures.set(object.id, {
          code: "imported_asset_limit",
          reason: `imported model materialization is limited to ${DIRECTOR_MESH_EXPORT_MAX_IMPORTED_ASSETS} unique assets`,
        });
        continue;
      }
      admittedAssetIds.add(asset.id);
    }

    try {
      let rootPromise = rootPromises.get(asset.id);
      if (!rootPromise) {
        rootPromise = loader(asset);
        rootPromises.set(asset.id, rootPromise);
      }
      const root = await rootPromise;
      const mesh = materializeDirectorImportedModelMesh(
        project,
        object,
        asset,
        root,
        DIRECTOR_MESH_EXPORT_MAX_TRIANGLES,
      );
      meshes.set(object.id, { asset, mesh });
    } catch (error) {
      failures.set(object.id, { code: "model_materialization_failed", reason: boundedModelFailure(error) });
    }
  }
  return { meshes, failures };
}

function prepareMeshExport(
  project: DirectorProject,
  format: "obj" | "stl",
  options: DirectorMeshExportOptions,
  materialized?: MaterializedMeshExportState,
) {
  const scope = selectedObjects(project, options);
  const omitted: DirectorMeshExportReport["omitted"] = [];
  const entries: MeshEntry[] = [];
  scope.objects.forEach((object) => {
    if (!object.visible && !options.includeHidden) {
      omitted.push({ stableId: object.id, name: object.name, code: "hidden_object", reason: "hidden object excluded" });
      return;
    }
    if (!object.geometryType) {
      const imported = materialized?.meshes.get(object.id);
      if (imported) {
        entries.push({
          object,
          meshSource: "imported-model",
          primitiveType: null,
          assetRefId: imported.asset.id,
          sourceFileName: imported.asset.fileName,
          materialName: `mat_${safeName(object.id)}`,
          triangles: imported.mesh.triangles,
          negativeScaleBaked: imported.mesh.negativeScaleBaked,
          skinned: imported.mesh.skinned,
        });
        return;
      }
      const failure = object.assetRefId
        ? (materialized?.failures.get(object.id) ?? {
            code: "sync_export_requires_archive" as const,
            reason: "imported model materialization is available only through the asynchronous archive exporter",
          })
        : {
            code: "unsupported_object_kind" as const,
            reason: `${object.kind} has no supported primitive mesh`,
          };
      omitted.push({ stableId: object.id, name: object.name, code: failure.code, reason: failure.reason });
      return;
    }
    const { triangles, negativeScaleBaked } = trianglesFor(
      project,
      object as DirectorObject & { geometryType: NonNullable<DirectorObject["geometryType"]> },
    );
    if (!triangles.length) {
      omitted.push({
        stableId: object.id,
        name: object.name,
        code: "degenerate_geometry",
        reason: "transform produced only degenerate triangles",
      });
      return;
    }
    entries.push({
      object,
      meshSource: "primitive",
      primitiveType: object.geometryType as NonNullable<DirectorObject["geometryType"]>,
      assetRefId: null,
      sourceFileName: null,
      materialName: `mat_${safeName(object.id)}`,
      triangles,
      negativeScaleBaked,
      skinned: false,
    });
  });
  if (!entries.length) throw new Error("Mesh export contains no supported visible geometry.");
  const triangleCount = entries.reduce((sum, entry) => sum + entry.triangles.length, 0);
  if (triangleCount > DIRECTOR_MESH_EXPORT_MAX_TRIANGLES) {
    throw new Error(`Mesh export exceeds the ${DIRECTOR_MESH_EXPORT_MAX_TRIANGLES} triangle limit.`);
  }
  const warnings = new Set<string>();
  if (omitted.length)
    warnings.add(`${omitted.length} scoped object(s) were omitted; inspect omitted[] before delivery.`);
  if (project.cameras.length) warnings.add("Cameras are not represented in OBJ/STL mesh output.");
  if (project.lights?.length)
    warnings.add("Lights and environment settings are not represented in OBJ/STL mesh output.");
  if (project.storyboard || project.scene.timeline)
    warnings.add("Storyboard, animation, and timeline semantics are not represented in static mesh output.");
  if (format === "stl")
    warnings.add(
      "STL omits materials, textures, hierarchy, units, and rich scene metadata; stable IDs are encoded in solid names and fully retained in the manifest sidecar.",
    );
  if (entries.some((entry) => entry.object.material?.textures && Object.keys(entry.object.material.textures).length)) {
    warnings.add("Texture maps are not embedded; OBJ exports scalar material approximations and STL omits materials.");
  }
  const importedCount = entries.filter((entry) => entry.meshSource === "imported-model").length;
  if (importedCount) {
    warnings.add(
      `${importedCount} imported model object(s) were materialized from FBX/OBJ/glTF geometry; source materials were flattened to the Director object material for OBJ and omitted for STL.`,
    );
  }
  if (entries.some((entry) => entry.skinned)) {
    warnings.add(
      "Skinned mesh vertices were baked at the loader's current pose; animation and skeleton data are not retained.",
    );
  }
  if (entries.some((entry) => entry.negativeScaleBaked))
    warnings.add("Negative-scale handedness was baked by reversing triangle winding.");
  const reportBase = {
    adapter: DIRECTOR_MESH_EXPORT_ADAPTER,
    contract: DIRECTOR_INTERCHANGE_CONTRACT,
    format,
    exportedAt: options.exportedAt ?? new Date().toISOString(),
    projectRevision: getDirectorProjectRevision(project),
    coordinateSystem: { ...DIRECTOR_INTERCHANGE_COORDINATE_SYSTEM },
    scope: {
      mode: scope.mode,
      requestedObjectIds: scope.requestedIds,
      includedObjectIds: entries.map((entry) => entry.object.id),
    },
    objects: entries.map((entry) => ({
      stableId: entry.object.id,
      name: entry.object.name,
      meshSource: entry.meshSource,
      primitiveType: entry.primitiveType,
      assetRefId: entry.assetRefId,
      sourceFileName: entry.sourceFileName,
      triangleCount: entry.triangles.length,
      materialName: format === "obj" ? entry.materialName : null,
      negativeScaleBaked: entry.negativeScaleBaked,
    })),
    omitted,
    triangleCount,
    warnings: [...warnings],
  };
  return { entries, reportBase };
}

function rgb(color: string | undefined): [number, number, number] {
  const match = color?.match(/^#([0-9a-f]{6})$/i);
  if (!match) return [0.7, 0.75, 0.82];
  const value = Number.parseInt(match[1], 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

function serializeDirectorProjectToObj(
  project: DirectorProject,
  options: DirectorMeshExportOptions,
  materialized?: MaterializedMeshExportState,
) {
  const { entries, reportBase } = prepareMeshExport(project, "obj", options, materialized);
  const obj = [
    "# Director OBJ mesh export",
    `# adapter ${DIRECTOR_MESH_EXPORT_ADAPTER}`,
    "# units meter",
    "# upAxis Y",
    "# handedness right",
    `# projectRevision ${reportBase.projectRevision}`,
    "mtllib director-scene.mtl",
  ];
  const mtl = ["# Director scalar material approximations", "# Texture maps and node materials are not embedded."];
  let vertexOffset = 1;
  let normalOffset = 1;
  entries.forEach((entry) => {
    const objectName = `${safeName(entry.object.name)}__${safeName(entry.object.id)}`;
    obj.push("", `# directorStableId ${entry.object.id}`, `o ${objectName}`, `usemtl ${entry.materialName}`);
    const baseColor = rgb(entry.object.material?.baseColor ?? entry.object.color);
    const emissive = rgb(entry.object.material?.emissiveColor ?? "#000000");
    mtl.push(
      "",
      `newmtl ${entry.materialName}`,
      `Kd ${baseColor.map(number).join(" ")}`,
      `Ke ${emissive.map((value) => number(value * (entry.object.material?.emissiveIntensity ?? 0))).join(" ")}`,
      `d ${number(entry.object.material?.opacity ?? 1)}`,
      `Ns ${number((1 - (entry.object.material?.roughness ?? 0.7)) * 1000)}`,
    );
    entry.triangles.forEach((triangle) => {
      obj.push(
        `v ${triangle.a.map(number).join(" ")}`,
        `v ${triangle.b.map(number).join(" ")}`,
        `v ${triangle.c.map(number).join(" ")}`,
        `vn ${triangle.normal.map(number).join(" ")}`,
        `f ${vertexOffset}//${normalOffset} ${vertexOffset + 1}//${normalOffset} ${vertexOffset + 2}//${normalOffset}`,
      );
      vertexOffset += 3;
      normalOffset += 1;
    });
  });
  return { obj: `${obj.join("\n")}\n`, mtl: `${mtl.join("\n")}\n`, reportBase };
}

/**
 * Exports Director primitive objects to an OBJ string with MTL sidecar.
 *
 * Imported model assets are not materialized in this synchronous path; use
 * {@link exportDirectorProjectToObjArchive} for full OBJ export including
 * imported models.
 *
 * @param project - The Director project to export.
 * @param options - Export scope options.
 * @returns The OBJ and MTL strings along with the report base.
 */
export function exportDirectorProjectToObj(project: DirectorProject, options: DirectorMeshExportOptions = {}) {
  return serializeDirectorProjectToObj(project, options);
}

function serializeDirectorProjectToStl(
  project: DirectorProject,
  options: DirectorMeshExportOptions,
  materialized?: MaterializedMeshExportState,
) {
  const { entries, reportBase } = prepareMeshExport(project, "stl", options, materialized);
  const lines: string[] = [];
  entries.forEach((entry) => {
    const solidName = `director_${safeName(entry.object.id)}`;
    lines.push(`solid ${solidName}`);
    entry.triangles.forEach((triangle) => {
      lines.push(
        `  facet normal ${triangle.normal.map(number).join(" ")}`,
        "    outer loop",
        `      vertex ${triangle.a.map(number).join(" ")}`,
        `      vertex ${triangle.b.map(number).join(" ")}`,
        `      vertex ${triangle.c.map(number).join(" ")}`,
        "    endloop",
        "  endfacet",
      );
    });
    lines.push(`endsolid ${solidName}`);
  });
  return { stl: `${lines.join("\n")}\n`, reportBase };
}

/**
 * Exports Director primitive objects to an ASCII STL string.
 *
 * Like {@link exportDirectorProjectToObj}, this synchronous path only
 * handles primitives; use the archive variant for imported models.
 *
 * @param project - The Director project to export.
 * @param options - Export scope options.
 * @returns The STL string and report base.
 */
export function exportDirectorProjectToStl(project: DirectorProject, options: DirectorMeshExportOptions = {}) {
  return serializeDirectorProjectToStl(project, options);
}

async function sha256Hex(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function archivedReport(
  reportBase: Omit<DirectorMeshExportReport, "files">,
  files: Array<{ path: string; mimeType: string; bytes: Uint8Array }>,
) {
  return directorMeshExportReportSchema.parse({
    ...reportBase,
    files: await Promise.all(
      files.map(async (file) => ({
        path: file.path,
        mimeType: file.mimeType,
        byteLength: file.bytes.byteLength,
        sha256: await sha256Hex(file.bytes),
      })),
    ),
  });
}

async function zipMeshExport(
  reportBase: Omit<DirectorMeshExportReport, "files">,
  files: Array<{ path: string; mimeType: string; bytes: Uint8Array }>,
  fileName: string,
) {
  const report = await archivedReport(reportBase, files);
  const zip = new JSZip();
  const date = new Date(report.exportedAt);
  const decoder = new TextDecoder();
  files.forEach((file) => zip.file(file.path, decoder.decode(file.bytes), { date }));
  zip.file("director-export.json", `${JSON.stringify(report, null, 2)}\n`, { date });
  return {
    bytes: await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } }),
    fileName,
    report,
  };
}

/**
 * Exports a Director project to a zipped OBJ+MTL archive.
 *
 * Imported model assets (FBX, OBJ, glTF) are asynchronously loaded and
 * materialized into world-space triangles. The archive includes a
 * `director-export.json` provenance report.
 *
 * @param project - The Director project to export.
 * @param options - Export scope options.
 * @returns The ZIP archive bytes, suggested file name, and provenance report.
 */
export async function exportDirectorProjectToObjArchive(
  project: DirectorProject,
  options: DirectorMeshExportOptions = {},
) {
  const encoder = new TextEncoder();
  const materialized = await materializeImportedMeshState(project, options);
  const result = serializeDirectorProjectToObj(project, options, materialized);
  return zipMeshExport(
    result.reportBase,
    [
      { path: "director-scene.obj", mimeType: DIRECTOR_OBJ_MIME_TYPE, bytes: encoder.encode(result.obj) },
      { path: "director-scene.mtl", mimeType: "text/plain;charset=utf-8", bytes: encoder.encode(result.mtl) },
    ],
    "director-obj.zip",
  );
}

/**
 * Exports a Director project to a zipped STL archive.
 *
 * Works like {@link exportDirectorProjectToObjArchive} but produces ASCII STL.
 * Materials, textures, and hierarchy are omitted; stable IDs are encoded in
 * solid names and fully retained in the manifest sidecar.
 *
 * @param project - The Director project to export.
 * @param options - Export scope options.
 * @returns The ZIP archive bytes, suggested file name, and provenance report.
 */
export async function exportDirectorProjectToStlArchive(
  project: DirectorProject,
  options: DirectorMeshExportOptions = {},
) {
  const encoder = new TextEncoder();
  const materialized = await materializeImportedMeshState(project, options);
  const result = serializeDirectorProjectToStl(project, options, materialized);
  return zipMeshExport(
    result.reportBase,
    [{ path: "director-scene.stl", mimeType: DIRECTOR_STL_MIME_TYPE, bytes: encoder.encode(result.stl) }],
    "director-stl.zip",
  );
}
