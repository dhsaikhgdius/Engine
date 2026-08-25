// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { verifyLtx2SourceCheckout } from "./ltx2-source.mjs";

const temporaryRoots = [];

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function createFixtureCheckout() {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "director-ltx2-source-"));
  temporaryRoots.push(temporaryRoot);
  const checkoutRoot = path.join(temporaryRoot, "checkout");
  mkdirSync(checkoutRoot, { recursive: true });
  git(["init", "--quiet"], checkoutRoot);
  git(["config", "user.email", "director-tests@example.invalid"], checkoutRoot);
  git(["config", "user.name", "Director Tests"], checkoutRoot);
  git(["remote", "add", "origin", "https://github.com/Lightricks/LTX-2.git"], checkoutRoot);

  const requiredFiles = {
    LICENSE: "fixture LTX license\n",
    "pyproject.toml": '[project]\nname = "ltx-fixture"\nversion = "0.0.0"\n',
    "uv.lock": "version = 1\n",
    "packages/ltx-core/src/ltx_core/__init__.py": "",
    "packages/ltx-pipelines/src/ltx_pipelines/__init__.py": "",
  };
  for (const [relativePath, contents] of Object.entries(requiredFiles)) {
    const absolutePath = path.join(checkoutRoot, relativePath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, contents);
  }
  git(["add", "."], checkoutRoot);
  git(["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture"], checkoutRoot);

  const commit = git(["rev-parse", "HEAD"], checkoutRoot);
  const licenseBlob = git(["hash-object", "LICENSE"], checkoutRoot);
  const lock = {
    schemaVersion: 1,
    repository: "https://github.com/Lightricks/LTX-2.git",
    commit,
    checkoutDirectory: "unused-in-test",
    license: {
      name: "fixture",
      path: "LICENSE",
      gitBlobSha: licenseBlob,
      url: "https://example.invalid/license",
    },
    packages: { "ltx-core": "0.0.0", "ltx-pipelines": "0.0.0" },
    models: {},
  };
  return { checkoutRoot, lock, temporaryRoot };
}

afterEach(() => {
  for (const temporaryRoot of temporaryRoots.splice(0)) {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

describe("verifyLtx2SourceCheckout", () => {
  it("accepts a normal checkout with a .git directory", () => {
    const fixture = createFixtureCheckout();

    const result = verifyLtx2SourceCheckout({ sourceRoot: fixture.checkoutRoot, lock: fixture.lock });

    expect(result.commit).toBe(fixture.lock.commit);
    expect(result.sourceRoot).toBe(fixture.checkoutRoot);
  });

  it("accepts a submodule/worktree checkout with a .git file", () => {
    const fixture = createFixtureCheckout();
    const worktreeRoot = path.join(fixture.temporaryRoot, "worktree");
    git(["worktree", "add", "--quiet", "--detach", worktreeRoot, fixture.lock.commit], fixture.checkoutRoot);

    expect(readFileSync(path.join(worktreeRoot, ".git"), "utf8")).toMatch(/^gitdir:/);
    const result = verifyLtx2SourceCheckout({ sourceRoot: worktreeRoot, lock: fixture.lock });

    expect(result.commit).toBe(fixture.lock.commit);
    expect(result.sourceRoot).toBe(worktreeRoot);
  });

  it("reports a missing checkout with an actionable setup command", () => {
    const fixture = createFixtureCheckout();
    const missingRoot = path.join(fixture.temporaryRoot, "missing");

    expect(() => verifyLtx2SourceCheckout({ sourceRoot: missingRoot, lock: fixture.lock })).toThrow(
      "run npm run setup:ltx2",
    );
  });

  it("rejects a checkout that does not match the pinned commit", () => {
    const fixture = createFixtureCheckout();
    const mismatchedLock = { ...fixture.lock, commit: "0".repeat(40) };

    expect(() => verifyLtx2SourceCheckout({ sourceRoot: fixture.checkoutRoot, lock: mismatchedLock })).toThrow(
      `expected ${"0".repeat(40)}`,
    );
  });

  it("rejects a plain directory that is not a Git checkout", () => {
    const fixture = createFixtureCheckout();
    const plainRoot = path.join(fixture.temporaryRoot, "plain");
    mkdirSync(plainRoot);

    expect(() => verifyLtx2SourceCheckout({ sourceRoot: plainRoot, lock: fixture.lock })).toThrow(
      "A normal .git directory and a submodule/worktree .git file are both supported",
    );
  });
});
