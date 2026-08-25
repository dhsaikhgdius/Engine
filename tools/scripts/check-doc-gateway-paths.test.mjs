// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkDocGatewayPaths,
  DOC_TRUTH_EXEMPTIONS,
  extractGatewayPathTokens,
  REMOVED_GATEWAY_MODULE_NAMES,
  UNWIRED_PROMISE_PHRASES,
} from "./check-doc-gateway-paths.mjs";

const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createTemporaryRoot(prefix = "director-doc-truth-") {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(directory);
  return directory;
}

async function writeTree(root, files) {
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = join(root, relativePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, contents);
  }
}

describe("check-doc-gateway-paths", () => {
  it("passes on this checkout: every documented gateway path exists and no removed-module language remains", () => {
    expect(checkDocGatewayPaths(process.cwd())).toEqual([]);
  });

  it("extracts path tokens, trimming sentence punctuation and reducing globs to real prefixes", () => {
    expect(extractGatewayPathTokens("see `backend/gateway/mcp-server.ts`.")).toEqual(["backend/gateway/mcp-server.ts"]);
    expect(extractGatewayPathTokens("lives in backend/gateway/agents/agentToolScheduler.ts;")).toEqual([
      "backend/gateway/agents/agentToolScheduler.ts",
    ]);
    // Pure glob patterns are not path references; a partially globbed path
    // reduces to its real directory prefix.
    expect(extractGatewayPathTokens("covers backend/gateway/** and backend/gateway/**/*.ts")).toEqual([]);
    expect(extractGatewayPathTokens("all of backend/gateway/agents/*.ts")).toEqual(["backend/gateway/agents/"]);
    expect(extractGatewayPathTokens("no gateway reference here")).toEqual([]);
  });

  it("flags a documented gateway path that does not exist and accepts one that does", async () => {
    const root = await createTemporaryRoot();
    await writeTree(root, {
      "docs/guide.md": "Dispatch lives in `backend/gateway/realModule.ts` and `backend/gateway/ghostModule.ts`.\n",
      "backend/gateway/realModule.ts": "export {};\n",
    });

    const failures = checkDocGatewayPaths(root, []);
    expect(failures).toEqual([
      expect.stringContaining("docs/guide.md:1: references backend/gateway/ghostModule.ts, which does not exist"),
    ]);
  });

  it("flags removed in-house harness module names case-insensitively", async () => {
    const root = await createTemporaryRoot();
    await writeTree(root, {
      "docs/stale.md": "Sessions persist through AgentSessionStore; delegation asks agentHarness for a child.\n",
    });

    const failures = checkDocGatewayPaths(root, []);
    expect(failures).toHaveLength(2);
    expect(failures[0]).toContain('removed gateway module "AgentSessionStore"');
    expect(failures[1]).toContain('removed gateway module "agentHarness"');
  });

  it("flags unwired capability promise phrases", async () => {
    const root = await createTemporaryRoot();
    await writeTree(root, {
      "docs/promise.md": "Model-facing MCP and hosted-harness surfaces summarize oversized results.\n",
    });

    const failures = checkDocGatewayPaths(root, []);
    expect(failures).toEqual([expect.stringContaining('contains "hosted-harness"')]);
  });

  it("scans the non-markdown teaching surfaces (DSH guidance, tool envelopes, MCP descriptions)", async () => {
    const root = await createTemporaryRoot();
    await writeTree(root, {
      "packages/dsh-plugin-workbench/src/register.ts": "// results persist via agentSessionStore\n",
    });

    const failures = checkDocGatewayPaths(root, []);
    expect(failures).toEqual([
      expect.stringContaining(
        'packages/dsh-plugin-workbench/src/register.ts:1: mentions removed gateway module "agentSessionStore"',
      ),
    ]);
  });

  it("honors scoped exemptions only for the granted category and requires a reason and a real file", async () => {
    const root = await createTemporaryRoot();
    await writeTree(root, {
      "docs/history.md": "The removed agentToolPipeline referenced backend/gateway/goneModule.ts.\n",
    });

    const namesOnly = [
      { path: "docs/history.md", allowRemovedModuleNames: true, reason: "historical record for this test" },
    ];
    const namesOnlyFailures = checkDocGatewayPaths(root, namesOnly);
    expect(namesOnlyFailures).toEqual([
      expect.stringContaining("references backend/gateway/goneModule.ts, which does not exist"),
    ]);

    const fullyExempt = [
      {
        path: "docs/history.md",
        allowRemovedModuleNames: true,
        allowMissingGatewayPaths: true,
        reason: "historical record for this test",
      },
    ];
    expect(checkDocGatewayPaths(root, fullyExempt)).toEqual([]);

    const invalidExemptions = [
      { path: "docs/history.md", allowRemovedModuleNames: true, allowMissingGatewayPaths: true },
      { path: "docs/absent.md", allowRemovedModuleNames: true, reason: "points nowhere" },
    ];
    const invalidFailures = checkDocGatewayPaths(root, invalidExemptions);
    expect(invalidFailures).toEqual([
      "docs/history.md: doc-truth exemption is missing its reason",
      "docs/absent.md: doc-truth exemption points at a file that does not exist",
    ]);
  });

  it("skips third-party trees and dated planning snapshots", async () => {
    const root = await createTemporaryRoot();
    await writeTree(root, {
      "vendor/deepseek-harness/README.md": "upstream agentHarness docs\n",
      "node_modules/pkg/README.md": "agentSessionStore\n",
      ".planning/codebase/ARCHITECTURE.md": "dated snapshot mentioning agentToolPipeline\n",
      ".runtime/notes.md": "agentSpillStore\n",
    });

    expect(checkDocGatewayPaths(root, [])).toEqual([]);
  });

  it("locks the denylists that the design review identified", () => {
    for (const name of ["agentSessionStore", "agentHarness", "agentToolPipeline"]) {
      expect(REMOVED_GATEWAY_MODULE_NAMES).toContain(name);
    }
    expect(UNWIRED_PROMISE_PHRASES).toContain("hosted-harness");
    for (const exemption of DOC_TRUTH_EXEMPTIONS) {
      expect(exemption.reason).toBeTruthy();
    }
  });
});
