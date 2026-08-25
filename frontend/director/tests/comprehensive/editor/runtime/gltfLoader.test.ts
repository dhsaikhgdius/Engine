import { renderHook, waitFor } from "@testing-library/react";
import { Group } from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearDirectorGltfDocumentCache,
  createDirectorGLTFLoader,
  loadDirectorGltfDocument,
  useDirectorGltfDocuments,
} from "../../../../src/comprehensive/editor/runtime/gltfLoader";

function emptyGltf(): GLTF {
  return { animations: [], scene: new Group() } as unknown as GLTF;
}

describe("director GLTF loader", () => {
  afterEach(() => {
    clearDirectorGltfDocumentCache();
    vi.restoreAllMocks();
  });

  it("creates a dedicated GLTFLoader per document so roam clips can parse concurrently", async () => {
    const instances: GLTFLoader[] = [];
    vi.spyOn(GLTFLoader.prototype, "loadAsync").mockImplementation(async function (this: GLTFLoader) {
      instances.push(this);
      return emptyGltf();
    });

    await Promise.all([loadDirectorGltfDocument("/a.glb"), loadDirectorGltfDocument("/b.glb")]);

    expect(instances).toHaveLength(2);
    expect(instances[0]).not.toBe(instances[1]);
    expect(instances[0]).toBeInstanceOf(GLTFLoader);
  });

  it("keeps successful roam clips when a sibling document fails", async () => {
    vi.spyOn(GLTFLoader.prototype, "loadAsync").mockImplementation(async (url) => {
      if (String(url).includes("missing")) throw new Error("404");
      return emptyGltf();
    });

    const { result } = renderHook(() => useDirectorGltfDocuments(["/walk.glb", "/missing.glb"]));
    expect(result.current).toBeNull();

    await waitFor(() => {
      expect(result.current?.[0]?.scene).toBeInstanceOf(Group);
      expect(result.current?.[1]).toBeNull();
    });
  });

  it("configures meshopt on every dedicated loader", () => {
    const loader = createDirectorGLTFLoader();
    expect(loader).toBeInstanceOf(GLTFLoader);
  });
});
