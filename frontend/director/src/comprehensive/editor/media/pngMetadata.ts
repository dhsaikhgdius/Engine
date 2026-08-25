/** Maximum number of metadata key-value pairs extracted from a single PNG. */
export const DIRECTOR_PNG_METADATA_MAX_ENTRIES = 32;
/** Maximum key length in characters for a PNG metadata entry. */
export const DIRECTOR_PNG_METADATA_MAX_KEY_LENGTH = 80;
/** Maximum value length in characters for a PNG metadata entry. */
export const DIRECTOR_PNG_METADATA_MAX_VALUE_LENGTH = 200_000;
/** Standard PNG file signature bytes. */
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;

/** A frozen record of extracted PNG text chunk key-value pairs. */
export type DirectorEmbeddedMediaMetadata = Readonly<Record<string, string>>;

function readUint32(bytes: Uint8Array, offset: number) {
  return ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;
}

function decodeLatin1(bytes: Uint8Array) {
  return new TextDecoder("latin1").decode(bytes);
}

function decodeUtf8(bytes: Uint8Array) {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function splitAtNull(bytes: Uint8Array, start = 0) {
  const index = bytes.indexOf(0, start);
  return index < 0 ? null : { before: bytes.subarray(start, index), next: index + 1 };
}

async function inflateText(bytes: Uint8Array) {
  if (typeof DecompressionStream === "undefined") return null;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
    return decodeUtf8(new Uint8Array(await new Response(stream).arrayBuffer()));
  } catch {
    return null;
  }
}

function addMetadata(target: Record<string, string>, key: string, value: string) {
  const safeKey = key.trim().slice(0, DIRECTOR_PNG_METADATA_MAX_KEY_LENGTH);
  const safeValue = value.trim().slice(0, DIRECTOR_PNG_METADATA_MAX_VALUE_LENGTH);
  if (!safeKey || !safeValue || Object.keys(target).length >= DIRECTOR_PNG_METADATA_MAX_ENTRIES) return;
  target[safeKey] = safeValue;
}

async function parseTextChunk(type: string, data: Uint8Array) {
  const keyword = splitAtNull(data);
  if (!keyword) return null;
  const key = decodeLatin1(keyword.before);
  if (type === "tEXt") return { key, value: decodeLatin1(data.subarray(keyword.next)) };
  if (type === "zTXt") {
    const compressionMethod = data[keyword.next];
    if (compressionMethod !== 0) return null;
    const value = await inflateText(data.subarray(keyword.next + 1));
    return value === null ? null : { key, value };
  }

  const compressionFlag = data[keyword.next];
  const compressionMethod = data[keyword.next + 1];
  if ((compressionFlag !== 0 && compressionFlag !== 1) || compressionMethod !== 0) return null;
  const language = splitAtNull(data, keyword.next + 2);
  if (!language) return null;
  const translatedKeyword = splitAtNull(data, language.next);
  if (!translatedKeyword) return null;
  const textBytes = data.subarray(translatedKeyword.next);
  const value = compressionFlag === 1 ? await inflateText(textBytes) : decodeUtf8(textBytes);
  return value === null ? null : { key, value };
}

/**
 * Checks whether the first bytes of a buffer match the PNG signature.
 *
 * @param bytes - The raw bytes to check.
 * @returns True if the bytes begin with the PNG signature.
 */
export function isPngBytes(bytes: Uint8Array) {
  return bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((value, index) => bytes[index] === value);
}

/**
 * Extracts text chunk metadata from a PNG blob.
 *
 * Supports tEXt, zTXt, and iTXt chunks. Compressed chunks are inflated
 * via DecompressionStream. The result is frozen and capped at the
 * configured maximum entry/key/value limits.
 *
 * @param blob - The PNG blob to extract metadata from.
 * @returns A frozen record of key-value pairs, or null if no metadata is found.
 */
export async function extractDirectorPngMetadata(blob: Blob): Promise<DirectorEmbeddedMediaMetadata | null> {
  if (blob.size < PNG_SIGNATURE.length || blob.size > 512 * 1024 * 1024) return null;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (!isPngBytes(bytes)) return null;
  const metadata: Record<string, string> = {};
  let offset: number = PNG_SIGNATURE.length;
  while (offset + 12 <= bytes.length && Object.keys(metadata).length < DIRECTOR_PNG_METADATA_MAX_ENTRIES) {
    const length = readUint32(bytes, offset);
    const typeStart = offset + 4;
    const dataStart = typeStart + 4;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (length > DIRECTOR_PNG_METADATA_MAX_VALUE_LENGTH * 2 || chunkEnd > bytes.length) break;
    const type = decodeLatin1(bytes.subarray(typeStart, typeStart + 4));
    if (type === "tEXt" || type === "zTXt" || type === "iTXt") {
      const parsed = await parseTextChunk(type, bytes.subarray(dataStart, dataEnd));
      if (parsed) addMetadata(metadata, parsed.key, parsed.value);
    }
    offset = chunkEnd;
    if (type === "IEND") break;
  }
  return Object.keys(metadata).length > 0 ? Object.freeze(metadata) : null;
}

/** Summarized ComfyUI generation metadata extracted from a PNG's embedded prompt/workflow. */
export interface DirectorComfyMetadataSummary {
  /** Positive prompt text, or null if not found. */
  prompt: string | null;
  /** Negative prompt text, or null if not found. */
  negativePrompt: string | null;
  /** Generation seed, or null if not found. */
  seed: number | null;
  /** Raw workflow JSON string, or null. */
  workflowJson: string | null;
  /** Raw prompt graph JSON (from the API), or null. */
  promptGraphJson: string | null;
  /** Concatenated searchable text from all metadata fields, capped at 500k characters. */
  searchableText: string;
}

function findPromptText(value: unknown, negative: boolean) {
  if (!value || typeof value !== "object") return null;
  const nodes = Object.values(value as Record<string, unknown>);
  for (const candidate of nodes) {
    if (!candidate || typeof candidate !== "object") continue;
    const node = candidate as Record<string, unknown>;
    const classType = String(node.class_type ?? node.type ?? "").toLocaleLowerCase();
    if (!classType.includes("text") && !classType.includes("clip")) continue;
    const inputs = node.inputs && typeof node.inputs === "object" ? (node.inputs as Record<string, unknown>) : node;
    const text = typeof inputs.text === "string" ? inputs.text.trim() : "";
    if (!text) continue;
    const title = String((node._meta as Record<string, unknown> | undefined)?.title ?? "").toLocaleLowerCase();
    const isNegative = classType.includes("negative") || title.includes("negative");
    if (isNegative === negative) return text;
  }
  return null;
}

function findSeed(value: unknown) {
  if (!value || typeof value !== "object") return null;
  for (const candidate of Object.values(value as Record<string, unknown>)) {
    if (!candidate || typeof candidate !== "object") continue;
    const node = candidate as Record<string, unknown>;
    const inputs = node.inputs && typeof node.inputs === "object" ? (node.inputs as Record<string, unknown>) : node;
    const seed = Number(inputs.seed ?? inputs.noise_seed);
    if (Number.isSafeInteger(seed) && seed >= 0) return seed;
  }
  return null;
}

function parseJson(value: string | undefined) {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

/**
 * Summarizes ComfyUI generation metadata from a PNG's embedded prompt/workflow fields.
 *
 * Parses the prompt graph and workflow JSON, finds positive/negative prompt text,
 * the seed, and builds a searchable concatenation for gallery filtering.
 *
 * @param metadata - The raw embedded metadata from a PNG, or null/undefined.
 * @returns A structured summary with prompt, seed, workflow, and searchable text.
 */
export function summarizeDirectorComfyMetadata(
  metadata: DirectorEmbeddedMediaMetadata | null | undefined,
): DirectorComfyMetadataSummary {
  const promptGraphJson = metadata?.prompt ?? metadata?.Prompt ?? null;
  const workflowJson = metadata?.workflow ?? metadata?.Workflow ?? null;
  const graph = parseJson(promptGraphJson ?? undefined) ?? parseJson(workflowJson ?? undefined);
  const prompt = findPromptText(graph, false);
  const negativePrompt = findPromptText(graph, true);
  const seed = findSeed(graph);
  return {
    prompt,
    negativePrompt,
    seed,
    workflowJson,
    promptGraphJson,
    searchableText: [prompt, negativePrompt, seed === null ? null : String(seed), ...Object.values(metadata ?? {})]
      .filter((value): value is string => Boolean(value))
      .join(" ")
      .slice(0, 500_000),
  };
}
