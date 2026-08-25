/**
 * The canonical ordered list of film production role identifiers.
 *
 * Each role represents a distinct responsibility in the film production pipeline, from
 * showrunner through editing. The order reflects a typical production workflow.
 */
export const FILM_ROLE_IDS = [
  "showrunner",
  "screenwriter",
  "production-designer",
  "continuity-supervisor",
  "shot-planner",
  "stage-director",
  "cinematographer",
  "generation-operator",
  "visual-critic",
  "repair-operator",
  "sound-designer",
  "editor",
] as const;

/** A film production role identifier drawn from the canonical set. */
export type FilmRoleId = (typeof FILM_ROLE_IDS)[number];

/**
 * Type guard that checks whether a value is a recognised film role identifier.
 *
 * @param value - The value to test.
 * @returns `true` when the value is a string that matches one of the canonical film role ids.
 */
export function isFilmRoleId(value: unknown): value is FilmRoleId {
  return typeof value === "string" && FILM_ROLE_IDS.some((roleId) => roleId === value);
}
