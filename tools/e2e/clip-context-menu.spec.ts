import { expect, test } from "@playwright/test";
import { addCardToTimeline, importFixtureImage, openVideoEditor, timelineClips } from "./helpers";

test.describe("剪辑右键菜单", () => {
  test("右键打开菜单并删除剪辑", async ({ page }) => {
    await openVideoEditor(page);
    const card = await importFixtureImage(page);
    await addCardToTimeline(page, card);
    await expect(timelineClips(page)).toHaveCount(1);

    await timelineClips(page).first().click({ button: "right" });

    const menu = page.getByRole("menu", { name: "剪辑菜单" });
    await expect(menu).toBeVisible();
    // "波纹删除" also contains 删除, so anchor the plain delete item exactly.
    await menu.getByRole("menuitem", { name: /^删除/ }).click();

    await expect(timelineClips(page)).toHaveCount(0);
  });
});
