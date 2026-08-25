import type { DirectorWorkspaceMode } from "../../editor/workspaces/directorWorkspaceStore";

/**
 * Top-bar workspace identifier.
 * Agent is a full chat surface, not a protocol workspace.
 */
export type DirectorAppWorkspace = DirectorWorkspaceMode | "agent";

/** Every workspace tab shown in the top bar, in display order. */
export const DIRECTOR_APP_WORKSPACES = ["canvas", "stage", "video", "agent"] as const satisfies readonly DirectorAppWorkspace[];

/**
 * Normalizes a raw query-parameter value into a valid workspace identifier.
 * The legacy "gallery" value is mapped to "stage".
 *
 * @param value - A raw string from a URL search param or similar source.
 * @returns A valid workspace identifier, or `null` when the value is unrecognized.
 */
export function parseDirectorAppWorkspace(value: string | null | undefined): DirectorAppWorkspace | null {
  if (value === "gallery") return "stage";
  if (value === "canvas" || value === "stage" || value === "video" || value === "agent") return value;
  return null;
}

/**
 * Reads the current workspace from the `workspace` URL search parameter.
 *
 * @returns A valid workspace identifier, or `null` when the parameter is missing,
 *          invalid, or called outside the browser.
 */
export function readDirectorAppWorkspaceFromLocation(): DirectorAppWorkspace | null {
  if (typeof window === "undefined") return null;
  return parseDirectorAppWorkspace(new URLSearchParams(window.location.search).get("workspace"));
}

/**
 * Writes a workspace identifier to the `workspace` URL search parameter
 * via `pushState`, so it becomes part of the browser history entry.
 *
 * @param mode - The workspace to persist into the URL.
 */
export function writeDirectorAppWorkspaceToLocation(mode: DirectorAppWorkspace) {
  const url = new URL(window.location.href);
  url.searchParams.set("workspace", mode);
  window.history.pushState(window.history.state, "", url);
}

/**
 * Type guard that narrows an app workspace to a creative (non-agent) workspace.
 *
 * @param mode - Any workspace identifier.
 */
export function isDirectorCreativeWorkspace(mode: DirectorAppWorkspace): mode is DirectorWorkspaceMode {
  return mode !== "agent";
}
