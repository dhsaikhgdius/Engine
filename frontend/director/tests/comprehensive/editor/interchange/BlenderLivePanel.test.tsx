// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BLENDER_LIVE_CONTRACT,
  type BlenderLiveSceneSnapshot,
} from "../../../../../../packages/protocol/src/blenderLiveProtocol";

const live = vi.hoisted(() => ({
  apply: vi.fn(),
  applyBatch: vi.fn(),
  inspect: vi.fn(),
  preview: vi.fn(),
  scene: vi.fn(),
  status: vi.fn(),
}));

vi.mock("../../../../src/comprehensive/i18n/language", () => ({
  useLanguage: () => ({ t: (value: string) => value }),
}));
vi.mock("../../../../src/comprehensive/editor/api/blenderLiveClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../src/comprehensive/editor/api/blenderLiveClient")>();
  return {
    ...actual,
    applyBlenderNativeBatch: live.applyBatch,
    applyBlenderNativeOperations: live.apply,
    getBlenderLivePreviewGlb: live.preview,
    getBlenderLiveScene: live.scene,
    getBlenderLiveStatus: live.status,
    inspectBlenderLiveObject: live.inspect,
  };
});

import {
  findPreferredBlenderMeshId,
  findBlenderMeshesForObject,
  BlenderLivePanel,
} from "../../../../src/comprehensive/editor/interchange/BlenderLivePanel";
import { BlenderLiveClientError } from "../../../../src/comprehensive/editor/api/blenderLiveClient";
import { useBlenderRuntimeStore } from "../../../../src/comprehensive/editor/runtime/blenderRuntimeStore";
import { hexToLinearRgb } from "../../../../src/comprehensive/editor/interchange/blenderColorSpace";

const requestId = "b4b2ed3d-b25b-4ad0-8db9-f04bcb229fb6";
const sceneEpoch = "48b0d9b3-2bf8-46a7-8832-909d816369e2";

afterEach(cleanup);

function inspection(mode: "OBJECT" | "EDIT") {
  return {
    id: "mesh-a",
    name: "Mesh A",
    type: "MESH",
    mode,
    dimensions: [2, 1, 3],
    evaluatedBounds: {
      min: [-1, 0, -1.5],
      max: [1, 1, 1.5],
      center: [0, 0.5, 0],
      size: [2, 1, 3],
    },
    selection: { selected: true, active: true },
    mesh: {
      vertices: 8,
      edges: 12,
      faces: 6,
      triangles: 12,
      looseVertices: 0,
      boundaryEdges: 0,
      nonManifoldEdges: 0,
      materialSlots: 0,
      selection: {
        vertices: { count: 0, sample: [] },
        edges: { count: 0, sample: [] },
        faces: { count: 6, sample: [0, 1, 2, 3, 4, 5] },
      },
      uvLayers: ["UVMap"],
      uvLayerDetails: [{ name: "UVMap", active: true, activeRender: true, loopCount: 24 }],
      colorAttributes: [],
      shapeKeys: [],
    },
    materialNodes: [
      {
        material: "Concrete",
        useNodes: true,
        nodeCount: 2,
        linkCount: 1,
        nodeTypes: { ShaderNodeBsdfPrincipled: 1, ShaderNodeOutputMaterial: 1 },
        principled: {
          baseColor: [0.4, 0.5, 0.6],
          roughness: 0.18,
          metallic: 0.9,
          alpha: 1,
        },
      },
    ],
    materialSlots: [
      {
        index: 0,
        name: "Concrete",
        link: "DATA",
        resolvedMaterial: "Concrete",
        dataMaterial: "Concrete",
      },
    ],
    materialGraphs: [
      {
        materialName: "Concrete",
        objectIds: ["mesh-a", "mesh-shared"],
        activeOutputNodeRef: "node-output",
        nodes: [
          {
            nodeRef: "node-texcoord",
            name: "Texture Coordinate",
            label: "",
            nodeType: "TEX_COORD",
            blenderType: "ShaderNodeTexCoord",
            activeOutput: false,
            location: [-520, 40],
            inputs: [],
            outputs: [
              {
                socketRef: "Generated",
                name: "Generated",
                type: "VECTOR",
                linked: false,
                enabled: true,
                multiInput: false,
              },
            ],
          },
          {
            nodeRef: "node-mapping",
            name: "Mapping",
            label: "",
            nodeType: "MAPPING",
            blenderType: "ShaderNodeMapping",
            activeOutput: false,
            location: [-300, 40],
            inputs: [
              {
                socketRef: "Vector",
                name: "Vector",
                type: "VECTOR",
                linked: false,
                enabled: true,
                multiInput: false,
                defaultValue: [0, 0, 0],
              },
            ],
            outputs: [
              {
                socketRef: "Vector",
                name: "Vector",
                type: "VECTOR",
                linked: false,
                enabled: true,
                multiInput: false,
              },
            ],
          },
          {
            nodeRef: "node-principled",
            name: "Principled BSDF",
            label: "Clay",
            nodeType: "PRINCIPLED_BSDF",
            blenderType: "ShaderNodeBsdfPrincipled",
            activeOutput: false,
            location: [0, 40],
            inputs: [
              {
                socketRef: "Base Color",
                name: "Base Color",
                type: "RGBA",
                linked: false,
                enabled: true,
                multiInput: false,
                defaultValue: [0.4, 0.5, 0.6, 1],
              },
              {
                socketRef: "Roughness",
                name: "Roughness",
                type: "VALUE",
                linked: false,
                enabled: true,
                multiInput: false,
                defaultValue: 0.72,
              },
              {
                socketRef: "Metallic",
                name: "Metallic",
                type: "VALUE",
                linked: false,
                enabled: true,
                multiInput: false,
                defaultValue: 0.08,
              },
              {
                socketRef: "Alpha",
                name: "Alpha",
                type: "VALUE",
                linked: false,
                enabled: true,
                multiInput: false,
                defaultValue: 1,
              },
            ],
            outputs: [
              {
                socketRef: "BSDF",
                name: "BSDF",
                type: "SHADER",
                linked: true,
                enabled: true,
                multiInput: false,
              },
            ],
          },
          {
            nodeRef: "node-output",
            name: "Material Output",
            label: "",
            nodeType: "MATERIAL_OUTPUT",
            blenderType: "ShaderNodeOutputMaterial",
            activeOutput: true,
            location: [260, 40],
            inputs: [
              {
                socketRef: "Surface",
                name: "Surface",
                type: "SHADER",
                linked: true,
                enabled: true,
                multiInput: false,
              },
            ],
            outputs: [],
          },
        ],
        links: [
          {
            from: { nodeRef: "node-principled", socketRef: "BSDF" },
            to: { nodeRef: "node-output", socketRef: "Surface" },
          },
        ],
      },
    ],
    animation: {
      action: null,
      fCurveCount: 0,
      keyframeCount: 0,
      driverCount: 0,
      nlaTrackCount: 0,
      nlaStripCount: 0,
    },
    warnings: [],
  };
}

function sceneSnapshot(revision: number, directorId?: string): BlenderLiveSceneSnapshot {
  return {
    contract: BLENDER_LIVE_CONTRACT,
    sceneEpoch,
    revision,
    sceneName: "Scene",
    frame: 1,
    unit: "meter",
    coordinateSystem: "right-handed-y-up-negative-z-forward",
    objects: [
      {
        id: "mesh-a",
        ...(directorId ? { directorId } : {}),
        name: "Mesh A",
        type: "MESH",
        kind: "mesh",
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        localTransform: {
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        },
        dimensions: [2, 1, 3],
        visible: true,
        collections: ["Collection"],
        parentId: null,
        modifierCount: 0,
        constraints: [],
      },
      {
        id: "camera-a",
        name: "Camera A",
        type: "CAMERA",
        kind: "camera",
        position: [4, 3, 4],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        localTransform: {
          position: [4, 3, 4],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        },
        dimensions: [1, 1, 1],
        visible: true,
        collections: ["Collection"],
        parentId: null,
        modifierCount: 0,
        constraints: [],
      },
    ],
    cameras: [],
    lights: [],
    selectedObjectIds: ["mesh-a"],
    activeObjectId: "mesh-a",
  };
}

describe("Blender native mesh editor", () => {
  beforeEach(() => {
    useBlenderRuntimeStore.getState().reset();
    vi.clearAllMocks();
    let revision = 4;
    let mode: "OBJECT" | "EDIT" = "OBJECT";
    let assignedMaterial: {
      name: string;
      parameters: Record<string, unknown>;
    } | null = null;
    live.status.mockResolvedValue({
      available: true,
      ok: true,
      contract: BLENDER_LIVE_CONTRACT,
      blenderVersion: "5.1.2",
      revision,
      sceneEpoch,
      busy: false,
    });
    live.scene.mockImplementation(async () => sceneSnapshot(revision));
    live.inspect.mockImplementation(async () => {
      const current = inspection(mode);
      if (!assignedMaterial || assignedMaterial.name === "Concrete") return { inspection: current };
      return {
        inspection: {
          ...current,
          materialNodes: [
            ...current.materialNodes,
            {
              material: assignedMaterial.name,
              useNodes: true,
              nodeCount: 2,
              linkCount: 1,
              nodeTypes: {
                ShaderNodeBsdfPrincipled: 1,
                ShaderNodeOutputMaterial: 1,
              },
              principled: assignedMaterial.parameters,
            },
          ],
          materialSlots: [
            ...current.materialSlots,
            {
              index: 1,
              name: assignedMaterial.name,
              link: "DATA",
              resolvedMaterial: assignedMaterial.name,
              dataMaterial: assignedMaterial.name,
            },
          ],
        },
      };
    });
    live.apply.mockImplementation(async (options: { operations: Array<Record<string, unknown>> }) => {
      const operation = options.operations[0] ?? {};
      if (operation.op === "set_selection") mode = operation.mode as "OBJECT" | "EDIT";
      if (operation.op === "assign_material") {
        assignedMaterial = {
          name: String(operation.materialName),
          parameters: operation.parameters as Record<string, unknown>,
        };
      }
      const mutatesGeometry = [
        "invoke_operator",
        "assign_material",
        "project_uv",
        "create_material_node",
        "delete_material_node",
        "set_material_node_input",
        "connect_material_nodes",
        "disconnect_material_node_input",
      ].includes(String(operation.op));
      const revisionBefore = revision;
      if (mutatesGeometry) revision += 1;
      const dirtyObjectIds = mutatesGeometry ? ["mesh-a"] : [];
      return {
        job: {},
        receipt: {
          contract: BLENDER_LIVE_CONTRACT,
          sceneEpoch,
          requestId,
          revisionBefore,
          revisionAfter: revision,
          createdObjectIds: [],
          changedObjectIds: dirtyObjectIds,
          deletedObjectIds: [],
          dirtyObjectIds,
          selection: {
            mode,
            activeObjectId: "mesh-a",
            selectedObjectIds: ["mesh-a"],
          },
          metrics: {
            before: { entities: 2, objects: 2, cameras: 1, lights: 0 },
            after: { entities: 2, objects: 2, cameras: 1, lights: 0 },
          },
          operations: [],
          warnings: [],
        },
        evidence: {
          sceneEpoch,
          revision,
          objects: [],
          cameras: [],
          lights: [],
        },
      };
    });
    useBlenderRuntimeStore.getState().publishStatus({
      available: true,
      ok: true,
      contract: BLENDER_LIVE_CONTRACT,
      blenderVersion: "5.1.2",
      revision: 4,
      sceneEpoch,
      busy: false,
    });
    useBlenderRuntimeStore.getState().publishSnapshot(sceneSnapshot(4));
  });

  it("keeps Blender's active mesh inside the selected Director root", () => {
    const base = sceneSnapshot(4);
    const mesh = base.objects[0]!;
    const snapshot: BlenderLiveSceneSnapshot = {
      ...base,
      activeObjectId: "mesh-b",
      selectedObjectIds: ["mesh-b"],
      objects: [
        {
          ...mesh,
          id: "asset-root",
          name: "Asset root",
          type: "EMPTY",
          parentId: null,
        },
        { ...mesh, id: "mesh-a", name: "Mesh A", parentId: "asset-root" },
        { ...mesh, id: "mesh-b", name: "Mesh B", parentId: "asset-root" },
        { ...mesh, id: "mesh-outside", name: "Outside mesh", parentId: null },
      ],
    };

    expect(findPreferredBlenderMeshId(snapshot, "asset-root")).toBe("mesh-b");
    expect(findBlenderMeshesForObject(snapshot, "asset-root").map((mesh) => mesh.id)).toEqual(["mesh-a", "mesh-b"]);
  });

  it("keeps object editing and creation inside the current Director project", async () => {
    const user = userEvent.setup();
    render(<BlenderLivePanel />);

    const panel = await screen.findByRole("region", { name: "Blender 场景" });
    expect(within(panel).queryByRole("region", { name: "Director 集成" })).toBeNull();
    expect(within(panel).getByRole("tab", { name: "对象编辑" })).toBeTruthy();
    expect(within(panel).getByText("Director 管理")).toBeTruthy();
    expect(within(panel).queryByRole("group", { name: "Blender 白膜预设" })).toBeNull();

    await user.click(within(panel).getByRole("tab", { name: "创建" }));

    expect(within(panel).getByRole("group", { name: "Blender 白膜预设" })).toBeTruthy();
    expect(within(panel).queryByRole("region", { name: "网格编辑" })).toBeNull();
  });

  it("consumes the shared runtime snapshot without starting another scene read", async () => {
    useBlenderRuntimeStore.getState().publishStatus({
      available: true,
      ok: true,
      contract: BLENDER_LIVE_CONTRACT,
      blenderVersion: "5.1.2",
      revision: 4,
      sceneEpoch,
      busy: false,
    });
    useBlenderRuntimeStore.getState().publishSnapshot(sceneSnapshot(4));

    render(<BlenderLivePanel />);

    await screen.findByRole("region", { name: "网格编辑" });
    expect(live.status).not.toHaveBeenCalled();
    expect(live.scene).not.toHaveBeenCalled();
    expect(live.inspect).toHaveBeenCalledTimes(1);
  });

  it("shows the stable Director link inherited by a native mesh", async () => {
    useBlenderRuntimeStore.getState().publishSnapshot(sceneSnapshot(5, "director-mesh-a"));
    render(<BlenderLivePanel />);

    const editor = await screen.findByRole("region", { name: "网格编辑" });
    expect(within(editor).getByText("Director 已关联")).toBeTruthy();
    expect(within(editor).getByText("director-mesh-a")).toBeTruthy();
  });

  it("uses typed Blender transactions for mode, domain, selection, and mesh edits", async () => {
    const user = userEvent.setup();
    render(<BlenderLivePanel />);

    const editor = await screen.findByRole("region", { name: "网格编辑" });
    expect(
      (
        within(editor).getByRole("combobox", {
          name: "活动 Mesh",
        }) as HTMLSelectElement
      ).value,
    ).toBe("mesh-a");

    await user.click(within(editor).getByRole("button", { name: "Edit" }));
    await waitFor(() =>
      expect(live.apply).toHaveBeenLastCalledWith(
        expect.objectContaining({
          expectedSceneEpoch: sceneEpoch,
          expectedRevision: 4,
          operations: [
            {
              op: "set_selection",
              selectedIds: ["mesh-a"],
              activeId: "mesh-a",
              mode: "EDIT",
            },
          ],
        }),
      ),
    );

    await user.click(within(editor).getByRole("button", { name: "边" }));
    await waitFor(() =>
      expect(live.apply).toHaveBeenLastCalledWith(
        expect.objectContaining({
          expectedRevision: 4,
          operations: [
            {
              op: "select_mesh_elements",
              id: "mesh-a",
              domain: "EDGE",
              indices: [],
              action: "NONE",
            },
          ],
        }),
      ),
    );

    await user.click(within(editor).getByRole("button", { name: "全选" }));
    await waitFor(() =>
      expect(live.apply).toHaveBeenLastCalledWith(
        expect.objectContaining({
          expectedRevision: 4,
          operations: [
            {
              op: "select_mesh_elements",
              id: "mesh-a",
              domain: "EDGE",
              indices: [],
              action: "ALL",
            },
          ],
        }),
      ),
    );

    await user.click(within(editor).getByRole("button", { name: "细分" }));
    await waitFor(() =>
      expect(live.apply).toHaveBeenLastCalledWith(
        expect.objectContaining({
          expectedRevision: 4,
          operations: [
            expect.objectContaining({
              op: "invoke_operator",
              operator: "mesh.subdivide",
            }),
          ],
        }),
      ),
    );
    expect((await within(editor).findByRole("status")).textContent).toContain("rev 4 → 5");
    expect(live.inspect).toHaveBeenCalledWith("mesh-a", {
      expectedSceneEpoch: sceneEpoch,
      expectedRevision: 5,
    });
    expect(live.preview).not.toHaveBeenCalled();
  });

  it("uses semantic material and UV transactions from compact mesh tabs", async () => {
    const user = userEvent.setup();
    render(<BlenderLivePanel />);

    const editor = await screen.findByRole("region", { name: "网格编辑" });
    await user.click(within(editor).getByRole("tab", { name: "材质" }));
    const materialEditor = within(editor).getByRole("region", {
      name: "Blender 材质编辑",
    });
    expect((within(materialEditor).getByLabelText("粗糙度") as HTMLInputElement).value).toBe("0.72");
    await user.selectOptions(within(materialEditor).getByRole("combobox", { name: "材质" }), "__new_material__");
    const name = within(materialEditor).getByLabelText("名称");
    await user.clear(name);
    await user.type(name, "Director Clay");
    fireEvent.change(within(materialEditor).getByLabelText("基础颜色"), {
      target: { value: "#804020" },
    });
    expect(within(materialEditor).getByRole("button", { name: "保留" }).getAttribute("aria-pressed")).toBe("true");
    await user.click(within(materialEditor).getByRole("button", { name: "新建并应用" }));

    await waitFor(() =>
      expect(live.apply).toHaveBeenLastCalledWith(
        expect.objectContaining({
          expectedSceneEpoch: sceneEpoch,
          expectedRevision: 4,
          operations: [
            {
              op: "assign_material",
              id: "mesh-a",
              materialName: "Director Clay",
              createIfMissing: true,
              faceScope: "PRESERVE",
              parameters: {
                baseColor: hexToLinearRgb("#804020"),
                roughness: 0.55,
                metallic: 0,
                alpha: 1,
              },
            },
          ],
        }),
      ),
    );
    await waitFor(() => expect(within(editor).getByRole("status").textContent).toContain("rev 4 → 5"));
    await waitFor(() =>
      expect(
        (
          within(materialEditor).getByRole("combobox", {
            name: "材质",
          }) as HTMLSelectElement
        ).value,
      ).toBe("Director Clay"),
    );

    await user.click(within(editor).getByRole("tab", { name: "UV" }));
    const uvEditor = within(editor).getByRole("region", {
      name: "Blender UV 编辑",
    });
    expect(within(uvEditor).getByText("1 · 24 个循环").textContent).toBe("1 · 24 个循环");
    await user.click(within(uvEditor).getByRole("button", { name: "立方体" }));
    const replaceUv = within(uvEditor).getByRole("checkbox", {
      name: "替换同名 UV 层",
    }) as HTMLInputElement;
    expect(replaceUv.checked).toBe(false);
    expect(
      (
        within(uvEditor).getByRole("button", {
          name: "生成 UV",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(within(uvEditor).getByText("同名 UV 层已存在；开启替换后再执行。")).toBeTruthy();
    await user.click(replaceUv);
    await user.click(within(uvEditor).getByRole("button", { name: "生成 UV" }));

    await waitFor(() =>
      expect(live.apply).toHaveBeenLastCalledWith(
        expect.objectContaining({
          expectedSceneEpoch: sceneEpoch,
          expectedRevision: 5,
          operations: [
            {
              op: "project_uv",
              id: "mesh-a",
              method: "CUBE",
              uvLayerName: "UVMap",
              replaceExisting: true,
            },
          ],
        }),
      ),
    );
    expect(live.preview).not.toHaveBeenCalled();
  });

  it("edits the selected Blender material without creating a duplicate", async () => {
    const user = userEvent.setup();
    render(<BlenderLivePanel />);

    const editor = await screen.findByRole("region", { name: "网格编辑" });
    await user.click(within(editor).getByRole("tab", { name: "材质" }));
    const materialEditor = within(editor).getByRole("region", {
      name: "Blender 材质编辑",
    });
    expect(
      (
        within(materialEditor).getByRole("combobox", {
          name: "材质",
        }) as HTMLSelectElement
      ).value,
    ).toBe("Concrete");
    await user.click(within(materialEditor).getByRole("button", { name: "全部面" }));
    await user.click(within(materialEditor).getByRole("button", { name: "应用材质" }));

    await waitFor(() =>
      expect(live.apply).toHaveBeenLastCalledWith(
        expect.objectContaining({
          expectedSceneEpoch: sceneEpoch,
          expectedRevision: 4,
          operations: [
            expect.objectContaining({
              op: "assign_material",
              id: "mesh-a",
              materialName: "Concrete",
              createIfMissing: false,
              faceScope: "ALL",
              parameters: expect.objectContaining({
                roughness: 0.72,
                metallic: 0.08,
                alpha: 1,
              }),
            }),
          ],
        }),
      ),
    );
  });

  it("keeps the last inspected UV layers when projection fails", async () => {
    live.apply.mockRejectedValueOnce(new Error("UV projection rejected."));
    const user = userEvent.setup();
    render(<BlenderLivePanel />);

    const editor = await screen.findByRole("region", { name: "网格编辑" });
    await user.click(within(editor).getByRole("tab", { name: "UV" }));
    const uvEditor = within(editor).getByRole("region", {
      name: "Blender UV 编辑",
    });
    const replaceUv = within(uvEditor).getByRole("checkbox", {
      name: "替换同名 UV 层",
    }) as HTMLInputElement;
    await user.click(replaceUv);
    await user.click(within(uvEditor).getByRole("button", { name: "生成 UV" }));

    await screen.findByText("UV projection rejected.");
    expect(within(uvEditor).getByText("1 · 24 个循环").textContent).toBe("1 · 24 个循环");
    expect(replaceUv.checked).toBe(true);
  });

  it("edits the inspected material graph through receipt-backed semantic operations", async () => {
    const user = userEvent.setup();
    render(<BlenderLivePanel />);

    const editor = await screen.findByRole("region", { name: "网格编辑" });
    await user.click(within(editor).getByRole("tab", { name: "材质" }));
    const materialEditor = within(editor).getByRole("region", {
      name: "Blender 材质编辑",
    });
    await user.click(within(materialEditor).getByText("材质节点"));
    const nodeEditor = within(materialEditor).getByRole("region", {
      name: "材质节点编辑",
    });

    expect(within(materialEditor).getByText("4 节点 · 1 连接").textContent).toBe("4 节点 · 1 连接");
    expect(within(materialEditor).getByText("2 个对象使用").textContent).toBe("2 个对象使用");

    await user.selectOptions(within(nodeEditor).getByRole("combobox", { name: "节点类型" }), "MAPPING");
    await user.type(within(nodeEditor).getByRole("textbox", { name: "节点标签" }), "Texture scale");
    await user.click(within(nodeEditor).getByRole("button", { name: "添加节点" }));
    await waitFor(() =>
      expect(live.apply).toHaveBeenLastCalledWith(
        expect.objectContaining({
          expectedSceneEpoch: sceneEpoch,
          expectedRevision: 4,
          operations: [
            {
              op: "create_material_node",
              id: "mesh-a",
              materialName: "Concrete",
              nodeRef: "mapping",
              nodeType: "MAPPING",
              label: "Texture scale",
            },
          ],
        }),
      ),
    );

    await user.selectOptions(within(nodeEditor).getByRole("combobox", { name: "节点" }), "node-principled");
    fireEvent.change(within(nodeEditor).getByRole("spinbutton", { name: "Roughness" }), {
      target: { value: "0.63" },
    });
    await user.click(within(nodeEditor).getByRole("button", { name: "设置 Roughness" }));
    await waitFor(() =>
      expect(live.apply).toHaveBeenLastCalledWith(
        expect.objectContaining({
          expectedRevision: 5,
          operations: [
            {
              op: "set_material_node_input",
              id: "mesh-a",
              materialName: "Concrete",
              nodeRef: "node-principled",
              inputSocketRef: "Roughness",
              value: 0.63,
            },
          ],
        }),
      ),
    );

    await user.click(within(nodeEditor).getByRole("button", { name: "连接" }));
    await waitFor(() =>
      expect(live.apply).toHaveBeenLastCalledWith(
        expect.objectContaining({
          expectedRevision: 6,
          operations: [
            {
              op: "connect_material_nodes",
              id: "mesh-a",
              materialName: "Concrete",
              from: { nodeRef: "node-texcoord", socketRef: "Generated" },
              to: { nodeRef: "node-mapping", socketRef: "Vector" },
            },
          ],
        }),
      ),
    );

    await user.click(within(nodeEditor).getByRole("button", { name: /断开.*Surface/ }));
    await waitFor(() =>
      expect(live.apply).toHaveBeenLastCalledWith(
        expect.objectContaining({
          expectedRevision: 7,
          operations: [
            {
              op: "disconnect_material_node_input",
              id: "mesh-a",
              materialName: "Concrete",
              nodeRef: "node-output",
              inputSocketRef: "Surface",
            },
          ],
        }),
      ),
    );

    await user.click(within(nodeEditor).getByRole("button", { name: "删除节点 Clay" }));
    await waitFor(() =>
      expect(live.apply).toHaveBeenLastCalledWith(
        expect.objectContaining({
          expectedRevision: 8,
          operations: [
            {
              op: "delete_material_node",
              id: "mesh-a",
              materialName: "Concrete",
              nodeRef: "node-principled",
            },
          ],
        }),
      ),
    );
    expect(live.inspect).toHaveBeenCalledWith("mesh-a", {
      expectedSceneEpoch: sceneEpoch,
      expectedRevision: 9,
    });
    expect(live.preview).not.toHaveBeenCalled();
  });

  it("keeps the last inspected node graph when a mutation fails", async () => {
    live.apply.mockRejectedValueOnce(new Error("Node edit rejected."));
    const user = userEvent.setup();
    render(<BlenderLivePanel />);

    const editor = await screen.findByRole("region", { name: "网格编辑" });
    await user.click(within(editor).getByRole("tab", { name: "材质" }));
    const materialEditor = within(editor).getByRole("region", {
      name: "Blender 材质编辑",
    });
    await user.click(within(materialEditor).getByText("材质节点"));
    const nodeEditor = within(materialEditor).getByRole("region", {
      name: "材质节点编辑",
    });
    await user.selectOptions(within(nodeEditor).getByRole("combobox", { name: "节点" }), "node-principled");
    const roughness = within(nodeEditor).getByRole("spinbutton", {
      name: "Roughness",
    }) as HTMLInputElement;
    fireEvent.change(roughness, { target: { value: "0.33" } });
    await user.click(within(nodeEditor).getByRole("button", { name: "设置 Roughness" }));

    await screen.findByText("Node edit rejected.");
    await waitFor(() => expect(roughness.value).toBe("0.72"));
    expect(
      (
        within(nodeEditor).getByRole("combobox", {
          name: "节点",
        }) as HTMLSelectElement
      ).value,
    ).toBe("node-principled");
    expect(within(materialEditor).getByText("4 节点 · 1 连接").textContent).toBe("4 节点 · 1 连接");
  });

  it("requests the shared scene poller after an epoch or revision conflict", async () => {
    live.apply.mockRejectedValueOnce(new BlenderLiveClientError("Blender scene changed.", 409, "conflict"));
    const user = userEvent.setup();
    render(<BlenderLivePanel />);

    const editor = await screen.findByRole("region", { name: "网格编辑" });
    const refreshesBeforeApply = useBlenderRuntimeStore.getState().refreshRequestId;
    await user.click(within(editor).getByRole("button", { name: "Edit" }));

    await screen.findByText("Blender scene changed.");
    expect(useBlenderRuntimeStore.getState().refreshRequestId).toBe(refreshesBeforeApply + 1);
    expect(live.scene).not.toHaveBeenCalled();
    expect(live.inspect).toHaveBeenCalledWith("mesh-a", {
      expectedSceneEpoch: sceneEpoch,
      expectedRevision: 4,
    });
    expect(live.preview).not.toHaveBeenCalled();
  });

  it("retries one bound inspection when the shared poller publishes a fresh snapshot", async () => {
    const nextSceneEpoch = "1851dbd3-0dbd-4c90-b810-02d64c209e17";
    const refreshed = { ...sceneSnapshot(5), sceneEpoch: nextSceneEpoch };
    live.inspect
      .mockRejectedValueOnce(new BlenderLiveClientError("The first snapshot is stale.", 409, "revision_conflict"))
      .mockResolvedValueOnce({ inspection: inspection("OBJECT") });

    render(<BlenderLivePanel />);

    await screen.findByText("The first snapshot is stale.");
    act(() => useBlenderRuntimeStore.getState().publishSnapshot(refreshed));
    await waitFor(() => expect(live.inspect).toHaveBeenCalledTimes(2));
    expect(live.scene).not.toHaveBeenCalled();
    expect(live.inspect).toHaveBeenNthCalledWith(1, "mesh-a", {
      expectedSceneEpoch: sceneEpoch,
      expectedRevision: 4,
    });
    expect(live.inspect).toHaveBeenNthCalledWith(2, "mesh-a", {
      expectedSceneEpoch: nextSceneEpoch,
      expectedRevision: 5,
    });
    expect(useBlenderRuntimeStore.getState().snapshot?.revision).toBe(5);
  });

  it("shows the connection state and launch guidance while Blender is offline", async () => {
    useBlenderRuntimeStore.getState().publishStatus({
      available: false,
      contract: BLENDER_LIVE_CONTRACT,
      reason: "Blender session is not reachable.",
    });

    render(<BlenderLivePanel />);

    const panel = await screen.findByRole("region", { name: "Blender 场景" });
    await within(panel).findByText("Blender 未连接");
    expect(within(panel).getByText("未连接")).toBeTruthy();
    expect(within(panel).getByText("npm run blender")).toBeTruthy();
    expect(within(panel).queryByRole("tab", { name: "对象编辑" })).toBeNull();

    const user = userEvent.setup();
    await user.click(within(panel).getByRole("button", { name: "重新检测" }));
    const refreshRequestId = useBlenderRuntimeStore.getState().refreshRequestId;
    act(() => {
      useBlenderRuntimeStore.getState().publishStatus({
        available: true,
        ok: true,
        contract: BLENDER_LIVE_CONTRACT,
        blenderVersion: "5.1.2",
        revision: 4,
        sceneEpoch,
        busy: false,
      });
      useBlenderRuntimeStore.getState().publishSnapshot(sceneSnapshot(4));
      useBlenderRuntimeStore.getState().completeRefresh(refreshRequestId);
    });

    await within(panel).findByRole("tab", { name: "对象编辑" });
    expect(within(panel).getByText("已连接")).toBeTruthy();
    expect(within(panel).getByText(/Blender 5\.1\.2/)).toBeTruthy();
    expect(within(panel).queryByText("Blender 未连接")).toBeNull();
  });

  it("shows the live session identity in the connected header", async () => {
    useBlenderRuntimeStore.getState().publishStatus({
      available: true,
      ok: true,
      contract: BLENDER_LIVE_CONTRACT,
      blenderVersion: "5.1.2",
      revision: 4,
      sceneEpoch,
      busy: false,
    });
    useBlenderRuntimeStore.getState().publishSnapshot(sceneSnapshot(4));

    render(<BlenderLivePanel />);

    const header = await screen.findByRole("group", { name: "Blender 连接状态" });
    expect(within(header).getByText("已连接")).toBeTruthy();
    expect(within(header).getByText("Blender 5.1.2 · rev 4")).toBeTruthy();
    expect(within(header).getByRole("button", { name: "刷新" })).toBeTruthy();
  });

  it("distinguishes success and error notices by tone", async () => {
    const user = userEvent.setup();
    render(<BlenderLivePanel />);

    const editor = await screen.findByRole("region", { name: "网格编辑" });
    await user.click(within(editor).getByRole("button", { name: "Edit" }));
    const success = await screen.findByText("切换 Edit Mode · 完成 · rev 4");
    expect(success.className).toContain("is-success");

    live.apply.mockRejectedValueOnce(new Error("Native edit rejected."));
    await user.click(within(editor).getByRole("button", { name: "Object" }));
    const failure = await screen.findByText("Native edit rejected.");
    expect(failure.className).toContain("is-error");
  });

  it("delegates manual retries to the shared scene poller", async () => {
    useBlenderRuntimeStore.getState().publishStatus({
      available: false,
      contract: BLENDER_LIVE_CONTRACT,
      reason: "Gateway unreachable.",
    });
    const user = userEvent.setup();
    render(<BlenderLivePanel />);

    const retry = await screen.findByRole("button", { name: "重新检测" });
    await user.click(retry);
    const refreshRequestId = useBlenderRuntimeStore.getState().refreshRequestId;
    expect(refreshRequestId).toBe(1);
    expect(screen.getByRole("button", { name: "正在检测…" })).toBeTruthy();
    expect(live.status).not.toHaveBeenCalled();

    act(() => useBlenderRuntimeStore.getState().completeRefresh(refreshRequestId));
    await screen.findByRole("button", { name: "重新检测" });
  });

  it("does not recursively read the scene after repeated inspection conflicts", async () => {
    const nextSceneEpoch = "1851dbd3-0dbd-4c90-b810-02d64c209e17";
    const refreshed = { ...sceneSnapshot(5), sceneEpoch: nextSceneEpoch };
    live.inspect
      .mockRejectedValueOnce(new BlenderLiveClientError("The first snapshot is stale.", 409, "revision_conflict"))
      .mockRejectedValueOnce(
        new BlenderLiveClientError("The refreshed scene also moved.", 409, "scene_epoch_conflict"),
      );

    render(<BlenderLivePanel />);

    await screen.findByText("The first snapshot is stale.");
    act(() => useBlenderRuntimeStore.getState().publishSnapshot(refreshed));
    await screen.findByText("The refreshed scene also moved.");
    expect(live.scene).not.toHaveBeenCalled();
    expect(live.inspect).toHaveBeenCalledTimes(2);
    expect(useBlenderRuntimeStore.getState()).toMatchObject({
      refreshRequestId: 2,
      snapshot: { revision: 5, sceneEpoch: nextSceneEpoch },
    });
  });
});
