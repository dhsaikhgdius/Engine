import { useEffect } from "react";
import { create } from "zustand";

type ViewportChromeSuppressionState = {
  suppressions: ReadonlySet<string>;
  suppress: (id: string) => void;
  release: (id: string) => void;
  reset: () => void;
};

/** Zustand store that tracks which sources are suppressing the viewport chrome. */
export const useViewportChromeSuppressionStore = create<ViewportChromeSuppressionState>((set) => ({
  suppressions: new Set(),
  suppress: (id) =>
    set((state) => {
      if (state.suppressions.has(id)) return state;
      const next = new Set(state.suppressions);
      next.add(id);
      return { suppressions: next };
    }),
  release: (id) =>
    set((state) => {
      if (!state.suppressions.has(id)) return state;
      const next = new Set(state.suppressions);
      next.delete(id);
      return { suppressions: next };
    }),
  reset: () => set({ suppressions: new Set() }),
}));

/** React hook that returns whether the viewport chrome is currently suppressed. */
export function useViewportChromeSuppressed() {
  return useViewportChromeSuppressionStore((state) => state.suppressions.size > 0);
}

/** Hide PiP + viewport toolbar while a fullscreen modal is mounted. */
export function useSuppressViewportChromeWhileMounted(suppressionId: string) {
  useEffect(() => {
    const { suppress, release } = useViewportChromeSuppressionStore.getState();
    suppress(suppressionId);
    return () => release(suppressionId);
  }, [suppressionId]);
}

export function resetViewportChromeSuppression() {
  useViewportChromeSuppressionStore.getState().reset();
}
