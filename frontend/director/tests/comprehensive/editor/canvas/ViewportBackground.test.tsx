import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ClampToEdgeWrapping, Color, EquirectangularReflectionMapping, Euler, SRGBColorSpace, Texture } from "three";
import type { DirectorAssetRef } from "../../../../src/comprehensive/editor/schema/directorProject";

const loaderCalls: Array<{
  url: string;
  texture: Texture;
  onLoad: (texture: Texture) => void;
  onError?: (error: unknown) => void;
}> = [];
let synchronousLoaderError: Error | null = null;

const mockScene = {
  background: null as unknown,
  environment: null as unknown,
  backgroundRotation: new Euler(),
  environmentRotation: new Euler(),
  backgroundBlurriness: 0.25,
  backgroundIntensity: 0.4,
  environmentIntensity: 0.3,
};
const mockGl = {
  setClearColor: vi.fn(),
};

vi.mock("three", async () => {
  const actual = await vi.importActual<typeof import("three")>("three");

  return {
    ...actual,
    TextureLoader: class {
      load(url: string, onLoad: (texture: Texture) => void, _onProgress?: unknown, onError?: (error: unknown) => void) {
        if (synchronousLoaderError) throw synchronousLoaderError;
        const texture = new actual.Texture();
        loaderCalls.push({ url, texture, onLoad: onLoad as (texture: Texture) => void, onError });
        return texture;
      }
    },
  };
});

vi.mock("@react-three/fiber", () => ({
  useFrame: vi.fn(),
  useThree: () => ({
    camera: { position: { copy: vi.fn() } },
    gl: mockGl,
    scene: mockScene,
  }),
}));

vi.mock("@react-three/drei", () => ({
  Html: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

import { useFrame } from "@react-three/fiber";
import { ViewportBackground } from "../../../../src/comprehensive/editor/canvas/ViewportBackground";

const panoramaAsset: DirectorAssetRef = {
  id: "asset_panorama_1",
  kind: "panorama",
  sourceType: "image",
  fileName: "studio-panorama.jpg",
  url: "data:image/jpeg;base64,studio",
  projectionMode: "equirectangular",
};

const backdropAsset: DirectorAssetRef = {
  ...panoramaAsset,
  id: "asset_backdrop_1",
  fileName: "regular-photo.jpg",
  projectionMode: "backdrop",
};

beforeEach(() => {
  loaderCalls.length = 0;
  mockScene.background = null;
  mockScene.environment = null;
  mockScene.backgroundRotation.set(0, 0, 0);
  mockScene.environmentRotation.set(0, 0, 0);
  mockScene.backgroundBlurriness = 0.25;
  mockScene.backgroundIntensity = 0.4;
  mockScene.environmentIntensity = 0.3;
  mockGl.setClearColor.mockClear();
  synchronousLoaderError = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("sets true 2:1 panorama textures as the 3D viewport equirectangular background", async () => {
  const { container } = render(
    <ViewportBackground backgroundColor="#06080D" panoramaAsset={panoramaAsset} panoramaRadius={60} panoramaYaw={30} />,
  );

  expect(loaderCalls[0]?.url).toBe(panoramaAsset.url);
  expect(mockScene.background).toBeInstanceOf(Color);

  act(() => {
    loaderCalls[0]?.onLoad(loaderCalls[0].texture);
  });

  await waitFor(() => expect(mockScene.background).toBe(loaderCalls[0]?.texture));
  expect(loaderCalls[0]?.texture.colorSpace).toBe(SRGBColorSpace);
  expect(loaderCalls[0]?.texture.mapping).toBe(EquirectangularReflectionMapping);
  expect(mockScene.backgroundRotation.y).toBeCloseTo((120 * Math.PI) / 180);
  expect(container.querySelector('mesh[name="panorama-backdrop-dome"]')).not.toBeInTheDocument();
  expect(container.querySelector("mesh[data-testid]")).not.toBeInTheDocument();
});

it("can reuse an equirectangular panorama as rotated PBR environment lighting", async () => {
  render(
    <ViewportBackground
      backgroundColor="#06080D"
      environmentEnabled
      environmentIntensity={0.75}
      environmentRotation={[0.1, 0.2, 0.3]}
      environmentUsePanorama
      panoramaAsset={panoramaAsset}
      panoramaRadius={60}
      panoramaYaw={30}
    />,
  );

  act(() => loaderCalls[0]?.onLoad(loaderCalls[0].texture));
  await waitFor(() => expect(mockScene.environment).toBe(loaderCalls[0]?.texture));
  expect(mockScene.environmentIntensity).toBe(0.75);
  expect(mockScene.environmentRotation.x).toBeCloseTo(0.1);
  expect(mockScene.environmentRotation.y).toBeCloseTo(0.2 + (120 * Math.PI) / 180);
  expect(mockScene.environmentRotation.z).toBeCloseTo(0.3);
});

it("renders regular uploaded photos on a scalable sphere with seam-safe edge handling", async () => {
  const { container, rerender } = render(
    <ViewportBackground backgroundColor="#06080D" panoramaAsset={backdropAsset} panoramaRadius={60} panoramaYaw={30} />,
  );

  act(() => {
    loaderCalls[0]?.onLoad(loaderCalls[0].texture);
  });

  await waitFor(() => expect(container.querySelector('mesh[name="panorama-backdrop-dome"]')).toBeInTheDocument());
  expect(mockScene.background).toBeInstanceOf(Color);
  expect(mockScene.background).not.toBe(loaderCalls[0]?.texture);
  expect(loaderCalls[0]?.texture.mapping).not.toBe(EquirectangularReflectionMapping);
  expect(loaderCalls[0]?.texture.wrapS).toBe(ClampToEdgeWrapping);
  expect(loaderCalls[0]?.texture.wrapT).toBe(ClampToEdgeWrapping);
  expect(loaderCalls[0]?.texture.repeat.x).toBe(-1);
  expect(loaderCalls[0]?.texture.offset.x).toBe(1);
  expect(useFrame).not.toHaveBeenCalled();
  expect(container.querySelector("spheregeometry")).toHaveAttribute("args", "60,96,64");

  const backdropMesh = container.querySelector('mesh[name="panorama-backdrop-dome"]');
  expect(backdropMesh).not.toHaveAttribute("scale", "60,60,60");

  rerender(
    <ViewportBackground
      backgroundColor="#06080D"
      panoramaAsset={backdropAsset}
      panoramaRadius={150}
      panoramaYaw={30}
    />,
  );

  expect(container.querySelector("spheregeometry")).toHaveAttribute("args", "150,96,64");
});

it("shows a visible viewport message instead of silently blacking out when panorama loading fails", async () => {
  render(
    <ViewportBackground backgroundColor="#123456" panoramaAsset={panoramaAsset} panoramaRadius={60} panoramaYaw={0} />,
  );

  act(() => {
    loaderCalls[0]?.onError?.(new Error("texture failed"));
  });

  expect(await screen.findByText("全景图加载失败")).toBeInTheDocument();
  expect(mockScene.background).toBeInstanceOf(Color);
});

it("contains synchronous texture loader crashes so the page does not go black", async () => {
  synchronousLoaderError = new Error("texture loader crashed");

  render(
    <ViewportBackground backgroundColor="#123456" panoramaAsset={panoramaAsset} panoramaRadius={60} panoramaYaw={0} />,
  );

  expect(await screen.findByText("全景图加载失败")).toBeInTheDocument();
  expect(mockScene.background).toBeInstanceOf(Color);
});

it("detaches its owned background during unmount cleanup", () => {
  const { unmount } = render(
    <ViewportBackground backgroundColor="#000000" panoramaAsset={null} panoramaRadius={60} panoramaYaw={0} />,
  );

  expect(mockScene.background).toBeInstanceOf(Color);

  unmount();

  expect(mockScene.background).toBeNull();
});

it("does not clear a newer background owned by another viewport", () => {
  const { unmount } = render(
    <ViewportBackground backgroundColor="#000000" panoramaAsset={null} panoramaRadius={60} panoramaYaw={0} />,
  );
  const replacement = new Color("#ffffff");
  mockScene.background = replacement;

  unmount();

  expect(mockScene.background).toBe(replacement);
});

it("detaches a loaded panorama when the owning viewport unmounts", async () => {
  const { unmount } = render(
    <ViewportBackground backgroundColor="#000000" panoramaAsset={panoramaAsset} panoramaRadius={60} panoramaYaw={0} />,
  );
  const texture = loaderCalls[0].texture;
  const dispose = vi.spyOn(texture, "dispose");

  act(() => loaderCalls[0].onLoad(texture));
  await waitFor(() => expect(mockScene.background).toBe(texture));
  unmount();

  expect(mockScene.background).toBeNull();
  expect(dispose).toHaveBeenCalledOnce();
});

it("detaches the previous panorama before disposing it during a URL swap", async () => {
  const replacementAsset = {
    ...panoramaAsset,
    id: "asset_panorama_2",
    url: "data:image/jpeg;base64,replacement",
  };
  const { rerender } = render(
    <ViewportBackground backgroundColor="#000000" panoramaAsset={panoramaAsset} panoramaRadius={60} panoramaYaw={0} />,
  );
  const previousTexture = loaderCalls[0].texture;

  act(() => loaderCalls[0].onLoad(previousTexture));
  await waitFor(() => expect(mockScene.background).toBe(previousTexture));
  const dispose = vi.spyOn(previousTexture, "dispose").mockImplementation(() => {
    expect(mockScene.background).not.toBe(previousTexture);
  });

  rerender(
    <ViewportBackground
      backgroundColor="#000000"
      panoramaAsset={replacementAsset}
      panoramaRadius={60}
      panoramaYaw={0}
    />,
  );

  expect(dispose).toHaveBeenCalledOnce();
  expect(mockScene.background).toBeInstanceOf(Color);
  expect(loaderCalls[1]?.url).toBe(replacementAsset.url);

  act(() => loaderCalls[1].onLoad(loaderCalls[1].texture));
  await waitFor(() => expect(mockScene.background).toBe(loaderCalls[1].texture));
});

it("does not clear scene.environment when no panorama is lighting the scene", () => {
  const kept = new Texture();
  mockScene.environment = kept;
  mockScene.environmentIntensity = 0.62;

  render(<ViewportBackground backgroundColor="#000000" panoramaAsset={null} panoramaRadius={60} panoramaYaw={0} />);

  expect(mockScene.environment).toBe(kept);
  expect(mockScene.environmentIntensity).toBe(0.62);
});
