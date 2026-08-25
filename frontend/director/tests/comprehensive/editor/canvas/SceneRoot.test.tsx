import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Box3, BoxGeometry, Group, Mesh, MeshBasicMaterial, PerspectiveCamera, Vector3 } from "three";
import { afterEach, beforeEach, vi } from "vitest";
import { VIEWPORT_CAMERA_VISUAL_SCALE } from "../../../../src/comprehensive/editor/schema/cameraGeometry";
import { createInitialDirectorState, useDirectorStore } from "../../../../src/comprehensive/editor/store/directorStore";
import { useBlenderRuntimeStore } from "../../../../src/comprehensive/editor/runtime/blenderRuntimeStore";
import {
  getCenteredControlTransform,
  getImportedModelNormalization,
  getMultiObjectGroupTransform,
  getMultiObjectTransformUpdates,
  getObjectTransformFromCenteredControl,
  getPreciseImportedModelBounds,
  getViewportCameraBodyWireframeLines,
  getViewportCameraFrustumLines,
  getViewportCameraQuaternion,
  getViewportCameraWireframeSegments,
  resolveViewportLabelOffsets,
  SceneRoot,
} from "../../../../src/comprehensive/editor/canvas/SceneRoot";

const mockCharacterModelShouldSuspend = vi.hoisted(() => ({ current: false }));
const mockFailedMixamoUrl = vi.hoisted(() => ({
  current: null as string | null,
}));
const mockViewportScene = vi.hoisted(() => ({ name: "mock-viewport-scene" }));
const mockCreatePortal = vi.hoisted(() =>
  vi.fn((children: React.ReactNode, _container: typeof mockViewportScene) => children),
);

vi.mock("@react-three/fiber", async () => {
  const actual = await vi.importActual<typeof import("@react-three/fiber")>("@react-three/fiber");

  return {
    ...actual,
    createPortal: mockCreatePortal,
    useFrame: () => undefined,
    useThree: (
      selector?: (state: {
        gl: { capabilities: { reversedDepthBuffer?: boolean }; extensions: { has: (name: string) => boolean } };
        scene: typeof mockViewportScene;
      }) => unknown,
    ) => {
      const state = {
        gl: { capabilities: { reversedDepthBuffer: true }, extensions: { has: () => false } },
        scene: mockViewportScene,
      };
      return selector ? selector(state) : state;
    },
  };
});

vi.mock("@react-three/drei", async () => {
  const actual = await vi.importActual<typeof import("@react-three/drei")>("@react-three/drei");

  return {
    ...actual,
    Html: ({
      center,
      children,
      distanceFactor,
      pointerEvents,
      position,
      sprite,
      transform,
      zIndexRange,
    }: {
      center?: boolean;
      children?: React.ReactNode;
      distanceFactor?: number;
      pointerEvents?: string;
      position?: [number, number, number];
      sprite?: boolean;
      transform?: boolean;
      zIndexRange?: [number, number];
    }) => (
      <div
        data-center={center ? "true" : "false"}
        data-distance-factor={distanceFactor}
        data-pointer-events={pointerEvents}
        data-position={JSON.stringify(position)}
        data-sprite={sprite ? "true" : "false"}
        data-testid="html-label"
        data-transform={transform ? "true" : "false"}
        data-z-index-range={JSON.stringify(zIndexRange)}
      >
        {children}
      </div>
    ),
    Line: ({
      color,
      lineWidth,
      name,
      opacity,
      onClick,
      points,
      segments,
      transparent,
    }: {
      color?: string;
      lineWidth?: number;
      name?: string;
      onClick?: React.MouseEventHandler<HTMLDivElement>;
      opacity?: number;
      points?: Array<[number, number, number]>;
      segments?: boolean;
      transparent?: boolean;
    }) => (
      <div
        data-clickable={onClick ? "true" : "false"}
        data-color={color}
        data-line-width={lineWidth}
        data-name={name}
        data-opacity={opacity}
        data-point-count={points?.length}
        data-points={JSON.stringify(points)}
        data-segments={segments ? "true" : "false"}
        data-testid="camera-line"
        data-transparent={transparent ? "true" : "false"}
        onClick={onClick}
      />
    ),
    useProgress: () => ({ progress: 0 }),
    Bounds: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    TransformControls: ({
      children,
      mode,
      object,
      translationSnap,
      userData,
    }: {
      children?: React.ReactNode;
      mode?: string;
      object?: { current: unknown };
      translationSnap?: number | null;
      userData?: Record<string, unknown>;
    }) => (
      <div
        data-has-object={object ? "true" : "false"}
        data-hide-from-capture={userData?.hideFromViewportCapture ? "true" : "false"}
        data-mode={mode}
        data-translation-snap={translationSnap == null ? "null" : String(translationSnap)}
        data-testid="transform-controls"
      >
        {children}
      </div>
    ),
  };
});

vi.mock("../../../../src/comprehensive/editor/runtime/PrimitiveMannequin", () => ({
  PrimitiveMannequin: ({
    bodyType,
    color,
    rigState,
  }: {
    bodyType?: string;
    color?: string;
    rigState?: { rigType?: string };
  }) => (
    <div
      data-body-type={bodyType}
      data-color={color}
      data-rig-type={rigState?.rigType}
      data-testid="mock-primitive-mannequin"
    />
  ),
}));

vi.mock("../../../../src/comprehensive/editor/runtime/CharacterModel", async () => {
  const React = await vi.importActual<typeof import("react")>("react");

  return {
    CharacterModel: ({
      bodyType,
      color,
      onLabelAnchorYChange,
      rigState,
      runtimeControlled,
    }: {
      bodyType?: string;
      color?: string;
      onLabelAnchorYChange?: (anchorY: number) => void;
      rigState?: { rigType?: string; controls?: Record<string, number> };
      runtimeControlled?: boolean;
    }) => {
      if (mockCharacterModelShouldSuspend.current) {
        throw new Promise(() => undefined);
      }

      const labelAnchorY = bodyType === "chibi" ? 0.92 : 2.04;

      React.useLayoutEffect(() => {
        onLabelAnchorYChange?.(labelAnchorY);
      }, [labelAnchorY, onLabelAnchorYChange]);

      return (
        <div
          data-body-type={bodyType}
          data-color={color}
          data-punch={rigState?.controls?.punch}
          data-rig-type={rigState?.rigType}
          data-runtime-controlled={runtimeControlled ? "true" : "false"}
          data-testid="mock-character-model"
        />
      );
    },
  };
});

vi.mock("../../../../src/comprehensive/editor/runtime/MixamoCharacterModel", async () => {
  const React = await vi.importActual<typeof import("react")>("react");

  return {
    MixamoCharacterModel: ({
      bodyType,
      onLabelAnchorYChange,
      onVisualCenterChange,
      rigState,
      runtimeControlled,
      url,
    }: {
      bodyType?: string;
      onLabelAnchorYChange?: (anchorY: number) => void;
      onVisualCenterChange?: (center: [number, number, number]) => void;
      rigState?: {
        rigType?: string;
        controls?: Record<string, number>;
        motion?: { clipId: string; loop: string; startFrame: number };
      };
      runtimeControlled?: boolean;
      url: string;
    }) => {
      if (mockFailedMixamoUrl.current === url) {
        throw new Error(`missing asset: ${url}`);
      }
      if (mockCharacterModelShouldSuspend.current) {
        throw new Promise(() => undefined);
      }

      React.useLayoutEffect(() => {
        onLabelAnchorYChange?.(bodyType === "chibi" ? 0.92 : 1.9);
        onVisualCenterChange?.([0, 0, 0]);
      }, [bodyType, onLabelAnchorYChange, onVisualCenterChange]);

      return (
        <div
          data-body-type={bodyType}
          data-punch={rigState?.controls?.punch}
          data-rig-type={rigState?.rigType}
          data-runtime-controlled={runtimeControlled ? "true" : "false"}
          data-testid="mock-character-model"
          data-url={url}
        >
          <span
            data-motion-clip={rigState?.motion?.clipId}
            data-motion-loop={rigState?.motion?.loop}
            data-motion-start-frame={rigState?.motion?.startFrame}
            data-rig-type={rigState?.rigType}
            data-runtime-controlled={runtimeControlled ? "true" : "false"}
            data-testid="mock-mixamo-character"
            data-url={url}
          />
        </div>
      );
    },
  };
});

vi.mock("../../../../src/comprehensive/editor/canvas/splat/SplatModel", () => ({
  SplatModel: ({
    fileName,
    grounded,
    modelNormalization,
    realWorldSizeM,
    url,
  }: {
    fileName: string;
    grounded?: boolean;
    modelNormalization?: "auto" | "preserve";
    realWorldSizeM?: number;
    url: string;
  }) => (
    <div
      data-file-name={fileName}
      data-grounded={grounded ? "true" : "false"}
      data-normalization={modelNormalization ?? "auto"}
      data-real-world-size={realWorldSizeM}
      data-testid="mock-splat-model"
      data-url={url}
    />
  ),
}));

function projectWithViewportLabels<T extends { scene: { showLabels?: boolean } }>(
  project: T,
  scene: Partial<T["scene"]> = {},
): T {
  return {
    ...project,
    scene: {
      ...project.scene,
      ...scene,
      showLabels: true,
    },
  };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  mockCreatePortal.mockClear();
  mockCharacterModelShouldSuspend.current = false;
  mockFailedMixamoUrl.current = null;
  useBlenderRuntimeStore.getState().reset();
  const base = createInitialDirectorState();
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...base,
    project: {
      ...base.project,
      scene: {
        ...base.project.scene,
        showLabels: true,
      },
      panoramaAssetId: "asset_panorama_1",
      assets: [
        ...base.project.assets,
        {
          id: "asset_panorama_1",
          kind: "panorama",
          sourceType: "image",
          fileName: "studio-360.jpg",
          url: "blob:studio-360",
        },
      ],
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("renders role labels while panorama background is managed by the viewport layer", () => {
  render(<SceneRoot />);

  expect(screen.queryByTestId("panorama-sphere")).not.toBeInTheDocument();
  expect(screen.getByText("角色01")).toBeInTheDocument();
});

it("opts only the runtime transform owner into character locomotion frame work", () => {
  render(<SceneRoot runtimeTransformOwnerId="char_default_a" />);

  expect(screen.getByTestId("mock-character-model")).toHaveAttribute("data-runtime-controlled", "true");
});

it("does not flash the procedural mannequin while the default UE4 role model is loading", () => {
  mockCharacterModelShouldSuspend.current = true;

  render(<SceneRoot />);

  expect(screen.queryByTestId("mock-character-model")).not.toBeInTheDocument();
  expect(screen.queryByTestId("mock-primitive-mannequin")).not.toBeInTheDocument();
  expect(screen.getByText("角色01")).toBeInTheDocument();
  expect(screen.getByText("机位01")).toBeInTheDocument();
});

it("renders role labels as centered screen-space overlays that stay readable in close-ups", () => {
  render(<SceneRoot />);

  const label = screen.getByText("角色01").closest('[data-testid="html-label"]');

  expect(label).toHaveAttribute("data-position", "[0,1.9,0]");
  expect(label).toHaveAttribute("data-center", "true");
  expect(label).toHaveAttribute("data-transform", "false");
  expect(label).toHaveAttribute("data-sprite", "false");
  expect(label).toHaveAttribute("data-pointer-events", "none");
  expect(label).not.toHaveAttribute("data-distance-factor");
  expect(label).toHaveAttribute("data-z-index-range", "[0,1]");
});

it("updates short role labels from the measured character model height", async () => {
  useDirectorStore.getState().updateCharacterBodyType("char_default_a", "chibi");

  render(<SceneRoot />);

  const label = screen.getByText("角色01").closest('[data-testid="html-label"]');

  await waitFor(() => {
    expect(label).toHaveAttribute("data-position", "[0,0.92,0]");
  });
});

it("shows an agent takeover badge inside the label of a possessed character", () => {
  const base = createInitialDirectorState();
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...base,
    project: {
      ...projectWithViewportLabels(base.project),
      objects: base.project.objects.map((item) =>
        item.id === "char_default_a"
          ? { ...item, agentBinding: { mode: "possess" as const, sessionId: "dsh-session-1" } }
          : item,
      ),
    },
  });

  render(<SceneRoot />);

  const badge = screen.getByText("Agent 接管");
  expect(badge).toHaveClass("role-label-agent-badge");
  expect(badge.closest(".role-label")).toHaveTextContent("角色01");
  // The badge lives in the same pointer-transparent overlay, so it cannot
  // block viewport selection or the transform gizmo.
  expect(badge.closest('[data-testid="html-label"]')).toHaveAttribute("data-pointer-events", "none");
});

it("keeps character labels free of the agent badge when no agent is bound", () => {
  render(<SceneRoot />);

  expect(screen.getByText("角色01")).toBeInTheDocument();
  expect(screen.queryByText("Agent 接管")).not.toBeInTheDocument();
});

it("renders every preset through the canonical packaged character while retaining distinct color identities", () => {
  useDirectorStore.getState().addPresetCharacter("female");
  useDirectorStore.getState().addPresetCharacter("teen");

  render(<SceneRoot />);

  const characters = useDirectorStore.getState().project.objects.filter((item) => item.kind === "character");
  const characterColors = characters.map((item) => item.color);

  expect(screen.getAllByTestId("mock-character-model")).toHaveLength(3);
  screen
    .getAllByTestId("mock-character-model")
    .forEach((model) => expect(model).toHaveAttribute("data-url", "/mixamo-characters/models/x-bot.glb"));
  expect(characterColors).toEqual(["#d19a3a", "#4F8EF7", "#E0524D"]);
  expect(new Set(characterColors).size).toBe(characterColors.length);
});

it("renders viewport camera labels with the same readable screen-space behavior as role labels", () => {
  render(<SceneRoot />);

  const label = screen.getByText("机位01").closest('[data-testid="html-label"]');
  const position = JSON.parse(label?.getAttribute("data-position") ?? "[]") as [number, number, number];

  expect(position[0]).toBeCloseTo(0);
  expect(position[1]).toBeCloseTo(0.65 * VIEWPORT_CAMERA_VISUAL_SCALE + 0.18);
  expect(position[2]).toBeCloseTo(0);
  expect(label).toHaveAttribute("data-center", "true");
  expect(label).toHaveAttribute("data-transform", "false");
  expect(label).toHaveAttribute("data-sprite", "false");
  expect(label).toHaveAttribute("data-pointer-events", "none");
  expect(label).not.toHaveAttribute("data-distance-factor");
  expect(label).toHaveAttribute("data-z-index-range", "[0,1]");
});

it("lays out overlapping viewport labels outside the live preview", () => {
  const rect = (left: number, top: number, width: number, height: number) => ({
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
  });
  const overlapArea = (left: ReturnType<typeof rect>, right: ReturnType<typeof rect>) =>
    Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left)) *
    Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top));
  const obstacle = rect(80, 40, 180, 100);
  const labels = [rect(110, 70, 70, 20), rect(110, 70, 70, 20), rect(110, 70, 70, 20)];

  const offsets = resolveViewportLabelOffsets(labels, rect(0, 0, 400, 240), [obstacle]);
  const placed = labels.map((label, index) => {
    const [x, y] = offsets[index];
    return rect(label.left + x, label.top + y, label.width, label.height);
  });

  placed.forEach((label) => expect(overlapArea(label, obstacle)).toBe(0));
  expect(overlapArea(placed[0], placed[1])).toBe(0);
  expect(overlapArea(placed[0], placed[2])).toBe(0);
  expect(overlapArea(placed[1], placed[2])).toBe(0);

  expect(resolveViewportLabelOffsets([rect(110, 170, 70, 20)], rect(0, 0, 400, 240), [], [[108, 48]])).toEqual([
    [0, 0],
  ]);
});

it("keeps legacy projects without optional overlay arrays renderable", () => {
  const state = createInitialDirectorState();
  useDirectorStore.setState({
    ...state,
    project: projectWithViewportLabels(state.project, {
      annotations: undefined,
      measurements: undefined,
    }),
  });

  render(<SceneRoot />);

  expect(screen.getByText("角色01")).toBeInTheDocument();
  expect(screen.getByText("机位01")).toBeInTheDocument();
});

it("does not draw a solid ground plate in the viewport", () => {
  const { container } = render(<SceneRoot />);

  expect(container.querySelector('mesh[name="director-player-ground"]')).not.toBeInTheDocument();
  expect(container.querySelector('meshstandardmaterial[color="#5a5e63"]')).not.toBeInTheDocument();
});

it("renders added geometry primitives as light blue-white models", () => {
  useDirectorStore.getState().addGeometryPrimitive("sphere");

  const { container } = render(<SceneRoot />);

  expect(container.querySelector('mesh[name="geometry-sphere"]')).toBeInTheDocument();
  const sphere = container.querySelector('mesh[name="geometry-sphere"]');
  expect(sphere?.querySelector("spheregeometry")).toHaveAttribute("args", "0.5,32,16");
  expect(container.querySelector('meshstandardmaterial[color="#d7e7ff"]')).toBeInTheDocument();
});

it("keeps static primitives instanced during runtime character control and restores a selected item", async () => {
  const state = useDirectorStore.getState();
  const boxes = Array.from({ length: 5 }, (_, index) => ({
    id: `batch_box_${index}`,
    name: `Batch box ${index}`,
    kind: "prop" as const,
    visible: true,
    locked: false,
    color: index % 2 ? "#f4a261" : "#264653",
    geometryType: "box" as const,
    transform: {
      position: [index * 2, 0, 0] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number],
    },
  }));
  useDirectorStore.setState({
    project: {
      ...state.project,
      objects: [...state.project.objects, ...boxes],
    },
  });

  const { container } = render(<SceneRoot runtimeTransformOwnerId="char_default_a" />);

  expect(container.querySelector('primitive[name="director-primitive-batch-box-0"]')).toBeInTheDocument();

  act(() => useDirectorStore.getState().selectObject("batch_box_2"));

  await waitFor(() => {
    expect(
      container.querySelector('group[name="director-object-batch_box_2"] mesh[name="geometry-box"]'),
    ).toBeInTheDocument();
  });
  expect(container.querySelector('primitive[name="director-primitive-batch-box-0"]')).toBeInTheDocument();
});

it("portals transform controls to the viewport root so scene transforms cannot offset the gizmo", () => {
  useDirectorStore.getState().addGeometryPrimitive("sphere");

  render(<SceneRoot />);

  expect(screen.getByTestId("transform-controls")).toBeInTheDocument();
  expect(mockCreatePortal).toHaveBeenCalledTimes(1);
  expect(mockCreatePortal.mock.calls[0]?.[1]).toBe(mockViewportScene);
});

it("does not render name labels above geometry primitives", () => {
  useDirectorStore.getState().addGeometryPrimitive("sphere");

  render(<SceneRoot />);

  expect(screen.getByText("角色01")).toBeInTheDocument();
  expect(screen.getByText("机位01")).toBeInTheDocument();
  expect(screen.queryByText("球体")).not.toBeInTheDocument();
});

it("grounds the torus geometry primitive on the floor", () => {
  useDirectorStore.getState().addGeometryPrimitive("torus");

  const { container } = render(<SceneRoot />);
  const torus = container.querySelector('mesh[name="geometry-torus"]');
  const geometry = torus?.querySelector("torusgeometry");
  const position = String(torus?.getAttribute("position") ?? "")
    .split(",")
    .map(Number) as [number, number, number];
  const [, tubeRadius] = String(geometry?.getAttribute("args") ?? "")
    .split(",")
    .map(Number);

  expect(torus).toBeInTheDocument();
  expect(position[1] - tubeRadius).toBeCloseTo(0);
});

it("normalizes imported model bounds to a director-desk friendly size on the ground", () => {
  const normalization = getImportedModelNormalization(new Box3(new Vector3(2, -3, -4), new Vector3(12, 2, 2)), 2);

  expect(normalization.scale).toBeCloseTo(0.2);
  expect(normalization.center).toEqual([0, 0, 0]);
  expect(normalization.position[0]).toBeCloseTo(-1.4);
  expect(normalization.position[1]).toBeCloseTo(0.6);
  expect(normalization.position[2]).toBeCloseTo(0.2);
});

it("preserves authored Blender scene scale and origin while exposing its real visual center", () => {
  const normalization = getImportedModelNormalization(
    new Box3(new Vector3(2, -3, -4), new Vector3(12, 2, 2)),
    2,
    "preserve",
  );

  expect(normalization).toEqual({
    center: [7, -0.5, -1],
    position: [0, 0, 0],
    scale: 1,
  });
});

it("grounds a preserved Blender scene by its measured lowest vertex without changing its scale", () => {
  const source = new Group();
  const mesh = new Mesh(new BoxGeometry(2, 4, 2), new MeshBasicMaterial());
  mesh.position.set(3, -6, -2);
  source.add(mesh);

  const normalization = getImportedModelNormalization(getPreciseImportedModelBounds(source), 2, "preserve", true);
  const normalized = new Group();
  normalized.position.set(...normalization.position);
  normalized.scale.setScalar(normalization.scale);
  normalized.add(source);

  const groundedBounds = getPreciseImportedModelBounds(normalized);

  expect(normalization.scale).toBe(1);
  expect(normalization.position).toEqual([0, 8, 0]);
  expect(normalization.center).toEqual([3, 2, -2]);
  expect(groundedBounds.min.y).toBeCloseTo(0, 6);
  expect(groundedBounds.max.y).toBeCloseTo(4, 6);
});

it("places transform controls at the floor pivot while preserving the grounded object transform", () => {
  const objectTransform = {
    position: [4, 0, -2] as [number, number, number],
    rotation: [0, Math.PI / 3, 0] as [number, number, number],
    scale: [2, 3, 4] as [number, number, number],
  };
  const localCenter = [0, 0, 0] as const;
  const centered = getCenteredControlTransform(objectTransform, localCenter);
  const control = new Group();
  control.position.set(...centered.position);
  control.rotation.set(...centered.rotation);
  control.scale.set(...centered.scale);

  expect(centered.position).toEqual([4, 0, -2]);
  expect(getObjectTransformFromCenteredControl(control, localCenter)).toEqual(objectTransform);

  control.position.x += 2;
  const translated = getObjectTransformFromCenteredControl(control, localCenter);
  expect(translated.position).toEqual([6, 0, -2]);
});

it("keeps an asset floor pivot fixed while rotating it through the centered control", () => {
  const localCenter = [0.25, 0, -0.5] as const;
  const control = new Group();
  control.position.set(3, 4, 5);
  control.rotation.set(0.2, Math.PI / 2, -0.1);
  control.scale.set(1.5, 0.75, 2);

  const objectTransform = getObjectTransformFromCenteredControl(control, localCenter);
  const reconstructedControl = getCenteredControlTransform(objectTransform, localCenter);

  reconstructedControl.position.forEach((value, index) => {
    expect(value).toBeCloseTo(control.position.getComponent(index), 6);
  });
});

it("keeps selected objects spaced around their shared center during a group transform", () => {
  const baseObject = createInitialDirectorState().project.objects.find((object) => object.kind === "character")!;
  const objects = [
    {
      ...baseObject,
      id: "left",
      transform: {
        ...baseObject.transform,
        position: [-1, 0, 0] as [number, number, number],
      },
    },
    {
      ...baseObject,
      id: "right",
      transform: {
        ...baseObject.transform,
        position: [1, 0, 0] as [number, number, number],
      },
    },
  ];
  const initialGroupTransform = getMultiObjectGroupTransform(objects);
  const updates = getMultiObjectTransformUpdates(objects, initialGroupTransform, {
    position: [3, 0, 0],
    rotation: [0, Math.PI / 2, 0],
    scale: [1, 1, 1],
  });

  expect(initialGroupTransform.position).toEqual([0, 0, 0]);
  expect(updates[0]!.transform.position[0]).toBeCloseTo(3, 6);
  expect(updates[0]!.transform.position[2]).toBeCloseTo(1, 6);
  expect(updates[1]!.transform.position[0]).toBeCloseTo(3, 6);
  expect(updates[1]!.transform.position[2]).toBeCloseTo(-1, 6);
});

it("rotates composite children around the measured shared floor pivot", () => {
  const base = createInitialDirectorState();
  const parent = {
    id: "composite_parent_test",
    name: "组合对象",
    kind: "prop" as const,
    visible: true,
    locked: false,
    isCompositeParent: true,
    transform: {
      position: [4, 0, 0] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number],
    },
  };
  const child = {
    id: "composite_child_test",
    name: "立方体",
    kind: "prop" as const,
    visible: true,
    locked: false,
    geometryType: "box" as const,
    parentObjectId: parent.id,
    transform: {
      position: [10, 0, 0] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number],
    },
  };
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...base,
    project: {
      ...base.project,
      objects: [parent, child, ...base.project.objects.slice(1)],
    },
  });

  const localCompositeCenter = [6, 0, 0] as const;
  const centered = getCenteredControlTransform(parent.transform, localCompositeCenter);
  const control = new Group();
  control.position.set(...centered.position);
  control.rotation.set(0, Math.PI / 2, 0);
  control.scale.set(...centered.scale);

  useDirectorStore
    .getState()
    .updateObjectTransform(parent.id, getObjectTransformFromCenteredControl(control, localCompositeCenter));

  const transformedChild = useDirectorStore.getState().project.objects.find((item) => item.id === child.id)!;
  const transformedChildCenter = getCenteredControlTransform(transformedChild.transform, [0, 0, 0]).position;
  transformedChildCenter.forEach((value, index) => {
    expect(value).toBeCloseTo(centered.position[index]!, 5);
  });
});

it("grounds transformed imported geometry by its precise lowest vertex", () => {
  const source = new Group();
  const mesh = new Mesh(new BoxGeometry(1, 2, 0.5), new MeshBasicMaterial());
  mesh.position.set(2, -3, 1);
  mesh.rotation.set(0.2, 0.35, Math.PI / 4);
  source.add(mesh);

  const normalization = getImportedModelNormalization(getPreciseImportedModelBounds(source));
  const normalized = new Group();
  normalized.position.set(...normalization.position);
  normalized.scale.setScalar(normalization.scale);
  normalized.add(source);

  const groundedBounds = getPreciseImportedModelBounds(normalized);

  expect(groundedBounds.min.y).toBeCloseTo(0, 6);
  expect(
    Math.max(
      groundedBounds.max.x - groundedBounds.min.x,
      groundedBounds.max.y - groundedBounds.min.y,
      groundedBounds.max.z - groundedBounds.min.z,
    ),
  ).toBeCloseTo(2, 6);
});

it("wraps each imported model in its own loading boundary so the rest of the scene stays mounted", () => {
  const base = createInitialDirectorState();
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...base,
    project: {
      ...projectWithViewportLabels(base.project),
      assets: [
        {
          id: "asset_model_1",
          kind: "prop",
          sourceType: "model",
          fileName: "microwave_low.fbx",
          url: "blob:microwave",
        },
      ],
      objects: [
        ...base.project.objects,
        {
          id: "obj_model_1",
          name: "微波炉",
          kind: "prop",
          visible: true,
          locked: false,
          assetRefId: "asset_model_1",
          transform: {
            position: [0, 0, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
          },
        },
      ],
    },
  });

  render(<SceneRoot />);

  expect(screen.getByText("角色01")).toBeInTheDocument();
  expect(screen.getByText("机位01")).toBeInTheDocument();
});

it("renders gaussian splat assets through the Spark splat branch instead of the mesh loaders", () => {
  const base = createInitialDirectorState();
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...base,
    project: {
      ...base.project,
      assets: [
        {
          id: "asset_splat_1",
          kind: "prop",
          sourceType: "model",
          fileName: "garden.spz",
          url: "/native-models/asset-splat/garden.spz",
          realWorldSizeM: 12,
          sizeSource: "user",
        },
      ],
      objects: [
        ...base.project.objects,
        {
          id: "obj_splat_1",
          name: "花园扫描",
          kind: "prop",
          visible: true,
          locked: false,
          assetRefId: "asset_splat_1",
          placementMode: "grounded",
          transform: {
            position: [0, 0, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
          },
        },
      ],
    },
  });

  render(<SceneRoot />);

  const splat = screen.getByTestId("mock-splat-model");
  expect(splat).toHaveAttribute("data-url", "/native-models/asset-splat/garden.spz");
  expect(splat).toHaveAttribute("data-file-name", "garden.spz");
  expect(splat).toHaveAttribute("data-grounded", "true");
  expect(splat).toHaveAttribute("data-real-world-size", "12");
});

it("routes 4DGS sequence manifests into the splat branch with their manifest file name", () => {
  const base = createInitialDirectorState();
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...base,
    project: {
      ...base.project,
      assets: [
        {
          id: "asset_splat_seq_1",
          kind: "prop",
          sourceType: "model",
          fileName: "dance.4dgs.json",
          url: "/native-models/asset-dance/dance.4dgs.json",
          splatSequence: { frameCount: 48, fps: 24 },
        },
      ],
      objects: [
        ...base.project.objects,
        {
          id: "obj_splat_seq_1",
          name: "舞蹈序列",
          kind: "prop",
          visible: true,
          locked: false,
          assetRefId: "asset_splat_seq_1",
          transform: {
            position: [0, 0, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
          },
        },
      ],
    },
  });

  render(<SceneRoot />);

  const splat = screen.getByTestId("mock-splat-model");
  expect(splat).toHaveAttribute("data-file-name", "dance.4dgs.json");
  expect(splat).toHaveAttribute("data-url", "/native-models/asset-dance/dance.4dgs.json");
});

it("renders imported character assets through the Mixamo runtime with their packaged URL", () => {
  const base = createInitialDirectorState();
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...base,
    project: {
      ...projectWithViewportLabels(base.project),
      assets: [
        {
          id: "asset_mixamo_1",
          kind: "character",
          sourceType: "model",
          fileName: "astronaut.glb",
          name: "Astronaut",
          url: "/mixamo-characters/models/astronaut.glb",
          assetSource: "library",
          characterMetadata: {
            heightM: 1.78,
            groundOffsetY: 0,
            visualCenter: [0, 0.89, 0],
            labelAnchorY: 1.9,
            rig: { type: "mixamo", boneCount: 65 },
          },
        },
      ],
      objects: [
        ...base.project.objects,
        {
          id: "obj_mixamo_1",
          name: "Astronaut",
          kind: "character",
          visible: true,
          locked: false,
          assetRefId: "asset_mixamo_1",
          placementMode: "grounded",
          characterRig: {
            rigType: "mixamo",
            posePresetId: "stand",
            controls: {},
          },
          transform: {
            position: [0, 0, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
          },
        },
      ],
    },
  });

  render(<SceneRoot />);

  expect(screen.getByTestId("mock-mixamo-character")).toHaveAttribute(
    "data-url",
    "/mixamo-characters/models/astronaut.glb",
  );
  expect(screen.getByTestId("mock-mixamo-character")).toHaveAttribute("data-rig-type", "mixamo");
  expect(screen.getByText("Astronaut")).toBeInTheDocument();
});

it("keeps a provisioned Mixamo character visible while the native preview is live", () => {
  const base = createInitialDirectorState();
  const character = base.project.objects.find((item) => item.id === "char_default_a")!;
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...base,
    project: {
      ...base.project,
      objects: base.project.objects.map((item) =>
        item.id === character.id
          ? {
              ...item,
              nativeSource: {
                engine: "blender" as const,
                objectId: item.id,
                provisioned: true,
              },
            }
          : item,
      ),
    },
  });

  const { rerender } = render(<SceneRoot />);
  expect(screen.getByTestId("mock-mixamo-character")).toBeInTheDocument();

  useBlenderRuntimeStore.getState().publishPreviewActive(true);
  rerender(<SceneRoot />);
  expect(screen.getByTestId("mock-mixamo-character")).toBeInTheDocument();
});

it("uses trajectory locomotion while moving and restores an authored one-shot after the path", () => {
  const base = createInitialDirectorState();
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...base,
    project: {
      ...base.project,
      objects: base.project.objects.map((item) =>
        item.id === "char_default_a"
          ? {
              ...item,
              characterRig: {
                ...item.characterRig!,
                motion: {
                  clipId: "wave",
                  enabled: true,
                  loop: "once" as const,
                  speed: 1,
                  weight: 1,
                  startFrame: 8,
                  blendInS: 0.12,
                  blendOutS: 0.15,
                  rootMotion: "in-place" as const,
                },
              },
              animation: {
                version: 1 as const,
                enabled: true,
                preset: "line" as const,
                motion: "walk" as const,
                orientToPath: true,
                keyframes: [
                  {
                    frame: 0,
                    interpolation: "linear" as const,
                    transform: item.transform,
                  },
                  {
                    frame: 10,
                    interpolation: "linear" as const,
                    transform: {
                      ...item.transform,
                      position: [4, 0, 0] as [number, number, number],
                    },
                  },
                ],
              },
            }
          : item,
      ),
    },
  });

  const { rerender } = render(<SceneRoot currentFrame={5} />);

  expect(screen.getByTestId("mock-mixamo-character")).toHaveAttribute("data-motion-clip", "walk");
  expect(screen.getByTestId("mock-mixamo-character")).toHaveAttribute("data-motion-loop", "repeat");
  expect(screen.getByTestId("mock-mixamo-character")).toHaveAttribute("data-motion-start-frame", "0");

  rerender(<SceneRoot currentFrame={10} />);

  expect(screen.getByTestId("mock-mixamo-character")).toHaveAttribute("data-motion-clip", "wave");
  expect(screen.getByTestId("mock-mixamo-character")).toHaveAttribute("data-motion-loop", "once");
  expect(screen.getByTestId("mock-mixamo-character")).toHaveAttribute("data-motion-start-frame", "8");
});

it("gives an authored motion block priority only inside its inclusive frame range", () => {
  const base = createInitialDirectorState();
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...base,
    project: {
      ...base.project,
      objects: base.project.objects.map((item) =>
        item.id === "char_default_a"
          ? {
              ...item,
              animation: {
                version: 1 as const,
                enabled: true,
                preset: "line" as const,
                motion: "walk" as const,
                keyframes: [
                  {
                    frame: 0,
                    interpolation: "linear" as const,
                    transform: item.transform,
                  },
                  {
                    frame: 12,
                    interpolation: "linear" as const,
                    transform: {
                      ...item.transform,
                      position: [4, 0, 0] as [number, number, number],
                    },
                  },
                ],
                motionBlocks: [
                  {
                    id: "motion-wave",
                    clipId: "wave",
                    enabled: true,
                    frameStart: 4,
                    frameEnd: 7,
                    loop: "once" as const,
                    speed: 1,
                    weight: 1,
                    blendInS: 0,
                    blendOutS: 0,
                    rootMotion: "in-place" as const,
                  },
                ],
              },
            }
          : item,
      ),
    },
  });

  const { rerender } = render(<SceneRoot currentFrame={5} />);
  expect(screen.getByTestId("mock-mixamo-character")).toHaveAttribute("data-motion-clip", "wave");

  rerender(<SceneRoot currentFrame={8} />);
  expect(screen.getByTestId("mock-mixamo-character")).toHaveAttribute("data-motion-clip", "walk");
});

it("keeps the scene usable with a procedural character fallback when an external character pack is absent", () => {
  const base = createInitialDirectorState();
  mockFailedMixamoUrl.current = "/mixamo-characters/models/astronaut.glb";
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...base,
    project: {
      ...projectWithViewportLabels(base.project),
      assets: [
        {
          id: "asset_mixamo_missing",
          kind: "character",
          sourceType: "model",
          fileName: "astronaut.glb",
          name: "Astronaut",
          url: mockFailedMixamoUrl.current,
          assetSource: "library",
          characterMetadata: {
            heightM: 1.78,
            groundOffsetY: 0,
            visualCenter: [0, 0.89, 0],
            labelAnchorY: 1.9,
            rig: { type: "mixamo", boneCount: 65 },
          },
        },
      ],
      objects: [
        ...base.project.objects,
        {
          id: "obj_mixamo_missing",
          name: "Astronaut",
          kind: "character",
          visible: true,
          locked: false,
          assetRefId: "asset_mixamo_missing",
          placementMode: "grounded",
          characterRig: {
            rigType: "mixamo",
            posePresetId: "stand",
            controls: {},
          },
          transform: {
            position: [0, 0, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
          },
        },
      ],
    },
  });

  render(<SceneRoot />);

  expect(screen.queryByTestId("mock-mixamo-character")).not.toBeInTheDocument();
  expect(screen.getAllByTestId("mock-character-model")).toHaveLength(2);
  expect(screen.getByText("Astronaut")).toBeInTheDocument();
  expect(screen.getByText("机位01")).toBeInTheDocument();
});

it("renders a visible binding asset at its owner transform even when the owner itself is hidden", () => {
  const base = createInitialDirectorState();
  const hiddenCharacter = {
    ...base.project.objects.find((item) => item.id === "char_default_a")!,
    visible: false,
    referenceBindings: [
      {
        id: "ref_asset_chair",
        kind: "asset3d" as const,
        label: "课堂椅子",
        ref: "asset_ref_chair",
        showInViewport: true,
      },
    ],
  };
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...base,
    project: {
      ...base.project,
      assets: [
        {
          id: "asset_ref_chair",
          kind: "prop",
          sourceType: "model",
          fileName: "classroom-chair.glb",
          url: "blob:classroom-chair",
        },
      ],
      objects: base.project.objects.map((item) => (item.id === hiddenCharacter.id ? hiddenCharacter : item)),
    },
  });

  const { container } = render(<SceneRoot />);

  expect(container.querySelector('group[name="reference-binding-char_default_a-asset_ref_chair"]')).toBeInTheDocument();
  expect(screen.queryByText("角色01")).not.toBeInTheDocument();
});

it("renders a transparent prompt visualization from a hidden object's binding", () => {
  const base = createInitialDirectorState();
  const hiddenCharacter = {
    ...base.project.objects.find((item) => item.id === "char_default_a")!,
    visible: false,
    referenceBindings: [
      {
        id: "ref_prompt_note",
        kind: "prompt" as const,
        label: "表演提示",
        ref: "缓慢回头，看向窗外",
        showInViewport: true,
        promptVisual: {
          fontColor: "#00d7ff",
          fontSize: 18,
          width: 260,
          height: 84,
        },
      },
    ],
  };
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...base,
    project: {
      ...base.project,
      objects: base.project.objects.map((item) => (item.id === hiddenCharacter.id ? hiddenCharacter : item)),
    },
  });

  render(<SceneRoot />);

  const visual = screen.getByLabelText("表演提示 提示词可视化");
  expect(visual).toHaveTextContent("缓慢回头，看向窗外");
  expect(visual).toHaveClass("prompt-reference-visual");
});

it("keeps imported model normalization neutral for empty bounds", () => {
  const normalization = getImportedModelNormalization(new Box3(), 2);

  expect(normalization.scale).toBe(1);
  expect(normalization.position).toEqual([0, 0, 0]);
});

it("renders the viewport camera as a reference-style blue wireframe model and viewfinder", () => {
  const { container } = render(<SceneRoot />);

  expect(screen.getByText("机位01")).toBeInTheDocument();
  expect(container.querySelector('meshstandardmaterial[color="#D88900"]')).not.toBeInTheDocument();
  expect(container.querySelector('meshstandardmaterial[color="#05070A"]')).not.toBeInTheDocument();
  expect(container.querySelector('meshstandardmaterial[color="#FF2B19"]')).not.toBeInTheDocument();

  const camera = useDirectorStore.getState().project.cameras[0]!;
  const bodyLines = getViewportCameraBodyWireframeLines();
  const lensLines = bodyLines.filter((line) => line.part === "lens");
  const reelLines = bodyLines.filter((line) => line.part === "reel");
  const allBodyPoints = bodyLines.filter((line) => line.part === "body").flatMap((line) => line.points);
  const bodyWidth =
    Math.max(...allBodyPoints.map((point) => point[0])) - Math.min(...allBodyPoints.map((point) => point[0]));
  const bodyHeight =
    Math.max(...allBodyPoints.map((point) => point[1])) - Math.min(...allBodyPoints.map((point) => point[1]));
  const bodyDepth =
    Math.max(...allBodyPoints.map((point) => point[2])) - Math.min(...allBodyPoints.map((point) => point[2]));
  const closedLensRings = lensLines.filter(({ points }) => {
    const firstPoint = points[0];
    const lastPoint = points[points.length - 1];
    return (
      points.length === 5 &&
      firstPoint?.[0] === lastPoint?.[0] &&
      firstPoint?.[1] === lastPoint?.[1] &&
      firstPoint?.[2] === lastPoint?.[2]
    );
  });

  expect(bodyWidth).toBeCloseTo(0.4 * VIEWPORT_CAMERA_VISUAL_SCALE);
  expect(bodyHeight).toBeCloseTo(0.4 * VIEWPORT_CAMERA_VISUAL_SCALE);
  expect(bodyDepth / bodyWidth).toBeGreaterThan(2.4);
  expect(lensLines).toHaveLength(6);
  expect(reelLines).toHaveLength(2);
  expect(reelLines.every((line) => line.points.length > 20)).toBe(true);
  expect(closedLensRings).toHaveLength(2);
  const viewfinderRays = getViewportCameraFrustumLines(camera).slice(0, 4);
  expect(viewfinderRays.every((points) => points[0]?.every((value) => value === 0))).toBe(true);
  expect(viewfinderRays.every((points) => (points[1]?.[2] ?? 0) > (points[0]?.[2] ?? 0))).toBe(true);

  const blueLines = screen.getAllByTestId("camera-line").filter((line) => line.dataset.color === "#A9D8FF");
  expect(blueLines).toHaveLength(1);
  expect(blueLines[0]).toHaveAttribute("data-name", `${camera.id}-wireframe`);
  expect(blueLines[0]).toHaveAttribute("data-segments", "true");
  expect(blueLines[0]).toHaveAttribute("data-transparent", "true");
  expect(blueLines[0]).toHaveAttribute("data-opacity", "0.92");
  expect(blueLines[0]).toHaveAttribute("data-line-width", "1");
  expect(blueLines[0]).toHaveAttribute("data-clickable", "true");
  expect(JSON.parse(blueLines[0]!.dataset.points ?? "[]")).toEqual(getViewportCameraWireframeSegments(camera));
});

it("keeps the camera helper frustum and the rendered lens on the same forward ray", () => {
  const source = useDirectorStore.getState().project.cameras[0]!;
  const position: [number, number, number] = [0, 70, 93];
  const target: [number, number, number] = [0, 64.58821852688506, 84.59092030676068];
  const camera = {
    ...source,
    transform: { ...source.transform, position },
    target,
  };
  const expectedForward = new Vector3(...target).sub(new Vector3(...position)).normalize();
  const helperQuaternion = getViewportCameraQuaternion(position, target);
  const helperFrustumCenter = getViewportCameraFrustumLines(camera)
    .slice(0, 4)
    .reduce((sum, line) => sum.add(new Vector3(...line[1])), new Vector3())
    .multiplyScalar(0.25)
    .applyQuaternion(helperQuaternion)
    .normalize();
  const pictureCamera = new PerspectiveCamera();
  pictureCamera.position.set(...position);
  pictureCamera.lookAt(...target);
  pictureCamera.updateMatrixWorld();
  const pictureForward = pictureCamera.getWorldDirection(new Vector3()).normalize();

  expect(helperFrustumCenter.dot(expectedForward)).toBeGreaterThan(0.999999);
  expect(pictureForward.dot(expectedForward)).toBeGreaterThan(0.999999);
  expect(helperFrustumCenter.dot(pictureForward)).toBeGreaterThan(0.999999);
});

it("selects the viewport camera when users click a camera model line", () => {
  render(<SceneRoot />);

  const wireframe = screen.getAllByTestId("camera-line").find((line) => line.dataset.name?.endsWith("-wireframe"));
  expect(wireframe).toHaveAttribute("data-clickable", "true");

  fireEvent.click(wireframe!);

  expect(useDirectorStore.getState().selectedObjectId).toBe("cam_object_1");
});

it("selects the viewport camera from the enlarged wireframe hit area", () => {
  const { container } = render(<SceneRoot />);
  const hitArea = container.querySelector('mesh[name="cam_1-hit-area"]');

  expect(hitArea).toBeInTheDocument();
  fireEvent.click(hitArea!);

  expect(useDirectorStore.getState().selectedObjectId).toBe("cam_object_1");
});

it("shows transform controls when a viewport camera is selected", () => {
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    selectedObjectId: "cam_object_1",
    transformMode: "rotate",
  });

  render(<SceneRoot />);

  expect(screen.getByTestId("transform-controls")).toHaveAttribute("data-mode", "rotate");
  expect(screen.getByTestId("transform-controls")).toHaveAttribute("data-has-object", "true");
  expect(screen.getByTestId("transform-controls")).toHaveAttribute("data-hide-from-capture", "true");
});

it("hides role labels when the scene toggle is disabled", () => {
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    project: {
      ...useDirectorStore.getState().project,
      scene: {
        ...useDirectorStore.getState().project.scene,
        showLabels: false,
      },
    },
  });

  render(<SceneRoot />);

  expect(screen.queryByText("角色01")).not.toBeInTheDocument();
});

it("hides screen-space labels when the stage is rendered through multiple viewport cameras", () => {
  render(<SceneRoot showViewportOverlays={false} />);

  expect(screen.queryByText("角色01")).not.toBeInTheDocument();
});

it("shows transform controls around the selected character in the active tool mode", () => {
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    selectedObjectId: "char_default_a",
    transformMode: "rotate",
  });

  render(<SceneRoot />);

  expect(screen.getByTestId("transform-controls")).toHaveAttribute("data-mode", "rotate");
  expect(screen.getByTestId("transform-controls")).toHaveAttribute("data-has-object", "true");
  expect(screen.getByTestId("transform-controls")).toHaveAttribute("data-hide-from-capture", "true");
  expect(screen.getByTestId("transform-controls")).toHaveAttribute("data-translation-snap", "null");
});

it("shows one shared transform control for a multi-object selection", () => {
  useDirectorStore.getState().addGeometryPrimitive("box");
  useDirectorStore.getState().addGeometryPrimitive("sphere");
  const ids = useDirectorStore
    .getState()
    .project.objects.filter((object) => object.geometryType === "box" || object.geometryType === "sphere")
    .map((object) => object.id);
  useDirectorStore.getState().selectObjects(ids);

  const { container } = render(<SceneRoot />);

  expect(screen.getAllByTestId("transform-controls")).toHaveLength(1);
  expect(container.querySelector('group[name="director-multi-object-transform-pivot"]')).toBeInTheDocument();
});

it("disables viewport transform controls while timeline playback is running", () => {
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    selectedObjectId: "char_default_a",
  });

  render(<SceneRoot currentFrame={12} isPlaying />);

  expect(screen.queryByTestId("transform-controls")).not.toBeInTheDocument();
});

it("keeps animated entities inspectable but disables base-transform gizmos while paused", () => {
  const state = createInitialDirectorState();
  useDirectorStore.setState({
    ...state,
    selectedObjectId: "char_default_a",
    project: {
      ...projectWithViewportLabels(state.project),
      objects: state.project.objects.map((item) =>
        item.id === "char_default_a"
          ? {
              ...item,
              animation: {
                version: 1 as const,
                keyframes: [
                  {
                    frame: 1,
                    interpolation: "linear" as const,
                    transform: item.transform,
                  },
                ],
              },
            }
          : item,
      ),
    },
  });

  render(<SceneRoot currentFrame={1} isPlaying={false} />);

  expect(screen.getByText("角色01")).toBeInTheDocument();
  expect(screen.queryByTestId("transform-controls")).not.toBeInTheDocument();
});

it("keeps the selected animated camera draggable at the current timeline frame", () => {
  const state = createInitialDirectorState();
  useDirectorStore.setState({
    ...state,
    selectedObjectId: "cam_object_1",
    selectedObjectIds: ["cam_object_1"],
    project: {
      ...state.project,
      cameras: state.project.cameras.map((camera) =>
        camera.id === "cam_1"
          ? {
              ...camera,
              animation: {
                version: 1,
                enabled: true,
                source: "manual",
                keyframes: [
                  {
                    frame: 0,
                    transform: camera.transform,
                    lookTarget: camera.target,
                  },
                  {
                    frame: 24,
                    transform: { ...camera.transform, position: [2, 1, 6] },
                    lookTarget: [0, 1, 0],
                  },
                ],
              },
            }
          : camera,
      ),
    },
  });

  render(<SceneRoot currentFrame={12} isPlaying={false} />);

  expect(screen.getByTestId("transform-controls")).toHaveAttribute("data-mode", "translate");
});

it("renders evaluated character pose controls at the requested timeline frame", () => {
  const state = createInitialDirectorState();
  useDirectorStore.setState({
    ...state,
    project: {
      ...state.project,
      scene: {
        ...state.project.scene,
        timeline: {
          version: 1,
          fps: 24,
          frameStart: 1,
          frameEnd: 11,
          currentFrame: 1,
          loop: true,
        },
      },
      objects: state.project.objects.map((item) =>
        item.kind === "character"
          ? {
              ...item,
              animation: {
                version: 1,
                keyframes: [
                  {
                    frame: 1,
                    interpolation: "linear" as const,
                    poseValues: { punch: 0 },
                  },
                  {
                    frame: 11,
                    interpolation: "linear" as const,
                    poseValues: { punch: 100 },
                  },
                ],
              },
            }
          : item,
      ),
    },
  });

  render(<SceneRoot currentFrame={6} />);

  expect(screen.getByTestId("mock-character-model")).toHaveAttribute("data-punch", "50");
});

it("shows transform controls around selected models while in camera view", () => {
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    viewMode: "camera",
    selectedObjectId: "char_default_a",
    transformMode: "scale",
  });

  render(<SceneRoot />);

  expect(screen.getByTestId("transform-controls")).toHaveAttribute("data-mode", "scale");
  expect(screen.getByTestId("transform-controls")).toHaveAttribute("data-has-object", "true");
  expect(screen.getByTestId("transform-controls")).toHaveAttribute("data-translation-snap", "null");
});

it("selects the whole crowd group and shows one transform control when users click a crowd member", () => {
  useDirectorStore.getState().addCrowdCharacters({ rows: 2, columns: 2, spacing: 1.2 });

  render(<SceneRoot />);

  fireEvent.click(screen.getAllByTestId("mock-character-model")[1]!);

  expect(useDirectorStore.getState().selectedCrowdId).toBe("crowd_1");
  expect(useDirectorStore.getState().selectedObjectIds).toHaveLength(4);
  expect(screen.getAllByTestId("transform-controls")).toHaveLength(1);
});

it("selects a composition parent from the viewport while preserving direct child editing for the outliner", () => {
  const state = createInitialDirectorState();
  const parent = {
    id: "composite_parent_chair",
    name: "课堂椅子",
    kind: "prop" as const,
    visible: true,
    locked: false,
    isCompositeParent: true,
    transform: {
      position: [0, 0, 0] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number],
    },
  };
  useDirectorStore.setState({
    ...state,
    project: {
      ...state.project,
      objects: [
        parent,
        ...state.project.objects.map((item) =>
          item.id === "char_default_a" ? { ...item, parentObjectId: parent.id } : item,
        ),
      ],
    },
  });

  const { rerender } = render(<SceneRoot />);
  fireEvent.click(screen.getByTestId("mock-character-model"));

  expect(useDirectorStore.getState().selectedObjectId).toBe(parent.id);
  expect(screen.getByTestId("transform-controls")).toBeInTheDocument();

  // The outliner calls selectObject(childId) directly; that intentional path
  // is the only route that exposes a child transform gizmo in the viewport.
  useDirectorStore.getState().selectObject("char_default_a");
  rerender(<SceneRoot />);
  expect(useDirectorStore.getState().selectedObjectId).toBe("char_default_a");
  expect(screen.getByTestId("transform-controls")).toBeInTheDocument();
});

it("passes world-grid snapping into viewport transform controls while translating selected objects", () => {
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    selectedObjectId: "char_default_a",
    transformMode: "translate",
    project: {
      ...useDirectorStore.getState().project,
      scene: {
        ...useDirectorStore.getState().project.scene,
        snapToGrid: true,
      },
    },
  });

  render(<SceneRoot />);

  expect(screen.getByTestId("transform-controls")).toHaveAttribute("data-mode", "translate");
  expect(screen.getByTestId("transform-controls")).toHaveAttribute("data-translation-snap", "1");
});

it("passes character body type to the procedural mannequin", () => {
  const state = createInitialDirectorState();
  const character = state.project.objects.find((item) => item.kind === "character");
  expect(character).toBeTruthy();

  useDirectorStore.setState({
    ...state,
    project: {
      ...state.project,
      objects: state.project.objects.map((item) => (item.id === character!.id ? { ...item, bodyType: "chibi" } : item)),
    },
  });

  render(<SceneRoot />);

  expect(screen.getByTestId("mock-character-model")).toHaveAttribute("data-body-type", "chibi");
});

it("uses the packaged Mixamo rig for default generated characters", () => {
  render(<SceneRoot />);

  expect(screen.getByTestId("mock-character-model")).toHaveAttribute("data-rig-type", "mixamo");
});
