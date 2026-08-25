// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  BLENDER_LIVE_CONTRACT,
  type BlenderLiveSceneSnapshot,
  type BlenderObjectInspection,
} from "../../../../../../packages/protocol/src/blenderLiveProtocol";

const live = vi.hoisted(() => ({
  apply: vi.fn(),
  inspect: vi.fn(),
}));

vi.mock("../../../../src/comprehensive/editor/api/blenderLiveClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../src/comprehensive/editor/api/blenderLiveClient")>();
  return {
    ...actual,
    applyBlenderNativeOperations: live.apply,
    inspectBlenderLiveObject: live.inspect,
  };
});

import { createInitialDirectorState, useDirectorStore } from "../../../../src/comprehensive/editor/store/directorStore";
import { useBlenderRuntimeStore } from "../../../../src/comprehensive/editor/runtime/blenderRuntimeStore";
import { RightPanel } from "../../../../src/comprehensive/editor/panels/RightPanel";

const meshInspection: BlenderObjectInspection = {
  id: "mesh-a",
  name: "Tower Mesh",
  type: "MESH",
  mode: "EDIT",
  dimensions: [1, 2, 1],
  evaluatedBounds: {
    min: [-0.5, 0, -0.5],
    max: [0.5, 2, 0.5],
    center: [0, 1, 0],
    size: [1, 2, 1],
  },
  selection: { selected: true, active: true },
  materialNodes: [],
  materialSlots: [],
  materialGraphs: [],
  geometryGraphs: [],
  mesh: {
    vertices: 8,
    edges: 12,
    faces: 2,
    triangles: 4,
    looseVertices: 0,
    boundaryEdges: 0,
    nonManifoldEdges: 0,
    materialSlots: 0,
    selection: {
      vertices: { count: 0, sample: [] },
      edges: { count: 0, sample: [] },
      faces: { count: 2, sample: [0, 1] },
    },
    uvLayers: [],
    uvLayerDetails: [],
    colorAttributes: [],
    shapeKeys: [],
  },
  animation: {
    action: null,
    activeAction: null,
    actions: [],
    fCurveCount: 0,
    keyframeCount: 0,
    driverCount: 0,
    nlaTrackCount: 0,
    nlaStripCount: 0,
    nlaTracks: [],
  },
  warnings: [],
};

const sceneSnapshot: BlenderLiveSceneSnapshot = {
  projectId: "director-project-a",
  sceneEpoch: "48b0d9b3-2bf8-46a7-8832-909d816369e2",
  revision: 3,
  sceneName: "Scene",
  frame: 1,
  unit: "meter",
  coordinateSystem: "right-handed-y-up-negative-z-forward",
  activeObjectId: "mesh-a",
  selectedObjectIds: ["mesh-a"],
  objects: [
    {
      id: "root-a",
      directorId: "native:root-a",
      name: "City tower",
      type: "EMPTY",
      parentId: null,
      kind: "prop",
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      localTransform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      dimensions: [1, 2, 1],
      visible: true,
      collections: ["Collection"],
      modifierCount: 0,
      constraints: [],
    },
    {
      id: "mesh-a",
      directorId: "native:mesh-a",
      name: "Tower Mesh",
      type: "MESH",
      parentId: "root-a",
      kind: "prop",
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      localTransform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      dimensions: [1, 2, 1],
      visible: true,
      collections: ["Collection"],
      modifierCount: 0,
      constraints: [],
    },
  ],
  cameras: [],
  lights: [],
  contract: BLENDER_LIVE_CONTRACT,
};

beforeEach(() => {
  live.apply.mockReset();
  live.inspect.mockReset();
  live.inspect.mockResolvedValue({ inspection: meshInspection });
  useBlenderRuntimeStore.getState().reset();
  useBlenderRuntimeStore.getState().publishStatus({
    available: true,
    ok: true,
    contract: BLENDER_LIVE_CONTRACT,
    projectId: "director-project-a",
    sceneEpoch: "48b0d9b3-2bf8-46a7-8832-909d816369e2",
    revision: 3,
    busy: false,
    blenderVersion: "4.2.0",
  });
  useBlenderRuntimeStore.getState().publishSnapshot(sceneSnapshot);
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...createInitialDirectorState(),
    selectedObjectId: "native:root-a",
    project: {
      ...createInitialDirectorState().project,
      nativeScene: { engine: "blender", projectId: "director-project-a" },
      objects: [
        {
          id: "native:root-a",
          name: "City tower",
          kind: "prop",
          visible: true,
          locked: false,
          color: "#d7e7ff",
          transform: {
            position: [0, 0, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
          },
          nativeSource: { engine: "blender", objectId: "root-a", provisioned: true },
        },
      ],
    },
  });
});

afterEach(() => cleanup());

it("embeds native mesh editing below the prop inspector for blender objects", async () => {
  render(<RightPanel />);

  expect(screen.getByLabelText("模型右侧属性面板")).toBeInTheDocument();
  await waitFor(() => expect(screen.getByLabelText("Blender Mesh 编辑")).toBeInTheDocument());
  expect(screen.getByRole("tablist", { name: "Mesh 编辑面板" })).toBeInTheDocument();
  expect(screen.queryByLabelText("Blender 场景")).not.toBeInTheDocument();
});

it("does not render mesh editing for characters or disconnected native objects", async () => {
  useDirectorStore.setState((state) => ({
    project: {
      ...state.project,
      objects: state.project.objects.map((object) =>
        object.id === "native:root-a"
          ? {
              ...object,
              kind: "character" as const,
              name: "Hero",
            }
          : object,
      ),
    },
  }));

  render(<RightPanel />);
  expect(screen.getByLabelText("角色右侧属性面板")).toBeInTheDocument();
  expect(screen.queryByLabelText("Blender Mesh 编辑")).not.toBeInTheDocument();

  cleanup();
  useBlenderRuntimeStore.getState().publishStatus({
    available: false,
    contract: BLENDER_LIVE_CONTRACT,
    reason: "offline",
  });
  useDirectorStore.setState((state) => ({
    project: {
      ...state.project,
      objects: state.project.objects.map((object) =>
        object.id === "native:root-a"
          ? {
              ...object,
              kind: "prop" as const,
              name: "City tower",
            }
          : object,
      ),
    },
  }));

  render(<RightPanel />);
  await waitFor(() => expect(screen.getByLabelText("模型右侧属性面板")).toBeInTheDocument());
  expect(screen.queryByLabelText("Blender Mesh 编辑")).not.toBeInTheDocument();
});
