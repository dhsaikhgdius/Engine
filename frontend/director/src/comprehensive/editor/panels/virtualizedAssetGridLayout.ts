/** Matches `--asset-library-card-min-size` and the CSS grid `auto-fill` track. */
export const ASSET_LIBRARY_CARD_MIN_WIDTH = 88;

/** Horizontal gap between asset library cards in the grid. */
export const ASSET_LIBRARY_COLUMN_GAP = 8;

/** Vertical gap between asset library rows in the grid. */
export const ASSET_LIBRARY_ROW_GAP = 10;

/** Combined left and right padding applied to the asset library viewport. */
export const ASSET_LIBRARY_HORIZONTAL_PADDING = 32;

/** Height reserved for the label area below each card. */
export const ASSET_LIBRARY_CARD_LABEL_HEIGHT = 34;

/**
 * Computes how many grid columns fit in the given viewport width.
 *
 * @param width - The available viewport width in pixels.
 * @returns The number of columns (at least 1). Non-finite or
 *   non-positive widths are clamped to a single column.
 */
export function getAssetLibraryColumnCount(width: number) {
  if (!Number.isFinite(width) || width <= 0) return 1;
  const availableWidth = Math.max(ASSET_LIBRARY_CARD_MIN_WIDTH, width - ASSET_LIBRARY_HORIZONTAL_PADDING);
  return Math.max(
    1,
    Math.floor((availableWidth + ASSET_LIBRARY_COLUMN_GAP) / (ASSET_LIBRARY_CARD_MIN_WIDTH + ASSET_LIBRARY_COLUMN_GAP)),
  );
}

/**
 * Computes the pixel width of each card for the given viewport and
 * column count.
 *
 * @param width - The available viewport width in pixels.
 * @param columnCount - The number of columns, typically from
 *   {@link getAssetLibraryColumnCount}.
 * @returns The card width in pixels, distributed evenly across columns
 *   after accounting for gaps.
 */
export function getAssetLibraryCardWidth(width: number, columnCount = getAssetLibraryColumnCount(width)) {
  const availableWidth = Math.max(ASSET_LIBRARY_CARD_MIN_WIDTH, width - ASSET_LIBRARY_HORIZONTAL_PADDING);
  const gaps = Math.max(0, columnCount - 1) * ASSET_LIBRARY_COLUMN_GAP;
  return (availableWidth - gaps) / Math.max(1, columnCount);
}

/**
 * Computes the total row height for virtualized layout, including the
 * card, its label, and the row gap.
 *
 * @param width - The available viewport width in pixels.
 * @param columnCount - The number of columns, typically from
 *   {@link getAssetLibraryColumnCount}.
 * @returns The row height in pixels.
 */
export function getAssetLibraryRowSize(width: number, columnCount = getAssetLibraryColumnCount(width)) {
  return getAssetLibraryCardWidth(width, columnCount) + ASSET_LIBRARY_CARD_LABEL_HEIGHT + ASSET_LIBRARY_ROW_GAP;
}

/**
 * Reads the usable viewport width from a DOM element, preferring the
 * border-box width and falling back to the content-box width.
 *
 * @param element - The DOM element whose viewport width to measure.
 * @returns The rounded pixel width, or `0` when the element has no
 *   measurable width.
 */
export function readAssetLibraryViewportWidth(element: HTMLElement) {
  const borderBox = element.getBoundingClientRect().width;
  const contentBox = element.clientWidth;
  const width = borderBox > 0 ? borderBox : contentBox;
  return width > 0 ? Math.round(width) : 0;
}
