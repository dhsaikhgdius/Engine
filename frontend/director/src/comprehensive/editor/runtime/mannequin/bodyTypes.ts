import bodyPresets from "./bodyPresets.json";
import type { CharacterBodyType } from "../../schema/directorProject";
import { DEFAULT_CHARACTER_BODY_TYPE, getGroundedLabelY } from "@director/project-schema";

export type { CharacterBodyType };
export { DEFAULT_CHARACTER_BODY_TYPE, getGroundedLabelY };

/** Dimensional parameters that define the proportional skeleton of a procedural character body. */
export interface CharacterBodyProportions {
  hipY: number;
  pelvisRadius: number;
  pelvisScale: [number, number, number];
  legSpread: number;
  torsoLowerRadius: number;
  torsoUpperRadius: number;
  torsoLowerHeight: number;
  torsoUpperHeight: number;
  torsoLowerScale: [number, number, number];
  torsoUpperScale: [number, number, number];
  shoulderWidth: number;
  shoulderRadius: number;
  upperArmRadius: number;
  upperArmLength: number;
  forearmRadius: number;
  forearmLength: number;
  elbowRadius: number;
  wristRadius: number;
  handRadius: number;
  handScale: [number, number, number];
  thighRadius: number;
  thighLength: number;
  calfRadius: number;
  calfLength: number;
  kneeRadius: number;
  ankleRadius: number;
  footRadius: number;
  footLength: number;
  footScale: [number, number, number];
  neckRadius: number;
  neckHeight: number;
  headRadius: number;
  headScale: [number, number, number];
  faceOffsetZ: number;
  eyeRadius: number;
  noseScale: [number, number, number];
  mouthScale: [number, number, number];
  jointRadiusScale: number;
}

/** A named body type preset with its label, default scale, and full proportional dimensions. */
export interface CharacterBodyPreset {
  bodyType: CharacterBodyType;
  label: string;
  defaultScale: [number, number, number];
  labelAnchorY: number;
  proportions: CharacterBodyProportions;
}

const bodyTypes = new Set<string>(["mannequin", "female", "broad", "muscular", "slim", "teen", "child", "chibi"]);
const validMetric = (value: unknown) =>
  typeof value === "number"
    ? Number.isFinite(value)
    : Array.isArray(value) && value.length === 3 && value.every((entry) => Number.isFinite(entry));
if (
  bodyPresets.length !== bodyTypes.size ||
  bodyPresets.some(
    (preset) =>
      !bodyTypes.delete(preset.bodyType) ||
      ![...preset.defaultScale, preset.labelAnchorY, ...Object.values(preset.proportions)].every(validMetric),
  )
) {
  throw new Error("Character body preset data does not match the shared body protocol.");
}
/** Runtime-validated array of all available body presets, loaded from the bundled JSON catalog. */
export const CHARACTER_BODY_PRESETS = bodyPresets as CharacterBodyPreset[];
const bodyPresetByType = new Map(CHARACTER_BODY_PRESETS.map((preset) => [preset.bodyType, preset]));

/** Body type options for UI selectors, derived from the available presets. */
export const BODY_TYPE_OPTIONS = CHARACTER_BODY_PRESETS.map(({ bodyType, label }) => ({
  bodyType,
  label,
}));

/**
 * Returns the body type if it matches a known preset, or the default body type otherwise.
 *
 * @param value - A candidate body type string, possibly null or undefined.
 * @returns A valid body type from the preset catalog.
 */
export function normalizeBodyType(value?: string | null): CharacterBodyType {
  return bodyPresetByType.has(value as CharacterBodyType) ? (value as CharacterBodyType) : DEFAULT_CHARACTER_BODY_TYPE;
}

/**
 * Returns the full preset for the given body type, falling back to the default when the value is unrecognized.
 *
 * @param value - A candidate body type string, possibly null or undefined.
 * @returns The resolved body preset.
 */
export function getBodyPreset(value?: string | null): CharacterBodyPreset {
  const bodyType = normalizeBodyType(value);
  return bodyPresetByType.get(bodyType)!;
}
