// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertInferenceLicenseAcceptance,
  verifyInferenceSourceCheckout,
} from "./inference-source.mjs";

const temporaryRoots = [];

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function createFixtureCheckout() {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "director-inference-source-"));
  temporaryRoots.push(temporaryRoot);
  const checkoutRoot = path.join(temporaryRoot, "checkout");
  mkdirSync(checkoutRoot, { recursive: true });
  git(["init", "--quiet"], checkoutRoot);
  git(["config", "user.email", "director-tests@example.invalid"], checkoutRoot);
  git(["config", "user.name", "Director Tests"], checkoutRoot);
  git(["remote", "add", "origin", "https://github.com/nv-tlabs/ardy.git"], checkoutRoot);

  const requiredFiles = {
    LICENSE: "fixture Apache license\n",
    "scripts/generate.py": "print('fixture')\n",
    "pyproject.toml": '[project]\nname = "ardy-fixture"\nversion = "0.0.0"\n',
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
    id: "ardy",
    displayName: "NVIDIA ARDY",
    repository: "https://github.com/nv-tlabs/ardy.git",
    commit,
    checkoutDirectory: "unused-in-test",
    setupCommand: "npm run setup:ardy",
    license: {
      name: "Apache License 2.0",
      path: "LICENSE",
      gitBlobSha: licenseBlob,
      url: "https://example.invalid/license",
    },
    requiredPaths: ["LICENSE", "scripts/generate.py", "pyproject.toml"],
  };
  return { checkoutRoot, lock, temporaryRoot };
}

afterEach(() => {
  for (const temporaryRoot of temporaryRoots.splice(0)) {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

describe("verifyInferenceSourceCheckout", () => {
  it("accepts a normal checkout with a .git directory", () => {
    const fixture = createFixtureCheckout();

    const result = verifyInferenceSourceCheckout({ sourceRoot: fixture.checkoutRoot, lock: fixture.lock });

    expect(result.commit).toBe(fixture.lock.commit);
    expect(result.sourceRoot).toBe(fixture.checkoutRoot);
  });

  it("accepts a submodule/worktree checkout with a .git file", () => {
    const fixture = createFixtureCheckout();
    const worktreeRoot = path.join(fixture.temporaryRoot, "worktree");
    git(["worktree", "add", "--quiet", "--detach", worktreeRoot, fixture.lock.commit], fixture.checkoutRoot);

    const result = verifyInferenceSourceCheckout({ sourceRoot: worktreeRoot, lock: fixture.lock });

    expect(result.commit).toBe(fixture.lock.commit);
    expect(result.sourceRoot).toBe(worktreeRoot);
  });

  it("reports a missing checkout with an actionable setup command", () => {
    const fixture = createFixtureCheckout();
    const missingRoot = path.join(fixture.temporaryRoot, "missing");

    expect(() => verifyInferenceSourceCheckout({ sourceRoot: missingRoot, lock: fixture.lock })).toThrow(
      "run npm run setup:ardy",
    );
  });

  it("rejects a checkout that does not match the pinned commit", () => {
    const fixture = createFixtureCheckout();
    const mismatchedLock = { ...fixture.lock, commit: "0".repeat(40) };

    expect(() => verifyInferenceSourceCheckout({ sourceRoot: fixture.checkoutRoot, lock: mismatchedLock })).toThrow(
      `expected ${"0".repeat(40)}`,
    );
  });
});

describe("assertInferenceLicenseAcceptance", () => {
  it("requires the configured acceptance env for restricted upstream licenses", () => {
    const previous = process.env.DIRECTOR_ACCEPT_HUNYUAN3D_LICENSE;
    delete process.env.DIRECTOR_ACCEPT_HUNYUAN3D_LICENSE;
    try {
      expect(() =>
        assertInferenceLicenseAcceptance({
          id: "hunyuan3d",
          displayName: "Tencent Hunyuan3D-2",
          licenseAcceptanceEnv: "DIRECTOR_ACCEPT_HUNYUAN3D_LICENSE",
          license: {
            name: "Tencent Hunyuan 3D 2.0 Community License Agreement",
            url: "https://example.invalid/hunyuan-license",
          },
        }),
      ).toThrow("DIRECTOR_ACCEPT_HUNYUAN3D_LICENSE=1");
    } finally {
      if (previous === undefined) delete process.env.DIRECTOR_ACCEPT_HUNYUAN3D_LICENSE;
      else process.env.DIRECTOR_ACCEPT_HUNYUAN3D_LICENSE = previous;
    }
  });

  it("does not require an acceptance env for Apache/MIT pins", () => {
    expect(() =>
      assertInferenceLicenseAcceptance({
        id: "ardy",
        license: { name: "Apache License 2.0", url: "https://example.invalid/apache" },
      }),
    ).not.toThrow();
  });
});
