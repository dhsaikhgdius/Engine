import { describe, expect, it } from "vitest";
import {
  fetchArdyBridgeStatus,
  generateArdyMotion,
} from "../../../../../src/comprehensive/editor/motion/ardy/ardyMotionClient";

function ndjsonResponse(lines: unknown[], { status = 200 }: { status?: number } = {}) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { "content-type": "application/x-ndjson" } });
}

describe("fetchArdyBridgeStatus", () => {
  it("unwraps the gateway envelope", async () => {
    const status = await fetchArdyBridgeStatus(async () =>
      Response.json({ success: true, result: { configured: true, remote: false, model: "core8" } }),
    );
    expect(status).toEqual({ configured: true, remote: false, model: "core8" });
  });

  it("rejects on transport errors", async () => {
    await expect(fetchArdyBridgeStatus(async () => new Response("nope", { status: 503 }))).rejects.toThrow(/503/);
  });
});

describe("generateArdyMotion", () => {
  it("streams status lines and resolves with the done event", async () => {
    const statusLines: string[] = [];
    const requests: Array<{ path: string; body: unknown }> = [];

    const result = await generateArdyMotion(
      {
        prompt: "A person waves.",
        durationS: 4,
        seed: 7,
        onStatus: (message) => statusLines.push(message),
      },
      async (path, init) => {
        requests.push({ path, body: JSON.parse(String(init?.body)) });
        return ndjsonResponse([
          { event: "status", message: "Generating 4s of motion with ARDY core8…" },
          { event: "status", message: "Loaded model: core8" },
          {
            event: "done",
            jobId: "motion-abc",
            motionUrl: "/api/motion/ardy/motions/motion-abc",
            bytes: 9,
            model: "core8",
          },
        ]);
      },
    );

    expect(requests[0]).toEqual({
      path: "/api/motion/ardy/generate",
      body: { prompt: "A person waves.", durationS: 4, seed: 7 },
    });
    expect(statusLines).toEqual(["Generating 4s of motion with ARDY core8…", "Loaded model: core8"]);
    expect(result).toEqual({
      jobId: "motion-abc",
      motionUrl: "/api/motion/ardy/motions/motion-abc",
      bytes: 9,
      model: "core8",
    });
  });

  it("surfaces bridge error events as rejections", async () => {
    await expect(
      generateArdyMotion({ prompt: "x", durationS: 4 }, async () =>
        ndjsonResponse([
          { event: "status", message: "Generating…" },
          { event: "error", message: "python3 exited with code 1: CUDA out of memory" },
        ]),
      ),
    ).rejects.toThrow(/CUDA out of memory/);
  });

  it("rejects when the stream ends without a done event", async () => {
    await expect(
      generateArdyMotion({ prompt: "x", durationS: 4 }, async () =>
        ndjsonResponse([{ event: "status", message: "…" }]),
      ),
    ).rejects.toThrow(/without a completed motion/);
  });

  it("uses the JSON error body of non-streaming failures", async () => {
    await expect(
      generateArdyMotion({ prompt: "x", durationS: 4 }, async () =>
        Response.json({ success: false, error: "ARDY is not configured; set DIRECTOR_ARDY_REPO." }, { status: 503 }),
      ),
    ).rejects.toThrow(/DIRECTOR_ARDY_REPO/);
  });
});
