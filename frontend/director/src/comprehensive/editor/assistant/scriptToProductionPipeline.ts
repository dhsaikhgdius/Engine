import { importDirectorProjectFromFountain } from "../interchange/fountain";
import { createEmptyDirectorStoryboard } from "../storyboard/directorStoryboard";
import type { DirectorProject } from "../schema/directorProject";
import {
  CANVAS_WORKFLOW_PRESETS,
  createBoardSectionId,
  type CanvasSectionKind,
  type DirectorBoardSection,
} from "../workspaces/canvasSections";
import type { DirectorBoardNode } from "../workspaces/directorWorkspaceStore";

/** One beat from the script plan, mapped to a Canvas section and frame range. */
export interface ScriptBeatPlanItem {
  beatId: string;
  title: string;
  body: string;
  sectionKind: CanvasSectionKind;
  frameStart: number;
  frameEnd: number;
}

/** The complete plan for turning a Fountain script into a Canvas workspace. */
export interface ScriptToCanvasPlan {
  sections: DirectorBoardSection[];
  nodes: Array<Omit<DirectorBoardNode, "id"> & { beatId: string }>;
  storyboardShotCount: number;
  warnings: string[];
  /** Typed Fountain importer omissions (dialogue, notes, sections, …). */
  omitted: Array<{ code: string; subject: string; reason: string }>;
}

const SECTION_BY_BEAT_INDEX: CanvasSectionKind[] = ["character", "scene", "generation", "final"];

function sectionKindForBeatIndex(index: number): CanvasSectionKind {
  return SECTION_BY_BEAT_INDEX[index % SECTION_BY_BEAT_INDEX.length] ?? "custom";
}

/**
 * Parse a Fountain script text and build a Canvas production plan:
 * workflow sections, note nodes for each shot, and any warnings.
 * Falls back to a single placeholder node when no shots are parsed.
 *
 * @param fountainText - The Fountain-formatted script text.
 * @param baseProject - Optional existing project for context.
 * @returns A plan with sections, nodes, shot count, and warnings.
 */
export function buildScriptToCanvasPlan(fountainText: string, baseProject?: DirectorProject): ScriptToCanvasPlan {
  const imported = importDirectorProjectFromFountain(fountainText, { baseProject });
  const shots = imported.project.storyboard?.shots ?? [];
  const warnings = [...imported.warnings];
  const sections = CANVAS_WORKFLOW_PRESETS.map((preset) => ({ ...preset, id: createBoardSectionId() }));
  const sectionByKind = new Map(sections.map((section) => [section.kind, section]));
  const nodes: ScriptToCanvasPlan["nodes"] = [];

  shots.forEach((shot, index) => {
    const sectionKind = sectionKindForBeatIndex(index);
    const section = sectionByKind.get(sectionKind) ?? sections[0]!;
    const column = index % 2;
    const row = Math.floor(index / 2);
    nodes.push({
      beatId: shot.scriptBeatId ?? shot.id,
      kind: "note",
      title: shot.title,
      body: `${shot.shotSize} · ${shot.movement} · F${shot.frameStart}-F${shot.frameEnd}`,
      mediaId: null,
      sectionId: section.id,
      x: section.x + 24 + column * 320,
      y: section.y + 48 + row * 180,
      width: 280,
      height: 156,
      accent: section.accent,
      productionJobId: null,
      productionJobStatus: null,
    });
  });

  if (!nodes.length) {
    warnings.push("Fountain 未解析出分镜条目，已保留四个工作流分区。");
    nodes.push({
      beatId: "script-start",
      kind: "note",
      title: "剧本起点",
      body: "粘贴 Fountain 后重新导入以生成分镜节点。",
      mediaId: null,
      sectionId: sections[0]!.id,
      x: sections[0]!.x + 24,
      y: sections[0]!.y + 48,
      width: 280,
      height: 156,
      accent: sections[0]!.accent,
      productionJobId: null,
      productionJobStatus: null,
    });
  }

  return {
    sections,
    nodes,
    storyboardShotCount: shots.length,
    warnings,
    omitted: imported.omitted ?? [],
  };
}

/**
 * Parse a Fountain script and merge the resulting storyboard into an
 * existing project, preserving all other project state.
 *
 * @param project - The existing project to merge into.
 * @param fountainText - The Fountain-formatted script text.
 * @returns The merged project and any import warnings.
 */
export function applyScriptPlanToProject(project: DirectorProject, fountainText: string) {
  const imported = importDirectorProjectFromFountain(fountainText, { baseProject: project });
  return {
    project: {
      ...imported.project,
      storyboard: imported.project.storyboard ?? createEmptyDirectorStoryboard(),
    },
    warnings: imported.warnings,
  };
}
