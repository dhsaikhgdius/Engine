/**
 * Browser-session cache for genuine camera-frame scene thumbnails.
 *
 * These are never embedded into portable scene JSON: a camera PNG can be
 * several megabytes, while the production manifest must remain a lightweight
 * list of scene references. The cache is shared by the left and bottom scene
 * browsers and survives a normal reload in this tab via sessionStorage.
 */

const STORAGE_PREFIX = "3d-director-ui:scene-camera-thumbnail:";
const listeners = new Set<() => void>();
const inFlight = new Map<string, Promise<string | null>>();
let snapshot: Readonly<Record<string, string>> = Object.freeze({});

function storageKey(sceneId: string) {
  return `${STORAGE_PREFIX}${sceneId}`;
}

function validImageDataUrl(value: unknown): value is string {
  return typeof value === "string" && /^data:image\/(png|jpeg|webp);base64,/i.test(value);
}

function emit() {
  listeners.forEach((listener) => listener());
}

/**
 * Returns the current snapshot of all cached scene camera thumbnails.
 *
 * The returned object is frozen and will not reflect subsequent updates;
 * subscribe to changes with {@link subscribeSceneCameraThumbnails}.
 *
 * @returns A frozen record mapping scene IDs to data URL strings.
 */
export function getSceneCameraThumbnails() {
  return snapshot;
}

/**
 * Subscribes to changes in the scene camera thumbnail cache.
 *
 * @param listener - A callback invoked whenever a thumbnail is added or the cache is reset.
 * @returns An unsubscribe function that removes the listener.
 */
export function subscribeSceneCameraThumbnails(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Reads a cached camera thumbnail for a scene, falling back to sessionStorage.
 *
 * On a cache miss, it attempts to hydrate from sessionStorage; on success
 * the value is promoted to the in-memory snapshot.
 *
 * @param sceneId - The unique identifier of the scene.
 * @returns The data URL string if cached, or null if unavailable.
 */
export function readSceneCameraThumbnail(sceneId: string) {
  if (!sceneId) return null;
  const cached = snapshot[sceneId];
  if (cached) return cached;
  try {
    const stored = window.sessionStorage.getItem(storageKey(sceneId));
    if (!validImageDataUrl(stored)) return null;
    snapshot = Object.freeze({ ...snapshot, [sceneId]: stored });
    return stored;
  } catch {
    return null;
  }
}

/**
 * Stores a camera thumbnail data URL in the cache and persists it to sessionStorage.
 *
 * If the thumbnail is already stored under the same scene ID and value,
 * this is a no-op. On sessionStorage write failure (e.g. quota exhaustion),
 * the thumbnail remains in memory for the lifetime of the page.
 *
 * @param sceneId - The unique identifier of the scene.
 * @param dataUrl - The base64-encoded PNG, JPEG, or WebP data URL.
 */
export function rememberSceneCameraThumbnail(sceneId: string, dataUrl: string) {
  if (!sceneId || !validImageDataUrl(dataUrl)) return;
  if (snapshot[sceneId] === dataUrl) return;
  snapshot = Object.freeze({ ...snapshot, [sceneId]: dataUrl });
  try {
    window.sessionStorage.setItem(storageKey(sceneId), dataUrl);
  } catch {
    // Quota exhaustion must not prevent the current card from showing its
    // genuine frame; it simply becomes memory-only for this page lifetime.
  }
  emit();
}

/**
 * Returns a cached thumbnail or captures one via the provided callback.
 *
 * Deduplicates concurrent capture requests for the same scene: if a capture
 * is already in flight, the existing promise is returned instead of starting
 * a new one. On success the captured thumbnail is stored in the cache.
 *
 * @param sceneId - The unique identifier of the scene.
 * @param capture - A callback that produces a data URL (or null if capture fails).
 * @returns A promise resolving to the data URL string, or null if unavailable.
 */
export async function ensureSceneCameraThumbnail(sceneId: string, capture: () => Promise<string | null>) {
  const existing = readSceneCameraThumbnail(sceneId);
  if (existing) return existing;
  const running = inFlight.get(sceneId);
  if (running) return running;
  const task = Promise.resolve(capture())
    .then((dataUrl) => {
      if (dataUrl) rememberSceneCameraThumbnail(sceneId, dataUrl);
      return dataUrl;
    })
    .catch(() => null)
    .finally(() => inFlight.delete(sceneId));
  inFlight.set(sceneId, task);
  return task;
}

/**
 * Clears all in-memory and in-flight thumbnail state.
 *
 * This does not clear sessionStorage entries; they will be re-hydrated
 * on the next read for each scene.
 */
export function resetSceneCameraThumbnailCache() {
  snapshot = Object.freeze({});
  inFlight.clear();
  emit();
}
