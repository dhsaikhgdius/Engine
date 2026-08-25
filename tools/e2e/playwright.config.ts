import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

/**
 * Director video-editor smoke suite (`tools/e2e/playwright.config.ts`).
 *
 * Lives next to the specs. Invoke via `npm run test:e2e` or
 * `npx playwright test --config tools/e2e/playwright.config.ts`. Playwright
 * does not auto-discover this file from the repo root.
 *
 * The app under test is the pure-frontend Vite dev server (`npm run dev:ui`);
 * the video editor persists to browser storage only, so no gateway/backend is
 * required. A dedicated port (5178, injected via DIRECTOR_UI_PORT) keeps the
 * suite from colliding with a developer's own `npm run dev` on 5175.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const E2E_PORT = Number(process.env.DIRECTOR_E2E_PORT ?? 5178);
const BASE_URL = `http://127.0.0.1:${E2E_PORT}`;

/**
 * The render-golden suite compares WebGL pixels, so it runs against its own
 * frozen server (tools/e2e/vite.config.golden.ts: watching and HMR disabled) —
 * repository edits during a run must never reload the page mid-comparison.
 */
const GOLDEN_PORT = Number(process.env.DIRECTOR_GOLDEN_PORT ?? 5179);
const GOLDEN_BASE_URL = `http://127.0.0.1:${GOLDEN_PORT}`;
const GOLDEN_SPEC = /render-golden\.spec\.ts/;

export default defineConfig({
  testDir: ".",
  outputDir: resolve(repoRoot, "test-results"),
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  // First load compiles the 3D stage + video editor chunks in dev mode.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never", outputFolder: resolve(repoRoot, "playwright-report") }]]
    : [["list"]],
  use: {
    baseURL: BASE_URL,
    headless: true,
    trace: "retain-on-failure",
    viewport: { width: 1440, height: 900 },
    // The UI honors prefers-reduced-motion; use it to cut animation flake.
    contextOptions: { reducedMotion: "reduce" },
  },
  projects: [
    {
      name: "chromium",
      testIgnore: GOLDEN_SPEC,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "chromium-golden",
      testMatch: GOLDEN_SPEC,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        baseURL: GOLDEN_BASE_URL,
      },
    },
  ],
  webServer: [
    {
      // Same dev server as `npm run dev:ui`, but with an isolated Vite dep
      // cache so a concurrently running `npm run dev` cannot trigger
      // mid-test full reloads (see tools/e2e/vite.config.e2e.ts).
      command: "npx vite --config tools/e2e/vite.config.e2e.ts --host 127.0.0.1",
      cwd: repoRoot,
      url: BASE_URL,
      env: { DIRECTOR_UI_PORT: String(E2E_PORT) },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      // Frozen server for pixel goldens: no file watching, no HMR.
      command: "npx vite --config tools/e2e/vite.config.golden.ts --host 127.0.0.1",
      cwd: repoRoot,
      url: GOLDEN_BASE_URL,
      env: { DIRECTOR_UI_PORT: String(GOLDEN_PORT) },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
