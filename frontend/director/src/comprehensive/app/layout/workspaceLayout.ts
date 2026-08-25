/*
 * The workspace shell follows the layout used by Flier123/agentic-3d-director
 * at a939ec5fd84ae32fcbb3b6b6cb5865216f6d7195.
 * Copyright (c) 2026 YZ. Used and modified under the MIT License.
 */

/** Minimum width (px) of the left scene-tree panel. */
export const MIN_LEFT_PANEL_WIDTH = 176;
// The shell applies a second, viewport-aware cap so expanded scene trees can
// be wide without taking away the last usable slice of the director viewport.
/** Maximum width (px) of the left scene-tree panel before the viewport cap applies. */
export const MAX_LEFT_PANEL_WIDTH = 640;
/** Minimum width (px) of the right inspector panel. */
export const MIN_RIGHT_PANEL_WIDTH = 240;
/** Maximum width (px) of the right inspector panel before the viewport cap applies. */
export const MAX_RIGHT_PANEL_WIDTH = 680;
/** Minimum width (px) reserved for the director viewport itself. */
export const MIN_DIRECTOR_VIEWPORT_WIDTH = 320;
/** Minimum height (px) of the timeline dock. */
export const MIN_TIMELINE_HEIGHT = 180;
/** Maximum height (px) of the timeline dock before the viewport cap applies. */
export const MAX_TIMELINE_HEIGHT = 540;
/** Click vs drag on a workspace sash. Below this (px), pointer-up is a click. */
export const PANEL_SASH_CLICK_DRAG_THRESHOLD_PX = 6;
/** Extra pull past the minimum before the bottom dock collapses. */
export const TIMELINE_COLLAPSE_OVERDRAG_PX = 12;
/** Extra pull past the minimum before the right inspector column collapses. */
export const RIGHT_PANEL_COLLAPSE_OVERDRAG_PX = 12;

/** The three tabs shown in the right inspector column. */
export type RightPanelMode = "properties" | "modeling" | "assets";

/**
 * Normalizes a raw string into a known right-panel mode.
 * Unrecognized values fall back to "properties".
 *
 * @param mode - A raw string, typically from a URL search param.
 * @returns A valid `RightPanelMode`.
 */
export function normalizeRightPanelMode(mode: string | undefined): RightPanelMode {
  switch (mode) {
    case "modeling":
    case "assets":
    case "properties":
      return mode;
    default:
      return "properties";
  }
}

/** Immutable snapshot of the workspace shell's panel sizes and visibility. */
export interface DirectorWorkspaceLayout {
  /** Left scene-tree panel width in px. */
  leftPanelWidth: number;
  /** Right inspector panel width in px. */
  rightPanelWidth: number;
  /** Whether the right panel is collapsed entirely. */
  rightPanelCollapsed: boolean;
  /** Which tab is active in the right panel. */
  rightPanelMode: RightPanelMode;
  /** Whether the timeline dock is collapsed. */
  timelineCollapsed: boolean;
  /** Timeline dock height in px. */
  timelineHeight: number;
  /** Whether the workspace is rendered without the top bar and side panels. */
  frameless: boolean;
}

/** Default layout applied on first launch before any persisted state is loaded. */
export const DEFAULT_DIRECTOR_WORKSPACE_LAYOUT: DirectorWorkspaceLayout = {
  leftPanelWidth: 220,
  rightPanelWidth: 260,
  rightPanelCollapsed: true,
  rightPanelMode: "properties",
  timelineCollapsed: true,
  timelineHeight: 238,
  frameless: false,
};

/**
 * Returns the visible width of the right sidebar, accounting for collapse state.
 *
 * @param layout - The current workspace layout.
 * @returns 0 when collapsed, otherwise the panel width.
 */
export function getVisibleRightSidebarWidth(layout: DirectorWorkspaceLayout) {
  return layout.rightPanelCollapsed ? 0 : layout.rightPanelWidth;
}

/**
 * Clamps a panel size value to a [minimum, maximum] range, rounding to the
 * nearest integer. Non-finite values are clamped to the minimum.
 *
 * @param value - The raw size value to clamp.
 * @param minimum - The lower bound.
 * @param maximum - The upper bound.
 * @returns The clamped, rounded integer value.
 */
export function clampWorkspaceSize(value: number, minimum: number, maximum: number) {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

/**
 * Computes the maximum timeline height allowed for a given viewport height,
 * reserving space for the viewport itself.
 *
 * @param viewportHeight - The available viewport height in px.
 * @returns The maximum timeline height, clamped to [MIN_TIMELINE_HEIGHT, MAX_TIMELINE_HEIGHT].
 */
export function getMaximumTimelineHeight(viewportHeight: number) {
  return Math.max(MIN_TIMELINE_HEIGHT, Math.min(MAX_TIMELINE_HEIGHT, Math.round(viewportHeight - 140)));
}

/**
 * Computes the maximum right panel width allowed for a given viewport width,
 * reserving space for the left panel and the director viewport.
 *
 * @param viewportWidth - The available viewport width in px.
 * @param leftPanelWidth - The current left panel width in px.
 * @returns The maximum right panel width, clamped to [MIN_RIGHT_PANEL_WIDTH, MAX_RIGHT_PANEL_WIDTH].
 */
export function getMaximumRightPanelWidth(viewportWidth: number, leftPanelWidth: number) {
  const viewportMaximum = viewportWidth - leftPanelWidth - MIN_DIRECTOR_VIEWPORT_WIDTH;
  return Math.max(MIN_RIGHT_PANEL_WIDTH, Math.min(MAX_RIGHT_PANEL_WIDTH, Math.round(viewportMaximum)));
}
