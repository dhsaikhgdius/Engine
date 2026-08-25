import { renderHook } from "@testing-library/react";
import { beforeEach, expect, it } from "vitest";
import {
  resetViewportChromeSuppression,
  useSuppressViewportChromeWhileMounted,
  useViewportChromeSuppressed,
  useViewportChromeSuppressionStore,
} from "../../../../src/comprehensive/editor/canvas/viewportChromeSuppression";

beforeEach(() => {
  resetViewportChromeSuppression();
});

it("tracks multiple fullscreen modal suppressions with reference counting by id", () => {
  const { result, unmount: unmountA } = renderHook(() => useSuppressViewportChromeWhileMounted("modal-a"));
  const { result: suppressed, rerender } = renderHook(() => useViewportChromeSuppressed());

  expect(suppressed.current).toBe(true);

  renderHook(() => useSuppressViewportChromeWhileMounted("modal-b"));
  rerender();
  expect(suppressed.current).toBe(true);

  unmountA();
  rerender();
  expect(suppressed.current).toBe(true);

  useViewportChromeSuppressionStore.getState().release("modal-b");
  rerender();
  expect(suppressed.current).toBe(false);
});

it("reset clears all active suppressions", () => {
  useViewportChromeSuppressionStore.getState().suppress("modal-a");
  useViewportChromeSuppressionStore.getState().suppress("modal-b");

  resetViewportChromeSuppression();

  expect(useViewportChromeSuppressionStore.getState().suppressions.size).toBe(0);
});
