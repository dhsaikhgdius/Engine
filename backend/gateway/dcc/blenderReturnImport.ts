import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Euler, Quaternion, Vector3 } from "three";
import { z } from "zod";
import type { DirectorAuthoringAction } from "@director/agent-engine";
import type { DirectorWorkbenchOperation } from "@director/agent-engine";
import type { DirectorProject, DirectorTransform } from "@director/project-schema";
import {
  DEFAULT_DIRECTOR_CAMERA_ASPECT_RATIO,
  DEFAULT_DIRECTOR_CAMERA_SENSOR_FORMAT,
  DIRECTOR_CAMERA_OPTICS_LIMITS,
  getCharacterPoseControlValueLimits,
  getDirectorProjectRevision,
  getFocalLengthFromVerticalFov,
  normalizeDirectorCameraOptics,
  resolveCharacterPoseControls,
} from "@director/project-schema";
import {
  blenderTransformToDirector,
  blenderWorldPointToDirector,
  canonicalDccTransformToDirector,
  canonicalWorldPointToDirector,
  directorDccConnectorProviderIdSchema,
  directorDccTransformSchema,
  directorTransformToBlender,
  directorTransformToCanonicalDcc,
  directorWorldPointToBlender,
  directorWorldPointToCanonical,
  type DirectorDccConnectorProviderId,
  type DirectorDccTransform,
} from "@director/dcc-protocol";
import {
  DIRECTOR_DCC_IMPORT_PLAN_CONTRACT,
  directorDccExchangePackageManifestSchema,
  directorDccImportPlanSchema,
  directorDccReturnManifestSchema,
  type DirectorDccExchangePackageManifest,
  type DirectorDccImportPlanCameraOptics,
  type DirectorDccImportPlanLightPatch,
  type DirectorDccImportPlanV1,
  type DirectorDccOmittedAddition,
  type DirectorDccOmittedOptics,
  type DirectorDccReturnManifestV1,
} from "@director/dcc-protocol";

/**
 * Machine-readable error codes for DCC return (round-trip) import failures.
 * Each code maps to a human-readable recovery hint in the `RECOVERY` table.
 */
export type DirectorDccImportErrorCode =
  | "stale_source_revision"
  | "package_invalid"
  | "path_escape"
  | "unknown_director_id"
  | "conflict_unresolved"
  | "stale_project_revision"
  | "browser_target_unavailable"
  | "authoring_failed";

const RECOVERY: Record<DirectorDccImportErrorCode, string> = {
  stale_source_revision:
    "Rebuild the import plan against the live project: unchanged objects merge automatically. Confirm each conflicting director_id in Director or exclude it with skip_director_ids; re-export only if the export job snapshot is missing.",
  package_invalid:
    "Regenerate the return package with the Director connector's return export (Blender director_return_export.py or the engine connector's headless export) and keep manifest/hash files intact.",
  path_escape: "Use a package under the provider's data/dcc-jobs/<provider> job root only.",
  unknown_director_id: "Edit a scene exported by Director and retain each object's director_id.",
  conflict_unresolved:
    "Confirm each conflicting object in Director or exclude it with skip_director_ids, rebuild the plan, then apply it.",
  stale_project_revision: "Observe the live project again, rebuild the import plan, and use a new idempotency key.",
  browser_target_unavailable: "Open the target Director Stage and retry against the same browser target.",
  authoring_failed:
    "Inspect the returned authoring error, correct the plan or project state, then rebuild before retrying.",
};

/**
 * An error thrown when a Blender return import fails a validation, conflict,
 * or authoring check. Carries a machine-readable code, an HTTP status, and
 * a human-readable recovery hint.
 */
export class DirectorDccImportError extends Error {
  /** Machine-readable error code. */
  readonly code: DirectorDccImportErrorCode;
  /** HTTP status code that best represents this error. */
  readonly status: number;
  /** Human-readable recovery hint. */
  readonly recovery: string;

  constructor(code: DirectorDccImportErrorCode, message: string, status = 400) {
    super(message);
    this.name = "DirectorDccImportError";
    this.code = code;
    this.status = status;
    this.recovery = RECOVERY[code];
  }
}

/** A validated Blender return package ready for plan construction. */
export interface ValidatedDirectorDccReturnPackage {
  /** Absolute path to the package directory. */
  packageDirectory: string;
  /** Relative path from the job root to the package directory. */
  packageDir: string;
  /** Absolute path to the verified manifest.json. */
  manifestPath: string;
  /** SHA-256 of the manifest file bytes. */
  manifestHash: string;
  /** The parsed and validated manifest. */
  manifest: DirectorDccReturnManifestV1;
  /** Map of relative paths to absolute, verified file paths (hash-checked). */
  files: Map<string, string>;
}

/** The response from a Director authoring operation. */
export interface DirectorDccAuthoringResponse {
  /** Whether the authoring operation was accepted. */
  success: boolean;
  /** Optional result payload. */
  result?: unknown;
  /** Optional error message on failure. */
  error?: string;
}

/** Options for building a DCC return import plan. */
export interface DccReturnImportPlanOptions {
  /** Director IDs whose changes are skipped instead of applied or conflicted. */
  skipDirectorIds?: readonly string[];
  /**
   * Opt in to `object_addition` changes (objects that gained a fresh
   * director_id in the DCC after the export snapshot). Off by default:
   * additions are listed as reviewable skips, never applied silently.
   */
  includeNewObjects?: boolean;
}

/** Backwards-compatible alias for the Blender-era option name. */
export type BlenderReturnImportPlanOptions = DccReturnImportPlanOptions;

/**
 * A DCC return importer validates a return package, builds an import plan
 * against the live project, and applies the plan through the Director authoring
 * surface. One importer instance serves one connector provider's job root.
 */
export interface DccReturnImporter {
  /** The connector provider whose return packages this importer accepts. */
  readonly provider: DirectorDccConnectorProviderId;
  /** Validate a return package directory and hash-check every file. */
  validatePackage(packageDir: string): Promise<ValidatedDirectorDccReturnPackage>;
  /** Build an import plan from a validated package and live project. */
  buildImportPlan(
    packageDir: string,
    project: DirectorProject,
    options?: DccReturnImportPlanOptions,
  ): Promise<DirectorDccImportPlanV1>;
  /** Apply a validated import plan, copying assets and issuing authoring actions. */
  applyImportPlan(
    plan: DirectorDccImportPlanV1,
    project: DirectorProject,
    expectedRevision: string,
    idempotencyKey: string,
    applyAuthoring: (operation: DirectorWorkbenchOperation) => Promise<DirectorDccAuthoringResponse | null>,
  ): Promise<{
    plan: DirectorDccImportPlanV1;
    authoring: DirectorDccAuthoringResponse | null;
    copiedAssets: Array<{ assetId: string; url: string; hash: string }>;
  }>;
}

/** Backwards-compatible alias for the Blender-era importer name. */
export type BlenderReturnImporter = DccReturnImporter;

/** Configuration for creating a DCC return importer. */
export interface CreateDccReturnImporterOptions {
  /** Absolute or relative workspace root path. */
  workspaceRoot: string;
  /** Directory under which DCC job data is persisted. */
  dataDirectory: string;
  /** Connector provider whose job root and wire space apply (defaults to blender). */
  provider?: DirectorDccConnectorProviderId;
}

/** Backwards-compatible alias for the Blender-era options name. */
export type CreateBlenderReturnImporterOptions = CreateDccReturnImporterOptions;

function isInside(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function posixRelative(parent: string, child: string): string {
  return relative(parent, child).split(sep).join("/");
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(path: string): Promise<string> {
  return sha256(await readFile(path));
}

function safeSegment(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return normalized || "director-asset";
}

function sceneTransform(project: DirectorProject): DirectorTransform {
  return {
    position: project.scene.position,
    rotation: project.scene.rotation,
    scale: [project.scene.scale, project.scene.scale, project.scene.scale],
  };
}

function refinedAssetId(directorId: string, hash: string): string {
  return `asset-${safeSegment(directorId)}-refined-${hash.slice(0, 12)}`;
}

function additionAssetId(directorId: string, hash: string): string {
  return `asset-${safeSegment(directorId)}-added-${hash.slice(0, 12)}`;
}

const finiteVec3Schema = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);

/**
 * Per-object export-time state recovered from the `scene.director-dcc.json`
 * that `exportBlend` writes into each DCC job directory. Extra fields stay
 * untouched so older and newer scene packages both parse.
 */
const directorDccSourceBaselineSchema = z.looseObject({
  contract: z.literal("director-dcc-scene-v1"),
  packageId: z.string(),
  sourceRevision: z.string(),
  objects: z.array(
    z.looseObject({
      id: z.string(),
      transform: directorDccTransformSchema,
      assetRefId: z.string().optional(),
      geometryType: z.string().optional(),
      color: z.string().optional(),
      parentObjectId: z.string().optional(),
      poseControls: z.record(z.string(), z.number().finite()).optional(),
    }),
  ),
  cameras: z.array(
    z.looseObject({
      id: z.string(),
      transform: directorDccTransformSchema,
      target: finiteVec3Schema,
      focalLengthMm: z.number().finite().optional(),
      apertureFStop: z.number().finite().optional(),
      focusDistanceM: z.number().finite().optional(),
      nearClipM: z.number().finite().optional(),
      farClipM: z.number().finite().optional(),
      sensorFormat: z.string().optional(),
    }),
  ),
  lights: z
    .array(
      z.looseObject({
        id: z.string(),
        position: finiteVec3Schema,
        target: finiteVec3Schema.optional(),
        color: z.string(),
        intensity: z.number().finite(),
      }),
    )
    .optional(),
});

/** The parsed export-time baseline snapshot from a DCC scene package. */
export type DirectorDccSourceBaseline = z.infer<typeof directorDccSourceBaselineSchema>;

/** Options for building a DCC import plan with object-level conflict detection. */
export interface DirectorDccImportPlanBuildOptions {
  /** Export-time per-object snapshot; enables object-level conflict detection on stale revisions. */
  baseline?: DirectorDccSourceBaseline | null;
  /** Changes for these director_ids are skipped instead of applied or conflicting. */
  skipDirectorIds?: readonly string[];
  /** Opt in to `object_addition` changes; off by default (reviewed skips). */
  includeNewObjects?: boolean;
}

const BASELINE_TOLERANCE = 1e-6;

function vectorsClose(left: readonly number[], right: readonly number[]): boolean {
  return (
    left.length === right.length && left.every((value, index) => Math.abs(value - right[index]!) <= BASELINE_TOLERANCE)
  );
}

function dccTransformsEqual(left: DirectorDccTransform, right: DirectorDccTransform): boolean {
  if (!vectorsClose(left.location, right.location) || !vectorsClose(left.scale, right.scale)) return false;
  // q and -q encode the same rotation; both sides are normalized on export.
  const dot = left.rotationQuaternion.reduce((sum, value, index) => sum + value * right.rotationQuaternion[index]!, 0);
  return Math.abs(Math.abs(dot) - 1) <= BASELINE_TOLERANCE;
}

/**
 * Coordinate boundary of a return package: Blender packages carry Blender
 * Z-up transforms, while engine connectors already converted to Director's
 * canonical space at the provider boundary (identity wire map).
 */
interface DccReturnSpace {
  toDirector(transform: DirectorDccTransform, world: DirectorTransform): DirectorTransform;
  fromDirector(transform: DirectorTransform, world: DirectorTransform): DirectorDccTransform;
  worldPointFromDirector(point: [number, number, number], world: DirectorTransform): [number, number, number];
  worldPointToDirector(point: [number, number, number], world: DirectorTransform): [number, number, number];
}

const BLENDER_RETURN_SPACE: DccReturnSpace = {
  toDirector: (transform, world) => blenderTransformToDirector(transform, world),
  fromDirector: (transform, world) => directorTransformToBlender(transform, world),
  worldPointFromDirector: (point, world) => directorWorldPointToBlender(point, world),
  worldPointToDirector: (point, world) => blenderWorldPointToDirector(point, world),
};

const CANONICAL_RETURN_SPACE: DccReturnSpace = {
  toDirector: (transform, world) => canonicalDccTransformToDirector(transform, world),
  fromDirector: (transform, world) => directorTransformToCanonicalDcc(transform, world),
  worldPointFromDirector: (point, world) => directorWorldPointToCanonical(point, world),
  worldPointToDirector: (point, world) => canonicalWorldPointToDirector(point, world),
};

function returnSpaceForProvider(provider: DirectorDccConnectorProviderId): DccReturnSpace {
  return provider === "blender" ? BLENDER_RETURN_SPACE : CANONICAL_RETURN_SPACE;
}

/** The optics a Director camera would export today, mirroring the scene-package builder. */
function liveCameraExportedOptics(camera: DirectorProject["cameras"][number]) {
  const optics = normalizeDirectorCameraOptics(camera);
  const aspectRatio = camera.aspectRatio ?? DEFAULT_DIRECTOR_CAMERA_ASPECT_RATIO;
  const sensorFormat = camera.sensorFormat ?? DEFAULT_DIRECTOR_CAMERA_SENSOR_FORMAT;
  const focalLengthMm = camera.focalLengthMm ?? getFocalLengthFromVerticalFov(camera.fov, aspectRatio, sensorFormat);
  return {
    focalLengthMm,
    apertureFStop: optics.apertureFStop,
    focusDistanceM: optics.focusDistanceM,
    nearClipM: optics.nearClipM,
    farClipM: optics.farClipM,
    sensorFormat,
  };
}

function scalarsClose(left: number | undefined, right: number | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return Math.abs(left - right) <= Math.max(Math.abs(left), Math.abs(right), 1) * 1e-6;
}

function cameraOpticsDiverged(
  camera: DirectorProject["cameras"][number],
  snapshot: DirectorDccSourceBaseline["cameras"][number],
): boolean {
  if (snapshot.focalLengthMm === undefined) {
    // Pre-optics export snapshots cannot verify optics edits; be conservative.
    return true;
  }
  const live = liveCameraExportedOptics(camera);
  return (
    !scalarsClose(live.focalLengthMm, snapshot.focalLengthMm) ||
    !scalarsClose(live.apertureFStop, snapshot.apertureFStop) ||
    !scalarsClose(live.focusDistanceM, snapshot.focusDistanceM) ||
    !scalarsClose(live.nearClipM, snapshot.nearClipM) ||
    !scalarsClose(live.farClipM, snapshot.farClipM) ||
    (snapshot.sensorFormat !== undefined && live.sensorFormat !== snapshot.sensorFormat)
  );
}

function poseControlsClose(
  left: Record<string, number> | undefined,
  right: Record<string, number> | undefined,
): boolean {
  const leftEntries = left ?? {};
  const rightEntries = right ?? {};
  const keys = new Set([...Object.keys(leftEntries), ...Object.keys(rightEntries)]);
  for (const key of keys) {
    if (!scalarsClose(leftEntries[key] ?? 0, rightEntries[key] ?? 0)) return false;
  }
  return true;
}

function directorSideDivergence(
  change: DirectorDccReturnManifestV1["changes"][number],
  entity:
    | DirectorProject["objects"][number]
    | DirectorProject["cameras"][number]
    | NonNullable<DirectorProject["lights"]>[number],
  world: DirectorTransform,
  baseline: DirectorDccSourceBaseline,
  space: DccReturnSpace,
): string | null {
  if (change.kind === "light_update") {
    const light = entity as NonNullable<DirectorProject["lights"]>[number];
    const snapshot = (baseline.lights ?? []).find((candidate) => candidate.id === change.directorId);
    if (!snapshot) {
      return `Light ${change.directorId} is not part of the export snapshot, so its Director-side edits cannot be verified.`;
    }
    const positionMoved =
      light.position !== undefined &&
      !vectorsClose(space.worldPointFromDirector(light.position, world), snapshot.position);
    const targetMoved =
      light.target !== undefined &&
      snapshot.target !== undefined &&
      !vectorsClose(space.worldPointFromDirector(light.target, world), snapshot.target);
    if (
      positionMoved ||
      targetMoved ||
      light.color !== snapshot.color ||
      !scalarsClose(light.intensity, snapshot.intensity)
    ) {
      return `Light ${change.directorId} changed in Director after the export, and the return package also updates it.`;
    }
    return null;
  }
  if (change.entityType === "camera") {
    const camera = entity as DirectorProject["cameras"][number];
    const snapshot = baseline.cameras.find((candidate) => candidate.id === change.directorId);
    if (!snapshot) {
      return `Camera ${change.directorId} is not part of the export snapshot, so its Director-side edits cannot be verified.`;
    }
    const checkTransform = change.kind !== "camera_update" || change.transform !== undefined;
    if (checkTransform && !dccTransformsEqual(space.fromDirector(camera.transform, world), snapshot.transform)) {
      return `Camera ${change.directorId} moved in Director after the export, and the return package also updates it.`;
    }
    if (checkTransform && !vectorsClose(space.worldPointFromDirector(camera.target, world), snapshot.target)) {
      return `Camera ${change.directorId} target changed in Director after the export, and the return package also updates it.`;
    }
    if (change.kind === "camera_update" && change.optics && cameraOpticsDiverged(camera, snapshot)) {
      return `Camera ${change.directorId} optics changed in Director after the export (or the export snapshot predates optics returns), and the return package also updates them.`;
    }
    return null;
  }
  const object = entity as DirectorProject["objects"][number];
  const snapshot = baseline.objects.find((candidate) => candidate.id === change.directorId);
  if (!snapshot) {
    return `Object ${change.directorId} is not part of the export snapshot, so its Director-side edits cannot be verified.`;
  }
  const transformChanged =
    !dccTransformsEqual(space.fromDirector(object.transform, world), snapshot.transform) ||
    (object.parentObjectId ?? null) !== (snapshot.parentObjectId ?? null);
  if (change.kind === "pose_update") {
    if (!poseControlsClose(snapshot.poseControls, resolveCharacterPoseControls(object.characterRig ?? null))) {
      return `Character ${change.directorId} pose controls changed in Director after the export, and the return package also updates them.`;
    }
    if (change.transform && transformChanged) {
      return `Object ${change.directorId} transform changed in Director after the export, and the return package also updates it.`;
    }
    return null;
  }
  if (change.kind === "mesh_replacement") {
    const geometryChanged =
      (object.assetRefId ?? null) !== (snapshot.assetRefId ?? null) ||
      (object.geometryType ?? null) !== (snapshot.geometryType ?? null) ||
      (object.color ?? null) !== (snapshot.color ?? null);
    if (geometryChanged) {
      return `Object ${change.directorId} geometry or asset reference changed in Director after the export, and the return package replaces its mesh.`;
    }
    if (change.transform && transformChanged) {
      return `Object ${change.directorId} transform changed in Director after the export, and the return package also updates it.`;
    }
    return null;
  }
  return transformChanged
    ? `Object ${change.directorId} transform changed in Director after the export, and the return package also updates it.`
    : null;
}

/**
 * Builds a DCC import plan from a validated return package and the live project.
 *
 * Each change in the return manifest is matched against the live project by
 * stable `directorId`. When the source revision is stale and an export-time
 * baseline is available, object-level conflict detection is applied: entities
 * that changed on both sides are reported as conflicts rather than applied.
 *
 * @param validated - A validated return package (packageDir, manifest, manifestHash).
 * @param project - The live Director project.
 * @param options - Optional baseline snapshot and skip list.
 * @returns A plan with operations, conflicts, and a `ready` flag.
 */
export function buildDirectorDccImportPlan(
  validated: Pick<ValidatedDirectorDccReturnPackage, "packageDir" | "manifest" | "manifestHash">,
  project: DirectorProject,
  options: DirectorDccImportPlanBuildOptions = {},
): DirectorDccImportPlanV1 {
  const { manifest } = validated;
  const space = returnSpaceForProvider(manifest.provider ?? "blender");
  const targetRevision = getDirectorProjectRevision(project);
  const operations: DirectorDccImportPlanV1["operations"] = [];
  const conflicts: DirectorDccImportPlanV1["conflicts"] = [];
  const omittedOptics: DirectorDccOmittedOptics[] = [];
  const omittedAdditions: DirectorDccOmittedAddition[] = [];
  const warnings = [...manifest.warnings];
  const world = sceneTransform(project);
  const sourceIsCurrent = manifest.sourceRevision === targetRevision;
  const baseline = sourceIsCurrent ? null : (options.baseline ?? null);
  const requestedSkips = new Set(options.skipDirectorIds ?? []);
  const matchedSkips = new Set<string>();

  if (!sourceIsCurrent && !baseline) {
    conflicts.push({
      directorId: "project",
      code: "stale_source_revision",
      reason:
        `Return package was exported from ${manifest.sourceRevision}, but the live project is ${targetRevision}, ` +
        "and no export snapshot is available for object-level conflict detection.",
    });
  } else if (!sourceIsCurrent) {
    warnings.push(
      `Return package was exported from ${manifest.sourceRevision}, but the live project is ${targetRevision}; ` +
        "each change merges per stable director_id and objects edited on both sides are reported as conflicts.",
    );
  }

  const clamp = (value: number, min: number, max: number, label: string): number => {
    if (value < min || value > max) {
      const clamped = Math.min(max, Math.max(min, value));
      warnings.push(`${label} ${value} is outside Director's ${min}-${max} range and was baked to ${clamped}.`);
      return clamped;
    }
    return value;
  };

  for (const change of manifest.changes) {
    if (requestedSkips.has(change.directorId)) {
      matchedSkips.add(change.directorId);
      const reason = `Skipped on request (skip_director_ids); the DCC change for ${change.directorId} is not applied.`;
      operations.push({ op: "skip", directorId: change.directorId, reason });
      if (change.kind === "object_addition") {
        omittedAdditions.push({
          directorId: change.directorId,
          name: change.name,
          meshFile: change.meshFile,
          code: "skip_requested",
          reason,
        });
      }
      continue;
    }
    if (change.kind === "object_addition") {
      const existing =
        project.objects.find((candidate) => candidate.id === change.directorId) ??
        project.cameras.find((candidate) => candidate.id === change.directorId) ??
        (project.lights ?? []).find((candidate) => candidate.id === change.directorId);
      if (existing) {
        const reason =
          `Stable ID ${change.directorId} already exists in the live project; a new DCC object cannot reuse it. ` +
          "Assign a fresh director_id in the DCC and re-export the return package.";
        operations.push({ op: "skip", directorId: change.directorId, reason });
        conflicts.push({ directorId: change.directorId, code: "duplicate_director_id", reason });
        omittedAdditions.push({
          directorId: change.directorId,
          name: change.name,
          meshFile: change.meshFile,
          code: "duplicate_director_id",
          reason,
        });
        continue;
      }
      if (!options.includeNewObjects) {
        // Additions are never auto-imported: without the explicit opt-in the
        // plan lists them as reviewable skips and stays ready to apply.
        const reason =
          `New DCC object "${change.name}" (${change.directorId}) is available but not imported; ` +
          "rebuild the plan with include_new_objects to import it after review.";
        operations.push({ op: "skip", directorId: change.directorId, reason });
        omittedAdditions.push({
          directorId: change.directorId,
          name: change.name,
          meshFile: change.meshFile,
          code: "opt_in_required",
          reason,
        });
        continue;
      }
      const hash = manifest.fileHashes[change.meshFile]!;
      operations.push({
        op: "create_prop",
        objectId: change.directorId,
        name: change.name,
        assetId: additionAssetId(change.directorId, hash),
        assetLabel: change.assetLabel ?? `${change.name} (DCC)`,
        glbPath: change.meshFile,
        hash,
        transform: space.toDirector(change.transform, world),
      });
      continue;
    }
    const object = project.objects.find((candidate) => candidate.id === change.directorId);
    const camera = project.cameras.find((candidate) => candidate.id === change.directorId);
    const light = (project.lights ?? []).find((candidate) => candidate.id === change.directorId);
    const expected = change.entityType === "camera" ? camera : change.entityType === "light" ? light : object;
    if (!expected) {
      const actualKind = object ? "an object" : camera ? "a camera" : light ? "a light" : null;
      const reason = actualKind
        ? `Stable ID ${change.directorId} resolves to ${actualKind}, not ${change.entityType}.`
        : `Stable ID ${change.directorId} no longer exists in the live project.`;
      operations.push({ op: "skip", directorId: change.directorId, reason });
      conflicts.push({
        directorId: change.directorId,
        code: actualKind ? "entity_type_mismatch" : "unknown_director_id",
        reason,
      });
      continue;
    }
    if (change.kind === "pose_update" && (object!.kind !== "character" || !object!.characterRig)) {
      const reason = `Stable ID ${change.directorId} is not a rigged Director character, so its pose sample cannot be applied.`;
      operations.push({ op: "skip", directorId: change.directorId, reason });
      conflicts.push({ directorId: change.directorId, code: "entity_type_mismatch", reason });
      continue;
    }

    if (baseline) {
      const divergence = directorSideDivergence(change, expected, world, baseline, space);
      if (divergence) {
        operations.push({ op: "skip", directorId: change.directorId, reason: divergence });
        conflicts.push({ directorId: change.directorId, code: "stale_source_revision", reason: divergence });
        continue;
      }
    }

    if (change.kind === "mesh_replacement") {
      const hash = manifest.fileHashes[change.meshFile]!;
      operations.push({
        op: "link_refined_asset",
        objectId: object!.id,
        assetId: refinedAssetId(object!.id, hash),
        assetLabel: change.assetLabel ?? `${object!.name} refined`,
        glbPath: change.meshFile,
        hash,
      });
      if (change.transform) {
        operations.push({
          op: "update_transform",
          entityType: "object",
          objectId: object!.id,
          transform: space.toDirector(change.transform, world),
        });
      }
      continue;
    }

    if (change.kind === "camera_update") {
      if (change.transform) {
        operations.push({
          op: "update_transform",
          entityType: "camera",
          objectId: change.directorId,
          transform: space.toDirector(change.transform, world),
        });
      }
      if (change.optics) {
        const optics: DirectorDccImportPlanCameraOptics = {};
        const label = (field: string) => `Camera ${change.directorId} ${field}`;
        if (change.optics.focalLengthMm !== undefined) {
          optics.focal_length_mm = clamp(change.optics.focalLengthMm, 12, 200, label("focal length (mm)"));
        }
        if (change.optics.apertureFStop !== undefined) {
          const { min, max } = DIRECTOR_CAMERA_OPTICS_LIMITS.apertureFStop;
          optics.aperture_f_stop = clamp(change.optics.apertureFStop, min, max, label("aperture (f-stop)"));
        }
        if (change.optics.focusDistanceM !== undefined) {
          const { min, max } = DIRECTOR_CAMERA_OPTICS_LIMITS.focusDistanceM;
          optics.focus_distance_m = clamp(change.optics.focusDistanceM, min, max, label("focus distance (m)"));
        }
        if (change.optics.nearClipM !== undefined) {
          const { min, max } = DIRECTOR_CAMERA_OPTICS_LIMITS.nearClipM;
          optics.near_clip_m = clamp(change.optics.nearClipM, min, max, label("near clip (m)"));
        }
        if (change.optics.farClipM !== undefined) {
          const { min, max } = DIRECTOR_CAMERA_OPTICS_LIMITS.farClipM;
          optics.far_clip_m = clamp(change.optics.farClipM, min, max, label("far clip (m)"));
        }
        // Sensor format is a Director named gate: the Blender exporter never
        // emits sensor mm edits, and the Gateway must warn-and-omit any return
        // package that still carries sensorFormat (crafted/legacy packages).
        if (change.optics.sensorFormat !== undefined) {
          const reason = `Camera ${change.directorId} sensor format '${change.optics.sensorFormat}' was omitted from the return plan (warn-and-omit); choose a sensor format in Director's named gates instead of editing Blender sensor size.`;
          warnings.push(reason);
          omittedOptics.push({
            directorId: change.directorId,
            code: "sensor_format",
            field: "sensorFormat",
            reason,
          });
        }
        if (Object.keys(optics).length > 0) {
          operations.push({ op: "update_camera_optics", objectId: change.directorId, optics });
        }
      }
      continue;
    }

    if (change.kind === "light_update") {
      const patch: DirectorDccImportPlanLightPatch = {};
      if (change.properties.color !== undefined) patch.color = change.properties.color.toLowerCase();
      if (change.properties.intensity !== undefined) {
        patch.intensity = clamp(change.properties.intensity, 0, 100, `Light ${change.directorId} intensity`);
      }
      if (change.properties.position !== undefined) {
        patch.position = space.worldPointToDirector(change.properties.position, world);
      }
      if (change.properties.target !== undefined) {
        patch.target = space.worldPointToDirector(change.properties.target, world);
      }
      operations.push({ op: "update_light", lightId: change.directorId, patch });
      continue;
    }

    if (change.kind === "pose_update") {
      const controls = Object.entries(change.controls)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([control, value]) => {
          const limits = getCharacterPoseControlValueLimits(control, object!.bodyType ?? null);
          return {
            control: control as keyof typeof change.controls,
            value: clamp(value, limits.min, limits.max, `Character ${change.directorId} pose control ${control}`),
          };
        });
      operations.push({ op: "set_character_pose", objectId: change.directorId, controls });
      if (change.transform) {
        operations.push({
          op: "update_transform",
          entityType: "object",
          objectId: change.directorId,
          transform: space.toDirector(change.transform, world),
        });
      }
      continue;
    }

    operations.push({
      op: "update_transform",
      entityType: change.entityType,
      objectId: change.directorId,
      transform: space.toDirector(change.transform, world),
    });
  }

  for (const skipped of requestedSkips) {
    if (!matchedSkips.has(skipped)) {
      warnings.push(`skip_director_ids entry "${skipped}" matches no change in the return package.`);
    }
  }

  return directorDccImportPlanSchema.parse({
    contract: DIRECTOR_DCC_IMPORT_PLAN_CONTRACT,
    ready: conflicts.length === 0,
    packageId: manifest.packageId,
    packageDir: validated.packageDir,
    manifestHash: validated.manifestHash,
    sourceRevision: manifest.sourceRevision,
    targetRevision,
    operations,
    conflicts,
    warnings,
    ...(omittedOptics.length > 0 ? { omittedOpticsCount: omittedOptics.length, omittedOptics } : {}),
    ...(omittedAdditions.length > 0 ? { omittedAdditionsCount: omittedAdditions.length, omittedAdditions } : {}),
  });
}

function cameraTargetForTransform(project: DirectorProject, cameraId: string, transform: DirectorTransform) {
  const camera = project.cameras.find((candidate) => candidate.id === cameraId);
  if (!camera) throw new DirectorDccImportError("unknown_director_id", `Camera ${cameraId} no longer exists.`, 409);
  const currentDistance = new Vector3(...camera.target).distanceTo(new Vector3(...camera.transform.position));
  const distance = Math.max(currentDistance, camera.focusDistanceM ?? 1, 0.01);
  const quaternion = new Quaternion().setFromEuler(new Euler(...transform.rotation, "XYZ"));
  const target = new Vector3(0, 0, -1).applyQuaternion(quaternion).multiplyScalar(distance);
  target.add(new Vector3(...transform.position));
  return [target.x, target.y, target.z] as [number, number, number];
}

/** The Director `update_camera` patch shape assembled from plan operations. */
interface CameraPatchAccumulator {
  position?: [number, number, number];
  target?: [number, number, number];
  focal_length_mm?: number;
  aperture_f_stop?: number;
  focus_distance_m?: number;
  near_clip_m?: number;
  far_clip_m?: number;
  sensor_format?: DirectorDccImportPlanCameraOptics["sensor_format"];
}

function authoringActionsForPlan(
  plan: DirectorDccImportPlanV1,
  project: DirectorProject,
  copied: Map<string, { url: string; fileName: string }>,
): DirectorAuthoringAction[] {
  const objectPatches = new Map<
    string,
    { asset_id?: string; transform?: Partial<DirectorTransform>; force: boolean }
  >();
  const cameraPatches = new Map<string, CameraPatchAccumulator>();
  const actions: DirectorAuthoringAction[] = [];

  for (const operation of plan.operations) {
    if (operation.op === "link_refined_asset") {
      const object = project.objects.find((candidate) => candidate.id === operation.objectId);
      const copiedAsset = copied.get(operation.assetId);
      if (!object || !copiedAsset) {
        throw new DirectorDccImportError("package_invalid", `Prepared asset ${operation.assetId} is unavailable.`);
      }
      actions.push({
        action: "upsert_asset",
        asset: {
          id: operation.assetId,
          kind: object.kind === "camera" ? "prop" : object.kind,
          sourceType: "model",
          fileName: copiedAsset.fileName,
          name: operation.assetLabel,
          url: copiedAsset.url,
          assetSource: "local",
        },
      });
      const patch = objectPatches.get(object.id) ?? { force: true };
      patch.asset_id = operation.assetId;
      objectPatches.set(object.id, patch);
      continue;
    }
    if (operation.op === "create_prop") {
      const copiedAsset = copied.get(operation.assetId);
      if (!copiedAsset) {
        throw new DirectorDccImportError("package_invalid", `Prepared asset ${operation.assetId} is unavailable.`);
      }
      actions.push({
        action: "upsert_asset",
        asset: {
          id: operation.assetId,
          kind: "prop",
          sourceType: "model",
          fileName: copiedAsset.fileName,
          name: operation.assetLabel,
          url: copiedAsset.url,
          assetSource: "local",
        },
      });
      actions.push({
        action: "add_object",
        id: operation.objectId,
        name: operation.name,
        kind: "prop",
        asset_id: operation.assetId,
        transform: operation.transform,
      });
      continue;
    }
    if (operation.op === "update_camera_optics") {
      const patch = cameraPatches.get(operation.objectId) ?? {};
      if (operation.optics.focal_length_mm !== undefined) patch.focal_length_mm = operation.optics.focal_length_mm;
      if (operation.optics.aperture_f_stop !== undefined) patch.aperture_f_stop = operation.optics.aperture_f_stop;
      if (operation.optics.focus_distance_m !== undefined) patch.focus_distance_m = operation.optics.focus_distance_m;
      if (operation.optics.near_clip_m !== undefined) patch.near_clip_m = operation.optics.near_clip_m;
      if (operation.optics.far_clip_m !== undefined) patch.far_clip_m = operation.optics.far_clip_m;
      if (operation.optics.sensor_format !== undefined) patch.sensor_format = operation.optics.sensor_format;
      cameraPatches.set(operation.objectId, patch);
      continue;
    }
    if (operation.op === "update_light") {
      actions.push({
        action: "update_light",
        light_id: operation.lightId,
        patch: {
          ...(operation.patch.color !== undefined ? { color: operation.patch.color } : {}),
          ...(operation.patch.intensity !== undefined ? { intensity: operation.patch.intensity } : {}),
          ...(operation.patch.position !== undefined ? { position: operation.patch.position } : {}),
          ...(operation.patch.target !== undefined ? { target: operation.patch.target } : {}),
        },
        force: true,
      });
      continue;
    }
    if (operation.op === "set_character_pose") {
      actions.push({
        action: "set_character_pose_controls",
        object_id: operation.objectId,
        controls: operation.controls.map((entry) => ({ control: entry.control, value: entry.value })),
        mode: "replace",
        force: true,
      });
      continue;
    }
    if (operation.op !== "update_transform") continue;
    if (operation.entityType === "camera") {
      const patch = cameraPatches.get(operation.objectId) ?? {};
      patch.position = operation.transform.position;
      patch.target = cameraTargetForTransform(project, operation.objectId, operation.transform);
      cameraPatches.set(operation.objectId, patch);
      continue;
    }
    const patch = objectPatches.get(operation.objectId) ?? { force: true };
    patch.transform = operation.transform;
    objectPatches.set(operation.objectId, patch);
  }

  // One update_camera action per camera keeps transform + optics atomic.
  for (const [cameraId, patch] of cameraPatches) {
    actions.push({ action: "update_camera", camera_id: cameraId, patch: { ...patch } });
  }

  for (const [objectId, value] of objectPatches) {
    actions.push({
      action: "update_object",
      object_id: objectId,
      patch: {
        ...(value.asset_id ? { asset_id: value.asset_id } : {}),
        ...(value.transform ? { transform: value.transform } : {}),
      },
      force: value.force,
    });
  }
  return actions;
}

/**
 * Creates a DCC return importer that validates round-trip packages,
 * builds import plans with conflict detection, and applies them through
 * the Director authoring surface.
 *
 * Return packages must reside under the provider's DCC jobs root; all file
 * paths are validated against the manifest's SHA-256 hashes and path-escape
 * checks. Blender packages are converted from Blender Z-up space; engine
 * packages arrive in Director's canonical space (the connector converts at
 * the provider boundary).
 *
 * @param options - Workspace root, data directory, and connector provider.
 * @returns An importer with validate, build, and apply methods.
 */
export function createDccReturnImporter(options: CreateDccReturnImporterOptions): DccReturnImporter {
  const provider = directorDccConnectorProviderIdSchema.parse(options.provider ?? "blender");
  const workspaceRoot = resolve(options.workspaceRoot);
  const jobRoot = resolve(options.dataDirectory, "dcc-jobs", provider);
  const exchangeJobRoot = resolve(options.dataDirectory, "dcc-jobs", "exchange", provider);
  const generatedImportRoot = resolve(workspaceRoot, "assets", "generated", "dcc-import");

  async function resolvePackageDirectory(input: string): Promise<{ absolute: string; relative: string }> {
    const trimmed = input.trim();
    const candidate = isAbsolute(trimmed)
      ? resolve(trimmed)
      : trimmed.startsWith("data/")
        ? resolve(workspaceRoot, trimmed)
        : resolve(jobRoot, trimmed);
    if (!isInside(jobRoot, candidate)) {
      throw new DirectorDccImportError("path_escape", `Return package escaped ${jobRoot}.`, 403);
    }
    let canonical: string;
    try {
      canonical = await realpath(candidate);
    } catch {
      throw new DirectorDccImportError("package_invalid", `Return package does not exist: ${trimmed}.`, 404);
    }
    const canonicalJobRoot = await realpath(jobRoot).catch(() => jobRoot);
    if (!isInside(canonicalJobRoot, canonical)) {
      throw new DirectorDccImportError("path_escape", "Return package symlink escaped the DCC job root.", 403);
    }
    if (!(await stat(canonical)).isDirectory()) {
      throw new DirectorDccImportError("package_invalid", "Return package path must be a directory.");
    }
    return { absolute: canonical, relative: posixRelative(canonicalJobRoot, canonical) };
  }

  async function validatePackage(packageDir: string): Promise<ValidatedDirectorDccReturnPackage> {
    const directory = await resolvePackageDirectory(packageDir);
    const manifestPath = resolve(directory.absolute, "manifest.json");
    let canonicalManifestPath: string;
    try {
      canonicalManifestPath = await realpath(manifestPath);
    } catch {
      throw new DirectorDccImportError("package_invalid", "Return package is missing manifest.json.");
    }
    if (!isInside(directory.absolute, canonicalManifestPath)) {
      throw new DirectorDccImportError("path_escape", "manifest.json symlink escaped the package root.", 403);
    }
    let manifestBytes: Uint8Array;
    try {
      manifestBytes = await readFile(canonicalManifestPath);
    } catch {
      throw new DirectorDccImportError("package_invalid", "Return package is missing manifest.json.");
    }
    let unknownManifest: unknown;
    try {
      unknownManifest = JSON.parse(Buffer.from(manifestBytes).toString("utf8")) as unknown;
    } catch {
      throw new DirectorDccImportError("package_invalid", "Return package manifest is not valid JSON.");
    }
    const parsed = directorDccReturnManifestSchema.safeParse(unknownManifest);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new DirectorDccImportError(
        "package_invalid",
        `Invalid return manifest at ${issue?.path.join(".") || "manifest"}: ${issue?.message ?? "invalid value"}.`,
      );
    }
    const manifestProvider = parsed.data.provider ?? "blender";
    if (manifestProvider !== provider) {
      throw new DirectorDccImportError(
        "package_invalid",
        `Return manifest was produced by the ${manifestProvider} connector, but this importer serves ${provider}.`,
      );
    }
    const files = new Map<string, string>();
    for (const [relativePath, expectedHash] of Object.entries(parsed.data.fileHashes)) {
      const candidate = resolve(directory.absolute, relativePath);
      if (!isInside(directory.absolute, candidate)) {
        throw new DirectorDccImportError("path_escape", `Manifest file escaped package root: ${relativePath}.`, 403);
      }
      let canonical: string;
      try {
        canonical = await realpath(candidate);
      } catch {
        throw new DirectorDccImportError("package_invalid", `Manifest file is missing: ${relativePath}.`);
      }
      if (!isInside(directory.absolute, canonical)) {
        throw new DirectorDccImportError("path_escape", `Manifest symlink escaped package root: ${relativePath}.`, 403);
      }
      if (!(await stat(canonical)).isFile()) {
        throw new DirectorDccImportError("package_invalid", `Manifest path is not a file: ${relativePath}.`);
      }
      const actualHash = await sha256File(canonical);
      if (actualHash !== expectedHash) {
        throw new DirectorDccImportError(
          "package_invalid",
          `SHA-256 mismatch for ${relativePath}: expected ${expectedHash}, received ${actualHash}.`,
        );
      }
      files.set(relativePath, canonical);
    }
    return {
      packageDirectory: directory.absolute,
      packageDir: directory.relative,
      manifestPath: canonicalManifestPath,
      manifestHash: sha256(manifestBytes),
      manifest: parsed.data,
      files,
    };
  }

  const MAX_VALIDATED_PACKAGE_CACHE_ENTRIES = 32;
  const validatedPackageCache = new Map<string, ValidatedDirectorDccReturnPackage>();

  function rememberValidatedPackage(validated: ValidatedDirectorDccReturnPackage): void {
    validatedPackageCache.delete(validated.packageDir);
    validatedPackageCache.set(validated.packageDir, validated);
    while (validatedPackageCache.size > MAX_VALIDATED_PACKAGE_CACHE_ENTRIES) {
      const oldest = validatedPackageCache.keys().next().value;
      if (oldest === undefined) break;
      validatedPackageCache.delete(oldest);
    }
  }

  async function validatePackageCached(packageDir: string): Promise<ValidatedDirectorDccReturnPackage> {
    const directory = await resolvePackageDirectory(packageDir);
    const cached = validatedPackageCache.get(directory.relative);
    if (cached) {
      const manifestHash = await sha256File(cached.manifestPath).catch(() => null);
      if (manifestHash === cached.manifestHash) {
        rememberValidatedPackage(cached);
        return cached;
      }
      validatedPackageCache.delete(directory.relative);
    }
    const validated = await validatePackage(directory.relative);
    rememberValidatedPackage(validated);
    return validated;
  }

  /**
   * Build a canonical-space baseline from the exchange package manifest that
   * was sent to the engine. Engine return transforms arrive in canonical
   * Director space, so the baseline snapshot uses the same wire space with the
   * export-time scene transform composed in.
   */
  function baselineFromExchangeManifest(manifest: DirectorDccExchangePackageManifest): DirectorDccSourceBaseline {
    const world = sceneTransform(manifest.project);
    return directorDccSourceBaselineSchema.parse({
      contract: "director-dcc-scene-v1",
      packageId: manifest.packageId,
      sourceRevision: manifest.sourceRevision,
      objects: manifest.project.objects.map((object) => ({
        id: object.id,
        transform: directorTransformToCanonicalDcc(object.transform, world),
        ...(object.assetRefId ? { assetRefId: object.assetRefId } : {}),
        ...(object.geometryType ? { geometryType: object.geometryType } : {}),
        ...(object.color ? { color: object.color } : {}),
        ...(object.parentObjectId ? { parentObjectId: object.parentObjectId } : {}),
      })),
      cameras: manifest.project.cameras.map((camera) => ({
        id: camera.id,
        transform: directorTransformToCanonicalDcc(camera.transform, world),
        target: directorWorldPointToCanonical(camera.target, world),
      })),
    });
  }

  async function loadEngineSourceBaseline(
    manifest: DirectorDccReturnManifestV1,
  ): Promise<DirectorDccSourceBaseline | null> {
    const canonicalExchangeRoot = await realpath(exchangeJobRoot).catch(() => null);
    if (!canonicalExchangeRoot) return null;
    const entries = await readdir(canonicalExchangeRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = resolve(canonicalExchangeRoot, entry.name, "manifest.json");
      let payload: unknown;
      try {
        payload = JSON.parse(await readFile(candidate, "utf8")) as unknown;
      } catch {
        continue;
      }
      const parsed = directorDccExchangePackageManifestSchema.safeParse(payload);
      if (!parsed.success) continue;
      if (parsed.data.packageId !== manifest.sourcePackageId) continue;
      if (parsed.data.sourceRevision !== manifest.sourceRevision) continue;
      return baselineFromExchangeManifest(parsed.data);
    }
    return null;
  }

  async function loadSourceBaseline(manifest: DirectorDccReturnManifestV1): Promise<DirectorDccSourceBaseline | null> {
    if (provider !== "blender") return loadEngineSourceBaseline(manifest);
    const canonicalJobRoot = await realpath(jobRoot).catch(() => null);
    if (!canonicalJobRoot) return null;
    const entries = await readdir(canonicalJobRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = resolve(canonicalJobRoot, entry.name, "scene.director-dcc.json");
      let payload: unknown;
      try {
        payload = JSON.parse(await readFile(candidate, "utf8")) as unknown;
      } catch {
        continue;
      }
      const parsed = directorDccSourceBaselineSchema.safeParse(payload);
      if (!parsed.success) continue;
      if (parsed.data.packageId !== manifest.sourcePackageId) continue;
      if (parsed.data.sourceRevision !== manifest.sourceRevision) continue;
      return parsed.data;
    }
    return null;
  }

  async function buildImportPlan(packageDir: string, project: DirectorProject, options?: DccReturnImportPlanOptions) {
    const validated = await validatePackageCached(packageDir);
    const baseline =
      validated.manifest.sourceRevision === getDirectorProjectRevision(project)
        ? null
        : await loadSourceBaseline(validated.manifest);
    return buildDirectorDccImportPlan(validated, project, {
      baseline,
      skipDirectorIds: options?.skipDirectorIds,
      includeNewObjects: options?.includeNewObjects,
    });
  }

  async function applyImportPlan(
    planInput: DirectorDccImportPlanV1,
    project: DirectorProject,
    expectedRevision: string,
    idempotencyKey: string,
    applyAuthoring: (operation: DirectorWorkbenchOperation) => Promise<DirectorDccAuthoringResponse | null>,
  ) {
    const submitted = directorDccImportPlanSchema.parse(planInput);
    const currentRevision = getDirectorProjectRevision(project);
    if (expectedRevision !== currentRevision || submitted.targetRevision !== currentRevision) {
      throw new DirectorDccImportError(
        "stale_project_revision",
        `Expected ${expectedRevision}, but the live project is ${currentRevision}.`,
        409,
      );
    }
    if (!submitted.ready || submitted.conflicts.length) {
      throw new DirectorDccImportError("conflict_unresolved", "The DCC return plan contains blocking conflicts.", 409);
    }
    const validated = await validatePackageCached(submitted.packageDir);
    if (validated.manifest.packageId !== submitted.packageId || validated.manifestHash !== submitted.manifestHash) {
      throw new DirectorDccImportError(
        "package_invalid",
        "Return package changed after the import plan was built.",
        409,
      );
    }
    // The submitted plan only pins identity (packageId/manifestHash/targetRevision)
    // and the skip/addition intent; the applied operations always come from a
    // server-side rebuild against the validated package and the live project.
    const skipDirectorIds = submitted.operations.flatMap((operation) =>
      operation.op === "skip" ? [operation.directorId] : [],
    );
    const includeNewObjects = submitted.operations.some((operation) => operation.op === "create_prop");
    const baseline =
      validated.manifest.sourceRevision === currentRevision ? null : await loadSourceBaseline(validated.manifest);
    const plan = buildDirectorDccImportPlan(validated, project, { baseline, skipDirectorIds, includeNewObjects });
    if (!plan.ready || plan.conflicts.length) {
      throw new DirectorDccImportError(
        "conflict_unresolved",
        "Rebuilding the plan against the live project produced blocking conflicts; rebuild and review the plan.",
        409,
      );
    }

    const immutableDirectory = sha256(validated.manifest.packageId).slice(0, 20);
    const destinationRoot = resolve(generatedImportRoot, immutableDirectory);
    await mkdir(destinationRoot, { recursive: true });
    const copied = new Map<string, { url: string; fileName: string }>();
    const copiedAssets: Array<{ assetId: string; url: string; hash: string }> = [];
    for (const operation of plan.operations) {
      if (operation.op !== "link_refined_asset" && operation.op !== "create_prop") continue;
      const source = validated.files.get(operation.glbPath);
      if (!source) {
        throw new DirectorDccImportError("package_invalid", `Validated mesh is unavailable: ${operation.glbPath}.`);
      }
      const fileName = `${safeSegment(operation.assetId)}.glb`;
      const destination = resolve(destinationRoot, fileName);
      if (!isInside(generatedImportRoot, destination)) {
        throw new DirectorDccImportError(
          "path_escape",
          "Generated imported asset path escaped generated asset root.",
          500,
        );
      }
      try {
        await access(destination);
        if ((await sha256File(destination)) !== operation.hash) {
          throw new DirectorDccImportError(
            "package_invalid",
            `Immutable DCC asset collision for ${operation.assetId}.`,
            409,
          );
        }
      } catch (error) {
        if (error instanceof DirectorDccImportError) throw error;
        await copyFile(source, destination);
        if ((await sha256File(destination)) !== operation.hash) {
          throw new DirectorDccImportError(
            "package_invalid",
            `Copied DCC asset failed verification: ${fileName}.`,
            500,
          );
        }
      }
      const url = `/dcc-import/${immutableDirectory}/${fileName}`;
      copied.set(operation.assetId, { url, fileName });
      copiedAssets.push({ assetId: operation.assetId, url, hash: operation.hash });
    }

    const actions = authoringActionsForPlan(plan, project, copied);
    if (!actions.length) return { plan, authoring: null, copiedAssets };
    const authoring = await applyAuthoring({
      op: "author",
      expected_revision: expectedRevision,
      idempotency_key: idempotencyKey,
      actions,
    });
    if (!authoring) {
      throw new DirectorDccImportError(
        "browser_target_unavailable",
        "No live Director browser accepted the import.",
        503,
      );
    }
    if (!authoring.success) {
      throw new DirectorDccImportError(
        "authoring_failed",
        authoring.error ?? "Director authoring rejected the import.",
        409,
      );
    }
    return { plan, authoring, copiedAssets };
  }

  return { provider, validatePackage, buildImportPlan, applyImportPlan };
}

/**
 * Creates the Blender-scoped DCC return importer (backwards-compatible entry).
 *
 * @param options - Workspace root and data directory.
 * @returns A return importer bound to the Blender job root.
 */
export function createBlenderReturnImporter(options: CreateDccReturnImporterOptions): DccReturnImporter {
  return createDccReturnImporter({ ...options, provider: "blender" });
}
