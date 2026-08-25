/**
 * Documentation truth lock for the Gateway architecture (`npm run repo:check`).
 *
 * The teaching channels are ranked (see `.claude/skills/director-workbench/SKILL.md`
 * "Canonical source order"): `capabilities`/`describe` own the vocabulary, the
 * skill and the DSH system guidance teach principles and pointers, tool
 * descriptions stay short envelopes, and rejection messages carry corrective
 * calls. Prose channels drift silently when Gateway modules move or die — two
 * such drifts (a summarization promise that was never wired, and docs teaching
 * an already-deleted in-house harness) each survived a whole architecture
 * migration. This check makes that class of drift mechanical:
 *
 * 1. every `backend/gateway/**` path referenced by documentation must exist;
 * 2. module names removed with the in-house harness must not be presented as
 *    current architecture;
 * 3. phrases that promised never-wired or since-removed capabilities must not
 *    reappear.
 *
 * Historical records (the supersede notice, the design review, the reuse
 * ledger, research proposals sketching future paths) carry explicit scoped
 * exemptions with reasons instead of being silently skipped.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Directory names never scanned: third-party trees and generated/dated snapshots. */
const SKIPPED_DIRECTORY_NAMES = new Set([".git", "node_modules", "vendor", ".external", ".runtime"]);

/**
 * Top-level directories excluded with a reason rather than by kind:
 * `.planning/` holds dated point-in-time codebase snapshots (each carries an
 * "Analysis Date"), not current teaching surfaces.
 */
const SKIPPED_ROOT_DIRECTORIES = new Set([".planning"]);

/** Documentation extensions scanned for Gateway references. */
const DOCUMENTATION_EXTENSIONS = [".md", ".mdc"];

/**
 * Non-markdown teaching surfaces locked by the same truth check: the DSH
 * system guidance and tool envelopes, and the MCP tool descriptions.
 */
const TEACHING_SOURCE_FILES = [
  "packages/dsh-plugin-workbench/src/register.ts",
  "packages/dsh-plugin-workbench/src/catalog.ts",
  "backend/gateway/mcp-server.ts",
];

/** A `backend/gateway/**` path-like token. Globs stop at `*`/`{` and resolve to real prefixes. */
const GATEWAY_PATH_PATTERN = /backend\/gateway\/[A-Za-z0-9_./-]+/g;

/**
 * Modules deleted with the in-house agent harness (superseded by the
 * `vendor/deepseek-harness` submodule plus `packages/dsh-plugin-workbench/`).
 * Documentation must not teach them as current architecture.
 */
export const REMOVED_GATEWAY_MODULE_NAMES = [
  "agentSessionStore",
  "agentHarness",
  "agentToolPipeline",
  "agentSpillStore",
  "agentAdapters",
  "agentAdapterRegistry",
  "openAiCompatibleAdapter",
  "hostedSessionHistory",
];

/**
 * Phrases that promised capabilities which were never wired or no longer
 * exist. "hosted-harness" and the in-process adapter claim survived the
 * harness migration inside the skill; every agent surface now reaches the
 * Gateway through `POST /api/tools/:name`.
 */
export const UNWIRED_PROMISE_PHRASES = ["hosted-harness", "Hosted and Codex adapters in the Gateway process"];

/**
 * Scoped exemptions for historical records. Each entry must say why the file
 * may keep the reference; new exemptions require the same justification.
 */
export const DOC_TRUTH_EXEMPTIONS = [
  {
    path: "docs/site/src/content/docs/engineering/architecture/agent-runtime-kernel.md",
    allowRemovedModuleNames: true,
    reason: "Supersede notice: names the removed in-house modules precisely to say they were removed.",
  },
  {
    path: "docs/site/src/content/docs/zh/engineering/architecture/agent-runtime-kernel.md",
    allowRemovedModuleNames: true,
    reason: "Chinese copy of the supersede notice.",
  },
  {
    path: "packages/dsh-plugin-workbench/HARNESS_DESIGN_REVIEW.zh-CN.md",
    allowRemovedModuleNames: true,
    allowUnwiredPromisePhrases: true,
    reason: "Design review that documents the drift this check now locks out.",
  },
  {
    path: "docs/site/src/content/docs/engineering/REFERENCE_REUSE_LEDGER.md",
    allowRemovedModuleNames: true,
    allowMissingGatewayPaths: true,
    reason:
      "License provenance ledger: records historical copy destinations, including files removed with the in-house harness.",
  },
  {
    path: "docs/research/CINEDELTA_PROPOSAL_DRAFT.md",
    allowMissingGatewayPaths: true,
    reason: "Research proposal sketching proposed (not yet existing) gateway paths.",
  },
  {
    path: "docs/research/CINEDELTA_RESEARCH_PROPOSAL_ZH.md",
    allowMissingGatewayPaths: true,
    reason: "Chinese research proposal sketching proposed (not yet existing) gateway paths.",
  },
];

function isDocumentationFile(name) {
  return DOCUMENTATION_EXTENSIONS.some((extension) => name.endsWith(extension));
}

function listDocumentationFiles(rootDir) {
  const files = [];
  const walk = (relativeDir) => {
    const entries = readdirSync(join(rootDir, relativeDir), { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue;
        if (!relativeDir && SKIPPED_ROOT_DIRECTORIES.has(entry.name)) continue;
        walk(relativePath);
      } else if (isDocumentationFile(entry.name)) {
        files.push(relativePath);
      }
    }
  };
  walk("");
  for (const teachingFile of TEACHING_SOURCE_FILES) {
    if (existsSync(join(rootDir, teachingFile))) files.push(teachingFile);
  }
  return files.sort();
}

/** Extracts referenced gateway paths from one line, trimming sentence punctuation. */
export function extractGatewayPathTokens(line) {
  const tokens = [];
  for (const match of line.matchAll(GATEWAY_PATH_PATTERN)) {
    const token = match[0].replace(/[.,;:]+$/, "");
    if (token) tokens.push(token);
  }
  return tokens;
}

const removedModulePattern = new RegExp(REMOVED_GATEWAY_MODULE_NAMES.join("|"), "gi");

export function checkDocGatewayPaths(rootDir = process.cwd(), exemptions = DOC_TRUTH_EXEMPTIONS) {
  const failures = [];
  const exemptionFor = (relativePath) => exemptions.find((exemption) => exemption.path === relativePath);
  for (const relativePath of listDocumentationFiles(rootDir)) {
    const exemption = exemptionFor(relativePath);
    const lines = readFileSync(join(rootDir, relativePath), "utf8").split("\n");
    lines.forEach((line, index) => {
      const location = `${relativePath}:${index + 1}`;
      if (!exemption?.allowMissingGatewayPaths) {
        for (const token of extractGatewayPathTokens(line)) {
          if (!existsSync(resolve(rootDir, token))) {
            failures.push(`${location}: references ${token}, which does not exist in this checkout`);
          }
        }
      }
      if (!exemption?.allowRemovedModuleNames) {
        for (const match of line.matchAll(removedModulePattern)) {
          failures.push(
            `${location}: mentions removed gateway module "${match[0]}" (deleted with the in-house harness; ` +
              `describe the DeepSeek Harness architecture or add a justified exemption)`,
          );
        }
      }
      if (!exemption?.allowUnwiredPromisePhrases) {
        for (const phrase of UNWIRED_PROMISE_PHRASES) {
          if (line.toLowerCase().includes(phrase.toLowerCase())) {
            failures.push(`${location}: contains "${phrase}", a capability promise that is not wired`);
          }
        }
      }
    });
  }
  for (const exemption of exemptions) {
    if (!exemption.reason) failures.push(`${exemption.path}: doc-truth exemption is missing its reason`);
    if (!existsSync(join(rootDir, exemption.path))) {
      failures.push(`${exemption.path}: doc-truth exemption points at a file that does not exist`);
    }
  }
  return failures;
}

const isDirectExecution = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isDirectExecution) {
  const failures = checkDocGatewayPaths();
  if (failures.length > 0) {
    console.error("Documentation truth check failed (gateway paths / removed modules / unwired promises):\n");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
  } else {
    console.log(
      "Documentation truth check passed: referenced backend/gateway paths exist and no removed-module or unwired-capability language was found.",
    );
  }
}
