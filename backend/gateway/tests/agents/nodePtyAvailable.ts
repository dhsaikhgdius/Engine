import { createRequire } from "node:module";

/**
 * True when the node-pty native addon loaded. Local checkouts without a
 * native toolchain may skip the gateway spawn integration tests, but CI must
 * never skip them silently: the workflow runs `npm rebuild node-pty` after
 * `npm ci --ignore-scripts`, so a load failure there is a broken pipeline.
 */
export function nodePtyNativeModuleAvailable(): boolean {
  try {
    createRequire(import.meta.url)("node-pty");
    return true;
  } catch (error) {
    if (process.env.CI) {
      throw new Error(
        "The node-pty native addon failed to load in CI; run `npm rebuild node-pty` after `npm ci --ignore-scripts` so the gateway integration tests run instead of skipping.",
        { cause: error },
      );
    }
    return false;
  }
}
