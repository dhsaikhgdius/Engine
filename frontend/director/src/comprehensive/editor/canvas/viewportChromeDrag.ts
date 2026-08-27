/**
 * Drag/position infrastructure for floating viewport chrome (camera PiP,
 * properties cards, toolbars): pointer-driven dragging with viewport-bounds
 * clamping, per-panel persisted offsets, and a module-level suppression
 * registry so overlays like fullscreen previews can hide all chrome at once.
 * Positions live outside React state where dragging is in flight so a move
 * never re-renders the 3D canvas beneath it.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
} from "react";

/** A 2D offset in CSS pixels, used for floating viewport chrome panels. */
export type ViewportChromeOffset = { x: number; y: number };
/** A 2D size in CSS pixels; height is optional for panels that size themselves. */
export type ViewportChromeSize = { width: number; height?: number };

const PROPS_STORAGE_KEY = "3d-director-ui:camera-viewport-properties-offset";
const PIP_STORAGE_KEY = "3d-director-ui:camera-picture-in-picture-offset";

/** Default top-left offset for the camera properties panel. */
export const DEFAULT_CAMERA_PROPERTIES_OFFSET: ViewportChromeOffset = { x: 18, y: 18 };
/**
 * Keep the quick camera panel comfortably readable in the 3D workspace.
 * The CSS width and drag clamp both use this value.
 */
export const CAMERA_PROPERTIES_WIDTH = 240;
/** Default top-left offset for the camera picture-in-picture preview. */
export const DEFAULT_CAMERA_PIP_OFFSET: ViewportChromeOffset = {
  x: DEFAULT_CAMERA_PROPERTIES_OFFSET.x + CAMERA_PROPERTIES_WIDTH + 16,
  y: 18,
};
/**
 * The live framing monitor needs enough room to judge composition and focus
 * without leaving the director view. This value also drives the R3F scissor
 * viewport and drag boundaries, so keep it as the single source of truth.
 */
export const CAMERA_PIP_WIDTH = 320;

/** The logical-pixel size of the camera PiP preview. */
export type CameraPictureInPictureLayout = {
  width: number;
  height: number;
};

/** The scissor/viewport rectangle for the camera PiP render pass. */
export type CameraPictureInPictureRenderRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type ChromeKind = "properties" | "pip";
type ChromeBounds = Pick<DOMRect, "left" | "top" | "width" | "height">;

let pipOverlayElement: HTMLElement | null = null;
let pipDragging = false;
let pipPreviewFrozen = false;

const listeners = {
  properties: new Set<() => void>(),
  pip: new Set<() => void>(),
};

const pipFrameListeners = new Set<() => void>();

let propertiesOffset = readStoredOffset(PROPS_STORAGE_KEY, DEFAULT_CAMERA_PROPERTIES_OFFSET);
let pipOffset = readStoredOffset(PIP_STORAGE_KEY, DEFAULT_CAMERA_PIP_OFFSET);

function readStoredOffset(key: string, fallback: ViewportChromeOffset): ViewportChromeOffset {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<ViewportChromeOffset>;
    if (typeof parsed.x !== "number" || typeof parsed.y !== "number") return fallback;
    if (!Number.isFinite(parsed.x) || !Number.isFinite(parsed.y)) return fallback;
    return { x: parsed.x, y: parsed.y };
  } catch {
    return fallback;
  }
}

function writeStoredOffset(key: string, offset: ViewportChromeOffset) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(key, JSON.stringify(offset));
  } catch {
    // Ignore quota / private-mode failures; in-memory offset still works.
  }
}

function getOffset(kind: ChromeKind) {
  return kind === "properties" ? propertiesOffset : pipOffset;
}

function persistOffset(kind: ChromeKind, offset = getOffset(kind)) {
  writeStoredOffset(kind === "properties" ? PROPS_STORAGE_KEY : PIP_STORAGE_KEY, offset);
}

function setOffset(kind: ChromeKind, offset: ViewportChromeOffset, persist = true, notify = true) {
  const current = getOffset(kind);
  const changed = current.x !== offset.x || current.y !== offset.y;
  if (kind === "properties") {
    propertiesOffset = offset;
  } else {
    pipOffset = offset;
  }
  if (persist) persistOffset(kind, offset);
  if (changed && notify) {
    for (const listener of listeners[kind]) listener();
  }
}

function subscribe(kind: ChromeKind, listener: () => void) {
  listeners[kind].add(listener);
  return () => {
    listeners[kind].delete(listener);
  };
}

/** Live PIP layout read from R3F useFrame without forcing React re-renders.
 *
 * @returns The current PiP offset.
 */
export function getCameraPictureInPictureOffset() {
  return pipOffset;
}

/** Registers the live PiP chrome so the WebGL scissor can follow its painted bounds. */
export function setCameraPictureInPictureOverlayElement(element: HTMLElement | null) {
  pipOverlayElement = element;
}

/**
 * Returns the DOM element that carries the frozen camera preview image during drag.
 *
 * @returns The freeze layer element, or null when not mounted.
 */
export function getCameraPictureInPictureFreezeLayer() {
  return pipOverlayElement?.querySelector<HTMLElement>(".camera-picture-in-picture__freeze") ?? null;
}

/** Returns whether the PiP panel is currently being dragged. */
export function isCameraPictureInPictureDragging() {
  return pipDragging;
}

/** Returns whether the PiP preview is currently frozen (showing a static snapshot). */
export function isCameraPictureInPicturePreviewFrozen() {
  return pipPreviewFrozen;
}

/**
 * Marks the PiP preview as frozen or unfrozen.
 * When unfrozen, the freeze layer background is cleared.
 *
 * @param frozen - Whether the preview should be frozen.
 */
export function markCameraPictureInPicturePreviewFrozen(frozen: boolean) {
  pipPreviewFrozen = frozen;
  pipOverlayElement?.toggleAttribute("data-pip-frozen", frozen);
  if (!frozen) {
    const layer = getCameraPictureInPictureFreezeLayer();
    if (layer) layer.style.backgroundImage = "";
  }
}

/**
 * Subscribes to PiP frame requests, typically from the R3F render loop.
 *
 * @param listener - Called when a new PiP frame should be rendered.
 * @returns A function that removes the listener.
 */
export function subscribeCameraPictureInPictureFrames(listener: () => void) {
  pipFrameListeners.add(listener);
  return () => {
    pipFrameListeners.delete(listener);
  };
}

/** Requests a single PiP render frame, notifying all frame subscribers. */
export function requestCameraPictureInPictureFrame() {
  for (const listener of pipFrameListeners) listener();
}

function chromeDragTransform(origin: ViewportChromeOffset, next: ViewportChromeOffset) {
  const dx = Math.round(next.x - origin.x);
  const dy = Math.round(next.y - origin.y);
  return dx === 0 && dy === 0 ? "" : `translate3d(${dx}px, ${dy}px, 0)`;
}

function chromeDragSatellites(panel: HTMLElement) {
  const kind = panel.getAttribute("data-viewport-chrome");
  const root = panel.parentElement;
  if (!kind || !root) return [] as HTMLElement[];
  return [...root.querySelectorAll<HTMLElement>(`[data-viewport-chrome-satellite="${kind}"]`)];
}

/**
 * Follow the pointer on the compositor thread without rewriting left/top.
 * Applies a CSS transform to the panel and its satellite elements.
 *
 * @param panel - The chrome panel element.
 * @param origin - The offset at drag start.
 * @param next - The current offset during drag.
 */
export function applyViewportChromeDragTransform(
  panel: HTMLElement,
  origin: ViewportChromeOffset,
  next: ViewportChromeOffset,
) {
  const transform = chromeDragTransform(origin, next);
  panel.style.transform = transform;
  for (const node of chromeDragSatellites(panel)) node.style.transform = transform;
}

/**
 * Bake the live transform into left/top so React can take over after pointerup.
 * Satellite elements are also updated with their delta.
 *
 * @param panel - The chrome panel element.
 * @param origin - The offset at drag start.
 * @param next - The final offset after drag.
 */
export function commitViewportChromeDragTransform(
  panel: HTMLElement,
  origin: ViewportChromeOffset,
  next: ViewportChromeOffset,
) {
  const dx = Math.round(next.x - origin.x);
  const dy = Math.round(next.y - origin.y);
  panel.style.left = `${Math.round(next.x)}px`;
  panel.style.top = `${Math.round(next.y)}px`;
  panel.style.transform = "";
  for (const node of chromeDragSatellites(panel)) {
    const left = Number.parseFloat(node.style.left);
    const top = Number.parseFloat(node.style.top);
    if (Number.isFinite(left)) node.style.left = `${left + dx}px`;
    if (Number.isFinite(top)) node.style.top = `${top + dy}px`;
    node.style.transform = "";
  }
}

/**
 * Shared CSS + scissor sizing with a stable width throughout a drag.
 * Size is a property of the monitor and viewport, never of its current X
 * coordinate. Shrinking the panel as it approaches the right edge makes the
 * pointer anchor drift and causes a visible jump on the first drag in narrow
 * viewports.
 *
 * @param viewportWidth - The current viewport width in px.
 * @param aspect - The PiP aspect ratio (width / height).
 * @returns The logical-pixel size of the PiP panel.
 */
export function resolveCameraPictureInPictureLayout(
  viewportWidth: number,
  aspect: number,
): CameraPictureInPictureLayout {
  // Size is a property of the monitor and viewport, never of its current X
  // coordinate. Shrinking the panel as it approaches the right edge makes the
  // pointer anchor drift and causes a visible jump on the first drag in narrow
  // viewports. Position clamping below keeps the stable panel fully visible.
  const width = Math.min(CAMERA_PIP_WIDTH, Math.max(1, viewportWidth - 36));
  return {
    width,
    height: Math.max(1, width / Math.max(aspect, 0.01)),
  };
}

/**
 * Physical-pixel size for the persistent camera-preview render target.
 *
 * @param logicalWidth - The logical width of the PiP panel.
 * @param logicalHeight - The logical height of the PiP panel.
 * @param pixelRatio - The device pixel ratio.
 * @returns The physical-pixel render target size.
 */
export function getCameraPictureInPictureRenderTargetSize(
  logicalWidth: number,
  logicalHeight: number,
  pixelRatio: number,
) {
  const safePixelRatio = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1;
  return {
    width: Math.max(1, Math.round(logicalWidth * safePixelRatio)),
    height: Math.max(1, Math.round(logicalHeight * safePixelRatio)),
  };
}

/**
 * Resolves the PiP scissor rectangle from the same authored layout values used
 * by the overlay. Unlike the DOM-alignment fallback below, this path performs
 * no layout reads and is therefore safe to call from every render frame.
 */
export function getCameraPictureInPictureRenderRectFromLayout(fallback: {
  viewportWidth: number;
  viewportHeight: number;
  offset: ViewportChromeOffset;
  aspect: number;
}): CameraPictureInPictureRenderRect {
  const layout = resolveCameraPictureInPictureLayout(fallback.viewportWidth, fallback.aspect);
  return {
    x: Math.round(fallback.offset.x),
    y: Math.max(0, Math.round(fallback.viewportHeight - fallback.offset.y - layout.height)),
    width: Math.max(1, Math.round(layout.width)),
    height: Math.max(1, Math.round(layout.height)),
  };
}

/**
 * Maps the painted PiP chrome onto the active WebGL canvas raster. Falls back to
 * offset math when the overlay is not mounted yet.
 */
export function getCameraPictureInPictureRenderRect(
  canvas: HTMLCanvasElement,
  fallback: {
    viewportWidth: number;
    viewportHeight: number;
    offset: ViewportChromeOffset;
    aspect: number;
  },
): CameraPictureInPictureRenderRect {
  const overlay = pipOverlayElement;
  if (overlay) {
    const canvasRect = canvas.getBoundingClientRect();
    const overlayRect = overlay.getBoundingClientRect();
    if (overlayRect.width > 0 && overlayRect.height > 0 && canvasRect.width > 0 && canvasRect.height > 0) {
      const left = overlayRect.left - canvasRect.left;
      const top = overlayRect.top - canvasRect.top;
      return {
        // WebGLRenderer.setViewport/setScissor accept logical pixels and apply
        // the renderer pixel ratio internally for the default framebuffer.
        x: Math.max(0, Math.round(left)),
        y: Math.max(0, Math.round(canvasRect.height - top - overlayRect.height)),
        width: Math.max(1, Math.round(overlayRect.width)),
        height: Math.max(1, Math.round(overlayRect.height)),
      };
    }
  }

  return getCameraPictureInPictureRenderRectFromLayout(fallback);
}

/**
 * React hook that returns the current offset for a viewport chrome panel,
 * using useSyncExternalStore for tear-free reads.
 *
 * @param kind - Which chrome panel ("properties" or "pip").
 * @returns The current offset.
 */
export function useCameraViewportChromeOffset(kind: ChromeKind) {
  return useSyncExternalStore(
    (listener) => subscribe(kind, listener),
    () => getOffset(kind),
    () => (kind === "properties" ? DEFAULT_CAMERA_PROPERTIES_OFFSET : DEFAULT_CAMERA_PIP_OFFSET),
  );
}

/** Resets both chrome offsets to their defaults and clears session storage. */
export function resetCameraViewportChromeOffsets() {
  pipOverlayElement?.removeAttribute("data-pip-frozen");
  propertiesOffset = DEFAULT_CAMERA_PROPERTIES_OFFSET;
  pipOffset = DEFAULT_CAMERA_PIP_OFFSET;
  pipOverlayElement = null;
  pipDragging = false;
  pipPreviewFrozen = false;
  if (typeof window !== "undefined") {
    window.sessionStorage.removeItem(PROPS_STORAGE_KEY);
    window.sessionStorage.removeItem(PIP_STORAGE_KEY);
  }
  for (const listener of listeners.properties) listener();
  for (const listener of listeners.pip) listener();
}

/**
 * Clamps a chrome offset so the panel stays within the viewport bounds.
 *
 * @param offset - The raw offset.
 * @param panelWidth - The panel width in px.
 * @param panelHeight - The panel height in px.
 * @param bounds - The viewport bounding rect.
 * @returns The clamped offset.
 */
export function clampViewportChromeOffset(
  offset: ViewportChromeOffset,
  panelWidth: number,
  panelHeight: number,
  bounds: DOMRect,
): ViewportChromeOffset {
  const maxX = Math.max(8, bounds.width - panelWidth - 8);
  const maxY = Math.max(8, bounds.height - panelHeight - 8);
  return {
    x: Math.min(maxX, Math.max(8, offset.x)),
    y: Math.min(maxY, Math.max(8, offset.y)),
  };
}

/**
 * Resolves a chrome offset from a pointer event, accounting for the grab offset
 * (where the user clicked relative to the panel's top-left).
 *
 * @param pointer - The pointer position in client coordinates.
 * @param grabOffset - The offset of the pointer relative to the panel's top-left.
 * @param panelSize - The panel dimensions.
 * @param bounds - The viewport bounding rect.
 * @returns The clamped offset.
 */
export function resolveViewportChromeOffsetFromPointer(
  pointer: { clientX: number; clientY: number },
  grabOffset: ViewportChromeOffset,
  panelSize: { width: number; height: number },
  bounds: Pick<DOMRect, "left" | "top" | "width" | "height">,
) {
  return clampViewportChromeOffset(
    {
      x: pointer.clientX - bounds.left - grabOffset.x,
      y: pointer.clientY - bounds.top - grabOffset.y,
    },
    panelSize.width,
    panelSize.height,
    bounds as DOMRect,
  );
}

/**
 * Pointer-drag a floating viewport chrome panel by its handle.
 * Inputs and nested buttons do not start a drag.
 */
export function useViewportChromeDrag(
  kind: ChromeKind,
  panelSize: number | ViewportChromeSize,
  getBounds: () => DOMRect | null,
) {
  const offset = useCameraViewportChromeOffset(kind);
  const panelWidth = typeof panelSize === "number" ? panelSize : panelSize.width;
  const panelHeight = typeof panelSize === "number" ? undefined : panelSize.height;
  const dragRef = useRef<{
    pointerId: number;
    handle: HTMLElement;
    grabOffset: ViewportChromeOffset;
    originOffset: ViewportChromeOffset;
    panel: HTMLElement | null;
    panelSize: { width: number; height: number };
    bounds: ChromeBounds;
  } | null>(null);
  const cleanupDragRef = useRef<((persist: boolean, updateState: boolean) => void) | null>(null);
  const [dragging, setDragging] = useState(false);
  const getBoundsRef = useRef(getBounds);
  getBoundsRef.current = getBounds;

  const clampToBounds = useCallback(() => {
    if (dragRef.current) return;
    if (!Number.isFinite(panelHeight) || (panelHeight ?? 0) <= 0) return;
    const bounds = getBoundsRef.current();
    if (!bounds) return;
    const current = getOffset(kind);
    const next = clampViewportChromeOffset(current, panelWidth, panelHeight as number, bounds);
    if (next.x !== current.x || next.y !== current.y) setOffset(kind, next);
  }, [kind, panelHeight, panelWidth]);

  useLayoutEffect(() => {
    clampToBounds();
  }, [clampToBounds]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0 || event.isPrimary === false) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, select, textarea, button, a, label")) return;

      const bounds = getBoundsRef.current();
      if (!bounds) return;
      const panel = event.currentTarget.closest("[data-viewport-chrome]") as HTMLElement | null;
      const panelRect = panel?.getBoundingClientRect();
      const width = Math.max(1, panelRect?.width || panelWidth);
      const height = Math.max(1, panelRect?.height || panelHeight || panel?.offsetHeight || 120);
      const handle = event.currentTarget;
      const originOffset = { ...getOffset(kind) };
      const cachedBounds: ChromeBounds = {
        left: bounds.left,
        top: bounds.top,
        width: bounds.width,
        height: bounds.height,
      };

      cleanupDragRef.current?.(true, true);

      dragRef.current = {
        handle,
        pointerId: event.pointerId,
        grabOffset: {
          x: panelRect ? event.clientX - panelRect.left : event.clientX - bounds.left - originOffset.x,
          y: panelRect ? event.clientY - panelRect.top : event.clientY - bounds.top - originOffset.y,
        },
        originOffset,
        panel,
        panelSize: { width, height },
        bounds: cachedBounds,
      };
      if (kind === "pip") {
        pipDragging = true;
        pipPreviewFrozen = false;
        pipOverlayElement?.removeAttribute("data-pip-frozen");
        requestCameraPictureInPictureFrame();
      }
      setDragging(true);
      try {
        handle.setPointerCapture?.(event.pointerId);
      } catch {
        // The global listeners below still complete the gesture in webviews
        // that reject pointer capture.
      }
      event.preventDefault();
      event.stopPropagation();

      let animationFrameId: number | null = null;
      let pendingOffset: ViewportChromeOffset | null = null;

      const flushPendingOffset = (persist: boolean, notify: boolean) => {
        if (animationFrameId !== null) {
          window.cancelAnimationFrame(animationFrameId);
          animationFrameId = null;
        }
        const drag = dragRef.current;
        const next = pendingOffset;
        pendingOffset = null;
        if (next) {
          setOffset(kind, next, persist, notify);
          if (drag?.panel && !notify) {
            applyViewportChromeDragTransform(drag.panel, drag.originOffset, next);
          }
          if (kind === "pip" && !pipPreviewFrozen) requestCameraPictureInPictureFrame();
        } else if (persist) {
          persistOffset(kind);
        }
      };

      const handleMove = (moveEvent: PointerEvent) => {
        const drag = dragRef.current;
        if (!drag || moveEvent.pointerId !== drag.pointerId) return;
        pendingOffset = resolveViewportChromeOffsetFromPointer(moveEvent, drag.grabOffset, drag.panelSize, drag.bounds);
        if (animationFrameId === null) {
          animationFrameId = window.requestAnimationFrame(() => {
            animationFrameId = null;
            flushPendingOffset(false, false);
          });
        }
        moveEvent.preventDefault();
      };

      const finishDrag = (pointerId: number | null, persist: boolean, updateState: boolean) => {
        const drag = dragRef.current;
        if (!drag || (pointerId !== null && drag.pointerId !== pointerId)) return;
        const next = pendingOffset ?? getOffset(kind);
        if (animationFrameId !== null) {
          window.cancelAnimationFrame(animationFrameId);
          animationFrameId = null;
        }
        pendingOffset = null;
        dragRef.current = null;
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
        window.removeEventListener("pointercancel", handleUp);
        window.removeEventListener("blur", handleBlur);
        drag.handle.removeEventListener("lostpointercapture", handleLostPointerCapture);
        if (kind === "pip") pipDragging = false;
        if (drag.panel) commitViewportChromeDragTransform(drag.panel, drag.originOffset, next);
        setOffset(kind, next, persist, updateState);
        if (!updateState && persist) persistOffset(kind);
        if (kind === "pip") requestCameraPictureInPictureFrame();
        try {
          if (drag.handle.hasPointerCapture?.(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId);
        } catch {
          // Capture may already have been released by the host.
        }
        cleanupDragRef.current = null;
        if (updateState) setDragging(false);
      };

      const handleUp = (upEvent: PointerEvent) => {
        finishDrag(upEvent.pointerId, true, true);
      };
      const handleLostPointerCapture = (lostEvent: PointerEvent) => {
        finishDrag(lostEvent.pointerId, true, true);
      };
      const handleBlur = () => {
        finishDrag(null, true, true);
      };

      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp);
      window.addEventListener("pointercancel", handleUp);
      window.addEventListener("blur", handleBlur);
      handle.addEventListener("lostpointercapture", handleLostPointerCapture);
      cleanupDragRef.current = (persist, updateState) => finishDrag(null, persist, updateState);
    },
    [kind, panelHeight, panelWidth],
  );

  useEffect(
    () => () => {
      cleanupDragRef.current?.(false, false);
      dragRef.current = null;
    },
    [],
  );

  return { clampToBounds, offset, dragging, onPointerDown };
}
