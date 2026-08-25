/**
 * Character inspector with tabs for properties, motion, pose, and IK controls.
 *
 * @module CharacterPanel
 */

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { replaceTupleAxis as replaceAxis } from "../../../../../../packages/protocol/src/primitives";
import { ArrowDownToLine, PersonStanding, UsersRound } from "lucide-react";
import type { PublicAgentProfile } from "@director/agent-engine";
import { listAgentProfiles } from "../assistant/agentProfilesClient";
import { dispatchDirectorAuthoringActions } from "../../../agent/dispatchDirectorAuthoringActions";
import characterPoseGroups from "./characterPoseGroups.json";
import {
  InspectorAxisGroup,
  InspectorColorField,
  InspectorPanel,
  InspectorRangeNumberField,
  InspectorSelectField,
  InspectorTextField,
  InspectorSection,
} from "./InspectorControls";
import { MANNEQUIN_POSE_PRESETS, resolveCharacterPoseControls } from "../presets/mannequinPosePresets";
import type {
  DirectorCharacterIkEffector,
  DirectorCharacterIkTarget,
  DirectorCharacterMotionState,
  DirectorObject,
  DirectorTransform,
} from "../schema/directorProject";
import {
  DIRECTOR_CHARACTER_MOTION_CATALOG,
  getDirectorCharacterMotion,
} from "@director/agent-engine/character-motions";
import { getDefaultCharacterIkTarget } from "../runtime/mannequin/characterIk";
import { ArdyMotionSection } from "./ArdyMotionSection";
import { useBlenderRuntimeStore } from "../runtime/blenderRuntimeStore";
import { getCrowdAnchorTransform, useDirectorStore } from "../store/directorStore";
import { useLanguage } from "../../i18n/language";
import {
  CHARACTER_POSE_CONTROL_KEYS,
  getCharacterPoseControlValueLimits,
  type CharacterPoseControlKey,
  type PosePresetId,
} from "../schema/poseSchema";

function clampFinite(value: string, minimum: number, maximum: number, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

type CharacterSelection = {
  mode: "single" | "crowd";
  crowdId: string | null;
  role: DirectorObject;
  name: string;
  color: string;
  transform: DirectorTransform;
};

type CharacterPoseGroup = { title: string; controls: Array<{ key: CharacterPoseControlKey; label: string }> };
const poseControlKeys = new Set<string>(CHARACTER_POSE_CONTROL_KEYS);
if (characterPoseGroups.some((group) => group.controls.some((control) => !poseControlKeys.has(control.key)))) {
  throw new Error("Character pose panel configuration contains an unknown shared pose control.");
}
const POSE_GROUPS = characterPoseGroups as CharacterPoseGroup[];
const TRANSFORM_AXES = ["X", "Y", "Z"] as const;
const CHARACTER_TRANSFORM_GROUPS = [
  { label: "位置", field: "position" },
  { label: "旋转", field: "rotation" },
  { label: "缩放", field: "scale", step: "0.01" },
] as const;

function buildCharacterPanelSelection(
  objects: DirectorObject[],
  selectedCrowdId: string | null,
  selectedObjectId: string | null,
): CharacterSelection | null {
  const role = objects.find((item) => item.id === selectedObjectId && item.kind === "character");

  if (selectedCrowdId) {
    const crowdMembers = objects.filter((item) => item.kind === "character" && item.crowdId === selectedCrowdId);
    const crowdAnchor = getCrowdAnchorTransform(objects, selectedCrowdId);

    if (crowdMembers.length && crowdAnchor) {
      return {
        mode: "crowd",
        crowdId: selectedCrowdId,
        role: crowdMembers[crowdMembers.length - 1] ?? crowdMembers[0],
        name: crowdMembers[0]?.crowdLabel ?? "群众",
        color: crowdMembers[0]?.color ?? "#4F8EF7",
        transform: crowdAnchor,
      };
    }
  }

  if (!role) return null;

  return {
    mode: "single",
    crowdId: null,
    role,
    name: role.name,
    color: role.color ?? "#4F8EF7",
    transform: role.transform,
  };
}

function useCharacterPanelSelection(): CharacterSelection | null {
  const selectedCrowdId = useDirectorStore((state) => state.selectedCrowdId);
  const selectedObjectId = useDirectorStore((state) => state.selectedObjectId);
  const objects = useDirectorStore((state) => state.project.objects);

  return useMemo(
    () => buildCharacterPanelSelection(objects, selectedCrowdId, selectedObjectId),
    [objects, selectedCrowdId, selectedObjectId],
  );
}

const CharacterSelectionSummary = memo(function CharacterSelectionSummary({
  selection,
}: {
  selection: CharacterSelection;
}) {
  const SelectionIcon = selection.mode === "crowd" ? UsersRound : PersonStanding;

  return (
    <div className="character-selection-summary" aria-label="当前角色">
      <span className="character-selection-avatar" aria-hidden="true">
        <SelectionIcon size={16} strokeWidth={1.8} />
      </span>
      <span className="character-selection-copy">
        <strong>{selection.name}</strong>
        <small>{selection.mode === "crowd" ? "角色群组" : "单个角色"}</small>
        {selection.mode === "single" && selection.role.agentBinding ? (
          <small aria-label="Agent 接管状态" className="character-agent-badge">
            Agent 接管中
          </small>
        ) : null}
      </span>
      <span aria-hidden="true" className="character-selection-color" style={{ backgroundColor: selection.color }} />
    </div>
  );
});

/**
 * "绑定 Agent" inspector block: attach an Agent session or profile to the
 * selected character so that Agent drives its motion, pose, IK, and transform.
 * All mutations dispatch through the shared authoring path (revision guarded,
 * undoable); the panel never writes the store directly.
 */
const CharacterAgentBindingSection = memo(function CharacterAgentBindingSection({
  selection,
}: {
  selection: CharacterSelection;
}) {
  const role = selection.role;
  const isCrowd = selection.mode === "crowd";
  const binding = role.agentBinding;
  const [profiles, setProfiles] = useState<PublicAgentProfile[]>([]);
  const [profileDraft, setProfileDraft] = useState("");
  const [sessionDraft, setSessionDraft] = useState("");
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => {
    if (isCrowd) return;
    let cancelled = false;
    listAgentProfiles()
      .then((available) => {
        if (!cancelled) setProfiles(available);
      })
      .catch(() => {
        // Offline gateway: manual session ids keep working without profiles.
      });
    return () => {
      cancelled = true;
    };
  }, [isCrowd]);

  const bindAgent = useCallback(() => {
    const sessionId = sessionDraft.trim();
    const profileId = profileDraft.trim();
    if (!sessionId && !profileId) {
      setFeedback("请先选择 Agent Profile 或填写 Session ID。");
      return;
    }
    const receipt = dispatchDirectorAuthoringActions([
      {
        action: "bind_character_agent",
        object_id: role.id,
        ...(sessionId ? { session_id: sessionId } : {}),
        ...(profileId ? { profile_id: profileId } : {}),
      },
    ]);
    setFeedback(receipt.ok ? null : receipt.error);
  }, [profileDraft, role.id, sessionDraft]);

  const unbindAgent = useCallback(() => {
    const receipt = dispatchDirectorAuthoringActions([{ action: "unbind_character_agent", object_id: role.id }]);
    setFeedback(receipt.ok ? null : receipt.error);
  }, [role.id]);

  if (isCrowd) {
    return (
      <InspectorSection title="绑定 Agent" className="character-agent-section">
        <p className="character-ik-note">群组选择暂不支持绑定 Agent；请选择单个角色后再绑定。</p>
      </InspectorSection>
    );
  }

  return (
    <InspectorSection title="绑定 Agent" className="character-agent-section">
      {binding ? (
        <>
          <p aria-live="polite" className="character-agent-status">
            此人物已被 Agent 接管
          </p>
          <p className="character-ik-note">
            <span>当前绑定</span>：<code>{binding.sessionId ?? binding.profileId ?? ""}</code>
          </p>
          <button aria-label="解除 Agent 绑定" className="inspector-action-button" type="button" onClick={unbindAgent}>
            解除绑定
          </button>
        </>
      ) : (
        <>
          <InspectorSelectField
            label="Agent Profile"
            ariaLabel="绑定 Agent Profile"
            value={profileDraft}
            onChange={setProfileDraft}
            options={[
              { value: "", label: "暂不选择 Profile" },
              ...profiles.map((profile) => ({ value: profile.id, label: profile.label })),
            ]}
          />
          <InspectorTextField
            label="Session ID"
            ariaLabel="绑定 Agent Session ID"
            value={sessionDraft}
            onChange={setSessionDraft}
          />
          <p className="character-ik-note">填写驱动该角色的 Agent Session ID（如 dsh-abc123），或选择 Profile 提前接上。</p>
          <button aria-label="绑定 Agent 到该角色" className="inspector-action-button" type="button" onClick={bindAgent}>
            绑定
          </button>
        </>
      )}
      {feedback ? (
        <p aria-live="polite" className="character-agent-feedback" role="alert">
          {feedback}
        </p>
      ) : null}
    </InspectorSection>
  );
});

const CharacterPropertiesTab = memo(function CharacterPropertiesTab({ selection }: { selection: CharacterSelection }) {
  const role = selection.role;
  const transform = selection.transform;
  const isCrowd = selection.mode === "crowd";
  const crowdId = selection.crowdId;
  const updateTransformAxis = (
    field: (typeof CHARACTER_TRANSFORM_GROUPS)[number]["field"],
    axis: 0 | 1 | 2,
    value: string,
  ) => {
    const patch: Partial<DirectorTransform> = { [field]: replaceAxis(transform[field], axis, Number(value)) };
    if (isCrowd && crowdId) useDirectorStore.getState().updateCrowdTransform(crowdId, patch);
    else useDirectorStore.getState().updateObjectTransform(role.id, patch);
  };

  return (
    <>
      <InspectorSection title="基本信息" className="character-identity-section">
        <InspectorTextField
          label="名称"
          ariaLabel="角色名称"
          value={selection.name}
          onChange={(value) => {
            if (isCrowd && crowdId) {
              useDirectorStore.getState().updateCrowdLabel(crowdId, value);
              return;
            }

            useDirectorStore.getState().updateObjectName(role.id, value);
          }}
        />
      </InspectorSection>
      <InspectorSection title="变换" className="character-transform-section">
        {CHARACTER_TRANSFORM_GROUPS.map(({ label, field, ...options }) => (
          <InspectorAxisGroup
            key={field}
            label={label}
            axes={TRANSFORM_AXES.map((axis, index) => ({
              axis,
              ariaLabel: `角色${label} ${axis}`,
              value: transform[field][index],
              ...options,
              onChange: (value) => updateTransformAxis(field, index as 0 | 1 | 2, value),
            }))}
          />
        ))}
      </InspectorSection>
      <InspectorSection title="放置" className="character-placement-section">
        <button
          aria-label="Down 2 Earth"
          className="inspector-action-button inspector-ground-button"
          title="让角色落到当前场景地面"
          type="button"
          onClick={() =>
            isCrowd && crowdId
              ? useDirectorStore.getState().dropCrowdToGround(crowdId)
              : useDirectorStore.getState().dropObjectToGround(role.id)
          }
        >
          <ArrowDownToLine aria-hidden size={14} />
          <span>Down 2 Earth</span>
        </button>
      </InspectorSection>
      <InspectorSection title="外观" className="character-appearance-section">
        <InspectorRangeNumberField
          label="统一缩放"
          rangeAriaLabel="角色统一缩放滑杆"
          numberAriaLabel="角色统一缩放"
          max="3"
          min="0.2"
          step="0.01"
          value={transform.scale[0]}
          onValueChange={(value) =>
            isCrowd && crowdId
              ? useDirectorStore.getState().updateCrowdUniformScale(crowdId, Number(value))
              : useDirectorStore.getState().updateUniformScale(role.id, Number(value))
          }
        />
        <InspectorColorField
          label="颜色"
          colorAriaLabel="角色颜色"
          hexAriaLabel="角色颜色 HEX"
          value={selection.color}
          onColorChange={(value) =>
            isCrowd && crowdId
              ? useDirectorStore.getState().updateCrowdColor(crowdId, value)
              : useDirectorStore.getState().updateObjectColor(role.id, value)
          }
          onHexChange={(value) =>
            isCrowd && crowdId
              ? useDirectorStore.getState().updateCrowdColor(crowdId, value)
              : useDirectorStore.getState().updateObjectColor(role.id, value)
          }
        />
      </InspectorSection>
      <CharacterAgentBindingSection selection={selection} />
    </>
  );
});

const CharacterPosePresetButton = memo(function CharacterPosePresetButton({
  label,
  presetId,
  isActive,
  onSelect,
}: {
  label: string;
  presetId: PosePresetId;
  isActive: boolean;
  onSelect: (presetId: PosePresetId) => void;
}) {
  return (
    <button className={isActive ? "is-active" : undefined} type="button" onClick={() => onSelect(presetId)}>
      {label}
    </button>
  );
});

const CharacterPosePresetGrid = memo(function CharacterPosePresetGrid({
  activePresetId,
  isCrowd,
  crowdId,
  roleId,
}: {
  activePresetId?: PosePresetId;
  isCrowd: boolean;
  crowdId: string | null;
  roleId: string;
}) {
  const handleSelect = useCallback(
    (presetId: PosePresetId) => {
      if (isCrowd && crowdId) {
        useDirectorStore.getState().applyCrowdPosePreset(crowdId, presetId);
        return;
      }

      useDirectorStore.getState().applyPosePreset(roleId, presetId);
    },
    [crowdId, isCrowd, roleId],
  );

  return (
    <div className="preset-grid">
      {MANNEQUIN_POSE_PRESETS.map((preset) => (
        <CharacterPosePresetButton
          key={preset.id}
          label={preset.label}
          presetId={preset.id}
          isActive={activePresetId === preset.id}
          onSelect={handleSelect}
        />
      ))}
    </div>
  );
});

const CharacterPoseControlField = memo(function CharacterPoseControlField({
  controlKey,
  groupTitle,
  label,
  value,
  isCrowd,
  crowdId,
  roleId,
  bodyType,
}: {
  controlKey: string;
  groupTitle: string;
  label: string;
  value: number;
  isCrowd: boolean;
  crowdId: string | null;
  roleId: string;
  bodyType?: string;
}) {
  const limits = getCharacterPoseControlValueLimits(controlKey, bodyType);
  const handleChange = useCallback(
    (nextValue: string) => {
      const numericValue = Number(nextValue);

      if (isCrowd && crowdId) {
        useDirectorStore.getState().updateCrowdPoseControl(crowdId, controlKey, numericValue);
        return;
      }

      useDirectorStore.getState().updatePoseControl(roleId, controlKey, numericValue);
    },
    [controlKey, crowdId, isCrowd, roleId],
  );

  return (
    <InspectorRangeNumberField
      label={label}
      rangeAriaLabel={`${groupTitle} · ${label} 滑杆`}
      numberAriaLabel={`${groupTitle} · ${label}`}
      max={String(limits.max)}
      min={String(limits.min)}
      step={controlKey === "body.offsetY" ? "0.01" : "1"}
      value={value}
      onValueChange={handleChange}
    />
  );
});

const CharacterPoseTab = memo(function CharacterPoseTab({ selection }: { selection: CharacterSelection }) {
  const role = selection.role;
  const isCrowd = selection.mode === "crowd";
  const crowdId = selection.crowdId;
  const controls = resolveCharacterPoseControls(role.characterRig);
  const activePresetId = MANNEQUIN_POSE_PRESETS.find((preset) => preset.id === role.characterRig?.posePresetId)?.id;

  if (!role.characterRig) {
    return <p>该模型未识别到标准 humanoid 骨骼，暂不支持姿势编辑。</p>;
  }

  return (
    <InspectorSection title="姿势预设" className="pose-preset-section">
      <CharacterPosePresetGrid activePresetId={activePresetId} isCrowd={isCrowd} crowdId={crowdId} roleId={role.id} />
      <InspectorSection title="姿势调节" className="pose-adjust-section">
        <div className="pose-groups">
          {POSE_GROUPS.map((group) => (
            <section key={group.title} className="pose-group">
              <h4>{group.title}</h4>
              {group.controls.map((control) => (
                <CharacterPoseControlField
                  key={control.key}
                  controlKey={control.key}
                  groupTitle={group.title}
                  label={control.label}
                  value={controls[control.key] ?? 0}
                  isCrowd={isCrowd}
                  crowdId={crowdId}
                  roleId={role.id}
                  bodyType={role.bodyType}
                />
              ))}
            </section>
          ))}
        </div>
      </InspectorSection>
    </InspectorSection>
  );
});

const CharacterIkTab = memo(function CharacterIkTab({
  selection,
  activeIkEffector,
  onActiveIkEffectorChange,
}: {
  selection: CharacterSelection;
  activeIkEffector: DirectorCharacterIkEffector;
  onActiveIkEffectorChange: (effector: DirectorCharacterIkEffector) => void;
}) {
  const role = selection.role;
  const isCrowd = selection.mode === "crowd";
  const crowdId = selection.crowdId;
  const storedIkTarget = role.characterRig?.ik?.[activeIkEffector];
  const ikTarget = storedIkTarget ?? getDefaultCharacterIkTarget(role.bodyType, activeIkEffector);

  const updateIkTarget = useCallback(
    (patch: Partial<DirectorCharacterIkTarget>) => {
      const nextTarget = { ...ikTarget, ...patch };

      if (isCrowd && crowdId) {
        useDirectorStore.getState().setCrowdCharacterIkEffector(crowdId, activeIkEffector, nextTarget);
        return;
      }

      useDirectorStore.getState().setCharacterIkEffector(role.id, activeIkEffector, nextTarget);
    },
    [activeIkEffector, crowdId, ikTarget, isCrowd, role.id],
  );

  const clearIkTarget = useCallback(() => {
    if (isCrowd && crowdId) {
      useDirectorStore.getState().clearCrowdCharacterIkEffector(crowdId, activeIkEffector);
      return;
    }

    useDirectorStore.getState().clearCharacterIkEffector(role.id, activeIkEffector);
  }, [activeIkEffector, crowdId, isCrowd, role.id]);

  if (!role.characterRig) {
    return <p>该模型未识别到标准 humanoid 骨骼，暂不支持 IK。</p>;
  }

  return (
    <InspectorSection title="四肢 IK" className="character-ik-section">
      <InspectorSelectField
        label="末端"
        ariaLabel="IK 末端"
        value={activeIkEffector}
        onChange={(value) => onActiveIkEffectorChange(value as DirectorCharacterIkEffector)}
        options={[
          { value: "leftHand", label: "左手" },
          { value: "rightHand", label: "右手" },
          { value: "leftFoot", label: "左脚" },
          { value: "rightFoot", label: "右脚" },
        ]}
      />
      <InspectorAxisGroup
        label="目标位置"
        axes={(["X", "Y", "Z"] as const).map((axis, index) => ({
          axis,
          ariaLabel: `IK 目标 ${axis}`,
          step: "0.01",
          value: ikTarget.target[index],
          onChange: (value: string) =>
            updateIkTarget({
              target: replaceAxis(
                ikTarget.target,
                index as 0 | 1 | 2,
                clampFinite(value, -10_000, 10_000, ikTarget.target[index]),
              ),
            }),
        }))}
      />
      <InspectorAxisGroup
        label="弯曲 Pole"
        axes={(["X", "Y", "Z"] as const).map((axis, index) => ({
          axis,
          ariaLabel: `IK Pole ${axis}`,
          step: "0.01",
          value: ikTarget.pole[index],
          onChange: (value: string) =>
            updateIkTarget({
              pole: replaceAxis(
                ikTarget.pole,
                index as 0 | 1 | 2,
                clampFinite(value, -10_000, 10_000, ikTarget.pole[index]),
              ),
            }),
        }))}
      />
      <InspectorRangeNumberField
        label="混合权重"
        rangeAriaLabel="IK 混合权重滑杆"
        numberAriaLabel="IK 混合权重"
        min="0"
        max="1"
        step="0.01"
        value={ikTarget.weight}
        onValueChange={(value) => updateIkTarget({ weight: clampFinite(value, 0, 1, ikTarget.weight) })}
      />
      <InspectorRangeNumberField
        label="伸展上限"
        rangeAriaLabel="IK 伸展上限滑杆"
        numberAriaLabel="IK 伸展上限"
        min="0.05"
        max="1"
        step="0.01"
        value={ikTarget.reachClamp}
        onValueChange={(value) => updateIkTarget({ reachClamp: clampFinite(value, 0.05, 1, ikTarget.reachClamp) })}
      />
      <p className="character-ik-note">目标与 Pole 使用角色局部米制坐标；不可达目标会稳定限制在骨段长度内。</p>
      {storedIkTarget ? (
        <button className="inspector-action-button" type="button" onClick={clearIkTarget}>
          清除此 IK
        </button>
      ) : (
        <button className="inspector-action-button" type="button" onClick={() => updateIkTarget({})}>
          启用此 IK
        </button>
      )}
    </InspectorSection>
  );
});

const CharacterMotionTab = memo(function CharacterMotionTab({
  nativeMode,
  selection,
}: {
  nativeMode: boolean;
  selection: CharacterSelection;
}) {
  const { locale, t } = useLanguage();
  const role = selection.role;
  const currentFrame = useDirectorStore((state) => state.project.scene.timeline?.currentFrame ?? 0);
  const motion = role.characterRig?.motion;
  const selectedMotion = motion ? getDirectorCharacterMotion(motion.clipId) : null;

  const commitMotion = useCallback(
    (nextMotion: DirectorCharacterMotionState | undefined) => {
      const store = useDirectorStore.getState();
      if (selection.mode === "crowd" && selection.crowdId) {
        store.setCrowdCharacterMotion(selection.crowdId, nextMotion);
      } else {
        store.setCharacterMotion(role.id, nextMotion);
      }
    },
    [role.id, selection.crowdId, selection.mode],
  );

  const patchMotion = useCallback(
    (patch: Partial<DirectorCharacterMotionState>) => {
      if (!motion) return;
      commitMotion({ ...motion, ...patch });
    },
    [commitMotion, motion],
  );

  const selectMotion = useCallback(
    (clipId: string) => {
      if (!clipId) {
        commitMotion(undefined);
        return;
      }
      const clip = getDirectorCharacterMotion(clipId);
      if (!clip) return;
      commitMotion({
        clipId: clip.id,
        enabled: true,
        loop: clip.defaultLoop,
        speed: 1,
        weight: 1,
        startFrame: currentFrame,
        blendInS: 0.12,
        blendOutS: clip.defaultLoop === "once" ? 0.15 : 0,
        rootMotion: clip.recommendedRootMotion,
      });
    },
    [commitMotion, currentFrame],
  );

  if (!role.characterRig) {
    return <p>该模型未识别到标准 humanoid 骨骼，暂不支持骨骼动作。</p>;
  }

  return (
    <InspectorSection title="骨骼动作" className="character-motion-section">
      <InspectorSelectField
        label="动作 Clip"
        ariaLabel="角色骨骼动作"
        value={motion?.clipId ?? ""}
        onChange={selectMotion}
        options={[
          { value: "", label: "无动作" },
          ...DIRECTOR_CHARACTER_MOTION_CATALOG.map((clip) => ({
            value: clip.id,
            label: locale === "en-US" ? clip.name : clip.nameZh,
          })),
        ]}
      />
      {motion && selectedMotion ? (
        <>
          <InspectorSelectField
            label="循环"
            ariaLabel="角色动作循环"
            value={motion.loop}
            onChange={(value) => patchMotion({ loop: value as DirectorCharacterMotionState["loop"] })}
            options={[
              { value: "once", label: "播放一次" },
              { value: "repeat", label: "循环" },
              // Native NLA strips cannot ping-pong; keep the entry only for
              // data that already persists it so the select stays readable.
              ...(!nativeMode || motion.loop === "ping-pong"
                ? [
                    {
                      value: "ping-pong",
                      label: nativeMode ? "往返（Blender 暂不可用）" : "往返",
                      disabled: nativeMode,
                    },
                  ]
                : []),
            ]}
          />
          <InspectorSelectField
            label="根运动"
            ariaLabel="角色动作根运动"
            value={motion.rootMotion}
            onChange={(value) => patchMotion({ rootMotion: value as DirectorCharacterMotionState["rootMotion"] })}
            options={[
              { value: "in-place", label: "原地（推荐）" },
              // Root-motion extraction is not implemented; the authored mode
              // stays visible only for migrated projects that persist it.
              ...(motion.rootMotion === "authored"
                ? [
                    {
                      value: "authored",
                      label: "保留位移（迁移兼容，暂不可用）",
                      disabled: true,
                    },
                  ]
                : []),
            ]}
          />
          <InspectorRangeNumberField
            label="速度"
            rangeAriaLabel="角色动作速度滑杆"
            numberAriaLabel="角色动作速度"
            min="0.1"
            max="4"
            step="0.05"
            value={motion.speed}
            onValueChange={(value) => patchMotion({ speed: clampFinite(value, 0.1, 4, motion.speed) })}
          />
          {!nativeMode ? (
            <InspectorRangeNumberField
              label="混合权重"
              rangeAriaLabel="角色动作权重滑杆"
              numberAriaLabel="角色动作权重"
              min="0"
              max="1"
              step="0.01"
              value={motion.weight}
              onValueChange={(value) => patchMotion({ weight: clampFinite(value, 0, 1, motion.weight) })}
            />
          ) : null}
          <InspectorTextField
            label="起始帧"
            ariaLabel="角色动作起始帧"
            type="number"
            step="1"
            value={motion.startFrame}
            onChange={(value) =>
              patchMotion({ startFrame: Math.round(clampFinite(value, -1_000_000, 1_000_000, motion.startFrame)) })
            }
          />
          {!nativeMode ? (
            <>
              <InspectorRangeNumberField
                label="淡入"
                rangeAriaLabel="角色动作淡入滑杆"
                numberAriaLabel="角色动作淡入秒数"
                min="0"
                max="10"
                step="0.05"
                value={motion.blendInS}
                onValueChange={(value) => patchMotion({ blendInS: clampFinite(value, 0, 10, motion.blendInS) })}
              />
              <InspectorRangeNumberField
                label="淡出"
                rangeAriaLabel="角色动作淡出滑杆"
                numberAriaLabel="角色动作淡出秒数"
                min="0"
                max="10"
                step="0.05"
                value={motion.blendOutS}
                onValueChange={(value) => patchMotion({ blendOutS: clampFinite(value, 0, 10, motion.blendOutS) })}
              />
            </>
          ) : (
            <p className="character-ik-note">
              Blender 角色动作使用独立动作轨道与完整权重；往返和混合淡入淡出尚未接入 Blender 骨架。
            </p>
          )}
          <p className="character-ik-note">
            {locale === "en-US" ? selectedMotion.name : selectedMotion.nameZh} · {selectedMotion.durationS.toFixed(2)}{" "}
            {t("秒")} · {selectedMotion.source.provider}
          </p>
          <button
            className="inspector-action-button"
            type="button"
            onClick={() => patchMotion({ enabled: !motion.enabled })}
          >
            {motion.enabled ? "暂停骨骼动作" : "启用骨骼动作"}
          </button>
          <button className="inspector-action-button" type="button" onClick={() => commitMotion(undefined)}>
            清除骨骼动作
          </button>
        </>
      ) : null}
    </InspectorSection>
  );
});

/**
 * Renders the character inspector with tabs for identity/transform, skeletal motion clips,
 * pose presets and controls, and IK effector targeting.
 */
export function CharacterPanel() {
  const [activeTab, setActiveTab] = useState<"properties" | "motion" | "pose" | "ik">("properties");
  const [activeIkEffector, setActiveIkEffector] = useState<DirectorCharacterIkEffector>("leftHand");
  const selection = useCharacterPanelSelection();
  const nativeRootObjectId =
    selection?.role.nativeSource?.engine === "blender" ? selection.role.nativeSource.objectId : null;
  const nativeRigCapability = useBlenderRuntimeStore((state) =>
    nativeRootObjectId ? state.nativeRigCapabilities[nativeRootObjectId] : undefined,
  );
  const isProvisionedNativeCharacter = Boolean(
    nativeRootObjectId && selection?.role.nativeSource?.provisioned !== false,
  );

  // Native Blender rigs have no Director IK adapter yet. Hiding the tab
  // (instead of advertising a control surface that cannot write results)
  // keeps the panel honest; a previously selected IK tab falls back to
  // properties when the selection becomes a native character.
  const resolvedActiveTab = activeTab === "ik" && isProvisionedNativeCharacter ? "properties" : activeTab;
  const tabs = useMemo(
    () => [
      { label: "属性", active: resolvedActiveTab === "properties", onClick: () => setActiveTab("properties") },
      { label: "动作", active: resolvedActiveTab === "motion", onClick: () => setActiveTab("motion") },
      { label: "姿势", active: resolvedActiveTab === "pose", onClick: () => setActiveTab("pose") },
      ...(isProvisionedNativeCharacter
        ? []
        : [{ label: "IK", active: resolvedActiveTab === "ik", onClick: () => setActiveTab("ik") }]),
    ],
    [isProvisionedNativeCharacter, resolvedActiveTab],
  );

  if (!selection) return null;

  const nativeSemanticNotice = isProvisionedNativeCharacter
    ? nativeRigCapability?.status === "ready" && nativeRigCapability.compatible
      ? null
      : nativeRigCapability?.status === "checking" || !nativeRigCapability
        ? "正在检查 Blender 角色骨架兼容性…"
        : (nativeRigCapability?.reason ?? "该 Blender 角色骨架不兼容 Director 角色控制。")
    : null;

  return (
    <InspectorPanel title="角色" ariaLabel="角色右侧属性面板" className="character-inspector" tabs={tabs}>
      <CharacterSelectionSummary selection={selection} />
      {resolvedActiveTab === "properties" ? <CharacterPropertiesTab selection={selection} /> : null}
      {resolvedActiveTab !== "properties" && nativeSemanticNotice ? (
        <p aria-live="polite" className="character-ik-note">
          {nativeSemanticNotice}
        </p>
      ) : null}
      {resolvedActiveTab === "motion" && !nativeSemanticNotice ? (
        <>
          <CharacterMotionTab selection={selection} nativeMode={isProvisionedNativeCharacter} />
          <ArdyMotionSection role={selection.role} />
        </>
      ) : null}
      {resolvedActiveTab === "pose" && !nativeSemanticNotice ? <CharacterPoseTab selection={selection} /> : null}
      {resolvedActiveTab === "ik" && !nativeSemanticNotice ? (
        <CharacterIkTab
          selection={selection}
          activeIkEffector={activeIkEffector}
          onActiveIkEffectorChange={setActiveIkEffector}
        />
      ) : null}
    </InspectorPanel>
  );
}
