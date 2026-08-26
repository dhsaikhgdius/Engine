import "./assetLibrary.css";
import { Boxes, Globe, ImagePlus, Move3D, ScanLine, ScanSearch, Sparkles, Upload } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { readLocalModelFile } from "../loaders/localModelImport";
import { applyEstimatedLocalModelSize } from "../loaders/localModelSize";
import { readPanoramaFile } from "../loaders/panoramaImport";
import { readTextureFile } from "../loaders/textureImport";
import { FLICK_HUMAN_DEFAULT_COLOR } from "../schema/flickHumanAppearance";
import { ModelLibraryPreviewDialog } from "../canvas/ModelLibraryPreview";
import { loadLocalFlickStageCatalog } from "../modelLibrary/flickPublicCatalog";
import { loadLocalMixamoCharacterCatalog } from "../modelLibrary/mixamoCharacterCatalog";
import { getModelLibraryItemSizeM } from "@director/dcc-interchange";
import {
  FLICK_STANDARD_CATEGORIES,
  filterModelLibraryItems,
  getFlickNativeModelLibraryItems,
  type FlickStandardCategoryId,
  type ModelLibraryItem,
} from "../modelLibrary/modelLibraryCatalog";
import { useDirectorStore } from "../store/directorStore";
import { ReferenceSceneReconstructionDialog } from "../reconstruction/ReferenceSceneReconstructionDialog";
import { CaptureReconstructionDialog } from "../reconstruction/CaptureReconstructionDialog";
import { ProceduralToolsDialog } from "../procedural/ProceduralToolsDialog";
import { Generated3DDialog } from "../generated3d/Generated3DDialog";
import { applyDirectorPageEvent } from "../assistant/pageStateBridge";
import { getDirectorObjectFocusSnapshot } from "../canvas/viewportObjectFocus";
import { VirtualizedAssetGrid } from "./VirtualizedAssetGrid";

const FLICK_NATIVE_ITEMS = getFlickNativeModelLibraryItems();

function useLocalCatalog(load: () => Promise<ModelLibraryItem[]>, fallbackError: string) {
  const [state, setState] = useState<{
    items: ModelLibraryItem[];
    status: "loading" | "ready" | "error";
    error: string | null;
  }>({ items: [], status: "loading", error: null });
  useEffect(() => {
    let cancelled = false;
    void load().then(
      (items) => !cancelled && setState({ items, status: "ready", error: null }),
      (error) =>
        !cancelled &&
        setState({ items: [], status: "error", error: error instanceof Error ? error.message : fallbackError }),
    );
    return () => {
      cancelled = true;
    };
  }, [fallbackError, load]);
  return state;
}

/** The side-panel library deliberately exposes the locally mirrored Stage categories only. */
export function AssetLibraryPanel() {
  const sceneImportRef = useRef<HTMLInputElement>(null);
  const panoramaImportRef = useRef<HTMLInputElement>(null);
  const textureImportRef = useRef<HTMLInputElement>(null);
  const [activeCategoryId, setActiveCategoryId] = useState<FlickStandardCategoryId>("all");
  const {
    items: flickItems,
    status: flickStatus,
    error: flickError,
  } = useLocalCatalog(loadLocalFlickStageCatalog, "本地模型目录读取失败");
  const {
    items: characterItems,
    status: characterStatus,
    error: characterError,
  } = useLocalCatalog(loadLocalMixamoCharacterCatalog, "人物目录读取失败");
  const [importError, setImportError] = useState<string | null>(null);
  const [importNotice, setImportNotice] = useState<string | null>(null);
  const [reconstructionOpen, setReconstructionOpen] = useState(false);
  const [captureReconstructionOpen, setCaptureReconstructionOpen] = useState(false);
  const [proceduralOpen, setProceduralOpen] = useState(false);
  const [generated3dOpen, setGenerated3dOpen] = useState(false);
  const [previewItem, setPreviewItem] = useState<ModelLibraryItem | null>(null);
  const projectAssets = useDirectorStore((state) => state.project.assets);
  const addImportedAsset = useDirectorStore((state) => state.addImportedAsset);
  const addObjectFromAsset = useDirectorStore((state) => state.addObjectFromAsset);
  const addPresetCharacter = useDirectorStore((state) => state.addPresetCharacter);
  const addCameraShot = useDirectorStore((state) => state.addCameraShot);
  const addGeometryPrimitive = useDirectorStore((state) => state.addGeometryPrimitive);

  const focusSelectedObjectInViewport = useCallback(() => {
    const state = useDirectorStore.getState();
    const objectId = state.selectedObjectId;
    if (!objectId) return;
    const snapshot = getDirectorObjectFocusSnapshot(state.project, [objectId]);
    if (!snapshot) return;
    applyDirectorPageEvent({
      sequence: Date.now(),
      sceneId: "asset-library",
      revision: Date.now(),
      tabId: "director-workbench",
      createdAt: new Date().toISOString(),
      state: { viewportCamera: snapshot },
    });
  }, []);

  const generatedItems = useMemo<ModelLibraryItem[]>(
    () =>
      projectAssets.flatMap((asset) =>
        asset.assetSource === "generated" && asset.sourceType === "model" && asset.kind !== "panorama"
          ? [
              {
                id: asset.id,
                assetSource: "generated",
                categoryId: "flick",
                fileName: asset.fileName,
                flickCategory: "other",
                kind: asset.kind,
                name: asset.name ?? asset.fileName.replace(/\.[^.]+$/, ""),
                thumbnailKind: "image",
                thumbnailUrl: asset.thumbnailUrl,
                url: asset.url,
              } satisfies ModelLibraryItem,
            ]
          : [],
      ),
    [projectAssets],
  );

  const activeItems = useMemo(() => {
    return filterModelLibraryItems(
      [...generatedItems, ...FLICK_NATIVE_ITEMS, ...characterItems, ...flickItems],
      activeCategoryId,
      "",
    );
  }, [activeCategoryId, characterItems, flickItems, generatedItems]);

  const catalogUnavailable = flickStatus === "error" && characterStatus === "error";
  const catalogReady = flickStatus === "ready" || characterStatus === "ready";
  const localItemCount = flickItems.length + characterItems.length;

  async function importModels(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const files = Array.from(input.files ?? []);
    if (!files.length) return;
    setImportError(null);
    setImportNotice(null);
    try {
      for (const file of files) {
        const result = await readLocalModelFile(file);
        const assetId = addImportedAsset({ kind: "prop", ...result, assetSource: "local" });
        applyEstimatedLocalModelSize(assetId, result.name);
        focusSelectedObjectInViewport();
      }
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "本地模型导入失败");
    } finally {
      input.value = "";
    }
  }

  async function importPanorama(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    setImportError(null);
    setImportNotice(null);
    try {
      const result = await readPanoramaFile(file);
      addImportedAsset({ kind: "panorama", ...result });
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "全景图导入失败");
    } finally {
      input.value = "";
    }
  }

  async function importTextures(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const files = Array.from(input.files ?? []);
    if (!files.length) return;
    setImportError(null);
    setImportNotice(null);
    try {
      for (const file of files) {
        const result = await readTextureFile(file);
        addImportedAsset({
          kind: "prop",
          sourceType: "image",
          addToScene: false,
          assetSource: "local",
          ...result,
        });
      }
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "材质贴图导入失败");
    } finally {
      input.value = "";
    }
  }

  const addLibraryItem = useCallback(
    (item: ModelLibraryItem) => {
      if (item.nativeAction === "add-human") {
        addPresetCharacter(undefined, FLICK_HUMAN_DEFAULT_COLOR);
        focusSelectedObjectInViewport();
        return;
      }
      if (item.nativeAction === "add-camera") {
        addCameraShot();
        return;
      }
      if (item.nativeAction === "add-cube") {
        addGeometryPrimitive("box");
        focusSelectedObjectInViewport();
        return;
      }
      if (item.nativeAction === "add-sphere") {
        addGeometryPrimitive("sphere");
        focusSelectedObjectInViewport();
        return;
      }

      const existingAsset = useDirectorStore
        .getState()
        .project.assets.find(
          (asset) =>
            asset.sourceType === "model" &&
            asset.assetSource === (item.assetSource ?? "library") &&
            asset.kind === (item.kind ?? "prop") &&
            asset.url === item.url,
        );
      if (existingAsset) {
        addObjectFromAsset(existingAsset.id);
        focusSelectedObjectInViewport();
        return;
      }

      const catalogSizeM = getModelLibraryItemSizeM(item);
      addImportedAsset({
        id: item.id,
        kind: item.kind ?? "prop",
        assetSource: "library",
        fileName: item.fileName,
        name: item.name,
        url: item.url,
        characterMetadata: item.characterMetadata,
        realWorldSizeM: catalogSizeM,
        sizeSource: catalogSizeM === undefined ? undefined : "catalog",
      });
      focusSelectedObjectInViewport();
    },
    [
      addCameraShot,
      addGeometryPrimitive,
      addImportedAsset,
      addObjectFromAsset,
      addPresetCharacter,
      focusSelectedObjectInViewport,
    ],
  );

  return (
    <section className="asset-library-panel" aria-label="模型库">
      <header className="asset-library-header">
        <div>
          <strong>模型库</strong>
          <small>{catalogReady ? `本地 ${localItemCount} 个组件` : "读取本地组件"}</small>
        </div>
      </header>

      <div className="asset-library-imports" aria-label="资源导入">
        <div className="asset-library-tool-group">
          <h3>导入</h3>
          <div className="asset-library-action-cluster">
            <label className="asset-library-import-action" title="导入模型">
              <Upload aria-hidden size={13} strokeWidth={1.75} />
              <span>模型</span>
              <input
                aria-label="从右侧导入本地模型"
                accept=".fbx,.obj,.glb,.gltf,.ply,.splat,.ksplat,.spz,.sog,.zip"
                multiple
                ref={sceneImportRef}
                type="file"
                onChange={(event) => void importModels(event)}
              />
            </label>
            <label className="asset-library-import-action" title="导入贴图">
              <ImagePlus aria-hidden size={13} strokeWidth={1.75} />
              <span>贴图</span>
              <input
                aria-label="从右侧导入材质贴图"
                accept=".jpg,.jpeg,.png,.webp,.avif"
                multiple
                ref={textureImportRef}
                type="file"
                onChange={(event) => void importTextures(event)}
              />
            </label>
            <label className="asset-library-import-action" title="导入全景">
              <Globe aria-hidden size={13} strokeWidth={1.75} />
              <span>全景图</span>
              <input
                aria-label="从右侧导入全景图"
                accept=".jpg,.jpeg,.png,.webp"
                ref={panoramaImportRef}
                type="file"
                onChange={(event) => void importPanorama(event)}
              />
            </label>
          </div>
        </div>
        <div className="asset-library-tool-group">
          <h3>生成</h3>
          <div className="asset-library-action-cluster">
            <button
              aria-label="打开 AI 生成 3D"
              className="asset-library-import-action"
              title="AI 生成 3D"
              onClick={() => setGenerated3dOpen(true)}
              type="button"
            >
              <Sparkles aria-hidden size={13} strokeWidth={1.75} />
              <span>AI 3D</span>
            </button>
            <button
              aria-label="从参考图重建场景"
              className="asset-library-import-action"
              title="参考图重建"
              onClick={() => setReconstructionOpen(true)}
              type="button"
            >
              <ScanSearch aria-hidden size={13} strokeWidth={1.75} />
              <span>重建</span>
            </button>
            <button
              aria-label="从视频或扫描重建场景"
              className="asset-library-import-action"
              title="视频 / 扫描重建"
              onClick={() => setCaptureReconstructionOpen(true)}
              type="button"
            >
              <ScanLine aria-hidden size={13} strokeWidth={1.75} />
              <span>扫描</span>
            </button>
            <button
              aria-label="打开程序化建模"
              className="asset-library-import-action"
              title="程序化建模"
              onClick={() => setProceduralOpen(true)}
              type="button"
            >
              <Boxes aria-hidden size={13} strokeWidth={1.75} />
              <span>程序化</span>
            </button>
          </div>
        </div>
        {importError ? (
          <p className="asset-library-error" role="status">
            {importError}
          </p>
        ) : null}
        {importNotice ? (
          <p className="asset-library-notice" role="status">
            {importNotice}
          </p>
        ) : null}
      </div>

      <div className="asset-library-browser">
        <div className="model-library-tabs asset-library-tabs" role="tablist" aria-label="模型分类">
          {FLICK_STANDARD_CATEGORIES.map((category) => {
            const active = category.id === activeCategoryId;
            return (
              <button
                key={category.id}
                aria-selected={active}
                className={`model-library-tab${active ? " is-active" : ""}`}
                role="tab"
                type="button"
                onClick={() => setActiveCategoryId(category.id)}
              >
                {category.label}
              </button>
            );
          })}
        </div>

        <div className="asset-library-placement-hint" role="note">
          <Move3D aria-hidden size={13} strokeWidth={1.9} />
          <span>拖入场景直接放置</span>
          <small>单击可预览</small>
        </div>

        {catalogUnavailable ? (
          <div className="model-library-empty-state asset-library-empty-state" role="status">
            <span>本地模型目录不可用</span>
            <small>{[flickError, characterError].filter(Boolean).join("；") || "请检查人物资源后重试。"}</small>
          </div>
        ) : (
          <VirtualizedAssetGrid items={activeItems} onAdd={addLibraryItem} onPreview={setPreviewItem} />
        )}
      </div>
      {previewItem ? (
        <ModelLibraryPreviewDialog item={previewItem} onAdd={addLibraryItem} onClose={() => setPreviewItem(null)} />
      ) : null}
      {reconstructionOpen ? (
        <ReferenceSceneReconstructionDialog
          onApplied={(message) => {
            setImportError(null);
            setImportNotice(message);
          }}
          onClose={() => setReconstructionOpen(false)}
        />
      ) : null}
      {captureReconstructionOpen ? (
        <CaptureReconstructionDialog
          onApplied={(message) => {
            setImportError(null);
            setImportNotice(message);
          }}
          onClose={() => setCaptureReconstructionOpen(false)}
        />
      ) : null}
      {proceduralOpen ? (
        <ProceduralToolsDialog
          onApplied={(message) => {
            setImportError(null);
            setImportNotice(message);
          }}
          onClose={() => setProceduralOpen(false)}
        />
      ) : null}
      {generated3dOpen ? (
        <Generated3DDialog
          onClose={() => setGenerated3dOpen(false)}
          onPromoted={(message) => {
            setImportError(null);
            setImportNotice(message);
          }}
        />
      ) : null}
    </section>
  );
}
