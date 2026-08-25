/**
 * Initialize or pin an official inference-source Git submodule from its lock file.
 *
 * Usage: `node tools/scripts/bootstrap-inference-source.mjs <lock.json>`
 */
import { execFileSync } from "node:child_process";
import path from "node:path";

import {
  assertInferenceLicenseAcceptance,
  readInferenceSourceLock,
  repositoryRoot,
  resolveInferenceSourceRoot,
  verifyInferenceSourceCheckout,
} from "./inference-source.mjs";

function runGit(args, cwd = repositoryRoot) {
  execFileSync("git", args, { cwd, stdio: "inherit" });
}

function gitOutput(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

const lockPath = process.argv[2]?.trim();
if (!lockPath) {
  throw new Error("Usage: node tools/scripts/bootstrap-inference-source.mjs <lock.json>");
}

const lock = readInferenceSourceLock(lockPath);
assertInferenceLicenseAcceptance(lock);
const sourceRoot = resolveInferenceSourceRoot(lock);
const checkoutPath = path.relative(repositoryRoot, sourceRoot);
const updateArgs = lock.submoduleRecursive
  ? ["submodule", "update", "--init", "--recursive", checkoutPath]
  : ["submodule", "update", "--init", checkoutPath];

try {
  gitOutput(["rev-parse", "HEAD"], sourceRoot);
} catch {
  runGit(updateArgs);
}

const current = gitOutput(["rev-parse", "HEAD"], sourceRoot);
if (current !== lock.commit) {
  const dirty = gitOutput(["status", "--porcelain", "--untracked-files=no"], sourceRoot);
  if (dirty) {
    throw new Error(`Refusing to switch dirty ${lock.displayName ?? lock.id} checkout at ${sourceRoot}`);
  }
  runGit(["fetch", "--depth", "1", "origin", lock.commit], sourceRoot);
  runGit(["checkout", "--detach", lock.commit], sourceRoot);
}

if (lock.submoduleRecursive) {
  runGit(["submodule", "update", "--init", "--recursive"], sourceRoot);
}

const verified = verifyInferenceSourceCheckout({ lock, sourceRoot });
process.stdout.write(
  `${JSON.stringify(
    {
      id: lock.id,
      sourceRoot: verified.sourceRoot,
      repository: lock.repository,
      commit: verified.commit,
    },
    null,
    2,
  )}\n`,
);
