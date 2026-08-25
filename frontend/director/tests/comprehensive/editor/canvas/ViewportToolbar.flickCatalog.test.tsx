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
  ...(await importOriginal<typeof import("../../../../src/comprehensive/editor/modelLibrary/mixamoCharacterCatalog")>()),
  loadLocalMixamoCharacterCatalog: (...args: unknown[]) => mockLoadLocalMixamoCharacterCatalog(...args),
}));

import { createInitialDirectorState, useDirectorStore } from "../../../../src/comprehensive/editor/store/directorStore";
import { ViewportToolbar } from "../../../../src/comprehensive/editor/canvas/ViewportToolbar";

beforeEach(() => {
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

afterEach(() => vi.restoreAllMocks());

it("adds a Flick catalog component with its local GLB path", async () => {
  const user = userEvent.setup();
  render(<ViewportToolbar />);

  await user.click(screen.getByRole("button", { name: "模型库" }));
  expect(screen.getByRole("tab", { name: "全部" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("tab", { name: "核心" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "人物" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "基本体" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "动物" })).toBeInTheDocument();
  expect(screen.queryByRole("tab", { name: "我的模型" })).not.toBeInTheDocument();
  expect(screen.queryByRole("tab", { name: "便利生活" })).not.toBeInTheDocument();

  await user.click(screen.getByRole("tab", { name: "动物" }));

  const addCat = await screen.findByRole("button", { name: "添加模型 Cat" });
  await user.click(addCat);

  await waitFor(() => {
    const state = useDirectorStore.getState();
    const asset = state.project.assets.find((item) => item.fileName === "cat.glb");
    expect(asset).toMatchObject({
      url: "/flick-stage-props/animals/cat.glb",
      realWorldSizeM: 0.6,
      sizeSource: "catalog",
    });
    expect(state.project.objects.some((item) => item.assetRefId === asset?.id)).toBe(true);
  });
});

it("adds a Mixamo X Bot from the characters tab", async () => {
  const user = userEvent.setup();
  render(<ViewportToolbar />);

  await user.click(screen.getByRole("button", { name: "模型库" }));
  await user.click(screen.getByRole("tab", { name: "人物" }));

  const previewCard = await screen.findByRole("button", { name: "添加模型 X Bot" });
  expect(previewCard.querySelector("img.model-library-thumb-image")).toHaveAttribute(
    "src",
    "/mixamo-characters/thumbnails/x-bot.webp",
  );

  const addXBot = screen.getByRole("button", { name: "添加模型 X Bot" });
  await user.click(addXBot);

  await waitFor(() => {
    const state = useDirectorStore.getState();
    const asset = state.project.assets.find((item) => item.fileName === "x-bot.glb");
    expect(asset).toMatchObject({
      kind: "character",
      url: "/mixamo-characters/models/x-bot.glb",
    });
    expect(state.project.objects.some((item) => item.assetRefId === asset?.id)).toBe(true);
  });
});
