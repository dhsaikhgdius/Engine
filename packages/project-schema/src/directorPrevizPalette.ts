/**
 * Neutral previz look shared by the editor, live camera view and DCC exports.
 *
 * The stage is a light studio field so the ground grid stays the floor.
 * Object colours stay independent of that field.
 */
export const DIRECTOR_PREVIZ_PALETTE = {
  /** Neutral sky tone for the previz background. */
  sky: "#c9cdd3",
  /** Dark studio-floor colour for the ground plane. */
  ground: "#5a5e63",
  /** Subtle grid line colour for the minor subdivision. */
  gridMinor: "#8a9098",
  /** Stronger grid line colour for the major subdivision. */
  gridMajor: "#5c636c",
  /** Default clay material colour for generic props and geometry. */
  clay: "#d8dce2",
  /** Warm clay tone reserved for humanoid characters. */
  human: "#d19a3a",
  /** Neutral clay tone for prop objects. */
  prop: "#d8dce2",
  /** Purple accent for articulated helper geometry. */
  articulation: "#6f36a1",
} as const;
