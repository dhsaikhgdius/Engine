import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Canonical launch definition for the Director MCP server; every agent config must match it. */
export const DIRECTOR_MCP_LAUNCH = Object.freeze({
  command: "node",
  args: Object.freeze(["--import", "tsx/esm", "backend/gateway/mcp-server.ts"]),
  env: Object.freeze({ STAGE_GATEWAY_URL: "http://127.0.0.1:8787" }),
});

const GENERATED_NOTICE =
  "<!-- Generated adapter. Edit AGENTS.md and `.claude/skills/director-workbench/`, then run `npm run sync:skills`. -->";

const WORKBENCH_POINTER = `Read \`AGENTS.md\` at the repository root for the repository map, commands, and conventions.

To control the live Director workbench (3D Stage, Canvas, Video Editor, Gallery), follow
\`.claude/skills/director-workbench/SKILL.md\`.`;

function markdownContents(body, frontmatter = "") {
  const noticeAndBody = `${GENERATED_NOTICE}\n\n${body.replace(/^\n+/, "").replace(/\s*$/, "\n")}`;
  return frontmatter ? `${frontmatter.replace(/\n+$/, "")}\n\n${noticeAndBody}` : noticeAndBody;
}

function jsonContents(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function launchServer(fields = {}) {
  return {
    ...fields,
    command: DIRECTOR_MCP_LAUNCH.command,
    args: [...DIRECTOR_MCP_LAUNCH.args],
    env: { ...DIRECTOR_MCP_LAUNCH.env },
  };
}

/** Per-product files generated from this module. Do not hand-edit those paths. */
export const AGENT_ADAPTER_FILES = Object.freeze({
  ".mcp.json": jsonContents({
    mcpServers: {
      "director-stage": launchServer({ cwd: "." }),
    },
  }),
  ".cursor/mcp.json": jsonContents({
    mcpServers: {
      "director-workbench": launchServer(),
    },
  }),
  ".codex/config.toml": `[mcp_servers.director-stage]
enabled = true
required = false
command = "node"
args = ["--import", "tsx/esm", "backend/gateway/mcp-server.ts"]
cwd = "."
startup_timeout_sec = 30.0
tool_timeout_sec = 120.0

[mcp_servers.director-stage.env]
STAGE_GATEWAY_URL = "${DIRECTOR_MCP_LAUNCH.env.STAGE_GATEWAY_URL}"
`,
  "CLAUDE.md": markdownContents(
    `Follow the repository agent guide in @AGENTS.md.

The Director workbench skill lives in \`.claude/skills/director-workbench/\`.
Edit that and \`AGENTS.md\`, then run \`npm run sync:skills\` to update the portable plugin copy.
The Director MCP server is configured in \`.mcp.json\`.
`,
    "# Claude Code guide\n",
  ),
  ".cursor/rules/director-workbench.mdc": markdownContents(
    `${WORKBENCH_POINTER} The Director MCP server (\`director-workbench\`)
is configured in \`.cursor/mcp.json\` and exposes \`director_workbench\`, \`director_creative\`, and
\`director_dcc\`. Never automate the UI by screen coordinates when a semantic operation exists.
`,
    `---
description: Director repository guide and 3D workbench skill entry point
alwaysApply: true
---
`,
  ),
});

/** JSON configs whose named server entry uses the common command/args/env shape. */
export const AGENT_MCP_JSON_CONFIGS = Object.freeze([
  { path: ".mcp.json", serverPath: ["mcpServers", "director-stage"] },
  { path: ".cursor/mcp.json", serverPath: ["mcpServers", "director-workbench"] },
]);

export const CODEX_MCP_CONFIG_PATH = ".codex/config.toml";

/** Instruction entry points; AGENTS.md is canonical and every other file must point back to it. */
export const AGENT_INSTRUCTION_FILES = Object.freeze([
  "AGENTS.md",
  "CLAUDE.md",
  ".cursor/rules/director-workbench.mdc",
]);

const CANONICAL_SKILL_FILE = ".claude/skills/director-workbench/SKILL.md";

function sameStringArray(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length && actual.every((v, i) => v === expected[i]);
}

export function renderAgentAdapterFiles() {
  return Object.entries(AGENT_ADAPTER_FILES).map(([path, contents]) => ({ path, contents }));
}

export function writeAgentAdapters(rootDir = process.cwd()) {
  const written = [];
  for (const { path, contents } of renderAgentAdapterFiles()) {
    const absolute = resolve(rootDir, path);
    if (existsSync(absolute) && readFileSync(absolute, "utf8") === contents) continue;
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
    written.push(path);
  }
  return written;
}

function checkGeneratedAdapters(rootDir, failures) {
  for (const { path, contents } of renderAgentAdapterFiles()) {
    const absolute = resolve(rootDir, path);
    if (!existsSync(absolute)) {
      failures.push(`${path}: missing generated adapter; run "npm run sync:skills"`);
      continue;
    }
    if (readFileSync(absolute, "utf8") !== contents) {
      failures.push(`${path}: differs from generated adapter; run "npm run sync:skills"`);
    }
  }
}

function checkLaunchShape(rootDir, failures) {
  for (const config of AGENT_MCP_JSON_CONFIGS) {
    const absolute = resolve(rootDir, config.path);
    if (!existsSync(absolute)) continue;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(absolute, "utf8"));
    } catch (error) {
      failures.push(`${config.path}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    const entry = config.serverPath.reduce((value, key) => (value == null ? value : value[key]), parsed);
    if (!entry || typeof entry !== "object") {
      failures.push(`${config.path}: missing "${config.serverPath.join(".")}" server entry`);
      continue;
    }
    if (entry.command !== DIRECTOR_MCP_LAUNCH.command) {
      failures.push(`${config.path}: command must be "${DIRECTOR_MCP_LAUNCH.command}"`);
    }
    if (!sameStringArray(entry.args, DIRECTOR_MCP_LAUNCH.args)) {
      failures.push(`${config.path}: args must be ${JSON.stringify(DIRECTOR_MCP_LAUNCH.args)}`);
    }
    if (entry.env?.STAGE_GATEWAY_URL !== DIRECTOR_MCP_LAUNCH.env.STAGE_GATEWAY_URL) {
      failures.push(`${config.path}: env.STAGE_GATEWAY_URL must be ${DIRECTOR_MCP_LAUNCH.env.STAGE_GATEWAY_URL}`);
    }
  }
}

export function checkAgentIntegrations(rootDir = process.cwd()) {
  const failures = [];
  const agentsAbsolute = resolve(rootDir, "AGENTS.md");
  if (!existsSync(agentsAbsolute)) {
    failures.push("AGENTS.md: missing agent instruction file");
  } else if (!readFileSync(agentsAbsolute, "utf8").includes(CANONICAL_SKILL_FILE)) {
    failures.push(`AGENTS.md: must reference ${CANONICAL_SKILL_FILE}`);
  }
  checkGeneratedAdapters(rootDir, failures);
  checkLaunchShape(rootDir, failures);
  return failures;
}
