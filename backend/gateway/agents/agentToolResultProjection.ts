import { asRecord } from "../../../packages/protocol/src/primitives";

/**
 * Model-facing tool result JSON above this byte count is summarized and
 * optionally spilled to disk to keep the conversation context lean.
 */
export const DIRECTOR_AGENT_TOOL_RESULT_BUDGET_BYTES = 12_288;

/**
 * Top-level result arrays larger than this are treated as a "heavy collection"
 * dump and summarized, even when the total byte budget is not exceeded.
 */
export const DIRECTOR_AGENT_HEAVY_COLLECTION_LIMIT = 48;

/** Maximum number of ids to sample from a heavy collection. */
const RESULT_ID_SAMPLE = 24;
/** Maximum number of feedback objects to retain when trimming. */
const FEEDBACK_OBJECT_SAMPLE = 8;
/** Maximum number of actionable audit issues retained in model context. */
const AUDIT_ISSUE_SAMPLE = 12;
/** Maximum characters for a scalar value before truncation. */
const MAX_SCALAR_CHARS = 2_000;

/**
 * Metadata keys that are always preserved verbatim in slimmed results.
 * These fields carry structural information that is small and useful for
 * the model regardless of the overall result size.
 */
const METADATA_KEYS = [
  "project_revision",
  "project_revision_before",
  "turn_id",
  "idempotency_key",
  "audit_token",
  "active_camera_id",
  "mode",
  "match_count",
  "returned_count",
  "reference_point",
  "requested_fields",
  "counts",
  "ready",
  "summary",
  "issue_count",
  "error_count",
  "warning_count",
  "code",
  "notes",
  "suggested_next",
  "object_id",
  "camera_id",
  "capture_requested",
  "capture",
  "pipeline_advisories",
  "outcomes",
  "stale_after_capture",
  "replay_stale",
  "stdout",
  "stderr",
  "content",
  "exitCode",
  "signal",
  "timedOut",
  "timeoutMs",
  "truncated",
  "sandboxDenied",
  "sandboxBackend",
  "workdir",
] as const;

/**
 * The reason a tool result was projected into a slimmed form.
 */
export type DirectorAgentToolProjectionReason = "heavy_collection" | "over_budget";

/**
 * A reference to a tool result that was spilled to disk.
 */
export type DirectorAgentToolSpillRef = {
  locator: string;
  bytes: number;
};

/**
 * The result of projecting a tool result — either the original envelope or a
 * slimmed version, plus whether a spill occurred.
 */
export type DirectorAgentToolProjection = {
  envelope: Record<string, unknown>;
  spilled: boolean;
  reason: DirectorAgentToolProjectionReason | null;
};

/**
 * Options for finalizing (projecting and optionally spilling) a tool envelope.
 */
export type FinalizeDirectorAgentToolEnvelopeOptions = {
  envelope: Record<string, unknown>;
  tool: string;
  input: unknown;
  /** Optional spill function for persisting oversize payloads. */
  saveSpill?: (payload: unknown) => Promise<DirectorAgentToolSpillRef | null>;
};

/**
 * Advisory text injected into slimmed results — tells the model to use
 * targeted `observe` calls rather than requesting the full dump.
 */
const RETRIEVAL_HINT =
  "Compact observation for the model. Pass observe fields (counts, objects, cameras, …) or inspect {entity, id} for details. Do not request the full dump back into the conversation.";
const CREATIVE_RETRIEVAL_HINT =
  'Compact Creative workspace snapshot. snapshot.counts are complete. observe accepts only {"op":"observe"}; do not add fields. Use capabilities before an unfamiliar edit. Omitted payloads are internal and cannot be read with bash.';
const BASH_RETRIEVAL_HINT =
  "Bash output was compacted. Re-run a narrower command or redirect output to a workspace file and read a focused window.";

/**
 * Computes the UTF-8 byte length of any JSON-serializable value.
 *
 * @param value - The value to measure.
 * @returns The byte length of its JSON representation.
 */
export function utf8ByteLength(value: unknown): number {
  return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8");
}

/**
 * Selects the model-facing fields from a tool result envelope.
 *
 * Drops internal gateway fields and keeps only the fields the model needs
 * to interpret the result.
 *
 * @param result - The raw tool result.
 * @returns A model-facing envelope.
 */
export function directorAgentModelEnvelope(result: Record<string, unknown>): Record<string, unknown> {
  const inner = asRecord(result.result);
  const feedback = normalizeFeedbackCounts(inner, result.feedback);
  return {
    success: result.success,
    code: result.code,
    result: result.result,
    error: result.error,
    feedback,
    target: result.target,
    agent_boundary: result.agent_boundary,
    outcomes: result.outcomes,
  };
}

function normalizeFeedbackCounts(inner: Record<string, unknown> | null, feedback: unknown): unknown {
  const counts = asRecord(inner?.counts);
  const record = asRecord(feedback);
  const sceneHint = asRecord(record?.scene_hint);
  if (!counts || !record || !sceneHint) return feedback;

  const nextSceneHint = { ...sceneHint };
  if (typeof counts.objects === "number") nextSceneHint.object_count = counts.objects;
  if (typeof counts.tracks === "number") nextSceneHint.track_count = counts.tracks;
  if (
    typeof counts.cameras === "number" &&
    Array.isArray(nextSceneHint.camera_ids) &&
    nextSceneHint.camera_ids.length !== counts.cameras
  ) {
    delete nextSceneHint.camera_ids;
  }
  return { ...record, scene_hint: nextSceneHint };
}

/**
 * Truncates a scalar value that exceeds the maximum character limit.
 *
 * Appends a `[truncated N chars]` suffix so the model knows data was cut.
 */
function truncateScalar(value: unknown): unknown {
  if (typeof value !== "string" || value.length <= MAX_SCALAR_CHARS) return value;
  return `${value.slice(0, MAX_SCALAR_CHARS)}…[truncated ${value.length - MAX_SCALAR_CHARS} chars]`;
}

/**
 * Samples up to `limit` ids from an array of objects.
 *
 * Looks for `id`, `object_id`, or plain string items.
 */
function sampleIds(items: unknown[], limit = RESULT_ID_SAMPLE): string[] {
  const ids: string[] = [];
  for (const item of items) {
    const record = asRecord(item);
    const id =
      typeof record?.id === "string"
        ? record.id
        : typeof record?.object_id === "string"
          ? record.object_id
          : typeof item === "string"
            ? item
            : null;
    if (!id) continue;
    ids.push(id);
    if (ids.length >= limit) break;
  }
  return ids;
}

/**
 * Returns the keys of result arrays that exceed the heavy-collection limit.
 */
function heavyCollectionKeys(inner: Record<string, unknown>): string[] {
  return Object.entries(inner)
    .filter(([, value]) => Array.isArray(value) && value.length > DIRECTOR_AGENT_HEAVY_COLLECTION_LIMIT)
    .map(([key]) => key);
}

/**
 * Determines whether a tool result envelope needs projection.
 *
 * A result needs projection if it has any heavy collection arrays or if its
 * total byte budget is exceeded.
 *
 * @param envelope - The model-facing envelope.
 * @param _context - Optional tool context (reserved for future use).
 * @returns Whether projection is needed and the reason.
 */
export function directorAgentToolResultNeedsProjection(
  envelope: Record<string, unknown>,
  _context?: { tool: string; input: unknown },
): { needed: boolean; reason: DirectorAgentToolProjectionReason | null } {
  const inner = asRecord(envelope.result);
  if (inner) {
    const heavy = heavyCollectionKeys(inner);
    if (heavy.length) return { needed: true, reason: "heavy_collection" };
  }
  if (utf8ByteLength(envelope) > DIRECTOR_AGENT_TOOL_RESULT_BUDGET_BYTES) {
    return { needed: true, reason: "over_budget" };
  }
  return { needed: false, reason: null };
}

/**
 * Slims a heavy collection array to a count + id sample.
 */
function slimCollection(value: unknown[]) {
  const ids = sampleIds(value);
  return {
    count: value.length,
    ids,
    omitted: Math.max(0, value.length - ids.length),
  };
}

/**
 * Extracts selected object ids from the UI context in the result.
 */
function selectedObjectIds(inner: Record<string, unknown>): string[] | undefined {
  const ui = asRecord(inner.ui);
  if (!Array.isArray(ui?.selectedObjectIds)) return undefined;
  const ids = ui.selectedObjectIds.filter((id): id is string => typeof id === "string").slice(0, RESULT_ID_SAMPLE);
  return ids.length ? ids : undefined;
}

function compactCreativeCollection(value: unknown, keys: readonly string[]) {
  const values = Array.isArray(value) ? value : [];
  const items = values.slice(0, RESULT_ID_SAMPLE).flatMap((entry) => {
    const record = asRecord(entry);
    if (!record) return [];
    const selected: Record<string, unknown> = {};
    for (const key of keys) {
      if (record[key] !== undefined) selected[key] = truncateScalar(record[key]);
    }
    return Object.keys(selected).length ? [selected] : [];
  });
  return { count: values.length, items, omitted: Math.max(0, values.length - items.length) };
}

function compactCreativeTracks(value: unknown) {
  const tracks = Array.isArray(value) ? value : [];
  const items = tracks.slice(0, RESULT_ID_SAMPLE).flatMap((entry) => {
    const track = asRecord(entry);
    if (!track) return [];
    const clips = Array.isArray(track.clips) ? track.clips : [];
    return [
      {
        id: track.id,
        name: truncateScalar(track.name),
        kind: track.kind,
        muted: track.muted,
        locked: track.locked,
        visible: track.visible,
        clip_count: clips.length,
        clip_ids: sampleIds(clips),
      },
    ];
  });
  return { count: tracks.length, items, omitted: Math.max(0, tracks.length - items.length) };
}

function compactCreativeObserveResult(
  inner: Record<string, unknown>,
  reason: DirectorAgentToolProjectionReason,
): Record<string, unknown> | null {
  if (inner.op !== "observe") return null;
  const snapshot = asRecord(inner.snapshot);
  if (!snapshot) return null;
  const board = asRecord(snapshot.board) ?? {};
  const dag = asRecord(board.dag);
  const edit = asRecord(snapshot.edit) ?? {};
  const media = asRecord(snapshot.media) ?? {};
  const gallery = asRecord(snapshot.gallery) ?? {};

  return {
    op: "observe",
    observe_mode: "summary",
    projection_reason: reason,
    retrieval_hint: CREATIVE_RETRIEVAL_HINT,
    snapshot: {
      version: snapshot.version,
      workspace: snapshot.workspace,
      counts: snapshot.counts,
      selection: snapshot.selection,
      board: {
        nodes: compactCreativeCollection(board.nodes, ["id", "kind", "title", "media_id"]),
        edges: compactCreativeCollection(board.edges, ["id", "source_node_id", "target_node_id"]),
        pipeline_runs: compactCreativeCollection(board.pipeline_runs, ["id", "status"]),
        dag: dag
          ? {
              valid: dag.valid,
              root_ids: Array.isArray(dag.roots) ? dag.roots.slice(0, RESULT_ID_SAMPLE) : [],
              leaf_ids: Array.isArray(dag.leaves) ? dag.leaves.slice(0, RESULT_ID_SAMPLE) : [],
              issue_count: Array.isArray(dag.issues) ? dag.issues.length : 0,
            }
          : undefined,
        viewport: board.viewport,
      },
      edit: {
        tracks: compactCreativeTracks(edit.tracks),
        settings: edit.settings,
        playhead_sec: edit.playhead_sec,
        timeline_zoom: edit.timeline_zoom,
      },
      media: {
        status: media.status,
        storage_mode: media.storage_mode,
        warning: truncateScalar(media.warning),
        error: truncateScalar(media.error),
        assets: compactCreativeCollection(media.assets, ["id", "media_id", "name", "kind", "type"]),
      },
      gallery: {
        media: compactCreativeCollection(gallery.media, ["id", "media_id", "custom_name", "name", "type"]),
        folders: compactCreativeCollection(gallery.folders, ["id", "name", "parent_id"]),
        preferences: gallery.preferences,
      },
    },
  };
}

function compactCreativeFeedback(feedback: unknown): unknown {
  const record = asRecord(feedback);
  if (!record) return feedback;
  return {
    changed: record.changed,
    available_refs: record.available_refs,
  };
}

/**
 * Produces a slimmed version of a tool result for the model.
 *
 * Retains metadata keys, selected object ids, and small collections;
 * replaces large arrays with count + id samples.
 *
 * @param inner - The inner result object.
 * @param reason - The projection reason.
 * @param spill - Optional spill reference for the full payload.
 * @returns The slimmed result object.
 */
export function slimDirectorAgentToolResult(
  inner: Record<string, unknown>,
  reason: DirectorAgentToolProjectionReason,
  spill?: DirectorAgentToolSpillRef,
): Record<string, unknown> {
  const slim: Record<string, unknown> = {
    observe_mode: "summary",
    projection_reason: reason,
    retrieval_hint: RETRIEVAL_HINT,
  };
  for (const key of METADATA_KEYS) {
    if (inner[key] !== undefined) slim[key] = truncateScalar(inner[key]);
  }
  const selected = selectedObjectIds(inner);
  if (selected) slim.selected_object_ids = selected;
  if (Array.isArray(inner.graph_issues)) slim.graph_issue_count = inner.graph_issues.length;
  const spatialQueryMode = ["frustum", "radius", "aabb", "nearby"].includes(String(inner.mode));
  if (spatialQueryMode && Array.isArray(inner.objects)) {
    slim.objects = inner.objects.slice(0, AUDIT_ISSUE_SAMPLE);
    slim.objects_omitted = Math.max(0, inner.objects.length - AUDIT_ISSUE_SAMPLE);
  }
  if (Array.isArray(inner.issues)) {
    slim.issues = inner.issues.slice(0, AUDIT_ISSUE_SAMPLE).map((value) => {
      const issue = asRecord(value);
      if (!issue) return value;
      return {
        severity: issue.severity,
        code: issue.code,
        message: truncateScalar(issue.message),
        ...(Array.isArray(issue.entity_ids) ? { entity_ids: issue.entity_ids.slice(0, RESULT_ID_SAMPLE) } : {}),
        ...(issue.suggested_fix !== undefined ? { suggested_fix: issue.suggested_fix } : {}),
      };
    });
    slim.issues_omitted = Math.max(0, inner.issues.length - AUDIT_ISSUE_SAMPLE);
  }
  const spatial = asRecord(inner.spatial);
  if (spatial) {
    slim.spatial = {
      counts: spatial.counts,
      placement_count: Array.isArray(spatial.placements) ? spatial.placements.length : undefined,
    };
  }
  const framing = asRecord(inner.framing);
  if (framing) {
    slim.framing = {
      camera_id: framing.camera_id,
      target_id: framing.target_id,
      focal_length_mm: framing.focal_length_mm,
      aspect: framing.aspect,
      evaluated_object_count: framing.evaluated_object_count,
      visible_object_count: framing.visible_object_count,
      issues: Array.isArray(framing.issues) ? framing.issues.slice(0, AUDIT_ISSUE_SAMPLE) : framing.issues,
      suggested_actions: framing.suggested_actions,
      note: truncateScalar(framing.note),
    };
  }
  if (inner.validation !== undefined && utf8ByteLength(inner.validation) <= 2_048) slim.validation = inner.validation;
  for (const [key, value] of Object.entries(inner)) {
    if (METADATA_KEYS.includes(key as (typeof METADATA_KEYS)[number])) continue;
    if (key === "issues") continue;
    if (key === "objects" && spatialQueryMode) continue;
    if (!Array.isArray(value)) continue;
    if (value.length <= DIRECTOR_AGENT_HEAVY_COLLECTION_LIMIT && utf8ByteLength(value) <= 2_048) {
      slim[key] = value;
      continue;
    }
    slim[key] = slimCollection(value);
  }
  if (spill) slim.spill = spill;
  return slim;
}

/**
 * Trims the feedback context when it contains a heavy collection of objects.
 *
 * Only the first {@link FEEDBACK_OBJECT_SAMPLE} objects are kept.
 */
function slimFeedback(feedback: unknown): unknown {
  const record = asRecord(feedback);
  if (!record) return feedback;
  const context = asRecord(record.context);
  if (!context || !Array.isArray(context.objects) || context.objects.length <= DIRECTOR_AGENT_HEAVY_COLLECTION_LIMIT) {
    return feedback;
  }
  return {
    ...record,
    context: {
      ...context,
      objects: context.objects.slice(0, FEEDBACK_OBJECT_SAMPLE),
    },
  };
}

/**
 * Projects a tool envelope into a slimmed form, replacing the result with a
 * summary and optionally attaching a spill reference.
 *
 * @param envelope - The model-facing envelope.
 * @param reason - The projection reason.
 * @param spill - Optional spill reference.
 * @returns The slimmed envelope.
 */
export function projectDirectorAgentToolEnvelope(
  envelope: Record<string, unknown>,
  reason: DirectorAgentToolProjectionReason,
  spill?: DirectorAgentToolSpillRef,
  tool?: string,
): Record<string, unknown> {
  const inner = asRecord(envelope.result) ?? {};
  const creativeResult = tool === "director_creative" ? compactCreativeObserveResult(inner, reason) : null;
  if (creativeResult) {
    return {
      ...envelope,
      result: creativeResult,
      feedback: compactCreativeFeedback(envelope.feedback),
    };
  }
  const result = slimDirectorAgentToolResult(inner, reason, spill);
  if (tool === "bash") result.retrieval_hint = BASH_RETRIEVAL_HINT;
  return {
    ...envelope,
    result,
    feedback: slimFeedback(envelope.feedback),
  };
}

/**
 * Builds the spill payload for a tool result — the full envelope data that
 * is too large to keep in the conversation.
 */
function spillPayload(envelope: Record<string, unknown>, tool: string, input: unknown) {
  return {
    tool,
    input,
    spilled_at: new Date().toISOString(),
    envelope: {
      success: envelope.success,
      code: envelope.code,
      result: envelope.result,
      error: envelope.error,
      feedback: envelope.feedback,
      agent_boundary: envelope.agent_boundary,
    },
  };
}

/**
 * Finalizes a tool envelope — checks whether projection is needed, spills
 * the full payload if configured, and returns the slimmed or original envelope.
 *
 * @param options - The finalization options.
 * @returns The projection result.
 */
export async function finalizeDirectorAgentToolEnvelope(
  options: FinalizeDirectorAgentToolEnvelopeOptions,
): Promise<DirectorAgentToolProjection> {
  const decision = directorAgentToolResultNeedsProjection(options.envelope, {
    tool: options.tool,
    input: options.input,
  });
  if (!decision.needed || !decision.reason) {
    return { envelope: options.envelope, spilled: false, reason: null };
  }

  let spill: DirectorAgentToolSpillRef | undefined;
  if (options.saveSpill) {
    try {
      const saved = await options.saveSpill(spillPayload(options.envelope, options.tool, options.input));
      if (saved) spill = saved;
    } catch {
      // Spill failures are non-fatal — the slimmed envelope is still returned.
      spill = undefined;
    }
  }

  return {
    envelope: projectDirectorAgentToolEnvelope(options.envelope, decision.reason, spill, options.tool),
    spilled: Boolean(spill),
    reason: decision.reason,
  };
}
