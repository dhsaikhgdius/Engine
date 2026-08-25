import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { prepareCleanStorage } from "./helpers";

/**
 * Render-golden regression suite for the 3D stage.
 *
 * A pinned fixture project (exported via the interchange menu) is imported
 * before sampling, so goldens do not race the async demo loader and stay
 * meaningful even if the bundled demo evolves. Headless
 * Chromium renders through SwiftShader, so pixels are deterministic for a
 * pinned Playwright build on one machine class; the thresholds below absorb
 * antialiasing jitter, not real regressions.
 *
 * When a render change is intentional, refresh the goldens with:
 *   npx playwright test --config tools/e2e/playwright.config.ts tools/e2e/render-golden.spec.ts --update-snapshots
 */

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PROJECT_PATH = join(here, "fixtures", "render-golden-project.json");

/** 320x180 monitor: 400 px ≈ 0.7% — tight enough to catch a shading change. */
const MONITOR_DIFF = { maxDiffPixels: 400 };
const VIEWPORT_DIFF = { maxDiffPixelRatio: 0.01 };

/** Keep ids ASCII so snapshot filenames stay portable. */
const MONITOR_MODES = [
  { id: "previz", label: "白模" },
  { id: "rgb", label: "原彩" },
  { id: "depth", label: "深度" },
  { id: "normal", label: "法向" },
  { id: "objectid", label: "分割图" },
  { id: "mask", label: "蒙版" },
  { id: "wireframe", label: "线框" },
] as const;

async function openStageWithFixture(page: Page) {
  await prepareCleanStorage(page);
  await page.goto("/?workspace=stage");
  const monitor = page.locator(".camera-picture-in-picture");
  await expect(monitor).toBeVisible({ timeout: 60_000 });

  // The e2e Vite server runs without the gateway, so no demo project ever
  // replaces the minimal boot project; importing the fixture is race-free.
  await page.getByRole("button", { name: "交换" }).first().click();
  await page.locator('input[aria-label="选择交换文件"]').setInputFiles(FIXTURE_PROJECT_PATH);
  await expect(page.getByText("已替换当前 3D 工程")).toBeVisible({ timeout: 30_000 });
  // Escape closes the popover without racing the re-render that follows the
  // project swap (the close button briefly detaches mid-import).
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "关闭交换面板" })).toBeHidden({ timeout: 10_000 });

  // Character GLBs and texture uploads settle before pixels are stable.
  await page.waitForTimeout(6_000);
}

test.describe("stage render goldens", () => {
  // First visit compiles the 3D stage chunks in dev mode and the fixture
  // import loads character GLBs; both stretch well past the default budget.
  test.beforeEach(() => test.setTimeout(240_000));

  test("main viewport matches golden", async ({ page }) => {
    await openStageWithFixture(page);
    const canvas = page.locator(".director-stage-canvas canvas").first();
    expect(await canvas.screenshot()).toMatchSnapshot("stage-viewport.png", VIEWPORT_DIFF);
  });

  test("camera monitor modalities match goldens", async ({ page }) => {
    await openStageWithFixture(page);
    const monitor = page.locator(".camera-picture-in-picture");
    const modeGroup = page.getByRole("group", { name: "相机预览模态" });

    for (const mode of MONITOR_MODES) {
      await modeGroup.getByRole("button", { name: mode.label, exact: true }).click();
      // One 30 fps monitor refresh plus margin so the scissored region shows
      // the newly selected modality before we sample pixels.
      await page.waitForTimeout(900);
      expect(await monitor.screenshot()).toMatchSnapshot(`monitor-${mode.id}.png`, MONITOR_DIFF);
    }
  });
});
