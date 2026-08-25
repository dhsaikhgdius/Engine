import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { mockLoadLocalFlickStageCatalog, mockLoadLocalMixamoCharacterCatalog } = vi.hoisted(() => ({
  mockLoadLocalFlickStageCatalog: vi.fn(),
  mockLoadLocalMixamoCharacterCatalog: vi.fn(),
}));

vi.mock("../../../../src/comprehensive/editor/modelLibrary/flickPublicCatalog", () => ({
  loadLocalFlickStageCatalog: (...args: unknown[]) => mockLoadLocalFlickStageCatalog(...args),
}));
vi.mock("../../../../src/comprehensive/editor/modelLibrary/mixamoCharacterCatalog", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../../src/comprehensive/editor/modelLibrary/mixamoCharacterCatalog")
  >()),
  loadLocalMixamoCharacterCatalog: (...args: unknown[]) => mockLoadLocalMixamoCharacterCatalog(...args),
}));
vi.mock("../../../../src/comprehensive/editor/canvas/ModelLibraryPreview", () => ({
  ModelLibraryPreviewDialog: ({
    item,
    onAdd,
    onClose,
  }: {
    item: { name: string };
    onAdd: (item: { name: string }) => void;
    onClose: () => void;
  }) => (
    <div aria-label={`${item.name} 大图预览`} role="dialog">
      <button onClick={() => onAdd(item)} type="button">
        添加至场景
      </button>
      <button onClick={onClose} type="button">
        关闭
      </button>
    </div>
  ),
}));
import { createInitialDirectorState, useDirectorStore } from "../../../../src/comprehensive/editor/store/directorStore";
import { setDirectorPageViewportHandler } from "../../../../src/comprehensive/editor/assistant/pageStateBridge";
import { AssetLibraryPanel } from "../../../../src/comprehensive/editor/panels/AssetLibraryPanel";

beforeEach(() => {
  vi.stubGlobal("WebGLRenderingContext", class WebGLRenderingContext {});
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...createInitialDirectorState(),
  });
  mockLoadLocalFlickStageCatalog.mockReset();
  mockLoadLocalMixamoCharacterCatalog.mockReset();
  mockLoadLocalFlickStageCatalog.mockResolvedValue([
    {
      assetSource: "library",
      catalogCategory: "animals",
      categoryId: "flick",
      fileName: "cat.glb",
      flickCategory: "animals",
      id: "flick:animals:cat.glb",
      kind: "prop",
      name: "Cat",
      // Keep the legacy value to prove that a supplied static cover wins over
      // the old per-card WebGL thumbnail path.
      thumbnailKind: "model",
      thumbnailUrl: "/flick-stage-props/thumbnails/animals/cat.webp",
      url: "/flick-stage-props/animals/cat.glb",
    },
  ]);
  mockLoadLocalMixamoCharacterCatalog.mockResolvedValue([
    {
      assetSource: "library",
      catalogCategory: "characters",
      categoryId: "flick",
      characterMetadata: {
        heightM: 1.78,
        groundOffsetY: 0,
        visualCenter: [0, 0.89, 0],
        labelAnchorY: 1.9,
        rig: { type: "mixamo", boneCount: 65 },
      },
      fileName: "x-bot.glb",
      flickCategory: "characters",
      id: "mixamo:x-bot",
      kind: "character",
      name: "X Bot",
      thumbnailKind: "image",
      thumbnailUrl: "/mixamo-characters/thumbnails/x-bot.webp",
      url: "/mixamo-characters/models/x-bot.glb",
    },
  ]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("uses Flick-only categories and adds a locally mirrored Flick component", async () => {
  const user = userEvent.setup();
  const viewport = vi.fn();
  const clearViewport = setDirectorPageViewportHandler(viewport);
  render(<AssetLibraryPanel />);

  expect(screen.getByLabelText("从右侧导入本地模型")).toBeInTheDocument();
  expect(screen.getByLabelText("从右侧导入全景图")).toBeInTheDocument();

  expect(screen.getByRole("tab", { name: "全部" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("tab", { name: "核心" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "人物" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "动物" })).toBeInTheDocument();
  expect(screen.queryByRole("tab", { name: "便利生活" })).not.toBeInTheDocument();
  await waitFor(() => expect(document.querySelectorAll(".model-library-native-thumb")).toHaveLength(3));

  await user.click(screen.getByRole("tab", { name: "动物" }));
  const previewCard = await screen.findByRole("button", { name: "预览模型 Cat" });
  expect(previewCard).toHaveAttribute("draggable", "true");
  expect(previewCard.querySelector("img.model-library-thumb-image")).toHaveAttribute(
    "src",
    "/flick-stage-props/thumbnails/animals/cat.webp",
  );
  expect(document.querySelectorAll(".model-library-thumb canvas")).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: "添加模型 Cat" }));

  await waitFor(() => {
    const state = useDirectorStore.getState();
    const asset = state.project.assets.find((item) => item.fileName === "cat.glb");
    expect(asset?.url).toBe("/flick-stage-props/animals/cat.glb");
    expect(asset).toMatchObject({ realWorldSizeM: 0.6, sizeSource: "catalog" });
    expect(state.project.objects.some((item) => item.assetRefId === asset?.id)).toBe(true);
  });
  expect(viewport).toHaveBeenCalledWith(
    expect.objectContaining({
      fov: expect.any(Number),
      position: [expect.any(Number), expect.any(Number), expect.any(Number)],
      target: [expect.any(Number), expect.any(Number), expect.any(Number)],
    }),
  );
  clearViewport();
});

it("opens the reference reconstruction and procedural authoring workflows from the library", async () => {
  const user = userEvent.setup();
  render(<AssetLibraryPanel />);

  await user.click(screen.getByRole("button", { name: "打开程序化建模" }));
  expect(screen.getByRole("dialog", { name: "程序化建模工具" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "关闭程序化建模" }));

  await user.click(screen.getByRole("button", { name: "从参考图重建场景" }));
  expect(screen.getByRole("dialog", { name: "参考图重建场景" })).toBeInTheDocument();
});

it("merges Mixamo characters with Flick props and uses the generated character cover", async () => {
  const user = userEvent.setup();
  render(<AssetLibraryPanel />);

  await user.click(screen.getByRole("tab", { name: "人物" }));
  const previewCard = await screen.findByRole("button", { name: "预览模型 X Bot" });

  expect(previewCard.querySelector("img.model-library-thumb-image")).toHaveAttribute(
    "src",
    "/mixamo-characters/thumbnails/x-bot.webp",
  );
  expect(screen.getByText("本地 2 个组件")).toBeInTheDocument();

  const addXBot = screen.getByRole("button", { name: "添加模型 X Bot" });
  await user.click(addXBot);
  await user.click(addXBot);
  await waitFor(() => {
    const state = useDirectorStore.getState();
    const assets = state.project.assets.filter((item) => item.fileName === "x-bot.glb");
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({
      kind: "character",
      url: "/mixamo-characters/models/x-bot.glb",
      characterMetadata: expect.objectContaining({
        groundOffsetY: 0,
        rig: expect.objectContaining({ type: "mixamo", boneCount: 65 }),
      }),
    });
    expect(state.project.objects.filter((item) => item.assetRefId === assets[0]?.id)).toHaveLength(3);
  });
});

it("opens a real model preview before adding a local component", async () => {
  const user = userEvent.setup();
  render(<AssetLibraryPanel />);

  await user.click(screen.getByRole("tab", { name: "动物" }));
  await user.click(await screen.findByRole("button", { name: "预览模型 Cat" }));

  expect(screen.getByRole("dialog", { name: "Cat 大图预览" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "添加至场景" }));

  await waitFor(() => {
    expect(useDirectorStore.getState().project.assets.some((item) => item.fileName === "cat.glb")).toBe(true);
  });
});

it("uses an auto-adaptive grid without manual thumbnail size controls", async () => {
  render(<AssetLibraryPanel />);

  await screen.findByRole("button", { name: "预览模型 Cat" });

  expect(screen.queryByRole("slider", { name: "调整模型缩略图大小" })).not.toBeInTheDocument();
  expect(screen.queryByLabelText("当前模型缩略图大小")).not.toBeInTheDocument();
  expect(screen.getByRole("list", { name: "模型列表" })).toHaveClass("asset-library-grid");
});

it("virtualizes a large local catalog instead of mounting every asset card", async () => {
  mockLoadLocalFlickStageCatalog.mockResolvedValue(
    Array.from({ length: 1_000 }, (_, index) => ({
      assetSource: "library",
      catalogCategory: "props",
      categoryId: "flick",
      fileName: `asset-${index}.glb`,
      flickCategory: "props",
      id: `flick:props:asset-${index}.glb`,
      kind: "prop",
      name: `Asset ${index}`,
      thumbnailKind: "image",
      thumbnailUrl: `/flick-stage-props/thumbnails/asset-${index}.webp`,
      url: `/flick-stage-props/asset-${index}.glb`,
    })),
  );

  render(<AssetLibraryPanel />);

  const list = await screen.findByRole("list", { name: "模型列表" });
  await waitFor(() => expect(list).toHaveClass("asset-library-grid-virtualized"));
  await waitFor(() => expect(screen.getByRole("button", { name: "预览模型 Asset 0" })).toBeInTheDocument());

  expect(list.querySelectorAll(".model-library-card-wrap").length).toBeLessThan(80);
  expect(screen.queryByRole("button", { name: "预览模型 Asset 999" })).not.toBeInTheDocument();
});

it("adds more asset columns when the library panel is wider than the two-card fallback", async () => {
  mockLoadLocalFlickStageCatalog.mockResolvedValue(
    Array.from({ length: 1_000 }, (_, index) => ({
      assetSource: "library",
      catalogCategory: "props",
      categoryId: "flick",
      fileName: `asset-${index}.glb`,
      flickCategory: "props",
      id: `flick:props:asset-${index}.glb`,
      kind: "prop",
      name: `Asset ${index}`,
      thumbnailKind: "image",
      thumbnailUrl: `/flick-stage-props/thumbnails/asset-${index}.webp`,
      url: `/flick-stage-props/asset-${index}.glb`,
    })),
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    bottom: 560,
    height: 560,
    left: 0,
    right: 657,
    top: 0,
    width: 657,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });

  render(<AssetLibraryPanel />);

  const list = await screen.findByRole("list", { name: "模型列表" });
  await waitFor(() => expect(list).toHaveAttribute("data-column-count", "6"));

  const firstRow = list.querySelector(".asset-library-virtual-row");
  expect(firstRow?.querySelectorAll(".model-library-card-wrap")).toHaveLength(6);
});
