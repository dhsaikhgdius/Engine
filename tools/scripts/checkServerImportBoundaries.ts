/**
 * Server import-boundary checker.
 *
 * Scans the backend gateway source tree for imports that would pull in
 * browser-only packages (React, Zustand, @react-three, etc.). Pure agent
 * modules that are safe for universal consumption are whitelisted; every
 * other import of a browser-runtime package from the server tree is flagged
 * as a boundary violation.
 *
 * @module checkServerImportBoundaries
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

/** Packages that require a browser runtime and must not import from the server tree. */
const BROWSER_RUNTIME_PACKAGES = [
  /^react(?:\/|$)/,
  /^react-dom(?:\/|$)/,
  /^@react-three(?:\/|$)/,
  /^zustand(?:\/|$)/,
  /^@xterm(?:\/|$)/,
  /^lucide-react(?:\/|$)/,
  /^camera-controls(?:\/|$)/,
];

/** Official workspace packages the control plane may import by relative path. */
const WORKSPACE_PACKAGE_PREFIXES = [
  "packages/protocol/",
  "packages/agent-engine/",
  "packages/project-schema/",
  "packages/stage-protocol/",
  "packages/dcc-protocol/",
  "packages/dcc-interchange/",
  "packages/model-provider/",
  "packages/di/",
  "packages/scene-pipeline/",
  "packages/dsh-plugin-workbench/",
];

export const TEMPORARY_SERVER_IMPORT_EXCEPTIONS = [] as const;

export type ServerImportBoundaryViolation = {
  importer: string;
  specifier: string;
  target: string | null;
  reason: string;
};

function withoutKnownExtension(path: string) {
  return path.replace(/\.(?:[cm]?[jt]sx?)$/, "").replace(/\/index$/, "");
}

function posix(path: string) {
  return path.replaceAll("\\", "/");
}

function moduleSpecifiers(source: string, fileName: string) {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const specifiers: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0]!)
    ) {
      specifiers.push(node.arguments[0]!.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

function allowedSourceTarget(_importer: string, target: string) {
  return WORKSPACE_PACKAGE_PREFIXES.some((prefix) => target.startsWith(prefix));
}

export function inspectServerSourceImports(
  source: string,
  importerPath: string,
  workspaceRoot: string,
): ServerImportBoundaryViolation[] {
  const importer = posix(relative(workspaceRoot, importerPath));
  const violations: ServerImportBoundaryViolation[] = [];
  for (const specifier of moduleSpecifiers(source, importerPath)) {
    if (!specifier.startsWith(".")) {
      if (BROWSER_RUNTIME_PACKAGES.some((pattern) => pattern.test(specifier))) {
        violations.push({
          importer,
          specifier,
          target: null,
          reason: "Server code cannot import a browser UI/runtime package.",
        });
      }
      continue;
    }
    const target = withoutKnownExtension(posix(relative(workspaceRoot, resolve(dirname(importerPath), specifier))));
    if (!target.startsWith("frontend/director/src/") && !target.startsWith("packages/")) continue;
    if (!allowedSourceTarget(importer, target)) {
      violations.push({
        importer,
        specifier,
        target,
        reason:
          "Server may import only official workspace packages; browser runtime and unapproved frontend modules belong behind an API boundary.",
      });
    }
  }
  return violations;
}

async function serverTypeScriptFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "tests") continue;
      files.push(...(await serverTypeScriptFiles(path)));
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.(?:test|spec)\.tsx?$/.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

export async function checkServerImportBoundaries(workspaceRoot: string) {
  const files = await serverTypeScriptFiles(resolve(workspaceRoot, "backend/gateway"));
  const violations = (
    await Promise.all(
      files.map(async (file) => inspectServerSourceImports(await readFile(file, "utf8"), file, workspaceRoot)),
    )
  ).flat();
  return { auditedFileCount: files.length, violations };
}

const ownPath = fileURLToPath(import.meta.url);
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === pathToFileURL(ownPath).href) {
  const workspaceRoot = resolve(dirname(ownPath), "../..");
  const result = await checkServerImportBoundaries(workspaceRoot);
  if (result.violations.length) {
    console.error("Server import boundary violations:");
    for (const violation of result.violations) {
      console.error(`- ${violation.importer}: ${violation.specifier} (${violation.reason})`);
    }
    process.exitCode = 1;
  } else {
    console.log(
      `Server import boundary passed (${result.auditedFileCount} files; ${TEMPORARY_SERVER_IMPORT_EXCEPTIONS.length} explicit migration exceptions).`,
    );
  }
}
