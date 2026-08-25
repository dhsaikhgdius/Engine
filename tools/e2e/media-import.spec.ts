import { expect, test } from "@playwright/test";
import { addCardToTimeline, importFixtureImage, openVideoEditor, timelineClips } from "./helpers";

test.describe("导入素材并加入时间线", () => {
  test("导入 PNG 后通过 + 按钮上轨,预览出现画面", async ({ page }) => {
    await openVideoEditor(page);

    const card = await importFixtureImage(page);
    await addCardToTimeline(page, card);

    await expect(timelineClips(page)).toHaveCount(1);
    // 播放头落在新剪辑起点上,预览区应渲染出真实图片。
    await expect(page.locator(".creative-preview-shell img").first()).toBeVisible();
  });
});
