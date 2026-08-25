import { afterEach, expect, it, vi } from "vitest";
import {
  clearViewportCaptureHandler,
  isViewportCaptureHostNeeded,
  isViewportCaptureUnavailableError,
  isViewportCaptureReady,
  requestViewportCapture,
  requestViewportCaptureHost,
  resetViewportCaptureHostRequest,
  setViewportCaptureHandler,
  subscribeViewportCaptureHost,
  subscribeViewportCaptureReadiness,
  type ViewportCaptureHandlerRequest,
} from "../../../../src/comprehensive/editor/io/captureBridge";

afterEach(() => {
  clearViewportCaptureHandler();
  resetViewportCaptureHostRequest();
});

it("forwards capture requests to the active canvas handler", async () => {
  const handler = vi.fn(async (_request: ViewportCaptureHandlerRequest) => [
    {
      label: "当前视角",
      dataUrl: "data:image/png;base64,demo",
      meta: {
        mode: "director" as const,
        cameraId: null,
        fov: 50,
        position: [0, 2.2, 9] as [number, number, number],
        target: [0, 1.2, 0] as [number, number, number],
      },
    },
  ]);

  setViewportCaptureHandler(handler);

  const results = await requestViewportCapture({
    preset: "current",
    source: "capture-panel",
    frame: 24,
    revisionRequested: 9,
  });

  expect(handler).toHaveBeenCalledWith({
    preset: "current",
    source: "capture-panel",
    frame: 24,
    revisionRequested: 9,
  });
  expect(handler.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);
  expect(handler.mock.calls[0]?.[0].signal.aborted).toBe(false);
  expect(results[0]?.dataUrl).toContain("data:image/png");
});

it("throws a clear error when the viewport capture handler is missing", async () => {
  const capture = requestViewportCapture({
    preset: "current",
    source: "camera-panel",
    cameraId: "cam_1",
  });
  await expect(capture).rejects.toThrow("Viewport capture handler is not registered");
  await expect(capture.catch((error: unknown) => isViewportCaptureUnavailableError(error))).resolves.toBe(true);
  expect(isViewportCaptureHostNeeded()).toBe(true);
});

it("asks the app shell to mount a capture host when the handler is missing", () => {
  const needed: boolean[] = [];
  const unsubscribe = subscribeViewportCaptureHost(() => needed.push(isViewportCaptureHostNeeded()));
  requestViewportCaptureHost();
  expect(isViewportCaptureHostNeeded()).toBe(true);
  expect(needed).toEqual([true]);
  requestViewportCaptureHost();
  expect(needed).toEqual([true]);
  unsubscribe();
});

it("waits for a late R3F registration when an external caller opts into the mount grace period", async () => {
  const handler = vi.fn(async (_request: ViewportCaptureHandlerRequest) => []);
  const capture = requestViewportCapture({
    preset: "current",
    source: "camera-panel",
    waitForHandlerMs: 1_000,
  });

  await Promise.resolve();
  expect(handler).not.toHaveBeenCalled();
  setViewportCaptureHandler(handler);

  await expect(capture).resolves.toEqual([]);
  expect(handler).toHaveBeenCalledTimes(1);
  expect(handler.mock.calls[0]?.[0]).not.toHaveProperty("waitForHandlerMs");
  expect(isViewportCaptureHostNeeded()).toBe(false);
});

it("cancels a registration wait without invoking a later handler", async () => {
  const controller = new AbortController();
  const capture = requestViewportCapture({
    preset: "current",
    source: "camera-panel",
    signal: controller.signal,
    waitForHandlerMs: 1_000,
  });

  controller.abort();
  await expect(capture).rejects.toMatchObject({ name: "AbortError" });

  const lateHandler = vi.fn(async () => []);
  setViewportCaptureHandler(lateHandler);
  await Promise.resolve();
  expect(lateHandler).not.toHaveBeenCalled();
});

it("preserves the active canvas lease when Vite evaluates a fresh bridge module", async () => {
  const handler = vi.fn(async () => []);
  setViewportCaptureHandler(handler);

  vi.resetModules();
  const hotReloadedBridge = await import("../../../../src/comprehensive/editor/io/captureBridge");
  await hotReloadedBridge.requestViewportCapture({ preset: "current", source: "camera-panel" });

  expect(handler).toHaveBeenCalledTimes(1);
});

it("serializes overlapping capture requests so exact frames cannot race", async () => {
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const startedFrames: number[] = [];
  setViewportCaptureHandler(async (request) => {
    startedFrames.push(request.frame ?? -1);
    if (request.frame === 1) await firstGate;
    return [];
  });

  const first = requestViewportCapture({ preset: "current", source: "capture-panel", frame: 1 });
  const second = requestViewportCapture({ preset: "current", source: "capture-panel", frame: 2 });
  await vi.waitFor(() => expect(startedFrames).toEqual([1]));

  releaseFirst?.();
  await Promise.all([first, second]);
  expect(startedFrames).toEqual([1, 2]);
});

it("forwards caller cancellation to the running capture as an AbortError", async () => {
  let handlerSignal: AbortSignal | undefined;
  const handler = vi.fn(async (request) => {
    handlerSignal = request.signal;
    return new Promise<never>(() => undefined);
  });
  const controller = new AbortController();
  setViewportCaptureHandler(handler);

  const capture = requestViewportCapture({
    preset: "current",
    source: "capture-panel",
    signal: controller.signal,
  });
  let rejection: unknown;
  const rejected = capture.catch((error: unknown) => {
    rejection = error;
  });
  await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

  controller.abort();

  await rejected;
  expect(rejection).toMatchObject({ name: "AbortError" });
  expect(isViewportCaptureUnavailableError(rejection)).toBe(false);
  expect(handlerSignal?.aborted).toBe(true);
});

it("aborts running and queued captures on clear and gives the next handler a fresh queue", async () => {
  const startedFrames: number[] = [];
  const oldHandler = vi.fn(async (request) => {
    startedFrames.push(request.frame ?? -1);
    return new Promise<never>(() => undefined);
  });
  setViewportCaptureHandler(oldHandler);

  const running = requestViewportCapture({ preset: "current", source: "capture-panel", frame: 1 });
  const queued = requestViewportCapture({ preset: "current", source: "capture-panel", frame: 2 });
  let runningError: unknown;
  let queuedError: unknown;
  const runningRejected = running.catch((error: unknown) => {
    runningError = error;
  });
  const queuedRejected = queued.catch((error: unknown) => {
    queuedError = error;
  });
  await vi.waitFor(() => expect(startedFrames).toEqual([1]));

  clearViewportCaptureHandler();

  await Promise.all([runningRejected, queuedRejected]);
  expect(runningError).toMatchObject({ name: "AbortError" });
  expect(queuedError).toMatchObject({ name: "AbortError" });
  expect(isViewportCaptureUnavailableError(runningError)).toBe(true);
  expect(isViewportCaptureUnavailableError(queuedError)).toBe(true);
  expect(startedFrames).toEqual([1]);

  const nextHandler = vi.fn(async () => []);
  setViewportCaptureHandler(nextHandler);
  await requestViewportCapture({ preset: "current", source: "capture-panel", frame: 3 });
  expect(nextHandler).toHaveBeenCalledTimes(1);
});

it("does not let a stale registration cleanup clear its replacement", async () => {
  const firstHandler = vi.fn(async () => []);
  const secondHandler = vi.fn(async () => []);
  const cleanupFirst = setViewportCaptureHandler(firstHandler);
  setViewportCaptureHandler(secondHandler);

  cleanupFirst();
  await requestViewportCapture({ preset: "current", source: "capture-panel" });

  expect(firstHandler).not.toHaveBeenCalled();
  expect(secondHandler).toHaveBeenCalledTimes(1);
});

it("publishes capture readiness when the Stage handler mounts and unmounts", () => {
  const readiness: boolean[] = [];
  const unsubscribe = subscribeViewportCaptureReadiness(() => readiness.push(isViewportCaptureReady()));

  const cleanup = setViewportCaptureHandler(async () => []);
  cleanup();
  unsubscribe();

  expect(readiness).toEqual([true, false]);
  expect(isViewportCaptureReady()).toBe(false);
});
