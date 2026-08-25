/**
 * Builds an `episode.package` job input from a recorded session, the live
 * Director project (for captions), and a staged video media id.
 */
import {
  episodePackageJobInputSchema,
  type EpisodePackageJobInput,
  type EpisodePackageJobInputDraft,
  type EpisodeRenderer,
  type EpisodeSceneRevision,
} from "@director/protocol/episode";
import type { DirectorProject } from "../schema/directorProject";
import { composeEpisodeCaptions } from "./episodeCaptionComposer";
import { convertSessionRecordToActionTrack, type SessionEpisodeTimeMapping } from "./sessionEpisodeExport";
import type { SessionRecord } from "./sessionRecordTypes";

/** Options for preparing an episode package job from a recorded session and live project. */
export interface PrepareEpisodePackageJobInputOptions {
  record: SessionRecord;
  project: DirectorProject;
  sourceVideoMediaId: string;
  sceneRevision: EpisodeSceneRevision;
  renderer: EpisodeRenderer;
  provenance: EpisodePackageJobInputDraft["provenance"];
  seed?: number;
  episodeId?: string;
  datasetId?: string;
  timeMapping?: SessionEpisodeTimeMapping;
  language?: string;
  includeSessionRecord?: boolean;
}

/** The result of preparing an episode package job: a validated input and any conversion warnings. */
export interface PreparedEpisodePackageJob {
  kind: "episode.package";
  input: EpisodePackageJobInput;
  warnings: string[];
}

/**
 * Converts a session record into a complete episode package job input.
 *
 * This function chains the session-to-action-track conversion, deterministic caption
 * composition, and schema validation into a single call. The resulting input is ready
 * for submission to the production job queue.
 *
 * @param options - The session record, project, video media ID, and metadata.
 * @returns A validated episode package job input with any conversion warnings.
 */
export function prepareEpisodePackageJobInput(
  options: PrepareEpisodePackageJobInputOptions,
): PreparedEpisodePackageJob {
  const converted = convertSessionRecordToActionTrack(options.record, {
    timeMapping: options.timeMapping,
  });
  const captions = composeEpisodeCaptions({
    project: options.project,
    events: converted.actionTrack.semanticEvents ?? [],
    timebase: converted.timebase,
    language: options.language,
  });
  const input = episodePackageJobInputSchema.parse({
    episodeId: options.episodeId ?? options.record.sessionId,
    projectId: options.record.projectId,
    datasetId: options.datasetId,
    sceneRevision: options.sceneRevision,
    seed: options.seed ?? 0,
    sourceVideoMediaId: options.sourceVideoMediaId,
    timebase: converted.timebase,
    renderer: options.renderer,
    provenance: options.provenance,
    actionTrack: converted.actionTrack,
    captions,
    sessionRecord: options.includeSessionRecord === false ? undefined : options.record,
  });
  return { kind: "episode.package", input, warnings: converted.warnings };
}
