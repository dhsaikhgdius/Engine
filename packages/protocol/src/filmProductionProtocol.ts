import { z } from "zod";
import { FILM_ROLE_IDS, type FilmRoleId } from "./filmRoles";

export type { FilmRoleId };

const nonEmptyText = (maximum: number) => z.string().trim().min(1).max(maximum);

/** Top-level production workflows for the multi-agent film production system. */
export const filmProductionWorkflowSchema = z.enum(["idea-to-film", "script-to-film", "novel-to-film"]);
/** Supported aspect ratios for film production output. */
export const filmProductionAspectRatioSchema = z.enum(["16:9", "2.39:1", "1.85:1", "9:16"]);

/** Top-level production parameters: duration, aspect ratio, frame rate, language, and visual style. */
export const filmProductionBriefSchema = z.strictObject({
  workflow: filmProductionWorkflowSchema.default("idea-to-film"),
  targetDurationSec: z.number().int().min(15).max(7_200).default(90),
  aspectRatio: filmProductionAspectRatioSchema.default("2.39:1"),
  fps: z.union([z.literal(23.976), z.literal(24), z.literal(25), z.literal(30)]).default(24),
  language: nonEmptyText(80).default("zh-CN"),
  visualStyle: nonEmptyText(2_000).default("cinematic, coherent production design, motivated lighting"),
  audience: z.string().trim().max(500).default("general audience"),
});

/** A single film-role agent's deliverable: title, summary, and structured output. */
export const filmRoleDeliverableSchema = z.strictObject({
  title: nonEmptyText(240),
  summary: nonEmptyText(2_000),
  deliverable: z.unknown(),
});

/** Parsed production brief. */
export type FilmProductionBrief = z.infer<typeof filmProductionBriefSchema>;
/** Parsed film-role deliverable. */
export type FilmRoleDeliverable = z.infer<typeof filmRoleDeliverableSchema>;
/** The four departments in the film production pipeline. */
export type FilmProductionDepartmentId = "story" | "visual" | "render" | "post";

/** The canonical sequence of film roles in execution order. */
export const FULL_FILM_ROLE_SEQUENCE = [...FILM_ROLE_IDS] as const satisfies readonly FilmRoleId[];

/** Human-readable labels, shortcuts, and department assignments for every film role. */
export const FILM_ROLE_PRESENTATION = {
  showrunner: { label: "总导演", shortLabel: "创意统筹", department: "story" },
  screenwriter: { label: "编剧", shortLabel: "剧本", department: "story" },
  "production-designer": { label: "美术指导", shortLabel: "世界与角色", department: "visual" },
  "continuity-supervisor": { label: "场记", shortLabel: "连续性", department: "story" },
  "shot-planner": { label: "分镜导演", shortLabel: "镜头表", department: "visual" },
  "stage-director": { label: "执行导演", shortLabel: "调度", department: "visual" },
  cinematographer: { label: "摄影指导", shortLabel: "摄影与灯光", department: "visual" },
  "generation-operator": { label: "生成制片", shortLabel: "镜头生成", department: "render" },
  "visual-critic": { label: "视效监制", shortLabel: "画面审片", department: "render" },
  "repair-operator": { label: "修片师", shortLabel: "定向修复", department: "render" },
  "sound-designer": { label: "声音设计", shortLabel: "对白与声音", department: "post" },
  editor: { label: "剪辑师", shortLabel: "成片装配", department: "post" },
} as const satisfies Record<FilmRoleId, { label: string; shortLabel: string; department: FilmProductionDepartmentId }>;

/** The four departments with their roles, labels, and hints. */
export const FILM_PRODUCTION_DEPARTMENTS = [
  {
    id: "story",
    label: "创作室",
    hint: "主题、剧本与连续性",
    roles: ["showrunner", "screenwriter", "continuity-supervisor"],
  },
  {
    id: "visual",
    label: "视觉部",
    hint: "美术、分镜、调度与摄影",
    roles: ["production-designer", "shot-planner", "stage-director", "cinematographer"],
  },
  {
    id: "render",
    label: "生成与视效",
    hint: "镜头生成、审片与修复",
    roles: ["generation-operator", "visual-critic", "repair-operator"],
  },
  {
    id: "post",
    label: "后期部",
    hint: "声音、节奏与成片装配",
    roles: ["sound-designer", "editor"],
  },
] as const satisfies ReadonlyArray<{
  id: FilmProductionDepartmentId;
  label: string;
  hint: string;
  roles: readonly FilmRoleId[];
}>;

/** Upstream roles whose artifacts each role consumes as context, in dependency order. */
export const FILM_ROLE_CONTEXT: Record<FilmRoleId, readonly FilmRoleId[]> = {
  showrunner: [],
  screenwriter: ["showrunner"],
  "production-designer": ["showrunner", "screenwriter"],
  "continuity-supervisor": ["showrunner", "screenwriter", "production-designer"],
  "shot-planner": ["showrunner", "screenwriter", "production-designer", "continuity-supervisor"],
  "stage-director": ["screenwriter", "production-designer", "continuity-supervisor", "shot-planner"],
  cinematographer: ["production-designer", "continuity-supervisor", "shot-planner", "stage-director"],
  "generation-operator": [
    "screenwriter",
    "production-designer",
    "continuity-supervisor",
    "shot-planner",
    "stage-director",
    "cinematographer",
  ],
  "visual-critic": ["continuity-supervisor", "shot-planner", "generation-operator"],
  "repair-operator": ["generation-operator", "visual-critic", "stage-director", "cinematographer"],
  "sound-designer": ["screenwriter", "shot-planner", "generation-operator"],
  editor: [
    "showrunner",
    "screenwriter",
    "continuity-supervisor",
    "shot-planner",
    "generation-operator",
    "visual-critic",
    "repair-operator",
    "sound-designer",
  ],
};

/** The artifact kind each film role produces, used for storage and retrieval routing. */
export const FILM_ROLE_ARTIFACT_KIND = {
  showrunner: "creative-brief",
  screenwriter: "screenplay",
  "production-designer": "production-bible",
  "continuity-supervisor": "continuity-ledger",
  "shot-planner": "shot-plan",
  "stage-director": "staging-plan",
  cinematographer: "cinematography-plan",
  "generation-operator": "generation-plan",
  "visual-critic": "visual-review",
  "repair-operator": "repair-report",
  "sound-designer": "sound-plan",
  editor: "edit-decision-list",
} as const satisfies Record<FilmRoleId, string>;

/**
 * Parses a raw agent text response into a structured film-role deliverable.
 *
 * Handles both bare JSON and fenced code blocks so that agents are not forced
 * into a single output format.
 *
 * @param text - Raw agent output, possibly wrapped in a markdown code fence.
 * @returns The parsed deliverable, or null if the text is not valid JSON or does not conform to the schema.
 */
export function parseFilmRoleDeliverable(text: string): FilmRoleDeliverable | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1];
  const candidate = fenced ?? trimmed;
  try {
    const parsed: unknown = JSON.parse(candidate);
    const result = filmRoleDeliverableSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
