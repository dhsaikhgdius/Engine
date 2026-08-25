import posePresets from "./mannequinPosePresets.json";
import type { CharacterRigState } from "../schema/directorProject";
import { CHARACTER_POSE_CONTROL_KEYS, POSE_PRESET_IDS, type PosePresetId } from "../schema/poseSchema";

export interface PosePresetDefinition {
  id: PosePresetId;
  label: string;
  controls: Record<string, number>;
}

const poseIds = new Set<string>(POSE_PRESET_IDS);
const controlKeys = new Set<string>(CHARACTER_POSE_CONTROL_KEYS);
if (
  posePresets.length !== poseIds.size ||
  posePresets.some(
    (preset) => !poseIds.delete(preset.id) || Object.keys(preset.controls).some((key) => !controlKeys.has(key)),
  )
) {
  throw new Error("Mannequin pose preset data does not match the shared pose protocol.");
}
export const MANNEQUIN_POSE_PRESETS = posePresets as PosePresetDefinition[];

const MANNEQUIN_POSE_PRESET_BY_ID = new Map<string, PosePresetDefinition>(
  MANNEQUIN_POSE_PRESETS.map((preset) => [preset.id, preset]),
);

export function getMannequinPosePreset(presetId: string | null | undefined) {
  return presetId ? (MANNEQUIN_POSE_PRESET_BY_ID.get(presetId) ?? null) : null;
}

/**
 * Resolve the actual controls consumed by every humanoid runtime.
 *
 * Older Stage projections and Agent-authored objects persisted only a preset
 * id and left `controls` empty. Treating the raw controls as the whole pose
 * made those characters render in the neutral stance even though the UI and
 * protocol reported e.g. `sit`, `wave`, or `push`. A preset is the base pose;
 * explicit controls are sparse overrides on top of it.
 */
export function resolveCharacterPoseControls(rigState: CharacterRigState | null | undefined) {
  const overrides = rigState?.controls ?? {};
  const preset = getMannequinPosePreset(rigState?.posePresetId);
  if (!preset) return overrides;
  if (Object.keys(overrides).length === 0) return preset.controls;
  return { ...preset.controls, ...overrides };
}
