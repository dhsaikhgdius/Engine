/**
 * Per-object production reference bindings: prompts, action names, skeleton
 * ids, and mounted 3D assets that describe how an object should be produced or
 * regenerated. Rendered inside the object tree's floating action menu and the
 * inspector. Only portable identifiers are persisted — URLs/data URIs are
 * rejected so scene documents stay shareable.
 */
import {
  Eye,
  EyeOff,
  Link2,
  Maximize2,
  MousePointer2,
  Pencil,
  Plus,
  SlidersHorizontal,
  Trash2,
  Upload,
} from "lucide-react";
import { useMemo, useState } from "react";
import { AssetBindingPreviewDialog, AssetPreviewCanvas } from "../canvas/AssetBindingPreview";
import { readLocalModelFile } from "../loaders/localModelImport";
import { applyEstimatedLocalModelSize } from "../loaders/localModelSize";
import {
  DIRECTOR_REFERENCE_KINDS,
  getPromptReferenceVisualStyle,
  type DirectorAssetRef,
  type DirectorObject,
  type DirectorReferenceBinding,
  type DirectorReferenceKind,
} from "../schema/directorProject";
import { useDirectorStore } from "../store/directorStore";

const UNSAFE_REFERENCE_PREFIX = /^(?:https?:|file:|data:)/i;

function referenceId() {
  return `ref-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function referenceKindLabel(kind: DirectorReferenceKind) {
  return DIRECTOR_REFERENCE_KINDS.find((item) => item.id === kind)?.label ?? kind;
}

/** Collapsible per-object production references.  Only portable identifiers
 * and prompt excerpts are stored; file URLs and binary content stay outside
 * the scene document and never leak through the Director bridge. */
export function ObjectReferenceBindings({ object }: { object: DirectorObject }) {
  const assets = useDirectorStore((state) => state.project.assets);
  const addImportedAsset = useDirectorStore((state) => state.addImportedAsset);
  const selectObject = useDirectorStore((state) => state.selectObject);
  const updateObjectReferenceBindings = useDirectorStore((state) => state.updateObjectReferenceBindings);
  const [kind, setKind] = useState<DirectorReferenceKind>("prompt");
  const [label, setLabel] = useState("");
  const [ref, setRef] = useState("");
  const [error, setError] = useState("");
  const [uploadStatus, setUploadStatus] = useState("");
  const [editingBindingId, setEditingBindingId] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState("");
  const [previewBinding, setPreviewBinding] = useState<{ asset: DirectorAssetRef; label: string } | null>(null);
  const [hoveredAsset, setHoveredAsset] = useState<{ asset: DirectorAssetRef; label: string } | null>(null);
  const [editingPromptVisualId, setEditingPromptVisualId] = useState<string | null>(null);
  const bindings = object.referenceBindings ?? [];
  const automaticReferences = useMemo(() => {
    const rows: Array<{ kind: DirectorReferenceKind; label: string; ref: string }> = [];
    const asset = object.assetRefId ? assets.find((item) => item.id === object.assetRefId) : undefined;
    if (asset) rows.push({ kind: "asset3d", label: "已挂载 3D 资产", ref: asset.fileName });
    if (object.characterRig?.rigType)
      rows.push({ kind: "skeleton", label: "角色骨骼", ref: object.characterRig.rigType });
    if (object.characterRig?.posePresetId)
      rows.push({ kind: "action", label: "当前动作", ref: object.characterRig.posePresetId });
    return rows;
  }, [assets, object.assetRefId, object.characterRig?.posePresetId, object.characterRig?.rigType]);

  function addBinding() {
    const normalizedRef = ref.trim();
    if (!normalizedRef) {
      setError("请填写资产 ID、相对标签或提示词片段。");
      return;
    }
    if (UNSAFE_REFERENCE_PREFIX.test(normalizedRef)) {
      setError("参考请使用资产 ID、相对标签或提示词，不保存 URL 或 data 内容。");
      return;
    }
    if (bindings.length >= 32) {
      setError("每个对象最多绑定 32 项参考。");
      return;
    }
    const nextBinding: DirectorReferenceBinding = {
      id: referenceId(),
      kind,
      label: label.trim() || referenceKindLabel(kind),
      ref: normalizedRef,
    };
    updateObjectReferenceBindings(object.id, [...bindings, nextBinding]);
    setLabel("");
    setRef("");
    setError("");
  }

  function removeBinding(bindingId: string) {
    updateObjectReferenceBindings(
      object.id,
      bindings.filter((item) => item.id !== bindingId),
    );
  }

  function beginRenamingBinding(binding: DirectorReferenceBinding) {
    setEditingBindingId(binding.id);
    setEditingLabel(binding.label);
  }

  function finishRenamingBinding(binding: DirectorReferenceBinding) {
    const nextLabel = editingLabel.trim() || referenceKindLabel(binding.kind);
    updateObjectReferenceBindings(
      object.id,
      bindings.map((item) => (item.id === binding.id ? { ...item, label: nextLabel } : item)),
    );
    setEditingBindingId(null);
    setEditingLabel("");
  }

  function cancelRenamingBinding() {
    setEditingBindingId(null);
    setEditingLabel("");
  }

  function toggleBindingViewport(binding: DirectorReferenceBinding) {
    updateObjectReferenceBindings(
      object.id,
      bindings.map((item) => (item.id === binding.id ? { ...item, showInViewport: !item.showInViewport } : item)),
    );
  }

  function updatePromptVisual(
    binding: DirectorReferenceBinding,
    patch: Partial<NonNullable<DirectorReferenceBinding["promptVisual"]>>,
  ) {
    updateObjectReferenceBindings(
      object.id,
      bindings.map((item) =>
        item.id === binding.id
          ? { ...item, promptVisual: { ...getPromptReferenceVisualStyle(item.promptVisual), ...patch } }
          : item,
      ),
    );
  }

  async function uploadAndBindAsset(file: File) {
    if (bindings.length >= 32) {
      setError("每个对象最多绑定 32 项参考。");
      return;
    }

    try {
      const result = await readLocalModelFile(file);
      const assetId = addImportedAsset({ kind: "prop", ...result, addToScene: false, assetSource: "local" });
      applyEstimatedLocalModelSize(assetId, result.name);
      const nextBinding: DirectorReferenceBinding = {
        id: referenceId(),
        kind: "asset3d",
        label: result.name.slice(0, 120) || referenceKindLabel("asset3d"),
        ref: assetId,
        showInViewport: true,
      };

      updateObjectReferenceBindings(object.id, [...bindings, nextBinding]);
      setError("");
      setUploadStatus(`已上传 ${result.fileName}，并已绑定到 ${object.name}。`);
    } catch (uploadError) {
      setUploadStatus("");
      setError(uploadError instanceof Error ? uploadError.message : "资产上传失败");
    }
  }

  return (
    <section className="object-reference-bindings" aria-label={`${object.name} 参考绑定`}>
      <div className="object-reference-heading">
        <span>
          <Link2 aria-hidden size={15} /> 参考绑定
        </span>
        <small aria-label={`完整对象 ID：${object.id}`} title={`对象 ID：${object.id}`}>
          对象 ID：{object.id}
        </small>
      </div>
      {automaticReferences.length || bindings.length ? (
        <ul className="object-reference-list">
          {automaticReferences.map((item) => (
            <li className="object-reference-item is-automatic" key={`automatic-${item.kind}-${item.ref}`}>
              <span className="object-reference-kind">{referenceKindLabel(item.kind)}</span>
              <span className="object-reference-label" data-i18n-user-content>
                {item.label}
              </span>
              <code>{item.ref}</code>
              <small className="object-reference-status">自动</small>
            </li>
          ))}
          {bindings.map((item) => {
            const bindingAsset = item.kind === "asset3d" ? assets.find((asset) => asset.id === item.ref) : undefined;
            const canPreviewAsset = Boolean(bindingAsset && bindingAsset.sourceType === "model");
            const canVisualize = item.kind === "prompt" || canPreviewAsset;
            const promptVisual = getPromptReferenceVisualStyle(item.promptVisual);

            return (
              <li
                className="object-reference-item"
                key={item.id}
                onMouseEnter={() =>
                  canPreviewAsset && setHoveredAsset({ asset: bindingAsset as DirectorAssetRef, label: item.label })
                }
                onMouseLeave={() =>
                  setHoveredAsset((current) => (current?.asset.id === bindingAsset?.id ? null : current))
                }
              >
                <span className="object-reference-kind">{referenceKindLabel(item.kind)}</span>
                {editingBindingId === item.id ? (
                  <input
                    aria-label={`编辑 ${object.name} 的${item.label}参考名称`}
                    autoFocus
                    className="object-reference-label-input"
                    maxLength={120}
                    onBlur={() => finishRenamingBinding(item)}
                    onChange={(event) => setEditingLabel(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        finishRenamingBinding(item);
                      }
                      if (event.key === "Escape") {
                        event.preventDefault();
                        cancelRenamingBinding();
                      }
                    }}
                    value={editingLabel}
                  />
                ) : (
                  <span className="object-reference-label" data-i18n-user-content>
                    {item.label}
                  </span>
                )}
                <code>{item.ref}</code>
                <div className="object-reference-actions">
                  {canVisualize ? (
                    <button
                      aria-label={`${item.showInViewport ? "从主画面隐藏" : "在主画面显示"} ${object.name} 的${item.label}${item.kind === "prompt" ? "提示词可视化" : "绑定资产"}`}
                      className={item.showInViewport ? "is-active" : undefined}
                      onClick={() => toggleBindingViewport(item)}
                      title={item.showInViewport ? "从主画面隐藏可视化绑定" : "在主画面显示可视化绑定"}
                      type="button"
                    >
                      {item.showInViewport ? <EyeOff aria-hidden size={13} /> : <Eye aria-hidden size={13} />}
                    </button>
                  ) : null}
                  {canVisualize ? (
                    <button
                      aria-label={`在主画面选择 ${object.name} 的${item.label}${item.kind === "prompt" ? "提示词可视化" : "绑定资产"}`}
                      onClick={() => selectObject(object.id)}
                      title="在主画面选择；拖动会带动被绑定对象"
                      type="button"
                    >
                      <MousePointer2 aria-hidden size={13} />
                    </button>
                  ) : null}
                  {canPreviewAsset ? (
                    <button
                      aria-label={`查看 ${object.name} 的${item.label}绑定资产`}
                      onClick={() => setPreviewBinding({ asset: bindingAsset as DirectorAssetRef, label: item.label })}
                      title="打开大图 3D 预览"
                      type="button"
                    >
                      <Maximize2 aria-hidden size={13} />
                    </button>
                  ) : null}
                  {item.kind === "prompt" ? (
                    <button
                      aria-expanded={editingPromptVisualId === item.id}
                      aria-label={`编辑 ${object.name} 的${item.label}提示词可视化样式`}
                      className={editingPromptVisualId === item.id ? "is-active" : undefined}
                      onClick={() => setEditingPromptVisualId((current) => (current === item.id ? null : item.id))}
                      title="编辑提示词可视化样式"
                      type="button"
                    >
                      <SlidersHorizontal aria-hidden size={13} />
                    </button>
                  ) : null}
                  <button
                    aria-label={`重命名 ${object.name} 的${item.label}参考`}
                    onClick={() => beginRenamingBinding(item)}
                    type="button"
                  >
                    <Pencil aria-hidden size={13} />
                  </button>
                  <button
                    aria-label={`移除 ${object.name} 的${item.label}参考`}
                    className="is-danger"
                    onClick={() => removeBinding(item.id)}
                    type="button"
                  >
                    <Trash2 aria-hidden size={14} />
                  </button>
                </div>
                {item.kind === "prompt" && editingPromptVisualId === item.id ? (
                  <div aria-label={`${item.label} 提示词可视化样式`} className="object-reference-prompt-style">
                    <label>
                      字色
                      <input
                        aria-label={`${item.label} 字体颜色`}
                        type="color"
                        value={promptVisual.fontColor}
                        onChange={(event) => updatePromptVisual(item, { fontColor: event.target.value })}
                      />
                    </label>
                    <label>
                      字号
                      <input
                        aria-label={`${item.label} 字体大小`}
                        max={96}
                        min={10}
                        type="number"
                        value={promptVisual.fontSize}
                        onChange={(event) =>
                          updatePromptVisual(item, {
                            fontSize: Math.max(10, Math.min(96, Number(event.target.value) || 10)),
                          })
                        }
                      />
                    </label>
                    <label>
                      宽
                      <input
                        aria-label={`${item.label} 文字框宽度`}
                        max={640}
                        min={80}
                        type="number"
                        value={promptVisual.width}
                        onChange={(event) =>
                          updatePromptVisual(item, {
                            width: Math.max(80, Math.min(640, Number(event.target.value) || 80)),
                          })
                        }
                      />
                    </label>
                    <label>
                      高
                      <input
                        aria-label={`${item.label} 文字框高度`}
                        max={480}
                        min={32}
                        type="number"
                        value={promptVisual.height}
                        onChange={(event) =>
                          updatePromptVisual(item, {
                            height: Math.max(32, Math.min(480, Number(event.target.value) || 32)),
                          })
                        }
                      />
                    </label>
                    <label>
                      填充
                      <input
                        aria-label={`${item.label} 文字框填充颜色`}
                        type="color"
                        value={
                          promptVisual.backgroundColor === "transparent" ? "#000000" : promptVisual.backgroundColor
                        }
                        onChange={(event) => updatePromptVisual(item, { backgroundColor: event.target.value })}
                      />
                    </label>
                    <label>
                      边框
                      <input
                        aria-label={`${item.label} 文字框边框颜色`}
                        type="color"
                        value={promptVisual.borderColor === "transparent" ? "#000000" : promptVisual.borderColor}
                        onChange={(event) => updatePromptVisual(item, { borderColor: event.target.value })}
                      />
                    </label>
                    <button
                      onClick={() =>
                        updatePromptVisual(item, { backgroundColor: "transparent", borderColor: "transparent" })
                      }
                      type="button"
                    >
                      清除填充和边框
                    </button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="object-reference-empty">暂无绑定；可添加提示词、资产、图片、纹理、视频、动作或骨骼参考。</p>
      )}
      <div className="object-reference-add-row">
        <select
          aria-label={`${object.name} 参考类型`}
          onChange={(event) => setKind(event.target.value as DirectorReferenceKind)}
          value={kind}
        >
          {DIRECTOR_REFERENCE_KINDS.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
        <input
          aria-label={`${object.name} 参考名称`}
          maxLength={120}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="名称（可选）"
          value={label}
        />
        <input
          aria-label={`${object.name} 参考内容`}
          maxLength={256}
          onChange={(event) => setRef(event.target.value)}
          placeholder="资产 ID、相对标签或提示词"
          value={ref}
        />
        <label className="object-reference-upload">
          <Upload aria-hidden size={14} /> 上传资产
          <input
            aria-label={`上传 ${object.name} 绑定资产`}
            accept=".fbx,.obj,.glb,.gltf,.ply,.splat,.ksplat,.spz,.sog,.zip"
            type="file"
            onChange={async (event) => {
              const input = event.currentTarget;
              const file = input.files?.[0];
              if (!file) return;
              await uploadAndBindAsset(file);
              input.value = "";
            }}
          />
        </label>
        <button
          aria-label={`添加 ${object.name} 参考`}
          className="object-reference-add"
          onClick={addBinding}
          type="button"
        >
          <Plus aria-hidden size={16} /> 添加
        </button>
      </div>
      {uploadStatus ? (
        <p className="object-reference-upload-status" role="status">
          {uploadStatus}
        </p>
      ) : null}
      {error ? (
        <p className="object-reference-error" role="status">
          {error}
        </p>
      ) : null}
      {hoveredAsset ? (
        <div aria-label={`${hoveredAsset.label} 悬停预览`} className="object-reference-hover-preview" role="status">
          <strong data-i18n-user-content>{hoveredAsset.label}</strong>
          <code>{hoveredAsset.asset.fileName}</code>
          <AssetPreviewCanvas asset={hoveredAsset.asset} />
          <span>悬停预览 · 点击 ⛶ 打开大窗口</span>
        </div>
      ) : null}
      {previewBinding ? (
        <AssetBindingPreviewDialog
          asset={previewBinding.asset}
          bindingLabel={previewBinding.label}
          onClose={() => setPreviewBinding(null)}
        />
      ) : null}
    </section>
  );
}
