/**
 * Browser-side film-role gate for Stage authoring controls.
 *
 * The gateway exposes its configured Director film role at
 * `GET /api/control-plane/film-role` (same `DIRECTOR_FILM_ROLE` source that
 * governs `POST /api/tools/*`), and this module applies the exact same
 * `roleAllowsTool` allow-table from `@director/protocol/film-role-tool-policy`
 * so a role that cannot author over HTTP also cannot author through the UI.
 *
 * Read-only work (observe, capture, playback, selection) stays enabled; only
 * write controls consult {@link stageAuthoringAllowed}.
 */

import { useEffect, useSyncExternalStore } from "react";
import { z } from "zod";
import { isFilmRoleId } from "@director/protocol/film-roles";
import { roleAllowsTool } from "@director/protocol/film-role-tool-policy";
import { directorControlPlaneFetch } from "./directorControlPlaneClient";

/**
 * Whether a film role may author the Director Stage — the same decision the
 * gateway makes for `director_workbench {op:"author"}`.
 *
 * @param role - The gateway-reported role value, or `null` when no role is set.
 * @returns `true` for no role (unrestricted); `false` for read-only roles like
 * `visual-critic` and for unrecognized role values (fail closed, matching the
 * policy's read-only fallback for unknown roles).
 */
export function stageAuthoringAllowedForRole(role: string | null | undefined): boolean {
  if (!role) return true;
  if (!isFilmRoleId(role)) return false;
  return roleAllowsTool(role, "director_workbench", { op: "author" });
}

type FilmRoleGateState = {
  /** The gateway-reported film role, or `null` when unrestricted/not yet known. */
  role: string | null;
  /** True once the gateway answered (or definitively failed). */
  loaded: boolean;
};

let state: FilmRoleGateState = { role: null, loaded: false };
let loadPromise: Promise<void> | null = null;
const listeners = new Set<() => void>();

function setState(next: FilmRoleGateState) {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return state;
}

const filmRoleResponseSchema = z.looseObject({ role: z.string().nullable() });

/**
 * Fetches the gateway film role once per page load. An unreachable gateway
 * keeps the unrestricted default so a local editor never locks itself out.
 */
export function loadDirectorFilmRole(): Promise<void> {
  loadPromise ??= (async () => {
    try {
      const response = await directorControlPlaneFetch("/api/control-plane/film-role");
      const payload = filmRoleResponseSchema.safeParse(await response.json().catch(() => ({})));
      const role = response.ok && payload.success && payload.data.role?.trim() ? payload.data.role.trim() : null;
      setState({ role, loaded: true });
    } catch {
      setState({ role: state.role, loaded: true });
    }
  })();
  return loadPromise;
}

/** The last known gateway film role (synchronous; `null` until loaded). */
export function directorFilmRole(): string | null {
  return state.role;
}

/**
 * Synchronous authoring gate for non-React call sites (the UI authoring
 * dispatch chokepoint). Kicks off the role fetch on first use and answers
 * from the last known role — unrestricted until the gateway reports a role.
 */
export function stageAuthoringAllowed(): boolean {
  void loadDirectorFilmRole();
  return stageAuthoringAllowedForRole(state.role);
}

/**
 * React gate for Stage write controls: `canAuthor` is `false` when the
 * gateway film role (e.g. `visual-critic`) may not author the Stage.
 */
export function useStageAuthoringGate() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    void loadDirectorFilmRole();
  }, []);
  return { role: snapshot.role, loaded: snapshot.loaded, canAuthor: stageAuthoringAllowedForRole(snapshot.role) };
}

/** Resets the gate and optionally primes a role without a gateway round trip. Tests only. */
export function resetFilmRoleGateForTests(role: string | null = null) {
  loadPromise = role === null ? null : Promise.resolve();
  setState({ role, loaded: role !== null });
}
