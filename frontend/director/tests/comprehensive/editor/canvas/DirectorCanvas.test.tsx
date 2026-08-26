import { StrictMode, createContext, forwardRef, useContext, useImperativeHandle, useMemo } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, vi } from "vitest";
import {
  BoxGeometry,
  Euler,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MOUSE,
  PerspectiveCamera,
  Quaternion,
  Vector3,
} from "three";
import {
  clearViewportCaptureHandler,
  requestViewportCapture,
} from "../../../../src/comprehensive/editor/io/captureBridge";
import { getCameraViewSnapshotFromShot } from "../../../../src/comprehensive/editor/schema/cameraGeometry";
import { calculateDirectorCameraExposure } from "../../../../src/comprehensive/editor/schema/cameraExposure";
import { evaluateDirectorCameraAtFrame } from "../../../../src/comprehensive/editor/schema/directorAnimation";
import {
  createModelLibraryDragPayload,
  MODEL_LIBRARY_DRAG_MIME,
} from "../../../../src/comprehensive/editor/modelLibrary/modelLibraryDrag";
import { getMixamoCharacterCatalogItem } from "../../../../src/comprehensive/editor/modelLibrary/mixamoCharacterCatalog";
import {
  resetPerformanceConfigOverrides,
  setPerformanceConfigOverride,
  setSelectedPerformanceProfile,
} from "../../../../src/comprehensive/editor/performance/performanceRuntime";
import {
  createDirectorPlayerObstacle,
  createDirectorVideoFrameCaptureRequest,
  DEFAULT_DIRECTOR_VIEW_SNAPSHOT,
  getViewportWheelZoomImpulse,
  getPlayerActorAtFrame,
  getInitialDirectorViewSnapshot,
  isDirectorCaptureSceneReady,
  getModelLibraryDropPlacement,
  getModelLibraryDropPosition,
  getSceneCameraViewSnapshot,
  inferPlayerRecordingGait,
  normalizeViewportWheelDelta,
  type PlayerRecordingSample,
} from "../../../../src/comprehensive/editor/canvas/DirectorCanvas";
import { getViewportAspectFrameRect } from "../../../../src/comprehensive/editor/canvas/viewportAspectFrame";
import {
  getViewportGridFadeDistance,
  VIEWPORT_GRID_FADE_STRENGTH,
} from "../../../../src/comprehensive/editor/canvas/viewportWheelZoom";
import { DIRECTOR_PREVIZ_PALETTE } from "@director/project-schema";

const mockCameraPositionSet = vi.hoisted(() => vi.fn());
const mockCameraLookAt = vi.hoisted(() => vi.fn());
const mockCameraUpdateMatrixWorld = vi.hoisted(() => vi.fn());
const mockCameraUpdateProjectionMatrix = vi.hoisted(() => vi.fn());
const mockOrbitTargetSet = vi.hoisted(() => vi.fn());
const mockOrbitUpdate = vi.hoisted(() => vi.fn());
const mockCaptureExcludedObjects = vi.hoisted(() => [
  { name: "viewport-grid", userData: { hideFromViewportCapture: true }, visible: true },
  { name: "viewport-camera-wireframe", userData: { hideFromViewportCapture: true }, visible: true },
]);
const mockCaptureVisibleObject = vi.hoisted(() => ({
  name: "role-model",
  userData: {},
  visible: true,
}));
const mockRenderVisibilitySnapshots = vi.hoisted(() => [] as boolean[][]);
const mockRenderCameraClippingSnapshots = vi.hoisted(() => [] as Array<[number, number]>);
const mockRenderExposureSnapshots = vi.hoisted(() => [] as number[]);
const mockGlRender = vi.hoisted(() => vi.fn());
const mockCanvasToDataURL = vi.hoisted(() => vi.fn(() => "data:image/png;base64,mock"));
const mockCaptureDirectorRenderPass = vi.hoisted(() => vi.fn());
const mockCaptureDirectorCinematicRenderPass = vi.hoisted(() => vi.fn());
const mockCinematicSessionResize = vi.hoisted(() => vi.fn());
const mockCinematicSessionRender = vi.hoisted(() => vi.fn());
const mockCinematicSessionDispose = vi.hoisted(() => vi.fn());
const mockThreeCamera = vi.hoisted(() => ({ current: null as PerspectiveCamera | null }));
const mockThreeCameras = vi.hoisted(() => ({
  main: null as PerspectiveCamera | null,
  gizmo: null as PerspectiveCamera | null,
}));
const mockR3f = vi.hoisted(() => ({
  CanvasContext: null as import("react").Context<"main" | "gizmo"> | null,
}));
const mockMainCanvasRender = vi.hoisted(() => vi.fn());
const mockGizmoCanvasRender = vi.hoisted(() => vi.fn());

it("waits for the bound Blender scene before enabling an offscreen delivery capture", () => {
  expect(
    isDirectorCaptureSceneReady({
      blenderLiveVisible: true,
      captureOnly: true,
      nativeProjectId: "project-1",
      nativeScenePhase: "syncing",
    }),
  ).toBe(false);
  expect(
    isDirectorCaptureSceneReady({
      blenderLiveVisible: true,
      captureOnly: true,
      nativeProjectId: "project-1",
      nativeScenePhase: "ready",
    }),
  ).toBe(true);
  expect(
    isDirectorCaptureSceneReady({
      blenderLiveVisible: true,
      captureOnly: true,
      nativeScenePhase: "offline",
    }),
  ).toBe(true);
});

beforeEach(() => {
  act(() => {
    resetPerformanceConfigOverrides();
    setSelectedPerformanceProfile("quality");
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => null);
  mockCameraPositionSet.mockClear();
  mockCameraLookAt.mockClear();
  mockCameraUpdateMatrixWorld.mockClear();
  mockCameraUpdateProjectionMatrix.mockClear();
  mockOrbitTargetSet.mockClear();
  mockOrbitUpdate.mockClear();
  mockGlRender.mockReset();
  mockCanvasToDataURL.mockReset();
  mockCanvasToDataURL.mockReturnValue("data:image/png;base64,mock");
  mockCaptureDirectorRenderPass.mockReset();
  mockCaptureDirectorCinematicRenderPass.mockReset();
  mockCinematicSessionResize.mockReset();
  mockCinematicSessionRender.mockReset();
  mockCinematicSessionDispose.mockReset();
  mockMainCanvasRender.mockClear();
  mockGizmoCanvasRender.mockClear();
  mockRenderVisibilitySnapshots.length = 0;
  mockRenderCameraClippingSnapshots.length = 0;
  mockRenderExposureSnapshots.length = 0;
  mockCaptureExcludedObjects.forEach((object) => {
    object.visible = true;
  });
  mockCaptureVisibleObject.visible = true;
  mockThreeCameras.main = null;
  mockThreeCameras.gizmo = null;
  mockThreeCamera.current = null;
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...createInitialDirectorState(),
  });
  useTimelineRuntimeStore.getState().reset();
});

vi.mock("../../../../src/comprehensive/editor/render/renderPassCapture", () => ({
  captureDirectorRenderPass: mockCaptureDirectorRenderPass,
}));

vi.mock("../../../../src/comprehensive/editor/render/cinematicOpticsCapture", () => ({
  captureDirectorCinematicRenderPass: mockCaptureDirectorCinematicRenderPass,
  createDirectorCinematicRenderSession: () => ({
    width: 1,
    height: 1,
    resize: mockCinematicSessionResize,
    renderToCurrentViewport: mockCinematicSessionRender,
    renderToTarget: vi.fn(),
    dispose: mockCinematicSessionDispose,
  }),
}));

afterEach(() => {
  act(() => {
    resetPerformanceConfigOverrides();
    setSelectedPerformanceProfile("quality");
  });
  clearViewportCaptureHandler();
  vi.restoreAllMocks();
});

function expandTimelineDock(): void {
  const sash = screen.queryByRole("separator", { name: "展开下方栏" });
  if (sash) fireEvent.keyDown(sash, { key: "Enter" });
}

vi.mock("@react-three/fiber", async () => {
  const actual = await vi.importActual<typeof import("@react-three/fiber")>("@react-three/fiber");
  const React = await import("react");
  if (!mockR3f.CanvasContext) {
    mockR3f.CanvasContext = React.createContext<"main" | "gizmo">("main");
  }
  const MockCanvasContext = mockR3f.CanvasContext;

  const createMockThreeCamera = (kind: "main" | "gizmo") => {
    const testCamera = new PerspectiveCamera(50, 1000 / 700, 0.1, 1000);
    if (kind === "main") {
      testCamera.position.set(0, 2.2, 9);
      testCamera.lookAt(0, 1.2, 0);
    } else {
      const offset = new Vector3(...DEFAULT_DIRECTOR_VIEW_SNAPSHOT.position).sub(
        new Vector3(...DEFAULT_DIRECTOR_VIEW_SNAPSHOT.target),
      );
      testCamera.position.copy(offset);
      testCamera.lookAt(0, 0, 0);
    }
    testCamera.updateProjectionMatrix();
    testCamera.updateMatrixWorld();

    const position = testCamera.position;
    const originalLookAt = testCamera.lookAt.bind(testCamera);
    const originalUpdateMatrixWorld = testCamera.updateMatrixWorld.bind(testCamera);
    const originalUpdateProjectionMatrix = testCamera.updateProjectionMatrix.bind(testCamera);
    const originalPositionSet = position.set.bind(position);
    const originalPositionCopy = position.copy.bind(position);

    if (kind === "main") {
      position.set = ((x: number, y: number, z: number) => {
        mockCameraPositionSet(x, y, z);
        const result = originalPositionSet(x, y, z);
        testCamera.updateMatrixWorld();
        return result;
      }) as typeof position.set;
    }

    position.copy = ((vector: Vector3) => {
      const result = originalPositionCopy(vector);
      testCamera.updateMatrixWorld();
      return result;
    }) as typeof position.copy;

    const lookAt = (...args: Parameters<PerspectiveCamera["lookAt"]>) => {
      if (kind === "main") mockCameraLookAt(...args);
      const result = originalLookAt(...args);
      originalUpdateMatrixWorld();
      return result;
    };
    const updateMatrixWorld = (...args: Parameters<PerspectiveCamera["updateMatrixWorld"]>) => {
      if (kind === "main") mockCameraUpdateMatrixWorld(...args);
      return originalUpdateMatrixWorld(...args);
    };
    const updateProjectionMatrix = () => {
      if (kind === "main") mockCameraUpdateProjectionMatrix();
      return originalUpdateProjectionMatrix();
    };

    testCamera.lookAt = lookAt as PerspectiveCamera["lookAt"];
    testCamera.updateMatrixWorld = updateMatrixWorld as PerspectiveCamera["updateMatrixWorld"];
    testCamera.updateProjectionMatrix = updateProjectionMatrix as PerspectiveCamera["updateProjectionMatrix"];

    return testCamera;
  };

  const getMockThreeCamera = (kind: "main" | "gizmo") => {
    const existing = mockThreeCameras[kind];
    if (existing) return existing;
    const created = createMockThreeCamera(kind);
    mockThreeCameras[kind] = created;
    if (kind === "gizmo") mockThreeCamera.current = created;
    return created;
  };

  return {
    ...actual,
    Canvas: ({
      camera,
      children,
      className,
      dpr,
      frameloop,
      gl,
      onPointerMissed,
      shadows,
    }: {
      camera?: { fov?: number; position?: [number, number, number] };
      children: React.ReactNode;
      className?: string;
      dpr?: number | [number, number];
      frameloop?: "always" | "demand" | "never";
      gl?: { reversedDepthBuffer?: boolean };
      onPointerMissed?: () => void;
      shadows?: boolean | string;
    }) => {
      if (className === "director-stage-canvas") mockMainCanvasRender();
      if (className === "viewport-gizmo-canvas") mockGizmoCanvasRender();
      return (
        <MockCanvasContext.Provider value={className === "viewport-gizmo-canvas" ? "gizmo" : "main"}>
          <div
            className={className}
            data-camera-fov={camera?.fov}
            data-camera-position={camera?.position ? JSON.stringify(camera.position) : undefined}
            data-dpr={JSON.stringify(dpr)}
            data-frameloop={frameloop}
            data-reversed-depth-buffer={String(gl?.reversedDepthBuffer)}
            data-shadows={String(shadows)}
            data-testid="mock-r3f-canvas"
            onClick={() => onPointerMissed?.()}
          >
            {children}
          </div>
        </MockCanvasContext.Provider>
      );
    },
    useFrame: () => undefined,
    useThree: () => {
      const canvasKind = React.useContext(MockCanvasContext);
      const testCamera = canvasKind === "gizmo" ? getMockThreeCamera("gizmo") : createMockThreeCamera("main");
      if (canvasKind === "gizmo") mockThreeCamera.current = testCamera;

      const gl = {
        toneMappingExposure: 1,
        render: (_scene: unknown, renderCamera: PerspectiveCamera) => {
          mockGlRender();
          mockRenderExposureSnapshots.push(gl.toneMappingExposure);
          mockRenderCameraClippingSnapshots.push([renderCamera.near, renderCamera.far]);
          mockRenderVisibilitySnapshots.push([
            ...mockCaptureExcludedObjects.map((object) => object.visible),
            mockCaptureVisibleObject.visible,
          ]);
        },
        setClearColor: () => undefined,
        setViewport: () => undefined,
        setScissor: () => undefined,
        setScissorTest: () => undefined,
        domElement: {
          width: 1000,
          height: 700,
          clientWidth: 1000,
          clientHeight: 700,
          toDataURL: mockCanvasToDataURL,
          setPointerCapture: () => undefined,
          releasePointerCapture: () => undefined,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
          getAttribute: () => null,
          setAttribute: () => undefined,
          removeAttribute: () => undefined,
          tabIndex: -1,
          style: { cursor: "" },
        },
      };

      return {
        camera: testCamera,
        size: { width: 1000, height: 700 },
        invalidate: () => undefined,
        gl,
        scene: {
          background: null,
          backgroundRotation: {
            clone: () => ({
              copy: () => undefined,
            }),
            copy: () => undefined,
            set: () => undefined,
          },
          backgroundBlurriness: 0,
          backgroundIntensity: 1,
          updateMatrixWorld: () => undefined,
          traverse: (callback: (object: { userData?: Record<string, unknown>; visible: boolean }) => void) => {
            [...mockCaptureExcludedObjects, mockCaptureVisibleObject].forEach(callback);
          },
        },
      };
    },
  };
});

vi.mock("../../../../src/comprehensive/editor/canvas/ViewportGroundGrid", () => ({
  ViewportGroundGrid: ({
    cellColor,
    cellSize,
    cellThickness,
    fadeDistance,
    fadeStrength,
    followCamera,
    infiniteGrid,
    position,
    sectionColor,
    sectionSize,
  }: {
    cellColor?: string;
    cellSize?: number;
    cellThickness?: number;
    fadeDistance?: number;
    fadeStrength?: number;
    followCamera?: boolean;
    infiniteGrid?: boolean;
    position?: [number, number, number];
    sectionColor?: string;
    sectionSize?: number;
  }) => (
    <div
      data-cell-color={cellColor}
      data-cell-size={String(cellSize)}
      data-cell-thickness={String(cellThickness)}
      data-fade-distance={String(fadeDistance)}
      data-fade-strength={String(fadeStrength)}
      data-follow-camera={String(followCamera)}
      data-infinite-grid={String(infiniteGrid)}
      data-position={JSON.stringify(position)}
      data-section-color={sectionColor}
      data-section-size={String(sectionSize)}
      data-testid="viewport-grid"
    />
  ),
}));

vi.mock("@react-three/drei", async () => {
  const actual = await vi.importActual<typeof import("@react-three/drei")>("@react-three/drei");
  const MockGizmoContext = createContext({
    tweenCamera: (_direction: { x: number; y: number; z: number }) => undefined,
  });

  return {
    ...actual,
    useGizmoContext: () => useContext(MockGizmoContext),
    Grid: ({
      cellColor,
      cellSize,
      cellThickness,
      fadeDistance,
      fadeStrength,
      followCamera,
      infiniteGrid,
      position,
      sectionColor,
      sectionSize,
    }: {
      cellColor?: string;
      cellSize?: number;
      cellThickness?: number;
      fadeDistance?: number;
      fadeStrength?: number;
      followCamera?: boolean;
      infiniteGrid?: boolean;
      position?: [number, number, number];
      sectionColor?: string;
      sectionSize?: number;
    }) => (
      <div
        data-cell-color={cellColor}
        data-cell-size={String(cellSize)}
        data-cell-thickness={String(cellThickness)}
        data-fade-distance={String(fadeDistance)}
        data-fade-strength={String(fadeStrength)}
        data-follow-camera={String(followCamera)}
        data-infinite-grid={String(infiniteGrid)}
        data-position={JSON.stringify(position)}
        data-section-color={sectionColor}
        data-section-size={String(sectionSize)}
        data-testid="viewport-grid"
      />
    ),
    GizmoHelper: ({
      alignment,
      children,
      margin,
      onUpdate,
    }: {
      alignment?: string;
      children?: React.ReactNode;
      margin?: [number, number];
      onUpdate?: () => void;
    }) => (
      <MockGizmoContext.Provider
        value={{
          tweenCamera: (direction) => {
            const camera = mockThreeCamera.current;
            if (!camera) return;
            const radius = Math.max(camera.position.length(), 0.000001);
            camera.position.set(direction.x, direction.y, direction.z).normalize().multiplyScalar(radius);
            camera.lookAt(0, 0, 0);
            camera.updateMatrixWorld();
            onUpdate?.();
          },
        }}
      >
        <div data-alignment={alignment} data-margin={JSON.stringify(margin)} data-testid="native-gizmo-helper">
          {children}
        </div>
      </MockGizmoContext.Provider>
    ),
    GizmoViewport: ({
      axisColors,
      disabled,
      scale,
    }: {
      axisColors?: [string, string, string];
      disabled?: boolean;
      scale?: number;
    }) => {
      const { tweenCamera } = useContext(MockGizmoContext);

      return (
        <div
          data-axis-colors={JSON.stringify(axisColors)}
          data-disabled={String(disabled ?? false)}
          data-scale={String(scale)}
          data-testid="native-gizmo-viewport"
        >
          {!disabled ? (
            <button
              aria-label="Drei 内置 X 轴按钮"
              type="button"
              onPointerDown={() => tweenCamera({ x: 1, y: 0, z: 0 })}
            />
          ) : null}
        </div>
      );
    },
    OrbitControls: forwardRef(function MockOrbitControls(
      {
        enabled,
        mouseButtons,
        target: targetProp,
      }: {
        enabled?: boolean;
        mouseButtons?: Partial<Record<"LEFT" | "MIDDLE" | "RIGHT", MOUSE>>;
        target?: [number, number, number];
      },
      ref,
    ) {
      const target = useMemo(() => {
        const vector = new Vector3();
        const set = vector.set.bind(vector);
        vector.set = ((x: number, y: number, z: number) => {
          mockOrbitTargetSet(x, y, z);
          return set(x, y, z);
        }) as typeof vector.set;
        return vector;
      }, []);

      useImperativeHandle(
        ref,
        () => ({
          object: mockThreeCameras.main,
          target,
          update: mockOrbitUpdate,
        }),
        [target],
      );

      return (
        <div
          data-enabled={String(enabled)}
          data-left-button={String(mouseButtons?.LEFT)}
          data-middle-button={String(mouseButtons?.MIDDLE)}
          data-right-button={String(mouseButtons?.RIGHT)}
          data-target={targetProp ? JSON.stringify(targetProp) : undefined}
          data-testid="orbit-controls"
        />
      );
    }),
    PerspectiveCamera: () => null,
    Html: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    Line: () => null,
    useTexture: () => ({ isTexture: true }),
  };
});

vi.mock("../../../../src/comprehensive/editor/canvas/SceneRoot", () => ({
  SceneRoot: ({
    children,
    currentFrame,
    isPlaying,
  }: {
    children?: React.ReactNode;
    currentFrame?: number;
    isPlaying?: boolean;
  }) => (
    <div data-current-frame={currentFrame} data-playing={isPlaying ? "true" : "false"} data-testid="mock-scene-root">
      {children}
    </div>
  ),
}));

vi.mock("../../../../src/comprehensive/editor/canvas/BlenderSceneLayer", () => ({
  BlenderSceneLayer: ({
    onActiveCameraChange,
    visible,
  }: {
    onActiveCameraChange?: (camera: unknown) => void;
    visible: boolean;
  }) => (
    <div
      data-controls-active-camera={String(Boolean(onActiveCameraChange))}
      data-testid="mock-blender-scene-layer"
      data-visible={visible}
    />
  ),
}));

vi.mock("../../../../src/comprehensive/editor/performance/DirectorShadowMapController", () => ({
  DirectorShadowMapController: () => null,
}));

import App from "../../../../src/comprehensive/App";
import { useTimelineRuntimeStore } from "../../../../src/comprehensive/editor/runtime/timelineRuntimeStore";
import { createInitialDirectorState, useDirectorStore } from "../../../../src/comprehensive/editor/store/directorStore";

it("normalizes wheel input across pixel, line, and page delta modes", () => {
  expect(normalizeViewportWheelDelta(100, 0, 800)).toBe(100);
  expect(normalizeViewportWheelDelta(3, 1, 800)).toBe(48);
  expect(normalizeViewportWheelDelta(1, 2, 800)).toBe(800);
});

it("keeps a recorded walking path on the walk gait", () => {
  const samples: PlayerRecordingSample[] = [
    {
      frame: 0,
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    },
    {
      frame: 12,
      transform: { position: [0.85, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    },
    {
      frame: 24,
      transform: { position: [1.7, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    },
  ];

  expect(inferPlayerRecordingGait(samples, 24)).toBe("walk");
});

it("replays a Shift-run recording with the run gait", () => {
  const samples: PlayerRecordingSample[] = [
    {
      frame: 0,
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    },
    {
      frame: 12,
      transform: { position: [1.6, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    },
    {
      frame: 24,
      transform: { position: [3.2, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    },
  ];

  expect(inferPlayerRecordingGait(samples, 24)).toBe("run");
});

it("uses captured gait samples while keeping legacy stationary recordings compatible", () => {
  const mixedSamples: PlayerRecordingSample[] = [
    {
      frame: 0,
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      gait: "idle",
    },
    {
      frame: 12,
      transform: { position: [0.7, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      gait: "walk",
    },
    {
      frame: 24,
      transform: { position: [2.3, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      gait: "run",
    },
  ];
  const stationarySamples: PlayerRecordingSample[] = [
    {
      frame: 0,
      transform: { position: [2, 1, -3], rotation: [0, 0, 0], scale: [1, 1, 1] },
    },
    {
      frame: 24,
      transform: { position: [2, 2, -3], rotation: [0, 0, 0], scale: [1, 1, 1] },
    },
  ];

  expect(inferPlayerRecordingGait(mixedSamples, 24)).toBe("run");
  expect(inferPlayerRecordingGait(stationarySamples, 24)).toBe("walk");
});

it("converts wheel input into bounded, sensitivity-aware smooth zoom impulses", () => {
  expect(getViewportWheelZoomImpulse(-100, 0, 800)).toBeLessThan(0);
  expect(getViewportWheelZoomImpulse(100, 0, 800)).toBeGreaterThan(0);
  expect(getViewportWheelZoomImpulse(10000, 0, 800)).toBeCloseTo(getViewportWheelZoomImpulse(400, 0, 800));
  expect(getViewportWheelZoomImpulse(100, 0, 800, 0.8)).toBeCloseTo(getViewportWheelZoomImpulse(100, 0, 800, 0.4) * 2);
});

beforeAll(async () => {
  const { unmount } = render(<App />);
  await screen.findByTestId("director-canvas", {}, { timeout: 5_000 });
  unmount();
  clearViewportCaptureHandler();
});

it("mounts the Blender authority layer in the Stage render root", async () => {
  render(<App />);

  const liveLayer = await screen.findByTestId("mock-blender-scene-layer");
  expect(liveLayer).toHaveAttribute("data-visible", "true");
  expect(liveLayer).toHaveAttribute("data-controls-active-camera", "false");
  expect(liveLayer.parentElement).toHaveAttribute("data-testid", "mock-scene-root");
});

it("applies the global scene transform to both camera position and target", () => {
  const state = createInitialDirectorState();
  const camera = {
    ...state.project.cameras[0],
    transform: {
      position: [0, 0, 10] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number],
    },
    target: [0, 0, 0] as [number, number, number],
  };
  const snapshot = getSceneCameraViewSnapshot(camera, {
    ...state.project.scene,
    scale: 0.75,
    position: [1, 2, 3],
    rotation: [0, Math.PI / 2, 0],
  });

  expect(snapshot.position[0]).toBeCloseTo(5.38, 2);
  expect(snapshot.position[1]).toBeCloseTo(2, 6);
  expect(snapshot.position[2]).toBeCloseTo(3, 6);
  expect(snapshot.target).toEqual([1, 2, 3]);
});

it("keeps the director viewport independent from the active project camera", () => {
  const state = createInitialDirectorState();
  const camera = {
    ...state.project.cameras[0],
    id: "camera-visible-scene",
    fov: 38,
    transform: {
      position: [7, 4, 9] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number],
    },
    target: [0, 1.2, 0] as [number, number, number],
  };
  useDirectorStore.setState({
    ...state,
    project: {
      ...state.project,
      activeCameraId: camera.id,
      cameras: [camera],
    },
  });
  const expected = getInitialDirectorViewSnapshot(useDirectorStore.getState().project);
  const { container } = render(<App />);

  expect(container.querySelector(".director-stage-canvas")).toHaveAttribute(
    "data-camera-position",
    JSON.stringify(expected.position),
  );
  expect(container.querySelector(".director-stage-canvas")).toHaveAttribute("data-camera-fov", String(expected.fov));
  expect(screen.getByTestId("orbit-controls")).toHaveAttribute("data-target", JSON.stringify(expected.target));
  expect(expected.position).not.toEqual(getCameraViewSnapshotFromShot(camera).position);
});

it("applies the fluid render budget when the fluid profile is selected", () => {
  act(() => setSelectedPerformanceProfile("fluid"));
  const { container } = render(<App />);

  expect(container.querySelector(".director-stage-canvas")).toHaveAttribute("data-dpr", JSON.stringify([1, 1.5]));
  expect(container.querySelector(".director-stage-canvas")).toHaveAttribute("data-reversed-depth-buffer", "true");
  expect(container.querySelector(".director-stage-canvas")).toHaveAttribute("data-shadows", "percentage");
  expect(container.querySelector(".viewport-gizmo-canvas")).toHaveAttribute("data-dpr", JSON.stringify([1, 1.5]));
});

it("applies custom render overrides on top of the selected profile", () => {
  act(() => {
    setPerformanceConfigOverride("mainDpr", 1.25);
    setPerformanceConfigOverride("gizmoDpr", 1);
    setPerformanceConfigOverride("shadowsEnabled", false);
  });
  const { container } = render(<App />);

  expect(container.querySelector(".director-stage-canvas")).toHaveAttribute("data-dpr", "1.25");
  expect(container.querySelector(".director-stage-canvas")).toHaveAttribute("data-shadows", "false");
  expect(container.querySelector(".viewport-gizmo-canvas")).toHaveAttribute("data-dpr", "1");
});

it("activates, zooms, maximizes, and restores quad panes while suspending single-view tools", () => {
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    viewportLayout: "quad",
  });

  render(<App />);

  const chrome = screen.getByLabelText("常驻四视图");
  expect(within(chrome).getByText("透视")).toBeInTheDocument();
  expect(within(chrome).getByText("顶视")).toBeInTheDocument();
  expect(within(chrome).getByText("前视")).toBeInTheDocument();
  expect(within(chrome).getByText("右视")).toBeInTheDocument();
  const canvas = screen.getByTestId("director-canvas");
  expect(canvas).toHaveAttribute("data-viewport-layout", "quad");
  expect(canvas).toHaveAttribute("data-active-quad-pane", "perspective");
  expect(screen.getByTestId("orbit-controls")).toHaveAttribute("data-enabled", "false");
  expect(screen.queryByLabelText("相机快捷属性")).not.toBeInTheDocument();

  const top = within(chrome).getByRole("region", { name: "顶视视图" });
  expect(top).not.toHaveAttribute("title");
  expect(screen.getByTestId("viewport-grid")).toHaveAttribute("data-follow-camera", "false");
  fireEvent.pointerDown(top);
  expect(top).toHaveAttribute("aria-current", "true");
  expect(canvas).toHaveAttribute("data-active-quad-pane", "top");

  fireEvent.wheel(top, { deltaY: -120 });
  expect(Number(top.getAttribute("data-zoom"))).toBeGreaterThan(1);
  fireEvent.click(within(top).getByRole("button", { name: "适配视图" }));
  expect(top).toHaveAttribute("data-zoom", "1");

  const front = within(chrome).getByRole("region", { name: "前视视图" });
  fireEvent.doubleClick(front);
  expect(canvas).toHaveAttribute("data-active-quad-pane", "front");
  expect(canvas).toHaveAttribute("data-maximized-quad-pane", "front");
  expect(within(chrome).getAllByRole("region")).toHaveLength(1);
  expect(within(chrome).getByRole("button", { name: "恢复四视图" })).toBeInTheDocument();

  fireEvent.keyDown(window, { key: "Escape" });
  expect(canvas).not.toHaveAttribute("data-maximized-quad-pane");
  expect(within(chrome).getAllByRole("region")).toHaveLength(4);
  expect(screen.getByRole("button", { name: "退出四视图" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "移动" })).not.toBeInTheDocument();
});

it("keeps the native pointer mapping stable while switching navigation modes", () => {
  render(<App />);

  const canvas = screen.getByTestId("director-canvas");
  const controls = screen.getByTestId("orbit-controls");
  expect(canvas).toHaveAttribute("data-navigation-mode", "hand");
  expect(controls).toHaveAttribute("data-left-button", String(MOUSE.ROTATE));
  expect(controls).toHaveAttribute("data-right-button", String(MOUSE.PAN));

  fireEvent.click(screen.getByRole("button", { name: "游标浏览" }));

  expect(canvas).toHaveAttribute("data-navigation-mode", "cursor");
  expect(screen.getByTestId("orbit-controls")).toHaveAttribute("data-left-button", String(MOUSE.ROTATE));
  expect(screen.getByTestId("orbit-controls")).toHaveAttribute("data-right-button", String(MOUSE.PAN));
});

it("converts a model-library drop from world space into transformed scene coordinates", () => {
  const state = createInitialDirectorState();
  const scene = {
    ...state.project.scene,
    groundHeight: 0.4,
    position: [4, 1, -3] as [number, number, number],
    rotation: [0.15, 0.6, -0.08] as [number, number, number],
    scale: 0.6,
  };
  const sceneMatrix = new Matrix4().compose(
    new Vector3(...scene.position),
    new Quaternion().setFromEuler(new Euler(...scene.rotation)),
    new Vector3(scene.scale, scene.scale, scene.scale),
  );
  const localTarget = new Vector3(2.25, scene.groundHeight, -1.5);
  const worldTarget = localTarget.clone().applyMatrix4(sceneMatrix);
  const camera = new PerspectiveCamera(50, 800 / 600, 0.1, 1000);
  camera.position.copy(worldTarget.clone().add(new Vector3(5, 8, 10)));
  camera.lookAt(worldTarget);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();

  const position = getModelLibraryDropPosition({
    bounds: { height: 600, left: 100, top: 40, width: 800 },
    camera,
    clientX: 500,
    clientY: 340,
    scene,
  });

  expect(position[0]).toBeCloseTo(localTarget.x, 5);
  expect(position[1]).toBeCloseTo(localTarget.y, 5);
  expect(position[2]).toBeCloseTo(localTarget.z, 5);
});

it("falls back to the viewport focus instead of stacking failed drops at the origin", () => {
  const state = createInitialDirectorState();
  const scene = { ...state.project.scene, groundHeight: 0.3 };
  const camera = new PerspectiveCamera(50, 1, 0.1, 1000);
  camera.position.set(0, 2, 0);
  camera.lookAt(0, 3, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();

  expect(
    getModelLibraryDropPosition({
      bounds: { height: 400, left: 0, top: 0, width: 400 },
      camera,
      clientX: 200,
      clientY: 200,
      fallbackWorldTarget: new Vector3(3, scene.groundHeight, -2),
      scene,
    }),
  ).toEqual([3, scene.groundHeight, -2]);
});

it("places a dropped model on the first upward-facing visible scene surface", () => {
  const state = createInitialDirectorState();
  const scene = { ...state.project.scene, groundHeight: 0 };
  const camera = new PerspectiveCamera(50, 1, 0.1, 1000);
  camera.position.set(0, 6, 0);
  camera.up.set(0, 0, -1);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();

  const sceneRoot = new Group();
  const support = new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial());
  support.position.y = 1;
  sceneRoot.add(support);
  sceneRoot.updateMatrixWorld(true);

  const placement = getModelLibraryDropPlacement({
    bounds: { height: 400, left: 0, top: 0, width: 400 },
    camera,
    clientX: 200,
    clientY: 200,
    scene,
    sceneRoot,
  });

  expect(placement.source).toBe("surface");
  expect(placement.position).toEqual([0, 2, 0]);
});

it("ignores the visual ground mesh so ground placement uses the exact scene plane", () => {
  const state = createInitialDirectorState();
  const scene = { ...state.project.scene, groundHeight: 0 };
  const camera = new PerspectiveCamera(50, 1, 0.1, 1000);
  camera.position.set(0, 6, 0);
  camera.up.set(0, 0, -1);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();

  const sceneRoot = new Group();
  const visualGround = new Mesh(new BoxGeometry(200, 0.1, 200), new MeshBasicMaterial());
  visualGround.name = "director-player-ground";
  visualGround.position.y = -0.05;
  sceneRoot.add(visualGround);
  sceneRoot.updateMatrixWorld(true);

  const placement = getModelLibraryDropPlacement({
    bounds: { height: 400, left: 0, top: 0, width: 400 },
    camera,
    clientX: 200,
    clientY: 200,
    scene,
    sceneRoot,
  });

  expect(placement).toEqual({ position: [0, 0, 0], source: "ground" });
});

it("snaps horizontal drop coordinates while preserving the support height", () => {
  const state = createInitialDirectorState();
  const scene = { ...state.project.scene, groundHeight: 0.35, snapToGrid: true };
  const placement = getModelLibraryDropPlacement({
    bounds: { height: 0, left: 0, top: 0, width: 0 },
    clientX: 0,
    clientY: 0,
    fallbackWorldTarget: new Vector3(2.2, scene.groundHeight, -1.7),
    scene,
  });

  expect(placement).toEqual({ position: [2, scene.groundHeight, -2], source: "fallback" });
});

it("renders a live R3F viewport and director scene controls", () => {
  const { container } = render(<App />);
  const scenePanel = screen.getByLabelText("3D场景右侧属性面板");

  expect(screen.getByTestId("director-canvas")).toBeInTheDocument();
  expect(screen.queryByLabelText("场景缩放")).not.toBeInTheDocument();
  fireEvent.click(within(scenePanel).getByText("变换").closest("button")!);
  expect(screen.getByLabelText("场景缩放")).toBeInTheDocument();
  expect(screen.getByText("背景与全景")).toBeInTheDocument();
  expect(screen.queryByLabelText("全景球参数")).not.toBeInTheDocument();
  fireEvent.click(within(scenePanel).getByText("全景精调").closest("button")!);
  expect(screen.getByLabelText("全景球参数")).toBeInTheDocument();
  expect(screen.getByTestId("orbit-controls")).toHaveAttribute("data-enabled", "true");
  expect(container.querySelector(".director-stage-canvas")).toHaveAttribute("data-frameloop", "demand");
});

it("parks continuous stage rendering while the page is hidden", () => {
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const { container } = render(<App />);
  expandTimelineDock();

  fireEvent.click(screen.getByRole("button", { name: "播放动画" }));
  expect(container.querySelector(".director-stage-canvas")).toHaveAttribute("data-frameloop", "always");

  hidden.mockReturnValue(true);
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(container.querySelector(".director-stage-canvas")).toHaveAttribute("data-frameloop", "demand");

  hidden.mockReturnValue(false);
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(container.querySelector(".director-stage-canvas")).toHaveAttribute("data-frameloop", "always");
});

it("keeps viewport capture registered through the StrictMode mount probe", async () => {
  render(
    <StrictMode>
      <App />
    </StrictMode>,
  );

  await expect(requestViewportCapture({ preset: "current", source: "camera-panel" })).resolves.toHaveLength(1);
});

it("shows a lockable live camera inset in director view", () => {
  render(<App />);

  const inset = screen.getByLabelText("机位01 实时取景");
  expect(inset).toHaveTextContent("35 mm · 16:9");
  expect(inset.tagName).toBe("ASIDE");
  expect(inset).toHaveStyle({ "--camera-picture-in-picture-width": "320px", width: "320px" });
  expect(inset.querySelector(".camera-picture-in-picture__freeze")).not.toBeNull();
  const lock = screen.getByRole("button", { name: "锁定相机视图" });
  expect(lock).toHaveAttribute("aria-pressed", "false");

  fireEvent.click(lock);

  expect(screen.getByRole("button", { name: "解除相机视图锁定" })).toHaveAttribute("aria-pressed", "true");
});

it("keeps the camera inset lock control translated after its state changes", () => {
  window.localStorage.setItem("director.ui.locale", "en-US");
  const { unmount } = render(<App />);

  const lock = screen.getByRole("button", { name: "Lock camera view" });
  expect(lock).toHaveAttribute("title", "Lock camera view");

  fireEvent.click(lock);

  const unlock = screen.getByRole("button", { name: "Unlock camera view" });
  expect(unlock).toHaveAttribute("aria-pressed", "true");
  expect(unlock).toHaveAttribute("title", "Unlock camera view");

  unmount();
  window.localStorage.removeItem("director.ui.locale");
});

it("switches the camera monitor between previz, rgb, depth and normal modalities", () => {
  render(<App />);

  const modeGroup = screen.getByRole("group", { name: "相机预览模态" });
  const clay = within(modeGroup).getByRole("button", { name: "白模" });
  const rgb = within(modeGroup).getByRole("button", { name: "原彩" });
  const depth = within(modeGroup).getByRole("button", { name: "深度" });
  const normal = within(modeGroup).getByRole("button", { name: "法向" });
  expect(clay).toHaveAttribute("aria-pressed", "false");
  expect(rgb).toHaveAttribute("aria-pressed", "true");

  fireEvent.click(depth);

  expect(depth).toHaveAttribute("aria-pressed", "true");
  expect(clay).toHaveAttribute("aria-pressed", "false");
  expect(normal).toHaveAttribute("aria-pressed", "false");
});

it("offers objectid, mask, motion and wireframe monitor modalities after the core four", () => {
  render(<App />);

  const modeGroup = screen.getByRole("group", { name: "相机预览模态" });
  const buttons = within(modeGroup).getAllByRole("button");
  expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
    "白模",
    "原彩",
    "深度",
    "法向",
    "分割图",
    "蒙版",
    "光流",
    "线框",
  ]);
  expect(buttons.every((button) => button.querySelector("svg[data-preview-mode]"))).toBe(true);

  const segmentation = within(modeGroup).getByRole("button", { name: "分割图" });
  const mask = within(modeGroup).getByRole("button", { name: "蒙版" });
  const motion = within(modeGroup).getByRole("button", { name: "光流" });
  const wireframe = within(modeGroup).getByRole("button", { name: "线框" });
  expect(segmentation).toHaveAttribute("title", "分割图：按对象实例的稳定分割着色");
  expect(mask).toHaveAttribute("title", "蒙版图：前景纯白、背景纯黑");
  expect(motion).toHaveAttribute("title", "光流：帧间屏幕位移，色相表示方向，亮度表示幅度");
  expect(wireframe).toHaveAttribute("title", "线框：几何拓扑线框视图");

  fireEvent.click(segmentation);
  expect(segmentation).toHaveAttribute("aria-pressed", "true");
  expect(within(modeGroup).getByRole("button", { name: "白模" })).toHaveAttribute("aria-pressed", "false");

  fireEvent.click(mask);
  expect(mask).toHaveAttribute("aria-pressed", "true");
  expect(segmentation).toHaveAttribute("aria-pressed", "false");

  fireEvent.click(motion);
  expect(motion).toHaveAttribute("aria-pressed", "true");
  expect(mask).toHaveAttribute("aria-pressed", "false");

  fireEvent.click(wireframe);
  expect(wireframe).toHaveAttribute("aria-pressed", "true");
  expect(motion).toHaveAttribute("aria-pressed", "false");
});

it("renders and clears the lasso selection rectangle", () => {
  render(<App />);

  fireEvent.click(screen.getByRole("button", { name: "套索选择" }));
  const lasso = screen.getByLabelText("套索选择区域");
  expect(screen.getByText("拖动方框选择对象")).toBeInTheDocument();

  fireEvent.pointerDown(lasso, { button: 0, pointerId: 7, clientX: 80, clientY: 90 });
  fireEvent.pointerMove(lasso, { pointerId: 7, clientX: 280, clientY: 240 });
  expect(lasso.querySelector(".lasso-selection-box")).toHaveStyle({ width: "200px", height: "150px" });

  fireEvent.pointerUp(lasso, { pointerId: 7, clientX: 280, clientY: 240 });
  expect(screen.queryByLabelText("套索选择区域")).toBeInTheDocument();
  expect(screen.getByText("拖动方框选择对象")).toBeInTheDocument();
});

it("exits lasso selection from the toolbar or Escape", () => {
  render(<App />);

  const button = screen.getByRole("button", { name: "套索选择" });
  fireEvent.click(button);
  expect(screen.getByLabelText("套索选择区域")).toBeInTheDocument();

  fireEvent.click(button);
  expect(screen.queryByLabelText("套索选择区域")).not.toBeInTheDocument();
  expect(button).toHaveAttribute("aria-pressed", "false");

  fireEvent.click(button);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByLabelText("套索选择区域")).not.toBeInTheDocument();
  expect(button).toHaveAttribute("aria-pressed", "false");
});

it("exits lasso selection when a transform tool takes over", () => {
  render(<App />);

  fireEvent.click(screen.getByRole("button", { name: "套索选择" }));
  expect(screen.getByLabelText("套索选择区域")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "旋转" }));

  expect(screen.queryByLabelText("套索选择区域")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "套索选择" })).toHaveAttribute("aria-pressed", "false");
  expect(screen.getByRole("button", { name: "旋转" })).toHaveAttribute("aria-pressed", "true");
});

it("cancels a lasso gesture without committing a selection", () => {
  render(<App />);

  fireEvent.click(screen.getByRole("button", { name: "套索选择" }));
  const lasso = screen.getByLabelText("套索选择区域");
  const selectionBeforeCancel = useDirectorStore.getState().selectedObjectIds;

  fireEvent.pointerDown(lasso, { button: 0, pointerId: 12, clientX: 80, clientY: 90 });
  fireEvent.pointerMove(lasso, { pointerId: 12, clientX: 280, clientY: 240 });
  fireEvent.pointerCancel(lasso, { pointerId: 12 });

  expect(useDirectorStore.getState().selectedObjectIds).toEqual(selectionBeforeCancel);
  expect(lasso.querySelector(".lasso-selection-box")).not.toBeInTheDocument();
  expect(screen.getByText("拖动方框选择对象")).toBeInTheDocument();
});

it("disables lasso selection outside the single director viewport", () => {
  render(<App />);

  fireEvent.click(screen.getByRole("button", { name: "四视图" }));

  expect(screen.queryByRole("button", { name: "套索选择" })).not.toBeInTheDocument();
  expect(screen.queryByLabelText("套索选择区域")).not.toBeInTheDocument();
});

it("closes and disables lasso selection while timeline playback is running", () => {
  render(<App />);
  expandTimelineDock();

  fireEvent.click(screen.getByRole("button", { name: "套索选择" }));
  expect(screen.getByLabelText("套索选择区域")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "播放动画" }));

  expect(screen.queryByLabelText("套索选择区域")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "套索选择" })).toBeDisabled();
});

it("does not bind Space to the stage timeline playback control", () => {
  render(<App />);
  expandTimelineDock();

  expect(screen.getByRole("button", { name: "播放动画" })).toBeInTheDocument();
  fireEvent.keyDown(window, { code: "Space" });

  expect(screen.getByRole("button", { name: "播放动画" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "暂停动画" })).not.toBeInTheDocument();
});

it("accepts a model-library asset drop and places the created object in the scene", () => {
  const initialView = getInitialDirectorViewSnapshot(useDirectorStore.getState().project);
  render(<App />);

  const canvas = screen.getByTestId("director-canvas");
  const item = {
    assetSource: "library" as const,
    categoryId: "flick" as const,
    catalogCategory: "animals",
    fileName: "cat.glb",
    flickCategory: "animals" as const,
    id: "flick:animals:cat.glb",
    kind: "prop" as const,
    name: "Cat",
    url: "/flick-stage-props/animals/cat.glb",
  };
  const payload = JSON.stringify(createModelLibraryDragPayload(item));
  const dataTransfer = {
    dropEffect: "none",
    types: [MODEL_LIBRARY_DRAG_MIME],
    getData: (type: string) => (type === MODEL_LIBRARY_DRAG_MIME ? payload : ""),
  } as unknown as DataTransfer;

  fireEvent.dragOver(canvas, { dataTransfer });
  expect(canvas).toHaveClass("is-asset-drop-target");
  expect(screen.queryByText("释放以添加到场景")).not.toBeInTheDocument();
  fireEvent.dragEnd(window);
  expect(canvas).not.toHaveClass("is-asset-drop-target");

  fireEvent.dragOver(canvas, { dataTransfer, clientX: 420, clientY: 280 });
  expect(screen.getByText("释放以放置")).toBeInTheDocument();
  fireEvent.dragEnd(window);
  expect(screen.queryByText("释放以放置")).not.toBeInTheDocument();
  expect(canvas).not.toHaveClass("is-asset-drop-target");

  fireEvent.dragOver(canvas, { dataTransfer });
  fireEvent.drop(canvas, { dataTransfer, clientX: 420, clientY: 280 });

  let state = useDirectorStore.getState();
  const asset = state.project.assets.find((entry) => entry.fileName === "cat.glb");
  let objects = state.project.objects.filter((entry) => entry.assetRefId === asset?.id);
  expect(asset).toMatchObject({ assetSource: "library", url: "/flick-stage-props/animals/cat.glb" });
  expect(objects).toHaveLength(1);
  expect(objects[0]).toMatchObject({
    name: "Cat",
    transform: { position: initialView.target },
  });
  expect(canvas).not.toHaveClass("is-asset-drop-target");

  fireEvent.dragOver(canvas, { dataTransfer });
  fireEvent.drop(canvas, { dataTransfer, clientX: 520, clientY: 320 });

  state = useDirectorStore.getState();
  objects = state.project.objects.filter((entry) => entry.assetRefId === asset?.id);
  expect(state.project.assets.filter((entry) => entry.url === item.url)).toHaveLength(1);
  expect(objects).toHaveLength(2);

  useDirectorStore.getState().undo();
  state = useDirectorStore.getState();
  expect(state.project.assets.filter((entry) => entry.url === item.url)).toHaveLength(1);
  expect(state.project.objects.filter((entry) => entry.assetRefId === asset?.id)).toHaveLength(1);

  useDirectorStore.getState().undo();
  state = useDirectorStore.getState();
  expect(state.project.assets.filter((entry) => entry.url === item.url)).toHaveLength(0);
  expect(state.project.objects.filter((entry) => entry.assetRefId === asset?.id)).toHaveLength(0);
});

it("keeps Mixamo metadata when a character card is dropped and creates no 3D drop marker", () => {
  const initialView = getInitialDirectorViewSnapshot(useDirectorStore.getState().project);
  const { container } = render(<App />);
  const canvas = screen.getByTestId("director-canvas");
  const item = getMixamoCharacterCatalogItem("mixamo:abe")!;
  const payload = JSON.stringify(createModelLibraryDragPayload(item));
  const dataTransfer = {
    dropEffect: "none",
    types: [MODEL_LIBRARY_DRAG_MIME],
    getData: (type: string) => (type === MODEL_LIBRARY_DRAG_MIME ? payload : ""),
  } as unknown as DataTransfer;

  fireEvent.dragOver(canvas, { dataTransfer, clientX: 420, clientY: 280 });
  expect(container.querySelector('group[name="director-drop-preview"]')).not.toBeInTheDocument();
  fireEvent.drop(canvas, { dataTransfer, clientX: 420, clientY: 280 });

  const state = useDirectorStore.getState();
  const asset = state.project.assets.find((entry) => entry.url === item.url);
  const object = state.project.objects.find((entry) => entry.assetRefId === asset?.id);

  expect(asset?.characterMetadata).toEqual(item.characterMetadata);
  expect(object).toMatchObject({
    kind: "character",
    placementMode: "grounded",
    characterRig: { rigType: "mixamo" },
    transform: { position: initialView.target },
  });
  expect(createDirectorPlayerObstacle(object!, asset)).toMatchObject({
    shape: "circle",
    walkableSurface: false,
  });
});

it("enters and exits character exploration while temporarily disabling editor controls", () => {
  render(<App />);

  fireEvent.click(screen.getByRole("button", { name: "角色漫游" }));

  const playerHud = screen.getByRole("complementary", { name: "角色漫游控制" });
  expect(playerHud).toBeInTheDocument();
  expect(within(playerHud).getByRole("button", { name: "退出角色漫游" })).toBeInTheDocument();
  expect(within(playerHud).getByText("点击场景锁定鼠标转向")).toBeInTheDocument();
  expect(screen.getByRole("complementary", { name: "技能施放" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "霜矛" })).toBeInTheDocument();
  // Disabled OrbitControls still applies residual damping on every frame.
  // Character roam owns the camera exclusively, so the editor controls must
  // be fully unmounted for the duration of the mode.
  expect(screen.queryByTestId("orbit-controls")).not.toBeInTheDocument();
  expect(screen.getByTestId("mock-scene-root")).toHaveAttribute("data-playing", "true");

  fireEvent.click(within(playerHud).getByRole("button", { name: "退出角色漫游" }));

  expect(screen.queryByRole("complementary", { name: "角色漫游控制" })).not.toBeInTheDocument();
  expect(screen.queryByRole("complementary", { name: "技能施放" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "角色漫游" })).toBeInTheDocument();
  expect(screen.getByTestId("orbit-controls")).toHaveAttribute("data-enabled", "true");
});

it("starts character exploration from the evaluated non-zero timeline frame instead of the base transform", () => {
  const state = createInitialDirectorState();
  const source = state.project.objects.find((object) => object.kind === "character")!;
  const animated = {
    ...source,
    transform: {
      position: [0, 0, 0] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number],
    },
    animation: {
      version: 1 as const,
      keyframes: [
        {
          frame: 0,
          interpolation: "linear" as const,
          transform: {
            position: [0, 0, 0] as [number, number, number],
            rotation: [0, 0, 0] as [number, number, number],
            scale: [1, 1, 1] as [number, number, number],
          },
        },
        {
          frame: 48,
          interpolation: "linear" as const,
          transform: {
            position: [12, 2, -4] as [number, number, number],
            rotation: [0, 1, 0] as [number, number, number],
            scale: [1, 1, 1] as [number, number, number],
          },
        },
      ],
    },
  };

  const active = getPlayerActorAtFrame([animated], animated.id, 24, 24);

  expect(active?.transform).toEqual({
    position: [6, 1, -2],
    rotation: [0, 0.5, 0],
    scale: [1, 1, 1],
  });
  expect(animated.transform.position).toEqual([0, 0, 0]);
  expect(getPlayerActorAtFrame([animated], null, 24, 24)).toBeNull();
});

it("uses mounted geometry for every imported non-character collision asset", () => {
  const prop = {
    id: "imported-prop",
    name: "Imported prop",
    kind: "prop" as const,
    visible: true,
    locked: false,
    assetRefId: "prop-asset",
    transform: {
      position: [2, 0, -1] as [number, number, number],
      rotation: [0, 0.3, 0] as [number, number, number],
      scale: [1.5, 1, 0.8] as [number, number, number],
    },
  };
  const asset = {
    id: "prop-asset",
    kind: "prop" as const,
    sourceType: "model" as const,
    fileName: "set-dressing.glb",
    url: "/models/set-dressing.glb",
  };

  expect(createDirectorPlayerObstacle(prop, asset)).toMatchObject({
    id: "imported-prop",
    meshRevision: "prop-asset:/models/set-dressing.glb",
    shape: "mesh",
  });
});

it("builds every video frame capture request with the selected render camera", () => {
  expect(createDirectorVideoFrameCaptureRequest(" cam_1 ", 24)).toEqual({
    preset: "current",
    source: "capture-panel",
    cameraId: "cam_1",
    cleanPlate: true,
    frame: 24,
    width: 1920,
    height: 1080,
  });
  expect(createDirectorVideoFrameCaptureRequest("cam_1", 24, "9:16")).toMatchObject({
    width: 1080,
    height: 1920,
  });
  expect(createDirectorVideoFrameCaptureRequest("cam_1", 24, "2.39:1")).toMatchObject({
    width: 1920,
    height: 804,
  });
  expect(() => createDirectorVideoFrameCaptureRequest("", 24)).toThrow("有效的活动机位");
  expect(() => createDirectorVideoFrameCaptureRequest("cam_1", 1.5)).toThrow("非负整数帧");
});

it("scrubs and plays the optional timeline in local UI state without persisting every frame", () => {
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
          frameEnd: 48,
          currentFrame: 1,
          loop: true,
        },
      },
    },
  });

  render(<App />);
  expandTimelineDock();

  expect(screen.getByLabelText("场景动画时间轴")).toBeInTheDocument();
  expect(screen.getByTestId("mock-scene-root")).toHaveAttribute("data-current-frame", "1");

  act(() => useTimelineRuntimeStore.getState().setPlayheadFrame(24));
  expect(screen.getByTestId("mock-scene-root")).toHaveAttribute("data-current-frame", "24");
  expect(useDirectorStore.getState().project.scene.timeline?.currentFrame).toBe(1);

  fireEvent.click(screen.getByRole("button", { name: "播放动画" }));
  expect(screen.getByTestId("mock-scene-root")).toHaveAttribute("data-playing", "true");
});

it("updates playhead consumers without rerendering the top-level R3F canvas", () => {
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
          frameStart: 0,
          frameEnd: 48,
          currentFrame: 0,
          loop: true,
        },
      },
    },
  });

  render(<App />);
  expect(screen.getByTestId("mock-scene-root")).toHaveAttribute("data-current-frame", "0");
  const canvasRenderCount = mockMainCanvasRender.mock.calls.length;

  act(() => useTimelineRuntimeStore.getState().setPlayheadFrame(24));

  expect(screen.getByTestId("mock-scene-root")).toHaveAttribute("data-current-frame", "24");
  expect(mockMainCanvasRender).toHaveBeenCalledTimes(canvasRenderCount);
  expect(useDirectorStore.getState().project.scene.timeline?.currentFrame).toBe(0);
});

it("advances RAF playback through the transient playhead without rerendering the top-level canvas", () => {
  const state = createInitialDirectorState();
  const sourceCamera = state.project.cameras[0];
  const animatedCamera = {
    ...sourceCamera,
    animation: {
      version: 1 as const,
      enabled: true,
      preset: "line" as const,
      keyframes: [
        {
          frame: 0,
          interpolation: "linear" as const,
          transform: {
            position: [0, 2, 8] as [number, number, number],
            rotation: [0, 0, 0] as [number, number, number],
            scale: [1, 1, 1] as [number, number, number],
          },
          lookTarget: [0, 1, 0] as [number, number, number],
          fov: 35,
        },
        {
          frame: 24,
          interpolation: "linear" as const,
          transform: {
            position: [8, 4, 2] as [number, number, number],
            rotation: [0, 0, 0] as [number, number, number],
            scale: [1, 1, 1] as [number, number, number],
          },
          lookTarget: [1, 1.5, 0] as [number, number, number],
          fov: 50,
        },
      ],
    },
  };
  useDirectorStore.setState({
    ...state,
    project: {
      ...state.project,
      activeCameraId: animatedCamera.id,
      cameras: [animatedCamera],
      scene: {
        ...state.project.scene,
        timeline: {
          version: 1,
          fps: 24,
          frameStart: 0,
          frameEnd: 48,
          currentFrame: 0,
          loop: true,
        },
      },
    },
  });
  const animationFrames = new Map<number, FrameRequestCallback>();
  let nextAnimationFrameId = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    nextAnimationFrameId += 1;
    animationFrames.set(nextAnimationFrameId, callback);
    return nextAnimationFrameId;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((frameId) => {
    animationFrames.delete(frameId);
  });

  const { unmount } = render(<App />);
  expandTimelineDock();
  fireEvent.click(screen.getByRole("button", { name: "播放动画" }));
  const runNextFrame = (time: number) => {
    const [frameId, callback] = animationFrames.entries().next().value as [number, FrameRequestCallback];
    animationFrames.delete(frameId);
    act(() => callback(time));
  };

  runNextFrame(1_000);
  const canvasRenderCount = mockMainCanvasRender.mock.calls.length;
  const gizmoRenderCount = mockGizmoCanvasRender.mock.calls.length;
  runNextFrame(1_500);

  expect(screen.getByTestId("mock-scene-root")).toHaveAttribute("data-current-frame", "12");
  expect(mockMainCanvasRender).toHaveBeenCalledTimes(canvasRenderCount);
  expect(mockGizmoCanvasRender).toHaveBeenCalledTimes(gizmoRenderCount);
  expect(useDirectorStore.getState().project.scene.timeline?.currentFrame).toBe(0);

  const expectedPilotSnapshot = getCameraViewSnapshotFromShot(evaluateDirectorCameraAtFrame(animatedCamera, 12));
  const stalePilotSnapshot = getCameraViewSnapshotFromShot(evaluateDirectorCameraAtFrame(animatedCamera, 0));
  expect(expectedPilotSnapshot.position).not.toEqual(stalePilotSnapshot.position);
  mockCameraPositionSet.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "开始掌镜" }));
  expect(mockCameraPositionSet).toHaveBeenCalledWith(...expectedPilotSnapshot.position);
  unmount();
});

it("pauses on an exact requested frame and waits for rendering before capture", async () => {
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
          frameEnd: 48,
          currentFrame: 1,
          loop: true,
        },
      },
    },
  });
  const animationFrames = new Map<number, FrameRequestCallback>();
  let nextAnimationFrameId = 0;
  const requestAnimationFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    nextAnimationFrameId += 1;
    animationFrames.set(nextAnimationFrameId, callback);
    return nextAnimationFrameId;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((frameId) => {
    animationFrames.delete(frameId);
  });

  render(<App />);
  expandTimelineDock();
  fireEvent.click(screen.getByRole("button", { name: "播放动画" }));
  expect(screen.getByTestId("mock-scene-root")).toHaveAttribute("data-playing", "true");

  let results: Awaited<ReturnType<typeof requestViewportCapture>> = [];
  const capturePromise = act(async () => {
    results = await requestViewportCapture({
      preset: "current",
      source: "capture-panel",
      frame: 24,
      revisionRequested: 9,
    });
  });
  await Promise.resolve();
  while (animationFrames.size > 0) {
    const [frameId, callback] = animationFrames.entries().next().value as [number, FrameRequestCallback];
    animationFrames.delete(frameId);
    callback(performance.now());
    await Promise.resolve();
  }
  await capturePromise;

  // The capture contract needs three render barriers. Other mounted UI
  // services (for example deferred document translation) may schedule their
  // own frame without changing capture correctness.
  expect(requestAnimationFrame.mock.calls.length).toBeGreaterThanOrEqual(3);
  expect(screen.getByTestId("mock-scene-root")).toHaveAttribute("data-current-frame", "24");
  expect(screen.getByTestId("mock-scene-root")).toHaveAttribute("data-playing", "false");
  expect(results[0]?.meta).toMatchObject({ frame: 24, revisionRequested: 9 });
});

it("renders the moving active camera at each requested video frame even in director view", async () => {
  const state = createInitialDirectorState();
  const sourceCamera = state.project.cameras[0];
  const animatedCamera = {
    ...sourceCamera,
    nearClipM: 0.02,
    farClipM: 8_000,
    animation: {
      version: 1 as const,
      enabled: true,
      preset: "line" as const,
      keyframes: [
        {
          frame: 0,
          transform: {
            position: [0, 2, 8] as [number, number, number],
            rotation: [0, 0, 0] as [number, number, number],
            scale: [1, 1, 1] as [number, number, number],
          },
          lookTarget: [0, 1, 0] as [number, number, number],
          fov: 35,
        },
        {
          frame: 48,
          transform: {
            position: [8, 4, 2] as [number, number, number],
            rotation: [0, 0, 0] as [number, number, number],
            scale: [1, 1, 1] as [number, number, number],
          },
          lookTarget: [1, 1.5, 0] as [number, number, number],
          fov: 50,
        },
      ],
    },
  };
  useDirectorStore.setState({
    ...state,
    viewMode: "director",
    project: {
      ...state.project,
      scene: {
        ...state.project.scene,
        timeline: {
          version: 1,
          fps: 24,
          frameStart: 0,
          frameEnd: 48,
          currentFrame: 0,
          loop: false,
        },
      },
      cameras: [animatedCamera],
      activeCameraId: animatedCamera.id,
    },
  });

  const animationFrames = new Map<number, FrameRequestCallback>();
  let nextAnimationFrameId = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    nextAnimationFrameId += 1;
    animationFrames.set(nextAnimationFrameId, callback);
    return nextAnimationFrameId;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((frameId) => {
    animationFrames.delete(frameId);
  });
  render(<App />);
  mockGlRender.mockClear();

  async function captureFrame(frame: number) {
    let result: Awaited<ReturnType<typeof requestViewportCapture>> = [];
    const pending = act(async () => {
      result = await requestViewportCapture({
        preset: "current",
        source: "capture-panel",
        cameraId: animatedCamera.id,
        cleanPlate: true,
        frame,
      });
    });
    await Promise.resolve();
    while (animationFrames.size > 0) {
      const [frameId, callback] = animationFrames.entries().next().value as [number, FrameRequestCallback];
      animationFrames.delete(frameId);
      callback(performance.now());
      await Promise.resolve();
    }
    await pending;
    return result[0]!;
  }

  const first = await captureFrame(0);
  const last = await captureFrame(48);
  const firstExpected = getCameraViewSnapshotFromShot(evaluateDirectorCameraAtFrame(animatedCamera, 0));
  const lastExpected = getCameraViewSnapshotFromShot(evaluateDirectorCameraAtFrame(animatedCamera, 48));

  expect(first.meta).toMatchObject({
    mode: "camera",
    cameraId: animatedCamera.id,
    frame: 0,
    fov: 35,
    position: firstExpected.position,
    target: firstExpected.target,
  });
  expect(last.meta).toMatchObject({
    mode: "camera",
    cameraId: animatedCamera.id,
    frame: 48,
    fov: 50,
    position: lastExpected.position,
    target: lastExpected.target,
  });
  expect(last.meta.position).not.toEqual(first.meta.position);
  expect(mockRenderCameraClippingSnapshots).toContainEqual([0.02, 8_000]);
  expect(mockRenderCameraClippingSnapshots.at(-1)).toEqual([0.1, 1_000]);
});

it("cancels a pending capture RAF on unmount without rendering afterwards", async () => {
  const animationFrames = new Map<number, FrameRequestCallback>();
  const scheduledCallbacks: FrameRequestCallback[] = [];
  let nextAnimationFrameId = 0;
  const requestAnimationFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    nextAnimationFrameId += 1;
    animationFrames.set(nextAnimationFrameId, callback);
    scheduledCallbacks.push(callback);
    return nextAnimationFrameId;
  });
  const cancelAnimationFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((frameId) => {
    animationFrames.delete(frameId);
  });
  const { unmount } = render(<App />);

  const capture = requestViewportCapture({
    preset: "current",
    source: "capture-panel",
    frame: 0,
  });
  const rejected = capture.catch((error: unknown) => error);
  await vi.waitFor(() => expect(requestAnimationFrame).toHaveBeenCalledTimes(1));
  const renderCountBeforeUnmount = mockGlRender.mock.calls.length;

  unmount();
  expect(await rejected).toMatchObject({ name: "AbortError" });
  scheduledCallbacks.forEach((callback) => callback(performance.now()));
  await Promise.resolve();

  expect(cancelAnimationFrame).toHaveBeenCalledTimes(1);
  expect(animationFrames.size).toBe(0);
  expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
  expect(mockGlRender).toHaveBeenCalledTimes(renderCountBeforeUnmount);
  expect(mockCanvasToDataURL).not.toHaveBeenCalled();
});

it("stops a multi-view capture before snapshotting or restoring when its signal aborts during render", async () => {
  const controller = new AbortController();
  render(<App />);
  mockGlRender.mockImplementationOnce(() => controller.abort());

  const capture = requestViewportCapture({
    preset: "twelve",
    source: "capture-panel",
    signal: controller.signal,
  });

  await expect(capture).rejects.toMatchObject({ name: "AbortError" });
  expect(mockGlRender).toHaveBeenCalledTimes(1);
  expect(mockCanvasToDataURL).not.toHaveBeenCalled();
});

it("keeps orbit controls available when a transformable object is selected but no handle is being dragged", () => {
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    selectedObjectId: "char_default_a",
  });

  render(<App />);

  expect(screen.getByTestId("orbit-controls")).toHaveAttribute("data-enabled", "true");
});

it("does not render a full-viewport transform drag layer over the 3D viewport", () => {
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    selectedObjectId: "char_default_a",
  });

  render(<App />);

  expect(screen.queryByRole("application", { name: "3D视口移动拖拽层" })).not.toBeInTheDocument();
  expect(screen.queryByRole("application", { name: "3D视口旋转拖拽层" })).not.toBeInTheDocument();
  expect(screen.queryByRole("application", { name: "3D视口缩放拖拽层" })).not.toBeInTheDocument();
});

it("renders the neutral previz viewport grid", () => {
  render(<App />);

  const snapshot = getInitialDirectorViewSnapshot(useDirectorStore.getState().project);
  const fadeDistance = getViewportGridFadeDistance(
    Math.hypot(
      snapshot.position[0] - snapshot.target[0],
      snapshot.position[1] - snapshot.target[1],
      snapshot.position[2] - snapshot.target[2],
    ),
  );

  expect(screen.getByTestId("viewport-grid")).toHaveAttribute("data-position", "[0,0.002,0]");
  expect(screen.getByTestId("viewport-grid")).toHaveAttribute("data-cell-color", DIRECTOR_PREVIZ_PALETTE.gridMinor);
  expect(screen.getByTestId("viewport-grid")).toHaveAttribute("data-cell-size", "1");
  expect(screen.getByTestId("viewport-grid")).toHaveAttribute("data-cell-thickness", "0.5");
  expect(screen.getByTestId("viewport-grid")).toHaveAttribute("data-section-color", DIRECTOR_PREVIZ_PALETTE.gridMajor);
  expect(screen.getByTestId("viewport-grid")).toHaveAttribute("data-section-size", "10");
  expect(screen.getByTestId("viewport-grid")).toHaveAttribute("data-fade-distance", String(fadeDistance));
  expect(screen.getByTestId("viewport-grid")).toHaveAttribute(
    "data-fade-strength",
    String(VIEWPORT_GRID_FADE_STRENGTH),
  );
  expect(screen.getByTestId("viewport-grid")).toHaveAttribute("data-follow-camera", "true");
  expect(screen.getByTestId("viewport-grid")).toHaveAttribute("data-infinite-grid", "true");
});

it("keeps the viewport grid on the transformed scene ground plane", () => {
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    project: {
      ...useDirectorStore.getState().project,
      scene: {
        ...useDirectorStore.getState().project.scene,
        groundHeight: 1.5,
        position: [3, 4, 5],
        rotation: [0.1, 0.2, 0.3],
        scale: 0.75,
      },
    },
  });

  render(<App />);

  const viewportGrid = screen.getByTestId("viewport-grid");
  const sceneGridTransform = viewportGrid.closest('group[name="director-viewport-ground-grid"]');

  expect(viewportGrid).toHaveAttribute("data-position", "[0,1.502,0]");
  expect(sceneGridTransform).toHaveAttribute("position", "3,4,5");
  expect(sceneGridTransform).toHaveAttribute("rotation", "0.1,0.2,0.3");
  expect(sceneGridTransform).toHaveAttribute("scale", "0.75,0.75,0.75");
});

it("opens the scene inspector when users click empty 3D viewport space", () => {
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    selectedObjectId: "char_default_a",
  });

  render(<App />);

  expect(screen.getByLabelText("角色名称")).toBeInTheDocument();

  fireEvent.click(within(screen.getByTestId("director-canvas")).getByTestId("mock-r3f-canvas"));

  expect(useDirectorStore.getState().selectedObjectId).toBeNull();
  const scenePanel = screen.getByLabelText("3D场景右侧属性面板");
  expect(scenePanel).toBeInTheDocument();
  expect(screen.queryByLabelText("场景缩放")).not.toBeInTheDocument();
  fireEvent.click(within(scenePanel).getByText("变换").closest("button")!);
  expect(screen.getByLabelText("场景缩放")).toBeInTheDocument();
});

it("keeps the output aspect ratio available without drawing a viewport picture frame", () => {
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    viewportAspectRatio: "9:16",
  });

  render(<App />);

  expect(useDirectorStore.getState().viewportAspectRatio).toBe("9:16");
  expect(screen.queryByLabelText("视口画幅框")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("视口画幅遮罩")).not.toBeInTheDocument();
});

it("does not draw the rule-of-thirds control in the viewport", () => {
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    viewportAspectRatio: "16:9",
    viewportRuleOfThirdsEnabled: false,
  });

  render(<App />);

  expect(screen.queryByRole("button", { name: "开启九宫格辅助线" })).not.toBeInTheDocument();
  expect(screen.queryByLabelText("九宫格辅助线")).not.toBeInTheDocument();
});

it("renders the native 3D viewport gizmo in an overlay canvas above the aspect mask", () => {
  render(<App />);

  expect(screen.getAllByTestId("mock-r3f-canvas")).toHaveLength(2);
  expect(screen.getByLabelText("3D视口原生坐标控件")).toContainElement(screen.getByTestId("native-gizmo-helper"));
  expect(screen.getByTestId("native-gizmo-helper")).toHaveAttribute("data-alignment", "center-center");
  expect(screen.getByTestId("native-gizmo-helper")).toHaveAttribute("data-margin", "[0,0]");
  expect(screen.getByTestId("native-gizmo-viewport")).toHaveAttribute(
    "data-axis-colors",
    '["#FF5A4F","#34C759","#0A84FF"]',
  );
  expect(screen.getByTestId("native-gizmo-viewport")).toHaveAttribute("data-disabled", "true");
  expect(screen.getByTestId("native-gizmo-viewport")).toHaveAttribute("data-scale", "28");
  expect(screen.getByTestId("native-gizmo-viewport").closest(".director-canvas")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("3D视口坐标指示")).not.toBeInTheDocument();
});

it("keeps the native viewport gizmo at the central viewport edge when side panels are open", () => {
  render(<App />);

  const gizmo = screen.getByLabelText("3D视口原生坐标控件");

  expect(gizmo).toHaveStyle({
    right: "20px",
  });
});

it("syncs native viewport gizmo axis clicks back to the main director view", () => {
  const initialView = getInitialDirectorViewSnapshot(useDirectorStore.getState().project);
  const distance = Math.hypot(
    initialView.position[0] - initialView.target[0],
    initialView.position[1] - initialView.target[1],
    initialView.position[2] - initialView.target[2],
  );
  render(<App />);
  mockCameraPositionSet.mockClear();
  mockOrbitTargetSet.mockClear();
  mockOrbitUpdate.mockClear();

  const gizmo = screen.getByLabelText("3D视口原生坐标控件");
  const xAxisHitTarget = screen.getByRole("button", { name: "切换到 X 正向视图" });
  const setPointerCapture = vi.fn();
  Object.defineProperty(gizmo, "setPointerCapture", { configurable: true, value: setPointerCapture });

  fireEvent.pointerDown(xAxisHitTarget, {
    button: 0,
    clientX: 100,
    clientY: 100,
    isPrimary: true,
    pointerId: 3,
  });
  fireEvent.pointerUp(xAxisHitTarget, { clientX: 100, clientY: 100, isPrimary: true, pointerId: 3 });
  expect(setPointerCapture).not.toHaveBeenCalled();

  fireEvent.click(xAxisHitTarget);

  expect(mockCameraPositionSet).toHaveBeenCalledWith(
    expect.closeTo(initialView.target[0] + distance, 5),
    initialView.target[1],
    initialView.target[2],
  );
  expect(mockOrbitTargetSet).toHaveBeenCalledWith(...initialView.target);
  expect(mockOrbitUpdate).toHaveBeenCalled();
});

it("orbits the main viewport when the full native gizmo is dragged and stops after pointer cancel", () => {
  const initialView = getInitialDirectorViewSnapshot(useDirectorStore.getState().project);
  render(<App />);
  mockCameraPositionSet.mockClear();
  mockOrbitTargetSet.mockClear();
  mockOrbitUpdate.mockClear();

  const gizmo = screen.getByLabelText("3D视口原生坐标控件");
  fireEvent.pointerDown(gizmo, { button: 0, clientX: 100, clientY: 100, isPrimary: true, pointerId: 7 });
  fireEvent.pointerMove(gizmo, { clientX: 126, clientY: 112, isPrimary: true, pointerId: 7 });

  expect(gizmo).toHaveClass("is-dragging");
  expect(mockCameraPositionSet).toHaveBeenCalled();
  expect(mockOrbitTargetSet).toHaveBeenCalledWith(...initialView.target);
  expect(mockOrbitUpdate).toHaveBeenCalled();

  fireEvent.pointerCancel(gizmo, { clientX: 126, clientY: 112, isPrimary: true, pointerId: 7 });
  expect(gizmo).not.toHaveClass("is-dragging");

  mockCameraPositionSet.mockClear();
  fireEvent.pointerMove(gizmo, { clientX: 150, clientY: 128, isPrimary: true, pointerId: 7 });
  expect(mockCameraPositionSet).not.toHaveBeenCalled();
});

it("clears a gizmo drag when pointer capture is unavailable and the pointer leaves the overlay", () => {
  render(<App />);
  mockCameraPositionSet.mockClear();

  const gizmo = screen.getByLabelText("3D视口原生坐标控件");
  Object.defineProperty(gizmo, "setPointerCapture", {
    configurable: true,
    value: () => {
      throw new DOMException("capture unavailable");
    },
  });

  fireEvent.pointerDown(gizmo, { button: 0, clientX: 100, clientY: 100, isPrimary: true, pointerId: 9 });
  fireEvent.pointerMove(gizmo, { clientX: 126, clientY: 112, isPrimary: true, pointerId: 9 });
  expect(gizmo).toHaveClass("is-dragging");

  fireEvent.pointerLeave(gizmo, { clientX: 132, clientY: 116, isPrimary: true, pointerId: 9 });
  expect(gizmo).not.toHaveClass("is-dragging");

  mockCameraPositionSet.mockClear();
  fireEvent.pointerMove(gizmo, { clientX: 150, clientY: 128, isPrimary: true, pointerId: 9 });
  expect(mockCameraPositionSet).not.toHaveBeenCalled();
});

it("hides the viewport gizmo while camera pilot mode owns the director camera", () => {
  render(<App />);

  expect(screen.getByLabelText("3D视口原生坐标控件")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "开始掌镜" }));

  expect(screen.getByLabelText("掌镜模式")).toBeInTheDocument();
  expect(screen.queryByLabelText("3D视口原生坐标控件")).not.toBeInTheDocument();
});

it("captures screenshots using the selected viewport aspect ratio crop", async () => {
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    viewportAspectRatio: "9:16",
  });

  const originalCreateElement = document.createElement.bind(document);
  const drawImage = vi.fn();
  const cropCanvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => ({
      drawImage,
    })),
    toDataURL: vi.fn(() => "data:image/png;base64,cropped"),
  };

  vi.spyOn(document, "createElement").mockImplementation(((tagName: string) => {
    if (tagName === "canvas") {
      return cropCanvas as unknown as HTMLCanvasElement;
    }

    return originalCreateElement(tagName);
  }) as typeof document.createElement);

  render(<App />);

  const results = await requestViewportCapture({
    preset: "current",
    source: "capture-panel",
  });

  expect(results[0]?.dataUrl).toBe("data:image/png;base64,cropped");
  expect(drawImage).toHaveBeenCalledTimes(1);
  expect(cropCanvas.width / cropCanvas.height).toBeCloseTo(9 / 16, 2);
});

it("encodes an exact-size auxiliary GPU pass and returns its object-ID metadata", async () => {
  const rgba = Uint8Array.from([1, 2, 3, 255, 4, 5, 6, 255]);
  mockCaptureDirectorCinematicRenderPass.mockReturnValue({
    rgba,
    metadata: {
      renderPass: "object-id",
      width: 2,
      height: 1,
      pixelFormat: "rgba8",
      bitsPerChannel: 8,
      rowOrder: "top-to-bottom",
      colorSpace: "data",
      encoding: "object-id-rgb",
      helpersExcluded: true,
      objectIdToRgb: { char_default_a: [1, 2, 3] },
      anamorphic: {
        applied: true,
        squeeze: 1.8,
        horizontalFovDegreesBefore: 60,
        horizontalFovDegreesAfter: 80,
      },
      depthOfField: {
        applied: false,
        requested: true,
        quality: "high",
        bypassReason: "technical-pass",
        apertureFStop: 2.8,
        focusDistanceM: 5,
        focalLengthMm: 35,
        sensorHeightMm: 20,
        apertureDiameterMm: 12.5,
        sampleCount: 0,
        renderScale: 1,
        maxBlurPixels: 24,
        depthEncoding: "hardware-perspective-depth",
      },
    },
  });
  const encodedData = new Uint8ClampedArray(8);
  const putImageData = vi.fn();
  const passCanvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => ({
      createImageData: vi.fn(() => ({ data: encodedData, width: 2, height: 1 })),
      putImageData,
    })),
    toDataURL: vi.fn(() => "data:image/png;base64,object-id"),
  };
  const originalCreateElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((tagName: string) =>
    tagName === "canvas"
      ? (passCanvas as unknown as HTMLCanvasElement)
      : originalCreateElement(tagName)) as typeof document.createElement);

  render(<App />);
  mockGlRender.mockClear();
  const [result] = await requestViewportCapture({
    preset: "current",
    source: "camera-panel",
    cameraId: "cam_1",
    cleanPlate: true,
    includeRenderPixels: true,
    renderPass: "object-id",
    width: 2,
    height: 1,
  });

  expect(mockCaptureDirectorCinematicRenderPass).toHaveBeenCalledWith(
    expect.objectContaining({
      cameraShot: expect.objectContaining({ id: "cam_1" }),
      depthOfField: { quality: "high", enabled: true },
      renderPass: "object-id",
      width: 2,
      height: 1,
    }),
  );
  expect(mockGlRender).not.toHaveBeenCalled();
  expect([...encodedData]).toEqual([...rgba]);
  expect(putImageData).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({
    dataUrl: "data:image/png;base64,object-id",
    renderPixels: {
      width: 2,
      height: 1,
      format: "rgba8",
      data: rgba,
    },
    meta: {
      renderPass: "object-id",
      raster: { width: 2, height: 1 },
      objectIdColors: { char_default_a: [1, 2, 3] },
      anamorphic: { applied: true, squeeze: 1.8 },
      depthOfField: { applied: false, quality: "high", bypassReason: "technical-pass" },
    },
  });
});

it("renders a requested camera even when it is not the active viewport camera", async () => {
  const state = useDirectorStore.getState();
  const requestedCamera = {
    ...state.project.cameras[0],
    id: "cam_requested",
    name: "请求机位",
    fov: 27,
    transform: {
      ...state.project.cameras[0].transform,
      position: [9, 4, 3] as [number, number, number],
    },
    target: [1, 1.5, 2] as [number, number, number],
  };
  useDirectorStore.setState({
    ...state,
    viewMode: "director",
    project: {
      ...state.project,
      cameras: [...state.project.cameras, requestedCamera],
      activeCameraId: state.project.cameras[0].id,
    },
  });

  render(<App />);
  mockCameraPositionSet.mockClear();
  mockCameraLookAt.mockClear();
  const expectedSnapshot = getCameraViewSnapshotFromShot(requestedCamera);

  const results = await requestViewportCapture({
    preset: "current",
    source: "capture-panel",
    cameraId: requestedCamera.id,
  });

  expect(mockCameraPositionSet).toHaveBeenCalledWith(...expectedSnapshot.position);
  expect(mockCameraLookAt).toHaveBeenCalledWith(1, 1.5, 2);
  expect(results[0]?.meta).toMatchObject({
    mode: "camera",
    cameraId: requestedCamera.id,
    fov: 27,
    position: expectedSnapshot.position,
    target: [1, 1.5, 2],
  });
});

it("resolves the linked Stage camera-rig id to the exact Director camera for capture", async () => {
  const state = useDirectorStore.getState();
  const requestedCamera = state.project.cameras[0]!;
  const requestedRig = state.project.objects.find(
    (object) => object.kind === "camera" && object.linkedCameraId === requestedCamera.id,
  )!;
  const expectedSnapshot = getCameraViewSnapshotFromShot(requestedCamera);

  render(<App />);
  mockCameraPositionSet.mockClear();

  const results = await requestViewportCapture({
    preset: "current",
    source: "capture-panel",
    cameraId: requestedRig.id,
    frame: 24,
    cleanPlate: true,
  });

  expect(mockCameraPositionSet).toHaveBeenCalledWith(...expectedSnapshot.position);
  expect(results[0]?.meta).toMatchObject({
    mode: "camera",
    cameraId: requestedCamera.id,
    position: expectedSnapshot.position,
  });
});

it("applies authored physical exposure to camera capture and restores the editor renderer", async () => {
  const state = useDirectorStore.getState();
  const camera = {
    ...state.project.cameras[0]!,
    apertureFStop: 2,
    iso: 1600,
    shutterAngle: 180,
  };
  useDirectorStore.setState({
    ...state,
    project: { ...state.project, cameras: [camera] },
  });
  const expectedExposure = calculateDirectorCameraExposure(
    camera,
    state.project.scene.timeline?.fps ?? 24,
  ).rendererExposureMultiplier;

  render(<App />);
  mockRenderExposureSnapshots.length = 0;
  await requestViewportCapture({ preset: "current", source: "camera-panel", cameraId: camera.id, cleanPlate: true });

  expect(mockRenderExposureSnapshots[0]).toBeCloseTo(expectedExposure, 8);
  expect(mockRenderExposureSnapshots.at(-1)).toBe(1);
});

it("rejects screenshot requests for missing cameras instead of silently using another view", async () => {
  render(<App />);

  await expect(
    requestViewportCapture({
      preset: "current",
      source: "capture-panel",
      cameraId: "cam_missing",
    }),
  ).rejects.toThrow("Camera not found: cam_missing");
});

it("draws visible character name labels into viewport screenshots", async () => {
  const state = useDirectorStore.getState();
  const target = DEFAULT_DIRECTOR_VIEW_SNAPSHOT.target;
  useDirectorStore.setState({
    ...state,
    viewportAspectRatio: "16:9",
    project: {
      ...state.project,
      scene: {
        ...state.project.scene,
        showLabels: true,
      },
      objects: state.project.objects.map((item) =>
        item.kind === "character"
          ? { ...item, transform: { ...item.transform, position: [target[0], 0, target[2]] } }
          : item,
      ),
    },
  });

  const originalCreateElement = document.createElement.bind(document);
  const fillText = vi.fn();
  const cropCanvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => ({
      beginPath: vi.fn(),
      closePath: vi.fn(),
      drawImage: vi.fn(),
      fill: vi.fn(),
      fillText,
      measureText: vi.fn(() => ({ width: 32 })),
      quadraticCurveTo: vi.fn(),
      lineTo: vi.fn(),
      moveTo: vi.fn(),
    })),
    toDataURL: vi.fn(() => "data:image/png;base64,labelled"),
  };

  vi.spyOn(document, "createElement").mockImplementation(((tagName: string) => {
    if (tagName === "canvas") {
      return cropCanvas as unknown as HTMLCanvasElement;
    }

    return originalCreateElement(tagName);
  }) as typeof document.createElement);

  render(<App />);

  await requestViewportCapture({
    preset: "current",
    source: "capture-panel",
  });

  expect(fillText).toHaveBeenCalledWith("角色01", expect.any(Number), expect.any(Number));
});

it("does not clamp labels for characters that are outside the captured frame", async () => {
  const state = useDirectorStore.getState();
  useDirectorStore.setState({
    ...state,
    viewportAspectRatio: "16:9",
    project: {
      ...state.project,
      scene: {
        ...state.project.scene,
        showLabels: true,
      },
      objects: state.project.objects.map((item) =>
        item.kind === "character" ? { ...item, transform: { ...item.transform, position: [100, 0, 0] } } : item,
      ),
    },
  });

  const originalCreateElement = document.createElement.bind(document);
  const fillText = vi.fn();
  const cropCanvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => ({
      beginPath: vi.fn(),
      closePath: vi.fn(),
      drawImage: vi.fn(),
      fill: vi.fn(),
      fillText,
      measureText: vi.fn(() => ({ width: 32 })),
      quadraticCurveTo: vi.fn(),
      lineTo: vi.fn(),
      moveTo: vi.fn(),
    })),
    toDataURL: vi.fn(() => "data:image/png;base64,offscreen-label"),
  };

  vi.spyOn(document, "createElement").mockImplementation(((tagName: string) => {
    if (tagName === "canvas") return cropCanvas as unknown as HTMLCanvasElement;
    return originalCreateElement(tagName);
  }) as typeof document.createElement);

  render(<App />);
  await requestViewportCapture({ preset: "current", source: "capture-panel" });

  expect(fillText).not.toHaveBeenCalled();
});

it("does not draw character name labels into screenshots when scene labels are hidden", async () => {
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    project: {
      ...useDirectorStore.getState().project,
      scene: {
        ...useDirectorStore.getState().project.scene,
        showLabels: false,
      },
    },
    viewportAspectRatio: "16:9",
  });

  const originalCreateElement = document.createElement.bind(document);
  const fillText = vi.fn();
  const cropCanvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => ({
      beginPath: vi.fn(),
      closePath: vi.fn(),
      drawImage: vi.fn(),
      fill: vi.fn(),
      fillText,
      measureText: vi.fn(() => ({ width: 32 })),
      quadraticCurveTo: vi.fn(),
      lineTo: vi.fn(),
      moveTo: vi.fn(),
    })),
    toDataURL: vi.fn(() => "data:image/png;base64-unlabelled"),
  };

  vi.spyOn(document, "createElement").mockImplementation(((tagName: string) => {
    if (tagName === "canvas") {
      return cropCanvas as unknown as HTMLCanvasElement;
    }

    return originalCreateElement(tagName);
  }) as typeof document.createElement);

  render(<App />);

  await requestViewportCapture({
    preset: "current",
    source: "capture-panel",
  });

  expect(fillText).not.toHaveBeenCalled();
});

it("never composites editor labels into clean-plate video frames", async () => {
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    viewportAspectRatio: "16:9",
    project: {
      ...useDirectorStore.getState().project,
      scene: {
        ...useDirectorStore.getState().project.scene,
        showLabels: true,
      },
    },
  });

  const originalCreateElement = document.createElement.bind(document);
  const fillText = vi.fn();
  const cropCanvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => ({
      beginPath: vi.fn(),
      closePath: vi.fn(),
      drawImage: vi.fn(),
      fill: vi.fn(),
      fillText,
      measureText: vi.fn(() => ({ width: 32 })),
      quadraticCurveTo: vi.fn(),
      lineTo: vi.fn(),
      moveTo: vi.fn(),
    })),
    toDataURL: vi.fn(() => "data:image/png;base64,clean-plate"),
  };

  vi.spyOn(document, "createElement").mockImplementation(((tagName: string) => {
    if (tagName === "canvas") return cropCanvas as unknown as HTMLCanvasElement;
    return originalCreateElement(tagName);
  }) as typeof document.createElement);

  render(<App />);
  const [capture] = await requestViewportCapture({
    preset: "current",
    source: "capture-panel",
    cameraId: useDirectorStore.getState().project.activeCameraId,
    cleanPlate: true,
  });

  expect(capture?.dataUrl).toBe("data:image/png;base64,clean-plate");
  expect(fillText).not.toHaveBeenCalled();
  expect(mockRenderVisibilitySnapshots).toContainEqual([false, false, true]);
});

it("hides viewport grid and camera helper models only while rendering screenshots", async () => {
  render(<App />);

  await requestViewportCapture({
    preset: "current",
    source: "capture-panel",
  });

  expect(mockRenderVisibilitySnapshots).toContainEqual([false, false, true]);
  expect(mockCaptureExcludedObjects.map((object) => object.visible)).toEqual([true, true]);
  expect(mockCaptureVisibleObject.visible).toBe(true);
});

it("captures screenshots from the same safe-area frame shown by the aspect overlay", async () => {
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    viewportAspectRatio: "16:9",
    viewportPanelsCollapsed: false,
  });

  const originalCreateElement = document.createElement.bind(document);
  const drawImage = vi.fn();
  const cropCanvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => ({
      drawImage,
    })),
    toDataURL: vi.fn(() => "data:image/png;base64,cropped-safe-area"),
  };

  vi.spyOn(document, "createElement").mockImplementation(((tagName: string) => {
    if (tagName === "canvas") {
      return cropCanvas as unknown as HTMLCanvasElement;
    }

    return originalCreateElement(tagName);
  }) as typeof document.createElement);

  render(<App />);

  await requestViewportCapture({
    preset: "current",
    source: "capture-panel",
  });

  // The dock overlays only the central viewport, so neither side panel nor the
  // dock changes the rendered frame that is captured from the canvas.
  const expectedFrame = getViewportAspectFrameRect("16:9", 1000, 700, 176, {
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
  });

  expect(expectedFrame).not.toBeNull();
  expect(drawImage).toHaveBeenCalledWith(
    expect.anything(),
    Math.round(expectedFrame!.left),
    Math.round(expectedFrame!.top),
    Math.round(expectedFrame!.width),
    Math.round(expectedFrame!.height),
    0,
    0,
    Math.round(expectedFrame!.width),
    Math.round(expectedFrame!.height),
  );
});

it("captures every four-view screenshot using the selected viewport aspect ratio crop", async () => {
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    viewportAspectRatio: "4:3",
  });

  const originalCreateElement = document.createElement.bind(document);
  const drawImage = vi.fn();
  const cropCanvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => ({
      drawImage,
    })),
    toDataURL: vi.fn(() => "data:image/png;base64,cropped-four"),
  };

  vi.spyOn(document, "createElement").mockImplementation(((tagName: string) => {
    if (tagName === "canvas") {
      return cropCanvas as unknown as HTMLCanvasElement;
    }

    return originalCreateElement(tagName);
  }) as typeof document.createElement);

  render(<App />);

  const results = await requestViewportCapture({
    preset: "four",
    source: "capture-panel",
  });

  expect(results).toHaveLength(4);
  results.forEach((result) => {
    expect(result.dataUrl).toBe("data:image/png;base64,cropped-four");
  });
  expect(drawImage).toHaveBeenCalledTimes(4);
  expect(cropCanvas.width / cropCanvas.height).toBeCloseTo(4 / 3, 2);
});
