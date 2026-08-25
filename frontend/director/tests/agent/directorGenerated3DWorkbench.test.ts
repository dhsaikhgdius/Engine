import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDirectorProjectRevision } from "@director/project-schema";
import { createInitialDirectorState, useDirectorStore } from "../../src/comprehensive/editor/store/directorStore";
import type { Generated3DJob } from "../../src/comprehensive/editor/generated3d/generated3dClient";
import { directorGenerated3DCommandSchema } from "@director/agent-engine/contract";
import { resetDirectorWorkbenchRuntimeForTests } from "../../src/agent/directorWorkbenchExecutor";
import { executeDirectorGenerated3DWorkbenchCommand } from "../../src/agent/directorGenerated3DWorkbench";

function job(status: Generated3DJob["status"] = "succeeded") {
  return {
    id: "agent-generated-job",
    kind: "model.generate",
    status,
    progress: status === "succeeded" ? 1 : 0,
    input: {
      mode: "text-to-3d",
      providerId: "meshy",
      name: "Agent statue",
      prompt: "A clean stone statue",
    },
    artifacts: [{ id: "receipt-1", role: "metadata" }],
  } as unknown as Generated3DJob;
}

beforeEach(() => {
  window.localStorage.clear();
  resetDirectorWorkbenchRuntimeForTests();
  useDirectorStore.setState({ ...useDirectorStore.getState(), ...createInitialDirectorState() });
});

describe("director generated 3D workbench", () => {
  it("requires a Gallery image identity for image-to-3D and coherent PBR settings", () => {
    expect(
      directorGenerated3DCommandSchema.safeParse({
        action: "submit",
        mode: "image-to-3d",
        name: "Missing source",
        prompt: "Object",
      }).success,
    ).toBe(false);
    expect(
      directorGenerated3DCommandSchema.safeParse({
        action: "submit",
        mode: "text-to-3d",
        name: "Bad PBR",
        prompt: "Object",
        texture: false,
        pbr: true,
      }).success,
    ).toBe(false);
  });

  it("maps a text request to the same production-job contract as the UI", async () => {
    const submitJob = vi.fn(async () => job("queued"));
    const command = directorGenerated3DCommandSchema.parse({
      action: "submit",
      mode: "text-to-3d",
      provider_id: "tripo",
      name: "Agent prop",
      prompt: "A carved arch",
      target_height_m: 2.4,
      topology: "lowpoly",
      target_polygon_count: 12_000,
      texture: true,
      pbr: true,
      seed: 21,
    });
    const execution = await executeDirectorGenerated3DWorkbenchCommand(command, undefined, {
      dependencies: { submitJob },
    });

    expect(execution).toMatchObject({ success: true, result: { accepted: true } });
    expect(submitJob).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "text-to-3d",
        providerId: "tripo",
        name: "Agent prop",
        targetHeightMeters: 2.4,
        topology: "lowpoly",
        targetPolygonCount: 12_000,
      }),
      undefined,
    );
  });

  it("promotes one generated asset and object into the current project", async () => {
    const expectedRevision = getDirectorProjectRevision(useDirectorStore.getState().project);
    const preparePromotion = vi.fn(async () => ({
      assetInput: {
        id: "generated3d:agent-generated-job",
        kind: "prop" as const,
        sourceType: "model" as const,
        name: "Agent statue",
        fileName: "generated-model.glb",
        url: "http://gateway.test/generated-3d/aaaaaaaa/model.glb",
        thumbnailUrl: "http://gateway.test/generated-3d/aaaaaaaa/thumbnail.png",
        assetSource: "generated" as const,
        modelNormalization: "preserve" as const,
        generation: {
          contract: "director-generated-3d-v1" as const,
          jobId: "agent-generated-job",
          providerId: "meshy" as const,
          externalId: "meshy:text-refine:remote-1",
          modelSha256: "a".repeat(64),
          thumbnailSha256: "b".repeat(64),
          receiptArtifactId: "receipt-1",
          prompt: "A clean stone statue",
          createdAt: "2026-08-07T00:00:00.000Z",
        },
      },
      galleryMediaId: "creative-media:image:statue",
      modelUrl: "http://gateway.test/generated-3d/aaaaaaaa/model.glb",
      thumbnailUrl: "http://gateway.test/generated-3d/aaaaaaaa/thumbnail.png",
      promotion: { receipt: { contract: "director-generated-3d-v1", jobId: "agent-generated-job" } },
    }));
    const command = directorGenerated3DCommandSchema.parse({
      action: "promote",
      job_id: "agent-generated-job",
      expected_revision: expectedRevision,
      idempotency_key: "generated-3d-promote-v1",
      object_id: "generated-statue-1",
      transform: { position: [2, 0, -1], rotation: [0, 0, 0], scale: [1, 1, 1] },
      placement_mode: "grounded",
    });
    const dependencies = {
      inspectJob: vi.fn(async () => job()),
      preparePromotion: preparePromotion as never,
    };

    const first = await executeDirectorGenerated3DWorkbenchCommand(command, undefined, {
      scope: "agent-generated-test",
      dependencies,
    });
    expect(first).toMatchObject({
      success: true,
      result: {
        generated_3d: {
          job_id: "agent-generated-job",
          asset_id: "generated3d:agent-generated-job",
          object_id: "generated-statue-1",
          gallery_media_id: "creative-media:image:statue",
        },
      },
    });
    expect(
      useDirectorStore.getState().project.assets.find((asset) => asset.id === "generated3d:agent-generated-job"),
    ).toMatchObject({
      assetSource: "generated",
      generation: { externalId: "meshy:text-refine:remote-1" },
    });
    expect(
      useDirectorStore.getState().project.objects.find((object) => object.id === "generated-statue-1"),
    ).toMatchObject({
      assetRefId: "generated3d:agent-generated-job",
      transform: { position: [2, 0, -1] },
      placementMode: "grounded",
    });

    expect(
      useDirectorStore.getState().project.objects.filter((object) => object.id === "generated-statue-1"),
    ).toHaveLength(1);

    const replay = await executeDirectorGenerated3DWorkbenchCommand(command, undefined, {
      scope: "agent-generated-test",
      dependencies,
    });
    expect(replay).toMatchObject({
      success: true,
      result: { idempotency_key: "generated-3d-promote-v1", idempotency_replayed: true },
    });
    expect(
      useDirectorStore.getState().project.objects.filter((object) => object.id === "generated-statue-1"),
    ).toHaveLength(1);
  });
});
