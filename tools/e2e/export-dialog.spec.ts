import { expect, test } from "@playwright/test";
import { addCardToTimeline, importFixtureImage, openVideoEditor, timelineClips } from "./helpers";

test.describe("导出弹窗", () => {
  test("打开导出对话框看到输出摘要,Escape 关闭", async ({ page }) => {
    await openVideoEditor(page);
    const card = await importFixtureImage(page);
    // 时间线为空时导出按钮禁用,先加一个剪辑。
    await addCardToTimeline(page, card);
    await expect(timelineClips(page)).toHaveCount(1);

    await page.getByRole("button", { name: "导出视频" }).click();

    const dialog = page.getByRole("dialog", { name: "导出时间线视频" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("输出尺寸")).toBeVisible();
    await expect(dialog.getByText("内容时长")).toBeVisible();

    // 不真正执行导出(headless 编码不稳定),Escape 直接关闭。
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });
});
