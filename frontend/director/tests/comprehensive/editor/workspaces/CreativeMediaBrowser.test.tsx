import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type { DirectorMediaItem } from "../../../../src/comprehensive/editor/workspaces/directorMediaLibrary";
import {
  DIRECTOR_MEDIA_DRAG_TYPE,
  useDirectorCreativeWorkspaceStore,
} from "../../../../src/comprehensive/editor/workspaces/directorWorkspaceStore";
import { CreativeMediaBrowser } from "../../../../src/comprehensive/editor/workspaces/CreativeMediaBrowser";

const mediaItems: DirectorMediaItem[] = [
  {
    id: "capture:image-1",
    kind: "image",
    collection: "captures",
    name: "晨光构图",
    subtitle: "主机位 · 35 mm",
    thumbnailUrl: "data:image/png;base64,image-preview",
    sourceUrl: "data:image/png;base64,image-source",
    durationSec: 3,
    cameraId: "camera-1",
    frameStart: null,
    frameEnd: null,
  },
  {
    id: "recording:video-1",
    kind: "video",
    collection: "recordings",
    name: "环绕镜头",
    subtitle: "4.2s · MP4",
    thumbnailUrl: null,
    sourceUrl: "blob:video-preview",
    durationSec: 4.2,
    cameraId: null,
    frameStart: 0,
    frameEnd: 101,
  },
  {
    id: "import:audio-1",
    kind: "audio",
    collection: "imports",
    name: "旁白草稿",
    subtitle: "2.5s · audio/wav",
    thumbnailUrl: null,
    sourceUrl: "blob:audio-preview",
    durationSec: 2.5,
    cameraId: null,
    frameStart: null,
    frameEnd: null,
  },
];

beforeEach(() => {
  useDirectorCreativeWorkspaceStore.getState().resetCreativeWorkspaces();
});

function mediaDataTransfer(mediaId: string) {
  return {
    effectAllowed: "none",
    dropEffect: "none",
    types: [DIRECTOR_MEDIA_DRAG_TYPE, "text/plain"],
    setData: vi.fn(),
    getData: vi.fn((type: string) => (type === DIRECTOR_MEDIA_DRAG_TYPE ? mediaId : "")),
    setDragImage: vi.fn(),
  } as unknown as DataTransfer;
}

function cardFor(name: string) {
  const card = screen.getByText(name).closest("article");
  expect(card).not.toBeNull();
  return card as HTMLElement;
}

it("renders and filters image, video, and audio media classifications", async () => {
  const user = userEvent.setup();
  render(<CreativeMediaBrowser items={mediaItems} />);

  expect(screen.queryByText(/可用素材/)).not.toBeInTheDocument();
  expect(within(cardFor("晨光构图")).getByText("图片")).toBeInTheDocument();
  expect(cardFor("晨光构图").querySelector("img")).toHaveAttribute("src", "data:image/png;base64,image-preview");
  expect(within(cardFor("环绕镜头")).getByText("视频")).toBeInTheDocument();
  expect(within(cardFor("环绕镜头")).getByText("4.2s")).toBeInTheDocument();
  expect(cardFor("环绕镜头").querySelector("video")).toHaveAttribute("src", "blob:video-preview");
  expect(within(cardFor("旁白草稿")).getByText("音频")).toBeInTheDocument();
  expect(within(cardFor("旁白草稿")).getByText("2.5s")).toBeInTheDocument();

  await user.click(screen.getByRole("tab", { name: "截图" }));
  expect(screen.getByText("晨光构图")).toBeInTheDocument();
  expect(screen.queryByText("环绕镜头")).not.toBeInTheDocument();
  expect(screen.queryByText("旁白草稿")).not.toBeInTheDocument();

  await user.click(screen.getByRole("tab", { name: "视频" }));
  expect(screen.queryByText("晨光构图")).not.toBeInTheDocument();
  expect(screen.getByText("环绕镜头")).toBeInTheDocument();
  expect(screen.queryByText("旁白草稿")).not.toBeInTheDocument();

  await user.click(screen.getByRole("tab", { name: "导入" }));
  expect(screen.queryByText("晨光构图")).not.toBeInTheDocument();
  expect(screen.queryByText("环绕镜头")).not.toBeInTheDocument();
  expect(screen.getByText("旁白草稿")).toBeInTheDocument();
});

it("shows a clear empty state only for storyboard shots without a captured preview", () => {
  const missingPreview: DirectorMediaItem = {
    id: "shot:uncaptured",
    kind: "shot",
    collection: "shots",
    name: "未捕获分镜",
    subtitle: "主机位 · F0–F95",
    thumbnailUrl: null,
    sourceUrl: null,
    durationSec: 4,
    cameraId: "camera-1",
    frameStart: 0,
    frameEnd: 95,
  };
  const capturedPreview: DirectorMediaItem = {
    ...missingPreview,
    id: "shot:captured",
    name: "已捕获分镜",
    thumbnailUrl: "data:image/png;base64,storyboard-preview",
    sourceUrl: "data:image/png;base64,storyboard-preview",
  };

  render(<CreativeMediaBrowser items={[missingPreview, capturedPreview]} />);

  const missingCard = cardFor("未捕获分镜");
  expect(within(missingCard).getByText("未捕获画面")).toBeInTheDocument();
  expect(missingCard.querySelector("img, video")).toBeNull();

  const capturedCard = cardFor("已捕获分镜");
  expect(capturedCard.querySelector("img")).toHaveAttribute("src", "data:image/png;base64,storyboard-preview");
  expect(within(capturedCard).queryByText("未捕获画面")).not.toBeInTheDocument();
});

it("opens the import picker and forwards every selected image, video, and audio file", async () => {
  const user = userEvent.setup();
  const onImportFiles = vi.fn();
  const inputClick = vi.spyOn(HTMLInputElement.prototype, "click");
  const { container } = render(<CreativeMediaBrowser items={[]} onImportFiles={onImportFiles} />);

  await user.click(screen.getByRole("button", { name: "导入素材" }));
  expect(inputClick).toHaveBeenCalledTimes(1);

  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  expect(input).not.toBeNull();
  expect(input).toHaveAccessibleName("导入素材");
  expect(input).toHaveAttribute("accept", "image/*,video/*,audio/*");
  expect(input).toHaveAttribute("multiple");
  expect(input).toHaveAttribute("tabindex", "-1");

  const image = new File(["image"], "reference.png", { type: "image/png" });
  const video = new File(["video"], "take.mp4", { type: "video/mp4" });
  const audio = new File(["audio"], "voice.wav", { type: "audio/wav" });
  await user.upload(input!, [image, video, audio]);

  expect(onImportFiles).toHaveBeenCalledTimes(1);
  expect(onImportFiles).toHaveBeenCalledWith([image, video, audio]);
});

it("forwards the selected media item from its add button", async () => {
  const user = userEvent.setup();
  const onAdd = vi.fn();
  render(<CreativeMediaBrowser items={mediaItems} onAdd={onAdd} />);

  await user.click(screen.getByRole("button", { name: "添加 晨光构图" }));

  expect(onAdd).toHaveBeenCalledTimes(1);
  expect(onAdd).toHaveBeenCalledWith(mediaItems[0]);
});

it("publishes the Director media id and plain-text fallback during drag", () => {
  const setData = vi.fn();
  const setDragImage = vi.fn();
  const dataTransfer = {
    effectAllowed: "none",
    setData,
    setDragImage,
  } as unknown as DataTransfer;
  render(<CreativeMediaBrowser items={mediaItems} />);

  const card = cardFor("环绕镜头");
  fireEvent.dragStart(card, { dataTransfer });

  expect(dataTransfer.effectAllowed).toBe("copy");
  expect(setData).toHaveBeenNthCalledWith(1, DIRECTOR_MEDIA_DRAG_TYPE, "recording:video-1");
  expect(setData).toHaveBeenNthCalledWith(2, "text/plain", "recording:video-1");
  expect(setDragImage).toHaveBeenCalledWith(expect.any(HTMLCanvasElement), 0, 0);
  expect(card).toHaveClass("is-dragging");

  fireEvent.dragEnd(card);
  expect(card).not.toHaveClass("is-dragging");
});

it("marks offline media, blocks broken drags/adds, and exposes the relink journey", async () => {
  const user = userEvent.setup();
  const onAdd = vi.fn();
  const onRelink = vi.fn();
  const offline: DirectorMediaItem = {
    ...mediaItems[1],
    id: "missing:take-7",
    name: "Missing take",
    sourceUrl: null,
    availability: "offline",
  };
  const proxy: DirectorMediaItem = {
    ...mediaItems[1],
    id: "creative-media:video:original",
    name: "Proxy-backed take",
    playbackSource: {
      variant: "proxy",
      assetId: "creative-media:video:proxy",
      url: "blob:proxy",
      proxyAssetId: "creative-media:video:proxy",
      reason: "proxy-fits-preview",
    },
  };
  render(<CreativeMediaBrowser items={[offline, proxy]} onAdd={onAdd} onRelink={onRelink} />);

  const offlineCard = cardFor("Missing take");
  expect(offlineCard).toHaveClass("is-offline");
  expect(offlineCard).toHaveAttribute("draggable", "false");
  expect(within(offlineCard).getByText("离线")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "添加 Missing take" })).not.toBeInTheDocument();

  const setData = vi.fn();
  fireEvent.dragStart(offlineCard, {
    dataTransfer: { effectAllowed: "none", setData } as unknown as DataTransfer,
  });
  expect(setData).not.toHaveBeenCalled();

  await user.click(screen.getByRole("button", { name: "重连 Missing take" }));
  expect(onRelink).toHaveBeenCalledWith(offline);
  expect(within(cardFor("Proxy-backed take")).getByText("Proxy")).toBeInTheDocument();
});

it("searches media by name without rating, tag, folder, or assembly chrome", async () => {
  const user = userEvent.setup();
  render(<CreativeMediaBrowser items={mediaItems} />);

  expect(screen.queryByRole("combobox", { name: "评分筛选" })).not.toBeInTheDocument();
  expect(screen.queryByRole("combobox", { name: "标签筛选" })).not.toBeInTheDocument();
  expect(screen.queryByRole("tree", { name: "素材文件夹" })).not.toBeInTheDocument();
  expect(screen.queryByRole("tablist", { name: "装配筛选" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "晨光构图 评分 4 星" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "编辑标签 晨光构图" })).not.toBeInTheDocument();

  await user.type(screen.getByRole("searchbox", { name: "搜索素材" }), "晨光");
  expect(screen.getByText("晨光构图")).toBeInTheDocument();
  expect(screen.queryByText("环绕镜头")).not.toBeInTheDocument();
});

it("adds media on card double-click but not from the add button or offline cards", async () => {
  const user = userEvent.setup();
  const onAdd = vi.fn();
  const offline: DirectorMediaItem = {
    ...mediaItems[1],
    id: "missing:take-9",
    name: "离线镜头",
    sourceUrl: null,
    availability: "offline",
  };
  render(<CreativeMediaBrowser items={[...mediaItems, offline]} onAdd={onAdd} />);

  const card = cardFor("晨光构图");
  expect(card).toHaveAttribute("title", "双击添加到工作区");
  fireEvent.doubleClick(card);
  expect(onAdd).toHaveBeenCalledTimes(1);
  expect(onAdd).toHaveBeenCalledWith(mediaItems[0]);

  fireEvent.doubleClick(within(card).getByRole("button", { name: "添加 晨光构图" }));
  expect(onAdd).toHaveBeenCalledTimes(1);

  const offlineCard = cardFor("离线镜头");
  expect(offlineCard).not.toHaveAttribute("title");
  fireEvent.doubleClick(offlineCard);
  expect(onAdd).toHaveBeenCalledTimes(1);
  await user.click(within(card).getByRole("button", { name: "添加 晨光构图" }));
  expect(onAdd).toHaveBeenCalledTimes(2);
});

it("offers a filter reset when the library has items but none match", async () => {
  const user = userEvent.setup();
  render(<CreativeMediaBrowser items={mediaItems} />);

  await user.click(screen.getByRole("tab", { name: "参考" }));
  await user.type(screen.getByRole("searchbox", { name: "搜索素材" }), "无匹配关键词");

  expect(await screen.findByText("没有匹配的素材")).toBeInTheDocument();
  expect(screen.queryByText("暂无可用素材")).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "清除筛选" }));

  expect(screen.getByRole("searchbox", { name: "搜索素材" })).toHaveValue("");
  expect(screen.getByRole("tab", { name: "全部" })).toHaveAttribute("aria-selected", "true");
  expect(screen.queryByText("没有匹配的素材")).not.toBeInTheDocument();
  expect(screen.getByText("晨光构图")).toBeInTheDocument();
  expect(screen.getByText("环绕镜头")).toBeInTheDocument();
  expect(screen.getByText("旁白草稿")).toBeInTheDocument();
});

it("keeps the capture guidance empty state when the library itself is empty", () => {
  render(<CreativeMediaBrowser items={[]} />);

  expect(screen.getByText("暂无可用素材")).toBeInTheDocument();
  expect(screen.getByText("请先在 3D 片场保存截图、分镜或录制视频。")).toBeInTheDocument();
  expect(screen.queryByText("没有匹配的素材")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "清除筛选" })).not.toBeInTheDocument();
});

it("plays a hover preview on thumbnail-less video cards and rewinds on leave", async () => {
  const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
  const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  const user = userEvent.setup();
  const offline: DirectorMediaItem = {
    ...mediaItems[1],
    id: "missing:take-9",
    name: "离线镜头",
    availability: "offline",
  };
  render(<CreativeMediaBrowser items={[...mediaItems, offline]} />);

  const videoCard = cardFor("环绕镜头");
  const video = videoCard.querySelector("video");
  expect(video).not.toBeNull();
  video!.currentTime = 2.5;

  await user.hover(videoCard);
  expect(play).toHaveBeenCalledTimes(1);

  await user.unhover(videoCard);
  expect(pause).toHaveBeenCalled();
  expect(video!.currentTime).toBe(0);

  await user.hover(cardFor("晨光构图"));
  await user.unhover(cardFor("晨光构图"));
  expect(play).toHaveBeenCalledTimes(1);

  expect(cardFor("离线镜头").querySelector("video")).not.toBeNull();
  await user.hover(cardFor("离线镜头"));
  expect(play).toHaveBeenCalledTimes(1);

  play.mockRestore();
  pause.mockRestore();
});

it("clears the search query from the inline clear button and keeps input focus", async () => {
  const user = userEvent.setup();
  render(<CreativeMediaBrowser items={mediaItems} />);

  const input = screen.getByRole("searchbox", { name: "搜索素材" });
  expect(screen.queryByRole("button", { name: "清空搜索" })).not.toBeInTheDocument();

  await user.type(input, "旁白");
  expect(screen.queryByText("晨光构图")).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "清空搜索" }));

  expect(input).toHaveValue("");
  expect(input).toHaveFocus();
  expect(screen.queryByRole("button", { name: "清空搜索" })).not.toBeInTheDocument();
  expect(screen.getByText("晨光构图")).toBeInTheDocument();
});
