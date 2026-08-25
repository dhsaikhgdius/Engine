import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, lstatSync, readFileSync } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ASSET_MANIFEST_VERSION = 1;
export const DEFAULT_ASSET_MANIFEST = "assets/manifest.lock.json";

const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const REVISION = /^[0-9a-f]{40}$/;
const REPOSITORY_ID = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const TOKEN_ENV = /^[A-Z][A-Z0-9_]*$/;
const LOCAL_ASSET_ROOTS = ["assets/library/"];

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function assertAllowedKeys(value, allowedKeys, label) {
  const unknown = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (unknown.length > 0) throw new Error(`${label} contains unknown properties: ${unknown.join(", ")}`);
}

function assertString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function assertIdentifier(value, label) {
  const identifier = assertString(value, label);
  if (!IDENTIFIER.test(identifier)) throw new Error(`${label} is not a safe identifier: ${identifier}`);
  return identifier;
}

export function assertSafeRelativePath(value, label = "path") {
  const candidate = assertString(value, label);
  if (
    isAbsolute(candidate) ||
    candidate.includes("\\") ||
    candidate.split("/").some((part) => part === ".." || part === "")
  ) {
    throw new Error(`${label} must be a normalized repository-relative path: ${candidate}`);
  }
  return candidate;
}

function assertUniqueIds(items, label) {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.id)) throw new Error(`${label} contains duplicate id: ${item.id}`);
    seen.add(item.id);
  }
}

/**
 * Parse and semantically validate an asset manifest. JSON Schema is the external
 * structural contract. This strict parser mirrors its closed-object boundary and
 * adds cross-reference/license/path checks before touching filesystem or network.
 */
export function parseAssetManifest(value) {
  const source = assertObject(value, "asset manifest");
  assertAllowedKeys(
    source,
    ["$schema", "manifestVersion", "release", "description", "repositories", "licenses", "files"],
    "asset manifest",
  );
  if (source.$schema !== undefined) assertString(source.$schema, "$schema");
  if (source.description !== undefined) assertString(source.description, "description");
  if (source.manifestVersion !== ASSET_MANIFEST_VERSION) {
    throw new Error(
      `Unsupported asset manifest version ${String(source.manifestVersion)}; expected ${ASSET_MANIFEST_VERSION}`,
    );
  }
  assertString(source.release, "release");
  if (!Array.isArray(source.repositories) || source.repositories.length === 0) {
    throw new Error("repositories must be a non-empty array");
  }
  if (!Array.isArray(source.licenses) || source.licenses.length === 0) {
    throw new Error("licenses must be a non-empty array");
  }
  if (!Array.isArray(source.files)) throw new Error("files must be an array");

  const repositories = source.repositories.map((entry, index) => {
    const repository = assertObject(entry, `repositories[${index}]`);
    assertAllowedKeys(
      repository,
      ["id", "provider", "repoType", "repoId", "revision", "access", "tokenEnv"],
      `repositories[${index}]`,
    );
    const id = assertIdentifier(repository.id, `repositories[${index}].id`);
    if (repository.provider !== "huggingface") {
      throw new Error(`repositories[${index}].provider must be huggingface`);
    }
    if (!new Set(["dataset", "model"]).has(repository.repoType)) {
      throw new Error(`repositories[${index}].repoType must be dataset or model`);
    }
    const repoId = assertString(repository.repoId, `repositories[${index}].repoId`);
    if (!REPOSITORY_ID.test(repoId)) throw new Error(`Invalid Hugging Face repoId: ${repoId}`);
    const revision = assertString(repository.revision, `repositories[${index}].revision`);
    if (!REVISION.test(revision)) {
      throw new Error(`Repository ${id} must pin an immutable 40-character commit SHA`);
    }
    if (!new Set(["public", "gated", "private"]).has(repository.access)) {
      throw new Error(`Repository ${id} has invalid access policy`);
    }
    if (repository.tokenEnv !== undefined && !TOKEN_ENV.test(repository.tokenEnv)) {
      throw new Error(`Repository ${id} has invalid tokenEnv`);
    }
    if (repository.access !== "public" && !repository.tokenEnv) {
      throw new Error(`Repository ${id} must declare tokenEnv for ${repository.access} access`);
    }
    return { ...repository, id, repoId, revision };
  });

  const licenses = source.licenses.map((entry, index) => {
    const license = assertObject(entry, `licenses[${index}]`);
    assertAllowedKeys(
      license,
      ["id", "name", "spdx", "url", "noticePath", "redistribution", "notes"],
      `licenses[${index}]`,
    );
    const id = assertIdentifier(license.id, `licenses[${index}].id`);
    assertString(license.name, `licenses[${index}].name`);
    if (!new Set(["public", "gated", "local-only"]).has(license.redistribution)) {
      throw new Error(`License ${id} has invalid redistribution policy`);
    }
    if (license.noticePath !== undefined) {
      assertSafeRelativePath(license.noticePath, `licenses[${index}].noticePath`);
    }
    if (license.spdx !== undefined) assertString(license.spdx, `licenses[${index}].spdx`);
    if (license.notes !== undefined) assertString(license.notes, `licenses[${index}].notes`);
    if (license.url !== undefined) {
      try {
        new URL(assertString(license.url, `licenses[${index}].url`));
      } catch {
        throw new Error(`licenses[${index}].url must be an absolute URL`);
      }
    }
    return { ...license, id };
  });

  assertUniqueIds(repositories, "repositories");
  assertUniqueIds(licenses, "licenses");
  const repositoryIds = new Set(repositories.map((repository) => repository.id));
  const licenseIds = new Set(licenses.map((license) => license.id));
  const licenseById = new Map(licenses.map((license) => [license.id, license]));

  const files = source.files.map((entry, index) => {
    const file = assertObject(entry, `files[${index}]`);
    assertAllowedKeys(
      file,
      ["id", "bundle", "source", "localPath", "sha256", "size", "mediaType", "licenseRef", "required", "description"],
      `files[${index}]`,
    );
    const id = assertIdentifier(file.id, `files[${index}].id`);
    const bundle = assertIdentifier(file.bundle, `files[${index}].bundle`);
    const licenseRef = assertIdentifier(file.licenseRef, `files[${index}].licenseRef`);
    if (!licenseIds.has(licenseRef)) throw new Error(`File ${id} references unknown license ${licenseRef}`);
    const sourceInfo = assertObject(file.source, `files[${index}].source`);
    let normalizedSource;
    if (sourceInfo.kind === "huggingface") {
      assertAllowedKeys(sourceInfo, ["kind", "repositoryId", "remotePath"], `files[${index}].source`);
      const repositoryId = assertIdentifier(sourceInfo.repositoryId, `files[${index}].source.repositoryId`);
      if (!repositoryIds.has(repositoryId)) {
        throw new Error(`File ${id} references unknown repository ${repositoryId}`);
      }
      normalizedSource = {
        ...sourceInfo,
        kind: "huggingface",
        repositoryId,
        remotePath: assertSafeRelativePath(sourceInfo.remotePath, `files[${index}].source.remotePath`),
      };
    } else if (sourceInfo.kind === "user-provided") {
      assertAllowedKeys(sourceInfo, ["kind", "instructions", "instructionsUrl"], `files[${index}].source`);
      normalizedSource = {
        ...sourceInfo,
        kind: "user-provided",
        instructions: assertString(sourceInfo.instructions, `files[${index}].source.instructions`),
      };
      if (sourceInfo.instructionsUrl !== undefined) {
        try {
          new URL(assertString(sourceInfo.instructionsUrl, `files[${index}].source.instructionsUrl`));
        } catch {
          throw new Error(`files[${index}].source.instructionsUrl must be an absolute URL`);
        }
      }
    } else {
      throw new Error(`File ${id} has unsupported source kind`);
    }
    const localPath = assertSafeRelativePath(file.localPath, `files[${index}].localPath`);
    if (!LOCAL_ASSET_ROOTS.some((root) => localPath.startsWith(root))) {
      throw new Error(`File ${id} targets unsupported local asset root: ${localPath}`);
    }
    if (!SHA256.test(file.sha256)) throw new Error(`File ${id} has invalid sha256`);
    if (!Number.isSafeInteger(file.size) || file.size < 0) throw new Error(`File ${id} has invalid size`);
    assertString(file.mediaType, `files[${index}].mediaType`);
    if (typeof file.required !== "boolean") throw new Error(`File ${id}.required must be boolean`);
    if (file.description !== undefined) assertString(file.description, `files[${index}].description`);

    const license = licenseById.get(licenseRef);
    if (normalizedSource.kind === "huggingface") {
      const repository = repositories.find((candidate) => candidate.id === normalizedSource.repositoryId);
      if (license.redistribution === "local-only") {
        throw new Error(`Local-only file ${id} cannot use a Hugging Face source`);
      }
      if (license.redistribution === "public" && repository.access !== "public") {
        throw new Error(`Publicly redistributable file ${id} must use a public repository`);
      }
      if (license.redistribution === "gated" && repository.access === "public") {
        throw new Error(`Gated file ${id} cannot use a public repository`);
      }
    } else if (license.redistribution !== "local-only") {
      throw new Error(`User-provided file ${id} must use a local-only license policy`);
    }
    return { ...file, id, bundle, source: normalizedSource, licenseRef, localPath };
  });
  assertUniqueIds(files, "files");

  const localPaths = new Set();
  for (const file of files) {
    if (localPaths.has(file.localPath)) throw new Error(`files contains duplicate localPath: ${file.localPath}`);
    localPaths.add(file.localPath);
  }

  return { ...source, repositories, licenses, files };
}

export function readAssetManifest(manifestPath = DEFAULT_ASSET_MANIFEST) {
  const absolutePath = resolve(process.cwd(), manifestPath);
  if (!existsSync(absolutePath)) {
    throw new Error(
      `Asset manifest not found: ${absolutePath}. Copy assets/manifest.example.json to assets/manifest.lock.json, then pin the uploaded Hugging Face commit SHA.`,
    );
  }
  return parseAssetManifest(JSON.parse(readFileSync(absolutePath, "utf8")));
}

export function isPlaceholderRepository(repository) {
  return repository.repoId.includes("YOUR_HF_ORG") || /^0+$/.test(repository.revision);
}

export function assertReleaseReady(manifest) {
  const placeholders = manifest.repositories.filter(isPlaceholderRepository);
  if (placeholders.length > 0) {
    throw new Error(
      `Asset manifest is not release-ready; replace placeholder repositories: ${placeholders.map((entry) => entry.id).join(", ")}`,
    );
  }
  return manifest;
}

export function buildHuggingFaceAssetUrl(repository, remotePath) {
  if (isPlaceholderRepository(repository)) {
    throw new Error(
      `Repository ${repository.id} is still a placeholder; publish and pin the Hugging Face dataset first`,
    );
  }
  const prefix = repository.repoType === "dataset" ? "datasets/" : "";
  const encodedPath = remotePath.split("/").map(encodeURIComponent).join("/");
  return `https://huggingface.co/${prefix}${repository.repoId}/resolve/${repository.revision}/${encodedPath}`;
}

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

export function resolveAssetTarget(projectRoot, localPath) {
  assertSafeRelativePath(localPath, "localPath");
  const root = resolve(projectRoot);
  const target = resolve(root, localPath);
  const relation = relative(root, target);
  if (!relation || relation.startsWith(`..${sep}`) || relation === ".." || isAbsolute(relation)) {
    throw new Error(`Asset target escapes or aliases the project root: ${localPath}`);
  }
  return target;
}

function assertNoSymlinkTraversal(projectRoot, targetPath) {
  const root = resolve(projectRoot);
  const relation = relative(root, targetPath);
  let cursor = root;
  for (const part of relation.split(sep).slice(0, -1)) {
    cursor = resolve(cursor, part);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`Refusing asset path through symbolic link: ${cursor}`);
    }
  }
}

export async function inspectAssetFile(projectRoot, file) {
  const target = resolveAssetTarget(projectRoot, file.localPath);
  if (!existsSync(target)) return { id: file.id, localPath: file.localPath, status: "missing" };
  const metadata = await stat(target);
  if (!metadata.isFile()) return { id: file.id, localPath: file.localPath, status: "not-a-file" };
  if (metadata.size !== file.size) {
    return {
      id: file.id,
      localPath: file.localPath,
      status: "size-mismatch",
      expected: file.size,
      actual: metadata.size,
    };
  }
  const actualHash = await sha256File(target);
  if (actualHash !== file.sha256) {
    return {
      id: file.id,
      localPath: file.localPath,
      status: "hash-mismatch",
      expected: file.sha256,
      actual: actualHash,
    };
  }
  return { id: file.id, localPath: file.localPath, status: "valid", bytes: metadata.size };
}

export async function verifyAssetFiles(manifest, options = {}) {
  const projectRoot = options.projectRoot ?? process.cwd();
  const bundle = options.bundle;
  const requiredOnly = options.requiredOnly ?? false;
  const files = manifest.files.filter(
    (file) => (!bundle || file.bundle === bundle) && (!requiredOnly || file.required),
  );
  const results = [];
  for (const file of files) results.push(await inspectAssetFile(projectRoot, file));
  return results;
}

async function downloadAssetFile(manifest, file, options) {
  const projectRoot = options.projectRoot ?? process.cwd();
  const target = resolveAssetTarget(projectRoot, file.localPath);
  assertNoSymlinkTraversal(projectRoot, target);

  const current = await inspectAssetFile(projectRoot, file);
  if (current.status === "valid") return { ...current, action: "kept" };
  if (file.source.kind === "user-provided") {
    throw new Error(`${file.localPath} requires user provisioning: ${file.source.instructions}`);
  }
  if (current.status !== "missing" && !options.force) {
    throw new Error(`${file.localPath} is ${current.status}; use --force to replace it atomically`);
  }

  const repository = manifest.repositories.find((entry) => entry.id === file.source.repositoryId);
  const url = buildHuggingFaceAssetUrl(repository, file.source.remotePath);
  const headers = { "Accept-Encoding": "identity" };
  if (repository.tokenEnv) {
    const token = process.env[repository.tokenEnv];
    if (!token) throw new Error(`Repository ${repository.id} requires ${repository.tokenEnv}`);
    headers.Authorization = `Bearer ${token}`;
  }

  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.part-${process.pid}-${Date.now()}`;
  try {
    const response = await fetch(url, { headers, redirect: "follow" });
    if (!response.ok || !response.body) {
      throw new Error(`Hugging Face download failed for ${file.id}: HTTP ${response.status}`);
    }
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null) {
      const parsedLength = Number(declaredLength);
      if (!Number.isSafeInteger(parsedLength) || parsedLength !== file.size) {
        throw new Error(
          `Hugging Face Content-Length mismatch for ${file.id}: expected ${file.size}, got ${declaredLength}`,
        );
      }
    }
    let receivedBytes = 0;
    const sizeLimit = new Transform({
      transform(chunk, _encoding, callback) {
        receivedBytes += chunk.length;
        if (receivedBytes > file.size) {
          callback(new Error(`Download for ${file.id} exceeded manifest size ${file.size}`));
          return;
        }
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body), sizeLimit, createWriteStream(temporary, { flags: "wx" }));
    const temporaryStats = await stat(temporary);
    const temporaryHash = await sha256File(temporary);
    if (temporaryStats.size !== file.size || temporaryHash !== file.sha256) {
      throw new Error(
        `Integrity check failed for ${file.id}: expected ${file.size}/${file.sha256}, got ${temporaryStats.size}/${temporaryHash}`,
      );
    }
    await rename(temporary, target);
    return { id: file.id, localPath: file.localPath, status: "valid", action: "downloaded", bytes: file.size };
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function installAssetFiles(manifest, options = {}) {
  const bundle = options.bundle;
  const requiredOnly = options.requiredOnly ?? false;
  const files = manifest.files.filter(
    (file) => (!bundle || file.bundle === bundle) && (!requiredOnly || file.required),
  );
  const results = [];
  for (const file of files) results.push(await downloadAssetFile(manifest, file, options));
  return results;
}

function parseCli(argv) {
  const [command = "status", ...rest] = argv;
  const options = { force: false, requiredOnly: false };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--force") options.force = true;
    else if (argument === "--required-only") options.requiredOnly = true;
    else if (argument === "--manifest") options.manifestPath = rest[++index];
    else if (argument === "--bundle") options.bundle = rest[++index];
    else throw new Error(`Unknown asset option: ${argument}`);
  }
  return { command, options };
}

async function main() {
  const { command, options } = parseCli(process.argv.slice(2));
  if (command === "status" || command === "verify") {
    const manifestPath = resolve(process.cwd(), options.manifestPath ?? DEFAULT_ASSET_MANIFEST);
    if (!existsSync(manifestPath)) {
      const message =
        `Asset manifest lock not created (${manifestPath}); asset restore is unavailable. ` +
        `Copy assets/manifest.example.json to assets/manifest.lock.json and pin a real Hugging Face dataset (repoId + commit SHA) to enable install/verify.`;
      if (command === "status") {
        console.log(message);
        return;
      }
      console.error(message);
      process.exitCode = 1;
      return;
    }
  }
  const manifest = readAssetManifest(options.manifestPath);
  if (command === "status" || command === "verify") {
    const results = await verifyAssetFiles(manifest, options);
    const failures = results.filter((result) => result.status !== "valid");
    console.log(JSON.stringify({ release: manifest.release, command, results }, null, 2));
    if (command === "verify") {
      const selectedFiles = manifest.files.filter(
        (file) => (!options.bundle || file.bundle === options.bundle) && (!options.requiredOnly || file.required),
      );
      const requiredIds = new Set(selectedFiles.filter((file) => file.required).map((file) => file.id));
      if (failures.some((failure) => requiredIds.has(failure.id))) process.exitCode = 1;
    }
    return;
  }
  if (command === "release-check") {
    assertReleaseReady(manifest);
    const results = await verifyAssetFiles(manifest, { ...options, requiredOnly: true });
    const failures = results.filter((result) => result.status !== "valid");
    console.log(JSON.stringify({ release: manifest.release, command, results }, null, 2));
    if (failures.length > 0) process.exitCode = 1;
    return;
  }
  if (command === "install") {
    const results = await installAssetFiles(manifest, options);
    console.log(JSON.stringify({ release: manifest.release, command, results }, null, 2));
    return;
  }
  throw new Error(`Unknown asset command ${command}; expected status, verify, release-check, or install`);
}

const isDirectExecution = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isDirectExecution) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
