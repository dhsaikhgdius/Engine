import { useEffect, useRef, useState } from "react";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

/**
 * Keeps every bundled GLB loader on the same decoding contract. Blender's
 * gltfpack export writes EXT_meshopt_compression, which GLTFLoader deliberately
 * does not enable until a decoder is supplied.
 */
export function configureDirectorGLTFLoader(loader: GLTFLoader) {
  loader.setMeshoptDecoder(MeshoptDecoder);
  return loader;
}

/** A dedicated parser per request: GLTFLoader.parse is not safe to overlap. */
export function createDirectorGLTFLoader() {
  return configureDirectorGLTFLoader(new GLTFLoader());
}

export function loadDirectorGltfDocument(url: string): Promise<GLTF> {
  return createDirectorGLTFLoader().loadAsync(url);
}

const resolvedDocumentByUrl = new Map<string, GLTF | null>();
const pendingDocumentByUrl = new Map<string, Promise<GLTF | null>>();
const resolvedDocumentBatches = new Map<string, Array<GLTF | null>>();
const pendingDocumentBatches = new Map<string, Promise<Array<GLTF | null>>>();

function documentBatchKey(urls: readonly string[]) {
  return urls.join("\0");
}

function loadCachedDirectorGltfDocument(url: string): Promise<GLTF | null> {
  if (resolvedDocumentByUrl.has(url)) return Promise.resolve(resolvedDocumentByUrl.get(url) ?? null);
  const pending = pendingDocumentByUrl.get(url);
  if (pending) return pending;
  const next = loadDirectorGltfDocument(url)
    .then((gltf) => {
      resolvedDocumentByUrl.set(url, gltf);
      pendingDocumentByUrl.delete(url);
      return gltf;
    })
    .catch(() => {
      resolvedDocumentByUrl.set(url, null);
      pendingDocumentByUrl.delete(url);
      return null;
    });
  pendingDocumentByUrl.set(url, next);
  return next;
}

function loadDirectorGltfDocumentBatch(urls: readonly string[]): Promise<Array<GLTF | null>> {
  const key = documentBatchKey(urls);
  const resolved = resolvedDocumentBatches.get(key);
  if (resolved) return Promise.resolve(resolved);
  const pending = pendingDocumentBatches.get(key);
  if (pending) return pending;
  const next = Promise.all(urls.map((url) => loadCachedDirectorGltfDocument(url))).then((documents) => {
    resolvedDocumentBatches.set(key, documents);
    pendingDocumentBatches.delete(key);
    return documents;
  });
  pendingDocumentBatches.set(key, next);
  return next;
}

/** Test hook; production code keeps a session-level document cache per URL. */
export function clearDirectorGltfDocumentCache() {
  resolvedDocumentByUrl.clear();
  pendingDocumentByUrl.clear();
  resolvedDocumentBatches.clear();
  pendingDocumentBatches.clear();
}

/**
 * Load many GLBs without sharing one GLTFLoader across in-flight parses, and
 * without Suspense. R3F's `useLoader` keeps a single loader per class and
 * `Promise.all`s the URLs; one failed emote then throws during render, the
 * scene asset error boundary swaps the Mixamo hero for a static mannequin, and
 * roam looks like a T-pose slide. Failed URLs resolve to `null` so walk/run
 * still bind. Returns `null` while the batch is in flight.
 */
export function useDirectorGltfDocuments(urls: readonly string[]): Array<GLTF | null> | null {
  const key = documentBatchKey(urls);
  const urlsRef = useRef(urls);
  urlsRef.current = urls;
  const [snapshot, setSnapshot] = useState<{ key: string; documents: Array<GLTF | null> } | null>(() => {
    const cached = resolvedDocumentBatches.get(key);
    return cached ? { key, documents: cached } : null;
  });

  useEffect(() => {
    const cached = resolvedDocumentBatches.get(key);
    if (cached) {
      setSnapshot({ key, documents: cached });
      return;
    }
    let cancelled = false;
    void loadDirectorGltfDocumentBatch(urlsRef.current).then((documents) => {
      if (!cancelled) setSnapshot({ key, documents });
    });
    return () => {
      cancelled = true;
    };
  }, [key]);

  if (snapshot?.key === key) return snapshot.documents;
  return resolvedDocumentBatches.get(key) ?? null;
}
