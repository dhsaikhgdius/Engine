/**
 * Converts a SessionRecord (sparse, session-time action log) into the
 * packages/protocol episode documents (dense, frame-indexed action track
 * plus a manifest shell).
 *
 * Time mapping is an explicit choice because the two production modes do not
 * share a definition of "frame":
 *
 * - `timeline-playhead` (default): episode frame = the recorded playhead.
 *   Use this for sampled rollouts that render timeline 0..N into a video.
 *   The playhead can scrub backwards, so mapped frames are not monotonic;
 *   events are sorted by (frame, seq) to satisfy the protocol's ascending
 *   order while preserving same-frame sequencing.
 * - `session-elapsed`: episode frame = round((atMs − first atMs) × fps).
 *   Use this when the editing session itself is the recording (a screencast
 *   of the operator/agent). Mixing the two silently would pair actions with
 *   the wrong video frames and destroy causal alignment.
 *
 * Camera poses are resampled with zero-order hold, never interpolated.
 * Session cameras jump discretely; slerp would invent motion that never
 * appeared on screen.
 */
import {
  EPISODE_ACTION_TRACK_CONTRACT,
  EPISODE_MANIFEST_CONTRACT,
  episodeActionTrackSchema,
  episodeManifestSchema,
  validateEpisodeIntegrity,
  type EpisodeActionTrack,
  type EpisodeArtifactRef,
  type EpisodeCaptions,
  type EpisodeIntegrityIssue,
  type EpisodeManifest,
  type EpisodeManifestInput,
  type EpisodeProvenance,
  type EpisodeRenderer,
  type EpisodeSceneRevision,
  type EpisodeSemanticEvent,
  type EpisodeTimebase,
} from "@director/protocol/episode";
import type { DirectorAuthoringAction, DirectorWorkbenchOperation } from "@director/agent-engine";
import type { SessionCameraPoseEntry, SessionRecord, SessionRecordEntry } from "./sessionRecordTypes";

/** How session-record entries map onto episode frames. See the file header for the semantics of each mode. */
export type SessionEpisodeTimeMapping = "timeline-playhead" | "session-elapsed";

export interface ConvertSessionRecordOptions {
  /**
   * How recorded entries map onto episode frames. Defaults to
   * `timeline-playhead`. See the file header for why the modes must not mix.
   */
  timeMapping?: SessionEpisodeTimeMapping;
  /**
   * Explicit episode length. When omitted, derived as max(mapped frame) + 1
   * (at least 1). Must not be smaller than the derived length — truncation
   * would silently drop actions.
   */
  frameCount?: number;
}

/** The result of converting a session record to an episode action track, including frame count and warnings. */
export interface SessionActionTrackConversion {
  actionTrack: EpisodeActionTrack;
  frameCount: number;
  timebase: EpisodeTimebase;
  warnings: string[];
}

/** Required fields for building a complete episode manifest from a session export. */
export interface BuildEpisodeManifestInput {
  id: string;
  projectId: string;
  sceneRevision: EpisodeSceneRevision;
  seed: number;
  timebase: EpisodeTimebase;
  renderer: EpisodeRenderer;
  provenance: EpisodeProvenance;
  artifacts: EpisodeArtifactRef[];
  datasetId?: string;
  quality?: EpisodeManifest["quality"];
}

/**
 * Structured error thrown when session-to-episode conversion fails due to missing
 * wall-clock timestamps, negative frame indices, or insufficient frame counts.
 */
export class SessionEpisodeExportError extends Error {
  readonly code: "missing-at-ms" | "negative-frame" | "frame-count-too-small";

  constructor(code: SessionEpisodeExportError["code"], message: string) {
    super(message);
    this.name = "SessionEpisodeExportError";
    this.code = code;
  }
}

const DEFAULT_FOV_DEGREES = 50;

/**
 * Authoring actions stay attached to their parent `workbench.author` event
 * (the atomic workbench transaction: revision guards, idempotency, batched
 * actions) and are also expanded into `authoring.<action>` children so the
 * training-facing event vocabulary is specific. Expansion is deterministic:
 * parent first, then actions in array order.
 */
function isAuthorOperation(
  operation: DirectorWorkbenchOperation,
): operation is Extract<DirectorWorkbenchOperation, { op: "author" }> {
  return operation.op === "author";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (Array.isArray(value)) {
    const first = value.find((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
    return first;
  }
  return undefined;
}

/**
 * Picks subject/object ids from known authoring fields without enumerating
 * every action variant. Priority is creation id → singular target → first of
 * a target list for subjectId; relational fields (parent, look-at, asset)
 * for objectId.
 */
function authoringEntityIds(action: DirectorAuthoringAction): { subjectId?: string; objectId?: string } {
  const record = asRecord(action);
  if (!record) return {};
  const subjectId =
    firstString(record.id) ??
    firstString(record.object_id) ??
    firstString(record.camera_id) ??
    firstString(record.light_id) ??
    firstString(record.group_id) ??
    firstString(record.effect_id) ??
    firstString(record.body_id) ??
    firstString(record.road_id) ??
    firstString(record.take_id) ??
    firstString(record.sequence_id) ??
    firstString(record.shot_id) ??
    firstString(record.annotation_id) ??
    firstString(record.measurement_id) ??
    firstString(record.target_id) ??
    firstString(record.layer_id) ??
    firstString(record.object_ids) ??
    firstString(record.camera_ids) ??
    firstString(record.light_ids) ??
    firstString(record.effect_ids) ??
    firstString(record.body_ids) ??
    firstString(record.group_ids) ??
    firstString(record.road_ids) ??
    firstString(record.take_ids) ??
    firstString(record.sequence_ids) ??
    firstString(record.shot_ids) ??
    firstString(record.annotation_ids) ??
    firstString(record.measurement_ids) ??
    firstString(record.asset_ids);
  const objectId =
    firstString(record.parent_id) ??
    firstString(record.look_target_object_id) ??
    firstString(record.target_object_id) ??
    firstString(record.asset_id) ??
    firstString(record.clip_id);
  return {
    ...(subjectId ? { subjectId } : {}),
    ...(objectId && objectId !== subjectId ? { objectId } : {}),
  };
}

interface MappedEntry {
  seq: number;
  frame: number;
  entry: SessionRecordEntry;
}

function sessionFps(record: SessionRecord): { numerator: number; denominator: number } {
  return record.timebase.frameRate;
}

function mapEntryFrame(
  entry: SessionRecordEntry,
  mapping: SessionEpisodeTimeMapping,
  originMs: number | null,
  frameRate: { numerator: number; denominator: number },
): number {
  if (mapping === "timeline-playhead") {
    if (!Number.isSafeInteger(entry.frame) || entry.frame < 0) {
      throw new SessionEpisodeExportError(
        "negative-frame",
        `timeline-playhead mapping requires a non-negative integer frame; seq ${entry.seq} has ${entry.frame}`,
      );
    }
    return entry.frame;
  }
  if (entry.atMs === undefined) {
    throw new SessionEpisodeExportError(
      "missing-at-ms",
      `session-elapsed mapping requires atMs on every entry; seq ${entry.seq} is missing it`,
    );
  }
  if (originMs === null) {
    throw new SessionEpisodeExportError("missing-at-ms", "session-elapsed mapping requires atMs on the first entry");
  }
  const frame = Math.round(((entry.atMs - originMs) * frameRate.numerator) / (1000 * frameRate.denominator));
  if (!Number.isSafeInteger(frame) || frame < 0) {
    throw new SessionEpisodeExportError(
      "negative-frame",
      `session-elapsed mapping produced frame ${frame} for seq ${entry.seq}`,
    );
  }
  return frame;
}

function mapRecords(record: SessionRecord, mapping: SessionEpisodeTimeMapping): MappedEntry[] {
  const frameRate = sessionFps(record);
  let originMs: number | null = null;
  if (mapping === "session-elapsed" && record.records.length > 0) {
    const first = record.records[0];
    if (first.atMs === undefined) {
      throw new SessionEpisodeExportError("missing-at-ms", "session-elapsed mapping requires atMs on the first entry");
    }
    originMs = first.atMs;
  }
  return record.records.map((entry) => ({
    seq: entry.seq,
    frame: mapEntryFrame(entry, mapping, originMs, frameRate),
    entry,
  }));
}

function workbenchSubjectId(operation: DirectorWorkbenchOperation): string | undefined {
  const record = asRecord(operation);
  if (!record) return undefined;
  return (
    firstString(record.subject_id) ??
    firstString(record.camera_id) ??
    firstString(record.object_ids) ??
    firstString(record.crowd_id)
  );
}

function semanticEventsFromMapped(mapped: MappedEntry[]) {
  type UnparsedSemanticEvent = Omit<EpisodeSemanticEvent, "payload"> & { payload?: unknown };
  const staged: Array<UnparsedSemanticEvent & { order: number }> = [];
  let order = 0;
  const push = (event: UnparsedSemanticEvent) => {
    staged.push({ ...event, order: order++ });
  };

  for (const item of mapped) {
    const { entry, frame } = item;
    if (entry.kind === "playhead") {
      push({
        frame,
        type: "timeline.playhead",
        payload: { playheadFrame: entry.frame },
      });
      continue;
    }
    if (entry.kind === "camera-pose") continue;
    const operation = entry.operation;
    const subjectId = workbenchSubjectId(operation);
    push({
      frame,
      type: `workbench.${operation.op}`,
      ...(subjectId ? { subjectId } : {}),
      payload: operation,
    });
    if (!isAuthorOperation(operation)) continue;
    for (const action of operation.actions) {
      const ids = authoringEntityIds(action);
      push({
        frame,
        type: `authoring.${action.action}`,
        ...ids,
        payload: action,
      });
    }
  }

  staged.sort((left, right) => left.frame - right.frame || left.order - right.order);
  return staged.map(({ order: _order, ...event }) => event);
}

/**
 * Zero-order hold along the episode timeline. Poses are indexed by mapped
 * frame; later seq wins on a collision. Frames before the first pose copy
 * that first pose (back-fill) — they never appeared on screen as a
 * different camera, so inventing a ramp would be worse.
 */
function holdCameraPoses(
  poses: MappedEntry[],
  frameCount: number,
): { cameraPose: NonNullable<EpisodeActionTrack["cameraPose"]>; warnings: string[] } | null {
  const samples = poses
    .filter((item): item is MappedEntry & { entry: SessionCameraPoseEntry } => item.entry.kind === "camera-pose")
    .slice()
    .sort((left, right) => left.frame - right.frame || left.seq - right.seq);
  if (samples.length === 0) return null;

  const byFrame = new Map<number, SessionCameraPoseEntry>();
  for (const sample of samples) byFrame.set(sample.frame, sample.entry);
  const frames = [...byFrame.keys()].sort((left, right) => left - right);
  const warnings: string[] = [];
  if (frames[0] > 0) {
    warnings.push(
      `camera pose back-filled frames [0, ${frames[0]}) with the first recorded pose (zero-order hold, no interpolation).`,
    );
  }

  const fovValues = samples
    .map((sample) => sample.entry.fovDegrees)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const uniqueFov = [...new Set(fovValues.map((value) => value.toFixed(6)))];
  if (uniqueFov.length > 1) {
    warnings.push(
      `camera fovDegrees changed during the session (${uniqueFov.join(", ")}); the episode stores one shared intrinsic (last recorded value).`,
    );
  }
  const fovDegrees = fovValues.length > 0 ? fovValues[fovValues.length - 1] : DEFAULT_FOV_DEGREES;

  const positions: Array<[number, number, number]> = [];
  const rotations: Array<[number, number, number, number]> = [];
  let keyIndex = 0;
  let current = byFrame.get(frames[0])!;
  for (let frame = 0; frame < frameCount; frame += 1) {
    while (keyIndex + 1 < frames.length && frame >= frames[keyIndex + 1]) {
      keyIndex += 1;
      current = byFrame.get(frames[keyIndex])!;
    }
    positions.push([current.position[0], current.position[1], current.position[2]]);
    rotations.push([current.rotation[0], current.rotation[1], current.rotation[2], current.rotation[3]]);
  }

  return {
    cameraPose: {
      intrinsics: { fovDegrees },
      positions,
      rotations,
    },
    warnings,
  };
}

/**
 * Converts a SessionRecord into an episode action track with dense, frame-indexed semantic events
 * and zero-order-hold camera poses. The time mapping mode determines whether entries are placed
 * at their recorded playhead frame or at their wall-clock elapsed position.
 *
 * @param record - The session record to convert.
 * @param options - Time mapping mode and optional explicit frame count.
 * @returns The action track, total frame count, timebase, and warnings.
 */
export function convertSessionRecordToActionTrack(
  record: SessionRecord,
  options: ConvertSessionRecordOptions = {},
): SessionActionTrackConversion {
  const timeMapping = options.timeMapping ?? "timeline-playhead";
  const mapped = mapRecords(record, timeMapping);
  const derivedFrameCount = mapped.reduce((max, item) => Math.max(max, item.frame + 1), 1);
  if (options.frameCount !== undefined) {
    if (!Number.isSafeInteger(options.frameCount) || options.frameCount < derivedFrameCount) {
      throw new SessionEpisodeExportError(
        "frame-count-too-small",
        `frameCount ${options.frameCount} is smaller than the derived length ${derivedFrameCount}`,
      );
    }
  }
  const frameCount = options.frameCount ?? derivedFrameCount;
  const warnings = [...(record.warnings ?? [])];
  const held = holdCameraPoses(mapped, frameCount);
  if (held) warnings.push(...held.warnings);

  const actionTrack = episodeActionTrackSchema.parse({
    contract: EPISODE_ACTION_TRACK_CONTRACT,
    ...(held ? { cameraPose: held.cameraPose } : {}),
    semanticEvents: semanticEventsFromMapped(mapped),
  });

  return {
    actionTrack,
    frameCount,
    timebase: { frameRate: { ...record.timebase.frameRate }, frameCount },
    warnings,
  };
}

/**
 * Builds a validated episode manifest from the required input fields.
 *
 * @param input - The manifest fields including ID, scene revision, seed, timebase, and provenance.
 * @returns A validated EpisodeManifest.
 */
export function buildEpisodeManifest(input: BuildEpisodeManifestInput): EpisodeManifest {
  const payload: EpisodeManifestInput = {
    contract: EPISODE_MANIFEST_CONTRACT,
    id: input.id,
    projectId: input.projectId,
    sceneRevision: input.sceneRevision,
    seed: input.seed,
    timebase: input.timebase,
    renderer: input.renderer,
    provenance: input.provenance,
    artifacts: input.artifacts,
    ...(input.datasetId ? { datasetId: input.datasetId } : {}),
    ...(input.quality ? { quality: input.quality } : {}),
  };
  return episodeManifestSchema.parse(payload);
}

/**
 * Validates an episode manifest against its action track and optional captions for structural integrity.
 *
 * @param manifest - The episode manifest to validate.
 * @param actionTrack - The optional action track to cross-validate.
 * @param captions - The optional captions to cross-validate.
 * @returns An array of integrity issues, empty when the episode is valid.
 */
export function validateConvertedEpisode(
  manifest: EpisodeManifest,
  actionTrack?: EpisodeActionTrack,
  captions?: EpisodeCaptions,
): EpisodeIntegrityIssue[] {
  return validateEpisodeIntegrity(manifest, actionTrack, captions);
}
