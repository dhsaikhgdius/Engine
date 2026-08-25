// @vitest-environment node

import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { ReferenceSceneAnalyzer } from "../../reconstruction/referenceSceneAnalyzer";
import { ReferenceSceneAnalysisError } from "../../reconstruction/referenceSceneAnalyzer";
import { handleReferenceSceneRoute } from "../../routes/referenceSceneRoutes";

const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xd9]);

function payload() {
  return {
    version: 1,
    projectRevision: `director-project-revision:v1:sha256:${"a".repeat(64)}`,
    prompt: "Reference blocking",
    applyMode: "append",
    analysisMode: "local",
    profileId: null,
    maxObjects: 4,
    image: {
      fileName: "reference.jpg",
      mimeType: "image/jpeg",
      base64: bytes.toString("base64"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      metrics: {
        width: 640,
        height: 480,
        palette: ["#112233"],
        meanLuminance: 0.3,
        edgeDensity: 0.2,
        foregroundCoverage: 0.5,
      },
    },
  };
}

function request(method = "POST") {
  return Object.assign(new EventEmitter(), { method }) as IncomingMessage;
}

function response() {
  return Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false }) as ServerResponse;
}

describe("reference scene routes", () => {
  it("validates and returns an analyzed plan", async () => {
    const analyze = vi.fn(async () => ({ id: "plan-1" }));
    const writes: Array<{ status: number; body: unknown }> = [];
    const handled = await handleReferenceSceneRoute(
      request(),
      response(),
      new URL("http://director.test/api/reconstruction/reference-scene/analyze"),
      {
        readBody: async () => payload(),
        json: (_response, status, body) => writes.push({ status, body }),
        analyzer: { analyze } as unknown as ReferenceSceneAnalyzer,
      },
    );

    expect(handled).toBe(true);
    expect(analyze).toHaveBeenCalledWith(expect.objectContaining({ maxObjects: 4 }), expect.any(AbortSignal));
    expect(writes).toEqual([{ status: 200, body: { plan: { id: "plan-1" } } }]);
  });

  it("rejects malformed requests before calling the analyzer", async () => {
    const analyze = vi.fn();
    const writes: Array<{ status: number; body: unknown }> = [];
    await handleReferenceSceneRoute(
      request(),
      response(),
      new URL("http://director.test/api/reconstruction/reference-scene/analyze"),
      {
        readBody: async () => ({ prompt: "missing everything" }),
        json: (_response, status, body) => writes.push({ status, body }),
        analyzer: { analyze } as unknown as ReferenceSceneAnalyzer,
      },
    );

    expect(analyze).not.toHaveBeenCalled();
    expect(writes[0]).toMatchObject({ status: 400, body: { code: "invalid_request" } });
  });

  it("preserves public analyzer error codes", async () => {
    const writes: Array<{ status: number; body: unknown }> = [];
    await handleReferenceSceneRoute(
      request(),
      response(),
      new URL("http://director.test/api/reconstruction/reference-scene/analyze"),
      {
        readBody: async () => payload(),
        json: (_response, status, body) => writes.push({ status, body }),
        analyzer: {
          analyze: vi.fn(async () => {
            throw new ReferenceSceneAnalysisError("Vision unavailable", 409, "profile_unavailable");
          }),
        } as unknown as ReferenceSceneAnalyzer,
      },
    );

    expect(writes).toEqual([{ status: 409, body: { error: "Vision unavailable", code: "profile_unavailable" } }]);
  });

  it("does not claim unrelated paths", async () => {
    await expect(
      handleReferenceSceneRoute(
        request("GET"),
        response(),
        new URL("http://director.test/api/reconstruction/reference-scene/analyze"),
        {
          readBody: async () => payload(),
          json: vi.fn(),
          analyzer: { analyze: vi.fn() } as unknown as ReferenceSceneAnalyzer,
        },
      ),
    ).resolves.toBe(false);
  });
});
