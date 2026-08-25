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

let currentRole: string | null = null;
let loadPromise: Promise<void> | null = null;
const listeners = new Set<() => void>();

/** Notifies subscribers only on a real role change so idle loads never rerender. */
function setRole(next: string | null) {
  if (next === currentRole) return;
  currentRole = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return currentRole;
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
      if (response.ok && payload.success) setRole(payload.data.role?.trim() || null);
    } catch {
      // Keep the last known role; the unrestricted default stays in place.
    }
  })();
  return loadPromise;
}

/** The last known gateway film role (synchronous; `null` until loaded). */
export function directorFilmRole(): string | null {
  return currentRole;
}

/**
 * Synchronous authoring gate for non-React call sites (the UI authoring
 * dispatch chokepoint). Kicks off the role fetch on first use and answers
 * from the last known role — unrestricted until the gateway reports a role.
 */
export function stageAuthoringAllowed(): boolean {
  void loadDirectorFilmRole();
  return stageAuthoringAllowedForRole(currentRole);
}

/**
 * React gate for Stage write controls: `canAuthor` is `false` when the
 * gateway film role (e.g. `visual-critic`) may not author the Stage.
 */
export function useStageAuthoringGate() {
  const role = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    void loadDirectorFilmRole();
  }, []);
  return { role, canAuthor: stageAuthoringAllowedForRole(role) };
}

/** Resets the gate and optionally primes a role without a gateway round trip. Tests only. */
export function resetFilmRoleGateForTests(role: string | null = null) {
  loadPromise = role === null ? null : Promise.resolve();
  setRole(role);
}
