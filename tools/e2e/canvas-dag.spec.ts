import { expect, test, type Page } from "@playwright/test";
import { prepareCleanStorage } from "./helpers";

/**
 * Canvas production-DAG journey: add nodes, auto-layout the dependency graph,
 * connect two nodes into an edge, delete the edge, and undo. Board state lives
 * in browser storage only, so no gateway is required.
 */

const boardNodes = (page: Page) => page.locator("article.creative-board-node");
const boardEdges = (page: Page) => page.locator("g.creative-board-edge");

async function openCanvas(page: Page) {
  await prepareCleanStorage(page);
  await page.goto("/?workspace=canvas");
  await expect(page.getByRole("main", { name: "画布工作区" })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("toolbar", { name: "画布操作" })).toBeVisible();
}

test.describe("画布依赖图", () => {
  test("添加便签、自动排列并连接为依赖图", async ({ page }) => {
    await openCanvas(page);
    await expect(boardNodes(page)).toHaveCount(0);

    // Two sticky notes are created at the board center and overlap; the
    // auto-layout pass separates them into dependency levels.
    await page.getByRole("button", { name: "添加便签" }).click();
    await page.getByRole("button", { name: "添加便签" }).click();
    await expect(boardNodes(page)).toHaveCount(2);

    await page.getByRole("button", { name: "自动排列依赖图" }).click();
    await expect(page.getByRole("status")).toContainText("依赖图已排列");

    // Connect note 1 -> note 2 with the connect tool.
    await page.getByRole("button", { name: "连接节点" }).click();
    await boardNodes(page).nth(0).click();
    await expect(page.getByText("选择另一个节点完成连接，Esc 取消")).toBeVisible();
    await boardNodes(page).nth(1).click();
    await expect(page.getByRole("status")).toContainText("依赖连接已创建");
    await expect(boardEdges(page)).toHaveCount(1);

    // A cycle must be rejected: connecting 2 -> 1 would close a loop.
    await boardNodes(page).nth(1).click();
    await boardNodes(page).nth(0).click();
    await expect(page.getByRole("alert")).toContainText("无法连接");
    await expect(boardEdges(page)).toHaveCount(1);
  });

  test("删除依赖连接后可撤销恢复", async ({ page }) => {
    await openCanvas(page);

    await page.getByRole("button", { name: "添加便签" }).click();
    await page.getByRole("button", { name: "添加便签" }).click();
    await page.getByRole("button", { name: "自动排列依赖图" }).click();
    await expect(page.getByRole("status")).toContainText("依赖图已排列");

    await page.getByRole("button", { name: "连接节点" }).click();
    await boardNodes(page).nth(0).click();
    await boardNodes(page).nth(1).click();
    await expect(boardEdges(page)).toHaveCount(1);

    // Clicking an edge removes it; undo restores it.
    await page.getByRole("button", { name: "选择" }).click();
    await boardEdges(page).first().click();
    await expect(boardEdges(page)).toHaveCount(0);

    await page.getByRole("button", { name: "撤销" }).click();
    await expect(boardEdges(page)).toHaveCount(1);
  });
});
