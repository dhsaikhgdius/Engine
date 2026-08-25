/**
 * Mutable ref that holds the active teardown callback for a window-level
 * pointer drag gesture.
 *
 * The caller owns this ref and passes it to every install call; the install
 * function writes the current cleanup into `current` and nulls it out when the
 * drag ends. This lets the caller cancel an in-flight drag from outside the
 * pointer event handlers.
 */
export interface PointerDragCleanupRef {
  /** Active teardown callback, or `null` when no drag is in progress. */
  current: (() => void) | null;
}

/**
 * Installs window-level pointermove / pointerup / pointercancel listeners for
 * a drag gesture and wires them to the provided cleanup ref.
 *
 * Only one drag can be active per ref at a time; calling install again while a
 * drag is in progress silently replaces the previous listeners.
 *
 * @param cleanupRef - Mutable ref that receives the teardown callback.
 *  The caller can invoke `cleanupRef.current?.()` to cancel the drag early.
 * @param move - Called on every pointermove event while the drag is active.
 * @param onEnd - Called once when the drag ends (pointerup or pointercancel).
 */
export function installWindowPointerDrag(
  cleanupRef: PointerDragCleanupRef,
  move: (event: PointerEvent) => void,
  onEnd?: () => void,
) {
  function cleanup() {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", cleanup);
    window.removeEventListener("pointercancel", cleanup);
    cleanupRef.current = null;
    onEnd?.();
  }
  cleanupRef.current = cleanup;
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", cleanup, { once: true });
  window.addEventListener("pointercancel", cleanup, { once: true });
}