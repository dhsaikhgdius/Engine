import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { checkAgentIntegrations, writeAgentAdapters } from "./agent-integrations.mjs";

export const CANONICAL_SKILL_ROOT = ".claude/skills/director-workbench";
export const SKILL_TARGETS = [
  { root: ".dsh/skills/director-workbench" },
  { root: "integrations/plugins/director-workbench/skills/director-workbench" },
];
export const SYNC_HINT = 'run "npm run sync:skills"';

function isDirectory(path) {
  return existsSync(path) && lstatSync(path).isDirectory();
}

function listFiles(baseDir) {
  const files = [];
  const walk = (relativeDir) => {
    const entries = readdirSync(join(baseDir, relativeDir), { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(relativePath);
      else files.push(relativePath);
    }
  };
  walk("");
  return files.sort();
}

function isRegularFile(path) {
  const stats = lstatSync(path);
  return stats.isFile() && !stats.isSymbolicLink();
}

export function activeSkillTargets(rootDir = process.cwd()) {
  return SKILL_TARGETS.filter(
    (target) => !target.onlyIfPresent || isDirectory(resolve(rootDir, target.onlyIfPresent)),
  ).map((target) => target.root);
}

export function checkSkillCopies(rootDir = process.cwd()) {
  const failures = [];
  const canonicalDir = resolve(rootDir, CANONICAL_SKILL_ROOT);
  if (!isDirectory(canonicalDir)) return [`${CANONICAL_SKILL_ROOT}: missing canonical skill directory`];
  const canonicalFiles = listFiles(canonicalDir);
  if (canonicalFiles.length === 0) return [`${CANONICAL_SKILL_ROOT}: canonical skill directory is empty`];
  for (const relativeFile of canonicalFiles) {
    if (!isRegularFile(join(canonicalDir, relativeFile))) {
      failures.push(`${CANONICAL_SKILL_ROOT}/${relativeFile}: expected a regular file (symlinks are not allowed)`);
    }
  }
  for (const targetRoot of activeSkillTargets(rootDir)) {
    const targetDir = resolve(rootDir, targetRoot);
    if (!isDirectory(targetDir)) {
      failures.push(`${targetRoot}: missing skill copy; ${SYNC_HINT}`);
      continue;
    }
    const targetFiles = new Set(listFiles(targetDir));
    for (const relativeFile of canonicalFiles) {
      const targetFile = join(targetDir, relativeFile);
      if (!targetFiles.has(relativeFile)) {
        failures.push(`${targetRoot}/${relativeFile}: missing; ${SYNC_HINT}`);
        continue;
      }
      if (!isRegularFile(targetFile)) {
        failures.push(`${targetRoot}/${relativeFile}: expected a regular file (symlinks are not allowed)`);
        continue;
      }
      if (!readFileSync(targetFile).equals(readFileSync(join(canonicalDir, relativeFile)))) {
        failures.push(`${targetRoot}/${relativeFile}: differs from ${CANONICAL_SKILL_ROOT}; ${SYNC_HINT}`);
      }
    }
    for (const extraFile of targetFiles) {
      if (!canonicalFiles.includes(extraFile)) {
        failures.push(`${targetRoot}/${extraFile}: not in canonical source; ${SYNC_HINT}`);
      }
    }
  }
  return failures;
}

export function syncSkillCopies(rootDir = process.cwd()) {
  const canonicalDir = resolve(rootDir, CANONICAL_SKILL_ROOT);
  if (!isDirectory(canonicalDir)) {
    throw new Error(`${CANONICAL_SKILL_ROOT}: missing canonical skill directory`);
  }
  const canonicalFiles = listFiles(canonicalDir);
  if (canonicalFiles.length === 0) {
    throw new Error(`${CANONICAL_SKILL_ROOT}: canonical skill directory is empty`);
  }
  const summary = [];
  for (const targetRoot of activeSkillTargets(rootDir)) {
    const targetDir = resolve(rootDir, targetRoot);
    const written = [];
    const removed = [];
    const existingFiles = isDirectory(targetDir) ? listFiles(targetDir) : [];
    for (const relativeFile of canonicalFiles) {
      const sourceFile = join(canonicalDir, relativeFile);
      if (!isRegularFile(sourceFile)) {
        throw new Error(`${CANONICAL_SKILL_ROOT}/${relativeFile}: expected a regular file`);
      }
      const contents = readFileSync(sourceFile);
      const targetFile = join(targetDir, relativeFile);
      if (existsSync(targetFile)) {
        if (isRegularFile(targetFile) && readFileSync(targetFile).equals(contents)) continue;
        rmSync(targetFile);
      }
      mkdirSync(dirname(targetFile), { recursive: true });
      writeFileSync(targetFile, contents);
      written.push(relativeFile);
    }
    for (const existingFile of existingFiles) {
      if (!canonicalFiles.includes(existingFile)) {
        rmSync(join(targetDir, existingFile));
        removed.push(existingFile);
      }
    }
    summary.push({ target: targetRoot, written, removed });
  }
  return summary;
}

const isDirectExecution = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isDirectExecution) {
  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check");
  const unknown = args.filter((argument) => argument !== "--check");
  if (unknown.length > 0) {
    console.error(`Unknown sync-agent-skills option: ${unknown.join(", ")}`);
    process.exitCode = 1;
  } else if (checkOnly) {
    const failures = [...checkSkillCopies(), ...checkAgentIntegrations()];
    if (failures.length > 0) {
      console.error(`Agent skill copies or adapters are out of sync:\n`);
      for (const failure of failures) console.error(`- ${failure}`);
      process.exitCode = 1;
    } else {
      console.log(`Agent skill copies match ${CANONICAL_SKILL_ROOT} and generated adapters match.`);
    }
  } else {
    const summary = syncSkillCopies();
    for (const { target, written, removed } of summary) {
      if (written.length === 0 && removed.length === 0) {
        console.log(`${target}: already in sync`);
        continue;
      }
      for (const relativeFile of written) console.log(`${target}/${relativeFile}: updated`);
      for (const relativeFile of removed) console.log(`${target}/${relativeFile}: removed (not in canonical source)`);
    }
    console.log(`Agent skill copies synchronized from ${CANONICAL_SKILL_ROOT}.`);
    const adapters = writeAgentAdapters();
    if (adapters.length === 0) console.log("Agent adapters: already in sync");
    else for (const path of adapters) console.log(`${path}: updated`);
  }
}
