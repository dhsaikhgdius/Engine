import { useEffect, useLayoutEffect, useRef } from "react";

/**
 * Layered Escape handling: every UI surface that closes on Esc (modal dialog,
 * dropdown, popover…) registers itself as a layer. A single window listener
 * forwards Escape only to the most recently registered layer, so pressing Esc
 * inside e.g. a dropdown that lives in a dialog closes the dropdown first and
 * keeps the dialog open.
 */
type EscapeLayerHandler = (event: KeyboardEvent) => void;

const escapeLayers: EscapeLayerHandler[] = [];

function handleWindowKeyDown(event: KeyboardEvent) {
  if (event.key !== "Escape") return;
  escapeLayers[escapeLayers.length - 1]?.(event);
}

/** Registers a layer on top of the stack.
 *
 * @param onEscape - Called when Escape is pressed and this layer is the topmost.
 * @returns An idempotent release function; calling it removes this layer from the stack.
 */
export function registerEscapeLayer(onEscape: EscapeLayerHandler): () => void {
  if (escapeLayers.length === 0) window.addEventListener("keydown", handleWindowKeyDown);
  escapeLayers.push(onEscape);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const index = escapeLayers.lastIndexOf(onEscape);
    if (index !== -1) escapeLayers.splice(index, 1);
    if (escapeLayers.length === 0) window.removeEventListener("keydown", handleWindowKeyDown);
  };
}

/**
 * Test/debug helper: returns the current number of registered Escape layers.
 *
 * @returns The stack depth.
 */
export function getEscapeLayerDepth() {
  return escapeLayers.length;
}

/**
 * Keeps a layer registered while `active` is true, always calling the latest handler.
 *
 * Uses a ref so the latest `onEscape` closure is forwarded without re-registering
 * the layer on every render.
 *
 * @param active - When true, the Escape layer is registered; when false, it is released.
 * @param onEscape - The handler to call on Escape; may change between renders.
 */
export function useEscapeLayer(active: boolean, onEscape: EscapeLayerHandler) {
  const handlerRef = useRef(onEscape);
  useLayoutEffect(() => {
    handlerRef.current = onEscape;
  });

  useEffect(() => {
    if (!active) return;
    return registerEscapeLayer((event) => handlerRef.current(event));
  }, [active]);
}
