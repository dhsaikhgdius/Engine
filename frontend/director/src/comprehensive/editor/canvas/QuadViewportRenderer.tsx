/**
 * Quad-viewport renderer that splits the canvas into perspective, top, front, and right panes
 * with per-frame scissor/viewport management, and the interactive chrome overlay.
 *
 * @module quad-viewport-renderer
 */

import { useFrame, useThree } from "@react-three/fiber";
import { Focus, Maximize2, Minimize2 } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { OrthographicCamera, PerspectiveCamera, Vector4 } from "three";
import {
  configureDirectorOrthographicCamera,
  configureDirectorPerspectivePane,
  getDirectorQuadViewportRects,
  getDirectorQuadViewportRenderRects,
  type DirectorQuadViewFraming,
  type DirectorQuadViewportId,
} from "./quadViewport";
import { beginDirectorCompositeRendererInfoPass, beginDirectorCompositeShadowPass } from "../performance/renderBudget";

const QUAD_VIEW_LABELS: Array<{ id: DirectorQuadViewportId; label: string }> = [
  { id: "perspective", label: "透视" },
  { id: "top", label: "顶视" },
  { id: "front", label: "前视" },
  { id: "right", label: "右视" },
];

/** Per-pane zoom levels keyed by viewport ID. */
export type DirectorQuadViewportZooms = Record<DirectorQuadViewportId, number>;

// Frame-persistent gl.getViewport/getScissor targets; each saved value must
// stay live until the finally-restore, so each gets a dedicated instance.
const quadPreviousViewport = new Vector4();
const quadPreviousScissor = new Vector4();

/** Renders the quad-viewport split by managing scissor/viewport regions and per-pane camera projection each frame. */
export function QuadViewportRenderer({
  framing,
  maximizedPaneId,
  zooms,
}: {
  framing: DirectorQuadViewFraming;
  maximizedPaneId: DirectorQuadViewportId | null;
  zooms: DirectorQuadViewportZooms;
}) {
  const { camera, gl, scene, size } = useThree();
  const orthographicCameras = useMemo(
    () => ({
      top: new OrthographicCamera(),
      front: new OrthographicCamera(),
      right: new OrthographicCamera(),
    }),
    [],
  );
  const originalPerspectiveProjection = useRef(
    camera instanceof PerspectiveCamera
      ? {
          position: camera.position.clone(),
          quaternion: camera.quaternion.clone(),
          zoom: camera.zoom,
        }
      : null,
  );
  const fullCanvasAspectRef = useRef(Math.max(0.01, size.width / Math.max(1, size.height)));

  useEffect(() => {
    fullCanvasAspectRef.current = Math.max(0.01, size.width / Math.max(1, size.height));
  }, [size.height, size.width]);

  useEffect(
    () => () => {
      if (!(camera instanceof PerspectiveCamera)) return;
      camera.aspect = fullCanvasAspectRef.current;
      if (originalPerspectiveProjection.current) {
        camera.position.copy(originalPerspectiveProjection.current.position);
        camera.quaternion.copy(originalPerspectiveProjection.current.quaternion);
        camera.updateMatrixWorld();
      }
      camera.zoom = originalPerspectiveProjection.current?.zoom ?? 1;
      camera.updateProjectionMatrix();
    },
    [camera],
  );

  useFrame(() => {
    const rects = getDirectorQuadViewportRenderRects(size.width, size.height, gl.getPixelRatio(), maximizedPaneId);
    const previousViewport = gl.getViewport(quadPreviousViewport);
    const previousScissor = gl.getScissor(quadPreviousScissor);
    const previousScissorTest = gl.getScissorTest();
    const previousAutoClear = gl.autoClear;
    const restoreRendererInfo = beginDirectorCompositeRendererInfoPass(gl.info);
    const restoreShadowMap = beginDirectorCompositeShadowPass(gl.shadowMap);

    gl.autoClear = false;
    gl.setScissorTest(true);
    try {
      for (const rect of rects) {
        gl.setViewport(rect.x, rect.y, rect.width, rect.height);
        gl.setScissor(rect.x, rect.y, rect.width, rect.height);
        gl.clear(true, true, true);

        if (rect.id === "perspective" && camera instanceof PerspectiveCamera) {
          configureDirectorPerspectivePane(camera, framing, rect.width / Math.max(1, rect.height), zooms.perspective);
          gl.render(scene, camera);
          continue;
        }

        if (rect.id !== "perspective") {
          const orthographicCamera = orthographicCameras[rect.id];
          configureDirectorOrthographicCamera(
            orthographicCamera,
            rect.id,
            framing,
            rect.width / Math.max(1, rect.height),
            zooms[rect.id],
          );
          gl.render(scene, orthographicCamera);
        }
      }
    } finally {
      restoreShadowMap();
      restoreRendererInfo();
      gl.setViewport(previousViewport);
      gl.setScissor(previousScissor);
      gl.setScissorTest(previousScissorTest);
      gl.autoClear = previousAutoClear;
    }
  }, 1);

  return null;
}

/** Interactive chrome overlay for the quad-viewport with pane labels, zoom controls, and maximize/restore actions. */
export function QuadViewportChrome({
  activePaneId,
  maximizedPaneId,
  onPaneActivate,
  onPaneReset,
  onPaneToggleMaximize,
  onPaneZoom,
  zooms,
}: {
  activePaneId: DirectorQuadViewportId;
  maximizedPaneId: DirectorQuadViewportId | null;
  onPaneActivate: (paneId: DirectorQuadViewportId) => void;
  onPaneReset: (paneId: DirectorQuadViewportId) => void;
  onPaneToggleMaximize: (paneId: DirectorQuadViewportId) => void;
  onPaneZoom: (paneId: DirectorQuadViewportId, deltaY: number) => void;
  zooms: DirectorQuadViewportZooms;
}) {
  const visiblePanes = maximizedPaneId
    ? QUAD_VIEW_LABELS.filter((pane) => pane.id === maximizedPaneId)
    : QUAD_VIEW_LABELS;

  return (
    <div
      aria-label="常驻四视图"
      className={`quad-viewport-chrome${maximizedPaneId ? " is-maximized" : ""}`}
      data-maximized-pane={maximizedPaneId ?? undefined}
    >
      {visiblePanes.map((pane) => (
        <section
          aria-current={activePaneId === pane.id ? "true" : undefined}
          aria-label={`${pane.label}视图`}
          className={`quad-viewport-pane is-${pane.id}${activePaneId === pane.id ? " is-active" : ""}`}
          data-pane={pane.id}
          data-zoom={zooms[pane.id]}
          key={pane.id}
          role="region"
          tabIndex={0}
          onDoubleClick={() => {
            onPaneActivate(pane.id);
            onPaneToggleMaximize(pane.id);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            onPaneToggleMaximize(pane.id);
          }}
          onPointerDown={(event) => {
            event.currentTarget.focus();
            onPaneActivate(pane.id);
          }}
          onWheel={(event) => {
            event.preventDefault();
            onPaneActivate(pane.id);
            onPaneZoom(pane.id, event.deltaY);
          }}
        >
          <header className="quad-viewport-pane-header">
            <span className="quad-viewport-pane-identity">
              <strong>{pane.label}</strong>
              <small>
                {pane.id === "perspective" ? "透视投影" : "正交投影"} · {Math.round(zooms[pane.id] * 100)}%
              </small>
            </span>
            <span className="quad-viewport-pane-actions">
              <button
                aria-label="适配视图"
                className="quad-viewport-pane-action"
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onPaneActivate(pane.id);
                  onPaneReset(pane.id);
                }}
                onDoubleClick={(event) => event.stopPropagation()}
              >
                <Focus aria-hidden="true" size={13} strokeWidth={1.9} />
              </button>
              <button
                aria-label={maximizedPaneId === pane.id ? "恢复四视图" : "最大化视图"}
                aria-pressed={maximizedPaneId === pane.id}
                className="quad-viewport-pane-action"
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onPaneActivate(pane.id);
                  onPaneToggleMaximize(pane.id);
                }}
                onDoubleClick={(event) => event.stopPropagation()}
              >
                {maximizedPaneId === pane.id ? (
                  <Minimize2 aria-hidden="true" size={13} strokeWidth={1.9} />
                ) : (
                  <Maximize2 aria-hidden="true" size={13} strokeWidth={1.9} />
                )}
              </button>
            </span>
          </header>
        </section>
      ))}
    </div>
  );
}
