import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useDirectorStore } from "../store/directorStore";

/**
 * Keeps TransformControls visually immediate while limiting expensive scene
 * document mutations to one latest-value commit per display frame.
 *
 * The pending final value is flushed synchronously before the undo batch is
 * closed. That ordering is important: otherwise a quick drag/release can lose
 * its last transform or create an extra undo entry outside the drag batch.
 */
export function useRafCoalescedTransformInteraction<Args extends unknown[]>(onObjectChange: (...args: Args) => void) {
  const callbackRef = useRef(onObjectChange);
  const pendingArgsRef = useRef<Args | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const interactionActiveRef = useRef(false);
  const beginUndoBatch = useDirectorStore((state) => state.beginUndoBatch);
  const endUndoBatch = useDirectorStore((state) => state.endUndoBatch);

  useLayoutEffect(() => {
    callbackRef.current = onObjectChange;
  }, [onObjectChange]);

  const flushPendingChange = useCallback(() => {
    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    const pendingArgs = pendingArgsRef.current;
    if (pendingArgs === null) return;

    pendingArgsRef.current = null;
    callbackRef.current(...pendingArgs);
  }, []);

  const scheduleObjectChange = useCallback(
    (...args: Args) => {
      pendingArgsRef.current = args;
      if (animationFrameRef.current !== null) return;

      animationFrameRef.current = window.requestAnimationFrame(() => {
        animationFrameRef.current = null;
        flushPendingChange();
      });
    },
    [flushPendingChange],
  );

  const handleMouseDown = useCallback(() => {
    // A stale programmatic change must land before the next gesture owns the
    // undo batch. Normally there is nothing pending here.
    flushPendingChange();
    if (interactionActiveRef.current) return;
    interactionActiveRef.current = true;
    beginUndoBatch();
  }, [beginUndoBatch, flushPendingChange]);

  const handleMouseUp = useCallback(() => {
    flushPendingChange();
    if (!interactionActiveRef.current) return;
    interactionActiveRef.current = false;
    endUndoBatch();
  }, [endUndoBatch, flushPendingChange]);

  useEffect(
    () => () => {
      // Selection changes can unmount the active gizmo before Three emits its
      // mouse-up callback. Preserve the last pose and never strand the store
      // inside an open undo batch.
      flushPendingChange();
      if (!interactionActiveRef.current) return;
      interactionActiveRef.current = false;
      endUndoBatch();
    },
    [endUndoBatch, flushPendingChange],
  );

  return {
    onMouseDown: handleMouseDown,
    onMouseUp: handleMouseUp,
    onObjectChange: scheduleObjectChange,
  };
}
