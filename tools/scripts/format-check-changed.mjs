#!/usr/bin/env node
/**
 * Run Prettier `--check` on files this checkout changed versus a git base,
 * using the same path globs as `npm run format:check`.
 *
 * Full-tree `format:check` currently fails on hundreds of files already on
 * `main`. CI uses this script so a PR is gated on the files it actually
 * touches, without a wholesale reformat of the rest of the tree.
 *
 * Base ref: `FORMAT_CHECK_BASE`, else `origin/$GITHUB_BASE_REF`, else `origin/main`.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * True when `file` would be included in `npm run format:check`.
 *
 * @param {string} file POSIX path relative to the repository root.
 */
export function pathIsInFormatCheckGlob(file) {
  const posix = file.replaceAll("\\", "/");
  return (
    /^frontend\/director\/(src|tests)\/.+\.(ts|tsx|css)$/.test(posix) ||
    /^backend\/gateway\/.+\.ts$/.test(posix) ||
    /^packages\/protocol\/(src|tests)\/.+\.(ts|tsx)$/.test(posix) ||
    /^tools\/[^/]+\.(js|ts|json)$/.test(posix) ||
    /^tools\/e2e\/[^/]+\.(js|ts)$/.test(posix) ||
    /^[^/]+\.(json|md|yml)$/.test(posix)
  );
}

/**
 * Resolves the git ref this check diffs against.
 *
 * @param {NodeJS.ProcessEnv} [environment]
 */
export function resolveFormatCheckBase(environment = process.env) {
  if (environment.FORMAT_CHECK_BASE?.trim()) return environment.FORMAT_CHECK_BASE.trim();
  if (environment.GITHUB_BASE_REF?.trim()) return `origin/${environment.GITHUB_BASE_REF.trim()}`;
  return "origin/main";
}

/**
 * Lists added/copied/modified/renamed files in the format:check glob versus `base...HEAD`.
 *
 * @param {string} base Git ref to compare against.
 * @param {{ cwd?: string }} [options]
 */
export function listChangedFormatFiles(base, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const diff = spawnSync("git", ["diff", "--name-only", "--diff-filter=ACMR", `${base}...HEAD`], {
    cwd,
    encoding: "utf8",
  });
  if (diff.status !== 0) {
    const detail = (diff.stderr || diff.stdout || "git diff failed").trim();
    throw new Error(`Unable to list files changed versus ${base}: ${detail}`);
  }
  return diff.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(pathIsInFormatCheckGlob)
    .filter((file) => existsSync(resolve(cwd, file)));
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  return fileURLToPath(import.meta.url) === resolve(entry);
}

function runPrettierCheck(files, cwd = process.cwd()) {
  const result = spawnSync("npx", ["prettier", "--check", "--", ...files], {
    cwd,
    encoding: "utf8",
    stdio: "inherit",
  });
  return result.status ?? 1;
}

if (invokedDirectly()) {
  const base = resolveFormatCheckBase();
  let files;
  try {
    files = listChangedFormatFiles(base);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  if (files.length === 0) {
    console.log(`format:check:changed — no format-glob files changed versus ${base}.`);
    process.exit(0);
  }
  console.log(`format:check:changed — Prettier check of ${files.length} file(s) versus ${base}:`);
  for (const file of files) console.log(`  ${file}`);
  process.exit(runPrettierCheck(files));
}
