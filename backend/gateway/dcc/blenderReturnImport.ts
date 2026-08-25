import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Euler, Quaternion, Vector3 } from "three";
import { z } from "zod";
import type { DirectorAuthoringAction } from "@director/agent-engine";
import type { DirectorWorkbenchOperation } from "@director/agent-engine";
import type { DirectorProject, DirectorTransform } from "@director/project-schema";
import { getDirectorProjectRevision } from "@director/project-schema";
import {
  blenderTransformToDirector,
  directorDccTransformSchema,
  directorTransformToBlender,
  directorWorldPointToBlender,
  type DirectorDccTransform,
} from "@director/dcc-protocol";
import {
  DIRECTOR_DCC_IMPORT_PLAN_CONTRACT,
  directorDccImportPlanSchema,
  directorDccReturnManifestSchema,
  type DirectorDccImportPlanV1,
  type DirectorDccReturnManifestV1,
} from "@director/dcc-protocol";

/**
 * Machine-readable error codes for Blender return (round-trip) import failures.
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
  package_invalid: "Regenerate the return package with director_return_export.py and keep manifest/hash files intact.",
  path_escape: "Use a package under data/dcc-jobs/blender only.",
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

/** Options for building a Blender return import plan. */
export interface BlenderReturnImportPlanOptions {
  /** Director IDs whose changes are skipped instead of applied or conflicted. */
  skipDirectorIds?: readonly string[];
}

/**
 * A Blender return importer validates a return package, builds an import plan
 * against the live project, and applies the plan through the Director authoring
 * surface.
 */
export interface BlenderReturnImporter {
  /** Validate a return package directory and hash-check every file. */
  validatePackage(packageDir: string): Promise<ValidatedDirectorDccReturnPackage>;
  /** Build an import plan from a validated package and live project. */
  buildImportPlan(
    packageDir: string,
    project: DirectorProject,
    options?: BlenderReturnImportPlanOptions,
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

/** Configuration for creating a Blender return importer. */
export interface CreateBlenderReturnImporterOptions {
  /** Absolute or relative workspace root path. */
  workspaceRoot: string;
  /** Directory under which DCC job data is persisted. */
  dataDirectory: string;
}

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
    }),
  ),
  cameras: z.array(
    z.looseObject({
      id: z.string(),
      transform: directorDccTransformSchema,
      target: finiteVec3Schema,
    }),
  ),
});

/** The parsed export-time baseline snapshot from a DCC scene package. */
export type DirectorDccSourceBaseline = z.infer<typeof directorDccSourceBaselineSchema>;

/** Options for building a DCC import plan with object-level conflict detection. */
export interface DirectorDccImportPlanBuildOptions {
  /** Export-time per-object snapshot; enables object-level conflict detection on stale revisions. */
  baseline?: DirectorDccSourceBaseline | null;
  /** Changes for these director_ids are skipped instead of applied or conflicting. */
  skipDirectorIds?: readonly string[];
}

const BASELINE_TOLERANCE = 1e-6;

function vectorsClose(left: readonly number[], right: readonly number[]): boolean {
  return (
    left.length === right.length && left.every((value, index) => Math.abs(value - right[index]!) <= BASELINE_TOLERANCE)
  );
}

function blenderTransformsEqual(left: DirectorDccTransform, right: DirectorDccTransform): boolean {
  if (!vectorsClose(left.location, right.location) || !vectorsClose(left.scale, right.scale)) return false;
  // q and -q encode the same rotation; both sides are normalized on export.
  const dot = left.rotationQuaternion.reduce((sum, value, index) => sum + value * right.rotationQuaternion[index]!, 0);
  return Math.abs(Math.abs(dot) - 1) <= BASELINE_TOLERANCE;
}

function directorSideDivergence(
  change: DirectorDccReturnManifestV1["changes"][number],
  entity: DirectorProject["objects"][number] | DirectorProject["cameras"][number],
  world: DirectorTransform,
  baseline: DirectorDccSourceBaseline,
): string | null {
  if (change.entityType === "camera") {
    const camera = entity as DirectorProject["cameras"][number];
    const snapshot = baseline.cameras.find((candidate) => candidate.id === change.directorId);
    if (!snapshot) {
      return `Camera ${change.directorId} is not part of the export snapshot, so its Director-side edits cannot be verified.`;
    }
    if (!blenderTransformsEqual(directorTransformToBlender(camera.transform, world), snapshot.transform)) {
      return `Camera ${change.directorId} moved in Director after the export, and the return package also updates it.`;
    }
    if (!vectorsClose(directorWorldPointToBlender(camera.target, world), snapshot.target)) {
      return `Camera ${change.directorId} target changed in Director after the export, and the return package also updates it.`;
    }
    return null;
  }
  const object = entity as DirectorProject["objects"][number];
  const snapshot = baseline.objects.find((candidate) => candidate.id === change.directorId);
  if (!snapshot) {
    return `Object ${change.directorId} is not part of the export snapshot, so its Director-side edits cannot be verified.`;
  }
  const transformChanged =
    !blenderTransformsEqual(directorTransformToBlender(object.transform, world), snapshot.transform) ||
    (object.parentObjectId ?? null) !== (snapshot.parentObjectId ?? null);
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
  const targetRevision = getDirectorProjectRevision(project);
  const operations: DirectorDccImportPlanV1["operations"] = [];
  const conflicts: DirectorDccImportPlanV1["conflicts"] = [];
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

  for (const change of manifest.changes) {
    if (requestedSkips.has(change.directorId)) {
      matchedSkips.add(change.directorId);
      operations.push({
        op: "skip",
        directorId: change.directorId,
        reason: `Skipped on request (skip_director_ids); the Blender change for ${change.directorId} is not applied.`,
      });
      continue;
    }
    const object = project.objects.find((candidate) => candidate.id === change.directorId);
    const camera = project.cameras.find((candidate) => candidate.id === change.directorId);
    const expected = change.entityType === "camera" ? camera : object;
    const opposite = change.entityType === "camera" ? object : camera;
    if (!expected) {
      const reason = opposite
        ? `Stable ID ${change.directorId} resolves to ${change.entityType === "camera" ? "an object" : "a camera"}, not ${change.entityType}.`
        : `Stable ID ${change.directorId} no longer exists in the live project.`;
      operations.push({ op: "skip", directorId: change.directorId, reason });
      conflicts.push({
        directorId: change.directorId,
        code: opposite ? "entity_type_mismatch" : "unknown_director_id",
        reason,
      });
      continue;
    }

    if (baseline) {
      const divergence = directorSideDivergence(change, expected, world, baseline);
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
          transform: blenderTransformToDirector(change.transform, world),
        });
      }
      continue;
    }

    operations.push({
      op: "update_transform",
      entityType: change.entityType,
      objectId: change.directorId,
      transform: blenderTransformToDirector(change.transform, world),
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

function authoringActionsForPlan(
  plan: DirectorDccImportPlanV1,
  project: DirectorProject,
  copied: Map<string, { url: string; fileName: string }>,
): DirectorAuthoringAction[] {
  const objectPatches = new Map<
    string,
    { asset_id?: string; transform?: Partial<DirectorTransform>; force: boolean }
  >();
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
    if (operation.op !== "update_transform") continue;
    if (operation.entityType === "camera") {
      actions.push({
        action: "update_camera",
        camera_id: operation.objectId,
        patch: {
          position: operation.transform.position,
          target: cameraTargetForTransform(project, operation.objectId, operation.transform),
        },
      });
      continue;
    }
    const patch = objectPatches.get(operation.objectId) ?? { force: true };
    patch.transform = operation.transform;
    objectPatches.set(operation.objectId, patch);
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
 * Creates a Blender return importer that validates round-trip packages,
 * builds import plans with conflict detection, and applies them through
 * the Director authoring surface.
 *
 * Return packages must reside under the DCC jobs root; all file paths are
 * validated against the manifest's SHA-256 hashes and path-escape checks.
 *
 * @param options - Workspace root and data directory.
 * @returns An importer with validate, build, and apply methods.
 */
export function createBlenderReturnImporter(options: CreateBlenderReturnImporterOptions): BlenderReturnImporter {
  const workspaceRoot = resolve(options.workspaceRoot);
  const jobRoot = resolve(options.dataDirectory, "dcc-jobs", "blender");
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

  const validatedPackageCache = new Map<string, ValidatedDirectorDccReturnPackage>();

  async function validatePackageCached(packageDir: string): Promise<ValidatedDirectorDccReturnPackage> {
    const directory = await resolvePackageDirectory(packageDir);
    const cached = validatedPackageCache.get(directory.relative);
    if (cached) {
      const manifestHash = await sha256File(cached.manifestPath).catch(() => null);
      if (manifestHash === cached.manifestHash) return cached;
      validatedPackageCache.delete(directory.relative);
    }
    const validated = await validatePackage(directory.relative);
    validatedPackageCache.set(validated.packageDir, validated);
    return validated;
  }

  async function loadSourceBaseline(manifest: DirectorDccReturnManifestV1): Promise<DirectorDccSourceBaseline | null> {
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

  async function buildImportPlan(
    packageDir: string,
    project: DirectorProject,
    options?: BlenderReturnImportPlanOptions,
  ) {
    const validated = await validatePackageCached(packageDir);
    const baseline =
      validated.manifest.sourceRevision === getDirectorProjectRevision(project)
        ? null
        : await loadSourceBaseline(validated.manifest);
    return buildDirectorDccImportPlan(validated, project, {
      baseline,
      skipDirectorIds: options?.skipDirectorIds,
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
      throw new DirectorDccImportError(
        "conflict_unresolved",
        "The Blender return plan contains blocking conflicts.",
        409,
      );
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
    // and the skip intent; the applied operations always come from a server-side
    // rebuild against the validated package and the live project.
    const skipDirectorIds = submitted.operations.flatMap((operation) =>
      operation.op === "skip" ? [operation.directorId] : [],
    );
    const baseline =
      validated.manifest.sourceRevision === currentRevision ? null : await loadSourceBaseline(validated.manifest);
    const plan = buildDirectorDccImportPlan(validated, project, { baseline, skipDirectorIds });
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
      if (operation.op !== "link_refined_asset") continue;
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

  return { validatePackage, buildImportPlan, applyImportPlan };
}
