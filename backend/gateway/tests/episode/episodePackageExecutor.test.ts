import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EPISODE_ACTION_TRACK_CONTRACT,
  EPISODE_CAPTIONS_CONTRACT,
  EPISODE_MANIFEST_CONTRACT,
  EPISODE_PACKAGE_ACTION_TRACK_FILE,
  EPISODE_PACKAGE_MANIFEST_FILE,
  EPISODE_PACKAGE_VIDEO_FILE,
  episodePackageJobInputSchema,
  type EpisodePackageJobInput,
} from "../../../../packages/protocol/src/episodeProtocol";
import { ProductionJobStore } from "../../jobs/productionJobStore";
import { MediaTranscodeInputStore } from "../../media/mediaTranscodeInputStore";
import { EpisodePackageExecutor } from "../../episode/episodePackageExecutor";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const VIDEO_BYTES = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);
const VIDEO_SHA256 = createHash("sha256").update(VIDEO_BYTES).digest("hex");

function packageInput(overrides: Record<string, unknown> = {}): EpisodePackageJobInput {
  return episodePackageJobInputSchema.parse({
    episodeId: "episode-test",
    projectId: "project-test",
    sceneRevision: "rev-1",
    seed: 7,
    sourceVideoMediaId: `media-input:sha256:${VIDEO_SHA256}`,
    timebase: { frameRate: { numerator: 24, denominator: 1 }, frameCount: 1 },
    renderer: {
      backendId: "three-webgl",
      version: "test",
      resolution: { width: 64, height: 64 },
      colorSpace: "srgb",
    },
    provenance: { codeVersion: "test", configHash: "sha256:episode-config" },
    actionTrack: {
      contract: EPISODE_ACTION_TRACK_CONTRACT,
      semanticEvents: [{ frame: 0, type: "timeline.playhead", payload: { playheadFrame: 0 } }],
    },
    captions: {
      contract: EPISODE_CAPTIONS_CONTRACT,
      sceneStatic: {
        language: "en",
        generator: { method: "deterministic-composed" },
        text: "The stage contains one character.",
      },
    },
    sessionRecord: { sessionId: "director-session:test", records: [] },
    ...overrides,
  });
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "director-episode-package-"));
  directories.push(directory);
  const store = new ProductionJobStore(directory);
  const inputs = new MediaTranscodeInputStore(directory, 1024 * 1024);
  await inputs.put(VIDEO_BYTES, VIDEO_SHA256);
  const executor = new EpisodePackageExecutor({
    store,
    inputs,
    now: () => new Date("2026-08-14T10:00:00.000Z"),
  });
  return { store, executor };
}

describe("EpisodePackageExecutor", () => {
  it("writes hashed video, action track, captions, session record, and manifest artifacts", async () => {
    const { store, executor } = await fixture();
    const queued = await store.enqueue({
      kind: "episode.package",
      input: packageInput(),
      idempotencyKey: "episode-package:success",
      createId: () => "episode-job-success",
    });
    const result = await executor.execute(queued);
    expect(result?.status).toBe("succeeded");
    expect(result?.artifacts.map((artifact) => artifact.fileName)).toEqual([
      EPISODE_PACKAGE_VIDEO_FILE,
      EPISODE_PACKAGE_ACTION_TRACK_FILE,
      "captions.json",
      "session-record.json",
      EPISODE_PACKAGE_MANIFEST_FILE,
    ]);
    expect(result?.artifacts[0]?.sha256).toBe(VIDEO_SHA256);
    expect(result?.artifacts[0]?.bytes).toBe(VIDEO_BYTES.byteLength);

    const attempt = result!.attempts.at(-1)!;
    const videoPath = store.artifactFilePath(result!.id, attempt.id, EPISODE_PACKAGE_VIDEO_FILE);
    expect(await readFile(videoPath)).toEqual(Buffer.from(VIDEO_BYTES));
    const manifest = JSON.parse(
      await readFile(store.artifactFilePath(result!.id, attempt.id, EPISODE_PACKAGE_MANIFEST_FILE), "utf8"),
    ) as { contract: string; artifacts: Array<{ path: string; kind: string }> };
    expect(manifest.contract).toBe(EPISODE_MANIFEST_CONTRACT);
    expect(manifest.artifacts.map((artifact) => artifact.kind)).toEqual([
      "video",
      "action-track",
      "captions",
      "metadata",
    ]);
  });

  it("fails non-retryably when action-track frame arrays disagree with the timebase", async () => {
    const { store, executor } = await fixture();
    const queued = await store.enqueue({
      kind: "episode.package",
      input: packageInput({
        timebase: { frameRate: { numerator: 24, denominator: 1 }, frameCount: 4 },
        actionTrack: {
          contract: EPISODE_ACTION_TRACK_CONTRACT,
          cameraPose: {
            intrinsics: { fovDegrees: 50 },
            positions: [[0, 1, 0]],
            rotations: [[0, 0, 0, 1]],
          },
        },
      }),
      idempotencyKey: "episode-package:integrity",
      createId: () => "episode-job-integrity",
    });
    const result = await executor.execute(queued);
    expect(result?.status).toBe("failed");
    expect(result?.attempts.at(-1)?.error).toMatchObject({
      code: "episode_integrity_failed",
      retryable: false,
    });
  });

  it("fails retryably when the staged video is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "director-episode-package-missing-"));
    directories.push(directory);
    const store = new ProductionJobStore(directory);
    const inputs = new MediaTranscodeInputStore(directory, 1024 * 1024);
    const executor = new EpisodePackageExecutor({ store, inputs });
    const queued = await store.enqueue({
      kind: "episode.package",
      input: packageInput(),
      idempotencyKey: "episode-package:missing",
      createId: () => "episode-job-missing",
    });
    const result = await executor.execute(queued);
    expect(result?.status).toBe("failed");
    expect(result?.attempts.at(-1)?.error).toMatchObject({
      code: "staged_input_missing",
      retryable: true,
    });
  });
});
