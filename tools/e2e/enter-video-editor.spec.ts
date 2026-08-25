import { expect, test } from "@playwright/test";
import { prepareCleanStorage, timelineClips, timelineRegion } from "./helpers";

test.describe("进入视频编辑器", () => {
  test("从首页通过工作区标签进入,看到空时间线", async ({ page }) => {
    await prepareCleanStorage(page);
    await page.goto("/");

    // 默认工作区是 3D 片场,首次加载包含 3D 场景初始化,给足超时。
    const videoTab = page.getByRole("tab", { name: "视频编辑器" });
    await expect(videoTab).toBeVisible({ timeout: 60_000 });
    await videoTab.click();

    await expect(timelineRegion(page)).toBeVisible({ timeout: 60_000 });
    await expect(timelineClips(page)).toHaveCount(0);
  });
});
