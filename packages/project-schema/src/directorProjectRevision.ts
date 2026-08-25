import { compareText } from "@director/protocol/primitives";
import type { DirectorProject } from "./directorProject";

/**
 * Versioned canonicalization contract for optimistic concurrency and
 * idempotency. Bump this value whenever canonicalization or hashing semantics
 * change, even if the DirectorProject document version stays the same.
 */
export const DIRECTOR_PROJECT_REVISION_CONTRACT = "director-project-revision:v1" as const;
/** Regex pattern that valid revision strings must match. */
export const DIRECTOR_PROJECT_REVISION_PATTERN = /^director-project-revision:v1:sha256:[0-9a-f]{64}$/;

/** A revision string in the format "director-project-revision:v1:sha256:<hex>". */
export type DirectorProjectRevision = `${typeof DIRECTOR_PROJECT_REVISION_CONTRACT}:sha256:${string}`;

const OMIT = Symbol("omit-from-director-project-revision");
/** Root keys that persist on disk but are not portable scene mutation truth. */
export const DIRECTOR_PROJECT_REVISION_OMITTED_ROOT_KEYS = ["productionGraphIdentities"] as const;
const MAX_DATA_URL_METADATA_LENGTH = 1_024;
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

type CanonicalValue = null | boolean | number | string | CanonicalValue[] | { [key: string]: CanonicalValue };

function normalizeDataUrl(value: string): { [key: string]: CanonicalValue } {
  const commaIndex = value.indexOf(",", "data:".length);
  const metadataEnd = commaIndex === -1 ? value.length : commaIndex;
  const metadataLength = Math.max(0, metadataEnd - "data:".length);
  const metadata = value.slice("data:".length, "data:".length + Math.min(metadataLength, MAX_DATA_URL_METADATA_LENGTH));
  const segments = metadata
    .split(";")
    .map((segment) => segment.trim().toLowerCase())
    .filter(Boolean);
  const firstSegment = segments[0];
  const hasExplicitMediaType = firstSegment?.includes("/") ?? false;
  const mediaType = hasExplicitMediaType ? firstSegment : "text/plain";
  const parameters = (hasExplicitMediaType ? segments.slice(1) : segments).sort(compareText);

  return {
    $directorOpaqueResource: {
      version: 1,
      scheme: "data",
      mediaType,
      ...(parameters.length ? { parameters } : {}),
      ...(metadataLength > MAX_DATA_URL_METADATA_LENGTH ? { metadataTruncated: true } : {}),
    },
  };
}

/**
 * Blob identifiers and data-url payloads are runtime/binary transport details,
 * not portable scene truth. Keep only bounded metadata so revisions remain
 * stable across browser sessions and never scale with embedded binary bytes.
 */
function normalizeOpaqueResource(value: string): CanonicalValue {
  if (/^blob:/i.test(value)) {
    return { $directorOpaqueResource: { version: 1, scheme: "blob" } };
  }
  if (/^data:/i.test(value)) return normalizeDataUrl(value);
  return value;
}

function canonicalizeValue(value: unknown, path: string, ancestors: Set<object>): CanonicalValue | typeof OMIT {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return OMIT;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return normalizeOpaqueResource(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Director project revision requires a finite number at ${path}; received ${String(value)}.`);
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "bigint") {
    throw new TypeError(`Director project revision does not support bigint at ${path}.`);
  }
  if (typeof value !== "object") return OMIT;

  if (ancestors.has(value)) {
    throw new TypeError(`Director project revision cannot canonicalize a circular reference at ${path}.`);
  }
  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      const result: CanonicalValue[] = [];
      value.forEach((item, index) => {
        const canonicalItem = canonicalizeValue(item, `${path}[${index}]`, ancestors);
        if (canonicalItem !== OMIT) result.push(canonicalItem);
      });
      return result;
    }

    const record = value as Record<string, unknown>;
    const result: Record<string, CanonicalValue> = {};
    Object.keys(record)
      .sort(compareText)
      .forEach((key) => {
        const canonicalItem = canonicalizeValue(record[key], `${path}.${key}`, ancestors);
        if (canonicalItem !== OMIT) result[key] = canonicalItem;
      });
    return result;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Returns the canonical DirectorProject JSON used by the revision algorithm.
 * Object keys are sorted, array order is retained, undefined values are
 * omitted, -0 is normalized to 0, and non-finite numbers are rejected.
 */
export function canonicalizeDirectorProjectForRevision(project: DirectorProject): string {
  const portable: Record<string, unknown> = { ...project };
  for (const key of DIRECTOR_PROJECT_REVISION_OMITTED_ROOT_KEYS) {
    delete portable[key];
  }
  const canonicalProject = canonicalizeValue(portable, "$", new Set());
  if (canonicalProject === OMIT) {
    throw new TypeError("Director project revision requires a project object.");
  }
  return JSON.stringify(canonicalProject);
}

function rotateRight(value: number, count: number): number {
  return (value >>> count) | (value << (32 - count));
}

/** A small synchronous SHA-256 implementation keeps this core browser-safe. */
export function sha256HexSync(value: string): string {
  const input = new TextEncoder().encode(value);
  const paddedLength = Math.ceil((input.byteLength + 9) / 64) * 64;
  const message = new Uint8Array(paddedLength);
  message.set(input);
  message[input.byteLength] = 0x80;

  const view = new DataView(message.buffer);
  const bitLength = input.byteLength * 8;
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

/**
 * Computes a deterministic, side-effect-free revision for the complete
 * portable DirectorProject truth. This function is synchronous in browsers
 * and Node so mutation guards can compare expected_revision atomically.
 */
export function getDirectorProjectRevision(project: DirectorProject): DirectorProjectRevision {
  const canonicalProject = canonicalizeDirectorProjectForRevision(project);
  return `${DIRECTOR_PROJECT_REVISION_CONTRACT}:sha256:${sha256HexSync(canonicalProject)}`;
}
