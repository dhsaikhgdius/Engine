import { expect, test } from "@playwright/test";
import {
  addCardToTimeline,
  cssLeftPx,
  importFixtureImage,
  openVideoEditor,
  playhead,
  scrubRulerAt,
  timelineClips,
  UNDO_MODIFIER,
} from "./helpers";

// 默认缩放下时间线为 72px/秒;图片剪辑默认 3 秒(216px 宽)。
const PX_PER_SEC = 72;

test.describe("时间线基本编辑", () => {
  test("拖动剪辑、刮擦标尺、S 分割、撤销", async ({ page }) => {
    await openVideoEditor(page);
    const card = await importFixtureImage(page);

    // 第一个剪辑落在 0s(播放头初始位置)。
    await addCardToTimeline(page, card);
    await expect(timelineClips(page)).toHaveCount(1);

    // 播放头移到 4s,再添加第二个剪辑,避免两个剪辑重叠。
    await scrubRulerAt(page, 4 * PX_PER_SEC);
    await addCardToTimeline(page, card);
    await expect(timelineClips(page)).toHaveCount(2);

    const secondClip = timelineClips(page).nth(1);
    const startLeft = await cssLeftPx(secondClip);
    expect(startLeft).toBeGreaterThan(PX_PER_SEC * 3.5);

    // 拖动第二个剪辑向右约 120px(超过 4px 拖动阈值)。
    const clipBox = await secondClip.boundingBox();
    if (!clipBox) throw new Error("剪辑不可见");
    const grabX = clipBox.x + clipBox.width / 2;
    const grabY = clipBox.y + clipBox.height / 2;
    await page.mouse.move(grabX, grabY);
    await page.mouse.down();
    await page.mouse.move(grabX + 60, grabY, { steps: 4 });
    await page.mouse.move(grabX + 120, grabY, { steps: 4 });
    await page.mouse.up();

    const movedLeft = await cssLeftPx(secondClip);
    expect(movedLeft).toBeGreaterThan(startLeft + 60);

    // 刮擦标尺:播放头应跟随指针落点(帧对齐允许少量偏差)。
    const scrubTargetPx = movedLeft + PX_PER_SEC; // 剪辑起点后 1s,落在剪辑内部
    await scrubRulerAt(page, scrubTargetPx);
    const playheadLeft = await cssLeftPx(playhead(page));
    expect(Math.abs(playheadLeft - scrubTargetPx)).toBeLessThan(12);

    // 拖动结束后剪辑保持选中,播放头在剪辑内部,按 S 在播放头处分割。
    await page.keyboard.press("s");
    await expect(timelineClips(page)).toHaveCount(3);

    // Ctrl/⌘+Z 撤销分割。
    await page.keyboard.press(`${UNDO_MODIFIER}+z`);
    await expect(timelineClips(page)).toHaveCount(2);
  });
});
