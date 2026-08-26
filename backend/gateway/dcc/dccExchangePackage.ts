import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  directorDccExchangePackageManifestSchema,
  directorDccExchangePackageResultSchema,
  type DirectorDccExchangePackageResult,
} from "@director/dcc-protocol";
import {
  directorDccPortableExchangeFormatSchema,
  directorDccProviderDescriptorSchema,
  getDirectorDccProviderDescriptor,
  type DirectorDccPortableExchangeFormat,
  type DirectorDccProviderDescriptor,
  type DirectorDccProviderId,
} from "@director/dcc-protocol";
import type { DirectorProject } from "@director/project-schema";
import { evaluateDirectorCameraAtFrame, evaluateDirectorObjectAtFrame } from "@director/project-schema";
import { getDirectorProjectRevision } from "@director/project-schema";
import { createDirectorInterchangeManifest } from "@director/dcc-interchange";
import { exportDirectorProjectToGlb } from "@director/dcc-interchange";
import { exportDirectorProjectToUsda } from "@director/dcc-interchange";
import { writeJsonAtomic } from "../atomicJsonFile";
import { resolveDccImageAsset, resolveDccModelAsset } from "./blenderBridge";
import { prepareGltfForBlender } from "./gltfPrepare";

/** Resource budgets that constrain a single DCC exchange package. */
export interface DirectorDccExchangePackageBudgets {
  /** Maximum number of model assets included in the package. */
  maxAssets: number;
  /** Maximum byte size of any single file in the package. */
  maxFileBytes: number;
  /** Maximum total byte size of the entire package. */
  maxPackageBytes: number;
  /** Maximum number of concurrent export operations. */
  maxConcurrentExports: number;
}

const DEFAULT_EXCHANGE_PACKAGE_BUDGETS: DirectorDccExchangePackageBudgets = Object.freeze({
  maxAssets: 512,
  maxFileBytes: 512 * 1024 * 1024,
  maxPackageBytes: 2 * 1024 * 1024 * 1024,
  maxConcurrentExports: 2,
});

/** Options for a single DCC exchange package export. */
export interface DirectorDccExchangePackageOptions {
  /** The target DCC provider id. */
  provider: DirectorDccProviderId;
  /** Optional explicit provider descriptor (defaults to the protocol definition). */
  descriptor?: DirectorDccProviderDescriptor;
  /** When false, the export is rejected even if the provider is configured. */
  exchangeReady?: boolean;
  /** Requested portable exchange formats; defaults to the provider's preferred format. */
  formats?: DirectorDccPortableExchangeFormat[];
  /** Optional camera id override for the export. */
  cameraId?: string;
  /** Optional frame override for the export. */
  frame?: number;
}

/**
 * A packager that exports a Director project to a portable DCC exchange
 * package containing GLB and/or USDA scene files plus asset copies.
 */
export interface DirectorDccExchangePackager {
  /**
   * Exports a Director project to a portable exchange package.
   *
   * @param project - The live Director project to export.
   * @param options - Provider, format, camera, and frame configuration.
   * @returns A result record with paths, hashes, and metadata for each exported artifact.
   */
  exportPackage(
    project: DirectorProject,
    options: DirectorDccExchangePackageOptions,
  ): Promise<DirectorDccExchangePackageResult>;
}

/** Configuration for creating a DCC exchange packager. */
export interface CreateDirectorDccExchangePackagerOptions {
  /** Absolute or relative workspace root path. */
  workspaceRoot: string;
  /** Directory under which exchange job data is persisted. */
  dataDirectory: string;
  /** Optional override for the default resource budgets. */
  budgets?: Partial<DirectorDccExchangePackageBudgets>;
  /** Optional glTF-to-GLB converter (defaults to `prepareGltfForBlender`). */
  convertGltfToGlb?: (inputPath: string, outputPath: string) => Promise<void>;
}

/**
 * An error thrown by the DCC exchange packager when a budget, format, or
 * validation constraint is violated.
 */
export class DirectorDccExchangePackageError extends Error {
  constructor(
    message: string,
    /** HTTP status code that best represents this error. */
    readonly status: 409 | 422 | 429,
    /** Machine-readable error code. */
    readonly code: string,
  ) {
    super(message);
    this.name = "DirectorDccExchangePackageError";
  }
}

class DirectorDccExchangeBudgetError extends DirectorDccExchangePackageError {
  constructor(message: string, status: 422 | 429 = 422) {
    super(message, status, status === 429 ? "dcc_exchange_busy" : "dcc_exchange_budget_exceeded");
    this.name = "DirectorDccExchangeBudgetError";
  }
}

function safeStem(value: string) {
  return (
    value
      .normalize("NFKC")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "asset"
  );
}

function positiveSafeInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return value;
}

function normalizeBudgets(input: Partial<DirectorDccExchangePackageBudgets> | undefined) {
  const budgets = { ...DEFAULT_EXCHANGE_PACKAGE_BUDGETS, ...input };
  return {
    maxAssets: positiveSafeInteger(budgets.maxAssets, "DCC exchange maxAssets"),
    maxFileBytes: positiveSafeInteger(budgets.maxFileBytes, "DCC exchange maxFileBytes"),
    maxPackageBytes: positiveSafeInteger(budgets.maxPackageBytes, "DCC exchange maxPackageBytes"),
    maxConcurrentExports: positiveSafeInteger(budgets.maxConcurrentExports, "DCC exchange maxConcurrentExports"),
  } satisfies DirectorDccExchangePackageBudgets;
}

function isInside(parent: string, child: string) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function assertFileBudget(label: string, byteLength: number, budgets: DirectorDccExchangePackageBudgets) {
  if (byteLength > budgets.maxFileBytes) {
    throw new DirectorDccExchangeBudgetError(
      `${label} is ${byteLength} bytes, exceeding the DCC exchange per-file budget of ${budgets.maxFileBytes}.`,
    );
  }
}

function addPackageBytes(
  label: string,
  byteLength: number,
  current: number,
  budgets: DirectorDccExchangePackageBudgets,
) {
  assertFileBudget(label, byteLength, budgets);
  const next = current + byteLength;
  if (!Number.isSafeInteger(next) || next > budgets.maxPackageBytes) {
    throw new DirectorDccExchangeBudgetError(
      `${label} would exceed the DCC exchange package budget of ${budgets.maxPackageBytes} bytes.`,
    );
  }
  return next;
}

function localGltfUris(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("glTF root must be a JSON object.");
  }
  const document = value as Record<string, unknown>;
  const uris: string[] = [];
  for (const collectionName of ["buffers", "images"] as const) {
    const collection = document[collectionName];
    if (collection === undefined) continue;
    if (!Array.isArray(collection)) throw new Error(`glTF ${collectionName} must be an array.`);
    collection.forEach((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`glTF ${collectionName}[${index}] must be an object.`);
      }
      const uri = (entry as Record<string, unknown>).uri;
      if (uri === undefined) return;
      if (typeof uri !== "string" || !uri.trim()) {
        throw new Error(`glTF ${collectionName}[${index}].uri must be a non-empty string.`);
      }
      if (!/^data:/i.test(uri)) uris.push(uri);
    });
  }
  return uris;
}

function decodeSafeGltfDependencyUri(uri: string) {
  if (
    uri.includes("\\") ||
    uri.includes("\0") ||
    uri.includes("?") ||
    uri.includes("#") ||
    /^[a-z][a-z\d+.-]*:/i.test(uri)
  ) {
    throw new Error(`glTF dependency URI is not a safe local relative path: ${uri}`);
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    throw new Error(`glTF dependency URI is not valid percent-encoding: ${uri}`);
  }
  if (
    !decoded ||
    decoded.startsWith("/") ||
    decoded.includes("\\") ||
    decoded.includes("\0") ||
    /^[a-z]:/i.test(decoded) ||
    decoded.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`glTF dependency URI is not a safe local relative path: ${uri}`);
  }
  return decoded;
}

async function validateGltfDependencies(sourcePath: string, budgets: DirectorDccExchangePackageBudgets) {
  const sourceStat = await stat(sourcePath);
  assertFileBudget(`glTF source ${sourcePath}`, sourceStat.size, budgets);
  const document = JSON.parse(await readFile(sourcePath, "utf8")) as unknown;
  const baseDirectory = await realpath(dirname(sourcePath));
  let inputBytes = sourceStat.size;
  for (const uri of localGltfUris(document)) {
    const decoded = decodeSafeGltfDependencyUri(uri);
    const dependency = await realpath(resolve(baseDirectory, decoded));
    if (!isInside(baseDirectory, dependency)) {
      throw new Error(`glTF dependency escaped its asset directory: ${uri}`);
    }
    const dependencyStat = await stat(dependency);
    if (!dependencyStat.isFile()) throw new Error(`glTF dependency is not a file: ${uri}`);
    assertFileBudget(`glTF dependency ${uri}`, dependencyStat.size, budgets);
    inputBytes += dependencyStat.size;
    if (!Number.isSafeInteger(inputBytes) || inputBytes > budgets.maxPackageBytes) {
      throw new DirectorDccExchangeBudgetError(
        `glTF source dependencies exceed the DCC exchange read budget of ${budgets.maxPackageBytes} bytes.`,
      );
    }
  }
}

async function sha256File(path: string) {
  return new Promise<string>((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectHash);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

function packageDigest(
  manifestSha256: string,
  formats: ReadonlyArray<{ format: string; relativePath: string; sha256: string; byteLength: number }>,
  assets: ReadonlyArray<{ assetRefId: string; relativePath: string; sha256: string; byteLength: number }>,
) {
  const canonical = {
    manifestSha256,
    formats: [...formats]
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
      .map(({ format, relativePath, sha256, byteLength }) => ({ format, relativePath, sha256, byteLength })),
    assets: [...assets]
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
      .map(({ assetRefId, relativePath, sha256, byteLength }) => ({
        assetRefId,
        relativePath,
        sha256,
        byteLength,
      })),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

async function writeArtifact(path: string, contents: string | Uint8Array) {
  await writeFile(path, contents);
  const fileStat = await stat(path);
  return { sha256: await sha256File(path), byteLength: fileStat.size };
}

function selectedProject(project: DirectorProject, cameraId?: string, frame?: number) {
  const selected = structuredClone(project);
  if (cameraId) {
    if (!selected.cameras.some((camera) => camera.id === cameraId)) {
      throw new DirectorDccExchangePackageError(
        `DCC exchange camera "${cameraId}" does not exist.`,
        422,
        "dcc_exchange_camera_invalid",
      );
    }
    selected.activeCameraId = cameraId;
  }
  if (frame !== undefined) {
    const timeline = selected.scene.timeline;
    if (!timeline) {
      throw new DirectorDccExchangePackageError(
        "DCC exchange frame selection requires a project timeline.",
        422,
        "dcc_exchange_frame_invalid",
      );
    }
    // NaN slips through plain range comparisons (NaN < x and NaN > x are both
    // false), so non-finite frames must be rejected explicitly.
    if (!Number.isFinite(frame) || frame < timeline.frameStart || frame > timeline.frameEnd) {
      throw new DirectorDccExchangePackageError(
        `DCC exchange frame ${frame} is outside ${timeline.frameStart}-${timeline.frameEnd}.`,
        422,
        "dcc_exchange_frame_invalid",
      );
    }
    timeline.currentFrame = frame;
  }
  const playbackFrame = selected.scene.timeline?.currentFrame;
  if (playbackFrame !== undefined) {
    const timeline = selected.scene.timeline!;
    if (playbackFrame < timeline.frameStart || playbackFrame > timeline.frameEnd) {
      throw new DirectorDccExchangePackageError(
        `DCC exchange frame ${playbackFrame} is outside ${timeline.frameStart}-${timeline.frameEnd}.`,
        422,
        "dcc_exchange_frame_invalid",
      );
    }
    selected.objects = selected.objects.map((object) =>
      evaluateDirectorObjectAtFrame(object, playbackFrame, timeline.fps),
    );
    const actionTargets = selected.objects.map((object) => ({
      id: object.id,
      position: object.transform.position,
    }));
    selected.cameras = selected.cameras.map((camera) =>
      evaluateDirectorCameraAtFrame(camera, playbackFrame, actionTargets),
    );
  }
  return selected;
}

/**
 * Unique texture image assets referenced by object PBR material texture
 * slots. Only the Unreal package bundles these today: its connector imports
 * them and binds material-instance texture parameters; other providers keep
 * their existing package layout unchanged.
 */
function referencedTextureAssets(project: DirectorProject) {
  const textureAssetIds = new Set<string>();
  for (const object of project.objects) {
    for (const assetId of Object.values(object.material?.textures ?? {})) {
      if (assetId) textureAssetIds.add(assetId);
    }
  }
  return project.assets.filter((asset) => asset.sourceType === "image" && textureAssetIds.has(asset.id));
}

function requestedFormats(descriptor: DirectorDccProviderDescriptor, input?: DirectorDccPortableExchangeFormat[]) {
  const supported = [
    ...new Set(
      descriptor.exchangeFormats.filter(
        (format): format is DirectorDccPortableExchangeFormat => format === "glb" || format === "usda",
      ),
    ),
  ];
  if (input?.length) {
    const requested = [
      ...new Set(
        input.map((format) => {
          const parsed = directorDccPortableExchangeFormatSchema.safeParse(format);
          if (!parsed.success) {
            throw new DirectorDccExchangePackageError(
              `DCC exchange format ${JSON.stringify(String(format).slice(0, 60))} is not a portable exchange format (glb, usda).`,
              422,
              "dcc_exchange_format_unsupported",
            );
          }
          return parsed.data;
        }),
      ),
    ];
    const unsupported = requested.filter((format) => !supported.includes(format));
    if (unsupported.length) {
      throw new DirectorDccExchangePackageError(
        `DCC provider ${descriptor.id} does not advertise portable format${unsupported.length === 1 ? "" : "s"} ${unsupported.join(", ")}.`,
        422,
        "dcc_exchange_format_unsupported",
      );
    }
    return requested;
  }
  if (!supported.length) {
    throw new DirectorDccExchangePackageError(
      `DCC provider ${descriptor.id} does not advertise a portable GLB or USDA exchange format.`,
      422,
      "dcc_exchange_format_unsupported",
    );
  }
  if (descriptor.preferredFormat === "glb" || descriptor.preferredFormat === "usda") {
    return [descriptor.preferredFormat, ...supported.filter((format) => format !== descriptor.preferredFormat)];
  }
  return supported;
}

/**
 * Creates a DCC exchange packager that exports Director projects to portable
 * GLB and USDA exchange packages with embedded asset copies.
 *
 * The packager enforces per-file and per-package byte budgets, validates
 * glTF dependencies, converts referenced glTF files to self-contained GLB,
 * and produces a signed manifest with SHA-256 hashes for every artifact.
 *
 * @param options - Workspace root, data directory, and optional budget overrides.
 * @returns A packager with a single `exportPackage` method.
 */
export function createDirectorDccExchangePackager(
  options: CreateDirectorDccExchangePackagerOptions,
): DirectorDccExchangePackager {
  const workspaceRoot = resolve(options.workspaceRoot);
  const exchangeRoot = resolve(options.dataDirectory, "dcc-jobs", "exchange");
  const budgets = normalizeBudgets(options.budgets);
  const convertGltfToGlb = options.convertGltfToGlb ?? prepareGltfForBlender;
  let activeExports = 0;

  return {
    async exportPackage(project, exportOptions) {
      if (activeExports >= budgets.maxConcurrentExports) {
        throw new DirectorDccExchangeBudgetError(
          `DCC exchange concurrent export limit of ${budgets.maxConcurrentExports} has been reached.`,
          429,
        );
      }
      activeExports += 1;
      try {
        const provider = exportOptions.provider;
        let descriptor: DirectorDccProviderDescriptor;
        try {
          descriptor = directorDccProviderDescriptorSchema.parse(
            exportOptions.descriptor ?? getDirectorDccProviderDescriptor(provider),
          );
        } catch (error) {
          throw new DirectorDccExchangePackageError(
            `DCC exchange provider ${JSON.stringify(String(provider).slice(0, 120))} has no valid provider descriptor: ${error instanceof Error ? error.message.slice(0, 400) : String(error).slice(0, 400)}`,
            422,
            "dcc_exchange_provider_invalid",
          );
        }
        if (descriptor.id !== provider) {
          throw new DirectorDccExchangePackageError(
            "DCC exchange descriptor does not match the requested provider.",
            422,
            "dcc_exchange_provider_invalid",
          );
        }
        if (exportOptions.exchangeReady === false) {
          throw new DirectorDccExchangePackageError(
            `DCC provider ${provider} reports that portable exchange is not ready.`,
            409,
            "dcc_exchange_unavailable",
          );
        }
        const formats = requestedFormats(descriptor, exportOptions.formats);
        const sourceProject = createDirectorInterchangeManifest(project).project;
        const sourceRevision = getDirectorProjectRevision(sourceProject);
        const portableProject = selectedProject(sourceProject, exportOptions.cameraId, exportOptions.frame);
        const referencedAssetIds = new Set(
          portableProject.objects
            .map((object) => object.assetRefId)
            .filter((assetRefId): assetRefId is string => Boolean(assetRefId)),
        );
        const modelAssets = portableProject.assets.filter(
          (asset) => asset.sourceType === "model" && referencedAssetIds.has(asset.id),
        );
        // Unreal-only: material texture slots resolve to bundled hashed files
        // so the connector can bind material-instance texture parameters.
        const textureAssets = provider === "unreal" ? referencedTextureAssets(portableProject) : [];
        if (modelAssets.length + textureAssets.length > budgets.maxAssets) {
          throw new DirectorDccExchangeBudgetError(
            `DCC exchange contains ${modelAssets.length + textureAssets.length} model and texture assets, exceeding the limit of ${budgets.maxAssets}.`,
          );
        }
        const jobId = randomUUID();
        const providerRoot = resolve(exchangeRoot, safeStem(provider));
        const stagingDirectory = resolve(providerRoot, `.tmp-${jobId}`);
        const packageDirectory = resolve(providerRoot, jobId);
        const warnings: string[] = [];

        await mkdir(stagingDirectory, { recursive: true });
        try {
          let packageBytes = 0;
          const formatRecords: Array<{
            format: DirectorDccPortableExchangeFormat;
            relativePath: string;
            sha256: string;
            byteLength: number;
          }> = [];
          for (const format of formats) {
            const relativePath = format === "glb" ? "scene-layout.glb" : "scene.usda";
            const outputPath = resolve(stagingDirectory, relativePath);
            const record = await writeArtifact(
              outputPath,
              format === "glb"
                ? await exportDirectorProjectToGlb(portableProject)
                : exportDirectorProjectToUsda(portableProject),
            );
            packageBytes = addPackageBytes(relativePath, record.byteLength, packageBytes, budgets);
            formatRecords.push({ format, relativePath, ...record });
          }

          const assetDirectory = resolve(stagingDirectory, "assets");
          await mkdir(assetDirectory, { recursive: true });
          const assetRecords: Array<{
            assetRefId: string;
            relativePath: string;
            sha256: string;
            byteLength: number;
          }> = [];
          let copiedIndex = 0;
          for (const asset of modelAssets) {
            const resolved = await resolveDccModelAsset(workspaceRoot, asset.url);
            if (resolved.status !== "resolved" || !resolved.sourcePath) {
              warnings.push(`${asset.fileName}: ${resolved.message ?? `asset is ${resolved.status}`}`);
              continue;
            }
            copiedIndex += 1;
            const extension = extname(resolved.sourcePath).toLowerCase();
            const outputExtension = extension === ".gltf" ? ".glb" : extension;
            const relativePath = `assets/${String(copiedIndex).padStart(3, "0")}-${safeStem(asset.id)}${outputExtension}`;
            const destination = resolve(stagingDirectory, relativePath);
            if (extension === ".gltf") {
              try {
                await validateGltfDependencies(resolved.sourcePath, budgets);
                await convertGltfToGlb(resolved.sourcePath, destination);
              } catch (error) {
                await rm(destination, { force: true });
                if (error instanceof DirectorDccExchangeBudgetError) throw error;
                warnings.push(
                  `${asset.fileName}: glTF could not be safely converted to a self-contained GLB and was skipped. ${error instanceof Error ? error.message : String(error)}`,
                );
                continue;
              }
            } else {
              const sourceStat = await stat(resolved.sourcePath);
              assertFileBudget(asset.fileName, sourceStat.size, budgets);
              await copyFile(resolved.sourcePath, destination);
            }
            const fileStat = await stat(destination);
            packageBytes = addPackageBytes(relativePath, fileStat.size, packageBytes, budgets);
            assetRecords.push({
              assetRefId: asset.id,
              relativePath,
              sha256: await sha256File(destination),
              byteLength: fileStat.size,
            });
          }
          for (const asset of textureAssets) {
            const resolved = await resolveDccImageAsset(workspaceRoot, asset.url);
            if (resolved.status !== "resolved" || !resolved.sourcePath) {
              warnings.push(
                `${asset.fileName}: texture ${resolved.message ?? `asset is ${resolved.status}`} Material texture slots referencing it will warn-and-omit in the host connector.`,
              );
              continue;
            }
            copiedIndex += 1;
            const extension = extname(resolved.sourcePath).toLowerCase();
            const relativePath = `assets/${String(copiedIndex).padStart(3, "0")}-${safeStem(asset.id)}${extension}`;
            const destination = resolve(stagingDirectory, relativePath);
            const sourceStat = await stat(resolved.sourcePath);
            assertFileBudget(asset.fileName, sourceStat.size, budgets);
            await copyFile(resolved.sourcePath, destination);
            const fileStat = await stat(destination);
            packageBytes = addPackageBytes(relativePath, fileStat.size, packageBytes, budgets);
            assetRecords.push({
              assetRefId: asset.id,
              relativePath,
              sha256: await sha256File(destination),
              byteLength: fileStat.size,
            });
          }
          if (formats.includes("glb")) {
            warnings.push(
              "scene-layout.glb carries stable IDs, hierarchy and cameras; model payloads remain separate under assets/ for the host connector to assemble.",
            );
          }

          const manifest = directorDccExchangePackageManifestSchema.parse({
            contract: "director-dcc-exchange-package-v1",
            packageId: jobId,
            provider,
            sourceRevision,
            createdAt: new Date().toISOString(),
            coordinateSystem: {
              linearUnit: "meter",
              metersPerUnit: 1,
              upAxis: "Y",
              handedness: "right",
              cameraForward: "-Z",
            },
            project: portableProject,
            formats: formatRecords,
            assets: assetRecords,
            warnings,
          });
          const manifestPath = resolve(stagingDirectory, "manifest.json");
          await writeJsonAtomic(manifestPath, manifest);
          const manifestStat = await stat(manifestPath);
          packageBytes = addPackageBytes("manifest.json", manifestStat.size, packageBytes, budgets);
          const manifestSha256 = await sha256File(manifestPath);
          const digest = packageDigest(manifestSha256, formatRecords, assetRecords);

          const result = directorDccExchangePackageResultSchema.parse({
            contract: "director-dcc-exchange-result-v1",
            jobId,
            provider,
            packagePath: packageDirectory,
            manifestPath: resolve(packageDirectory, "manifest.json"),
            manifestSha256,
            packageDigest: digest,
            sourceRevision,
            formats: formatRecords.map((artifact) => ({
              format: artifact.format,
              fileName: artifact.relativePath,
              path: resolve(packageDirectory, artifact.relativePath),
              mimeType: artifact.format === "glb" ? "model/gltf-binary" : "model/vnd.usda",
              sha256: artifact.sha256,
              byteLength: artifact.byteLength,
            })),
            assets: assetRecords.map((asset) => ({
              assetRefId: asset.assetRefId,
              fileName: asset.relativePath.split("/").at(-1) ?? asset.relativePath,
              path: resolve(packageDirectory, asset.relativePath),
              relativePath: asset.relativePath,
              sha256: asset.sha256,
              byteLength: asset.byteLength,
            })),
            warnings: [
              ...warnings,
              `${descriptor.label} integration level is ${descriptor.integration}; capability levels in discover are authoritative.`,
            ],
          });
          await mkdir(providerRoot, { recursive: true });
          await rename(stagingDirectory, packageDirectory);
          return result;
        } catch (error) {
          await rm(stagingDirectory, { recursive: true, force: true });
          throw error;
        }
      } finally {
        activeExports -= 1;
      }
    },
  };
}
