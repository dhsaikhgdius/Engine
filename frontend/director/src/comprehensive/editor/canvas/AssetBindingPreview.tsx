import { OrbitControls } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { useEffect, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { DIRECTOR_MAX_QUALITY_DPR } from "../performance/performanceProfiles";
import type { DirectorAssetRef } from "../schema/directorProject";
import { useSuppressViewportChromeWhileMounted } from "./viewportChromeSuppression";
import { ImportedModel } from "./SceneRoot";

function PreviewScene({ asset }: { asset: DirectorAssetRef }) {
  return (
    <>
      <color attach="background" args={["#111820"]} />
      <ambientLight intensity={1.35} />
      <directionalLight intensity={1.8} position={[3, 5, 4]} />
      <directionalLight color="#8ed9ff" intensity={0.65} position={[-4, 2, -3]} />
      <gridHelper args={[8, 16, "#2d4c60", "#1a2730"]} position={[0, -0.01, 0]} />
      <ImportedModel fileName={asset.fileName} url={asset.url} />
      <OrbitControls enableDamping makeDefault maxDistance={10} minDistance={1.6} target={[0, 0.7, 0]} />
    </>
  );
}

/** A real, rotatable Three.js asset preview shared by the hover card and modal. */
export function AssetPreviewCanvas({ asset }: { asset: DirectorAssetRef }) {
  return (
    <Canvas
      camera={{ fov: 42, position: [3.4, 2.5, 4.2] }}
      className="asset-binding-preview-canvas"
      dpr={DIRECTOR_MAX_QUALITY_DPR}
    >
      <PreviewScene asset={asset} />
    </Canvas>
  );
}

function PreviewShell({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  useSuppressViewportChromeWhileMounted("asset-binding-preview");
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return createPortal(children, document.body);
}

export function AssetBindingPreviewDialog({
  asset,
  bindingLabel,
  onClose,
}: {
  asset: DirectorAssetRef;
  bindingLabel: string;
  onClose: () => void;
}) {
  return (
    <PreviewShell onClose={onClose}>
      <div
        aria-label={`${bindingLabel} 资产预览`}
        className="asset-binding-preview-backdrop"
        onMouseDown={onClose}
        role="presentation"
      >
        <section
          aria-describedby="asset-binding-preview-file"
          aria-label={`${bindingLabel} 大图预览`}
          aria-modal="true"
          className="asset-binding-preview-dialog"
          onMouseDown={(event: MouseEvent<HTMLElement>) => event.stopPropagation()}
          role="dialog"
        >
          <header>
            <div>
              <strong>{bindingLabel}</strong>
              <code id="asset-binding-preview-file">{asset.fileName}</code>
            </div>
            <button aria-label={`关闭 ${bindingLabel} 预览`} onClick={onClose} title="关闭预览" type="button">
              关闭
            </button>
          </header>
          <AssetPreviewCanvas asset={asset} />
          <p>拖动旋转，滚轮缩放。这个预览不会改变场景中的对象位置。</p>
        </section>
      </div>
    </PreviewShell>
  );
}
