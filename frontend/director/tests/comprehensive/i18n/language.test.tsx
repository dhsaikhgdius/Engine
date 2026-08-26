import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { LanguageProvider, translateString, useLanguage } from "../../../src/comprehensive/i18n/language";

function Probe() {
  const { locale, setLocale, t } = useLanguage();
  return (
    <div>
      <span data-testid="translated-scene">{t("场景")}</span>
      <span aria-label="场景对象列表">场景对象列表</span>
      <span aria-label="场景" data-i18n-user-content>
        场景
      </span>
      <span aria-label="角色" data-i18n-preserve-attributes>
        角色
      </span>
      <span aria-valuetext="第 24 帧，1.000 秒" role="slider" />
      <button onClick={() => setLocale(locale === "zh-CN" ? "en-US" : "zh-CN")} type="button">
        {locale}
      </button>
    </div>
  );
}

afterEach(() => {
  window.localStorage.clear();
  document.documentElement.lang = "";
  document.documentElement.removeAttribute("data-locale");
});

it("translates direct and dynamic UI phrases", () => {
  expect(translateString("场景", "en-US")).toBe("Scene");
  expect(translateString("收起 角色 分组", "en-US")).toBe("Collapse Characters group");
  expect(translateString("调整模型缩略图大小", "en-US")).toBe("Adjust model thumbnail size");
  expect(translateString("常驻四视图", "en-US")).toBe("Persistent quad view");
  expect(translateString("导出确定性 IN/OUT 帧包", "en-US")).toBe("Export deterministic IN/OUT frame package");
  expect(translateString("IK 目标 X", "en-US")).toBe("IK target X");
  expect(translateString("角色位置 X", "en-US")).toBe("Character position X");
  expect(translateString("相机旋转 Y", "en-US")).toBe("Camera rotation Y");
  expect(translateString("高级光学", "en-US")).toBe("Advanced optics");
  expect(translateString("相机变形宽银幕挤压", "en-US")).toBe("Camera anamorphic squeeze");
  expect(translateString("剖切平面", "en-US")).toBe("Clipping planes");
  expect(translateString("全局剖切会进入项目、Agent 快照与最终渲染。", "en-US")).toBe(
    "Global clipping is included in the project, Agent snapshots, and final renders.",
  );
  expect(translateString("添加剖切平面", "en-US")).toBe("Add clipping plane");
  expect(translateString("姿势预设", "en-US")).toBe("Pose presets");
  expect(translateString("招手", "en-US")).toBe("Wave");
  expect(translateString("左肩 · 外展 滑杆", "en-US")).toBe("Left shoulder · Spread slider");
  expect(translateString("收起 我的模型分组", "en-US")).toBe("Collapse My models group");
  expect(translateString("展开 我的模型分组", "en-US")).toBe("Expand My models group");
  expect(translateString("切换到 Z 反向视图", "en-US")).toBe("Switch to Z negative view");
  expect(translateString("确定性渲染 F12 · 50%", "en-US")).toBe("Deterministic render F12 · 50%");
  expect(translateString("角色01", "en-US")).toBe("Character 01");
  expect(translateString("机位01", "en-US")).toBe("Camera 01");
  expect(translateString("机位01-截图01", "en-US")).toBe("Camera 01-Capture 01");
  expect(translateString("角色01（2）", "en-US")).toBe("Character 01 (2)");
  expect(translateString("镜头 A 已导出为确定性 PNG 帧包（24 帧 · SHA abc123）", "en-US")).toBe(
    "镜头 A exported as a deterministic PNG frame package (24 frames · SHA abc123)",
  );
  expect(translateString("镜头 A 已按确定性时间戳导出（F1–F24）", "en-US")).toBe(
    "镜头 A exported with deterministic timestamps (F1–F24)",
  );
  expect(translateString("性能 高清", "en-US")).toBe("Performance High quality");
  expect(translateString("左肩 · 外展", "en-US")).toBe("Left shoulder · Spread");
  expect(translateString("重新启动 Codex", "en-US")).toBe("Restart Codex");
  expect(translateString("高级编辑", "en-US")).toBe("Advanced editing");
  expect(translateString("0 个选中", "en-US")).toBe("0 selected");
  expect(translateString("场景工具", "en-US")).toBe("Scene tools");
  expect(translateString("已重置 2 个对象变换", "en-US")).toBe("Reset transforms for 2 objects");
  expect(translateString("对象枢轴 X", "en-US")).toBe("Object pivot X");
  expect(translateString("高级编辑轴", "en-US")).toBe("Advanced editing axis");
  expect(translateString("对象图层列表", "en-US")).toBe("Object layer list");
  expect(translateString("隐藏图层 default", "en-US")).toBe("Hide layer default");
  expect(translateString("锁定图层 default", "en-US")).toBe("Lock layer default");
  expect(translateString("打开 Central boulevard lane marking 列表操作", "en-US")).toBe(
    "Open Central boulevard lane marking list actions",
  );
  expect(translateString("删除整条轨迹", "en-US")).toBe("Delete trajectory");
  expect(translateString("路径弯折", "en-US")).toBe("Path handles");
  expect(translateString("只改快慢，不改路线。左下是这一帧，右上是下一帧。", "en-US")).toBe(
    "Changes speed, not the route. Bottom-left is this frame; top-right is the next.",
  );
  expect(translateString("轨迹入点偏移 X", "en-US")).toBe("Path arrive handle X");
  expect(translateString("关键帧 1，第 0 帧", "en-US")).toBe("Keyframe 1, frame 0");
  expect(translateString("机位01 已有轨道", "en-US")).toBe("Camera 01 has a track");
  expect(translateString("几何对象", "en-US")).toBe("Geometry");
  expect(translateString("几何对象右侧属性面板", "en-US")).toBe("Geometry properties panel");
  expect(translateString("圆周运动", "en-US")).toBe("Circular");
  expect(translateString("覆盖 0–287 帧，可继续编辑关键帧", "en-US")).toBe(
    "Covers frames 0–287; keyframes stay editable",
  );
  expect(translateString("数据选项", "en-US")).toBe("Data options");
  expect(translateString("背景与全景", "en-US")).toBe("Background & panorama");
  expect(translateString("环境旋转 Y 拖动调整", "en-US")).toBe("Environment rotation Y drag control");
  expect(translateString("第 120 帧，时间码 00:00:05:00", "en-US")).toBe("Frame 120, timecode 00:00:05:00");
  expect(translateString(" · 未安装", "en-US")).toBe(" · Not installed");
  expect(translateString("删除宏“Lighting”？", "en-US")).toBe("Delete macro “Lighting”?");
  expect(translateString("宏“Lighting”已执行，可撤销", "en-US")).toBe("Ran macro “Lighting”; undo is available");
  expect(translateString("排队中 · 前方 2 项", "en-US")).toBe("Queued · 2 ahead");
  expect(translateString("Session 状态：已完成", "en-US")).toBe("Session status: Completed");
  expect(translateString("会话 dsh-abc123 · 活跃", "en-US")).toBe("Session dsh-abc123 · Active");
  expect(translateString("会话 dsh-abc123 · 空闲", "en-US")).toBe("Session dsh-abc123 · Idle");
  expect(translateString("正在观察场景", "en-US")).toBe("Observing the scene");
  expect(translateString("正在修改 12 个物体", "en-US")).toBe("Authoring 12 objects");
  expect(translateString("已截取画面", "en-US")).toBe("Captured a frame");
  expect(translateString("prop-lamp、prop-chair 等 12 个", "en-US")).toBe("prop-lamp、prop-chair · 12 total");
  expect(translateString("画面保留，但场景已过期", "en-US")).toBe("Frame kept, but the scene is stale");
  expect(translateString("已保存 场景检查点", "en-US")).toBe("Saved Scene checkpoint");
  expect(translateString("已保存 场景检查点（仅 Director 项目）", "en-US")).toBe(
    "Saved Scene checkpoint (Director project only)",
  );
  expect(translateString("已保存 Turn 前自动检查点（仅 Director 项目）", "en-US")).toBe(
    "Saved Automatic pre-turn checkpoint (Director project only)",
  );
  expect(translateString("Codex 当前不可用，请选择已安装的 Agent", "en-US")).toBe(
    "Codex is unavailable; select an installed agent",
  );
  expect(translateString("2/5 个节点完成 · 第 2/3 层", "en-US")).toBe("2/5 nodes complete · Layer 2/3");
  expect(translateString("渲染镜头 · 第 6/8 阶段", "en-US")).toBe("Shot rendering · Stage 6/8");
  expect(translateString("生产运行完成：雨夜电车", "en-US")).toBe("Production run completed: 雨夜电车");
  expect(translateString("电影管线已完成全部阶段。", "en-US")).toBe("Film pipeline completed all stages.");
  expect(translateString("场景", "zh-CN")).toBe("场景");
});

it("switches the rendered UI and restores Chinese source text", async () => {
  const user = userEvent.setup();
  render(
    <LanguageProvider>
      <Probe />
    </LanguageProvider>,
  );

  expect(screen.getByTestId("translated-scene")).toHaveTextContent("场景");
  await user.click(screen.getByRole("button", { name: "zh-CN" }));
  expect(screen.getByTestId("translated-scene")).toHaveTextContent("Scene");
  expect(screen.getByLabelText("Scene object list")).toBeInTheDocument();
  expect(screen.getByLabelText("场景")).toHaveTextContent("场景");
  expect(screen.getByLabelText("角色")).toHaveTextContent("Characters");
  expect(screen.getByRole("slider")).toHaveAttribute("aria-valuetext", "Frame 24, 1.000 seconds");
  expect(document.documentElement.lang).toBe("en-US");

  await user.click(screen.getByRole("button", { name: "en-US" }));
  expect(screen.getByTestId("translated-scene")).toHaveTextContent("场景");
  expect(screen.getByLabelText("场景对象列表")).toBeInTheDocument();
  expect(document.documentElement.lang).toBe("zh-CN");
});
