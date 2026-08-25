/**
 * Vitest runner configuration (`tools/vitest.config.ts`).
 *
 * Lives under `tools/`. Invoke via `npm test` or
 * `npx vitest run --config tools/vitest.config.ts <path>`. Vitest does not
 * auto-discover this file from the repo root.
 *
 * `root` is the repository so frontend, gateway, and package tests collect
 * together. Uses jsdom with thread-pool isolation. Excludes `tools/e2e/`
 * (Playwright), `.external/` (vendored trees), `.runtime/` (generated
 * worktrees), and `vendor/`.
 *
 * @module vitest.config
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

/** Repository root resolved from this config file's location. */
const configDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(configDirectory, "..");

export default defineConfig({
  root: projectRoot,
  test: {
    environment: "jsdom",
    globals: true,
    pool: "threads",
    testTimeout: 10_000,
    setupFiles: resolve(configDirectory, "vitest.setup.ts"),
    // `tools/e2e/` holds Playwright specs (`npm run test:e2e`); they import
    // @playwright/test and cannot run under the vitest runner. `.runtime/`
    // holds generated trees (including agent worktrees) that must never be
    // collected as this checkout's tests.
    exclude: [...configDefaults.exclude, ".external/**", "tools/e2e/**", ".runtime/**", "vendor/**"],
  },
});
