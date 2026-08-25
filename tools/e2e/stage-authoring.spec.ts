import { expect, test, type Page } from "@playwright/test";
import { prepareCleanStorage, UNDO_MODIFIER } from "./helpers";

/**
 * Stage authoring journey: rename, duplicate, and undo scene objects through
 * the object tree. Runs against the gateway-less e2e Vite server, so the
 * minimal boot project (角色01 + 机位01) is deterministic.
 */

const objectTree = (page: Page) => page.getByRole("tree", { name: "场景对象列表" });

async function openStage(page: Page) {
  await prepareCleanStorage(page);
  await page.goto("/?workspace=stage");
  // First load compiles the 3D stage chunk in dev mode; give it headroom.
  await expect(objectTree(page)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("treeitem", { name: "角色01" })).toBeVisible({ timeout: 30_000 });
}

test.describe("3D 片场对象编辑", () => {
  test("重命名对象并撤销", async ({ page }) => {
    await openStage(page);

    await page.getByRole("button", { name: "重命名 角色01" }).click();
    const nameInput = page.getByRole("textbox", { name: "编辑 角色01 名称" });
    await expect(nameInput).toBeVisible();
    await nameInput.fill("主角甲");
    await nameInput.press("Enter");

    await expect(page.getByRole("treeitem", { name: "主角甲" })).toBeVisible();
    await expect(page.getByRole("treeitem", { name: "角色01" })).toHaveCount(0);

    await page.keyboard.press(`${UNDO_MODIFIER}+KeyZ`);
    await expect(page.getByRole("treeitem", { name: "角色01" })).toBeVisible();
    await expect(page.getByRole("treeitem", { name: "主角甲" })).toHaveCount(0);
  });

  test("复制粘贴对象并撤销", async ({ page }) => {
    await openStage(page);

    // Select the default character, then duplicate it via clipboard shortcuts
    // (handled by the app shell in the stage workspace).
    const character = page.getByRole("treeitem", { name: "角色01" });
    await character.click();
    await expect(character).toHaveAttribute("aria-selected", "true");

    await page.keyboard.press(`${UNDO_MODIFIER}+KeyC`);
    await page.keyboard.press(`${UNDO_MODIFIER}+KeyV`);
    // Pasted characters are renamed sequentially (角色02), never duplicated names.
    await expect(page.getByRole("treeitem", { name: "角色02" })).toBeVisible();

    await page.keyboard.press(`${UNDO_MODIFIER}+KeyZ`);
    await expect(page.getByRole("treeitem", { name: "角色02" })).toHaveCount(0);
    await expect(page.getByRole("treeitem", { name: "角色01" })).toBeVisible();
  });
});
