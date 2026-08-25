/** Coalesces pointer-rate updates to the display refresh rate. */
export interface AnimationFrameScheduler<T> {
  /** Cancels any pending flush and clears the queued value. */
  cancel: () => void;
  /** Immediately applies the latest queued value, cancelling any pending rAF. */
  flush: () => void;
  /**
   * Queues a value to be applied on the next animation frame.
   * Only the most recent value is kept; earlier ones are overwritten.
   */
  schedule: (value: T) => void;
}

/** Coalesces pointer-rate layout work to the display refresh rate. */
export function createAnimationFrameScheduler<T>(apply: (value: T) => void): AnimationFrameScheduler<T> {
  let animationFrameId: number | null = null;
  let hasPendingValue = false;
  let pendingValue: T;

  const applyPending = () => {
    if (!hasPendingValue) return;
    hasPendingValue = false;
    apply(pendingValue);
  };

  const cancel = () => {
    if (animationFrameId !== null) window.cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
    hasPendingValue = false;
  };

  const flush = () => {
    if (animationFrameId !== null) window.cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
    applyPending();
  };

  const schedule = (value: T) => {
    pendingValue = value;
    hasPendingValue = true;
    if (animationFrameId !== null) return;
    animationFrameId = window.requestAnimationFrame(() => {
      animationFrameId = null;
      applyPending();
    });
  };

  return { cancel, flush, schedule };
}
