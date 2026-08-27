import { createHash } from "node:crypto";
import {
  comfyGenerationParametersSchema,
  comfyWorkflowGraphSchema,
  comfyWorkflowInspectionSchema,
  type ComfyGenerationParameters,
  type ComfyMediaKind,
  type ComfyWorkflowGraph,
  type ComfyWorkflowParameter,
} from "../../../packages/protocol/src/comfyGenerationProtocol";
import { stableJson } from "../../../packages/protocol/src/stableJson";

// Input names whose meaning Director understands regardless of node type;
// these get an explicit semantic so submission can bind prompt/size/seed etc.
const SEMANTIC_INPUTS = new Map<string, ComfyWorkflowParameter["semantic"]>([
  ["width", "width"],
  ["height", "height"],
  ["seed", "seed"],
  ["noise_seed", "seed"],
  ["steps", "steps"],
  ["cfg", "cfg"],
  ["cfg_scale", "cfg"],
  ["sampler", "sampler"],
  ["sampler_name", "sampler"],
  ["scheduler", "scheduler"],
  ["ckpt_name", "model"],
  ["model_name", "model"],
  ["lora_name", "lora"],
  ["image", "reference_image"],
  ["duration", "duration_seconds"],
  ["duration_seconds", "duration_seconds"],
  ["seconds", "duration_seconds"],
  ["sample_rate", "sample_rate"],
  ["samplerate", "sample_rate"],
  ["voice", "voice"],
  ["speaker", "voice"],
  ["language", "language"],
  ["audio_mode", "audio_mode"],
]);

// Allowlist of node inputs surfaced as editable parameters; everything else
// in a workflow stays opaque so the form never exposes wiring internals.
const EXPOSED_INPUTS = new Set([
  ...SEMANTIC_INPUTS.keys(),
  "text",
  "text_g",
  "text_l",
  "prompt",
  "negative_prompt",
  "denoise",
  "strength",
  "batch_size",
  "frames",
  "num_frames",
  "fps",
  "duration",
  "duration_seconds",
  "seconds",
  "sample_rate",
  "samplerate",
  "voice",
  "speaker",
  "language",
  "audio_mode",
]);

function workflowHash(workflow: ComfyWorkflowGraph) {
  return createHash("sha256").update(stableJson(workflow)).digest("hex");
}

function isPrimitive(value: unknown): value is string | number | boolean | null {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function isEditableValue(value: unknown) {
  if (isPrimitive(value)) return true;
  if (!Array.isArray(value) || value.length > 256) return false;
  // A two-item [node id, output index] tuple is a ComfyUI edge, not a user parameter.
  if (
    value.length === 2 &&
    (typeof value[0] === "string" || typeof value[0] === "number") &&
    Number.isInteger(value[1])
  ) {
    return false;
  }
  return value.every(isPrimitive);
}

function titleFor(nodeTitle: string, inputName: string) {
  const input = inputName.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  return nodeTitle ? `${nodeTitle} · ${input}` : input;
}

function inferType(inputName: string, value: unknown): ComfyWorkflowParameter["type"] {
  const normalized = inputName.toLowerCase();
  if (normalized.includes("ckpt") || normalized === "model_name") return "model";
  if (normalized.includes("lora")) return "lora";
  if (normalized.includes("sampler")) return "sampler";
  if (normalized.includes("scheduler")) return "scheduler";
  if (normalized === "image" || normalized.endsWith("_image")) return "image";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return "text";
}

// Text-encode nodes rarely label their purpose; "negative" anywhere in the
// node identity wins, and otherwise the first CLIP text input is treated as
// the positive prompt with the second as the negative (ComfyUI convention).
function inferTextSemantic(
  classType: string,
  title: string,
  inputName: string,
  seenPrompt: boolean,
): ComfyWorkflowParameter["semantic"] {
  const haystack = `${classType} ${title} ${inputName}`.toLowerCase();
  if (haystack.includes("negative")) return "negative_prompt";
  if (inputName.toLowerCase() === "negative_prompt") return "negative_prompt";
  if (inputName.toLowerCase() === "prompt") return "prompt";
  if (/clip.*text|text.*encode/i.test(classType) && /^(text|text_g|text_l)$/i.test(inputName)) {
    return seenPrompt ? "negative_prompt" : "prompt";
  }
  return null;
}

/**
 * Inspects a raw ComfyUI workflow JSON and extracts editable parameters,
 * class types, and warnings. Used by the workflow registration endpoint
 * and the Director UI to present a human-readable parameter form.
 *
 * @param rawWorkflow - The raw workflow JSON (parsed API-format export).
 * @param mediaKind - The media kind this workflow produces (image, video, audio).
 * @param supportedClassTypes - Optional set of class types the target node pool supports.
 * @returns A validated workflow inspection with parameters, warnings, and a content hash.
 */
export function inspectComfyWorkflow(
  rawWorkflow: unknown,
  mediaKind: ComfyMediaKind,
  supportedClassTypes?: ReadonlySet<string>,
) {
  const workflow = comfyWorkflowGraphSchema.parse(rawWorkflow);
  const parameters: ComfyWorkflowParameter[] = [];
  let seenPrompt = false;

  for (const [nodeId, node] of Object.entries(workflow)) {
    const nodeTitle = node._meta?.title?.trim() || node.class_type;
    for (const [inputName, value] of Object.entries(node.inputs)) {
      const normalized = inputName.toLowerCase();
      if (!EXPOSED_INPUTS.has(normalized) || !isEditableValue(value)) continue;
      let semantic = SEMANTIC_INPUTS.get(normalized) ?? null;
      if (!semantic && typeof value === "string") {
        semantic = inferTextSemantic(node.class_type, nodeTitle, inputName, seenPrompt);
      }
      if (semantic === "prompt") seenPrompt = true;
      parameters.push({
        id: `${nodeId}.${inputName}`,
        label: titleFor(nodeTitle, inputName),
        nodeId,
        inputName,
        type: inferType(inputName, value),
        semantic,
        defaultValue: value as ComfyWorkflowParameter["defaultValue"],
        options: [],
        minimum: null,
        maximum: null,
        step: null,
      });
    }
  }

  const classTypes = [...new Set(Object.values(workflow).map((node) => node.class_type))].sort();
  const unsupportedClassTypes = supportedClassTypes
    ? classTypes.filter((classType) => !supportedClassTypes.has(classType))
    : [];
  const warnings = [
    ...(parameters.some((parameter) => parameter.semantic === "prompt")
      ? []
      : ["No editable positive-prompt input was detected; expose a text input in API workflow JSON."]),
    ...(unsupportedClassTypes.length
      ? [`Selected ComfyUI nodes do not advertise ${unsupportedClassTypes.length} workflow class type(s).`]
      : []),
  ];
  return comfyWorkflowInspectionSchema.parse({
    mediaKind,
    nodeCount: Object.keys(workflow).length,
    parameters,
    classTypes,
    unsupportedClassTypes,
    warnings,
    workflowSha256: workflowHash(workflow),
  });
}

// Recursively replaces {{TOKEN}} placeholders: a string that IS a token is
// replaced with the typed value (numbers stay numbers); strings merely
// containing tokens get textual substitution.
function replaceTokens(value: unknown, tokens: Readonly<Record<string, string | number>>): unknown {
  if (Array.isArray(value)) return value.map((entry) => replaceTokens(entry, tokens));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, replaceTokens(entry, tokens)]));
  }
  if (typeof value !== "string") return value;
  if (Object.prototype.hasOwnProperty.call(tokens, value)) return tokens[value]!;
  return Object.entries(tokens).reduce(
    (text, [token, replacement]) => text.replaceAll(token, String(replacement)),
    value,
  );
}

/**
 * Patches a ComfyUI workflow with generation parameters and token replacements.
 * Semantic parameters (prompt, width, seed, etc.) are applied automatically;
 * explicit overrides in `input.parameters` take precedence.
 *
 * @param rawWorkflow - The raw workflow JSON.
 * @param descriptors - The exposed parameter descriptors from inspection.
 * @param input - Generation input values.
 * @returns The patched workflow graph ready for submission.
 */
export function patchComfyWorkflow(
  rawWorkflow: unknown,
  descriptors: readonly ComfyWorkflowParameter[],
  input: {
    prompt: string;
    negativePrompt?: string;
    width: number;
    height: number;
    seed: number;
    durationSeconds?: number;
    fps?: number;
    sampleRate?: number;
    voice?: string;
    language?: string;
    audioMode?: "sound-effect" | "music" | "speech";
    parameters?: ComfyGenerationParameters;
  },
) {
  const workflow = structuredClone(comfyWorkflowGraphSchema.parse(rawWorkflow));
  const descriptorById = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
  const overrides = comfyGenerationParametersSchema.parse(input.parameters ?? {});
  for (const id of Object.keys(overrides)) {
    if (!descriptorById.has(id)) throw new Error(`Workflow parameter ${id} is not exposed by this workflow`);
  }

  const semanticValues = new Map<NonNullable<ComfyWorkflowParameter["semantic"]>, unknown>([
    ["prompt", input.prompt],
    ["negative_prompt", input.negativePrompt ?? ""],
    ["width", input.width],
    ["height", input.height],
    ["seed", input.seed],
    ["duration_seconds", input.durationSeconds ?? 0],
    ["sample_rate", input.sampleRate ?? 48_000],
    ["voice", input.voice ?? ""],
    ["language", input.language ?? ""],
    ["audio_mode", input.audioMode ?? "sound-effect"],
  ]);
  for (const descriptor of descriptors) {
    const node = workflow[descriptor.nodeId];
    if (!node || !Object.prototype.hasOwnProperty.call(node.inputs, descriptor.inputName)) continue;
    const explicit = Object.prototype.hasOwnProperty.call(overrides, descriptor.id);
    const semanticValue = descriptor.semantic ? semanticValues.get(descriptor.semantic) : undefined;
    if (explicit) node.inputs[descriptor.inputName] = overrides[descriptor.id];
    else if (semanticValue !== undefined) node.inputs[descriptor.inputName] = semanticValue;
  }

  const durationSeconds = input.durationSeconds ?? 0;
  const fps = input.fps ?? 0;
  return comfyWorkflowGraphSchema.parse(
    replaceTokens(workflow, {
      "{{PROMPT}}": input.prompt,
      "{{NEGATIVE_PROMPT}}": input.negativePrompt ?? "",
      "{{WIDTH}}": input.width,
      "{{HEIGHT}}": input.height,
      "{{SEED}}": input.seed,
      "{{FPS}}": fps,
      "{{DURATION_SECONDS}}": durationSeconds,
      "{{NUM_FRAMES}}": Math.max(1, Math.round(durationSeconds * fps)),
      "{{SAMPLE_RATE}}": input.sampleRate ?? 48_000,
      "{{VOICE}}": input.voice ?? "",
      "{{LANGUAGE}}": input.language ?? "",
      "{{AUDIO_MODE}}": input.audioMode ?? "sound-effect",
    }),
  );
}

/**
 * Computes a stable SHA-256 hash of a ComfyUI workflow graph for deduplication.
 *
 * @param workflow - The validated workflow graph.
 * @returns Hex-encoded SHA-256 digest.
 */
export function hashComfyWorkflow(workflow: ComfyWorkflowGraph) {
  return workflowHash(workflow);
}
