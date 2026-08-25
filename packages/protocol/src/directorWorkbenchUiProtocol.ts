import { z } from "zod";

/**
 * Viewport aspect-ratio presets shared by the Stage UI contract and Agent
 * observe/author surfaces. Distinct from {@link DIRECTOR_CAMERA_ASPECT_RATIOS}:
 * this list includes `auto` plus extra framing options used only by the viewport.
 */
export const VIEWPORT_ASPECT_RATIO_OPTIONS = [
  { id: "auto", label: "自动", value: null },
  { id: "1:1", label: "1:1", value: 1 },
  { id: "2:1", label: "2:1", value: 2 },
  { id: "3:4", label: "3:4", value: 3 / 4 },
  { id: "4:3", label: "4:3", value: 4 / 3 },
  { id: "16:9", label: "16:9", value: 16 / 9 },
  { id: "1.85:1", label: "1.85:1", value: 1.85 },
  { id: "2.39:1", label: "2.39:1", value: 2.39 },
  { id: "21:9", label: "21:9", value: 21 / 9 },
  { id: "9:16", label: "9:16", value: 9 / 16 },
] as const;

/** Union of all valid viewport aspect ratio preset ids. */
export type ViewportAspectRatio = (typeof VIEWPORT_ASPECT_RATIO_OPTIONS)[number]["id"];

/** Looks up the numeric value for a viewport aspect ratio preset id. */
export function getViewportAspectRatioValue(ratio: ViewportAspectRatio) {
  return VIEWPORT_ASPECT_RATIO_OPTIONS.find((option) => option.id === ratio)?.value ?? null;
}

const viewportAspectRatios = VIEWPORT_ASPECT_RATIO_OPTIONS.map(({ id }) => id) as [
  ViewportAspectRatio,
  ...ViewportAspectRatio[],
];

/** Supported viewport layout modes. */
export const DIRECTOR_VIEWPORT_LAYOUTS = ["single", "quad"] as const;
/** Union of valid viewport layout modes. */
export type DirectorViewportLayout = (typeof DIRECTOR_VIEWPORT_LAYOUTS)[number];

/** Coerces an unknown value to a valid viewport layout, defaulting to "single". */
export function normalizeDirectorViewportLayout(value: unknown): DirectorViewportLayout {
  return value === "quad" ? "quad" : "single";
}

/** Default character movement speed in the viewport. */
export const DEFAULT_VIEWPORT_CHARACTER_MOVE_SPEED = 1;

/**
 * Runtime and compile-time contract for UI state crossing the workbench boundary.
 *
 * This schema covers every persisted UI preference that the Stage viewport and
 * inspector panels share across sessions. Values are validated on load so a
 * corrupted localStorage entry never crashes the renderer.
 */
export const directorUiStateSchema = z.strictObject({
  viewMode: z.enum(["director", "camera"]),
  selectedObjectId: z.string().nullable(),
  selectedObjectIds: z.array(z.string()),
  selectedCrowdId: z.string().nullable(),
  directorInspectorMode: z.enum(["auto", "scene"]),
  transformMode: z.enum(["translate", "rotate", "scale"]),
  viewportAspectRatio: z.enum(viewportAspectRatios),
  viewportLayout: z.enum(DIRECTOR_VIEWPORT_LAYOUTS),
  viewportRuleOfThirdsEnabled: z.boolean(),
  viewportPanelsCollapsed: z.boolean(),
  viewportRotateSensitivity: z.number().finite().positive(),
  viewportZoomSensitivity: z.number().finite().positive(),
  viewportMoveSpeed: z.number().finite().positive(),
  viewportCharacterMoveSpeed: z.number().finite().positive().default(DEFAULT_VIEWPORT_CHARACTER_MOVE_SPEED),
  viewportPilotInertia: z.number().finite().min(0).max(1),
  viewportPilotLookSmoothing: z.number().finite().min(0).max(1),
  viewportPilotBankStrength: z.number().finite().min(0).max(1),
});

/** The full UI state record persisted across Stage sessions. */
export type DirectorUiState = z.infer<typeof directorUiStateSchema>;
/** Gizmo mode for the viewport transform tool. */
export type TransformMode = DirectorUiState["transformMode"];

/** All valid shot-package render pass ids. */
export const DIRECTOR_SHOT_RENDER_PASS_IDS = [
  "clean",
  "clay",
  "albedo",
  "roughness",
  "metalness",
  "emissive",
  "ao",
  "shadow",
  "depth",
  "normal",
  "object-id",
  "mask",
  "pose",
  "lineart",
  "semantic",
  "motion",
] as const;

/** A render pass id. */
export type DirectorShotRenderPassId = (typeof DIRECTOR_SHOT_RENDER_PASS_IDS)[number];

/** Valid categories for Agent-facing asset catalog items. */
export const directorAgentAssetCategorySchema = z.enum([
  "characters",
  "basic",
  "animals",
  "furniture",
  "guns",
  "nature",
  "structure",
  "vehicles",
  "weapons",
  "other",
]);

/** Preview asset shape for the Agent catalog: status, kind, and URLs. */
export const directorAgentAssetPreviewSchema = z.strictObject({
  status: z.enum(["ready", "runtime", "fallback"]),
  kind: z.enum(["image", "model"]),
  url: z.string().min(1),
  thumbnail_url: z.string().min(1).nullable(),
  source_model_url: z.string().min(1),
});

/** A category in the Agent-facing asset catalog. */
export type DirectorAgentAssetCategory = z.infer<typeof directorAgentAssetCategorySchema>;
