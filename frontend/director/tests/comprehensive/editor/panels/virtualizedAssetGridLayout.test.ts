import { expect, it } from "vitest";
import {
  getAssetLibraryCardWidth,
  getAssetLibraryColumnCount,
  getAssetLibraryRowSize,
  readAssetLibraryViewportWidth,
} from "../../../../src/comprehensive/editor/panels/virtualizedAssetGridLayout";

it("keeps two cards in a typical narrow side panel", () => {
  expect(getAssetLibraryColumnCount(248)).toBe(2);
  expect(getAssetLibraryColumnCount(260)).toBe(2);
});

it("adds columns as the asset library grows instead of stretching two cards", () => {
  expect(getAssetLibraryColumnCount(400)).toBe(3);
  expect(getAssetLibraryColumnCount(520)).toBe(5);
  expect(getAssetLibraryColumnCount(657)).toBe(6);
  expect(getAssetLibraryColumnCount(900)).toBe(9);
});

it("sizes cards to fill the row without dropping below the CSS minimum", () => {
  const width = 657;
  const columns = getAssetLibraryColumnCount(width);
  const cardWidth = getAssetLibraryCardWidth(width, columns);
  expect(columns).toBe(6);
  expect(cardWidth).toBeGreaterThanOrEqual(88);
  expect(cardWidth).toBeLessThan(120);
  expect(getAssetLibraryRowSize(width, columns)).toBe(cardWidth + 44);
});

it("prefers the visible border box so size containment cannot pin a 248px fallback", () => {
  const element = {
    clientWidth: 248,
    getBoundingClientRect: () => ({ width: 657 }),
  } as HTMLElement;

  expect(readAssetLibraryViewportWidth(element)).toBe(657);
});
