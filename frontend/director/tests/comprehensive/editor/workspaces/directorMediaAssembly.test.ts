import { expect, it } from "vitest";
import {
  describeDirectorMediaAssemblyChain,
  formatDirectorMediaAssemblyClock,
  indexDirectorMediaAssembly,
  isDirectorMediaAssembled,
  buildDirectorMediaAssemblyTree,
} from "../../../../src/comprehensive/editor/workspaces/directorMediaAssembly";
import type {
  DirectorBoardNode,
  DirectorBoardEdge,
  DirectorEditTrack,
} from "../../../../src/comprehensive/editor/workspaces/directorWorkspaceStore";

function node(
  id: string,
  title: string,
  mediaId: string | null,
  kind: DirectorBoardNode["kind"] = "image",
): Pick<DirectorBoardNode, "id" | "title" | "kind" | "mediaId"> {
  return { id, title, kind, mediaId };
}

function edge(sourceNodeId: string, targetNodeId: string): Pick<DirectorBoardEdge, "sourceNodeId" | "targetNodeId"> {
  return { sourceNodeId, targetNodeId };
}

function track(
  id: string,
  name: string,
  clips: Array<{ id: string; mediaId: string; name: string; startSec: number }>,
): Pick<DirectorEditTrack, "id" | "name" | "clips"> {
  return {
    id,
    name,
    clips: clips.map((clip) => ({
      ...clip,
      durationSec: 3,
      inSec: 0,
      sourceDurationSec: 12,
      playbackRate: 1,
      opacity: 1,
      volume: 1,
      fadeInSec: 0,
      fadeOutSec: 0,
      scale: 1,
      positionX: 0,
      positionY: 0,
      rotationDeg: 0,
      fit: "contain" as const,
    })),
  };
}

it("indexes canvas placement, nearest media neighbors through notes, and timeline clips", () => {
  const names = new Map([
    ["capture:image-1", "晨光构图"],
    ["recording:video-1", "环绕镜头"],
    ["import:audio-1", "旁白草稿"],
  ]);
  const records = indexDirectorMediaAssembly(
    [
      node("shot-a", "参考图", "capture:image-1"),
      node("note-1", "镜头说明", null, "note"),
      node("gen-video", "生成视频", "recording:video-1", "video"),
      node("voice", "旁白", "import:audio-1", "audio"),
    ],
    [edge("shot-a", "note-1"), edge("note-1", "gen-video"), edge("voice", "gen-video")],
    [track("video-1", "视频 1", [{ id: "clip-1", mediaId: "recording:video-1", name: "环绕", startSec: 4.2 }])],
    names,
  );

  const still = records.get("capture:image-1")!;
  expect(still.canvasNodes).toEqual([{ nodeId: "shot-a", title: "参考图", kind: "image" }]);
  expect(still.outputs).toEqual([
    { mediaId: "recording:video-1", name: "环绕镜头", viaNodeId: "gen-video", viaNodeTitle: "生成视频" },
  ]);
  expect(still.timelineClips).toEqual([]);
  expect(isDirectorMediaAssembled(still)).toBe(true);
  expect(describeDirectorMediaAssemblyChain(still, "晨光构图")).toBe("晨光构图 → 环绕镜头");

  const video = records.get("recording:video-1")!;
  expect(video.inputs.map((link) => link.mediaId).sort()).toEqual(["capture:image-1", "import:audio-1"]);
  expect(video.timelineClips).toEqual([
    { clipId: "clip-1", trackId: "video-1", trackName: "视频 1", name: "环绕", startSec: 4.2 },
  ]);
  expect(describeDirectorMediaAssemblyChain(video, "环绕镜头")).toBe("晨光构图 + 旁白草稿 → 环绕镜头");

  const tree = buildDirectorMediaAssemblyTree(video, "环绕镜头");
  expect(tree.map((node) => node.label)).toEqual(["输入", "环绕镜头"]);
  expect(tree[0]?.children.map((node) => node.label)).toEqual(["晨光构图", "旁白草稿"]);
  expect(tree[0]?.children[0]?.children.map((node) => node.label)).toEqual(["参考图"]);
  expect(tree[1]?.current).toBe(true);
  expect(tree[1]?.children.map((node) => node.label)).toEqual(["画布", "时间线"]);
  expect(tree[1]?.children[0]?.children.map((node) => node.label)).toEqual(["生成视频"]);
  expect(tree[1]?.children[1]?.children).toEqual([
    expect.objectContaining({ label: "视频 1 · 环绕", detail: "00:04.2", clipId: "clip-1" }),
  ]);
});

it("treats unused library items as unassembled and formats clip clocks", () => {
  const records = indexDirectorMediaAssembly(
    [node("orphan", "未连接", "capture:image-1")],
    [],
    [track("audio-1", "音频 1", [{ id: "clip-2", mediaId: "import:audio-1", name: "旁白", startSec: 72 }])],
  );
  expect(isDirectorMediaAssembled(records.get("capture:image-1"))).toBe(true);
  expect(records.get("capture:image-1")?.inputs).toEqual([]);
  expect(records.get("capture:image-1")?.outputs).toEqual([]);
  expect(isDirectorMediaAssembled(records.get("missing"))).toBe(false);
  expect(formatDirectorMediaAssemblyClock(72)).toBe("01:12.0");
  expect(formatDirectorMediaAssemblyClock(4.2)).toBe("00:04.2");
  expect(describeDirectorMediaAssemblyChain(records.get("import:audio-1")!, "旁白草稿")).toBe("旁白草稿 → 时间线");
});
