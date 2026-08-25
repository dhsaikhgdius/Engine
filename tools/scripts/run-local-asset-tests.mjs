import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const cliArguments = process.argv.slice(2);
// --check-assets: report asset availability only (exit 0 when complete, 2 when
// incomplete) without running vitest. Used by CI to decide between run and skip.
const checkAssetsOnly = cliArguments.includes("--check-assets");
const vitestArguments = cliArguments.filter((argument) => argument !== "--check-assets");
const assetTestFiles = [
  "backend/gateway/tests/dcc/gltfPrepare.test.ts",
  "frontend/director/tests/comprehensive/editor/modelLibrary/flickPublicCatalog.test.ts",
  "frontend/director/tests/comprehensive/editor/modelLibrary/mixamoCharacterCatalog.test.ts",
  "frontend/director/tests/comprehensive/editor/runtime/MixamoCharacterModel.test.tsx",
  "frontend/director/tests/comprehensive/editor/runtime/mixamo/mixamoCharacterPrepare.test.ts",
  "frontend/director/tests/comprehensive/editor/runtime/mixamo/mixamoCharacterRig.test.ts",
  "frontend/director/tests/comprehensive/editor/runtime/mixamo/mixamoFootLockRig.test.ts",
  "frontend/director/tests/comprehensive/editor/runtime/mixamo/mixamoMotion.test.ts",
  "packages/agent-engine/tests/characterMotionCatalog.test.ts",
];

const requiredFiles = new Map();

function requireFile(relativePath, bundle) {
  if (typeof relativePath !== "string" || relativePath.length === 0) return;
  requiredFiles.set(decodeURIComponent(relativePath.replace(/^\//, "")), bundle);
}

function readCatalog(relativePath, bundle) {
  requireFile(relativePath, `${bundle} metadata`);
  const absolutePath = resolve(projectRoot, relativePath);
  if (!existsSync(absolutePath)) return null;
  try {
    return JSON.parse(readFileSync(absolutePath, "utf8"));
  } catch (error) {
    console.error(`Cannot parse ${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}

requireFile("assets/library/models/storyai-open-mannequin.glb", "open mannequin");

const mixamoCharacters = readCatalog("assets/library/mixamo-characters/catalog.json", "Mixamo characters");
for (const item of mixamoCharacters?.items ?? []) {
  requireFile(`assets/library/${String(item.modelUrl).replace(/^\//, "")}`, "Mixamo characters");
  requireFile(`assets/library/${String(item.thumbnailUrl).replace(/^\//, "")}`, "Mixamo character previews");
}

const directorCharacters = readCatalog("assets/library/director-characters/catalog.json", "Director characters");
for (const item of directorCharacters?.items ?? []) {
  requireFile(`assets/library/${String(item.modelUrl).replace(/^\//, "")}`, "Director characters");
  requireFile(`assets/library/${String(item.thumbnailUrl).replace(/^\//, "")}`, "Director character previews");
}

const motions = readCatalog("assets/library/mixamo-animations/catalog.json", "Mixamo motions");
for (const item of motions?.items ?? []) {
  requireFile(`assets/library/${String(item.url).replace(/^\//, "")}`, "Mixamo motions");
}

const flickProps = readCatalog("assets/library/flick-stage-props/catalog.json", "local-only Stage props");
for (const item of flickProps?.items ?? []) {
  requireFile(`assets/library/flick-stage-props/${item.category}/${item.fileName}`, "local-only Stage props");
  requireFile(`assets/library/${String(item.thumbnailUrl).replace(/^\//, "")}`, "local-only Stage prop previews");
}

const missingByBundle = new Map();
for (const [relativePath, bundle] of requiredFiles) {
  const absolutePath = resolve(projectRoot, relativePath);
  let missing = !existsSync(absolutePath);
  if (!missing) {
    try {
      missing = !statSync(absolutePath).isFile() || statSync(absolutePath).size === 0;
    } catch {
      missing = true;
    }
  }
  if (!missing) continue;
  const paths = missingByBundle.get(bundle) ?? [];
  paths.push(relativePath);
  missingByBundle.set(bundle, paths);
}

if (missingByBundle.size > 0) {
  const total = [...missingByBundle.values()].reduce((sum, paths) => sum + paths.length, 0);
  console.error(`\nLocal asset acceptance tests cannot run: ${total} required file(s) are missing or empty.`);
  console.error("This is expected in a source-only GitHub checkout; `npm run test:core` does not require them.\n");
  for (const [bundle, paths] of missingByBundle) {
    console.error(`- ${bundle}: ${paths.length} missing`);
    for (const path of paths.slice(0, 5)) console.error(`    ${path}`);
    if (paths.length > 5) console.error(`    ... ${paths.length - 5} more`);
  }
  console.error("\nRestore redistributable assets with `npm run assets:install`, then provide local-only assets");
  console.error("according to docs/site/src/content/docs/development/open-source-assets.md.");
  console.error("Run `npm run assets:verify` before retrying `npm run test:assets`.\n");
  process.exit(2);
}

if (checkAssetsOnly) {
  console.log(`All ${requiredFiles.size} required local asset files are present; asset acceptance tests can run.`);
  process.exit(0);
}

const result = spawnSync(
  process.execPath,
  [
    resolve(projectRoot, "node_modules/vitest/vitest.mjs"),
    "run",
    "--config",
    resolve(projectRoot, "tools/vitest.config.ts"),
    ...assetTestFiles,
    ...vitestArguments,
  ],
  {
    cwd: projectRoot,
    env: { ...process.env, DIRECTOR_LOCAL_ASSET_TESTS: "1" },
    stdio: "inherit",
  },
);

if (result.error) throw result.error;
if (result.signal) {
  console.error(`Asset acceptance tests terminated by signal ${result.signal}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
