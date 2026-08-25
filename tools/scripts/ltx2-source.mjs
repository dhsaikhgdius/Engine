import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const lockPath = path.join(repositoryRoot, "vendor", "ltx-2.lock.json");

export function readLtx2SourceLock() {
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  if (
    lock.schemaVersion !== 1 ||
    typeof lock.repository !== "string" ||
    !/^[a-f0-9]{40}$/.test(lock.commit) ||
    typeof lock.checkoutDirectory !== "string" ||
    !/^[a-f0-9]{40}$/.test(lock.license?.gitBlobSha ?? "")
  ) {
    throw new Error(`Invalid LTX-2 source lock: ${lockPath}`);
  }
  return lock;
}

export function resolveLtx2SourceRoot(lock = readLtx2SourceLock()) {
  const configured = process.env.DIRECTOR_LTX2_SOURCE_DIR?.trim();
  return path.resolve(configured || path.join(repositoryRoot, lock.checkoutDirectory));
}

export function assertLtx2LicenseAcceptance(lock = readLtx2SourceLock()) {
  if (process.env.DIRECTOR_ACCEPT_LTX2_LICENSE !== "1") {
    throw new Error(
      `Official LTX-2 source is governed by the LTX-2 Community License (${lock.license.url}). ` +
        "Review its commercial, redistribution, acceptable-use, disclosure, and competing-product restrictions, " +
        "then set DIRECTOR_ACCEPT_LTX2_LICENSE=1 if you are authorized to accept them.",
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

export function verifyLtx2SourceCheckout({
  allowDirty = false,
  lock: lockOverride,
  sourceRoot: sourceRootOverride,
} = {}) {
  const lock = lockOverride ?? readLtx2SourceLock();
  const sourceRoot = path.resolve(sourceRootOverride ?? resolveLtx2SourceRoot(lock));
  if (!existsSync(sourceRoot)) {
    throw new Error(`Official LTX-2 source checkout is missing at ${sourceRoot}; run npm run setup:ltx2`);
  }

  let gitTopLevel;
  try {
    const insideWorkTree = git(["rev-parse", "--is-inside-work-tree"], sourceRoot);
    gitTopLevel = realpathSync(git(["rev-parse", "--show-toplevel"], sourceRoot));
    if (insideWorkTree !== "true" || gitTopLevel !== realpathSync(sourceRoot)) {
      throw new Error("not the checkout root");
    }
  } catch {
    throw new Error(
      `Official LTX-2 source at ${sourceRoot} is not a complete Git checkout. ` +
        "A normal .git directory and a submodule/worktree .git file are both supported; run npm run setup:ltx2.",
    );
  }

  const remote = git(["config", "--get", "remote.origin.url"], sourceRoot);
  if (normalizeRemote(remote) !== normalizeRemote(lock.repository)) {
    throw new Error(`Unexpected LTX-2 origin ${remote}; expected ${lock.repository}`);
  }
  const commit = git(["rev-parse", "HEAD"], sourceRoot);
  if (commit !== lock.commit) {
    throw new Error(`Unexpected LTX-2 commit ${commit}; expected ${lock.commit}`);
  }
  const licenseBlob = git(["hash-object", lock.license.path], sourceRoot);
  if (licenseBlob !== lock.license.gitBlobSha) {
    throw new Error(`LTX-2 license verification failed: ${licenseBlob}`);
  }
  const requiredPaths = [
    "pyproject.toml",
    "uv.lock",
    "packages/ltx-core/src/ltx_core",
    "packages/ltx-pipelines/src/ltx_pipelines",
  ];
  for (const relativePath of requiredPaths) {
    if (!existsSync(path.join(sourceRoot, relativePath))) {
      throw new Error(`Incomplete LTX-2 source checkout: missing ${relativePath}`);
    }
  }
  const dirty = git(["status", "--porcelain", "--untracked-files=no"], sourceRoot);
  if (dirty && !allowDirty) {
    throw new Error("The pinned LTX-2 checkout has modified tracked files; preserve reproducibility before running it");
  }
  return { lock, sourceRoot, commit, remote, dirty: Boolean(dirty) };
}

export { repositoryRoot };
