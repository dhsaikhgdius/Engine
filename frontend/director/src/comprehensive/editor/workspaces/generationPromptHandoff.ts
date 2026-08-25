import {
  comfyGenerationParametersSchema,
  type ComfyGenerationParameters,
  type ComfyMediaKind,
} from "../../../../../../packages/protocol/src/comfyGenerationProtocol";

const GENERATION_PROMPT_HANDOFF_KEY = "director.gallery-generation.prompt-handoff.v1";
const MAX_PROMPT_LENGTH = 40_000;

/** Supported generative model targets that the Gallery can route a handoff prompt to. */
export type DirectorGenerationTargetModel = "generic" | "flux" | "sdxl" | "midjourney" | "wan" | "ltx" | "runway";

/**
 * Snapshot of a generation prompt prepared by the Storyboard workspace and
 * handed off to the Gallery for execution.
 *
 * The handoff is stored in sessionStorage as a single atomic payload so the
 * Gallery can consume it in a different workspace without URL routing.
 */
export interface DirectorGenerationPromptHandoff {
  /** Schema version discriminator. */
  version: 1;
  /** Originating workspace that authored this handoff. */
  source: "storyboard";
  /** ISO-8601 timestamp of when the handoff was saved. */
  createdAt: string;
  /** Media kind the generation pipeline should produce. */
  mediaKind: ComfyMediaKind;
  /** Target model the Gallery should route the prompt to. */
  targetModel: DirectorGenerationTargetModel;
  /** Positive prompt text. */
  prompt: string;
  /** Negative prompt text. */
  negativePrompt: string;
  /** Opaque key-value metadata forwarded to the generation job. */
  metadata: Record<string, string | number | boolean>;
  /** Resolved workflow ID, or null when no workflow was selected. */
  workflowId: string | null;
  /** Workflow node IDs this handoff targets. */
  nodeIds: string[];
  /** Resolved ComfyUI generation parameters. */
  parameters: ComfyGenerationParameters;
  /** Used for the first exposed reference-image input when no exact binding is saved yet. */
  referenceMediaId: string | null;
  /** Exact workflow parameter ID to durable Gallery media ID bindings. */
  referenceImages: Record<string, string>;
}

function normalizeHandoff(candidate: unknown): DirectorGenerationPromptHandoff | null {
  if (!candidate || typeof candidate !== "object") return null;
  const value = candidate as Partial<DirectorGenerationPromptHandoff>;
  if (
    value.version !== 1 ||
    value.source !== "storyboard" ||
    (value.mediaKind !== "image" && value.mediaKind !== "video" && value.mediaKind !== "audio") ||
    typeof value.prompt !== "string" ||
    !value.prompt.trim() ||
    value.prompt.length > MAX_PROMPT_LENGTH ||
    typeof value.negativePrompt !== "string" ||
    value.negativePrompt.length > MAX_PROMPT_LENGTH ||
    typeof value.createdAt !== "string" ||
    typeof value.targetModel !== "string"
  ) {
    return null;
  }
  const allowedTargets = new Set<DirectorGenerationTargetModel>([
    "generic",
    "flux",
    "sdxl",
    "midjourney",
    "wan",
    "ltx",
    "runway",
  ]);
  if (!allowedTargets.has(value.targetModel as DirectorGenerationTargetModel)) return null;
  const metadata = Object.fromEntries(
    Object.entries(value.metadata ?? {})
      .filter(([, entry]) => ["string", "number", "boolean"].includes(typeof entry))
      .slice(0, 64),
  ) as Record<string, string | number | boolean>;
  const workflowId = typeof value.workflowId === "string" && value.workflowId.trim() ? value.workflowId.trim() : null;
  const nodeIds = Array.isArray(value.nodeIds)
    ? [...new Set(value.nodeIds.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim())))]
        .slice(0, 32)
        .map((entry) => entry.slice(0, 80))
    : [];
  const parsedParameters = comfyGenerationParametersSchema.safeParse(value.parameters ?? {});
  const referenceMediaId =
    typeof value.referenceMediaId === "string" && value.referenceMediaId.trim()
      ? value.referenceMediaId.trim().slice(0, 512)
      : null;
  const referenceImages = Object.fromEntries(
    Object.entries(value.referenceImages ?? {})
      .filter(
        ([parameterId, mediaId]) =>
          Boolean(parameterId.trim()) && typeof mediaId === "string" && Boolean(mediaId.trim()),
      )
      .slice(0, 64)
      .map(([parameterId, mediaId]) => [parameterId.slice(0, 240), mediaId.slice(0, 512)]),
  );
  return {
    version: 1,
    source: "storyboard",
    createdAt: value.createdAt,
    mediaKind: value.mediaKind,
    targetModel: value.targetModel as DirectorGenerationTargetModel,
    prompt: value.prompt,
    negativePrompt: value.negativePrompt,
    metadata,
    workflowId,
    nodeIds,
    parameters: parsedParameters.success ? parsedParameters.data : {},
    referenceMediaId,
    referenceImages,
  };
}

/**
 * Saves a generation prompt handoff to sessionStorage so the Gallery workspace
 * can pick it up on its next mount.
 *
 * @param input - The handoff payload, with version, source, and createdAt
 *  filled in automatically. Optional fields default to empty values.
 * @returns `true` when the handoff was validated and saved successfully,
 *  `false` when validation failed or sessionStorage is unavailable.
 */
export function saveDirectorGenerationPromptHandoff(
  input: Omit<
    DirectorGenerationPromptHandoff,
    | "version"
    | "source"
    | "createdAt"
    | "workflowId"
    | "nodeIds"
    | "parameters"
    | "referenceMediaId"
    | "referenceImages"
  > & {
    source?: DirectorGenerationPromptHandoff["source"];
    workflowId?: string | null;
    nodeIds?: string[];
    parameters?: ComfyGenerationParameters;
    referenceMediaId?: string | null;
    referenceImages?: Record<string, string>;
  },
) {
  if (typeof window === "undefined") return false;
  const handoff = normalizeHandoff({
    ...input,
    version: 1,
    source: input.source ?? "storyboard",
    createdAt: new Date().toISOString(),
  });
  if (!handoff) return false;
  try {
    window.sessionStorage.setItem(GENERATION_PROMPT_HANDOFF_KEY, JSON.stringify(handoff));
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads the current generation prompt handoff from sessionStorage without
 * removing it.
 *
 * @returns The validated handoff payload, or `null` when no handoff is
 *  present, the stored data is corrupt, or sessionStorage is unavailable.
 */
export function peekDirectorGenerationPromptHandoff() {
  if (typeof window === "undefined") return null;
  try {
    return normalizeHandoff(JSON.parse(window.sessionStorage.getItem(GENERATION_PROMPT_HANDOFF_KEY) ?? "null"));
  } catch {
    return null;
  }
}

/**
 * Reads and atomically clears the generation prompt handoff from sessionStorage.
 *
 * Use this when the Gallery workspace has successfully consumed the handoff
 * and no other consumer should see the same payload.
 *
 * @returns The validated handoff payload, or `null` when no handoff was
 *  present or the stored data was invalid.
 */
export function consumeDirectorGenerationPromptHandoff() {
  const handoff = peekDirectorGenerationPromptHandoff();
  if (typeof window !== "undefined") window.sessionStorage.removeItem(GENERATION_PROMPT_HANDOFF_KEY);
  return handoff;
}
