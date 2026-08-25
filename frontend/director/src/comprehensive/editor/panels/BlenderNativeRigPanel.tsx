/**
 * 原生骨架面板，用于检查和编辑 Blender 原生骨架的姿势、骨骼、Action 和 NLA 轨道。
 *
 * @module native-rig-panel
 */

import { KeyRound, RefreshCw, RotateCcw, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  BlenderAgentOperation,
  BlenderEffectReceipt,
  BlenderLiveSceneSnapshot,
  BlenderObjectInspection,
} from "../../../../../../packages/protocol/src/blenderLiveProtocol";
import { useLanguage } from "../../i18n/language";
import {
  inspectBlenderLiveObject,
  BlenderLiveClientError,
  blenderAddNlaStripOperation,
  blenderCreateActionOperation,
  blenderCreateNlaTrackOperation,
  blenderDeletePoseKeyframesOperation,
  blenderImportMixamoActionOperation,
  blenderInsertPoseKeyframesOperation,
  blenderRemoveNlaStripOperation,
  blenderSelectPoseBonesOperation,
  blenderSetActiveActionOperation,
  blenderSetPoseBoneTransformOperation,
  blenderSetSceneFrameOperation,
  blenderUpdateNlaStripOperation,
  type BlenderKeyframeInterpolation,
  type BlenderMixamoRootMotion,
  type BlenderNlaBlendMode,
  type BlenderPoseChannel,
} from "../api/blenderLiveClient";
import { DIRECTOR_CHARACTER_MOTION_CATALOG } from "@director/agent-engine/character-motions";
import { useBlenderRuntimeStore } from "../runtime/blenderRuntimeStore";
import { applyBlenderRuntimeOperations } from "../runtime/blenderRuntimeTransactions";
import { useDirectorStore } from "../store/directorStore";
import { InspectorPanel, InspectorSection } from "./InspectorControls";
import "./blenderNativeRigPanel.css";

type RigInspection = BlenderObjectInspection & {
  rig: NonNullable<BlenderObjectInspection["rig"]>;
};

type RigContext = {
  rootObjectId: string;
  sceneEpoch: string;
  revision: number;
  frame: number;
  inspection: RigInspection;
};

type PoseTransform = RigInspection["rig"]["bones"][number]["local"];

const IDENTITY_POSE: PoseTransform = {
  location: [0, 0, 0],
  rotationQuaternion: [1, 0, 0, 0],
  scale: [1, 1, 1],
};

const NLA_BLEND_MODES = ["REPLACE", "ADD", "COMBINE"] as const satisfies readonly BlenderNlaBlendMode[];

type NlaStripDraft = {
  trackName: string;
  stripName: string;
  actionName: string;
  startFrame: number;
  blendMode: BlenderNlaBlendMode;
  influence: number;
  repeat: number;
};

function isSceneIdentityConflict(error: unknown) {
  return (
    error instanceof BlenderLiveClientError &&
    (error.status === 409 || error.code === "scene_epoch_conflict" || error.code === "revision_conflict")
  );
}

function isRigInspection(inspection: BlenderObjectInspection): inspection is RigInspection {
  return inspection.type === "ARMATURE" && inspection.rig !== undefined;
}

function normalizeQuaternion(value: [number, number, number, number]): [number, number, number, number] {
  const magnitude = Math.hypot(...value);
  if (magnitude < 1e-8) return [1, 0, 0, 0];
  const normalized = value.map((component) => component / magnitude) as [number, number, number, number];
  if (normalized[0] < 0) {
    return normalized.map((component) => {
      const flipped = -component;
      return Object.is(flipped, -0) ? 0 : flipped;
    }) as typeof normalized;
  }
  return normalized.map((component) => (Object.is(component, -0) ? 0 : component)) as typeof normalized;
}

function boneDepth(boneRef: string, parents: Map<string, string | null>) {
  let depth = 0;
  let parentRef = parents.get(boneRef) ?? null;
  while (parentRef && parents.has(parentRef)) {
    depth += 1;
    parentRef = parents.get(parentRef) ?? null;
  }
  return depth;
}

function parseNumber(value: string, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * 为选中的 Blender 原生骨架渲染完整的 Rig 检查面板，包括骨骼树、姿势编辑、Action 管理和 NLA 轨道。
 * 当对象不是原生骨架时，回退渲染为 {fallback}。
 */
export function BlenderNativeRigPanel({ fallback }: { fallback: ReactNode }) {
  const { locale, t } = useLanguage();
  const selectedDirectorObject = useDirectorStore((state) => {
    const selected = state.project.objects.find((object) => object.id === state.selectedObjectId);
    return selected?.nativeSource?.engine === "blender" ? selected : null;
  });
  const selectedNativeObjectId = selectedDirectorObject?.nativeSource?.objectId ?? null;
  const usesDirectorCharacterPanel = selectedDirectorObject?.kind === "character";
  const runtimeScene = useBlenderRuntimeStore((state) => state.snapshot);
  const publishNativeRigCapability = useBlenderRuntimeStore((state) => state.publishNativeRigCapability);
  const requestRuntimeRefresh = useBlenderRuntimeStore((state) => state.requestRefresh);
  const [context, setContext] = useState<RigContext | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [receipt, setReceipt] = useState<BlenderEffectReceipt | null>(null);
  const [search, setSearch] = useState("");
  const [poseDraft, setPoseDraft] = useState<PoseTransform>(IDENTITY_POSE);
  const [actionName, setActionName] = useState("");
  const [motionId, setMotionId] = useState(DIRECTOR_CHARACTER_MOTION_CATALOG[0]?.id ?? "");
  const [rootMotion, setRootMotion] = useState<BlenderMixamoRootMotion>("IN_PLACE");
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [nlaTrackName, setNlaTrackName] = useState("");
  const [nlaStripDraft, setNlaStripDraft] = useState<NlaStripDraft>({
    trackName: "",
    stripName: "",
    actionName: "",
    startFrame: 1,
    blendMode: "REPLACE",
    influence: 1,
    repeat: 1,
  });
  const [frameDraft, setFrameDraft] = useState(1);
  const [channels, setChannels] = useState<BlenderPoseChannel[]>(["LOCATION", "ROTATION", "SCALE"]);
  const [interpolation, setInterpolation] = useState<BlenderKeyframeInterpolation>("BEZIER");
  const busyRef = useRef(false);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    if (!selectedNativeObjectId || usesDirectorCharacterPanel) return;
    publishNativeRigCapability({
      rootObjectId: selectedNativeObjectId,
      status: "checking",
      compatible: false,
      missingBoneRoles: [],
      mappedBoneCount: 0,
    });
  }, [publishNativeRigCapability, selectedNativeObjectId, usesDirectorCharacterPanel]);

  const readBoundContext = useCallback(
    async (
      scene: BlenderLiveSceneSnapshot,
      signal?: AbortSignal,
      expectedRevision = scene.revision,
      frame = scene.frame,
    ): Promise<RigContext | null> => {
      if (!selectedNativeObjectId || usesDirectorCharacterPanel) return null;
      const objectsById = new Map(scene.objects.map((object) => [object.id, object]));
      const belongsToSelectedRoot = (objectId: string) => {
        let current = objectsById.get(objectId);
        while (current) {
          if (current.id === selectedNativeObjectId) return true;
          current = current.parentId ? objectsById.get(current.parentId) : undefined;
        }
        return false;
      };
      const activeObject =
        scene.objects.find(
          (object) =>
            object.id === scene.activeObjectId && object.type === "ARMATURE" && belongsToSelectedRoot(object.id),
        ) ?? scene.objects.find((object) => object.type === "ARMATURE" && belongsToSelectedRoot(object.id));
      if (activeObject?.type !== "ARMATURE") return null;
      const result = await inspectBlenderLiveObject(activeObject.id, {
        expectedSceneEpoch: scene.sceneEpoch,
        expectedRevision,
        signal,
      });
      return isRigInspection(result.inspection)
        ? {
            rootObjectId: selectedNativeObjectId,
            sceneEpoch: scene.sceneEpoch,
            revision: expectedRevision,
            frame,
            inspection: result.inspection,
          }
        : null;
    },
    [selectedNativeObjectId, usesDirectorCharacterPanel],
  );

  const refresh = useCallback(
    async (scene: BlenderLiveSceneSnapshot, signal?: AbortSignal) => {
      if (busyRef.current) return;
      try {
        const next = await readBoundContext(scene, signal);
        if (!signal?.aborted) {
          setContext(next);
          setMessage("");
          const compatibility = next?.inspection.rig.mixamoCompatibility;
          publishNativeRigCapability({
            rootObjectId: selectedNativeObjectId!,
            status: compatibility?.compatible ? "ready" : "unsupported",
            compatible: compatibility?.compatible === true,
            reason: next
              ? compatibility
                ? compatibility.compatible
                  ? undefined
                  : t("Blender 骨架缺少 Director 角色所需的标准骨骼。")
                : t("Blender 骨架未报告角色兼容性。")
              : t("所选 Blender 资产中未找到骨架。"),
            missingBoneRoles: compatibility?.missingBoneRoles ?? [],
            mappedBoneCount: compatibility?.mappedBoneCount ?? 0,
            sceneEpoch: next?.sceneEpoch,
            revision: next?.revision,
            inspection: next?.inspection,
          });
        }
      } catch (error) {
        if (!signal?.aborted) {
          if (isSceneIdentityConflict(error)) requestRuntimeRefresh();
          const reason = error instanceof Error ? error.message : String(error);
          setMessage(reason);
          publishNativeRigCapability({
            rootObjectId: selectedNativeObjectId!,
            status: "error",
            compatible: false,
            reason,
            missingBoneRoles: [],
            mappedBoneCount: 0,
          });
        }
      }
    },
    [publishNativeRigCapability, readBoundContext, requestRuntimeRefresh, selectedNativeObjectId, t],
  );

  useEffect(() => {
    if (usesDirectorCharacterPanel) {
      setContext(null);
      return;
    }
    if (!runtimeScene) {
      setContext(null);
      return;
    }
    const controller = new AbortController();
    void refresh(runtimeScene, controller.signal);
    return () => {
      controller.abort();
    };
  }, [refresh, runtimeScene, usesDirectorCharacterPanel]);

  const activeBone = useMemo(() => {
    const activeBoneRef = context?.inspection.rig.activeBoneRef;
    return context?.inspection.rig.bones.find((bone) => bone.boneRef === activeBoneRef) ?? null;
  }, [context]);

  useEffect(() => {
    if (activeBone) setPoseDraft(activeBone.local);
  }, [activeBone]);

  const inspectedSceneFrame = context?.frame;
  useEffect(() => {
    if (inspectedSceneFrame !== undefined) setFrameDraft(inspectedSceneFrame);
  }, [inspectedSceneFrame]);

  async function apply(label: string, operations: BlenderAgentOperation[]) {
    if (!context || operations.length === 0) return null;
    setBusy(true);
    setMessage(`${label}…`);
    try {
      const result = await applyBlenderRuntimeOperations({
        expectedSceneEpoch: context.sceneEpoch,
        expectedRevision: context.revision,
        operations,
      });
      const frameOperation = operations.find((operation) => operation.op === "set_scene_frame");
      const transactionScene = result.projectedSnapshot ?? runtimeScene;
      const next = transactionScene
        ? await readBoundContext(
            transactionScene,
            undefined,
            result.receipt.revisionAfter,
            frameOperation?.op === "set_scene_frame" ? frameOperation.frame : context.frame,
          )
        : null;
      if (next) setContext(next);
      setReceipt(result.receipt);
      setMessage(`${label} · ${t("完成")} · rev ${result.receipt.revisionAfter}`);
      return result.receipt;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      setBusy(false);
    }
  }

  const rig = context?.inspection.rig;
  const selectedBoneRefs = useMemo(() => rig?.selectedBoneRefs ?? [], [rig?.selectedBoneRefs]);
  const selectedBoneSet = useMemo(() => new Set(selectedBoneRefs), [selectedBoneRefs]);
  const parentByBoneRef = useMemo(
    () => new Map(rig?.bones.map((bone) => [bone.boneRef, bone.parentRef]) ?? []),
    [rig?.bones],
  );
  const visibleBones = useMemo(() => {
    if (!rig) return [];
    const query = search.trim().toLocaleLowerCase();
    if (!query) return rig.bones;
    const visibleRefs = new Set<string>();
    for (const bone of rig.bones) {
      if (!bone.boneRef.toLocaleLowerCase().includes(query)) continue;
      let boneRef: string | null = bone.boneRef;
      while (boneRef) {
        visibleRefs.add(boneRef);
        boneRef = parentByBoneRef.get(boneRef) ?? null;
      }
    }
    return rig.bones.filter((bone) => visibleRefs.has(bone.boneRef));
  }, [parentByBoneRef, rig, search]);
  const activeAction = context?.inspection.animation.activeAction;
  const nlaTracks = context?.inspection.animation.nlaTracks ?? [];
  const firstNlaTrackName = nlaTracks[0]?.name ?? "";
  const firstActionName = context?.inspection.animation.actions[0]?.actionName ?? "";
  const keyedBoneRefs = selectedBoneRefs.length ? selectedBoneRefs : rig?.activeBoneRef ? [rig.activeBoneRef] : [];

  useEffect(() => {
    setNlaStripDraft((current) => ({
      ...current,
      trackName: current.trackName || firstNlaTrackName,
      actionName: current.actionName || firstActionName,
    }));
  }, [firstActionName, firstNlaTrackName]);

  function updatePoseVector(field: "location" | "scale", index: 0 | 1 | 2, value: string) {
    setPoseDraft((current) => {
      const next = [...current[field]] as [number, number, number];
      next[index] = parseNumber(value, current[field][index]);
      return { ...current, [field]: next };
    });
  }

  function updateQuaternion(index: 0 | 1 | 2 | 3, value: string) {
    setPoseDraft((current) => {
      const next = [...current.rotationQuaternion] as [number, number, number, number];
      next[index] = parseNumber(value, current.rotationQuaternion[index]);
      return { ...current, rotationQuaternion: next };
    });
  }

  function toggleChannel(channel: BlenderPoseChannel) {
    setChannels((current) =>
      current.includes(channel) ? current.filter((entry) => entry !== channel) : [...current, channel],
    );
  }

  function updateNlaStrip(form: HTMLFormElement, trackName: string, stripName: string) {
    const fields = new FormData(form);
    void apply(t("更新 NLA Strip"), [
      blenderUpdateNlaStripOperation({
        objectId: context!.inspection.id,
        trackName,
        stripName,
        blendMode: String(fields.get("blendMode")) as BlenderNlaBlendMode,
        influence: Number(fields.get("influence")),
        repeat: Number(fields.get("repeat")),
      }),
    ]);
  }

  if (
    !context ||
    context.rootObjectId !== selectedNativeObjectId ||
    !rig ||
    selectedDirectorObject?.kind === "character"
  ) {
    return fallback;
  }

  return (
    <>
      {fallback}
      <InspectorPanel title="Rig" ariaLabel={t("骨骼属性面板")} className="native-rig-inspector">
        <div className="native-rig-summary">
          <div>
            <strong data-i18n-user-content>{context.inspection.name}</strong>
            <small>
              {rig.boneCount} {t("根骨骼")} · {rig.deformBoneCount} {t("变形骨骼")}
            </small>
          </div>
          <button
            aria-label={t("刷新 Rig")}
            disabled={busy}
            onClick={() => {
              requestRuntimeRefresh();
              if (runtimeScene) void refresh(runtimeScene);
            }}
            type="button"
          >
            <RefreshCw aria-hidden size={13} />
          </button>
        </div>

        <InspectorSection title={t("骨骼")} className="native-rig-bones-section">
          <label className="native-rig-search">
            <Search aria-hidden size={13} />
            <input
              aria-label={t("搜索骨骼")}
              onChange={(event) => setSearch(event.currentTarget.value)}
              placeholder={t("按名称筛选")}
              type="search"
              value={search}
            />
          </label>
          <div className="native-rig-selection-bar">
            <small>
              {selectedBoneRefs.length} / {rig.boneCount} {t("已选")}
            </small>
            <div>
              <button
                disabled={busy || rig.bones.length === 0}
                onClick={() =>
                  void apply(t("全选骨骼"), [
                    blenderSelectPoseBonesOperation({ objectId: context.inspection.id, action: "ALL" }),
                  ])
                }
                type="button"
              >
                {t("全选")}
              </button>
              <button
                disabled={busy || selectedBoneRefs.length === 0}
                onClick={() =>
                  void apply(t("取消选择骨骼"), [
                    blenderSelectPoseBonesOperation({ objectId: context.inspection.id, action: "NONE" }),
                  ])
                }
                type="button"
              >
                {t("全不选")}
              </button>
            </div>
          </div>
          <div aria-label={t("骨骼树")} className="native-rig-bone-tree" role="tree">
            {visibleBones.map((bone) => {
              const selected = selectedBoneSet.has(bone.boneRef);
              const active = rig.activeBoneRef === bone.boneRef;
              return (
                <div
                  aria-selected={selected}
                  className={`native-rig-bone-row${active ? " is-active" : ""}`}
                  key={bone.boneRef}
                  role="treeitem"
                  style={{ paddingInlineStart: 8 + boneDepth(bone.boneRef, parentByBoneRef) * 12 }}
                >
                  <input
                    aria-label={`${selected ? t("取消选择") : t("选择")} ${bone.boneRef}`}
                    checked={selected}
                    disabled={busy}
                    onChange={(event) =>
                      void apply(event.currentTarget.checked ? t("添加骨骼选择") : t("移除骨骼选择"), [
                        blenderSelectPoseBonesOperation({
                          objectId: context.inspection.id,
                          boneRefs: [bone.boneRef],
                          ...(event.currentTarget.checked ? { activeBoneRef: bone.boneRef } : {}),
                          action: event.currentTarget.checked ? "ADD" : "SUBTRACT",
                        }),
                      ])
                    }
                    type="checkbox"
                  />
                  <button
                    aria-current={active ? "true" : undefined}
                    data-i18n-user-content
                    disabled={busy}
                    onClick={() =>
                      void apply(t("设置活动骨骼"), [
                        blenderSelectPoseBonesOperation({
                          objectId: context.inspection.id,
                          boneRefs: [bone.boneRef],
                          activeBoneRef: bone.boneRef,
                          action: "SET",
                        }),
                      ])
                    }
                    type="button"
                  >
                    {bone.boneRef}
                  </button>
                  {bone.deform ? <small>{t("变形")}</small> : null}
                </div>
              );
            })}
          </div>
        </InspectorSection>

        <InspectorSection title={t("姿势")} className="native-rig-pose-section">
          {activeBone ? (
            <>
              <div className="native-rig-active-bone">
                <span>{t("活动骨骼")}</span>
                <strong data-i18n-user-content>{activeBone.boneRef}</strong>
              </div>
              <div className="native-rig-transform-group">
                <span>{t("本地位置")}</span>
                <div className="native-rig-vector-grid">
                  {(["X", "Y", "Z"] as const).map((axis, index) => (
                    <label key={axis}>
                      <span>{axis}</span>
                      <input
                        aria-label={`${t("本地位置")} ${axis}`}
                        onChange={(event) =>
                          updatePoseVector("location", index as 0 | 1 | 2, event.currentTarget.value)
                        }
                        step="0.01"
                        type="number"
                        value={poseDraft.location[index]}
                      />
                    </label>
                  ))}
                </div>
              </div>
              <div className="native-rig-transform-group">
                <span>{t("本地旋转四元数")}</span>
                <div className="native-rig-quaternion-grid">
                  {(["W", "X", "Y", "Z"] as const).map((axis, index) => (
                    <label key={axis}>
                      <span>{axis}</span>
                      <input
                        aria-label={`${t("本地旋转四元数")} ${axis}`}
                        onChange={(event) => updateQuaternion(index as 0 | 1 | 2 | 3, event.currentTarget.value)}
                        step="0.001"
                        type="number"
                        value={poseDraft.rotationQuaternion[index]}
                      />
                    </label>
                  ))}
                </div>
              </div>
              <div className="native-rig-transform-group">
                <span>{t("本地缩放")}</span>
                <div className="native-rig-vector-grid">
                  {(["X", "Y", "Z"] as const).map((axis, index) => (
                    <label key={axis}>
                      <span>{axis}</span>
                      <input
                        aria-label={`${t("本地缩放")} ${axis}`}
                        onChange={(event) => updatePoseVector("scale", index as 0 | 1 | 2, event.currentTarget.value)}
                        step="0.01"
                        type="number"
                        value={poseDraft.scale[index]}
                      />
                    </label>
                  ))}
                </div>
              </div>
              <div className="native-rig-pose-actions">
                <button
                  disabled={busy}
                  onClick={() =>
                    void apply(t("应用骨骼姿势"), [
                      blenderSetPoseBoneTransformOperation({
                        objectId: context.inspection.id,
                        boneRef: activeBone.boneRef,
                        local: {
                          location: poseDraft.location,
                          rotationQuaternion: normalizeQuaternion(poseDraft.rotationQuaternion),
                          scale: poseDraft.scale,
                        },
                      }),
                    ])
                  }
                  type="button"
                >
                  {t("应用姿势")}
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    void apply(t("重置骨骼姿势"), [
                      blenderSetPoseBoneTransformOperation({
                        objectId: context.inspection.id,
                        boneRef: activeBone.boneRef,
                        local: IDENTITY_POSE,
                      }),
                    ])
                  }
                  type="button"
                >
                  <RotateCcw aria-hidden size={12} /> {t("重置")}
                </button>
              </div>
            </>
          ) : (
            <p className="native-rig-empty">{t("选择一个活动骨骼以编辑本地姿势。")}</p>
          )}
        </InspectorSection>

        <InspectorSection title="Action" className="native-rig-action-section">
          <label className="native-rig-field">
            <span>{t("活动 Action")}</span>
            <select
              aria-label={t("活动 Action")}
              disabled={busy || context.inspection.animation.actions.length === 0}
              onChange={(event) =>
                void apply(t("切换活动 Action"), [
                  blenderSetActiveActionOperation(context.inspection.id, event.currentTarget.value),
                ])
              }
              value={activeAction?.actionName ?? ""}
            >
              <option disabled value="">
                {t("未绑定 Action")}
              </option>
              {context.inspection.animation.actions.map((action) => (
                <option data-i18n-user-content key={action.actionName} value={action.actionName}>
                  {action.actionName}
                </option>
              ))}
            </select>
          </label>
          {activeAction ? (
            <small className="native-rig-action-meta">
              F{activeAction.frameRange[0]}–F{activeAction.frameRange[1]} · {activeAction.keyframeCount} {t("关键帧")}
            </small>
          ) : null}
          <div className="native-rig-create-action">
            <input
              aria-label={t("新 Action 名称")}
              data-i18n-user-content
              onChange={(event) => setActionName(event.currentTarget.value)}
              placeholder={t("输入 Action 名称")}
              type="text"
              value={actionName}
            />
            <button
              disabled={busy || !actionName.trim()}
              onClick={() =>
                void apply(t("创建 Action"), [
                  blenderCreateActionOperation(context.inspection.id, actionName.trim()),
                ]).then((result) => {
                  if (result) setActionName("");
                })
              }
              type="button"
            >
              {t("创建")}
            </button>
          </div>
          <details className="native-rig-animation-tools">
            <summary>{t("Mixamo / NLA")}</summary>
            <div className="native-rig-animation-block">
              <div className="native-rig-animation-heading">
                <strong>Mixamo</strong>
                {rig.mixamoCompatibility ? (
                  <small className={rig.mixamoCompatibility.compatible ? "is-compatible" : "is-incompatible"}>
                    {rig.mixamoCompatibility.compatible
                      ? `${rig.mixamoCompatibility.mappedBoneCount} ${t("骨骼已映射")}`
                      : `${t("缺少")} ${rig.mixamoCompatibility.missingBoneRoles.join(", ")}`}
                  </small>
                ) : (
                  <small>{t("未报告兼容性")}</small>
                )}
              </div>
              <div className="native-rig-mixamo-grid">
                <label className="native-rig-field native-rig-mixamo-motion">
                  <span>{t("动作")}</span>
                  <select
                    aria-label={t("Mixamo 动作")}
                    disabled={busy}
                    onChange={(event) => {
                      const nextMotionId = event.currentTarget.value;
                      const motion = DIRECTOR_CHARACTER_MOTION_CATALOG.find((entry) => entry.id === nextMotionId);
                      setMotionId(nextMotionId);
                      setRootMotion(motion?.recommendedRootMotion === "authored" ? "AUTHORED" : "IN_PLACE");
                    }}
                    value={motionId}
                  >
                    {DIRECTOR_CHARACTER_MOTION_CATALOG.map((motion) => (
                      <option data-i18n-user-content key={motion.id} value={motion.id}>
                        {locale === "en-US" ? motion.name : motion.nameZh}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="native-rig-field">
                  <span>{t("根运动")}</span>
                  <select
                    aria-label={t("根运动")}
                    disabled={busy}
                    onChange={(event) => setRootMotion(event.currentTarget.value as BlenderMixamoRootMotion)}
                    value={rootMotion}
                  >
                    <option value="IN_PLACE">In place</option>
                    <option value="AUTHORED">Authored</option>
                  </select>
                </label>
              </div>
              <div className="native-rig-mixamo-actions">
                <label>
                  <input
                    checked={replaceExisting}
                    disabled={busy}
                    onChange={(event) => setReplaceExisting(event.currentTarget.checked)}
                    type="checkbox"
                  />
                  <span>{t("覆盖同名 Action")}</span>
                </label>
                <button
                  disabled={busy || !motionId || rig.mixamoCompatibility?.compatible !== true}
                  onClick={() =>
                    void apply(t("导入 Mixamo 动作"), [
                      blenderImportMixamoActionOperation({
                        objectId: context.inspection.id,
                        motionId,
                        rootMotion,
                        replaceExisting,
                      }),
                    ])
                  }
                  type="button"
                >
                  {t("导入 Mixamo 动作")}
                </button>
              </div>
            </div>

            <div className="native-rig-animation-block">
              <div className="native-rig-animation-heading">
                <strong>NLA</strong>
                <small>
                  {nlaTracks.length} Track · {nlaTracks.reduce((total, track) => total + track.strips.length, 0)} Strip
                </small>
              </div>
              <div className="native-rig-create-action">
                <input
                  aria-label={t("新 NLA Track 名称")}
                  data-i18n-user-content
                  onChange={(event) => setNlaTrackName(event.currentTarget.value)}
                  placeholder={t("Track 名称")}
                  type="text"
                  value={nlaTrackName}
                />
                <button
                  disabled={busy || !nlaTrackName.trim()}
                  onClick={() =>
                    void apply(t("创建 NLA Track"), [
                      blenderCreateNlaTrackOperation(context.inspection.id, nlaTrackName.trim()),
                    ]).then((result) => {
                      if (result) setNlaTrackName("");
                    })
                  }
                  type="button"
                >
                  {t("创建 Track")}
                </button>
              </div>
              <div className="native-rig-nla-add-grid">
                <input
                  aria-label={t("新 Strip 名称")}
                  data-i18n-user-content
                  onChange={(event) => {
                    const stripName = event.currentTarget.value;
                    setNlaStripDraft((current) => ({ ...current, stripName }));
                  }}
                  placeholder={t("Strip 名称")}
                  type="text"
                  value={nlaStripDraft.stripName}
                />
                <select
                  aria-label={t("NLA Track")}
                  disabled={busy || nlaTracks.length === 0}
                  onChange={(event) => {
                    const trackName = event.currentTarget.value;
                    setNlaStripDraft((current) => ({ ...current, trackName }));
                  }}
                  value={nlaStripDraft.trackName}
                >
                  {nlaTracks.map((track) => (
                    <option data-i18n-user-content key={track.name} value={track.name}>
                      {track.name}
                    </option>
                  ))}
                </select>
                <select
                  aria-label={t("Strip Action")}
                  disabled={busy || context.inspection.animation.actions.length === 0}
                  onChange={(event) => {
                    const actionName = event.currentTarget.value;
                    setNlaStripDraft((current) => ({ ...current, actionName }));
                  }}
                  value={nlaStripDraft.actionName}
                >
                  {context.inspection.animation.actions.map((action) => (
                    <option data-i18n-user-content key={action.actionName} value={action.actionName}>
                      {action.actionName}
                    </option>
                  ))}
                </select>
                <input
                  aria-label={t("Strip 起始帧")}
                  onChange={(event) => {
                    const startFrame = Math.trunc(parseNumber(event.currentTarget.value, nlaStripDraft.startFrame));
                    setNlaStripDraft((current) => ({
                      ...current,
                      startFrame,
                    }));
                  }}
                  step="1"
                  type="number"
                  value={nlaStripDraft.startFrame}
                />
                <select
                  aria-label={t("Strip 混合模式")}
                  disabled={busy}
                  onChange={(event) => {
                    const blendMode = event.currentTarget.value as BlenderNlaBlendMode;
                    setNlaStripDraft((current) => ({
                      ...current,
                      blendMode,
                    }));
                  }}
                  value={nlaStripDraft.blendMode}
                >
                  {NLA_BLEND_MODES.map((mode) => (
                    <option key={mode} value={mode}>
                      {mode}
                    </option>
                  ))}
                </select>
                <input
                  aria-label={t("Strip 权重")}
                  max="1"
                  min="0"
                  onChange={(event) => {
                    const influence = parseNumber(event.currentTarget.value, nlaStripDraft.influence);
                    setNlaStripDraft((current) => ({
                      ...current,
                      influence,
                    }));
                  }}
                  step="0.05"
                  type="number"
                  value={nlaStripDraft.influence}
                />
                <input
                  aria-label={t("Strip 重复")}
                  min="0.01"
                  onChange={(event) => {
                    const repeat = parseNumber(event.currentTarget.value, nlaStripDraft.repeat);
                    setNlaStripDraft((current) => ({
                      ...current,
                      repeat,
                    }));
                  }}
                  step="0.1"
                  type="number"
                  value={nlaStripDraft.repeat}
                />
                <button
                  disabled={
                    busy || !nlaStripDraft.trackName || !nlaStripDraft.stripName.trim() || !nlaStripDraft.actionName
                  }
                  onClick={() =>
                    void apply(t("添加 NLA Strip"), [
                      blenderAddNlaStripOperation({
                        objectId: context.inspection.id,
                        trackName: nlaStripDraft.trackName,
                        stripName: nlaStripDraft.stripName.trim(),
                        actionName: nlaStripDraft.actionName,
                        startFrame: nlaStripDraft.startFrame,
                        blendMode: nlaStripDraft.blendMode,
                        influence: nlaStripDraft.influence,
                        repeat: nlaStripDraft.repeat,
                      }),
                    ]).then((result) => {
                      if (result) setNlaStripDraft((current) => ({ ...current, stripName: "" }));
                    })
                  }
                  type="button"
                >
                  {t("添加 Strip")}
                </button>
              </div>
              <div className="native-rig-nla-tracks">
                {nlaTracks.map((track) => (
                  <div className="native-rig-nla-track" key={track.name}>
                    <strong data-i18n-user-content>{track.name}</strong>
                    {track.strips.length ? (
                      track.strips.map((strip) => (
                        <form
                          aria-label={`${t("编辑 NLA Strip")} ${strip.name}`}
                          className="native-rig-nla-strip"
                          key={`${track.name}:${strip.name}:${strip.blendMode}:${strip.influence}:${strip.repeat}`}
                        >
                          <span data-i18n-user-content title={strip.actionName ?? undefined}>
                            {strip.name}
                          </span>
                          <select
                            aria-label={`${strip.name} ${t("混合模式")}`}
                            defaultValue={strip.blendMode}
                            disabled={busy}
                            name="blendMode"
                          >
                            {NLA_BLEND_MODES.map((mode) => (
                              <option key={mode} value={mode}>
                                {mode}
                              </option>
                            ))}
                          </select>
                          <input
                            aria-label={`${strip.name} ${t("权重")}`}
                            defaultValue={strip.influence}
                            max="1"
                            min="0"
                            name="influence"
                            step="0.05"
                            type="number"
                          />
                          <input
                            aria-label={`${strip.name} ${t("重复")}`}
                            defaultValue={strip.repeat}
                            min="0.01"
                            name="repeat"
                            step="0.1"
                            type="number"
                          />
                          <button
                            aria-label={`${t("更新")} ${strip.name}`}
                            disabled={busy}
                            onClick={(event) => updateNlaStrip(event.currentTarget.form!, track.name, strip.name)}
                            type="button"
                          >
                            {t("更新")}
                          </button>
                          <button
                            aria-label={`${t("删除")} ${strip.name}`}
                            disabled={busy}
                            onClick={() =>
                              void apply(t("删除 NLA Strip"), [
                                blenderRemoveNlaStripOperation(context.inspection.id, track.name, strip.name),
                              ])
                            }
                            type="button"
                          >
                            {t("删除")}
                          </button>
                        </form>
                      ))
                    ) : (
                      <small className="native-rig-empty">{t("空 Track")}</small>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </details>
          <div className="native-rig-frame-row">
            <label>
              <span>{t("当前帧")}</span>
              <input
                aria-label={t("当前帧")}
                onChange={(event) => setFrameDraft(Math.trunc(parseNumber(event.currentTarget.value, frameDraft)))}
                step="1"
                type="number"
                value={frameDraft}
              />
            </label>
            <button
              disabled={busy || frameDraft === context.frame}
              onClick={() => void apply(t("设置当前帧"), [blenderSetSceneFrameOperation(frameDraft)])}
              type="button"
            >
              {t("跳转")}
            </button>
          </div>
          <div aria-label={t("关键帧通道")} className="native-rig-channel-grid" role="group">
            {(["LOCATION", "ROTATION", "SCALE"] as BlenderPoseChannel[]).map((channel) => (
              <label key={channel}>
                <input
                  checked={channels.includes(channel)}
                  disabled={busy}
                  onChange={() => toggleChannel(channel)}
                  type="checkbox"
                />
                <span>{t({ LOCATION: "位置", ROTATION: "旋转", SCALE: "缩放" }[channel])}</span>
              </label>
            ))}
          </div>
          <label className="native-rig-field">
            <span>{t("插值")}</span>
            <select
              aria-label={t("关键帧插值")}
              disabled={busy}
              onChange={(event) => setInterpolation(event.currentTarget.value as BlenderKeyframeInterpolation)}
              value={interpolation}
            >
              <option value="CONSTANT">Constant</option>
              <option value="LINEAR">Linear</option>
              <option value="BEZIER">Bezier</option>
            </select>
          </label>
          <div className="native-rig-key-actions">
            <button
              disabled={busy || !activeAction || keyedBoneRefs.length === 0 || channels.length === 0}
              onClick={() =>
                activeAction &&
                void apply(t("插入姿势关键帧"), [
                  blenderInsertPoseKeyframesOperation({
                    objectId: context.inspection.id,
                    actionName: activeAction.actionName,
                    frame: frameDraft,
                    boneRefs: keyedBoneRefs,
                    channels,
                    interpolation,
                  }),
                ])
              }
              type="button"
            >
              <KeyRound aria-hidden size={12} /> {t("插入关键帧")}
            </button>
            <button
              disabled={busy || !activeAction || keyedBoneRefs.length === 0 || channels.length === 0}
              onClick={() =>
                activeAction &&
                void apply(t("删除姿势关键帧"), [
                  blenderDeletePoseKeyframesOperation({
                    objectId: context.inspection.id,
                    actionName: activeAction.actionName,
                    frame: frameDraft,
                    boneRefs: keyedBoneRefs,
                    channels,
                  }),
                ])
              }
              type="button"
            >
              {t("删除关键帧")}
            </button>
          </div>
        </InspectorSection>

        {receipt ? (
          <small className="native-rig-receipt" role="status">
            rev {receipt.revisionAfter} · {receipt.operations.length} ops
          </small>
        ) : null}
        {message ? <output className="native-rig-message">{message}</output> : null}
      </InspectorPanel>
    </>
  );
}
