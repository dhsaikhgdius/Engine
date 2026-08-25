import type { ScreenshotResult } from "./screenshotExport";
import type { DirectorCaptureBackgroundMode } from "../render/renderPassCapture";
import type { DirectorShotRenderPassId } from "../shot/shotPackage";

export type ViewportCapturePreset = "current" | "four" | "twelve";

/** Capture request from any caller (UI, gateway, agent) to the Stage viewport's offscreen renderer. */
export interface ViewportCaptureRequest {
  preset: ViewportCapturePreset;
  source: "capture-panel" | "camera-panel";
  cameraId?: string | null;
  /** Render only scene content for downstream video/image generation. */
  cleanPlate?: boolean;
  /** Optional auxiliary render channel. Omitted and `clean` both use the beauty pass. */
  renderPass?: DirectorShotRenderPassId;
  /**
   * "transparent" renders the offscreen beauty pass with alpha-0 empty pixels
   * and environment dressing hidden (绿幕/合成用). Only honored by offscreen
   * clean renders; omitted requests keep the composited default.
   */
  background?: DirectorCaptureBackgroundMode;
  /** False disables the cinematic depth-of-field pass; default keeps it on. */
  depthOfField?: boolean;
  /**
   * Additionally read back float depth for EXR encoding. Honored only by the
   * offscreen "depth" render pass; the handler attaches the payload to the
   * returned screenshot's `depthFloat` field.
   */
  depthFloat?: boolean;
  /**
   * Additionally compute the dense per-pixel motion flow field for float EXR
   * encoding. Honored only by the offscreen "motion" render pass; the handler
   * attaches the payload to the returned screenshot's `motionFlow` field.
   */
  motionFlowFloat?: boolean;
  /** Return the raw top-to-bottom RGBA8 pass buffer for dataset annotations. */
  includeRenderPixels?: boolean;
  /** Exact off-screen raster size. Width and height must be supplied together. */
  width?: number;
  height?: number;
  frame?: number;
  revisionRequested?: number;
  /**
   * Allow a caller that outlives the React viewport (for example the Agent
   * Gateway) to bridge the short interval before R3F commits its capture
   * handler. UI callers keep the fail-fast default.
   */
  waitForHandlerMs?: number;
  signal?: AbortSignal;
}

/** The shape a capture request takes once it reaches the handler, with the AbortSignal guaranteed present. */
export type ViewportCaptureHandlerRequest = Omit<ViewportCaptureRequest, "signal" | "waitForHandlerMs"> & {
  readonly signal: AbortSignal;
};

/** The handler signature that the R3F viewport must register to receive capture requests. */
export type ViewportCaptureHandler = (request: ViewportCaptureHandlerRequest) => Promise<ScreenshotResult[]>;

type ViewportCaptureRegistration = {
  controller: AbortController;
  handler: ViewportCaptureHandler;
  queue: Promise<void>;
};

type ViewportCaptureRegistrationWaiter = {
  resolve: (registration: ViewportCaptureRegistration) => void;
};

type ViewportCaptureBridgeState = {
  version: 1;
  registration: ViewportCaptureRegistration | null;
  waiters: Set<ViewportCaptureRegistrationWaiter>;
};

type ViewportCaptureReadinessState = {
  version: 1;
  listeners: Set<() => void>;
};

type ViewportCaptureHostState = {
  version: 1;
  needed: boolean;
  activeLeases: number;
  persistentRequest: boolean;
  listeners: Set<() => void>;
};

/**
 * Vite can hot-replace this module without remounting the already committed
 * R3F tree. A module-local registration is therefore not durable enough: the
 * visible canvas keeps its handler closure while a newly evaluated
 * requestViewportCapture would see an empty singleton. Keeping the small
 * runtime lease on globalThis makes both module generations share ownership;
 * a real page navigation still creates a fresh realm and a fresh bridge.
 */
const VIEWPORT_CAPTURE_BRIDGE_STATE_KEY = "__DIRECTOR_VIEWPORT_CAPTURE_BRIDGE_STATE__";
const VIEWPORT_CAPTURE_READINESS_STATE_KEY = "__DIRECTOR_VIEWPORT_CAPTURE_READINESS_STATE__";
const VIEWPORT_CAPTURE_HOST_STATE_KEY = "__DIRECTOR_VIEWPORT_CAPTURE_HOST_STATE__";
const VIEWPORT_CAPTURE_HANDLER_MISSING_MESSAGE = "Viewport capture handler is not registered";
const VIEWPORT_CAPTURE_REGISTRATION_RELEASED_MESSAGE = "Viewport capture handler was unregistered during capture";
/** Cold-mounting DirectorCanvas on Agent/Canvas/Video needs more than the Stage commit grace. */
const VIEWPORT_CAPTURE_HOST_MOUNT_MS = 20_000;

function getViewportCaptureBridgeState() {
  const runtime = globalThis as typeof globalThis & {
    [VIEWPORT_CAPTURE_BRIDGE_STATE_KEY]?: ViewportCaptureBridgeState;
  };
  const existing = runtime[VIEWPORT_CAPTURE_BRIDGE_STATE_KEY];
  if (existing?.version === 1) return existing;

  const created: ViewportCaptureBridgeState = {
    version: 1,
    registration: null,
    waiters: new Set(),
  };
  runtime[VIEWPORT_CAPTURE_BRIDGE_STATE_KEY] = created;
  return created;
}

function getViewportCaptureReadinessState() {
  const runtime = globalThis as typeof globalThis & {
    [VIEWPORT_CAPTURE_READINESS_STATE_KEY]?: ViewportCaptureReadinessState;
  };
  const existing = runtime[VIEWPORT_CAPTURE_READINESS_STATE_KEY];
  if (existing?.version === 1) return existing;

  const created: ViewportCaptureReadinessState = {
    version: 1,
    listeners: new Set(),
  };
  runtime[VIEWPORT_CAPTURE_READINESS_STATE_KEY] = created;
  return created;
}

function notifyViewportCaptureReadiness() {
  [...getViewportCaptureReadinessState().listeners].forEach((listener) => listener());
}

function getViewportCaptureHostState() {
  const runtime = globalThis as typeof globalThis & {
    [VIEWPORT_CAPTURE_HOST_STATE_KEY]?: ViewportCaptureHostState;
  };
  const existing = runtime[VIEWPORT_CAPTURE_HOST_STATE_KEY];
  if (existing?.version === 1) {
    // Preserve the host latch across Vite module replacement while upgrading
    // realms that were created before capture-host leases existed.
    existing.activeLeases ??= 0;
    existing.persistentRequest ??= existing.needed;
    return existing;
  }

  const created: ViewportCaptureHostState = {
    version: 1,
    needed: false,
    activeLeases: 0,
    persistentRequest: false,
    listeners: new Set(),
  };
  runtime[VIEWPORT_CAPTURE_HOST_STATE_KEY] = created;
  return created;
}

function notifyViewportCaptureHost() {
  [...getViewportCaptureHostState().listeners].forEach((listener) => listener());
}

/** Whether the app should mount an offscreen Stage canvas for capture. */
export function isViewportCaptureHostNeeded() {
  return getViewportCaptureHostState().needed;
}

/** Subscribe to on-demand capture-host mount requests. */
export function subscribeViewportCaptureHost(listener: () => void) {
  const host = getViewportCaptureHostState();
  host.listeners.add(listener);
  return () => host.listeners.delete(listener);
}

/**
 * Ask the app shell to mount a hidden Stage canvas. Agent / Canvas / Video
 * tabs have no visible viewport; capture still needs the R3F handler.
 */
export function requestViewportCaptureHost() {
  const host = getViewportCaptureHostState();
  host.persistentRequest = true;
  if (host.needed) return;
  host.needed = true;
  notifyViewportCaptureHost();
}

function acquireViewportCaptureHost() {
  const host = getViewportCaptureHostState();
  host.activeLeases += 1;
  if (!host.needed) {
    host.needed = true;
    notifyViewportCaptureHost();
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = getViewportCaptureHostState();
    current.activeLeases = Math.max(0, current.activeLeases - 1);
    if (current.activeLeases > 0 || current.persistentRequest || !current.needed) return;
    current.needed = false;
    notifyViewportCaptureHost();
  };
}

/** Test helper: drop the host-needed latch without touching the handler. */
export function resetViewportCaptureHostRequest() {
  const host = getViewportCaptureHostState();
  host.persistentRequest = false;
  if (!host.needed) return;
  host.needed = false;
  notifyViewportCaptureHost();
}

/** Whether this browser realm currently owns a mounted Stage capture handler. */
export function isViewportCaptureReady() {
  return Boolean(getActiveViewportCaptureRegistration());
}

/** Subscribe to mount/unmount changes without coupling the gateway to React. */
export function subscribeViewportCaptureReadiness(listener: () => void) {
  const readiness = getViewportCaptureReadinessState();
  readiness.listeners.add(listener);
  return () => readiness.listeners.delete(listener);
}

function createViewportCaptureAbortError() {
  return new DOMException("Viewport capture aborted", "AbortError");
}

function createViewportCaptureRegistrationAbortError() {
  return new DOMException(VIEWPORT_CAPTURE_REGISTRATION_RELEASED_MESSAGE, "AbortError");
}

/**
 * Lifecycle failures are retryable host-state failures, unlike a caller or
 * gateway cancellation. Keep the distinction explicit even though both
 * interrupt a running render with an AbortError.
 */
export function isViewportCaptureUnavailableError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { message?: unknown; name?: unknown };
  return (
    candidate.message === VIEWPORT_CAPTURE_HANDLER_MISSING_MESSAGE ||
    (candidate.name === "AbortError" && candidate.message === VIEWPORT_CAPTURE_REGISTRATION_RELEASED_MESSAGE)
  );
}

function getViewportCaptureAbortError(signal: AbortSignal) {
  const reason = signal.reason;
  return reason instanceof DOMException && reason.name === "AbortError" ? reason : createViewportCaptureAbortError();
}

/**
 * Throws an AbortError if the given signal is already aborted.
 * Callers should check the signal before starting expensive capture work.
 *
 * @param signal - The AbortSignal to check.
 */
export function throwIfViewportCaptureAborted(signal: AbortSignal) {
  if (signal.aborted) {
    throw getViewportCaptureAbortError(signal);
  }
}

function combineCaptureSignals(...signals: Array<AbortSignal | undefined>) {
  const controller = new AbortController();
  const removeListeners: Array<() => void> = [];

  const abortFrom = (signal: AbortSignal) => {
    if (!controller.signal.aborted) {
      controller.abort(getViewportCaptureAbortError(signal));
    }
  };

  signals.forEach((signal) => {
    if (!signal) return;
    if (signal.aborted) {
      abortFrom(signal);
      return;
    }

    const onAbort = () => abortFrom(signal);
    signal.addEventListener("abort", onAbort, { once: true });
    removeListeners.push(() => signal.removeEventListener("abort", onAbort));
  });

  return {
    release: () => removeListeners.forEach((removeListener) => removeListener()),
    signal: controller.signal,
  };
}

function rejectOnCaptureAbort<T>(promise: Promise<T>, signal: AbortSignal) {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      complete();
    };
    const onAbort = () => finish(() => reject(getViewportCaptureAbortError(signal)));

    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
    if (signal.aborted) onAbort();
  });
}

function attachCaptureSignal(request: ViewportCaptureRequest, signal: AbortSignal): ViewportCaptureHandlerRequest {
  const { signal: _requestedSignal, waitForHandlerMs: _waitForHandlerMs, ...handlerRequest } = request;
  // Cancellation is runtime-only; keep the existing serializable capture payload shape stable.
  Object.defineProperty(handlerRequest, "signal", {
    configurable: false,
    enumerable: false,
    value: signal,
    writable: false,
  });
  return handlerRequest as ViewportCaptureHandlerRequest;
}

function abortRegistration(registration: ViewportCaptureRegistration) {
  if (!registration.controller.signal.aborted) {
    registration.controller.abort(createViewportCaptureRegistrationAbortError());
  }
  registration.queue = Promise.resolve();
}

function getActiveViewportCaptureRegistration() {
  return getViewportCaptureBridgeState().registration;
}

function waitForViewportCaptureRegistration(timeoutMs: number, signal?: AbortSignal) {
  const current = getActiveViewportCaptureRegistration();
  if (current) return Promise.resolve(current);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new Error(VIEWPORT_CAPTURE_HANDLER_MISSING_MESSAGE));
  }
  if (signal?.aborted) return Promise.reject(getViewportCaptureAbortError(signal));

  const bridgeState = getViewportCaptureBridgeState();
  return new Promise<ViewportCaptureRegistration>((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      signal?.removeEventListener("abort", onAbort);
      bridgeState.waiters.delete(waiter);
      complete();
    };
    const waiter: ViewportCaptureRegistrationWaiter = {
      resolve: (registration) => finish(() => resolve(registration)),
    };
    const onAbort = () => finish(() => reject(getViewportCaptureAbortError(signal!)));
    const timeoutId = window.setTimeout(
      () => finish(() => reject(new Error(VIEWPORT_CAPTURE_HANDLER_MISSING_MESSAGE))),
      timeoutMs,
    );

    bridgeState.waiters.add(waiter);
    signal?.addEventListener("abort", onAbort, { once: true });

    // Registration can land between the first read and waiter insertion.
    const registration = bridgeState.registration;
    if (registration) waiter.resolve(registration);
  });
}

/**
 * Registers the R3F canvas's capture handler. Returns a cleanup function that
 * unregisters and aborts any in-flight captures. Only one handler can be
 * registered at a time; a new call replaces the previous one.
 *
 * @param handler - The viewport capture handler from the R3F canvas.
 * @returns A cleanup function to unregister the handler.
 */
export function setViewportCaptureHandler(handler: ViewportCaptureHandler) {
  clearViewportCaptureHandler();

  const registration: ViewportCaptureRegistration = {
    controller: new AbortController(),
    handler,
    queue: Promise.resolve(),
  };
  const bridgeState = getViewportCaptureBridgeState();
  bridgeState.registration = registration;
  [...bridgeState.waiters].forEach((waiter) => waiter.resolve(registration));
  notifyViewportCaptureReadiness();

  return () => {
    const currentState = getViewportCaptureBridgeState();
    if (currentState.registration !== registration) return;
    currentState.registration = null;
    abortRegistration(registration);
    notifyViewportCaptureReadiness();
  };
}

/** Unregisters the current capture handler and aborts any in-flight captures. Idempotent. */
export function clearViewportCaptureHandler() {
  const bridgeState = getViewportCaptureBridgeState();
  const registration = bridgeState.registration;
  bridgeState.registration = null;
  if (registration) {
    abortRegistration(registration);
    notifyViewportCaptureReadiness();
  }
}

/**
 * Sends a capture request to the registered viewport handler. Requests are
 * serialized through a per-handler queue so overlapping captures never race.
 *
 * If no handler is registered yet, the call waits up to `waitForHandlerMs`
 * for one to appear (useful for gateway callers that outlive the React mount).
 *
 * @param request - The capture request parameters.
 * @returns The screenshot results from the handler.
 */
export async function requestViewportCapture(request: ViewportCaptureRequest) {
  // Preserve the established scheduling contract for an already mounted
  // canvas: adding an unconditional await here would insert an extra
  // microtask before the R3F render barrier.
  const existing = getActiveViewportCaptureRegistration();
  const requestedWait = request.waitForHandlerMs ?? 0;
  const releaseHost =
    (!existing && requestedWait > 0) || (existing && isViewportCaptureHostNeeded())
      ? acquireViewportCaptureHost()
      : null;
  if (!existing && !releaseHost) requestViewportCaptureHost();
  const waitMs = !existing && requestedWait > 0 ? Math.max(requestedWait, VIEWPORT_CAPTURE_HOST_MOUNT_MS) : requestedWait;

  try {
    const registration = existing ?? (await waitForViewportCaptureRegistration(waitMs, request.signal));
    const combined = combineCaptureSignals(registration.controller.signal, request.signal);
    const execution = registration.queue.then(() => {
      throwIfViewportCaptureAborted(combined.signal);
      const handlerResult = Promise.resolve(registration.handler(attachCaptureSignal(request, combined.signal)));
      return rejectOnCaptureAbort(handlerResult, combined.signal);
    });
    registration.queue = execution.then(
      () => undefined,
      () => undefined,
    );

    try {
      return await rejectOnCaptureAbort(execution, combined.signal);
    } finally {
      combined.release();
    }
  } finally {
    releaseHost?.();
  }
}
