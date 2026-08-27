/**
 * Quality audit for `director_creative` snapshots (`op:"audit"`).
 *
 * Runs pure structural checks over the projected workspace snapshot —
 * Canvas DAG integrity, editorial timeline consistency, media availability,
 * gallery hygiene — and produces a typed receipt whose `ready` flag means
 * zero error-severity issues. Like the Stage audit, this is not a visual
 * judgment: every issue carries a machine-readable code, the affected
 * entity ids, and a `suggested_next` corrective operation so agents can
 * repair rather than guess. The receipt embeds the snapshot fingerprint it
 * was computed from, tying the verdict to one exact state.
 *
 * @module creativeWorkspaceAgentQuality
 */

import { z } from "zod";
import {
  creativeWorkspaceAuditScopeSchema,
  creativeWorkspaceQualityProfileSchema,
  creativeWorkspaceSnapshotFingerprintSchema,
} from "@director/protocol/creativeWorkspaceProtocol";
import type { CreativeWorkspaceAgentSnapshot } from "./creativeWorkspaceAgentSchemas";

/**
 * Validates the severity classification of a creative workspace audit finding.
 *
 * "error" blocks the delivery pipeline; "warning" signals a recommended fix;
 * "info" is advisory only.
 */
export const creativeWorkspaceAuditSeveritySchema = z.enum(["error", "warning", "info"]);

/**
 * Validates a single issue detected during a creative workspace quality audit.
 *
 * Each issue carries a machine-readable {@link code}, a human-readable
 * {@link message}, the affected {@link entity_ids}, and a
 * {@link suggested_next} remediation step.
 */
export const creativeWorkspaceAuditIssueSchema = z.strictObject({
  severity: creativeWorkspaceAuditSeveritySchema,
  code: z.string(),
  message: z.string(),
  entity_ids: z.array(z.string()),
  suggested_next: z.string(),
});

/**
 * Validates the complete receipt produced by an audit of a creative workspace snapshot.
 *
 * The receipt bundles quality metrics, the list of issues found, and a
 * top-level {@link ready} flag that is `true` only when zero errors are present.
 */
export const creativeWorkspaceAuditReceiptSchema = z.strictObject({
  version: z.literal(1),
  audit_id: z.string(),
  snapshot_fingerprint: creativeWorkspaceSnapshotFingerprintSchema,
  scope: creativeWorkspaceAuditScopeSchema,
  quality_profile: creativeWorkspaceQualityProfileSchema,
  ready: z.boolean(),
  summary: z.strictObject({
    errors: z.number().int().nonnegative(),
    warnings: z.number().int().nonnegative(),
    info: z.number().int().nonnegative(),
  }),
  metrics: z.strictObject({
    board_nodes: z.number().int().nonnegative(),
    connected_board_nodes: z.number().int().nonnegative(),
    media_backed_board_nodes: z.number().int().nonnegative(),
    timeline_duration_sec: z.number().nonnegative(),
    video_clips: z.number().int().nonnegative(),
    audio_clips: z.number().int().nonnegative(),
    visible_picture_coverage_sec: z.number().nonnegative(),
    audible_coverage_sec: z.number().nonnegative(),
  }),
  issues: z.array(creativeWorkspaceAuditIssueSchema),
  next_steps: z.array(z.string()),
});

/** The subset of the creative workspace that the audit should inspect. */
export type CreativeWorkspaceAuditScope = z.infer<typeof creativeWorkspaceAuditScopeSchema>;

/** The quality bar the audit should enforce, from lenient to strict. */
export type CreativeWorkspaceQualityProfile = z.infer<typeof creativeWorkspaceQualityProfileSchema>;

/** Severity level of an audit finding — "error", "warning", or "info". */
export type CreativeWorkspaceAuditSeverity = z.infer<typeof creativeWorkspaceAuditSeveritySchema>;

/** A single audit issue with severity, diagnostic code, and suggested remediation. */
export type CreativeWorkspaceAuditIssue = z.infer<typeof creativeWorkspaceAuditIssueSchema>;

/** The complete audit result including issues, metrics, and a readiness verdict. */
export type CreativeWorkspaceAuditReceipt = z.infer<typeof creativeWorkspaceAuditReceiptSchema>;

/**
 * Factory that creates a {@link CreativeWorkspaceAuditIssue} with the given
 * severity, diagnostic code, and remediation guidance.
 */
function issue(
  severity: CreativeWorkspaceAuditSeverity,
  code: string,
  message: string,
  entityIds: string[],
  suggestedNext: string,
): CreativeWorkspaceAuditIssue {
  return { severity, code, message, entity_ids: entityIds, suggested_next: suggestedNext };
}

/**
 * Computes the total duration covered by the union of potentially overlapping
 * time ranges. Each range is a `[start, end]` pair in seconds.
 */
function unionDuration(ranges: Array<[number, number]>) {
  if (!ranges.length) return 0;
  const sorted = ranges
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
    .sort((left, right) => left[0] - right[0]);
  if (!sorted.length) return 0;
  let total = 0;
  let [rangeStart, rangeEnd] = sorted[0];
  for (let index = 1; index < sorted.length; index += 1) {
    const [start, end] = sorted[index];
    if (start <= rangeEnd) {
      rangeEnd = Math.max(rangeEnd, end);
      continue;
    }
    total += rangeEnd - rangeStart;
    rangeStart = start;
    rangeEnd = end;
  }
  return total + rangeEnd - rangeStart;
}

/**
 * Inspects the canvas board for quality issues: dangling edges, missing or
 * mismatched media references, unresolved shots, disconnected nodes, and
 * heavy node overlaps. Returns the set of connected node ids for metrics.
 */
function auditCanvas(snapshot: CreativeWorkspaceAgentSnapshot, issues: CreativeWorkspaceAuditIssue[]) {
  const mediaById = new Map(snapshot.media.assets.map((asset) => [asset.id, asset]));
  const connectedIds = new Set<string>();
  snapshot.board.edges.forEach((edge) => {
    connectedIds.add(edge.source_node_id);
    connectedIds.add(edge.target_node_id);
    const sourceExists = snapshot.board.nodes.some((node) => node.id === edge.source_node_id);
    const targetExists = snapshot.board.nodes.some((node) => node.id === edge.target_node_id);
    if (!sourceExists || !targetExists) {
      issues.push(
        issue(
          "error",
          "canvas.dangling_edge",
          `Edge ${edge.id} references a missing canvas node.`,
          [edge.id, edge.source_node_id, edge.target_node_id],
          "Remove the dangling edge or restore both endpoint nodes.",
        ),
      );
    }
  });

  snapshot.board.nodes.forEach((node) => {
    if (node.kind === "image" || node.kind === "video" || node.kind === "audio") {
      if (!node.media_id) {
        issues.push(
          issue(
            "error",
            "canvas.media_missing",
            `${node.kind} node “${node.title}” has no durable media asset.`,
            [node.id],
            "Attach an observed media_id of the same kind or convert the node to a note.",
          ),
        );
      } else {
        const asset = mediaById.get(node.media_id);
        if (!asset) {
          issues.push(
            issue(
              "error",
              "canvas.media_not_found",
              `Canvas node “${node.title}” references missing media ${node.media_id}.`,
              [node.id, node.media_id],
              "Relink the node to an existing durable media id returned by observe.",
            ),
          );
        } else if (asset.kind !== node.kind) {
          issues.push(
            issue(
              "error",
              "canvas.media_kind_mismatch",
              `Canvas node “${node.title}” is ${node.kind} but its media is ${asset.kind}.`,
              [node.id, asset.id],
              "Use a media asset whose kind matches the node.",
            ),
          );
        }
      }
    }
    if (node.kind === "shot" && !node.body.trim() && !node.media_id) {
      issues.push(
        issue(
          "warning",
          "canvas.unresolved_shot",
          `Shot node “${node.title}” has neither a shot brief nor linked media.`,
          [node.id],
          "Add the framing/action intent or connect the shot to a captured Stage result.",
        ),
      );
    }
    if (snapshot.board.nodes.length > 1 && !connectedIds.has(node.id)) {
      issues.push(
        issue(
          "warning",
          "canvas.disconnected",
          `Canvas node “${node.title}” is disconnected from the production graph.`,
          [node.id],
          "Connect it to its upstream reference or downstream shot/output node.",
        ),
      );
    }
  });

  let overlapWarnings = 0;
  // Cap at 24 overlap warnings to avoid flooding the audit with an O(n²) noise floor
  for (let leftIndex = 0; leftIndex < snapshot.board.nodes.length && overlapWarnings < 24; leftIndex += 1) {
    const left = snapshot.board.nodes[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < snapshot.board.nodes.length; rightIndex += 1) {
      const right = snapshot.board.nodes[rightIndex];
      const overlapWidth = Math.max(
        0,
        Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x),
      );
      const overlapHeight = Math.max(
        0,
        Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y),
      );
      const overlapArea = overlapWidth * overlapHeight;
      const smallerArea = Math.min(left.width * left.height, right.width * right.height);
      // 60% overlap threshold: below this the nodes are still individually readable
      if (!smallerArea || overlapArea / smallerArea < 0.6) continue;
      overlapWarnings += 1;
      issues.push(
        issue(
          "warning",
          "canvas.heavy_overlap",
          `Canvas nodes “${left.title}” and “${right.title}” substantially overlap.`,
          [left.id, right.id],
          "Move one node so both cards and their ports remain readable.",
        ),
      );
    }
  }

  return connectedIds;
}

/**
 * Inspects the video edit timeline for quality issues: missing media, kind
 * mismatches on tracks, source-range and fade-range overflows, and clip
 * overlaps. Returns aggregate metrics for timeline duration, clip counts,
 * and coverage.
 */
function auditVideo(snapshot: CreativeWorkspaceAgentSnapshot, issues: CreativeWorkspaceAuditIssue[]) {
  const mediaById = new Map(snapshot.media.assets.map((asset) => [asset.id, asset]));
  const pictureRanges: Array<[number, number]> = [];
  const audibleRanges: Array<[number, number]> = [];
  let timelineDuration = 0;
  let videoClips = 0;
  let audioClips = 0;

  snapshot.edit.tracks.forEach((track) => {
    const sortedClips = [...track.clips].sort((left, right) => left.start_sec - right.start_sec);
    sortedClips.forEach((clip, index) => {
      timelineDuration = Math.max(timelineDuration, clip.start_sec + clip.duration_sec);
      if (track.kind === "video") videoClips += 1;
      else audioClips += 1;
      const asset = mediaById.get(clip.media_id);
      if (!asset) {
        issues.push(
          issue(
            "error",
            "edit.media_not_found",
            `Clip “${clip.name}” references missing media ${clip.media_id}.`,
            [track.id, clip.id, clip.media_id],
            "Relink the clip to an observed durable media id before export.",
          ),
        );
      } else {
        const expectedTrackKind = asset.kind === "audio" ? "audio" : "video";
        if (track.kind !== expectedTrackKind) {
          issues.push(
            issue(
              "error",
              "edit.media_kind_mismatch",
              `Clip “${clip.name}” uses ${asset.kind} media on a ${track.kind} track.`,
              [track.id, clip.id, asset.id],
              `Move the clip to a ${expectedTrackKind} track.`,
            ),
          );
        }
      }
      // Floating-point epsilon guard: a clip that consumes its full source at
      // playback rate 1.0 should not trigger a false positive.
      if (clip.in_sec + clip.duration_sec * clip.playback_rate > clip.source_duration_sec + Number.EPSILON) {
        issues.push(
          issue(
            "error",
            "edit.source_range_exceeded",
            `Clip “${clip.name}” consumes media beyond its source duration.`,
            [track.id, clip.id],
            "Reduce duration, source In, or playback rate.",
          ),
        );
      }
      // Epsilon guard: fades that exactly equal clip duration should not flag.
      if (clip.fade_in_sec + clip.fade_out_sec > clip.duration_sec + Number.EPSILON) {
        issues.push(
          issue(
            "error",
            "edit.fade_range_exceeded",
            `Clip “${clip.name}” has fades longer than the clip.`,
            [track.id, clip.id],
            "Shorten fade-in or fade-out so their sum fits the clip duration.",
          ),
        );
      }
      const previous = sortedClips[index - 1];
      if (previous && previous.start_sec + previous.duration_sec > clip.start_sec + Number.EPSILON) {
        issues.push(
          issue(
            "warning",
            "edit.track_overlap",
            `Clips “${previous.name}” and “${clip.name}” overlap on track “${track.name}”.`,
            [track.id, previous.id, clip.id],
            "Move one clip to another layer or remove the overlap before export.",
          ),
        );
      }
      if (track.kind === "video" && track.visible && clip.opacity > 0) {
        pictureRanges.push([clip.start_sec, clip.start_sec + clip.duration_sec]);
      }
      if (!track.muted && clip.volume > 0 && (track.kind === "audio" || asset?.kind === "video")) {
        audibleRanges.push([clip.start_sec, clip.start_sec + clip.duration_sec]);
      }
    });
  });

  if (videoClips + audioClips === 0) {
    issues.push(
      issue(
        "warning",
        "edit.empty",
        "The edit timeline has no clips.",
        [],
        "Add an observed media asset to a compatible track.",
      ),
    );
  } else if (!pictureRanges.length) {
    issues.push(
      issue(
        "warning",
        "edit.no_picture",
        "The edit contains no visible picture coverage.",
        [],
        "Add or reveal at least one visual clip before production delivery.",
      ),
    );
  }

  return {
    timelineDuration,
    videoClips,
    audioClips,
    visiblePictureCoverage: unionDuration(pictureRanges),
    audibleCoverage: unionDuration(audibleRanges),
  };
}

/**
 * Runs a quality audit against a creative workspace snapshot.
 *
 * Inspects the canvas board and/or video edit timeline (depending on
 * {@link scope}) and returns an {@link CreativeWorkspaceAuditReceipt} with
 * categorized issues, aggregate metrics, and a top-level readiness verdict.
 *
 * @param snapshot - The workspace snapshot to audit, obtained via {@link observeCreativeWorkspaceAgentSnapshot}.
 * @param scope - The workspace areas to inspect; defaults to `"all"`.
 * @param qualityProfile - The quality bar to enforce; defaults to `"production"`.
 * @returns The audit receipt with issues, metrics, and a readiness verdict.
 */
export function auditCreativeWorkspaceSnapshot(
  snapshot: CreativeWorkspaceAgentSnapshot,
  scope: CreativeWorkspaceAuditScope = "all",
  qualityProfile: CreativeWorkspaceQualityProfile = "production",
): CreativeWorkspaceAuditReceipt {
  const issues: CreativeWorkspaceAuditIssue[] = [];
  if (snapshot.media.status !== "ready") {
    issues.push(
      issue(
        snapshot.media.status === "error" ? "error" : "warning",
        "media.not_ready",
        snapshot.media.error ?? snapshot.media.warning ?? `Media library status is ${snapshot.media.status}.`,
        [],
        "Wait for durable media hydration or resolve the reported media storage error.",
      ),
    );
  }
  const connectedIds = scope === "video" ? new Set<string>() : auditCanvas(snapshot, issues);
  const videoMetrics =
    scope === "canvas"
      ? { timelineDuration: 0, videoClips: 0, audioClips: 0, visiblePictureCoverage: 0, audibleCoverage: 0 }
      : auditVideo(snapshot, issues);
  const relevantIssues = issues.filter((entry) => {
    if (scope === "canvas") return entry.code.startsWith("canvas.") || entry.code.startsWith("media.");
    if (scope === "video") return entry.code.startsWith("edit.") || entry.code.startsWith("media.");
    return true;
  });
  const summary = {
    errors: relevantIssues.filter((entry) => entry.severity === "error").length,
    warnings: relevantIssues.filter((entry) => entry.severity === "warning").length,
    info: relevantIssues.filter((entry) => entry.severity === "info").length,
  };
  // Deduplicate suggested next steps and cap at 12 to keep the receipt concise
  const nextSteps = [...new Set(relevantIssues.map((entry) => entry.suggested_next))].slice(0, 12);
  return {
    version: 1,
    audit_id: `creative-audit:${crypto.randomUUID()}`,
    snapshot_fingerprint: snapshot.snapshot_fingerprint,
    scope,
    quality_profile: qualityProfile,
    ready: summary.errors === 0,
    summary,
    metrics: {
      board_nodes: snapshot.counts.board_nodes,
      connected_board_nodes: connectedIds.size,
      media_backed_board_nodes: snapshot.board.nodes.filter((node) => Boolean(node.media_id)).length,
      timeline_duration_sec: videoMetrics.timelineDuration,
      video_clips: videoMetrics.videoClips,
      audio_clips: videoMetrics.audioClips,
      visible_picture_coverage_sec: videoMetrics.visiblePictureCoverage,
      audible_coverage_sec: videoMetrics.audibleCoverage,
    },
    issues: relevantIssues,
    next_steps: nextSteps,
  };
}
