import { execFileSync } from "node:child_process";
import path from "node:path";

import {
  assertLtx2LicenseAcceptance,
  readLtx2SourceLock,
  repositoryRoot,
  resolveLtx2SourceRoot,
  verifyLtx2SourceCheckout,
} from "./ltx2-source.mjs";

function runGit(args, cwd = repositoryRoot) {
  execFileSync("git", args, { cwd, stdio: "inherit" });
}

function gitOutput(args, cwd = repositoryRoot) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

const lock = readLtx2SourceLock();
assertLtx2LicenseAcceptance(lock);
const sourceRoot = resolveLtx2SourceRoot(lock);
const checkoutPath = path.relative(repositoryRoot, sourceRoot);

try {
  gitOutput(["rev-parse", "HEAD"], sourceRoot);
} catch {
  try {
    runGit(["submodule", "update", "--init", "--recursive", checkoutPath]);
  } catch {
    runGit(["submodule", "add", "--force", "--depth", "1", "--name", "vendor/ltx-2", lock.repository, checkoutPath]);
  }
}

const current = gitOutput(["rev-parse", "HEAD"], sourceRoot);
if (current !== lock.commit) {
  const dirty = gitOutput(["status", "--porcelain", "--untracked-files=no"], sourceRoot);
  if (dirty) {
    throw new Error(`Refusing to switch dirty LTX-2 checkout at ${sourceRoot}`);
  }
  runGit(["fetch", "--depth", "1", "origin", lock.commit], sourceRoot);
  runGit(["checkout", "--detach", lock.commit], sourceRoot);
}

const verified = verifyLtx2SourceCheckout();
process.stdout.write(
  `${JSON.stringify({ sourceRoot: verified.sourceRoot, repository: lock.repository, commit: verified.commit }, null, 2)}\n`,
);
