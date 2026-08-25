/**
 * Deterministic fingerprints over the workbench document (project + UI
 * state). Reuses the existing project revision canonicalization and the
 * synchronous browser-safe SHA-256, so fingerprints are stable across key
 * ordering, blob/data-url payload bytes, and -0 versus 0.
 */
import { stableLexicalJson } from "@director/protocol/stable-json";
import type { DirectorProject } from "../schema/directorProject";
import { canonicalizeDirectorProjectForRevision, sha256HexSync } from "../schema/directorProjectRevision";
import { directorUiStateSchema, type DirectorUiState } from "@director/protocol/workbench-ui";
import type { DirectorStore } from "../store/directorStore";

/** Contract identifier embedded in every session fingerprint for version-aware verification. */
export const DIRECTOR_SESSION_FINGERPRINT_CONTRACT = "director-session-fingerprint:v1" as const;

/** The workbench document covered by session fingerprints. */
export interface DirectorWorkbenchStateSnapshot {
  project: DirectorProject;
  ui: DirectorUiState;
}

/**
 * The UI slice is flattened into the Director store state; the strict UI
 * protocol schema is the authoritative field list, so picking by its keys
 * cannot drift from the executor's own workbench document shape.
 */
const UI_STATE_KEYS = Object.keys(directorUiStateSchema.shape) as Array<keyof DirectorUiState>;

/**
 * Picks the UI state fields from the Director store using the strict UI protocol schema as the authoritative key list.
 * This ensures the picked fields never drift from the executor's own workbench document shape.
 *
 * @param state - The Director store state to pick from.
 * @returns A validated UI state snapshot.
 */
export function pickDirectorWorkbenchUiState(state: DirectorStore): DirectorUiState {
  const picked: Record<string, unknown> = {};
  for (const key of UI_STATE_KEYS) picked[key] = state[key];
  return directorUiStateSchema.parse(picked);
}

/** Deep-cloned {project, ui} snapshot suitable for seeding a later replay. */
export function captureDirectorWorkbenchSnapshot(state: DirectorStore): DirectorWorkbenchStateSnapshot {
  return structuredClone({ project: state.project, ui: pickDirectorWorkbenchUiState(state) });
}

/**
 * world.effects[*].createdAt is stamped from the wall clock inside the
 * authoring path (add_world_effect), so it can never re-execute to the same
 * value. It is diagnostic provenance rather than scene truth, and it is the
 * only wall-clock value written into project state by the typed operation
 * path, so the session fingerprint excludes exactly that field.
 */
function withoutVolatileProjectFields(project: DirectorProject): DirectorProject {
  if (!project.world || project.world.effects.length === 0) return project;
  const clone = structuredClone(project);
  for (const effect of clone.world?.effects ?? []) {
    delete (effect as { createdAt?: string }).createdAt;
  }
  return clone;
}

/**
 * Computes a deterministic SHA-256 fingerprint over the given workbench snapshot.
 * Volatile fields (wall-clock timestamps in world effects) are excluded so the
 * fingerprint is stable across sessions with identical scene content.
 *
 * @param snapshot - The {project, ui} snapshot to fingerprint.
 * @returns A fingerprint string like "director-session-fingerprint:v1:sha256:<hex>".
 */
export function computeDirectorSessionFingerprint(snapshot: DirectorWorkbenchStateSnapshot): string {
  const canonicalProject = canonicalizeDirectorProjectForRevision(withoutVolatileProjectFields(snapshot.project));
  const canonicalUi = stableLexicalJson(snapshot.ui);
  return `${DIRECTOR_SESSION_FINGERPRINT_CONTRACT}:sha256:${sha256HexSync(`${canonicalProject}\n${canonicalUi}`)}`;
}

/**
 * Convenience wrapper that picks the UI state and computes the fingerprint from a live store reference.
 *
 * @param state - The Director store state.
 * @returns A fingerprint string.
 */
export function computeDirectorSessionFingerprintFromState(state: DirectorStore): string {
  return computeDirectorSessionFingerprint({ project: state.project, ui: pickDirectorWorkbenchUiState(state) });
}
