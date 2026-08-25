import type {
  ComfyGenerationInputImage,
  ComfyGenerationSubmitRequest,
  ComfyMediaKind,
  ComfyNodeSnapshot,
  ComfyWorkflowRecord,
} from "../../../../../../packages/protocol/src/comfyGenerationProtocol";
import type {
  ProductionJobArtifact,
  ProductionJobRecord,
} from "../../../../../../packages/protocol/src/productionJobProtocol";
import { sha256HexSync } from "../schema/directorProjectRevision";
import { probeCreativeMediaFile } from "../media/creativeMediaProbe";
import { persistentCreativeMediaLibrary, type CreativeMediaAsset } from "../media/persistentCreativeMediaStore";
import { analyzeDirectorCanvasDag } from "./canvasDag";
import {
  cancelComfyGenerationJob,
  fetchGenerationArtifact,
  inspectComfyGenerationJob,
  listComfyGenerationNodes,
  listComfyGenerationWorkflows,
  reconcileComfyGenerationJob,
  retryComfyGenerationJob,
  submitComfyGeneration,
  uploadComfyGenerationInputImage,
} from "./galleryGenerationBridge";
import {
  createDefaultDirectorCanvasProductionConfig,
  directorCanvasProductionConfigSchema,
  type DirectorCanvasNodeOutput,
  type DirectorCanvasPipelineNodeRun,
  type DirectorCanvasPipelineNodeStatus,
  type DirectorCanvasPipelineRun,
  type DirectorCanvasProductionConfig,
} from "./canvasPipelineProtocol";
import {
  useDirectorCreativeWorkspaceStore,
  type DirectorBoardEdge,
  type DirectorBoardNode,
} from "./directorWorkspaceStore";

type GenerationJob = Extract<ProductionJobRecord, { kind: "image.generate" | "video.generate" | "audio.generate" }>;

/** External services and utilities the canvas pipeline requires to discover workflows, submit generation jobs, poll for results, fetch artifacts, and import media. */
export interface DirectorCanvasPipelineDependencies {
  /** Lists available ComfyUI workflows from the generation service. */
  listWorkflows: typeof listComfyGenerationWorkflows;
  /** Lists available ComfyUI execution nodes with their status and load. */
  listNodes: typeof listComfyGenerationNodes;
  /** Submits a generation request to the ComfyUI backend. */
  submit: typeof submitComfyGeneration;
  /** Polls the current status of a submitted generation job. */
  inspect: typeof inspectComfyGenerationJob;
  /** Retries a failed or cancelled generation job in-place. */
  retry: typeof retryComfyGenerationJob;
  /** Reconciles a generation job whose outcome is unknown (e.g. after a network interruption). */
  reconcile: typeof reconcileComfyGenerationJob;
  /** Cancels a running generation job. */
  cancel: typeof cancelComfyGenerationJob;
  /** Downloads a generation artifact blob by job and artifact id. */
  fetchArtifact: typeof fetchGenerationArtifact;
  /** Uploads an input image to a ComfyUI execution node for use as a reference. */
  uploadInputImage: typeof uploadComfyGenerationInputImage;
  /** Looks up a media asset from the persistent library by id. */
  getMediaAsset: (mediaId: string) => CreativeMediaAsset | null;
  /** Retrieves the raw blob for a media asset from the persistent library. */
  getMediaBlob: (mediaId: string) => Promise<Blob | null>;
  /** Imports a generated file into the persistent media library. */
  importMediaFile: typeof persistentCreativeMediaLibrary.importFile;
  /** Probes a media file for dimensions, duration, and other metadata. */
  probeMediaFile: typeof probeCreativeMediaFile;
  /** Returns the current wall-clock time for timestamping run events. */
  now: () => Date;
  /** Returns a promise that resolves after a delay, or rejects on abort. */
  delay: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

/** Configuration knobs that control which nodes run, how many execute in parallel, and how the pipeline reports progress. */
export interface DirectorCanvasPipelineOptions {
  /** Stable identifier for this pipeline run. Auto-generated when omitted. */
  runId?: string;
  /** Only nodes in this set (and their transitive upstream dependencies) are executed. Runs the full graph when omitted. */
  targetNodeIds?: readonly string[];
  /** Nodes that must re-execute even if they already have a usable media output. */
  forceNodeIds?: readonly string[];
  /** Maximum number of nodes that may execute concurrently. */
  maxParallel?: number;
  /** Agent attribution metadata attached to the run record. */
  agentRequest?: DirectorCanvasPipelineRun["agentRequest"];
  /** Interval in milliseconds between generation job status polls. */
  pollIntervalMs?: number;
  /** Overrides for specific pipeline dependencies, useful in tests. */
  dependencies?: Partial<DirectorCanvasPipelineDependencies>;
  /** Callback invoked after every state change, receiving a snapshot of the current run. */
  onProgress?: (run: DirectorCanvasPipelineRun) => void;
}

/** A handle that lets callers await pipeline completion or cancel the run while it is in progress. */
export interface DirectorCanvasPipelineHandle {
  /** The stable id assigned to this pipeline run. */
  runId: string;
  /** Resolves with the final run record when the pipeline finishes (success, partial, or failure). */
  promise: Promise<DirectorCanvasPipelineRun>;
  /** Cancels the pipeline and all in-flight generation jobs. */
  cancel: () => void;
}

let activeCanvasPipelineHandle: DirectorCanvasPipelineHandle | null = null;

const TERMINAL_GENERATION_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
const FAILED_DEPENDENCY_STATUSES = new Set<DirectorCanvasPipelineNodeStatus>([
  "failed",
  "blocked",
  "cancelled",
  "stale",
]);

function abortError() {
  return new DOMException("Canvas pipeline cancelled", "AbortError");
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : abortError();
}

function defaultDelay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : abortError());
      return;
    }
    const timer = globalThis.setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        globalThis.clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : abortError());
      },
      { once: true },
    );
  });
}

function pipelineDependencies(
  overrides: Partial<DirectorCanvasPipelineDependencies> = {},
): DirectorCanvasPipelineDependencies {
  return {
    listWorkflows: listComfyGenerationWorkflows,
    listNodes: listComfyGenerationNodes,
    submit: submitComfyGeneration,
    inspect: inspectComfyGenerationJob,
    retry: retryComfyGenerationJob,
    reconcile: reconcileComfyGenerationJob,
    cancel: cancelComfyGenerationJob,
    fetchArtifact: fetchGenerationArtifact,
    uploadInputImage: uploadComfyGenerationInputImage,
    getMediaAsset: (mediaId) => persistentCreativeMediaLibrary.getAsset(mediaId),
    getMediaBlob: (mediaId) => persistentCreativeMediaLibrary.getBlob(mediaId),
    importMediaFile: persistentCreativeMediaLibrary.importFile.bind(persistentCreativeMediaLibrary),
    probeMediaFile: probeCreativeMediaFile,
    now: () => new Date(),
    delay: defaultDelay,
    ...overrides,
  };
}

function createRunId() {
  const entropy =
    globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `canvas-run-${entropy}`;
}

function mediaKindForNode(node: DirectorBoardNode): ComfyMediaKind | null {
  return node.kind === "image" || node.kind === "video" || node.kind === "audio" ? node.kind : null;
}

function generationKindForMedia(mediaKind: ComfyMediaKind): GenerationJob["kind"] {
  return mediaKind === "image" ? "image.generate" : mediaKind === "video" ? "video.generate" : "audio.generate";
}

function inferAudioMode(node: DirectorBoardNode): DirectorCanvasProductionConfig["audioMode"] {
  const source = `${node.title}\n${node.body}`.toLocaleLowerCase();
  if (/(语音|旁白|对白|台词|speech|voice|narration|dialogue)/i.test(source)) return "speech";
  if (/(音乐|配乐|乐曲|music|score|soundtrack)/i.test(source)) return "music";
  return "sound-effect";
}

/**
 * Resolves the effective production configuration for a canvas node.
 *
 * Merges the node's explicit production config with system defaults, and
 * infers the audio mode from the node's title and body when not set.
 *
 * @param node - The board node whose production configuration to resolve.
 * @returns A validated production configuration ready for the generation pipeline.
 */
export function getDirectorCanvasNodeProductionConfig(node: DirectorBoardNode): DirectorCanvasProductionConfig {
  const fallback = createDefaultDirectorCanvasProductionConfig();
  return directorCanvasProductionConfigSchema.parse({
    ...fallback,
    ...(node.productionConfig ?? {}),
    audioMode: node.productionConfig?.audioMode ?? inferAudioMode(node),
  });
}

function stableGraphFingerprint(nodes: readonly DirectorBoardNode[], edges: readonly DirectorBoardEdge[]) {
  return `sha256:${sha256HexSync(
    JSON.stringify({
      nodes: [...nodes]
        .map((node) => ({
          id: node.id,
          kind: node.kind,
          title: node.title,
          body: node.body,
          mediaId: node.mediaId,
          productionConfig: getDirectorCanvasNodeProductionConfig(node),
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      edges: [...edges]
        .map((edge) => ({ sourceNodeId: edge.sourceNodeId, targetNodeId: edge.targetNodeId }))
        .sort(
          (left, right) =>
            left.sourceNodeId.localeCompare(right.sourceNodeId) || left.targetNodeId.localeCompare(right.targetNodeId),
        ),
    }),
  )}`;
}

function incomingNodeIds(edges: readonly DirectorBoardEdge[], nodeId: string) {
  return edges
    .filter((edge) => edge.targetNodeId === nodeId)
    .map((edge) => edge.sourceNodeId)
    .sort((left, right) => left.localeCompare(right));
}

function upstreamContext(nodeIds: readonly string[], nodeById: ReadonlyMap<string, DirectorBoardNode>) {
  return nodeIds
    .map((nodeId) => nodeById.get(nodeId))
    .filter((node): node is DirectorBoardNode => Boolean(node))
    .map((node) => {
      const body = node.body.trim();
      return `- ${node.title.trim() || node.kind}${body ? `: ${body}` : ""}`;
    })
    .join("\n")
    .slice(0, 4_000);
}

function buildPrompt(
  node: DirectorBoardNode,
  parentIds: readonly string[],
  nodeById: ReadonlyMap<string, DirectorBoardNode>,
) {
  const own = node.body.trim() || node.title.trim();
  const context = upstreamContext(parentIds, nodeById);
  return [own, context ? `Upstream production context:\n${context}` : ""].filter(Boolean).join("\n\n").slice(0, 12_000);
}

/**
 * Hashes only the payload that actually reaches the generation request: the
 * effective prompt, the resolved output dimensions, the workflow, upstream
 * reference media, and the config fields forwarded to the provider. Load
 * balancing choices (execution node ids) and display-only fields (title when
 * the body already provides the prompt) must not invalidate finished runs.
 */
function nodeRequestFingerprint(input: {
  node: DirectorBoardNode;
  parentIds: readonly string[];
  nodeById: ReadonlyMap<string, DirectorBoardNode>;
  workflowId: string;
}) {
  const { nodeIds: _executionNodeIds, workflowId: _configuredWorkflowId, ...requestConfig } =
    getDirectorCanvasNodeProductionConfig(input.node);
  return `sha256:${sha256HexSync(
    JSON.stringify({
      nodeId: input.node.id,
      kind: input.node.kind,
      prompt: buildPrompt(input.node, input.parentIds, input.nodeById),
      dimensions: outputDimensions(input.node),
      workflowId: input.workflowId,
      config: requestConfig,
      referenceMediaIds: input.parentIds.map((parentId) => input.nodeById.get(parentId)?.mediaId ?? null),
    }),
  )}`;
}

function sortedWorkflows(workflows: readonly ComfyWorkflowRecord[], mediaKind: ComfyMediaKind) {
  return workflows
    .filter((workflow) => workflow.mediaKind === mediaKind)
    .sort(
      (left, right) =>
        Number(right.source === "configured") - Number(left.source === "configured") ||
        left.name.localeCompare(right.name) ||
        left.id.localeCompare(right.id),
    );
}

function resolveWorkflow(
  node: DirectorBoardNode,
  mediaKind: ComfyMediaKind,
  workflows: readonly ComfyWorkflowRecord[],
) {
  const config = getDirectorCanvasNodeProductionConfig(node);
  const compatible = sortedWorkflows(workflows, mediaKind);
  if (config.workflowId) {
    const selected = compatible.find((workflow) => workflow.id === config.workflowId);
    if (!selected) throw new Error(`节点“${node.title}”指定的 ${mediaKind} 工作流不存在或类型不匹配`);
    return selected;
  }
  const configured = compatible.filter((workflow) => workflow.source === "configured");
  if (configured.length === 1) return configured[0]!;
  if (compatible.length === 1) return compatible[0]!;
  if (!compatible.length) throw new Error(`没有可用的 ${mediaKind} ComfyUI 工作流`);
  throw new Error(`节点“${node.title}”有多个 ${mediaKind} 工作流，请在生成配置中明确选择`);
}

function resolveTargetNodes(node: DirectorBoardNode, nodes: readonly ComfyNodeSnapshot[]) {
  const config = getDirectorCanvasNodeProductionConfig(node);
  const available = nodes
    .filter((candidate) => candidate.enabled && (candidate.status === "online" || candidate.status === "busy"))
    .sort(
      (left, right) =>
        Number(left.status === "busy") - Number(right.status === "busy") ||
        left.activeJobs + left.queuedJobs - (right.activeJobs + right.queuedJobs) ||
        left.id.localeCompare(right.id),
    );
  if (!config.nodeIds.length) {
    if (!available.length) throw new Error("没有在线的 ComfyUI 执行节点");
    return available.map((candidate) => candidate.id);
  }
  const availableById = new Map(available.map((candidate) => [candidate.id, candidate]));
  const selected = config.nodeIds.filter((nodeId) => availableById.has(nodeId));
  const unavailable = config.nodeIds.filter((nodeId) => !availableById.has(nodeId));
  if (unavailable.length) throw new Error(`指定的 ComfyUI 节点不可用：${unavailable.join(", ")}`);
  return selected;
}

function outputDimensions(node: DirectorBoardNode) {
  const ratio = Math.max(0.2, Math.min(5, node.width / node.height));
  const longEdge = 1_024;
  const width = ratio >= 1 ? longEdge : Math.round((longEdge * ratio) / 8) * 8;
  const height = ratio >= 1 ? Math.round(longEdge / ratio / 8) * 8 : longEdge;
  return { width: Math.max(64, width), height: Math.max(64, height) };
}

const SHA256_INITIAL_STATE = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
] as const;
const SHA256_ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
] as const;

function rotateRight(value: number, count: number) {
  return (value >>> count) | (value << (32 - count));
}

// sha256HexSync only accepts strings and re-encodes them as UTF-8, which
// corrupts binary payloads, so artifact verification keeps a byte-level
// implementation for deployments where crypto.subtle is unavailable
// (for example plain-HTTP LAN hosts).
function sha256HexFromBytes(bytes: Uint8Array): string {
  const paddedLength = Math.ceil((bytes.byteLength + 9) / 64) * 64;
  const message = new Uint8Array(paddedLength);
  message.set(bytes);
  message[bytes.byteLength] = 0x80;

  const view = new DataView(message.buffer);
  const bitLength = bytes.byteLength * 8;
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const state = Uint32Array.from(SHA256_INITIAL_STATE);
  const schedule = new Uint32Array(64);
  for (let blockOffset = 0; blockOffset < paddedLength; blockOffset += 64) {
    for (let index = 0; index < 16; index += 1) {
      schedule[index] = view.getUint32(blockOffset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const previous15 = schedule[index - 15]!;
      const previous2 = schedule[index - 2]!;
      const sigma0 = rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ (previous15 >>> 3);
      const sigma1 = rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ (previous2 >>> 10);
      schedule[index] = (schedule[index - 16]! + sigma0 + schedule[index - 7]! + sigma1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const bigSigma1 = rotateRight(e!, 6) ^ rotateRight(e!, 11) ^ rotateRight(e!, 25);
      const choose = (e! & f!) ^ (~e! & g!);
      const temporary1 = (h! + bigSigma1 + choose + SHA256_ROUND_CONSTANTS[index]! + schedule[index]!) >>> 0;
      const bigSigma0 = rotateRight(a!, 2) ^ rotateRight(a!, 13) ^ rotateRight(a!, 22);
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const temporary2 = (bigSigma0 + majority) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d! + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }

    state[0] = (state[0]! + a!) >>> 0;
    state[1] = (state[1]! + b!) >>> 0;
    state[2] = (state[2]! + c!) >>> 0;
    state[3] = (state[3]! + d!) >>> 0;
    state[4] = (state[4]! + e!) >>> 0;
    state[5] = (state[5]! + f!) >>> 0;
    state[6] = (state[6]! + g!) >>> 0;
    state[7] = (state[7]! + h!) >>> 0;
  }
  return Array.from(state, (part) => part.toString(16).padStart(8, "0")).join("");
}

async function exactSha256(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  try {
    const subtle = globalThis.crypto?.subtle;
    if (subtle) {
      const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
      return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
    }
  } catch {
    // Older webviews may expose crypto.subtle but reject digest operations.
  }
  return sha256HexFromBytes(bytes);
}

async function verifyArtifact(blob: Blob, artifact: ProductionJobArtifact) {
  if (blob.size !== artifact.bytes) {
    throw new Error(`生成产物字节数不一致：预期 ${artifact.bytes}，实际 ${blob.size}`);
  }
  const sha256 = await exactSha256(blob);
  if (sha256 !== artifact.sha256) throw new Error("生成产物 SHA-256 校验失败");
}

async function mapWithConcurrency<T>(values: readonly T[], concurrency: number, task: (value: T) => Promise<void>) {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(values.length, Math.max(1, concurrency)) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      await task(values[index]!);
    }
  });
  await Promise.all(workers);
}

function isGenerationJob(job: ProductionJobRecord): job is GenerationJob {
  return job.kind === "image.generate" || job.kind === "video.generate" || job.kind === "audio.generate";
}

async function waitForGenerationJob(
  initial: GenerationJob,
  dependencies: DirectorCanvasPipelineDependencies,
  signal: AbortSignal,
  pollIntervalMs: number,
  onStatus: (job: GenerationJob) => void,
) {
  let job = initial;
  while (!TERMINAL_GENERATION_STATUSES.has(job.status)) {
    throwIfAborted(signal);
    if (job.status === "outcome_unknown") {
      const reconciled = await dependencies.reconcile(job.id, signal);
      if (!isGenerationJob(reconciled)) throw new Error(`任务 ${job.id} 返回了错误的生成类型`);
      job = reconciled;
    } else {
      await dependencies.delay(pollIntervalMs, signal);
      const inspected = await dependencies.inspect(job.id, signal);
      if (!isGenerationJob(inspected)) throw new Error(`任务 ${job.id} 返回了错误的生成类型`);
      job = inspected;
    }
    onStatus(job);
  }
  return job;
}

function expectedArtifact(job: GenerationJob, mediaKind: ComfyMediaKind) {
  const prefix = `${mediaKind}/`;
  const artifact = job.artifacts.find((candidate) => candidate.mimeType.startsWith(prefix));
  if (!artifact) throw new Error(`任务 ${job.id} 成功，但没有 ${mediaKind} 产物`);
  return artifact;
}

async function referenceInputs(input: {
  workflow: ComfyWorkflowRecord;
  targetNodeId: string;
  parentIds: readonly string[];
  nodeById: ReadonlyMap<string, DirectorBoardNode>;
  dependencies: DirectorCanvasPipelineDependencies;
  signal: AbortSignal;
}) {
  const referenceParameters = input.workflow.parameters.filter(
    (parameter) => parameter.type === "image" || parameter.semantic === "reference_image",
  );
  if (!referenceParameters.length) return [];
  const sourceMediaIds = input.parentIds
    .map((nodeId) => input.nodeById.get(nodeId)?.mediaId ?? null)
    .filter((mediaId): mediaId is string => Boolean(mediaId))
    .filter((mediaId) => input.dependencies.getMediaAsset(mediaId)?.kind === "image");
  const pairs = sourceMediaIds.slice(0, referenceParameters.length).map((mediaId, index) => ({
    mediaId,
    parameter: referenceParameters[index]!,
  }));
  return Promise.all(
    pairs.map(async ({ mediaId, parameter }): Promise<ComfyGenerationInputImage> => {
      const asset = input.dependencies.getMediaAsset(mediaId);
      const blob = await input.dependencies.getMediaBlob(mediaId);
      if (!asset || !blob) throw new Error(`上游参考图不可用：${mediaId}`);
      const receipt = await input.dependencies.uploadInputImage({
        nodeId: input.targetNodeId,
        sourceMediaId: mediaId,
        fileName: asset.fileName,
        mimeType: asset.mimeType,
        blob,
        signal: input.signal,
      });
      return { ...receipt, parameterId: parameter.id };
    }),
  );
}

function initialNodeRun(nodeId: string): DirectorCanvasPipelineNodeRun {
  return {
    nodeId,
    status: "pending",
    requestFingerprint: null,
    jobId: null,
    artifactId: null,
    mediaId: null,
    startedAt: null,
    finishedAt: null,
    error: null,
  };
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isAbort(error: unknown, signal: AbortSignal) {
  return signal.aborted || (error instanceof DOMException && error.name === "AbortError");
}

async function reusableMediaNodeIds(
  nodes: readonly DirectorBoardNode[],
  forceNodeIds: ReadonlySet<string>,
  dependencies: DirectorCanvasPipelineDependencies,
) {
  const reusable = new Set<string>();
  await Promise.all(
    nodes.map(async (node) => {
      if (!mediaKindForNode(node) || !node.mediaId || forceNodeIds.has(node.id)) return;
      if (dependencies.getMediaAsset(node.mediaId) || (await dependencies.getMediaBlob(node.mediaId))) {
        reusable.add(node.id);
      }
    }),
  );
  return reusable;
}

async function executePipeline(input: {
  runId: string;
  controller: AbortController;
  activeJobIds: Set<string>;
  options: DirectorCanvasPipelineOptions;
}) {
  const dependencies = pipelineDependencies(input.options.dependencies);
  const store = useDirectorCreativeWorkspaceStore.getState();
  const allNodes = store.boardNodes.map((node) => structuredClone(node));
  const allEdges = store.boardEdges.map((edge) => ({ ...edge }));
  const requestedTargets = new Set((input.options.targetNodeIds ?? []).map((nodeId) => nodeId.trim()).filter(Boolean));
  const allNodeIds = new Set(allNodes.map((node) => node.id));
  const missingTargets = [...requestedTargets].filter((nodeId) => !allNodeIds.has(nodeId));
  if (missingTargets.length) throw new Error(`Canvas 目标节点不存在：${missingTargets.join(", ")}`);
  const includedNodeIds = requestedTargets.size ? new Set(requestedTargets) : new Set(allNodeIds);
  if (requestedTargets.size) {
    const incomingByTarget = new Map<string, string[]>();
    for (const edge of allEdges) {
      const sources = incomingByTarget.get(edge.targetNodeId) ?? [];
      sources.push(edge.sourceNodeId);
      incomingByTarget.set(edge.targetNodeId, sources);
    }
    const pending = [...requestedTargets];
    while (pending.length) {
      const nodeId = pending.pop()!;
      for (const sourceNodeId of incomingByTarget.get(nodeId) ?? []) {
        if (includedNodeIds.has(sourceNodeId)) continue;
        includedNodeIds.add(sourceNodeId);
        pending.push(sourceNodeId);
      }
    }
  }
  const nodes = allNodes.filter((node) => includedNodeIds.has(node.id));
  const edges = allEdges.filter(
    (edge) => includedNodeIds.has(edge.sourceNodeId) && includedNodeIds.has(edge.targetNodeId),
  );
  const forceNodeIds = new Set((input.options.forceNodeIds ?? []).map((nodeId) => nodeId.trim()).filter(Boolean));
  const invalidForcedNodeIds = [...forceNodeIds].filter((nodeId) => !includedNodeIds.has(nodeId));
  if (invalidForcedNodeIds.length) {
    throw new Error(`强制重跑节点不在当前执行子图：${invalidForcedNodeIds.join(", ")}`);
  }
  const analysis = analyzeDirectorCanvasDag(nodes, edges);
  if (!nodes.length) throw new Error("Canvas 没有可执行节点");
  if (!analysis.valid) throw new Error(`Canvas DAG 无效：${analysis.issues.map((issue) => issue.code).join(", ")}`);
  const reusableNodeIds = await reusableMediaNodeIds(nodes, forceNodeIds, dependencies);

  const startedAt = dependencies.now().toISOString();
  let run: DirectorCanvasPipelineRun = {
    version: 1,
    id: input.runId,
    graphFingerprint: stableGraphFingerprint(nodes, edges),
    status: "running",
    startedAt,
    updatedAt: startedAt,
    finishedAt: null,
    nodeRuns: analysis.topologicalOrder.map(initialNodeRun),
    error: null,
    ...(input.options.agentRequest ? { agentRequest: structuredClone(input.options.agentRequest) } : {}),
  };
  const persistRun = () => {
    useDirectorCreativeWorkspaceStore.getState().upsertBoardPipelineRun(run);
    input.options.onProgress?.(structuredClone(run));
  };
  const patchNodeRun = (nodeId: string, patch: Partial<DirectorCanvasPipelineNodeRun>) => {
    const updatedAt = dependencies.now().toISOString();
    run = {
      ...run,
      updatedAt,
      nodeRuns: run.nodeRuns.map((nodeRun) => (nodeRun.nodeId === nodeId ? { ...nodeRun, ...patch } : nodeRun)),
    };
    persistRun();
  };
  persistRun();

  let workflows: ComfyWorkflowRecord[] = [];
  let executionNodes: ComfyNodeSnapshot[] = [];
  let runtimeDiscoveryError: string | null = null;
  const hasUnresolvedGenerationNode = nodes.some((node) => mediaKindForNode(node) && !reusableNodeIds.has(node.id));
  if (hasUnresolvedGenerationNode) {
    try {
      [workflows, executionNodes] = await Promise.all([
        dependencies.listWorkflows(input.controller.signal),
        dependencies.listNodes(input.controller.signal),
      ]);
    } catch (error) {
      runtimeDiscoveryError = `生成运行时发现失败：${errorText(error)}`;
    }
  }

  const runtimeNodeById = new Map(nodes.map((node) => [node.id, node]));
  const statusByNodeId = new Map<string, DirectorCanvasPipelineNodeStatus>();
  const maxParallel = Math.max(1, Math.min(16, input.options.maxParallel ?? 4));
  const pollIntervalMs = Math.max(100, Math.min(10_000, input.options.pollIntervalMs ?? 1_000));

  const appendOutput = (nodeId: string, output: DirectorCanvasNodeOutput) => {
    useDirectorCreativeWorkspaceStore.getState().appendBoardNodeProductionOutput(nodeId, output);
  };

  const updateProduction = (nodeId: string, patch: Parameters<typeof store.updateBoardNodeProduction>[1]) =>
    useDirectorCreativeWorkspaceStore.getState().updateBoardNodeProduction(nodeId, patch);

  async function executeNode(nodeId: string) {
    throwIfAborted(input.controller.signal);
    const node = runtimeNodeById.get(nodeId)!;
    const parentIds = incomingNodeIds(edges, nodeId);
    const failedParents = parentIds.filter((parentId) => FAILED_DEPENDENCY_STATUSES.has(statusByNodeId.get(parentId)!));
    if (failedParents.length) {
      const error = `上游节点未成功：${failedParents.join(", ")}`;
      const finishedAt = dependencies.now().toISOString();
      statusByNodeId.set(nodeId, "blocked");
      updateProduction(nodeId, {
        productionRunId: input.runId,
        productionJobStatus: "blocked",
        productionError: error,
      });
      patchNodeRun(nodeId, { status: "blocked", finishedAt, error });
      return;
    }

    const mediaKind = mediaKindForNode(node);
    if (!mediaKind) {
      const finishedAt = dependencies.now().toISOString();
      statusByNodeId.set(nodeId, "passthrough");
      updateProduction(nodeId, {
        productionRunId: input.runId,
        productionJobStatus: "passthrough",
        productionError: null,
      });
      patchNodeRun(nodeId, { status: "passthrough", startedAt: finishedAt, finishedAt, error: null });
      return;
    }
    if (reusableNodeIds.has(node.id)) {
      const finishedAt = dependencies.now().toISOString();
      statusByNodeId.set(nodeId, "cached");
      updateProduction(nodeId, {
        productionRunId: input.runId,
        productionJobStatus: "cached",
        productionError: null,
      });
      patchNodeRun(nodeId, {
        status: "cached",
        mediaId: node.mediaId,
        startedAt: finishedAt,
        finishedAt,
        error: null,
      });
      return;
    }

    let requestFingerprint: string | null = null;
    let workflow: ComfyWorkflowRecord | null = null;
    let selectedNodeIds: string[] = [];
    let job: GenerationJob | null = null;
    const nodeStartedAt = dependencies.now().toISOString();
    statusByNodeId.set(nodeId, "running");
    updateProduction(nodeId, {
      productionRunId: input.runId,
      productionJobId: null,
      productionJobStatus: "running",
      productionError: null,
    });
    patchNodeRun(nodeId, { status: "running", startedAt: nodeStartedAt, error: null });

    try {
      if (runtimeDiscoveryError) throw new Error(runtimeDiscoveryError);
      workflow = resolveWorkflow(node, mediaKind, workflows);
      selectedNodeIds = resolveTargetNodes(node, executionNodes);
      requestFingerprint = nodeRequestFingerprint({
        node,
        parentIds,
        nodeById: runtimeNodeById,
        workflowId: workflow.id,
      });
      patchNodeRun(nodeId, { requestFingerprint });
      const config = getDirectorCanvasNodeProductionConfig(node);
      const references = await referenceInputs({
        workflow,
        targetNodeId: selectedNodeIds[0]!,
        parentIds,
        nodeById: runtimeNodeById,
        dependencies,
        signal: input.controller.signal,
      });
      const prompt = buildPrompt(node, parentIds, runtimeNodeById);
      if (!prompt) throw new Error(`节点“${node.title}”没有可执行提示词`);
      const dimensions = outputDimensions(node);
      const request: ComfyGenerationSubmitRequest = {
        kind: generationKindForMedia(mediaKind),
        workflowId: workflow.id,
        prompt,
        negativePrompt: config.negativePrompt || undefined,
        ...dimensions,
        seed: config.seed,
        durationSeconds: config.durationSeconds,
        fps: config.fps,
        audioMode: config.audioMode,
        sampleRate: config.sampleRate,
        voice: config.voice || undefined,
        language: config.language || undefined,
        parameters: {
          ...config.parameters,
          ...Object.fromEntries(references.map((reference) => [reference.parameterId, reference.workflowValue])),
        },
        inputImages: references,
        sourceArtifactIds: references.map((reference) => reference.sourceMediaId),
        sourceContext: {
          source: "manual",
          createdAt: nodeStartedAt,
          metadata: {
            canvasNodeId: node.id,
            canvasRunId: input.runId,
            canvasGraphFingerprint: run.graphFingerprint,
          },
        },
        nodeIds: references.length ? [selectedNodeIds[0]!] : selectedNodeIds,
        copies: 1,
        seedStrategy: "fixed",
        promptProvenance: { source: "manual", editedAfterCompile: false },
        enhancePrompt: false,
        idempotencyKey: `canvas-pipeline:${node.id.slice(0, 60)}:${requestFingerprint.slice(-48)}`,
      };
      const submitted = await dependencies.submit(request, input.controller.signal);
      const submittedJob = submitted.jobs[0];
      if (!submittedJob || !isGenerationJob(submittedJob)) throw new Error("生成服务没有返回可追踪任务");
      job = submittedJob;
      if (job.status === "failed" || job.status === "cancelled") {
        const retried = await dependencies.retry(job.id, undefined, input.controller.signal);
        if (!isGenerationJob(retried)) throw new Error(`任务 ${job.id} 重试后类型不匹配`);
        job = retried;
      }
      input.activeJobIds.add(job.id);
      updateProduction(nodeId, { productionJobId: job.id, productionJobStatus: job.status });
      patchNodeRun(nodeId, { jobId: job.id });
      job = await waitForGenerationJob(job, dependencies, input.controller.signal, pollIntervalMs, (next) =>
        updateProduction(nodeId, { productionJobId: next.id, productionJobStatus: next.status }),
      );
      input.activeJobIds.delete(job.id);
      if (job.status !== "succeeded") throw new Error(job.error ?? job.message ?? `生成任务 ${job.status}`);
      const artifact = expectedArtifact(job, mediaKind);
      const blob = await dependencies.fetchArtifact(job.id, artifact.id, input.controller.signal);
      await verifyArtifact(blob, artifact);
      throwIfAborted(input.controller.signal);
      const file = new File([blob], artifact.fileName, {
        type: artifact.mimeType,
        lastModified: dependencies.now().getTime(),
      });
      const probe = await dependencies.probeMediaFile(file);
      const generationMetadata = JSON.stringify({
        version: 1,
        source: "canvas-pipeline",
        canvasRunId: input.runId,
        canvasNodeId: node.id,
        graphFingerprint: run.graphFingerprint,
        requestFingerprint,
        jobId: job.id,
        artifactId: artifact.id,
        kind: job.kind,
        workflowId: workflow.id,
        executionNodeId: job.input.nodeId,
        prompt: job.input.prompt,
        negativePrompt: job.input.negativePrompt ?? "",
        parameters: job.input.parameters,
        inputImages: job.input.inputImages,
      }).slice(0, 200_000);
      const asset = await dependencies.importMediaFile(file, {
        ...probe,
        source: `canvas-pipeline:${input.runId}`,
        embeddedMetadata: {
          ...(probe.embeddedMetadata ?? {}),
          director_generation: generationMetadata,
          director_prompt: job.input.prompt.slice(0, 200_000),
        },
      });
      useDirectorCreativeWorkspaceStore.getState().updateGalleryMedia(asset.id, {
        addedAt: dependencies.now().toISOString(),
      });

      const live = useDirectorCreativeWorkspaceStore.getState();
      const liveNode = live.boardNodes.find((candidate) => candidate.id === nodeId);
      const liveNodeById = new Map(live.boardNodes.map((candidate) => [candidate.id, candidate]));
      const liveParentIds = incomingNodeIds(live.boardEdges, nodeId);
      const stillCurrent =
        liveNode &&
        requestFingerprint ===
          nodeRequestFingerprint({
            node: liveNode,
            parentIds: liveParentIds,
            nodeById: liveNodeById,
            workflowId: workflow.id,
          });
      const outputStatus = stillCurrent ? "succeeded" : "stale";
      const finishedAt = dependencies.now().toISOString();
      const output: DirectorCanvasNodeOutput = {
        runId: input.runId,
        requestFingerprint,
        status: outputStatus,
        jobId: job.id,
        artifactId: artifact.id,
        mediaId: asset.id,
        workflowId: workflow.id,
        nodeId: job.input.nodeId,
        createdAt: finishedAt,
        error: stillCurrent ? null : "节点输入在任务运行期间发生变化；结果已保留在 Gallery，但未覆盖当前节点",
      };
      appendOutput(nodeId, output);
      if (stillCurrent) {
        node.mediaId = asset.id;
        runtimeNodeById.set(nodeId, node);
        statusByNodeId.set(nodeId, "succeeded");
        updateProduction(nodeId, {
          mediaId: asset.id,
          productionRunId: input.runId,
          productionJobId: job.id,
          productionJobStatus: "succeeded",
          productionError: null,
        });
        patchNodeRun(nodeId, {
          status: "succeeded",
          jobId: job.id,
          artifactId: artifact.id,
          mediaId: asset.id,
          finishedAt,
          error: null,
        });
      } else {
        statusByNodeId.set(nodeId, "stale");
        updateProduction(nodeId, {
          productionRunId: input.runId,
          productionJobId: job.id,
          productionJobStatus: "stale",
          productionError: output.error,
        });
        patchNodeRun(nodeId, {
          status: "stale",
          jobId: job.id,
          artifactId: artifact.id,
          mediaId: asset.id,
          finishedAt,
          error: output.error,
        });
      }
    } catch (error) {
      const aborted = isAbort(error, input.controller.signal);
      if (job && !aborted) input.activeJobIds.delete(job.id);
      const status: DirectorCanvasPipelineNodeStatus = aborted ? "cancelled" : "failed";
      const message = aborted ? "流水线已取消" : errorText(error);
      const finishedAt = dependencies.now().toISOString();
      statusByNodeId.set(nodeId, status);
      updateProduction(nodeId, {
        productionRunId: input.runId,
        productionJobId: job?.id ?? null,
        productionJobStatus: status,
        productionError: message,
      });
      patchNodeRun(nodeId, { status, jobId: job?.id ?? null, finishedAt, error: message });
      if (requestFingerprint) {
        appendOutput(nodeId, {
          runId: input.runId,
          requestFingerprint,
          status: aborted ? "cancelled" : "failed",
          jobId: job?.id ?? null,
          artifactId: null,
          mediaId: null,
          workflowId: workflow?.id ?? null,
          nodeId: job?.input.nodeId ?? selectedNodeIds[0] ?? null,
          createdAt: finishedAt,
          error: message,
        });
      }
    }
  }

  try {
    for (const level of analysis.parallelLevels) {
      throwIfAborted(input.controller.signal);
      await mapWithConcurrency(level, maxParallel, executeNode);
    }
  } catch (error) {
    if (!isAbort(error, input.controller.signal)) throw error;
  }

  if (input.controller.signal.aborted && input.activeJobIds.size) {
    await Promise.allSettled([...input.activeJobIds].map((jobId) => dependencies.cancel(jobId)));
    input.activeJobIds.clear();
  }
  const terminalAt = dependencies.now().toISOString();
  const statuses = run.nodeRuns.map((nodeRun) => nodeRun.status);
  const failed = statuses.filter((status) => FAILED_DEPENDENCY_STATUSES.has(status)).length;
  const completed = statuses.filter((status) => ["succeeded", "cached", "passthrough"].includes(status)).length;
  const runStatus = input.controller.signal.aborted
    ? "cancelled"
    : failed === 0
      ? "succeeded"
      : completed > 0
        ? "partial"
        : "failed";
  run = {
    ...run,
    status: runStatus,
    updatedAt: terminalAt,
    finishedAt: terminalAt,
    error:
      runStatus === "failed"
        ? (run.nodeRuns.find((nodeRun) => nodeRun.error)?.error ?? "Canvas 流水线失败")
        : runStatus === "cancelled"
          ? "Canvas 流水线已取消"
          : null,
  };
  persistRun();
  return run;
}

/**
 * Starts a new canvas pipeline run that executes the board's production DAG.
 *
 * The pipeline discovers workflows and execution nodes, resolves the
 * topological order, submits generation jobs level by level with configurable
 * parallelism, polls for completion, verifies artifacts, and imports results
 * into the persistent media library. The returned handle lets callers await
 * the final run record or cancel the pipeline mid-flight.
 *
 * Only one pipeline may be active at a time; starting a new one replaces the
 * previous active handle.
 *
 * @param options - Execution controls: target nodes, force re-run, parallelism, polling interval, and progress callback.
 * @returns A handle with the run id, a promise for the final run record, and a cancel function.
 */
export function startDirectorCanvasPipeline(options: DirectorCanvasPipelineOptions = {}): DirectorCanvasPipelineHandle {
  const runId = options.runId ?? createRunId();
  const controller = new AbortController();
  const activeJobIds = new Set<string>();
  let handle!: DirectorCanvasPipelineHandle;
  const promise = executePipeline({ runId, controller, activeJobIds, options }).finally(() => {
    if (activeCanvasPipelineHandle === handle) activeCanvasPipelineHandle = null;
  });
  handle = {
    runId,
    promise,
    cancel: () => controller.abort(abortError()),
  };
  activeCanvasPipelineHandle = handle;
  return handle;
}

/**
 * Returns the currently active canvas pipeline handle, or `null` if no pipeline is running.
 *
 * @returns The active pipeline handle, or `null`.
 */
export function getActiveDirectorCanvasPipelineHandle() {
  return activeCanvasPipelineHandle;
}

/**
 * Computes a stable SHA-256 fingerprint of the canvas graph for cache invalidation and change detection.
 *
 * The fingerprint captures node identity, kind, title, body, media association,
 * resolved production config, and edge topology, sorted deterministically so
 * that reordering does not produce a different hash.
 *
 * @param nodes - The board nodes in the graph.
 * @param edges - The directed edges connecting the nodes.
 * @returns A `sha256:...` fingerprint string.
 */
export function getDirectorCanvasGraphFingerprint(
  nodes: readonly DirectorBoardNode[],
  edges: readonly DirectorBoardEdge[],
) {
  return stableGraphFingerprint(nodes, edges);
}