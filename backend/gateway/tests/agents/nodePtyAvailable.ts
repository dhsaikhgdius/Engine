import { createRequire } from "node:module";

/**
 * True when the node-pty native addon loaded. GitHub `npm ci --ignore-scripts`
 * skips the node-pty rebuild, so gateway spawn integration tests must skip.
 */
export function nodePtyNativeModuleAvailable(): boolean {
  try {
    createRequire(import.meta.url)("node-pty");
    return true;
  } catch {
    return false;
  }
}
