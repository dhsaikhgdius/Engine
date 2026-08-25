/**
 * Shared utilities for pinned official inference-source Git submodules.
 *
 * LTX-2 keeps a dedicated `ltx2-source.mjs` because it also locks model shards.
 * Hunyuan3D-2, TRELLIS, and ARDY share this helper and sibling `vendor/*.lock.json` pins.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * @param {string} lockPath
 * @returns {Record<string, unknown> & {
 *   schemaVersion: number,
 *   id: string,
 *   displayName?: string,
 *   repository: string,
 *   commit: string,
 *   checkoutDirectory: string,
 *   setupCommand: string,
 *   sourceDirEnv?: string,
 *   licenseAcceptanceEnv?: string,
 *   submoduleRecursive?: boolean,
 *   requiredPaths: string[],
 *   license: { name: string, path: string, gitBlobSha: string, url: string },
 * }}
 */
export function readInferenceSourceLock(lockPath) {
  const absoluteLockPath = path.isAbsolute(lockPath) ? lockPath : path.join(repositoryRoot, lockPath);
  const lock = JSON.parse(readFileSync(absoluteLockPath, "utf8"));
  const requiredPaths = Array.isArray(lock.requiredPaths) ? lock.requiredPaths : [];
  if (
    lock.schemaVersion !== 1 ||
    typeof lock.id !== "string" ||
    typeof lock.repository !== "string" ||
    !/^[a-f0-9]{40}$/.test(lock.commit) ||
    typeof lock.checkoutDirectory !== "string" ||
    typeof lock.setupCommand !== "string" ||
    !/^[a-f0-9]{40}$/.test(lock.license?.gitBlobSha ?? "") ||
    typeof lock.license?.path !== "string" ||
    requiredPaths.length === 0 ||
    requiredPaths.some((entry) => typeof entry !== "string" || !entry.trim())
  ) {
    throw new Error(`Invalid inference source lock: ${absoluteLockPath}`);
  }
  return lock;
}

export function resolveInferenceSourceRoot(lock) {
  const configured = lock.sourceDirEnv ? process.env[lock.sourceDirEnv]?.trim() : undefined;
  return path.resolve(configured || path.join(repositoryRoot, lock.checkoutDirectory));
}

export function assertInferenceLicenseAcceptance(lock) {
  const envName = lock.licenseAcceptanceEnv;
  if (!envName) return;
  if (process.env[envName] !== "1") {
    const label = lock.displayName ?? lock.id;
    throw new Error(
      `Official ${label} source is governed by ${lock.license.name} (${lock.license.url}). ` +
        "Review its commercial, redistribution, territory, and acceptable-use restrictions, " +
        `then set ${envName}=1 if you are authorized to accept them.`,
    );
  }
}

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function normalizeRemote(value) {
  return value
    .trim()
    .replace(/\/$/, "")
    .replace(/\.git$/, "");
}

export function verifyInferenceSourceCheckout({
  allowDirty = false,
  lock: lockOverride,
  lockPath,
  sourceRoot: sourceRootOverride,
} = {}) {
  const lock = lockOverride ?? readInferenceSourceLock(lockPath);
  const label = lock.displayName ?? lock.id;
  const sourceRoot = path.resolve(sourceRootOverride ?? resolveInferenceSourceRoot(lock));
  if (!existsSync(sourceRoot)) {
    throw new Error(`Official ${label} source checkout is missing at ${sourceRoot}; run ${lock.setupCommand}`);
  }

  try {
    const insideWorkTree = git(["rev-parse", "--is-inside-work-tree"], sourceRoot);
    const gitTopLevel = realpathSync(git(["rev-parse", "--show-toplevel"], sourceRoot));
    if (insideWorkTree !== "true" || gitTopLevel !== realpathSync(sourceRoot)) {
      throw new Error("not the checkout root");
    }
  } catch {
    throw new Error(
      `Official ${label} source at ${sourceRoot} is not a complete Git checkout. ` +
        `A normal .git directory and a submodule/worktree .git file are both supported; run ${lock.setupCommand}.`,
    );
  }

  const remote = git(["config", "--get", "remote.origin.url"], sourceRoot);
  if (normalizeRemote(remote) !== normalizeRemote(lock.repository)) {
    throw new Error(`Unexpected ${label} origin ${remote}; expected ${lock.repository}`);
  }
  const commit = git(["rev-parse", "HEAD"], sourceRoot);
  if (commit !== lock.commit) {
    throw new Error(`Unexpected ${label} commit ${commit}; expected ${lock.commit}`);
  }
  const licenseBlob = git(["hash-object", lock.license.path], sourceRoot);
  if (licenseBlob !== lock.license.gitBlobSha) {
    throw new Error(`${label} license verification failed: ${licenseBlob}`);
  }
  for (const relativePath of lock.requiredPaths) {
    if (!existsSync(path.join(sourceRoot, relativePath))) {
      throw new Error(`Incomplete ${label} source checkout: missing ${relativePath}`);
    }
  }
  const dirty = git(["status", "--porcelain", "--untracked-files=no"], sourceRoot);
  if (dirty && !allowDirty) {
    throw new Error(
      `The pinned ${label} checkout has modified tracked files; preserve reproducibility before running it`,
    );
  }
  return { lock, sourceRoot, commit, remote, dirty: Boolean(dirty) };
}
