/**
 * UI dispatch layer for Director authoring actions.
 *
 * UI mutators and Agent workbench authoring share applyDirectorAuthoringActions;
 * this helper fills revision/idempotency, commits through replaceProject (undoable),
 * and returns a receipt for parity harnesses.
 */

import {
  applyDirectorAuthoringActions,
  type DirectorAuthoringAction,
  type DirectorAuthoringResult,
} from "@director/agent-engine/authoring";
import { getDirectorProjectRevision, type DirectorProject } from "@director/project-schema";
import { directorControlPlaneFetch } from "../comprehensive/editor/api/directorControlPlaneClient";
import { useDirectorStore } from "../comprehensive/editor/store/directorStore";

/**
 * Fire-and-forget ingest of one UI-dispatched authoring apply into the
 * gateway's unified tool audit trail (`POST /api/agent/tool-audit`).
 * The UI mutator must never block on, or fail because of, audit ingest.
 */
function recordUiAuthoringAudit(entry: {
  outcome: "success" | "error";
  idempotencyKey?: string;
  revisionBefore: string;
  revisionAfter?: string;
  code?: string;
}) {
  try {
    void directorControlPlaneFetch("/api/agent/tool-audit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tool: "director_workbench",
        operation: "author",
        source: "ui",
        role: null,
        outcome: entry.outcome,
        revision_before: entry.revisionBefore,
        ...(entry.revisionAfter ? { revision_after: entry.revisionAfter } : {}),
        ...(entry.idempotencyKey ? { idempotency_key: entry.idempotencyKey } : {}),
        ...(entry.code ? { code: entry.code } : {}),
      }),
    }).catch(() => {});
  } catch {
    // Audit ingest is best-effort only.
  }
}

export type DispatchDirectorAuthoringOptions = {
  idempotencyKey?: string;
  expectedRevision?: string;
  force?: boolean;
};

export type DispatchDirectorAuthoringReceipt = {
  ok: true;
  project_revision_before: string;
  project_revision: string;
  idempotency_key: string;
  created: DirectorAuthoringResult["created"];
  updated: DirectorAuthoringResult["updated"];
  deleted: DirectorAuthoringResult["deleted"];
  action_count: number;
  notes: string[];
};

export type DispatchDirectorAuthoringFailure = {
  ok: false;
  error: string;
  project_revision_before: string;
};

/**
 * Compile a Stage UI delete into authoring actions.
 * Matches historical UI semantics: children are detached (not cascade-deleted),
 * and locked objects/layers are force-deleted once the UI already confirmed the delete.
 */
export function compileDirectorDeleteObjectActions(
  project: DirectorProject,
  objectIds: string[],
): DirectorAuthoringAction[] {
  const requested = Array.from(new Set(objectIds)).filter((id) => project.objects.some((object) => object.id === id));
  if (!requested.length) return [];
  const requestedSet = new Set(requested);
  const detachChildren: DirectorAuthoringAction[] = project.objects
    .filter(
      (object) => object.parentObjectId && requestedSet.has(object.parentObjectId) && !requestedSet.has(object.id),
    )
    .map((object) => ({
      action: "update_object" as const,
      object_id: object.id,
      patch: { parent_id: null },
      force: true,
    }));
  return [
    ...detachChildren,
    {
      action: "delete_objects",
      object_ids: requested,
      force: true,
    },
  ];
}

export function dispatchDirectorAuthoringActions(
  actions: DirectorAuthoringAction[],
  options: DispatchDirectorAuthoringOptions = {},
): DispatchDirectorAuthoringReceipt | DispatchDirectorAuthoringFailure {
  if (!actions.length) {
    const projectRevisionBefore = getDirectorProjectRevision(useDirectorStore.getState().project);
    return {
      ok: false,
      error: "No authoring actions to dispatch.",
      project_revision_before: projectRevisionBefore,
    };
  }
  const store = useDirectorStore.getState();
  const before = store.project;
  const projectRevisionBefore = getDirectorProjectRevision(before);
  const idempotencyKey = options.idempotencyKey ?? `ui-author:${crypto.randomUUID()}`;
  if (options.expectedRevision && options.expectedRevision !== projectRevisionBefore) {
    recordUiAuthoringAudit({
      outcome: "error",
      code: "stale_project_revision",
      idempotencyKey,
      revisionBefore: projectRevisionBefore,
    });
    return {
      ok: false,
      error: `Stale project revision (expected ${options.expectedRevision}, current ${projectRevisionBefore}).`,
      project_revision_before: projectRevisionBefore,
    };
  }
  try {
    const authored = applyDirectorAuthoringActions(before, actions);
    store.applyAuthoredProject(authored.project);
    const after = useDirectorStore.getState().project;
    const projectRevision = getDirectorProjectRevision(after);
    recordUiAuthoringAudit({
      outcome: "success",
      idempotencyKey,
      revisionBefore: projectRevisionBefore,
      revisionAfter: projectRevision,
    });
    return {
      ok: true,
      project_revision_before: projectRevisionBefore,
      project_revision: projectRevision,
      idempotency_key: idempotencyKey,
      created: authored.created,
      updated: authored.updated,
      deleted: authored.deleted,
      action_count: authored.action_count,
      notes: authored.notes ?? [],
    };
  } catch (error) {
    recordUiAuthoringAudit({
      outcome: "error",
      idempotencyKey,
      revisionBefore: projectRevisionBefore,
    });
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      project_revision_before: projectRevisionBefore,
    };
  }
}
