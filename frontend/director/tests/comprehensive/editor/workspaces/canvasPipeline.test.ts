import { createHash } from "node:crypto";
import { act } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import {
  comfyNodeSnapshotSchema,
  comfyWorkflowRecordSchema,
  type ComfyGenerationSubmitRequest,
  type ComfyMediaKind,
} from "../../../../../../packages/protocol/src/comfyGenerationProtocol";
import {
  productionJobRecordSchema,
  type ProductionJobRecord,
} from "../../../../../../packages/protocol/src/productionJobProtocol";
import { getDirectorCanvasGraphFingerprint, startDirectorCanvasPipeline } from "../../../../src/comprehensive/editor/workspaces/canvasPipeline";
import { useDirectorCreativeWorkspaceStore, type DirectorBoardNode } from "../../../../src/comprehensive/editor/workspaces/directorWorkspaceStore";

const now = "2026-08-07T00:00:00.000Z";
const executionNode = comfyNodeSnapshotSchema.parse({
  id: "gpu-a",
  label: "GPU A",
  baseUrl: "http://127.0.0.1:8188",
  enabled: true,
  maxConcurrent: 2,
  status: "online",
  activeJobs: 0,
  queuedJobs: 0,
  queueRemaining: 0,
  ramTotalBytes: null,
  ramFreeBytes: null,
  vramTotalBytes: null,
  vramFreeBytes: null,
  deviceName: "Test GPU",
  detail: null,
  checkedAt: now,
});

function workflow(mediaKind: ComfyMediaKind) {
  return comfyWorkflowRecordSchema.parse({
    version: 1,
    id: `comfy-workflow-canvas-${mediaKind}`,
    name: `Canvas ${mediaKind}`,
    description: "Test workflow",
    category: "Test",
    mediaKind,
    workflow: { "1": { class_type: "DirectorTestNode", inputs: {} } },
    parameters: [],
    workflowSha256: mediaKind === "image" ? "a".repeat(64) : mediaKind === "video" ? "b".repeat(64) : "c".repeat(64),
    source: "configured",
    createdAt: now,
    updatedAt: now,
  });
}

const workflows = [workflow("image"), workflow("video"), workflow("audio")];

async function sha256(blob: Blob) {
  return createHash("sha256")
    .update(Buffer.from(await blob.arrayBuffer()))
    .digest("hex");
}

async function generationJob(
  request: ComfyGenerationSubmitRequest,
  status: "running" | "succeeded" | "failed",
  blob?: Blob,
) {
  const id = `job-${request.kind}-${request.sourceContext.metadata.canvasNodeId}`;
  const artifact =
    status === "succeeded" && blob
      ? {
          id: `artifact-${id}`,
          attemptId: `${id}-attempt-1`,
          role: "primary",
          mimeType: blob.type,
          fileName:
            request.kind === "image.generate"
              ? "output.png"
              : request.kind === "video.generate"
                ? "output.mp4"
                : "output.wav",
          sha256: await sha256(blob),
          bytes: blob.size,
          createdAt: now,
        }
      : null;
  const baseInput = {
    prompt: request.prompt,
    negativePrompt: request.negativePrompt,
    workflowId: request.workflowId,
    nodeId: executionNode.id,
    seed: request.seed,
    parameters: request.parameters,
    inputImages: request.inputImages,
    sourceArtifactIds: request.sourceArtifactIds,
    sourceContext: request.sourceContext,
    promptProvenance: request.promptProvenance,
  };
  const input =
    request.kind === "image.generate"
      ? { ...baseInput, width: request.width, height: request.height }
      : request.kind === "video.generate"
        ? {
            ...baseInput,
            width: request.width,
            height: request.height,
            durationSeconds: request.durationSeconds,
            fps: request.fps,
          }
        : {
            ...baseInput,
            mode: request.audioMode,
            durationSeconds: request.durationSeconds,
            sampleRate: request.sampleRate,
            voice: request.voice,
            language: request.language,
          };
  return productionJobRecordSchema.parse({
    contractVersion: 1,
    id,
    kind: request.kind,
    status,
    progress: status === "succeeded" ? 1 : status === "running" ? 0.5 : 0,
    inputFingerprint: `fp-${id}`,
    idempotencyKey: request.idempotencyKey!,
    input,
    attempts: [
      {
        id: `${id}-attempt-1`,
        number: 1,
        status,
        provider: `comfyui:${executionNode.id}`,
        inputFingerprint: `fp-${id}`,
        idempotencyKey: request.idempotencyKey!,
        sourceRevisions: {},
        timestamps: {
          createdAt: now,
          ...(status !== "running" ? { startedAt: now, finishedAt: now } : { startedAt: now }),
        },
        artifacts: artifact ? [artifact] : [],
      },
    ],
    artifacts: artifact ? [artifact] : [],
    ...(artifact ? { artifact } : {}),
    ...(status === "failed" ? { error: "provider failed" } : {}),
    createdAt: now,
    updatedAt: now,
  });
}

function addNode(kind: DirectorBoardNode["kind"], title: string, x: number) {
  return useDirectorCreativeWorkspaceStore.getState().addBoardNode({ kind, title, body: `${title} prompt`, x, y: 40 })!;
}

function baseDependencies(blobs: Map<string, Blob>): Record<string, any> {
  return {
    listWorkflows: vi.fn(async () => workflows),
    listNodes: vi.fn(async () => [executionNode]),
    submit: vi.fn(),
    inspect: vi.fn(),
    retry: vi.fn(),
    reconcile: vi.fn(),
    cancel: vi.fn(),
    fetchArtifact: vi.fn(async (jobId: string) => blobs.get(jobId)!),
    uploadInputImage: vi.fn(),
    getMediaAsset: vi.fn(() => null),
    getMediaBlob: vi.fn(async () => null),
    probeMediaFile: vi.fn(async (file: File) => ({
      kind: (file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : "audio") as
        "image" | "video" | "audio",
      durationSec: file.type.startsWith("image/") ? null : 5,
      width: file.type.startsWith("image/") || file.type.startsWith("video/") ? 1024 : null,
      height: file.type.startsWith("image/") || file.type.startsWith("video/") ? 576 : null,
    })),
    importMediaFile: vi.fn(async (file: File) => ({
      id: `creative-media:${file.type.split("/")[0]}:${file.name}`,
      kind: file.type.split("/")[0] as "image" | "video" | "audio",
      name: file.name,
      fileName: file.name,
      mimeType: file.type,
      size: file.size,
      createdAt: now,
      lastModified: file.lastModified,
      durationSec: null,
      width: 1024,
      height: 576,
      source: "canvas-pipeline:test",
      objectUrl: `blob:${file.name}`,
    })),
    now: () => new Date(now),
    delay: vi.fn(async (_milliseconds: number, _signal: AbortSignal) => undefined),
  };
}

beforeEach(() => {
  window.localStorage.clear();
  act(() => useDirectorCreativeWorkspaceStore.getState().resetCreativeWorkspaces());
});

it("executes independent generation branches in one durable DAG run and returns verified artifacts to their nodes", async () => {
  const root = addNode("note", "Scene brief", 20);
  const image = addNode("image", "Hero frame", 360);
  const audio = addNode("audio", "Music score", 360);
  act(() => {
    const store = useDirectorCreativeWorkspaceStore.getState();
    store.addBoardEdge(root.id, image.id);
    store.addBoardEdge(root.id, audio.id);
  });
  const imageBlob = new Blob(["verified image"], { type: "image/png" });
  const audioBlob = new Blob(["verified audio"], { type: "audio/wav" });
  const blobs = new Map<string, Blob>();
  const dependencies = baseDependencies(blobs);
  dependencies.submit = vi.fn(async (request: ComfyGenerationSubmitRequest) => {
    const blob = request.kind === "image.generate" ? imageBlob : audioBlob;
    const job = await generationJob(request, "succeeded", blob);
    blobs.set(job.id, blob);
    return { groupId: `group-${job.id}`, jobs: [job] };
  });

  const run = await startDirectorCanvasPipeline({
    runId: "canvas-run-parallel",
    dependencies,
  }).promise;

  expect(run.status).toBe("succeeded");
  expect(run.nodeRuns).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ nodeId: root.id, status: "passthrough" }),
      expect.objectContaining({ nodeId: image.id, status: "succeeded", mediaId: "creative-media:image:output.png" }),
      expect.objectContaining({ nodeId: audio.id, status: "succeeded", mediaId: "creative-media:audio:output.wav" }),
    ]),
  );
  expect(dependencies.submit).toHaveBeenCalledTimes(2);
  expect(dependencies.submit.mock.calls.map((call: [ComfyGenerationSubmitRequest]) => call[0].prompt)).toEqual(
    expect.arrayContaining([expect.stringContaining("Scene brief")]),
  );
  const state = useDirectorCreativeWorkspaceStore.getState();
  expect(state.boardPipelineRuns.at(-1)).toMatchObject({ id: run.id, status: "succeeded" });
  expect(state.boardNodes.find((node) => node.id === image.id)).toMatchObject({
    mediaId: "creative-media:image:output.png",
    productionJobStatus: "succeeded",
    productionHistory: [expect.objectContaining({ runId: run.id, status: "succeeded" })],
  });
});

it("runs only a selected node and its ancestors, with an explicit force flag for regenerated outputs", async () => {
  const root = addNode("note", "Root context", 20);
  const image = addNode("image", "Existing image", 320);
  const unrelatedAudio = addNode("audio", "Unrelated audio", 320);
  act(() => {
    const store = useDirectorCreativeWorkspaceStore.getState();
    store.addBoardEdge(root.id, image.id);
    store.updateBoardNode(image.id, { mediaId: "creative-media:image:old" });
  });
  const blob = new Blob(["new image"], { type: "image/png" });
  const blobs = new Map<string, Blob>();
  const dependencies = baseDependencies(blobs);
  dependencies.submit = vi.fn(async (request: ComfyGenerationSubmitRequest) => {
    const job = await generationJob(request, "succeeded", blob);
    blobs.set(job.id, blob);
    return { groupId: `group-${job.id}`, jobs: [job] };
  });

  const run = await startDirectorCanvasPipeline({
    runId: "canvas-run-targeted",
    targetNodeIds: [image.id],
    forceNodeIds: [image.id],
    dependencies,
  }).promise;

  expect(run.status).toBe("succeeded");
  expect(run.nodeRuns.map((nodeRun) => nodeRun.nodeId)).toEqual(expect.arrayContaining([root.id, image.id]));
  expect(run.nodeRuns.map((nodeRun) => nodeRun.nodeId)).not.toContain(unrelatedAudio.id);
  expect(dependencies.submit).toHaveBeenCalledOnce();
  expect(useDirectorCreativeWorkspaceStore.getState().boardNodes.find((node) => node.id === image.id)?.mediaId).toBe(
    "creative-media:image:output.png",
  );
});

it("does not treat a missing durable media reference as a cached Canvas result", async () => {
  const image = addNode("image", "Missing output", 20);
  act(() => {
    useDirectorCreativeWorkspaceStore.getState().updateBoardNode(image.id, {
      mediaId: "creative-media:image:missing",
      productionJobStatus: "cached",
    });
  });
  const blob = new Blob(["replacement image"], { type: "image/png" });
  const blobs = new Map<string, Blob>();
  const dependencies = baseDependencies(blobs);
  dependencies.submit = vi.fn(async (request: ComfyGenerationSubmitRequest) => {
    const job = await generationJob(request, "succeeded", blob);
    blobs.set(job.id, blob);
    return { groupId: `group-${job.id}`, jobs: [job] };
  });

  const run = await startDirectorCanvasPipeline({ runId: "canvas-run-missing-cache", dependencies }).promise;

  expect(run.status).toBe("succeeded");
  expect(run.nodeRuns[0]).toMatchObject({ status: "succeeded", mediaId: "creative-media:image:output.png" });
  expect(dependencies.getMediaBlob).toHaveBeenCalledWith("creative-media:image:missing");
  expect(dependencies.listWorkflows).toHaveBeenCalledOnce();
  expect(dependencies.submit).toHaveBeenCalledOnce();
});

it("reuses a current durable media asset without starting a generation runtime", async () => {
  const image = addNode("image", "Current output", 20);
  act(() => {
    useDirectorCreativeWorkspaceStore.getState().updateBoardNode(image.id, {
      mediaId: "creative-media:image:current",
    });
  });
  const dependencies = baseDependencies(new Map());
  dependencies.getMediaAsset = vi.fn(() => ({ id: "creative-media:image:current" }));

  const run = await startDirectorCanvasPipeline({ runId: "canvas-run-current-cache", dependencies }).promise;

  expect(run.status).toBe("succeeded");
  expect(run.nodeRuns[0]).toMatchObject({ status: "cached", mediaId: "creative-media:image:current" });
  expect(dependencies.getMediaBlob).not.toHaveBeenCalled();
  expect(dependencies.listWorkflows).not.toHaveBeenCalled();
  expect(dependencies.submit).not.toHaveBeenCalled();
});

it("blocks only descendants of a failed node while another branch completes", async () => {
  const root = addNode("note", "Root", 20);
  const failedImage = addNode("image", "Fail image", 320);
  const blockedVideo = addNode("video", "Blocked video", 620);
  const audio = addNode("audio", "Independent music", 320);
  act(() => {
    const store = useDirectorCreativeWorkspaceStore.getState();
    store.addBoardEdge(root.id, failedImage.id);
    store.addBoardEdge(failedImage.id, blockedVideo.id);
    store.addBoardEdge(root.id, audio.id);
  });
  const audioBlob = new Blob(["audio"], { type: "audio/wav" });
  const blobs = new Map<string, Blob>();
  const dependencies = baseDependencies(blobs);
  dependencies.submit = vi.fn(async (request: ComfyGenerationSubmitRequest) => {
    const job = await generationJob(request, request.kind === "image.generate" ? "failed" : "succeeded", audioBlob);
    if (request.kind === "audio.generate") blobs.set(job.id, audioBlob);
    return { groupId: `group-${job.id}`, jobs: [job] };
  });
  dependencies.retry = vi.fn(async (jobId: string) => {
    const request = dependencies.submit.mock.calls.find(([,]) => true)?.[0] as ComfyGenerationSubmitRequest;
    const failed = await generationJob(request, "failed");
    return { ...failed, id: jobId } as ProductionJobRecord;
  });

  const run = await startDirectorCanvasPipeline({ runId: "canvas-run-partial", dependencies }).promise;

  expect(run.status).toBe("partial");
  expect(run.nodeRuns).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ nodeId: failedImage.id, status: "failed" }),
      expect.objectContaining({ nodeId: blockedVideo.id, status: "blocked" }),
      expect.objectContaining({ nodeId: audio.id, status: "succeeded" }),
    ]),
  );
  expect(dependencies.submit.mock.calls.map((call: [ComfyGenerationSubmitRequest]) => call[0].kind)).not.toContain(
    "video.generate",
  );
});

it("keeps a completed result in Gallery but does not overwrite a node edited during execution", async () => {
  const image = addNode("image", "Original", 20);
  const blob = new Blob(["stale image"], { type: "image/png" });
  const blobs = new Map<string, Blob>();
  const dependencies = baseDependencies(blobs);
  dependencies.submit = vi.fn(async (request: ComfyGenerationSubmitRequest) => {
    const job = await generationJob(request, "succeeded", blob);
    blobs.set(job.id, blob);
    return { groupId: `group-${job.id}`, jobs: [job] };
  });
  dependencies.fetchArtifact = vi.fn(async (jobId: string) => {
    act(() => useDirectorCreativeWorkspaceStore.getState().updateBoardNode(image.id, { body: "Edited while running" }));
    return blobs.get(jobId)!;
  });

  const run = await startDirectorCanvasPipeline({ runId: "canvas-run-stale", dependencies }).promise;
  const node = useDirectorCreativeWorkspaceStore.getState().boardNodes.find((candidate) => candidate.id === image.id)!;

  expect(run.status).toBe("failed");
  expect(run.nodeRuns[0]).toMatchObject({ status: "stale", mediaId: "creative-media:image:output.png" });
  expect(node.mediaId).toBeNull();
  expect(node.productionHistory).toEqual([
    expect.objectContaining({ status: "stale", mediaId: "creative-media:image:output.png" }),
  ]);
});

it("cancels active provider jobs and persists a cancelled run", async () => {
  addNode("image", "Long render", 20);
  const dependencies = baseDependencies(new Map());
  dependencies.submit = vi.fn(async (request: ComfyGenerationSubmitRequest) => ({
    groupId: "group-running",
    jobs: [await generationJob(request, "running")],
  }));
  dependencies.delay = vi.fn(
    (_milliseconds: number, signal: AbortSignal) =>
      new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
      }),
  );
  dependencies.cancel = vi.fn(async (jobId: string) => {
    const request = dependencies.submit.mock.calls[0]![0] as ComfyGenerationSubmitRequest;
    return { ...(await generationJob(request, "failed")), id: jobId, status: "cancelled" } as ProductionJobRecord;
  });
  const handle = startDirectorCanvasPipeline({ runId: "canvas-run-cancel", dependencies });
  await vi.waitFor(() => expect(dependencies.submit).toHaveBeenCalledOnce());
  handle.cancel();

  const run = await handle.promise;
  expect(run.status).toBe("cancelled");
  expect(run.nodeRuns[0]?.status).toBe("cancelled");
  expect(dependencies.cancel).toHaveBeenCalledWith(expect.stringContaining("job-image.generate"));
});

it("verifies artifacts with a pure JavaScript SHA-256 when crypto.subtle is unavailable", async () => {
  const image = addNode("image", "No subtle", 20);
  const bytes = new Uint8Array(256);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 37 + 89) % 256;
  const blob = new Blob([bytes], { type: "image/png" });
  const blobs = new Map<string, Blob>();
  const dependencies = baseDependencies(blobs);
  dependencies.submit = vi.fn(async (request: ComfyGenerationSubmitRequest) => {
    const job = await generationJob(request, "succeeded", blob);
    blobs.set(job.id, blob);
    return { groupId: `group-${job.id}`, jobs: [job] };
  });

  const originalCrypto = globalThis.crypto;
  vi.stubGlobal("crypto", { randomUUID: originalCrypto.randomUUID.bind(originalCrypto) });
  try {
    expect(globalThis.crypto.subtle).toBeUndefined();
    const run = await startDirectorCanvasPipeline({ runId: "canvas-run-no-subtle", dependencies }).promise;
    expect(run.status).toBe("succeeded");
    expect(run.nodeRuns[0]).toMatchObject({
      nodeId: image.id,
      status: "succeeded",
      mediaId: "creative-media:image:output.png",
    });
  } finally {
    vi.unstubAllGlobals();
  }
});

it("keeps a finished result current when only the title changes while the body provides the prompt", async () => {
  const image = addNode("image", "Original title", 20);
  const blob = new Blob(["retitled image"], { type: "image/png" });
  const blobs = new Map<string, Blob>();
  const dependencies = baseDependencies(blobs);
  dependencies.submit = vi.fn(async (request: ComfyGenerationSubmitRequest) => {
    const job = await generationJob(request, "succeeded", blob);
    blobs.set(job.id, blob);
    return { groupId: `group-${job.id}`, jobs: [job] };
  });
  dependencies.fetchArtifact = vi.fn(async (jobId: string) => {
    act(() =>
      useDirectorCreativeWorkspaceStore.getState().updateBoardNode(image.id, { title: "Renamed while running" }),
    );
    return blobs.get(jobId)!;
  });

  const run = await startDirectorCanvasPipeline({ runId: "canvas-run-retitled", dependencies }).promise;
  const node = useDirectorCreativeWorkspaceStore.getState().boardNodes.find((candidate) => candidate.id === image.id)!;

  expect(run.status).toBe("succeeded");
  expect(run.nodeRuns[0]).toMatchObject({ status: "succeeded", mediaId: "creative-media:image:output.png" });
  expect(node.mediaId).toBe("creative-media:image:output.png");
});

it("marks a finished result stale when the node output dimensions change while running", async () => {
  const image = addNode("image", "Resize target", 20);
  const blob = new Blob(["resized image"], { type: "image/png" });
  const blobs = new Map<string, Blob>();
  const dependencies = baseDependencies(blobs);
  dependencies.submit = vi.fn(async (request: ComfyGenerationSubmitRequest) => {
    const job = await generationJob(request, "succeeded", blob);
    blobs.set(job.id, blob);
    return { groupId: `group-${job.id}`, jobs: [job] };
  });
  dependencies.fetchArtifact = vi.fn(async (jobId: string) => {
    act(() => useDirectorCreativeWorkspaceStore.getState().updateBoardNode(image.id, { height: 640 }));
    return blobs.get(jobId)!;
  });

  const run = await startDirectorCanvasPipeline({ runId: "canvas-run-resized", dependencies }).promise;
  const node = useDirectorCreativeWorkspaceStore.getState().boardNodes.find((candidate) => candidate.id === image.id)!;

  expect(run.nodeRuns[0]).toMatchObject({ status: "stale", mediaId: "creative-media:image:output.png" });
  expect(node.mediaId).toBeNull();
  expect(node.productionHistory).toEqual([
    expect.objectContaining({ status: "stale", mediaId: "creative-media:image:output.png" }),
  ]);
});

it("keeps graph fingerprints stable across layout-only changes", () => {
  const note = addNode("note", "Stable", 20);
  const before = useDirectorCreativeWorkspaceStore.getState();
  const first = getDirectorCanvasGraphFingerprint(before.boardNodes, before.boardEdges);
  act(() => before.updateBoardNode(note.id, { x: 900, y: 700, width: 640, height: 400 }));
  const after = useDirectorCreativeWorkspaceStore.getState();
  expect(getDirectorCanvasGraphFingerprint(after.boardNodes, after.boardEdges)).toBe(first);
});
