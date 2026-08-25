import { mkdtemp } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ProductionArtifactVersionInput } from "../../../../packages/protocol/src/productionArtifactProtocol";
import { ProductionArtifactStore } from "../../artifacts/productionArtifactStore";
import { handleProductionArtifactRoute } from "../../routes/productionArtifactRoutes";

const now = "2026-08-03T00:00:00.000Z";

function version(): ProductionArtifactVersionInput {
  return {
    contract: "director-artifact-version-v1",
    versionId: "artifact-version-1",
    artifactId: "artifact-1",
    ordinal: 1,
    immutable: true,
    kind: "image",
    name: "Frame",
    content: { sha256: "a".repeat(64), bytes: 1, mimeType: "image/png", fileName: "frame.png" },
    provenance: { kind: "upload", sourceFingerprint: `sha256:${"b".repeat(64)}` },
    sourceVersionIds: [],
    createdAt: now,
    createdBy: "agent-1",
  };
}

async function requestRoute(method: string, path: string, body: unknown, store: ProductionArtifactStore) {
  const responses: Array<{ status: number; body: unknown }> = [];
  const handled = await handleProductionArtifactRoute(
    { method } as IncomingMessage,
    {} as ServerResponse,
    new URL(path, "http://director.local"),
    {
      readBody: async () => body,
      json: (_response, status, responseBody) => responses.push({ status, body: responseBody }),
      store,
      now: () => now,
    },
  );
  return { handled, response: responses[0] };
}

describe("production artifact routes", () => {
  it("creates, replays, lists, and reads immutable versions", async () => {
    const store = new ProductionArtifactStore(await mkdtemp(join(tmpdir(), "director-artifact-route-")));
    expect(
      await requestRoute("POST", "/api/production/artifact-versions", { version: version() }, store),
    ).toMatchObject({
      handled: true,
      response: { status: 201, body: { replayed: false } },
    });
    expect(
      await requestRoute("POST", "/api/production/artifact-versions", { version: version() }, store),
    ).toMatchObject({
      response: { status: 200, body: { replayed: true } },
    });
    expect(
      await requestRoute("GET", "/api/production/artifact-versions?artifact_id=artifact-1", null, store),
    ).toMatchObject({
      response: { status: 200, body: { versions: [{ versionId: "artifact-version-1" }] } },
    });
    expect(
      await requestRoute("GET", "/api/production/artifact-versions/artifact-version-1", null, store),
    ).toMatchObject({
      response: { status: 200, body: { version: { artifactId: "artifact-1" } } },
    });
  });

  it("returns a guarded promotion and rejects stale expected pointers", async () => {
    const store = new ProductionArtifactStore(await mkdtemp(join(tmpdir(), "director-artifact-route-")));
    await requestRoute("POST", "/api/production/artifact-versions", { version: version() }, store);
    const promotionBody = {
      promotionId: "client-promotion-1",
      target: { workspace: "canvas", ownerId: "node-1", slot: "media" },
      versionId: "artifact-version-1",
      expectedPreviousVersionId: null,
      promotedBy: "agent-1",
    };
    expect(await requestRoute("POST", "/api/production/promotions", promotionBody, store)).toMatchObject({
      response: { status: 201, body: { promotion: { previousVersionId: null, versionId: "artifact-version-1" } } },
    });
    expect(await requestRoute("POST", "/api/production/promotions", promotionBody, store)).toMatchObject({
      response: { status: 200, body: { replayed: true, promotion: { promotionId: "client-promotion-1" } } },
    });
    expect(
      await requestRoute(
        "POST",
        "/api/production/promotions",
        { ...promotionBody, promotedBy: "different-agent" },
        store,
      ),
    ).toMatchObject({ response: { status: 409, body: { code: "artifact_conflict" } } });
    expect(
      await requestRoute(
        "GET",
        "/api/production/promotions/current?workspace=canvas&owner_id=node-1&slot=media",
        null,
        store,
      ),
    ).toMatchObject({ response: { status: 200, body: { promotion: { versionId: "artifact-version-1" } } } });
  });

  it("rejects oversized route ids and ambiguous observed fingerprint sets", async () => {
    const store = new ProductionArtifactStore(await mkdtemp(join(tmpdir(), "director-artifact-route-")));
    expect(
      await requestRoute("GET", `/api/production/artifact-versions?artifact_id=${"a".repeat(241)}`, null, store),
    ).toMatchObject({ response: { status: 400, body: { code: "invalid_artifact_id" } } });

    expect(
      await requestRoute(
        "POST",
        "/api/production/promotions",
        {
          promotionId: "promotion-ambiguous",
          target: { workspace: "delivery", ownerId: "delivery-1", slot: "master" },
          versionId: "artifact-version-1",
          expectedPreviousVersionId: null,
          observedFingerprints: [
            { kind: "artifact", value: `artifact-version:v1:sha256:${"1".repeat(64)}` },
            { kind: "artifact", value: `artifact-version:v1:sha256:${"2".repeat(64)}` },
          ],
          promotedBy: "agent-1",
        },
        store,
      ),
    ).toMatchObject({ response: { status: 400, body: { code: "invalid_artifact_promotion" } } });
  });
});
