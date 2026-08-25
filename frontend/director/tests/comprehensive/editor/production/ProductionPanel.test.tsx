import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { resetDirectorSessionRuntime, updateDirectorSessionRuntime } from "../../../../src/comprehensive/editor/session/directorSessionRuntime";
import { createInitialDirectorState, useDirectorStore } from "../../../../src/comprehensive/editor/store/directorStore";
import { rememberSceneCameraThumbnail, resetSceneCameraThumbnailCache } from "../../../../src/comprehensive/editor/production/sceneCameraThumbnailCache";

const client = vi.hoisted(() => ({
  create: vi.fn(),
  get: vi.fn(),
  getScene: vi.fn(),
  update: vi.fn(),
}));

vi.mock("../../../../src/comprehensive/editor/production/productionClient", () => ({
  createDirectorProductionScene: client.create,
  getDirectorProduction: client.get,
  getDirectorProductionSceneSnapshot: client.getScene,
  updateDirectorProduction: client.update,
  DirectorProductionClientError: class DirectorProductionClientError extends Error {},
}));

import { ProductionPanel } from "../../../../src/comprehensive/editor/production/ProductionPanel";

const production = {
  productionId: "main",
  revision: 4,
  updatedAt: null,
  updatedBy: null,
  production: {
    version: 1 as const,
    title: "短片制作",
    activeSceneId: "scene-one",
    scenes: [
      { sceneId: "scene-one", title: "开场", sourceRevision: 3, createdAt: "2026-01-01T00:00:00Z" },
      { sceneId: "scene-two", title: "次场", sourceRevision: 1, createdAt: "2026-01-01T00:00:00Z" },
    ],
    editorialTimeline: [],
  },
};

beforeEach(() => {
  client.create.mockReset();
  client.get.mockReset();
  client.getScene.mockReset();
  client.update.mockReset();
  client.get.mockResolvedValue(production);
  client.getScene.mockResolvedValue({
    sceneId: "scene-one",
    revision: 3,
    scene: { scene: { backgroundColor: "#08090d" }, entities: [{ id: "actor", type: "character" }] },
  });
  client.update.mockResolvedValue({
    ...production,
    revision: 5,
    production: { ...production.production, activeSceneId: "scene-two" },
  });
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...createInitialDirectorState(),
  });
  resetDirectorSessionRuntime();
  resetSceneCameraThumbnailCache();
  updateDirectorSessionRuntime({ sceneId: "scene-one", revision: 3 });
});

it("lists the production scenes and switches through the host bridge after the manifest revision commits", async () => {
  const user = userEvent.setup();
  const postMessage = vi.spyOn(window.parent, "postMessage").mockImplementation(() => undefined);
  render(<ProductionPanel />);

  const target = await screen.findByRole("button", { name: "次场 r1" });
  await user.click(target);

  expect(client.update).toHaveBeenCalledWith("main", 4, [
    {
      op: "set_active_scene",
      sceneId: "scene-two",
    },
  ]);
  expect(postMessage).toHaveBeenCalledWith(
    {
      type: "storyai:director-desk-switch-scene",
      payload: expect.objectContaining({
        sceneId: "scene-two",
        activationId: expect.stringMatching(/^director-activation-ui:/),
      }),
    },
    window.location.origin,
  );
  postMessage.mockRestore();
});

it("duplicates the loaded scene with an independent project seed", async () => {
  const user = userEvent.setup();
  const postMessage = vi.spyOn(window.parent, "postMessage").mockImplementation(() => undefined);
  const sourceProject = useDirectorStore.getState().project;
  client.create.mockResolvedValue({
    ...production,
    revision: 5,
    production: {
      ...production.production,
      activeSceneId: "scene-copy",
      scenes: [
        ...production.production.scenes,
        { sceneId: "scene-copy", title: "开场", sourceRevision: 0, createdAt: "2026-01-02T00:00:00Z" },
      ],
    },
  });
  render(<ProductionPanel />);

  await user.click(await screen.findByRole("button", { name: "复制当前场景" }));

  expect(client.create).toHaveBeenCalledWith(
    expect.objectContaining({
      productionId: "main",
      expectedRevision: 4,
      sourceSceneId: "scene-one",
      title: "开场",
    }),
  );
  expect(postMessage).toHaveBeenCalledWith(
    {
      type: "storyai:director-desk-switch-scene",
      payload: {
        sceneId: "scene-copy",
        activationId: expect.stringMatching(/^director-activation-ui:/),
        project: sourceProject,
      },
    },
    window.location.origin,
  );
  const postedProject = postMessage.mock.calls.at(-1)?.[0]?.payload?.project;
  expect(postedProject).toEqual(sourceProject);
  expect(postedProject).not.toBe(sourceProject);
  postMessage.mockRestore();
});

it("keeps switching visible until the host emits the matching render-ready acknowledgement", async () => {
  const user = userEvent.setup();
  const postMessage = vi.spyOn(window.parent, "postMessage").mockImplementation(() => undefined);
  render(<ProductionPanel />);

  await user.click(await screen.findByRole("button", { name: "次场 r1" }));
  expect(screen.getByRole("status")).toHaveTextContent("正在切换到 scene-two");
  const activationId = postMessage.mock.calls.at(-1)?.[0]?.payload?.activationId;

  await act(() => updateDirectorSessionRuntime({ sceneId: "scene-two", revision: 1 }));
  expect(screen.getByRole("status")).toHaveTextContent("正在切换到 scene-two");
  await act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        source: window,
        data: {
          type: "storyai:director-desk-scene-switch-ready",
          payload: { sceneId: "scene-two", activationId, sceneProjectRevision: 0 },
        },
      }),
    );
  });
  await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  postMessage.mockRestore();
});

it("renders a collapsible thumbnail browser for the bottom scene tab", async () => {
  const user = userEvent.setup();
  render(<ProductionPanel variant="scene-browser" />);

  expect(await screen.findByTestId("scene-thumbnail-scene-one")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "开场 r3" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "收起场景缩略图列表" }));
  expect(screen.queryByLabelText("场景缩略图库")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "展开场景缩略图列表" }));
  expect(screen.getByLabelText("场景缩略图库")).toBeInTheDocument();
});

it("collapses and restores the editorial cut list independently from the scene list", async () => {
  const user = userEvent.setup();
  client.get.mockResolvedValue({
    ...production,
    production: {
      ...production.production,
      editorialTimeline: [
        {
          id: "cut-01",
          label: "开场广角",
          sceneId: "scene-one",
          cameraId: "cam_1",
          frameStart: 1,
          frameEnd: 48,
          mode: "linked" as const,
          sourceRevision: 3,
        },
      ],
    },
  });
  render(<ProductionPanel />);

  expect(await screen.findByLabelText("剪辑轨")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "收起剪辑轨列表" }));
  expect(screen.queryByLabelText("剪辑轨")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "开场 r3" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "展开剪辑轨列表" }));
  expect(screen.getByLabelText("剪辑轨")).toBeInTheDocument();
});

it("uses the genuine cached current-camera frame instead of an object-diagram thumbnail", async () => {
  const cameraFrame =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlckH8AAAAASUVORK5CYII=";
  rememberSceneCameraThumbnail("scene-one", cameraFrame);
  render(<ProductionPanel variant="scene-browser" />);

  const thumbnail = await screen.findByTestId("scene-thumbnail-scene-one");
  expect(thumbnail.querySelector("img")?.getAttribute("src")).toBe(cameraFrame);
  expect(thumbnail.querySelector(".production-scene-thumbnail-grid")).not.toBeInTheDocument();
});

it("removes a scene reference and switches away when the current scene is deleted", async () => {
  const user = userEvent.setup();
  const postMessage = vi.spyOn(window.parent, "postMessage").mockImplementation(() => undefined);
  client.update.mockResolvedValue({
    ...production,
    revision: 5,
    production: {
      ...production.production,
      activeSceneId: "scene-two",
      scenes: production.production.scenes.filter((scene) => scene.sceneId !== "scene-one"),
    },
  });
  render(<ProductionPanel />);

  await user.click(await screen.findByRole("button", { name: "删除场景 开场" }));

  expect(client.update).toHaveBeenCalledWith("main", 4, [
    {
      op: "remove_scene_reference",
      sceneId: "scene-one",
    },
  ]);
  expect(postMessage).toHaveBeenCalledWith(
    {
      type: "storyai:director-desk-switch-scene",
      payload: expect.objectContaining({ sceneId: "scene-two", activationId: expect.any(String) }),
    },
    window.location.origin,
  );
  expect(screen.getByRole("status")).toHaveTextContent("已删除场景，正在切换到 scene-two");
  postMessage.mockRestore();
});

it("replaces the last remaining scene with a fresh empty scene before removing it", async () => {
  const user = userEvent.setup();
  const postMessage = vi.spyOn(window.parent, "postMessage").mockImplementation(() => undefined);
  client.get.mockResolvedValue({
    ...production,
    production: {
      ...production.production,
      scenes: [production.production.scenes[0]!],
    },
  });
  client.create.mockResolvedValue({
    ...production,
    revision: 5,
    production: {
      ...production.production,
      activeSceneId: "scene-fresh",
      scenes: [
        production.production.scenes[0]!,
        { sceneId: "scene-fresh", title: "新场景", sourceRevision: 0, createdAt: "2026-01-02T00:00:00Z" },
      ],
    },
  });
  client.update.mockResolvedValue({
    ...production,
    revision: 6,
    production: {
      ...production.production,
      activeSceneId: "scene-fresh",
      scenes: [{ sceneId: "scene-fresh", title: "新场景", sourceRevision: 0, createdAt: "2026-01-02T00:00:00Z" }],
    },
  });
  render(<ProductionPanel />);

  await user.click(await screen.findByRole("button", { name: "删除场景 开场" }));

  expect(client.create).toHaveBeenCalledWith(
    expect.objectContaining({
      productionId: "main",
      expectedRevision: 4,
      title: "新场景",
    }),
  );
  expect(client.update).toHaveBeenCalledWith("main", 5, [
    {
      op: "remove_scene_reference",
      sceneId: "scene-one",
    },
  ]);
  expect(postMessage).toHaveBeenCalledWith(
    {
      type: "storyai:director-desk-switch-scene",
      payload: expect.objectContaining({ sceneId: "scene-fresh", activationId: expect.any(String) }),
    },
    window.location.origin,
  );
  postMessage.mockRestore();
});
