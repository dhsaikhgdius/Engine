import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vite";
import baseConfig from "../vite.config";

/**
 * E2E-only Vite config: identical to `tools/vite.config.ts` except for a dedicated
 * dependency cache. Sharing node_modules/.vite/director with a developer's
 * long-running `npm run dev` causes cross-instance re-optimization races,
 * which surface as full-page reloads in the middle of a test.
 */
const worldEngineRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));

export default mergeConfig(
  baseConfig,
  defineConfig({
    cacheDir: resolve(worldEngineRoot, "node_modules/.vite/director-e2e"),
  }),
);
