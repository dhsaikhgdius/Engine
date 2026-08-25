import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const BLENDER_OPERATION_MANIFEST_SOURCE = "packages/protocol/src/blenderOperationManifest.json";
export const BLENDER_OPERATION_MANIFEST_TARGET =
  "integrations/blender/live/addons/worldengine_studio/blenderOperationManifest.json";

export function checkBlenderOperationManifest(rootDir = process.cwd()) {
  const source = resolve(rootDir, BLENDER_OPERATION_MANIFEST_SOURCE);
  const target = resolve(rootDir, BLENDER_OPERATION_MANIFEST_TARGET);
  if (!existsSync(target)) return [`${BLENDER_OPERATION_MANIFEST_TARGET}: missing generated copy`];
  return readFileSync(source).equals(readFileSync(target))
    ? []
    : [`${BLENDER_OPERATION_MANIFEST_TARGET}: run npm run sync:blender-operations`];
}

export function syncBlenderOperationManifest(rootDir = process.cwd()) {
  writeFileSync(
    resolve(rootDir, BLENDER_OPERATION_MANIFEST_TARGET),
    readFileSync(resolve(rootDir, BLENDER_OPERATION_MANIFEST_SOURCE)),
  );
}

const isDirectExecution = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isDirectExecution) {
  if (process.argv.includes("--check")) {
    const failures = checkBlenderOperationManifest();
    if (failures.length) {
      failures.forEach((failure) => console.error(failure));
      process.exitCode = 1;
    } else {
      console.log("Blender operation manifest is synchronized.");
    }
  } else {
    syncBlenderOperationManifest();
    console.log(`Updated ${BLENDER_OPERATION_MANIFEST_TARGET}.`);
  }
}
