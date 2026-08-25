import { z } from "zod";
import canvasWorkflowPresets from "./canvasWorkflowPresets.json";

/** The available section kind identifiers for Canvas board sections. */
export const CANVAS_SECTION_KINDS = ["character", "scene", "generation", "final", "custom"] as const;

/** Union type of all valid Canvas section kind strings. */
export type CanvasSectionKind = (typeof CANVAS_SECTION_KINDS)[number];

/** Zod schema for a Canvas board section's persisted state. */
export const boardSectionSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(CANVAS_SECTION_KINDS),
  title: z.string().trim().min(1).max(120),
  collapsed: z.boolean(),
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().min(240).max(2400),
  height: z.number().finite().min(180).max(1600),
  accent: z.string().min(1).max(32),
});

/** A visual section / lane on the Canvas board that groups nodes by workflow stage. */
export type DirectorBoardSection = z.infer<typeof boardSectionSchema>;

/** Horizontal workflow lanes — created on script import, not on fresh canvas. */
export const CANVAS_WORKFLOW_PRESETS: readonly Omit<DirectorBoardSection, "id">[] = z
  .array(boardSectionSchema.omit({ id: true }))
  .parse(canvasWorkflowPresets);

/**
 * Generates a unique board section identifier.
 *
 * Uses `crypto.randomUUID` when available, falling back to a time-and-random-based
 * identifier for environments without a secure random source.
 *
 * @param prefix - A stable prefix for the generated id. Defaults to `"board-section"`.
 * @returns A unique section id string.
 */
export function createBoardSectionId(prefix = "board-section") {
  if (typeof globalThis.crypto?.randomUUID === "function") return `${prefix}-${globalThis.crypto.randomUUID()}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Creates board sections from the workflow preset definitions.
 *
 * Each preset is cloned with a freshly generated unique id, so the same preset
 * layout can be instantiated multiple times without id collisions.
 *
 * @returns An array of board sections, one per workflow preset.
 */
export function createPresetBoardSections(): DirectorBoardSection[] {
  return CANVAS_WORKFLOW_PRESETS.map((preset) => ({
    ...preset,
    id: createBoardSectionId(),
  }));
}

/** True when a node's center lies inside the section bounds. */
export function nodeCenterInsideSection(
  node: { x: number; y: number; width: number; height: number },
  section: DirectorBoardSection,
) {
  const cx = node.x + node.width / 2;
  const cy = node.y + node.height / 2;
  return cx >= section.x && cx <= section.x + section.width && cy >= section.y && cy <= section.y + section.height;
}

/**
 * Resolves which board section a node belongs to.
 *
 * If the node carries an explicit `sectionId` that still exists in the sections list,
 * that assignment is honored. Otherwise the node is tested against each section's
 * bounds using {@link nodeCenterInsideSection} and the first match wins.
 *
 * @param node - The node to resolve, with optional explicit section assignment.
 * @param sections - The current set of board sections.
 * @returns The matching section id, or `null` when no section contains the node.
 */
export function resolveSectionForNode(
  node: { x: number; y: number; width: number; height: number; sectionId?: string | null },
  sections: readonly DirectorBoardSection[],
) {
  // Honor an explicit section assignment only when the section still exists.
  if (node.sectionId && sections.some((section) => section.id === node.sectionId)) return node.sectionId;
  const match = sections.find((section) => nodeCenterInsideSection(node, section));
  return match?.id ?? null;
}