/**
 * Fullscreen 3D preview modal for asset-library items: mounts a second,
 * self-contained R3F canvas (portal to document.body) with orbit controls so
 * the user can inspect a catalog model, character, or camera prop before
 * placing it on the Stage. Suppresses the main viewport chrome while open
 * and honors the resolved performance profile so the preview never outruns
 * the primary canvas's budget.
 */
import { OrbitControls } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { Suspense, useEffect, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import type { ModelLibraryItem } from "../modelLibrary/modelLibraryCatalog";
import { FLICK_HUMAN_DEFAULT_COLOR } from "../schema/flickHumanAppearance";
import { CharacterModel } from "../runtime/CharacterModel";
import { ImportedModel } from "./SceneRoot";
import { useResolvedPerformanceConfig } from "../performance/performanceRuntime";
import { useSuppressViewportChromeWhileMounted } from "./viewportChromeSuppression";

function CoreModelPreview({ item }: { item: ModelLibraryItem }) {
  if (item.nativeAction === "add-human") {
    return (
      <CharacterModel
        color={FLICK_HUMAN_DEFAULT_COLOR}
        rigState={{ rigType: "mixamo", posePresetId: "stand", controls: {} }}
      />
    );
  }

  if (item.nativeAction === "add-camera") {
    return (
      <group position={[0, 0.7, 0]} rotation={[0.16, -0.56, 0]}>
        <mesh castShadow>
          <boxGeometry args={[1.25, 0.68, 0.82]} />
          <meshStandardMaterial color="#242326" roughness={0.42} />
        </mesh>
        <mesh position={[0.76, 0, 0]} rotation={[0, Math.PI / 2, 0]} castShadow>
          <cylinderGeometry args={[0.3, 0.36, 0.5, 32]} />
          <meshStandardMaterial color="#111114" metalness={0.28} roughness={0.31} />
        </mesh>
        <mesh position={[1.03, 0, 0]} rotation={[0, Math.PI / 2, 0]}>
          <cylinderGeometry args={[0.2, 0.23, 0.08, 32]} />
          <meshStandardMaterial color="#8e9baa" metalness={0.36} roughness={0.22} />
        </mesh>
      </group>
    );
  }

  if (item.nativeAction === "add-sphere") {
    return (
      <mesh position={[0, 0.55, 0]} castShadow receiveShadow>
        <sphereGeometry args={[0.55, 40, 24]} />
        <meshStandardMaterial color="#b9c2cf" roughness={0.5} />
      </mesh>
    );
  }

  return (
    <mesh position={[0, 0.5, 0]} castShadow receiveShadow>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color="#b9c2cf" roughness={0.5} />
    </mesh>
  );
}

export function ModelLibraryPreviewScene({ item, compact = false }: { item: ModelLibraryItem; compact?: boolean }) {
  return (
    <>
      <color attach="background" args={["#111820"]} />
      <ambientLight intensity={1.2} />
      <directionalLight intensity={1.9} position={[3.5, 5, 4]} />
      <directionalLight color="#93d9ff" intensity={0.6} position={[-3, 1.5, -3]} />
      {!compact ? <gridHelper args={[8, 16, "#2d4c60", "#1a2730"]} position={[0, -0.01, 0]} /> : null}
      <Suspense fallback={null}>
        {item.nativeAction ? (
          <CoreModelPreview item={item} />
        ) : (
          <ImportedModel fileName={item.fileName} url={item.url} />
        )}
      </Suspense>
      {!compact ? (
        <OrbitControls enableDamping makeDefault maxDistance={11} minDistance={1.35} target={[0, 0.72, 0]} />
      ) : null}
    </>
  );
}

/** A single lazy Canvas lets users inspect local GLBs without loading every library asset at once. */
export function ModelLibraryPreviewCanvas({ item }: { item: ModelLibraryItem }) {
  const dpr = useResolvedPerformanceConfig().previewDpr;
  return (
    <Canvas
      aria-label={`${item.name} 三维预览`}
      camera={{ fov: 42, position: [3.4, 2.45, 4.15] }}
      className="asset-binding-preview-canvas"
      dpr={dpr}
    >
      <ModelLibraryPreviewScene item={item} />
    </Canvas>
  );
}

export function ModelLibraryPreviewDialog({
  item,
  onAdd,
  onClose,
}: {
  item: ModelLibraryItem;
  onAdd: (item: ModelLibraryItem) => void;
  onClose: () => void;
}) {
  useSuppressViewportChromeWhileMounted("model-library-preview");
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return createPortal(
    <div
      aria-label={`${item.name} 资产预览`}
      className="asset-binding-preview-backdrop"
      onMouseDown={onClose}
      role="presentation"
    >
      <section
        aria-label={`${item.name} 大图预览`}
        aria-modal="true"
        className="asset-binding-preview-dialog model-library-preview-dialog"
        onMouseDown={(event: MouseEvent<HTMLElement>) => event.stopPropagation()}
        role="dialog"
      >
        <header>
          <div>
            <strong data-i18n-user-content>{item.name}</strong>
            <code>{item.fileName}</code>
          </div>
          <div className="model-library-preview-dialog-actions">
            <button
              onClick={() => {
                onAdd(item);
                onClose();
              }}
              type="button"
            >
              添加至场景
            </button>
            <button aria-label={`关闭 ${item.name} 预览`} onClick={onClose} type="button">
              关闭
            </button>
          </div>
        </header>
        <ModelLibraryPreviewCanvas item={item} />
        <p>拖动旋转，滚轮缩放。预览不会修改场景；确认后再添加。</p>
      </section>
    </div>,
    document.body,
  );
}
