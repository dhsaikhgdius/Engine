import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vite";
import baseConfig from "../vite.config";

/**
 * Render-golden Vite config: a frozen server for pixel comparisons.
 *
 * File watching and HMR are disabled so edits landing in the repository while
 * the golden suite runs (parallel agents, a developer's editor) can never
 * trigger a mid-test full-page reload — the suite compares pixels, and a
 * reload both detaches locators and re-races asset loading. The dependency
 * cache is separate from dev and e2e instances for the same reason as
 * `tools/e2e/vite.config.e2e.ts`. Merges `tools/vite.config.ts`.
 */
const worldEngineRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));

export default mergeConfig(
  baseConfig,
  defineConfig({
    cacheDir: resolve(worldEngineRoot, "node_modules/.vite/director-golden"),
    server: {
      hmr: false,
      watch: null,
    },
  }),
);
