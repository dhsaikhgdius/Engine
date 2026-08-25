/**
 * Local executor for `episode.package`: bind a staged MP4 to an already
 * converted action track and captions, write hashed package artifacts, and
 * refuse to succeed when validateEpisodeIntegrity reports issues.
 */
import { createHash } from "node:crypto";
import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  EPISODE_MANIFEST_CONTRACT,
  EPISODE_PACKAGE_ACTION_TRACK_FILE,
  EPISODE_PACKAGE_CAPTIONS_FILE,
  EPISODE_PACKAGE_MANIFEST_FILE,
  EPISODE_PACKAGE_SESSION_RECORD_FILE,
  EPISODE_PACKAGE_VIDEO_FILE,
  canonicalEpisodeJson,
  episodeManifestSchema,
  parseEpisodePackageSourceSha256,
  validateEpisodeIntegrity,
  type EpisodePackageJobInput,
} from "../../../packages/protocol/src/episodeProtocol";
import {
  productionJobArtifactSchema,
  transitionProductionJob,
  type ProductionJobArtifact,
  type ProductionJobError,
  type ProductionJobRecord,
} from "../../../packages/protocol/src/productionJobProtocol";
import { stableLexicalJson } from "../../../packages/protocol/src/stableJson";
import type { ProductionJobStore } from "../jobs/productionJobStore";
import {
  MediaInputIntegrityError,
  MediaInputMissingError,
  type MediaTranscodeInputStore,
} from "../media/mediaTranscodeInputStore";

/**
 * Structured error for episode packaging failures with a machine-readable
 * code and retryability flag.
 */
export class EpisodePackageJobError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "EpisodePackageJobError";
  }
}

/** Dependencies for the episode package executor. */
export interface EpisodePackageExecutorOptions {
  store: ProductionJobStore;
  inputs: MediaTranscodeInputStore;
  now?: () => Date;
}

function sha256Hex(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function toStructuredFailure(error: unknown): ProductionJobError {
  if (error instanceof EpisodePackageJobError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  if (error instanceof MediaInputMissingError) {
    return { code: error.code, message: error.message, retryable: true };
  }
  if (error instanceof MediaInputIntegrityError) {
    return { code: error.code, message: error.message, retryable: false };
  }
  return {
    code: "episode_package_failed",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}

interface PlannedFile {
  fileName: string;
  role: string;
  mimeType: string;
  kind: "video" | "action-track" | "captions" | "metadata";
  sha256: string;
  bytes: number;
  contents?: string;
  copyFrom?: string;
}

/**
 * Local executor for `episode.package` jobs. Binds a staged MP4 to an already
 * converted action track and captions, writes hashed package artifacts, and
 * refuses to succeed when validateEpisodeIntegrity reports issues.
 */
export class EpisodePackageExecutor {
  private readonly running = new Set<string>();
  private readonly now: () => Date;

  constructor(private readonly options: EpisodePackageExecutorOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Executes a queued episode package job: verifies the staged source video,
   * validates integrity, writes hashed artifacts (video, action track,
   * captions, manifest, optional session record), and transitions the job
   * to succeeded.
   *
   * @param jobInput - The queued job record.
   * @returns The updated job record, or null when the job is no longer queued.
   * @throws When the job kind is not episode.package.
   */
  async execute(jobInput: ProductionJobRecord): Promise<ProductionJobRecord | null> {
    if (jobInput.kind !== "episode.package") {
      throw new Error(`Cannot package episode production job ${jobInput.kind}`);
    }
    if (this.running.has(jobInput.id)) return this.options.store.get(jobInput.id);
    this.running.add(jobInput.id);
    try {
      const queued = await this.options.store.get(jobInput.id);
      if (!queued || queued.kind !== "episode.package" || queued.status !== "queued") return queued;
      let latest = await this.options.store.update(
        transitionProductionJob(queued, "running", { progress: 0.1, message: "Packaging episode" }),
      );
      const attempt = latest.attempts.at(-1)!;
      const createdAt = this.now().toISOString();
      const spec = latest.input as EpisodePackageJobInput;
      const sourceSha256 = parseEpisodePackageSourceSha256(spec.sourceVideoMediaId);
      const sourcePath = await this.options.inputs.verifiedSourcePath(sourceSha256);
      const videoBytes = (await stat(sourcePath)).size;

      const actionTrackJson = stableLexicalJson(spec.actionTrack);
      const captionsJson = stableLexicalJson(spec.captions);
      const sessionRecordJson = spec.sessionRecord === undefined ? null : stableLexicalJson(spec.sessionRecord);

      const files: PlannedFile[] = [
        {
          fileName: EPISODE_PACKAGE_VIDEO_FILE,
          role: "video",
          mimeType: "video/mp4",
          kind: "video",
          sha256: sourceSha256,
          bytes: videoBytes,
          copyFrom: sourcePath,
        },
        {
          fileName: EPISODE_PACKAGE_ACTION_TRACK_FILE,
          role: "action-track",
          mimeType: "application/json",
          kind: "action-track",
          sha256: sha256Hex(actionTrackJson),
          bytes: Buffer.byteLength(actionTrackJson),
          contents: actionTrackJson,
        },
        {
          fileName: EPISODE_PACKAGE_CAPTIONS_FILE,
          role: "captions",
          mimeType: "application/json",
          kind: "captions",
          sha256: sha256Hex(captionsJson),
          bytes: Buffer.byteLength(captionsJson),
          contents: captionsJson,
        },
      ];
      if (sessionRecordJson) {
        files.push({
          fileName: EPISODE_PACKAGE_SESSION_RECORD_FILE,
          role: "session-record",
          mimeType: "application/json",
          kind: "metadata",
          sha256: sha256Hex(sessionRecordJson),
          bytes: Buffer.byteLength(sessionRecordJson),
          contents: sessionRecordJson,
        });
      }

      const manifest = episodeManifestSchema.parse({
        contract: EPISODE_MANIFEST_CONTRACT,
        id: spec.episodeId,
        datasetId: spec.datasetId,
        projectId: spec.projectId,
        sceneRevision: spec.sceneRevision,
        seed: spec.seed,
        timebase: spec.timebase,
        renderer: spec.renderer,
        provenance: spec.provenance,
        artifacts: files.map((file) => ({
          path: file.fileName,
          kind: file.kind,
          sha256: file.sha256,
          bytes: file.bytes,
        })),
        quality: spec.quality,
      });
      const issues = validateEpisodeIntegrity(manifest, spec.actionTrack, spec.captions);
      if (issues.length > 0) {
        throw new EpisodePackageJobError(
          `episode integrity failed: ${issues.map((issue) => issue.message).join("; ")}`,
          "episode_integrity_failed",
          false,
        );
      }
      const manifestJson = canonicalEpisodeJson(manifest);
      files.push({
        fileName: EPISODE_PACKAGE_MANIFEST_FILE,
        role: "manifest",
        mimeType: "application/json",
        kind: "metadata",
        sha256: sha256Hex(manifestJson),
        bytes: Buffer.byteLength(manifestJson),
        contents: manifestJson,
      });

      const artifacts: ProductionJobArtifact[] = [];
      for (const file of files) {
        const target = this.options.store.artifactFilePath(latest.id, attempt.id, file.fileName);
        await mkdir(dirname(target), { recursive: true });
        if (file.copyFrom) await copyFile(file.copyFrom, target);
        else await writeFile(target, file.contents ?? "");
        artifacts.push(
          productionJobArtifactSchema.parse({
            id: `${attempt.id}-${file.role}`,
            attemptId: attempt.id,
            role: file.role,
            mimeType: file.mimeType,
            fileName: file.fileName,
            sha256: file.sha256,
            bytes: file.bytes,
            createdAt,
          }),
        );
      }

      const current = await this.options.store.get(latest.id);
      if (!current || current.status === "cancelled") return current;
      return this.options.store.update(
        transitionProductionJob(current, "succeeded", {
          progress: 1,
          message: `Packaged episode ${spec.episodeId}`,
          artifacts,
          artifact: artifacts[0],
        }),
      );
    } catch (error) {
      const latest = await this.options.store.get(jobInput.id);
      if (!latest || latest.status === "cancelled") return latest;
      if (latest.status !== "running" && latest.status !== "queued") throw error;
      const failure = toStructuredFailure(error);
      const running =
        latest.status === "queued"
          ? await this.options.store.update(
              transitionProductionJob(latest, "running", { progress: 0, message: "Packaging episode" }),
            )
          : latest;
      return this.options.store.update(
        transitionProductionJob(running, "failed", {
          message: "Episode package failed",
          error: failure.message,
          structuredError: failure,
        }),
      );
    } finally {
      this.running.delete(jobInput.id);
    }
  }
}
