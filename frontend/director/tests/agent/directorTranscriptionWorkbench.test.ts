import { describe, expect, it, vi } from "vitest";
import type { DirectorMediaTranscript } from "@director/protocol/mediaTranscriptionProtocol";
import type { ProductionJobRecord } from "@director/protocol/productionJobProtocol";
import type { CreativeMediaAsset } from "../../src/comprehensive/editor/media/persistentCreativeMediaStore";
import { directorTranscriptionCommandSchema } from "@director/agent-engine/contract";
import { MediaTranscriptionRequestError } from "../../src/comprehensive/editor/media/mediaTranscriptionBridge";
import { executeDirectorTranscriptionWorkbenchCommand } from "../../src/agent/directorTranscriptionWorkbench";

const SOURCE_ID = "creative-media:audio:dialogue";

function asset() {
  return {
    id: SOURCE_ID,
    kind: "audio",
    name: "Dialogue",
    fileName: "dialogue.wav",
    mimeType: "audio/wav",
    durationSec: 2,
    proxyOf: null,
  } as CreativeMediaAsset;
}

function job(status: ProductionJobRecord["status"] = "succeeded") {
  return {
    id: "transcription-job-1",
    kind: "media.transcribe",
    status,
    input: {
      sourceMediaId: SOURCE_ID,
      sourceSha256: "a".repeat(64),
      sourceMimeType: "audio/wav",
      sourceFileName: "dialogue.wav",
      durationSec: 2,
      model: "whisper-1",
      language: "en",
    },
    artifacts: [],
  } as unknown as Extract<ProductionJobRecord, { kind: "media.transcribe" }>;
}

function transcript(): DirectorMediaTranscript {
  return {
    version: 1,
    jobId: "transcription-job-1",
    sourceMediaId: SOURCE_ID,
    sourceSha256: "a".repeat(64),
    provider: "openai-compatible",
    model: "whisper-1",
    language: "en",
    durationSec: 2,
    text: "Hello Director",
    segments: [{ startSec: 0, endSec: 2, text: "Hello Director", speaker: null, confidence: 0.9 }],
    createdAt: "2026-08-07T00:00:00.000Z",
  };
}

describe("Director transcription workbench", () => {
  it("submits exact durable Gallery media without putting bytes on the Agent command", async () => {
    const submitJob = vi.fn(async () => job("queued"));
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" });
    const command = directorTranscriptionCommandSchema.parse({
      action: "submit",
      source_media_id: SOURCE_ID,
      language: "en",
    });

    const result = await executeDirectorTranscriptionWorkbenchCommand(command, undefined, {
      dependencies: {
        getAsset: vi.fn(() => asset()),
        getBlob: vi.fn(async () => blob),
        submitJob,
      },
    });

    expect(result).toMatchObject({ success: true, result: { accepted: true, job: { kind: "media.transcribe" } } });
    expect(submitJob).toHaveBeenCalledWith(
      expect.objectContaining({
        asset: expect.objectContaining({ id: SOURCE_ID }),
        blob,
        language: "en",
      }),
    );
  });

  it("promotes a verified transcript and deduplicated caption timeline projection", async () => {
    const setTranscript = vi.fn(async () => asset());
    const insertCaptions = vi.fn(() => ({ inserted: 1, trackId: "video-2", alreadyPresent: false }));
    const command = directorTranscriptionCommandSchema.parse({
      action: "promote",
      job_id: "transcription-job-1",
      add_to_timeline: true,
      caption_offset_seconds: 4,
    });

    const result = await executeDirectorTranscriptionWorkbenchCommand(command, undefined, {
      dependencies: {
        inspectJob: vi.fn(async () => job()),
        getAsset: vi.fn(() => asset()),
        fetchTranscript: vi.fn(async () => transcript()),
        setTranscript,
        insertCaptions,
      },
    });

    expect(setTranscript).toHaveBeenCalledWith(SOURCE_ID, transcript());
    expect(insertCaptions).toHaveBeenCalledWith(
      [{ startSec: 0, endSec: 2, text: "Hello Director" }],
      expect.objectContaining({ sourceMediaId: SOURCE_ID, transcriptionJobId: "transcription-job-1", offsetSec: 4 }),
    );
    expect(result).toMatchObject({
      success: true,
      result: { transcription: { transcript_persisted: true, captions_inserted: 1, caption_track_id: "video-2" } },
    });
  });

  it("rejects image and proxy sources before upload", async () => {
    const command = directorTranscriptionCommandSchema.parse({
      action: "submit",
      source_media_id: SOURCE_ID,
    });
    const image = { ...asset(), kind: "image" } as CreativeMediaAsset;
    const result = await executeDirectorTranscriptionWorkbenchCommand(command, undefined, {
      dependencies: { getAsset: vi.fn(() => image) },
    });
    expect(result).toMatchObject({ success: false, result: { code: "transcription_failed" } });
  });

  it("surfaces the gateway's structured error code instead of a blanket transcription_failed", async () => {
    const command = directorTranscriptionCommandSchema.parse({
      action: "submit",
      source_media_id: SOURCE_ID,
      idempotency_key: "unconfigured-submit-key",
    });
    const result = await executeDirectorTranscriptionWorkbenchCommand(command, undefined, {
      dependencies: {
        getAsset: vi.fn(() => asset()),
        getBlob: vi.fn(async () => new Blob([new Uint8Array([1])], { type: "audio/wav" })),
        submitJob: vi.fn(async () => {
          throw new MediaTranscriptionRequestError("No transcription provider is configured",
            "transcription_not_configured", 503);
        }),
      },
    });
    expect(result).toEqual({
      success: false,
      error: "No transcription provider is configured",
      result: { code: "transcription_not_configured" },
    });

    const missing = await executeDirectorTranscriptionWorkbenchCommand(
      directorTranscriptionCommandSchema.parse({ action: "get", job_id: "missing-job" }),
      undefined,
      {
        dependencies: {
          inspectJob: vi.fn(async () => {
            throw new MediaTranscriptionRequestError("Transcription job does not exist",
              "transcription_job_not_found", 404);
          }),
        },
      },
    );
    expect(missing).toEqual({
      success: false,
      error: "Transcription job does not exist",
      result: { code: "transcription_job_not_found" },
    });
  });

  it("reports a transport-level fetch failure as an explicit gateway_unreachable code", async () => {
    const command = directorTranscriptionCommandSchema.parse({ action: "capabilities" });
    const result = await executeDirectorTranscriptionWorkbenchCommand(command, undefined, {
      dependencies: {
        capabilities: vi.fn(async () => {
          // Browsers reject a network-level fetch failure with this TypeError.
          throw new TypeError("Failed to fetch");
        }),
      },
    });
    expect(result).toEqual({
      success: false,
      error: "Failed to fetch",
      result: { code: "gateway_unreachable" },
    });
  });

  it("searches a promoted transcript by text, speaker, and time without returning the full transcript", async () => {
    const promoted = {
      ...asset(),
      durationSec: 12,
      transcript: {
        ...transcript(),
        durationSec: 12,
        text: "Opening line 你好导演 Closing line",
        segments: [
          { startSec: 0, endSec: 2, text: "Opening line", speaker: "Guest", confidence: 0.8 },
          { startSec: 4, endSec: 6, text: "你好导演", speaker: "Host", confidence: 0.95 },
          { startSec: 8, endSec: 10, text: "Closing line", speaker: "Host", confidence: 0.9 },
        ],
      },
    } as CreativeMediaAsset;
    const command = directorTranscriptionCommandSchema.parse({
      action: "search",
      source_media_id: SOURCE_ID,
      query: "你好 导演",
      speaker: "host",
      from_seconds: 3,
      to_seconds: 7,
    });

    const result = await executeDirectorTranscriptionWorkbenchCommand(command, undefined, {
      dependencies: { getAsset: vi.fn(() => promoted) },
    });

    expect(result).toEqual({
      success: true,
      result: {
        search: {
          source_media_id: SOURCE_ID,
          job_id: "transcription-job-1",
          query: "你好 导演",
          speaker: "host",
          total_matches: 1,
          matches: [
            {
              index: 1,
              start_seconds: 4,
              end_seconds: 6,
              speaker: "Host",
              confidence: 0.95,
              text: "你好导演",
            },
          ],
        },
      },
    });
  });

  it("reads a bounded transcript window and reports truncation", async () => {
    const promoted = {
      ...asset(),
      transcript: {
        ...transcript(),
        segments: [
          { startSec: 0, endSec: 1, text: "One", speaker: null, confidence: null },
          { startSec: 1, endSec: 2, text: "Two", speaker: null, confidence: null },
        ],
      },
    } as CreativeMediaAsset;
    const command = directorTranscriptionCommandSchema.parse({
      action: "read",
      source_media_id: SOURCE_ID,
      max_segments: 1,
    });

    const result = await executeDirectorTranscriptionWorkbenchCommand(command, undefined, {
      dependencies: { getAsset: vi.fn(() => promoted) },
    });

    expect(result).toMatchObject({
      success: true,
      result: {
        transcript: {
          total_segments_in_window: 2,
          truncated: true,
          segments: [{ index: 0, text: "One" }],
        },
      },
    });
  });
});
