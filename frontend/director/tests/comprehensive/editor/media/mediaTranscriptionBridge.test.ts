import { afterEach, describe, expect, it, vi } from "vitest";

const controlPlaneMocks = vi.hoisted(() => ({
  directorControlPlaneFetch: vi.fn(),
  directorControlPlaneUrl: (path: string) => `http://director.test${path}`,
}));

vi.mock("../../../../src/comprehensive/editor/api/directorControlPlaneClient", () => controlPlaneMocks);

import {
  getMediaTranscriptionCapabilities,
  inspectMediaTranscriptionJob,
  MediaTranscriptionRequestError,
} from "../../../../src/comprehensive/editor/media/mediaTranscriptionBridge";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const capabilities = {
  version: 1,
  configured: false,
  provider: "openai-compatible",
  model: "whisper-1",
  endpointHost: null,
  maxInputBytes: 200 * 1024 * 1024,
  supportsSegments: true,
  supportsVtt: true,
  supportsLongMedia: true,
  longMediaStrategy: "adaptive-chunking",
  chunkThresholdSec: 900,
  chunkDurationSec: 600,
  chunkConcurrency: 2,
};

afterEach(() => vi.clearAllMocks());

describe("mediaTranscriptionBridge", () => {
  it("reports an unconfigured provider as an explicit capabilities state, not an error", async () => {
    controlPlaneMocks.directorControlPlaneFetch.mockResolvedValue(jsonResponse(200, capabilities));
    await expect(getMediaTranscriptionCapabilities()).resolves.toMatchObject({
      configured: false,
      provider: "openai-compatible",
      endpointHost: null,
    });
  });

  it("propagates the gateway's structured error code and status on non-ok responses", async () => {
    controlPlaneMocks.directorControlPlaneFetch.mockResolvedValue(
      jsonResponse(404, { code: "transcription_job_not_found", message: "Transcription job does not exist" }),
    );
    const failure = await inspectMediaTranscriptionJob("missing-job").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MediaTranscriptionRequestError);
    expect(failure).toMatchObject({
      code: "transcription_job_not_found",
      status: 404,
      message: "Transcription job does not exist",
    });
  });

  it("keeps a null code and a status-bearing message when the gateway response has no structured body", async () => {
    controlPlaneMocks.directorControlPlaneFetch.mockResolvedValue(new Response("upstream broke", { status: 502 }));
    const failure = await inspectMediaTranscriptionJob("any-job").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MediaTranscriptionRequestError);
    expect(failure).toMatchObject({ code: null, status: 502, message: "Transcription request failed (502)" });
  });
});
