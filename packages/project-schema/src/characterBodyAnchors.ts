import type { CharacterBodyType } from "./directorProject";

/** Body type used when no explicit type is provided or when an unrecognized value is supplied. */
export const DEFAULT_CHARACTER_BODY_TYPE: CharacterBodyType = "mannequin";

/**
 * Name-label Y offsets matching the procedural body presets.
 *
 * Keep this table aligned with `frontend/.../mannequin/bodyPresets.json`
 * `labelAnchorY` values; `bodyTypes.test.ts` asserts they stay in lockstep.
 */
export const CHARACTER_BODY_LABEL_ANCHOR_Y = {
  mannequin: 2.62,
  female: 2.52,
  broad: 2.76,
  muscular: 2.7,
  slim: 2.58,
  teen: 2.28,
  child: 1.82,
  chibi: 1.38,
} as const satisfies Record<CharacterBodyType, number>;

/**
 * Returns the Y-coordinate of the label anchor for the given body type, used to
 * position name labels above the character.
 *
 * @param value - A candidate body type string, possibly null or undefined.
 * @returns The label anchor Y in world units.
 */
export function getGroundedLabelY(value?: string | null): number {
  return value && value in CHARACTER_BODY_LABEL_ANCHOR_Y
    ? CHARACTER_BODY_LABEL_ANCHOR_Y[value as CharacterBodyType]
    : CHARACTER_BODY_LABEL_ANCHOR_Y[DEFAULT_CHARACTER_BODY_TYPE];
}
