// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_INSTRUCTION_FILES,
  AGENT_MCP_JSON_CONFIGS,
  checkAgentIntegrations,
  writeAgentAdapters,
} from "./agent-integrations.mjs";

const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createTemporaryRoot(prefix = "director-agent-integrations-") {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(directory);
  return directory;
}

describe("agent-integrations", () => {
  it("keeps every coding-agent MCP configuration and instruction file consistent in this checkout", () => {
    expect(checkAgentIntegrations(process.cwd())).toEqual([]);
  });

  it("covers only the documented Cursor, Codex, and Claude adapters", () => {
    expect(AGENT_MCP_JSON_CONFIGS.map((config) => config.path)).toEqual([".mcp.json", ".cursor/mcp.json"]);
    expect(AGENT_INSTRUCTION_FILES).toEqual(["AGENTS.md", "CLAUDE.md", ".cursor/rules/director-workbench.mdc"]);
  });

  it("writes per-agent adapters into an isolated root and is idempotent on a second pass", async () => {
    const directory = await createTemporaryRoot();
    await writeFile(join(directory, "AGENTS.md"), "See .claude/skills/director-workbench/SKILL.md\n");

    const firstWrite = writeAgentAdapters(directory);
    expect(firstWrite.length).toBeGreaterThan(0);
    expect(checkAgentIntegrations(directory)).toEqual([]);

    expect(writeAgentAdapters(directory)).toEqual([]);
    expect(checkAgentIntegrations(directory)).toEqual([]);
  });

  it("reports actionable failures for a directory without agent integrations", async () => {
    const directory = await createTemporaryRoot();
    const failures = checkAgentIntegrations(directory);

    expect(failures.some((failure) => failure.startsWith("AGENTS.md"))).toBe(true);
    expect(failures.some((failure) => failure.includes("missing generated adapter"))).toBe(true);
  });

  it("detects a hand-edited generated adapter", async () => {
    const directory = await createTemporaryRoot();
    await writeFile(join(directory, "AGENTS.md"), "See .claude/skills/director-workbench/SKILL.md\n");
    writeAgentAdapters(directory);
    await writeFile(join(directory, ".cursor/mcp.json"), "{}\n");

    const failures = checkAgentIntegrations(directory);
    expect(failures.some((failure) => failure.includes(".cursor/mcp.json: differs from generated adapter"))).toBe(
      true,
    );
  });
});
