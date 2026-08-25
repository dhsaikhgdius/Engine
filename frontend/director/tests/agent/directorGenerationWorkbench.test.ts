import { describe, expect, it, vi } from "vitest";
import type { ComfyNodeSnapshot, ComfyWorkflowRecord } from "@director/protocol/comfyGenerationProtocol";
import type { ProductionJobRecord } from "@director/protocol/productionJobProtocol";
import type { CreativeMediaAsset } from "../../src/comprehensive/editor/media/persistentCreativeMediaStore";
import { directorGenerationCommandSchema } from "@director/agent-engine/contract";
import { executeDirectorGenerationWorkbenchCommand } from "../../src/agent/directorGenerationWorkbench";

const ARTIFACT_SHA256 = "a".repeat(64);

function audioJob(status: ProductionJobRecord["status"] = "succeeded") {
  return {
    id: "generation-audio-1",
    kind: "audio.generate",
    status,
    input: {
      prompt: "Soft rain against glass",
      negativePrompt: "speech",
      mode: "sound-effect",
      durationSeconds: 8,
      sampleRate: 48_000,
      workflowId: "comfy-workflow-audio-main",
      nodeId: "node-a",
      seed: 17,
      parameters: { "12.volume": 0.8 },
      sourceArtifactIds: [],
      promptProvenance: { source: "manual", editedAfterCompile: false },
    },
    artifacts: [
      {
        id: "artifact-audio-1",
        attemptId: "attempt-1",
        role: "primary",
        mimeType: "audio/wav",
        fileName: "rain.wav",
        sha256: ARTIFACT_SHA256,
        bytes: 4,
        createdAt: "2026-08-07T00:00:00.000Z",
      },
      {
        id: "artifact-receipt-1",
        attemptId: "attempt-1",
        role: "receipt",
        mimeType: "application/json",
        fileName: "receipt.json",
        sha256: "b".repeat(64),
        bytes: 2,
        createdAt: "2026-08-07T00:00:00.000Z",
      },
    ],
  } as unknown as ProductionJobRecord;
}

function workflow() {
  return {
    version: 1,
    id: "comfy-workflow-audio-main",
    name: "Audio main",
    description: "Production audio",
    category: "Audio",
    mediaKind: "audio",
    workflow: { "12": { class_type: "SaveAudio", inputs: {} } },
    parameters: [],
    workflowSha256: "c".repeat(64),
    source: "imported",
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
  } as ComfyWorkflowRecord;
}

describe("director Gallery generation workbench", () => {
  it("validates audio controls and artifact selection", () => {
    expect(
      directorGenerationCommandSchema.parse({
        action: "submit",
        kind: "audio.generate",
        workflow_id: "comfy-workflow-audio-main",
        prompt: "Narrate the slate",
        audio_mode: "speech",
        voice: "director",
        language: "zh-CN",
      }),
    ).toMatchObject({ duration_seconds: 5, sample_rate: 48_000, copies: 1, seed_strategy: "increment" });
    expect(
      directorGenerationCommandSchema.safeParse({
        action: "submit",
        kind: "image.generate",
        workflow_id: "comfy-workflow-image-main",
        prompt: "A wide landscape",
        voice: "invalid-for-image",
      }).success,
    ).toBe(false);
  });

  it("maps a durable Agent audio submission onto the same request as Gallery", async () => {
    const submitJob = vi.fn(async () => ({ groupId: "group-1", jobs: [audioJob("queued")] }));
    const command = directorGenerationCommandSchema.parse({
      action: "submit",
      kind: "audio.generate",
      workflow_id: "comfy-workflow-audio-main",
      prompt: "Soft rain against glass",
      negative_prompt: "speech",
      duration_seconds: 8,
      sample_rate: 48_000,
      seed: 17,
      parameters: { "12.volume": 0.8 },
      node_ids: ["node-a"],
      copies: 2,
      seed_strategy: "fixed",
    });

    const execution = await executeDirectorGenerationWorkbenchCommand(command, undefined, {
      dependencies: { submitJob },
    });

    expect(execution).toMatchObject({ success: true, result: { groupId: "group-1", accepted: true } });
    expect(submitJob).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "audio.generate",
        workflowId: "comfy-workflow-audio-main",
        durationSeconds: 8,
        sampleRate: 48_000,
        nodeIds: ["node-a"],
        copies: 2,
        seedStrategy: "fixed",
      }),
      undefined,
    );
  });

  it("returns bounded workflow discovery without leaking the full graph", async () => {
    const node = { id: "node-a", label: "Node A" } as ComfyNodeSnapshot;
    const nodes = await executeDirectorGenerationWorkbenchCommand(
      directorGenerationCommandSchema.parse({ action: "nodes" }),
      undefined,
      { dependencies: { listNodes: vi.fn(async () => [node]) } },
    );
    expect(nodes).toMatchObject({ success: true, result: { nodes: [{ id: "node-a" }] } });

    const workflows = await executeDirectorGenerationWorkbenchCommand(
      directorGenerationCommandSchema.parse({ action: "workflows", media_kind: "audio" }),
      undefined,
      { dependencies: { listWorkflows: vi.fn(async () => [workflow()]) } },
    );
    expect(workflows).toMatchObject({ success: true, result: { workflows: [{ mediaKind: "audio" }] } });
    expect((workflows.result as { workflows: Array<Record<string, unknown>> }).workflows[0]).not.toHaveProperty(
      "workflow",
    );
  });

  it("checks the downloaded media shape before persisting an audio result with waveform data", async () => {
    const importedAsset = {
      id: `creative-media:audio:${ARTIFACT_SHA256}`,
      kind: "audio",
      fileName: "rain.wav",
      waveform: null,
    } as CreativeMediaAsset;
    const importFile = vi.fn(async () => importedAsset);
    const ensureWaveform = vi.fn(async () => ({ peaks: [0.5] }));
    const command = directorGenerationCommandSchema.parse({
      action: "promote",
      job_id: "generation-audio-1",
      artifact_ids: ["artifact-audio-1"],
      ensure_waveform: true,
    });

    const execution = await executeDirectorGenerationWorkbenchCommand(command, undefined, {
      dependencies: {
        inspectJob: vi.fn(async () => audioJob()),
        listWorkflows: vi.fn(async () => [workflow()]),
        fetchArtifact: vi.fn(async () => new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/wav" })),
        probeFile: vi.fn(async () => ({ kind: "audio" as const, durationSec: 8, waveform: null })),
        importFile,
        ensureWaveform,
      },
    });

    expect(execution).toMatchObject({
      success: true,
      result: {
        generation: {
          job_id: "generation-audio-1",
          promoted: [
            {
              artifact_id: "artifact-audio-1",
              media_id: `creative-media:audio:${ARTIFACT_SHA256}`,
              bytes: 4,
              waveform_ready: true,
            },
          ],
        },
      },
    });
    expect(importFile).toHaveBeenCalledWith(
      expect.any(File),
      expect.objectContaining({
        kind: "audio",
        source: "comfy-generation:generation-audio-1",
        embeddedMetadata: expect.objectContaining({
          director_prompt: "Soft rain against glass",
          workflow: expect.stringContaining("SaveAudio"),
        }),
      }),
    );
    expect(ensureWaveform).toHaveBeenCalledWith(importedAsset.id);
  });

  it("rejects incomplete jobs and missing selections", async () => {
    const promote = directorGenerationCommandSchema.parse({
      action: "promote",
      job_id: "generation-audio-1",
      artifact_ids: ["artifact-audio-1"],
    });
    expect(
      await executeDirectorGenerationWorkbenchCommand(promote, undefined, {
        dependencies: { inspectJob: vi.fn(async () => audioJob("running")) },
      }),
    ).toMatchObject({ success: false, error: expect.stringContaining("not succeeded") });

    const missing = directorGenerationCommandSchema.parse({
      action: "promote",
      job_id: "generation-audio-1",
      artifact_ids: ["missing-artifact"],
    });
    expect(
      await executeDirectorGenerationWorkbenchCommand(missing, undefined, {
        dependencies: { inspectJob: vi.fn(async () => audioJob()) },
      }),
    ).toMatchObject({ success: false, error: expect.stringContaining("does not exist") });
  });
});
