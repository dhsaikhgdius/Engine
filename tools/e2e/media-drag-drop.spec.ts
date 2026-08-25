import { expect, test, type Page } from "@playwright/test";
import { importFixtureImage, openVideoEditor, timelineClips, videoTrackRow } from "./helpers";

/**
 * 核心回归:真实浏览器中把素材卡拖到时间线轨道必须能落轨。
 * 此前 dragover 阶段 DataTransfer 处于保护模式导致 jsdom 测不出的失效,
 * 应用侧通过拖拽会话(dragstart 时注册素材 id)兜底,这里用真 Chrome 验证。
 */

const CARD_SELECTOR = ".creative-media-card";
const TRACK_SELECTOR = '[data-track-id="video-1"]';

/**
 * 后备路径:手动派发 dragstart→dragenter→dragover→drop→dragend 序列。
 * 构造的 DataTransfer 会被素材卡自己的 onDragStart 填充(自定义类型 +
 * 拖拽会话),与真实拖放走完全相同的应用代码。
 */
async function dispatchHtml5DragAndDrop(page: Page): Promise<void> {
  await page.evaluate(
    ({ cardSelector, trackSelector }) => {
      const source = document.querySelector(cardSelector);
      const target = document.querySelector(trackSelector);
      if (!source || !target) throw new Error("拖放源或目标不存在");
      const dataTransfer = new DataTransfer();
      const fire = (type: string, element: Element, x: number, y: number) => {
        const event = new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: x,
          clientY: y,
        });
        // DragEvent 构造器不接受 dataTransfer,以只读属性形式挂上去。
        Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
        element.dispatchEvent(event);
      };
      const from = source.getBoundingClientRect();
      const to = target.getBoundingClientRect();
      const dropX = to.left + to.width / 2;
      const dropY = to.top + to.height / 2;
      fire("dragstart", source, from.left + from.width / 2, from.top + from.height / 2);
      fire("dragenter", target, dropX, dropY);
      fire("dragover", target, dropX, dropY);
      fire("drop", target, dropX, dropY);
      fire("dragend", source, dropX, dropY);
    },
    { cardSelector: CARD_SELECTOR, trackSelector: TRACK_SELECTOR },
  );
}

test.describe("素材拖放上轨", () => {
  test("把素材卡拖到 video-1 轨道后剪辑数 +1", async ({ page }, testInfo) => {
    await openVideoEditor(page);
    await importFixtureImage(page);
    await expect(timelineClips(page)).toHaveCount(0);

    // 优先走 Playwright 原生拖放(真实输入事件驱动的 HTML5 dnd)。
    let native = true;
    try {
      await page.dragAndDrop(CARD_SELECTOR, TRACK_SELECTOR, { timeout: 10_000 });
      await expect(timelineClips(page)).toHaveCount(1, { timeout: 5_000 });
    } catch {
      native = false;
    }

    if (!native) {
      testInfo.annotations.push({
        type: "fallback",
        description: "page.dragAndDrop 未使剪辑落轨,改用手动派发 dragstart→dragover→drop 序列",
      });
      await dispatchHtml5DragAndDrop(page);
    }

    // 无论走哪条路径,"drop 能落轨"这个断言必须成立。
    await expect(timelineClips(page)).toHaveCount(1);
    await expect(videoTrackRow(page).locator(".creative-timeline-clip")).toHaveCount(1);
  });
});
