/**
 * Category palette for the "semantic" render pass (ControlNet-style semantic
 * segmentation). Unlike the instance-level object-id pass, every mesh of the
 * same category shares one flat color. The exact mapping ships with each
 * capture as `metadata.categoryToRgb`, so downstream tools must read it from
 * there instead of hard-coding these bytes.
 *
 * Colors are high-distinction pure hues; "character" follows the ADE20K
 * person convention (150, 5, 61). "background" documents the clear color of
 * pixels with no rendered geometry.
 */
/** The four semantic segmentation categories supported by the semantic render pass. */
export const DIRECTOR_SEMANTIC_CATEGORIES = ["character", "prop", "environment", "background"] as const;

/** Union of the four semantic category string literals. */
export type DirectorSemanticCategory = (typeof DIRECTOR_SEMANTIC_CATEGORIES)[number];

/** RGB values are exact unsigned bytes written to the data-color-space target. */
export const DIRECTOR_SEMANTIC_PALETTE: Record<DirectorSemanticCategory, readonly [number, number, number]> = {
  character: [150, 5, 61],
  prop: [0, 102, 200],
  environment: [4, 200, 3],
  background: [0, 0, 0],
};

/** Fresh mutable copy of the palette for per-capture metadata. */
export function createDirectorSemanticCategoryColorMap(): Record<DirectorSemanticCategory, [number, number, number]> {
  return Object.fromEntries(
    DIRECTOR_SEMANTIC_CATEGORIES.map((category) => [category, [...DIRECTOR_SEMANTIC_PALETTE[category]]]),
  ) as Record<DirectorSemanticCategory, [number, number, number]>;
}
