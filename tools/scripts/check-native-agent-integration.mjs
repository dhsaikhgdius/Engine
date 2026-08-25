import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import { checkAgentIntegrations } from "./agent-integrations.mjs";
import { activeSkillTargets, CANONICAL_SKILL_ROOT, checkSkillCopies } from "./sync-agent-skills.mjs";
import { checkBlenderOperationManifest } from "./sync-blender-operation-manifest.mjs";

const root = process.cwd();
const failures = [];

function assertRealDirectory(relativePath) {
  try {
    const stats = lstatSync(resolve(root, relativePath));
    if (!stats.isDirectory()) failures.push(`${relativePath}: expected a directory`);
    if (stats.isSymbolicLink()) failures.push(`${relativePath}: symlinks are not allowed`);
  } catch {
    failures.push(`${relativePath}: missing native skill directory`);
  }
}

for (const relativePath of [CANONICAL_SKILL_ROOT, ...activeSkillTargets(root)]) assertRealDirectory(relativePath);

failures.push(...checkSkillCopies(root));
failures.push(...checkAgentIntegrations(root));
failures.push(...checkBlenderOperationManifest(root));

if (failures.length > 0) {
  console.error("Native Agent integration check failed:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    "Native Agent integration passed: real skill directories, synchronized instructions, and coding-agent MCP configurations verified.",
  );
}
