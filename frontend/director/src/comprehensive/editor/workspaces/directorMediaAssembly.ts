import type {
  DirectorBoardEdge,
  DirectorBoardNode,
  DirectorBoardNodeKind,
  DirectorEditTrack,
} from "./directorWorkspaceStore";

/** Records a canvas node that references a particular media item. */
export interface DirectorMediaAssemblyNodeUse {
  /** The canvas node id. */
  nodeId: string;
  /** The node's display title. */
  title: string;
  /** The node kind (image, video, audio, etc.). */
  kind: DirectorBoardNodeKind;
}

/** Records a timeline clip that references a particular media item. */
export interface DirectorMediaAssemblyClipUse {
  /** The clip id. */
  clipId: string;
  /** The track id this clip belongs to. */
  trackId: string;
  /** The track's display name. */
  trackName: string;
  /** The clip's display name. */
  name: string;
  /** The clip's start time on the timeline, in seconds. */
  startSec: number;
}

/** A directed assembly link from one media item to another through a canvas node. */
export interface DirectorMediaAssemblyLink {
  /** The linked media item id. */
  mediaId: string;
  /** The linked media item's display name. */
  name: string;
  /** The id of the canvas node that bridges the two media items. */
  viaNodeId: string;
  /** The title of the bridging canvas node. */
  viaNodeTitle: string;
}

/** The complete assembly picture for one media item in the canvas and timeline. */
export interface DirectorMediaAssemblyRecord {
  /** The media item id this record describes. */
  mediaId: string;
  /** Every canvas node that references this media. */
  canvasNodes: DirectorMediaAssemblyNodeUse[];
  /** Every timeline clip that references this media. */
  timelineClips: DirectorMediaAssemblyClipUse[];
  /** Upstream media that feed into this media through canvas edges. */
  inputs: DirectorMediaAssemblyLink[];
  /** Downstream media that this media feeds into through canvas edges. */
  outputs: DirectorMediaAssemblyLink[];
}

type AssemblyBoardNode = Pick<DirectorBoardNode, "id" | "title" | "kind" | "mediaId">;
type AssemblyBoardEdge = Pick<DirectorBoardEdge, "sourceNodeId" | "targetNodeId">;
type AssemblyEditTrack = Pick<DirectorEditTrack, "id" | "name" | "clips">;

function isPlacedMediaId(mediaId: string | null | undefined): mediaId is string {
  return typeof mediaId === "string" && mediaId.length > 0 && !mediaId.startsWith("text:");
}

function compareText(left: string, right: string) {
  return left.localeCompare(right, "zh-CN", { numeric: true, sensitivity: "base" });
}

function mediaName(mediaId: string, names: ReadonlyMap<string, string>, fallback: string) {
  return names.get(mediaId) || fallback;
}

function neighborsOf(
  edges: readonly AssemblyBoardEdge[],
  nodeId: string,
  direction: "incoming" | "outgoing",
) {
  return edges.flatMap((edge) => {
    if (direction === "outgoing" && edge.sourceNodeId === nodeId) return [edge.targetNodeId];
    if (direction === "incoming" && edge.targetNodeId === nodeId) return [edge.sourceNodeId];
    return [];
  });
}

/** Walk past note/frame nodes so the library shows media-to-media assembly, not just one hop. */
function collectNearestMediaLinks(
  startNodeId: string,
  direction: "incoming" | "outgoing",
  nodesById: ReadonlyMap<string, AssemblyBoardNode>,
  edges: readonly AssemblyBoardEdge[],
  names: ReadonlyMap<string, string>,
): DirectorMediaAssemblyLink[] {
  const links: DirectorMediaAssemblyLink[] = [];
  const seenNodes = new Set<string>([startNodeId]);
  const seenKeys = new Set<string>();
  const queue = [...neighborsOf(edges, startNodeId, direction)];

  while (queue.length) {
    const nodeId = queue.shift()!;
    if (seenNodes.has(nodeId)) continue;
    seenNodes.add(nodeId);
    const node = nodesById.get(nodeId);
    if (!node) continue;
    if (isPlacedMediaId(node.mediaId)) {
      const key = `${node.mediaId}:${node.id}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      links.push({
        mediaId: node.mediaId,
        name: mediaName(node.mediaId, names, node.title),
        viaNodeId: node.id,
        viaNodeTitle: node.title,
      });
      continue;
    }
    queue.push(...neighborsOf(edges, nodeId, direction));
  }

  return links.sort(
    (left, right) => compareText(left.name, right.name) || compareText(left.viaNodeTitle, right.viaNodeTitle),
  );
}

/**
 * Returns true when a media item is referenced by at least one canvas node or
 * timeline clip.
 *
 * @param record - The assembly record to check, or undefined.
 * @returns Whether the media is assembled into the canvas or timeline.
 */
export function isDirectorMediaAssembled(record: DirectorMediaAssemblyRecord | undefined) {
  if (!record) return false;
  return record.canvasNodes.length > 0 || record.timelineClips.length > 0;
}

/**
 * Format a duration in seconds as a padded MM:SS.s clock string.
 *
 * Negative and non-finite inputs are clamped to zero.
 *
 * @param seconds - The duration in seconds.
 * @returns A clock string like "01:05.3".
 */
export function formatDirectorMediaAssemblyClock(seconds: number) {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const minutes = Math.floor(safe / 60);
  const remainder = safe - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${remainder.toFixed(1).padStart(4, "0")}`;
}

/** Compact “A → this → B” line for the card, using unique neighboring media names. */
export function describeDirectorMediaAssemblyChain(
  record: DirectorMediaAssemblyRecord,
  selfName: string,
): string | null {
  if (!isDirectorMediaAssembled(record) && record.inputs.length === 0 && record.outputs.length === 0) return null;
  const unique = (links: readonly DirectorMediaAssemblyLink[]) =>
    [...new Set(links.map((link) => link.name).filter((name) => name && name !== selfName))];
  const inputs = unique(record.inputs);
  const outputs = unique(record.outputs);
  const parts: string[] = [];
  if (inputs.length) parts.push(inputs.join(" + "));
  parts.push(selfName);
  if (outputs.length) parts.push(outputs.join(" + "));
  if (parts.length === 1 && record.timelineClips.length > 0) return `${selfName} → 时间线`;
  if (parts.length === 1) return selfName;
  return parts.join(" → ");
}

/** The kind of node in the assembly tree outliner. */
export type DirectorMediaAssemblyTreeKind = "branch" | "media" | "canvas" | "timeline";

/** A node in the assembly tree shown in the side-panel outliner. */
export interface DirectorMediaAssemblyTreeNode {
  /** Unique tree node id used for React keys and expansion state. */
  id: string;
  /** The kind of tree node. */
  kind: DirectorMediaAssemblyTreeKind;
  /** Display label for this node. */
  label: string;
  /** Optional secondary detail text (e.g., child count or clock time). */
  detail?: string;
  /** Whether this node represents the currently selected media item. */
  current?: boolean;
  /** The associated canvas node id, when kind is "canvas" or "media". */
  canvasNodeId?: string;
  /** The associated timeline clip id, when kind is "timeline". */
  clipId?: string;
  /** The clip start time, when kind is "timeline". */
  startSec?: number;
  /** Child tree nodes. */
  children: DirectorMediaAssemblyTreeNode[];
}

function groupAssemblyLinks(links: readonly DirectorMediaAssemblyLink[], keyPrefix: string) {
  const groups = new Map<string, DirectorMediaAssemblyTreeNode>();
  links.forEach((link) => {
    const existing = groups.get(link.mediaId);
    const via: DirectorMediaAssemblyTreeNode = {
      id: `${keyPrefix}:canvas:${link.viaNodeId}`,
      kind: "canvas",
      label: link.viaNodeTitle,
      canvasNodeId: link.viaNodeId,
      children: [],
    };
    if (existing) {
      if (!existing.children.some((child) => child.canvasNodeId === link.viaNodeId)) existing.children.push(via);
      return;
    }
    groups.set(link.mediaId, {
      id: `${keyPrefix}:media:${link.mediaId}`,
      kind: "media",
      label: link.name,
      canvasNodeId: link.viaNodeId,
      children: [via],
    });
  });
  return [...groups.values()]
    .map((group) => ({
      ...group,
      children: [...group.children].sort((left, right) => compareText(left.label, right.label)),
    }))
    .sort((left, right) => compareText(left.label, right.label));
}

function assemblyBranch(
  id: string,
  label: string,
  children: DirectorMediaAssemblyTreeNode[],
): DirectorMediaAssemblyTreeNode | null {
  if (!children.length) return null;
  return { id, kind: "branch", label, detail: String(children.length), children };
}

/** Nested input → current → canvas/timeline/output tree for the side-panel outliner. */
export function buildDirectorMediaAssemblyTree(
  record: DirectorMediaAssemblyRecord,
  selfName: string,
): DirectorMediaAssemblyTreeNode[] {
  if (!isDirectorMediaAssembled(record) && record.inputs.length === 0 && record.outputs.length === 0) return [];

  const currentChildren = [
    assemblyBranch(
      "branch:canvas",
      "画布",
      record.canvasNodes.map((node) => ({
        id: `canvas:${node.nodeId}`,
        kind: "canvas" as const,
        label: node.title,
        canvasNodeId: node.nodeId,
        children: [],
      })),
    ),
    assemblyBranch(
      "branch:timeline",
      "时间线",
      record.timelineClips.map((clip) => ({
        id: `clip:${clip.clipId}`,
        kind: "timeline" as const,
        label: `${clip.trackName} · ${clip.name}`,
        detail: formatDirectorMediaAssemblyClock(clip.startSec),
        clipId: clip.clipId,
        startSec: clip.startSec,
        children: [],
      })),
    ),
    assemblyBranch("branch:outputs", "输出", groupAssemblyLinks(record.outputs, "out")),
  ].filter((node): node is DirectorMediaAssemblyTreeNode => Boolean(node));

  const roots: DirectorMediaAssemblyTreeNode[] = [];
  const inputs = assemblyBranch("branch:inputs", "输入", groupAssemblyLinks(record.inputs, "in"));
  if (inputs) roots.push(inputs);
  roots.push({
    id: "branch:current",
    kind: "media",
    label: selfName,
    current: true,
    canvasNodeId: record.canvasNodes[0]?.nodeId,
    clipId: record.timelineClips[0]?.clipId,
    startSec: record.timelineClips[0]?.startSec,
    children: currentChildren,
  });
  return roots;
}

/**
 * Build an index of every media item referenced by canvas nodes and timeline
 * clips, collecting its upstream inputs, downstream outputs, and placement
 * details.
 *
 * @param nodes - All board nodes in the current workspace.
 * @param edges - All board edges in the current workspace.
 * @param tracks - All edit tracks with their clips.
 * @param names - Optional map of media id to display name for display override.
 * @returns A map from media id to its assembly record.
 */
export function indexDirectorMediaAssembly(
  nodes: readonly AssemblyBoardNode[],
  edges: readonly AssemblyBoardEdge[],
  tracks: readonly AssemblyEditTrack[],
  names: ReadonlyMap<string, string> = new Map(),
) {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const records = new Map<string, DirectorMediaAssemblyRecord>();

  const ensure = (mediaId: string): DirectorMediaAssemblyRecord => {
    const existing = records.get(mediaId);
    if (existing) return existing;
    const created: DirectorMediaAssemblyRecord = {
      mediaId,
      canvasNodes: [],
      timelineClips: [],
      inputs: [],
      outputs: [],
    };
    records.set(mediaId, created);
    return created;
  };

  nodes.forEach((node) => {
    if (!isPlacedMediaId(node.mediaId)) return;
    const record = ensure(node.mediaId);
    record.canvasNodes.push({ nodeId: node.id, title: node.title, kind: node.kind });
    record.inputs.push(...collectNearestMediaLinks(node.id, "incoming", nodesById, edges, names));
    record.outputs.push(...collectNearestMediaLinks(node.id, "outgoing", nodesById, edges, names));
  });

  tracks.forEach((track) => {
    track.clips.forEach((clip) => {
      if (!isPlacedMediaId(clip.mediaId)) return;
      ensure(clip.mediaId).timelineClips.push({
        clipId: clip.id,
        trackId: track.id,
        trackName: track.name,
        name: clip.name,
        startSec: clip.startSec,
      });
    });
  });

  records.forEach((record) => {
    record.canvasNodes.sort((left, right) => compareText(left.title, right.title) || compareText(left.nodeId, right.nodeId));
    record.timelineClips.sort(
      (left, right) => left.startSec - right.startSec || compareText(left.name, right.name),
    );
    const inputKeys = new Set<string>();
    record.inputs = record.inputs.filter((link) => {
      const key = `${link.mediaId}:${link.viaNodeId}`;
      if (link.mediaId === record.mediaId || inputKeys.has(key)) return false;
      inputKeys.add(key);
      return true;
    });
    const outputKeys = new Set<string>();
    record.outputs = record.outputs.filter((link) => {
      const key = `${link.mediaId}:${link.viaNodeId}`;
      if (link.mediaId === record.mediaId || outputKeys.has(key)) return false;
      outputKeys.add(key);
      return true;
    });
  });

  return records;
}
