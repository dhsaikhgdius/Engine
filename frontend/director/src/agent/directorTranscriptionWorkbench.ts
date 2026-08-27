/**
 * Transcription workbench command executor (`transcription` operations).
 *
 * Bridges the Agent contract to the media transcription pipeline: capability
 * discovery, job lifecycle (list / get / submit / cancel / retry), reading and
 * searching a promoted transcript window, and promoting a completed job's
 * transcript onto its Gallery asset — optionally inserting caption cues into
 * the Video Editor timeline. Submission resolves Gallery media to bytes
 * locally, and reads/searches run entirely against the persisted transcript
 * so they never touch the network.
 */
import {
  directorMediaTranscriptToCaptionCues,
  insertDirectorCaptionCuesIntoTimeline,
} from "../comprehensive/editor/workspaces/captionImport";
import { isNetworkFailureMessage } from "../comprehensive/editor/api/friendlyError";
import {
  cancelMediaTranscriptionJob,
  fetchDirectorMediaTranscript,
  getMediaTranscriptionCapabilities,
  inspectMediaTranscriptionJob,
  listMediaTranscriptionJobs,
  MediaTranscriptionRequestError,
  retryMediaTranscriptionJob,
  submitMediaTranscription,
  type MediaTranscriptionJob,
} from "../comprehensive/editor/media/mediaTranscriptionBridge";
import {
  persistentCreativeMediaLibrary,
  type CreativeMediaAsset,
} from "../comprehensive/editor/media/persistentCreativeMediaStore";
import type { DirectorMediaTranscriptSegment } from "@director/protocol/mediaTranscriptionProtocol";
import type { DirectorTranscriptionCommand } from "@director/agent-engine/contract";
import type { DirectorWorkbenchExecution } from "./directorWorkbenchExecutor";

/**
 * Dependency injection surface for the transcription workbench. Each method
 * isolates a side effect (API call, media library access, caption insertion)
 * so the executor can be tested with stubs.
 */
export interface DirectorTranscriptionWorkbenchDependencies {
  /** Fetch the server-side transcription capabilities and model list. */
  capabilities?: typeof getMediaTranscriptionCapabilities;
  /** List recent transcription jobs for the current workspace. */
  listJobs?: typeof listMediaTranscriptionJobs;
  /** Inspect a single transcription job by ID. */
  inspectJob?: typeof inspectMediaTranscriptionJob;
  /** Submit a new transcription job for a media asset. */
  submitJob?: typeof submitMediaTranscription;
  /** Cancel a pending or running transcription job. */
  cancelJob?: typeof cancelMediaTranscriptionJob;
  /** Retry a failed or cancelled transcription job. */
  retryJob?: typeof retryMediaTranscriptionJob;
  /** Fetch the full transcript result for a completed job. */
  fetchTranscript?: typeof fetchDirectorMediaTranscript;
  /** Look up a media asset by ID from the persistent creative library. */
  getAsset?: (id: string) => CreativeMediaAsset | null;
  /** Retrieve the raw blob bytes for a media asset. */
  getBlob?: (id: string) => Promise<Blob | null>;
  /** Persist a promoted transcript to the media library. */
  setTranscript?: typeof persistentCreativeMediaLibrary.setTranscript;
  /** Insert transcript segments as caption cues into the timeline. */
  insertCaptions?: typeof insertDirectorCaptionCuesIntoTimeline;
}

function defaultDependencies(): Required<DirectorTranscriptionWorkbenchDependencies> {
  return {
    capabilities: getMediaTranscriptionCapabilities,
    listJobs: listMediaTranscriptionJobs,
    inspectJob: inspectMediaTranscriptionJob,
    submitJob: submitMediaTranscription,
    cancelJob: cancelMediaTranscriptionJob,
    retryJob: retryMediaTranscriptionJob,
    fetchTranscript: fetchDirectorMediaTranscript,
    getAsset: (id) => persistentCreativeMediaLibrary.getAsset(id),
    getBlob: (id) => persistentCreativeMediaLibrary.getBlob(id),
    setTranscript: (id, transcript) => persistentCreativeMediaLibrary.setTranscript(id, transcript),
    insertCaptions: insertDirectorCaptionCuesIntoTimeline,
  };
}

/** Wrap a payload as a successful workbench execution. */
function success(result: unknown): DirectorWorkbenchExecution {
  return { success: true, result };
}

/** Assert that a Gallery asset exists and is transcribable (original audio/video, not a proxy). */
function assertSourceAsset(asset: CreativeMediaAsset | null, sourceMediaId: string) {
  if (!asset) throw new Error(`Gallery media "${sourceMediaId}" does not exist`);
  // Proxies delegate to an original asset; only the original can be transcribed.
  if (asset.proxyOf) throw new Error(`Gallery media "${sourceMediaId}" is a proxy; transcribe the original media`);
  if (asset.kind !== "audio" && asset.kind !== "video") {
    throw new Error(`Gallery media "${sourceMediaId}" is ${asset.kind}, not audio or video`);
  }
  return asset;
}

/** Resolve a Gallery asset plus its promoted transcript; throws when either is missing. */
function transcriptSource(asset: CreativeMediaAsset | null, sourceMediaId: string) {
  const source = assertSourceAsset(asset, sourceMediaId);
  if (!source.transcript) {
    throw new Error(`Gallery media "${sourceMediaId}" has no promoted transcript`);
  }
  return { source, transcript: source.transcript };
}

/** Project one transcript segment into the snake_case wire shape agents read. */
function transcriptSegmentResult(segment: DirectorMediaTranscriptSegment, index: number) {
  return {
    index,
    start_seconds: segment.startSec,
    end_seconds: segment.endSec,
    speaker: segment.speaker,
    confidence: segment.confidence,
    text: segment.text,
  };
}

/**
 * Normalize text for transcript search: Unicode NFKC compatibility
 * decomposition, locale-aware lowercasing, then collapse all non-letter/number
 * sequences into single spaces so queries match across punctuation and
 * whitespace differences.
 */
function normalizeTranscriptSearchText(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Check whether a transcript segment's time range overlaps a query window.
 * When {@link toSec} is undefined the window is open-ended (from fromSec onward).
 */
function segmentOverlapsWindow(startSec: number, endSec: number, fromSec: number, toSec?: number) {
  return endSec > fromSec && (toSec === undefined || startSec < toSec);
}

/**
 * Execute a transcription workbench command: capabilities, list, get, submit,
 * cancel, retry, read, search, or promote. The promote action fetches the
 * completed transcript, persists it to the media library, and optionally
 * inserts caption cues into the timeline.
 *
 * @param command - The transcription command to execute.
 * @param signal - An optional abort signal to cancel the operation.
 * @param options - Optional dependency overrides for testing.
 * @returns The execution result, with command-specific payloads under
 *   {@link DirectorWorkbenchExecution.result}.
 */
export async function executeDirectorTranscriptionWorkbenchCommand(
  command: DirectorTranscriptionCommand,
  signal?: AbortSignal,
  options: { dependencies?: DirectorTranscriptionWorkbenchDependencies } = {},
): Promise<DirectorWorkbenchExecution> {
  const dependencies = { ...defaultDependencies(), ...options.dependencies };
  try {
    signal?.throwIfAborted();
    switch (command.action) {
      case "capabilities":
        return success(await dependencies.capabilities(signal));
      case "list":
        return success({ jobs: await dependencies.listJobs(command.limit, signal) });
      case "get":
        return success({ job: await dependencies.inspectJob(command.job_id, signal) });
      case "submit": {
        const asset = assertSourceAsset(dependencies.getAsset(command.source_media_id), command.source_media_id);
        const blob = await dependencies.getBlob(asset.id);
        if (!blob) throw new Error(`Gallery media "${asset.id}" has no durable bytes`);
        signal?.throwIfAborted();
        const job = await dependencies.submitJob({
          asset,
          blob,
          language: command.language,
          idempotencyKey: command.idempotency_key,
          signal,
        });
        return success({ job, accepted: true });
      }
      case "cancel":
        return success({ job: await dependencies.cancelJob(command.job_id, signal) });
      case "retry":
        return success({ job: await dependencies.retryJob(command.job_id, command.idempotency_key, signal) });
      case "read": {
        const { source, transcript } = transcriptSource(
          dependencies.getAsset(command.source_media_id),
          command.source_media_id,
        );
        const segments = transcript.segments
          .map((segment, index) => ({ segment, index }))
          .filter(({ segment }) =>
            segmentOverlapsWindow(segment.startSec, segment.endSec, command.from_seconds, command.to_seconds),
          );
        return success({
          transcript: {
            source_media_id: source.id,
            job_id: transcript.jobId,
            language: transcript.language,
            duration_seconds: transcript.durationSec,
            from_seconds: command.from_seconds,
            to_seconds: command.to_seconds ?? transcript.durationSec,
            total_segments_in_window: segments.length,
            truncated: segments.length > command.max_segments,
            segments: segments
              .slice(0, command.max_segments)
              .map(({ segment, index }) => transcriptSegmentResult(segment, index)),
          },
        });
      }
      case "search": {
        const { source, transcript } = transcriptSource(
          dependencies.getAsset(command.source_media_id),
          command.source_media_id,
        );
        const query = normalizeTranscriptSearchText(command.query);
        const queryTerms = query.split(" ").filter(Boolean);
        const requestedSpeaker = command.speaker ? normalizeTranscriptSearchText(command.speaker) : null;
        const matches = transcript.segments
          .map((segment, index) => {
            if (!segmentOverlapsWindow(segment.startSec, segment.endSec, command.from_seconds, command.to_seconds)) {
              return null;
            }
            if (requestedSpeaker && normalizeTranscriptSearchText(segment.speaker ?? "") !== requestedSpeaker) {
              return null;
            }
            const searchable = normalizeTranscriptSearchText(`${segment.speaker ?? ""} ${segment.text}`);
            const phraseMatch = searchable.includes(query);
            const matchingTerms = queryTerms.filter((term) => searchable.includes(term));
            // Require either a full phrase match or all individual terms to match.
            if (!phraseMatch && matchingTerms.length !== queryTerms.length) return null;
            return {
              // Phrase match scores 100 + term count; term-only match scores just the count.
              score: (phraseMatch ? 100 : 0) + matchingTerms.length,
              ...transcriptSegmentResult(segment, index),
            };
          })
          .filter((match): match is NonNullable<typeof match> => match !== null)
          .sort((left, right) => right.score - left.score || left.start_seconds - right.start_seconds);
        return success({
          search: {
            source_media_id: source.id,
            job_id: transcript.jobId,
            query: command.query,
            speaker: command.speaker ?? null,
            total_matches: matches.length,
            matches: matches.slice(0, command.limit).map(({ score: _score, ...match }) => match),
          },
        });
      }
      case "promote": {
        const job = await dependencies.inspectJob(command.job_id, signal);
        // Only completed jobs can be promoted; running, pending, or failed jobs are rejected.
        if (job.status !== "succeeded")
          throw new Error(`Transcription job "${job.id}" is ${job.status}, not succeeded`);
        const source = assertSourceAsset(dependencies.getAsset(job.input.sourceMediaId), job.input.sourceMediaId);
        const transcript = await dependencies.fetchTranscript(job as MediaTranscriptionJob, signal);
        signal?.throwIfAborted();
        const persisted = await dependencies.setTranscript(source.id, transcript);
        // The asset may have been deleted between the fetch and the persist.
        if (!persisted) throw new Error(`Gallery media "${source.id}" disappeared before transcript promotion`);
        const captions = command.add_to_timeline
          ? dependencies.insertCaptions(directorMediaTranscriptToCaptionCues(transcript), {
              sourceMediaId: source.id,
              transcriptionJobId: transcript.jobId,
              offsetSec: command.caption_offset_seconds,
            })
          : { inserted: 0, trackId: null, alreadyPresent: false };
        return success({
          transcription: {
            job_id: job.id,
            source_media_id: source.id,
            language: transcript.language,
            text: transcript.text,
            segment_count: transcript.segments.length,
            transcript_persisted: true,
            captions_inserted: captions.inserted,
            caption_track_id: captions.trackId,
            captions_already_present: captions.alreadyPresent ?? false,
          },
        });
      }
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      result: { code: transcriptionFailureCode(error) },
    };
  }
}

/**
 * Maps a thrown transcription error onto a stable failure code: cancellation,
 * the gateway's structured code (e.g. `transcription_not_configured`,
 * `transcription_job_not_found`), an explicit `gateway_unreachable` for
 * transport-level fetch failures, and `transcription_failed` otherwise.
 */
function transcriptionFailureCode(error: unknown) {
  if (error instanceof DOMException && error.name === "AbortError") return "cancelled";
  if (error instanceof MediaTranscriptionRequestError && error.code) return error.code;
  if (error instanceof TypeError && isNetworkFailureMessage(error.message)) return "gateway_unreachable";
  return "transcription_failed";
}
