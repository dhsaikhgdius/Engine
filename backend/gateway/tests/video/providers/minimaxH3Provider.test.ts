import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MinimaxH3Provider, minimaxH3Duration, minimaxH3Ratio, minimaxH3Resolution } from "../../../video/providers/minimaxH3Provider";
import { VideoProviderHttpError } from "../../../video/providers/videoProvider";

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function generationRequest(overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: "shot:scene-1:take-1",
    prompt: "A captain watches the fleet jump to warp from the bridge window.",
    width: 1280,
    height: 720,
    frameRate: 24,
    numFrames: 120,
    seed: 42,
    generateAudio: true,
    enhancePrompt: false,
    conditioning: [],
    metadata: {},
    ...overrides,
  };
}

describe("MiniMax H3 contract mapping", () => {
  it("normalizes duration, resolution, and ratio into the H3 contract", () => {
    expect(minimaxH3Duration(120, 24)).toBe(5);
    expect(minimaxH3Duration(24, 24)).toBe(4);
    expect(minimaxH3Duration(1_441, 24)).toBe(15);
    expect(minimaxH3Resolution(1280, 720)).toBe("768P");
    expect(minimaxH3Resolution(2560, 1440)).toBe("2K");
    expect(minimaxH3Ratio(1280, 720)).toBe("16:9");
    expect(minimaxH3Ratio(720, 1280)).toBe("9:16");
    expect(minimaxH3Ratio(1024, 1024)).toBe("1:1");
    expect(minimaxH3Ratio(1216, 512)).toBe("21:9");
  });
});

describe("MinimaxH3Provider", () => {
  it("submits a text-to-video task and derives a restart-safe job id from the task id", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("https://api.minimax.io/v2/video_generation");
      expect(init?.method).toBe("POST");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer test-secret");
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(payload).toMatchObject({
        model: "MiniMax-H3",
        resolution: "768P",
        duration: 5,
        ratio: "16:9",
      });
      expect(payload.content).toEqual([
        { type: "text", text: "A captain watches the fleet jump to warp from the bridge window." },
      ]);
      return jsonResponse({ task_id: "424010985738629" });
    });
    const provider = new MinimaxH3Provider({ apiKey: "test-secret", fetchImpl });

    const job = await provider.submit(
      generationRequest({
        negativePrompt: "flicker",
        conditioning: [
          {
            role: "depth",
            uri: "/workspace/data/depth.png",
            mimeType: "image/png",
            frameIndex: 0,
            strength: 1,
            crf: 19,
          },
        ],
      }),
    );

    expect(job.id).toBe("video-mmx-424010985738629");
    expect(job.provider).toBe("minimax-h3");
    expect(job.status).toBe("queued");
    expect(job.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("negative prompt"),
        expect.stringContaining("seed"),
        expect.stringContaining("depth"),
      ]),
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("uploads a local reference frame as a first_frame data URI with adaptive ratio", async () => {
    const directory = await mkdtemp(join(tmpdir(), "minimax-h3-"));
    const referencePath = join(directory, "reference.png");
    await writeFile(referencePath, Buffer.from("fake-png-bytes"));
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const payload = JSON.parse(String(init?.body)) as { content: Array<Record<string, unknown>>; ratio: string };
      expect(payload.ratio).toBe("adaptive");
      expect(payload.content).toHaveLength(2);
      expect(payload.content[1]).toMatchObject({ type: "image_url", role: "first_frame" });
      const image = payload.content[1].image_url as { url: string };
      expect(image.url).toBe(`data:image/png;base64,${Buffer.from("fake-png-bytes").toString("base64")}`);
      return jsonResponse({ task_id: "424010985738630" });
    });
    const provider = new MinimaxH3Provider({ apiKey: "test-secret", fetchImpl });

    const job = await provider.submit(
      generationRequest({
        conditioning: [
          {
            role: "clean-frame",
            uri: referencePath,
            mimeType: "image/png",
            frameIndex: 0,
            strength: 1,
            crf: 19,
          },
        ],
      }),
    );
    expect(job.id).toBe("video-mmx-424010985738630");
  });

  it("maps query-task states, outputs, and failures onto the provider job contract", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      expect(url).toContain("/v2/query/video_generation/424010985738629");
      if (fetchImpl.mock.calls.length === 1) {
        return jsonResponse({
          task: { id: "424010985738629", status: "running", created_at: 1_785_125_529, updated_at: 1_785_125_600 },
        });
      }
      if (fetchImpl.mock.calls.length === 2) {
        return jsonResponse({
          task: {
            id: "424010985738629",
            status: "succeeded",
            created_at: 1_785_125_529,
            updated_at: 1_785_125_946,
            content: { url: "https://cdn.minimax.example/output.mp4" },
          },
        });
      }
      return jsonResponse({
        task: {
          id: "424010985738629",
          status: "failed",
          created_at: 1_785_125_529,
          updated_at: 1_785_125_946,
          error: { code: "1026", message: "video description contains sensitive content" },
        },
      });
    });
    const provider = new MinimaxH3Provider({ apiKey: "test-secret", fetchImpl });

    await expect(provider.getJob("video-mmx-424010985738629")).resolves.toMatchObject({ status: "running" });
    await expect(provider.getJob("video-mmx-424010985738629")).resolves.toMatchObject({
      status: "completed",
      createdAt: "2026-07-27T04:12:09.000Z",
      outputs: [{ kind: "video", uri: "https://cdn.minimax.example/output.mp4", mimeType: "video/mp4" }],
    });
    await expect(provider.getJob("video-mmx-424010985738629")).resolves.toMatchObject({
      status: "failed",
      error: { code: "1026", message: "video description contains sensitive content", retriable: false },
    });
  });

  it("reports cancellation honestly because the hosted API cannot cancel", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        task: { id: "424010985738629", status: "running", created_at: 1_785_125_529, updated_at: 1_785_125_600 },
      }),
    );
    const provider = new MinimaxH3Provider({ apiKey: "test-secret", fetchImpl });
    const job = await provider.cancel("video-mmx-424010985738629");
    expect(job.status).toBe("running");
    expect(job.cancelRequested).toBe(true);
    expect(job.warnings.join(" ")).toContain("does not support cancelling");
  });

  it("surfaces OpenAI-style errors with retriability derived from the HTTP status", async () => {
    const provider = new MinimaxH3Provider({
      apiKey: "test-secret",
      fetchImpl: vi.fn<typeof fetch>(async () =>
        jsonResponse(
          { type: "error", error: { type: "rate_limit_error", message: "rate limit, please retry later (1002)" } },
          429,
        ),
      ),
    });
    const rateLimited = provider.getJob("video-mmx-424010985738629");
    await expect(rateLimited).rejects.toBeInstanceOf(VideoProviderHttpError);
    await expect(rateLimited).rejects.toMatchObject({ status: 429, retriable: true });

    const insufficient = new MinimaxH3Provider({
      apiKey: "test-secret",
      fetchImpl: vi.fn<typeof fetch>(async () =>
        jsonResponse(
          { type: "error", error: { type: "insufficient_balance_error", message: "insufficient balance (1008)" } },
          402,
        ),
      ),
    });
    const failed = insufficient.submit(generationRequest());
    await expect(failed).rejects.toBeInstanceOf(VideoProviderHttpError);
    await expect(failed).rejects.toMatchObject({ status: 402, retriable: false });
  });

  it("rejects job ids that were not minted by this provider", async () => {
    const provider = new MinimaxH3Provider({ apiKey: "test-secret", fetchImpl: vi.fn<typeof fetch>() });
    await expect(provider.getJob("video-12345678-abcd")).rejects.toThrow("was not created by the MiniMax H3 provider");
  });
});
