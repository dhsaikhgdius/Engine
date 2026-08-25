import { expect, test, type Page } from "@playwright/test";
import { FIXTURE_PNG_NAME, FIXTURE_PNG_PATH, prepareCleanStorage } from "./helpers";

/**
 * Gallery / media-library journey in the Canvas workspace: import an asset,
 * verify it registers as a media card plus a board node, then exercise
 * search, collection filters, and the clear-filters empty state.
 */

const mediaBrowser = (page: Page) => page.locator("section.creative-media-browser");
const mediaCard = (page: Page) => mediaBrowser(page).getByRole("listitem").filter({ hasText: FIXTURE_PNG_NAME });

async function openCanvasWithFixture(page: Page) {
  await prepareCleanStorage(page);
  await page.goto("/?workspace=canvas");
  await expect(page.getByRole("main", { name: "画布工作区" })).toBeVisible({ timeout: 60_000 });
  await mediaBrowser(page).locator('input[type="file"][aria-label="导入素材"]').setInputFiles(FIXTURE_PNG_PATH);
  await expect(mediaCard(page)).toBeVisible({ timeout: 20_000 });
}

test.describe("素材库与画廊", () => {
  test("导入素材出现在素材库并生成画布节点", async ({ page }) => {
    await openCanvasWithFixture(page);

    // Canvas imports register the asset and drop a matching image node.
    const importedNode = page.locator("article.creative-board-node.is-image").filter({ hasText: FIXTURE_PNG_NAME });
    await expect(importedNode).toHaveCount(1);
    await expect(importedNode.locator("img")).toBeVisible();
  });

  test("搜索与分类筛选，清除筛选可恢复", async ({ page }) => {
    await openCanvasWithFixture(page);
    const search = page.getByRole("searchbox", { name: "搜索素材" });

    // Positive search keeps the card; a miss shows the empty state.
    await search.fill(FIXTURE_PNG_NAME);
    await expect(mediaCard(page)).toBeVisible();
    await search.fill("绝不存在的素材名称");
    await expect(mediaCard(page)).toHaveCount(0);
    await expect(mediaBrowser(page).getByText("没有匹配的素材")).toBeVisible();

    await mediaBrowser(page).getByRole("button", { name: "清除筛选" }).click();
    await expect(mediaCard(page)).toBeVisible();

    // Imported assets live in the 导入 collection; 分镜 must filter them out.
    await mediaBrowser(page).getByRole("tab", { name: "导入" }).click();
    await expect(mediaCard(page)).toBeVisible();
    await mediaBrowser(page).getByRole("tab", { name: "分镜" }).click();
    await expect(mediaCard(page)).toHaveCount(0);
    await mediaBrowser(page).getByRole("tab", { name: "全部" }).click();
    await expect(mediaCard(page)).toBeVisible();
  });
});
