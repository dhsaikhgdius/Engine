/**
 * jsdom cannot decode real video, so these tests drive the sampling pipeline
 * through prototype mocks: load() dispatches loadeddata, the currentTime
 * setter dispatches seeked, and canvas getContext/toDataURL are stubbed.
 * Paths that require true decoding (actual frame pixels, cover-crop output,
 * tainted-canvas CORS failures) are exercised only in the browser.
 */
import { act, renderHook } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDirectorClipFilmstripCache,
  DIRECTOR_CLIP_FILMSTRIP_CACHE_LIMIT,
  directorFilmstripTileTimeSec,
  getDirectorClipFilmstrip,
  requestDirectorClipFilmstrip,
  subscribeDirectorClipFilmstrips,
  useDirectorClipFilmstrip,
  type DirectorClipFilmstripRequest,
} from "../../../../src/comprehensive/editor/workspaces/clipFilmstrip";

const TILE_DATA_URL = "data:image/jpeg;base64,filmstrip-tile";

type LoadBehavior = "ready" | "error" | "stall";
let loadBehavior: LoadBehavior = "ready";
let seekBehavior: "seeked" | "stall" = "seeked";
let loadCallCount = 0;
let seekLog: number[] = [];

const currentTimes = new WeakMap<HTMLMediaElement, number>();
const originalMediaDescriptors = {
  load: Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "load"),
  pause: Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "pause"),
  currentTime: Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentTime"),
};

beforeAll(() => {
  Object.defineProperty(HTMLMediaElement.prototype, "load", {
    configurable: true,
    value(this: HTMLMediaElement) {
      loadCallCount += 1;
      const behavior = loadBehavior;
      if (behavior === "stall") return;
      // Async dispatch mirrors real media elements: listeners attach first.
      queueMicrotask(() => this.dispatchEvent(new Event(behavior === "ready" ? "loadeddata" : "error")));
    },
  });
  Object.defineProperty(HTMLMediaElement.prototype, "pause", {
    configurable: true,
    value: () => undefined,
  });
  Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
    configurable: true,
    get(this: HTMLMediaElement) {
      return currentTimes.get(this) ?? 0;
    },
    set(this: HTMLMediaElement, value: number) {
      currentTimes.set(this, value);
      seekLog.push(value);
      if (seekBehavior === "seeked") queueMicrotask(() => this.dispatchEvent(new Event("seeked")));
    },
  });
});

afterAll(() => {
  for (const [name, descriptor] of Object.entries(originalMediaDescriptors)) {
    if (descriptor) Object.defineProperty(HTMLMediaElement.prototype, name, descriptor);
    else delete (HTMLMediaElement.prototype as unknown as Record<string, unknown>)[name];
  }
});

beforeEach(() => {
  loadBehavior = "ready";
  seekBehavior = "seeked";
  loadCallCount = 0;
  seekLog = [];
  // jsdom has no canvas backend: getContext returns null and toDataURL throws,
  // so both are stubbed to observable fakes.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(TILE_DATA_URL);
});

afterEach(async () => {
  // Cancel outstanding tasks, then drain their pending waits so the module's
  // concurrency counter returns to zero before the next test.
  clearDirectorClipFilmstripCache();
  if (vi.isFakeTimers()) {
    await vi.advanceTimersByTimeAsync(9_000);
    vi.useRealTimers();
  }
  await flushSampling();
  vi.restoreAllMocks();
});

/** The mocked pipeline settles entirely on microtasks; ~50 hops is plenty. */
async function flushSampling() {
  for (let hop = 0; hop < 50; hop += 1) await Promise.resolve();
}

function baseRequest(overrides: Partial<DirectorClipFilmstripRequest> = {}): DirectorClipFilmstripRequest {
  return {
    mediaId: "media-1",
    sourceUrl: "blob:director/clip-1",
    inSec: 1,
    timelineDurationSec: 4,
    playbackRate: 1,
    tileWidth: 48,
    tileHeight: 46,
    tileCount: 2,
    ...overrides,
  };
}

describe("directorFilmstripTileTimeSec", () => {
  it("samples each tile at the center of its timeline slice", () => {
    const request = baseRequest({ inSec: 2, timelineDurationSec: 10, playbackRate: 1, tileCount: 4 });
    expect(directorFilmstripTileTimeSec(request, 0)).toBeCloseTo(2 + (0.5 / 4) * 10);
    expect(directorFilmstripTileTimeSec(request, 1)).toBeCloseTo(2 + (1.5 / 4) * 10);
    expect(directorFilmstripTileTimeSec(request, 3)).toBeCloseTo(2 + (3.5 / 4) * 10);
  });

  it("scales the source offset by playbackRate", () => {
    const request = baseRequest({ inSec: 5, timelineDurationSec: 6, playbackRate: 2, tileCount: 3 });
    // 5 + ((i + 0.5) / 3) * 6 * 2 = 5 + (i + 0.5) * 4
    expect(directorFilmstripTileTimeSec(request, 0)).toBeCloseTo(7);
    expect(directorFilmstripTileTimeSec(request, 1)).toBeCloseTo(11);
    expect(directorFilmstripTileTimeSec(request, 2)).toBeCloseTo(15);
  });
});

describe("cache keys and hits", () => {
  it("derives the documented key format from the request", () => {
    const strip = requestDirectorClipFilmstrip(baseRequest({ mediaId: "key-media" }));
    expect(strip.key).toBe("key-media|1.000|4.000|1.000|48x46|2");
  });

  it("clamps tileCount and tile dimensions before keying", () => {
    const strip = requestDirectorClipFilmstrip(
      baseRequest({ mediaId: "clamped", tileCount: 1000, tileWidth: 4, tileHeight: 9000 }),
    );
    expect(strip.tiles).toHaveLength(240);
    expect(strip.key).toBe("clamped|1.000|4.000|1.000|8x512|240");
  });

  it("returns the same reference for repeated requests and resamples after clear", async () => {
    const request = baseRequest({ mediaId: "cache-media" });
    const first = requestDirectorClipFilmstrip(request);
    expect(first.complete).toBe(false);
    expect(first.tiles).toEqual([null, null]);
    expect(requestDirectorClipFilmstrip(request)).toBe(first);

    await flushSampling();
    const settled = getDirectorClipFilmstrip(request);
    expect(settled?.complete).toBe(true);
    expect(requestDirectorClipFilmstrip(request)).toBe(settled);
    expect(getDirectorClipFilmstrip(request)).toBe(settled);

    clearDirectorClipFilmstripCache();
    expect(getDirectorClipFilmstrip(request)).toBeNull();

    const retried = requestDirectorClipFilmstrip(request);
    expect(retried.complete).toBe(false);
    await flushSampling();
    expect(getDirectorClipFilmstrip(request)?.complete).toBe(true);
  });

  it("does not trigger sampling from getDirectorClipFilmstrip", () => {
    expect(getDirectorClipFilmstrip(baseRequest({ mediaId: "read-only" }))).toBeNull();
    expect(loadCallCount).toBe(0);
  });
});

describe("LRU eviction", () => {
  it("evicts the least recently read strip beyond the cache limit", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    loadBehavior = "stall";
    const first = baseRequest({ mediaId: "lru-first" });
    const second = baseRequest({ mediaId: "lru-second" });
    requestDirectorClipFilmstrip(first);
    requestDirectorClipFilmstrip(second);
    // Reading refreshes recency, so "second" becomes the oldest entry.
    expect(getDirectorClipFilmstrip(first)).not.toBeNull();

    for (let index = 0; index < DIRECTOR_CLIP_FILMSTRIP_CACHE_LIMIT - 1; index += 1) {
      requestDirectorClipFilmstrip(baseRequest({ mediaId: `lru-filler-${index}` }));
    }

    // 49 strips were requested against a limit of 48: exactly one eviction.
    expect(getDirectorClipFilmstrip(second)).toBeNull();
    expect(getDirectorClipFilmstrip(first)).not.toBeNull();
    expect(getDirectorClipFilmstrip(baseRequest({ mediaId: "lru-filler-0" }))).not.toBeNull();
  });
});

describe("sampling pipeline", () => {
  it("fills tiles in ascending source order and notifies subscribers", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeDirectorClipFilmstrips(listener);
    const request = baseRequest({ mediaId: "notify-media", tileCount: 2 });

    const initial = requestDirectorClipFilmstrip(request);
    expect(initial.tiles).toEqual([null, null]);

    await flushSampling();
    const strip = getDirectorClipFilmstrip(request);
    expect(strip?.complete).toBe(true);
    expect(strip?.tiles).toEqual([TILE_DATA_URL, TILE_DATA_URL]);
    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(1);
    // Tile centers: inSec 1 + (0.5/2)*4 = 2 and 1 + (1.5/2)*4 = 4, ascending.
    expect(seekLog).toEqual([directorFilmstripTileTimeSec(request, 0), directorFilmstripTileTimeSec(request, 1)]);
    unsubscribe();
  });

  it("runs at most two samplers concurrently and merges duplicate keys", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    loadBehavior = "stall";
    requestDirectorClipFilmstrip(baseRequest({ mediaId: "concurrent-0" }));
    requestDirectorClipFilmstrip(baseRequest({ mediaId: "concurrent-0" }));
    requestDirectorClipFilmstrip(baseRequest({ mediaId: "concurrent-1" }));
    requestDirectorClipFilmstrip(baseRequest({ mediaId: "concurrent-2" }));
    await flushSampling();
    // Third distinct strip stays queued; the duplicate never spawns a task.
    expect(loadCallCount).toBe(2);
  });

  it("completes the strip with null tiles when the video errors", async () => {
    loadBehavior = "error";
    const request = baseRequest({ mediaId: "error-media", tileCount: 3 });
    requestDirectorClipFilmstrip(request);
    await flushSampling();
    const strip = getDirectorClipFilmstrip(request);
    expect(strip?.complete).toBe(true);
    expect(strip?.tiles).toEqual([null, null, null]);
  });

  it("marks a tile null after the seek budget elapses and still completes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    seekBehavior = "stall";
    const request = baseRequest({ mediaId: "timeout-media", tileCount: 1 });
    requestDirectorClipFilmstrip(request);
    await flushSampling();
    // Trip the 8s per-seek budget.
    await vi.advanceTimersByTimeAsync(8_100);
    const strip = getDirectorClipFilmstrip(request);
    expect(strip?.complete).toBe(true);
    expect(strip?.tiles).toEqual([null]);
  });

  it("returns a settled all-null strip when no DOM is available (SSR)", () => {
    vi.stubGlobal("document", undefined);
    try {
      const strip = requestDirectorClipFilmstrip(baseRequest({ mediaId: "ssr-media", tileCount: 3 }));
      expect(strip.complete).toBe(true);
      expect(strip.tiles).toEqual([null, null, null]);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(loadCallCount).toBe(0);
  });
});

describe("useDirectorClipFilmstrip", () => {
  it("returns null for a null request without requesting work", () => {
    const { result } = renderHook(() => useDirectorClipFilmstrip(null));
    expect(result.current).toBeNull();
    expect(loadCallCount).toBe(0);
  });

  it("requests sampling, re-renders as tiles land, and keeps snapshots stable", async () => {
    const request = baseRequest({ mediaId: "hook-media", tileCount: 2 });
    const { result, rerender } = renderHook(
      ({ req }: { req: DirectorClipFilmstripRequest | null }) => useDirectorClipFilmstrip(req),
      { initialProps: { req: null as DirectorClipFilmstripRequest | null } },
    );
    expect(result.current).toBeNull();

    rerender({ req: request });
    // The mount effect requested sampling; tiles have not landed yet.
    expect(result.current).not.toBeNull();
    expect(result.current?.complete).toBe(false);

    await act(async () => {
      await flushSampling();
    });
    expect(result.current?.complete).toBe(true);
    expect(result.current?.tiles).toEqual([TILE_DATA_URL, TILE_DATA_URL]);

    // A new request object with identical parameters must not change the
    // snapshot reference, otherwise useSyncExternalStore would loop.
    const settled = result.current;
    rerender({ req: { ...request } });
    expect(result.current).toBe(settled);
  });
});
