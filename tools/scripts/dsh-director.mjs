#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const dshRoot = resolve(repositoryRoot, "vendor/deepseek-harness");
const overlayDir = resolve(dshRoot, ".director");
const pluginPath = resolve(overlayDir, "plugin.mjs");
const patchPath = resolve(overlayDir, "cordis.yml");
const dshVersion = "0.1.0-rc.6";

function git(args, cwd = repositoryRoot) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

if (!existsSync(resolve(dshRoot, "package.json"))) {
  git(["submodule", "update", "--init", "--depth", "1", "vendor/deepseek-harness"]);
}
mkdirSync(overlayDir, { recursive: true });
execFileSync(
  resolve(repositoryRoot, "node_modules/.bin/esbuild"),
  [
    resolve(repositoryRoot, "packages/dsh-plugin-workbench/src/cordis.ts"),
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--target=node22",
    `--outfile=${pluginPath}`,
  ],
  { cwd: repositoryRoot, stdio: "inherit" },
);

writeFileSync(
  patchPath,
  `- insert:
    - id: director-workbench
      name: ${JSON.stringify(pluginPath)}
`,
);

console.log(`DeepSeek Harness overlay written to ${overlayDir}`);
if (process.argv.includes("--prepare-only")) process.exit(0);

console.log(`Starting Director DeepSeek Harness ${dshVersion} at http://127.0.0.1:3080`);
const launched = spawnSync(
  "pnpm",
  [`--package=@deepseek-ai/dsh@${dshVersion}`, "dlx", "dsh", "web", "--patch", patchPath],
  { cwd: repositoryRoot, stdio: "inherit" },
);
if (launched.error) throw launched.error;
if (launched.signal) process.kill(process.pid, launched.signal);
process.exit(launched.status ?? 0);
