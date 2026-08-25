import { CSKEL27_JOINT_COUNT } from "./cskel27";

/**
 * Bounded browser decoder for ARDY motion npz archives.
 *
 * A numpy `savez()` archive is a zip of `.npy` members. ARDY's
 * `scripts/generate.py` writes `local_rot_mats` (F, 27, 3, 3),
 * `root_positions` (F, 3), `posed_joints` (F, 27, 3), a scalar `fps`, and a
 * `text` prompt. Members may be STORED or DEFLATE-compressed; deflate is
 * decoded with the platform's `DecompressionStream("deflate-raw")` so no
 * dependency is added.
 *
 * Every bound is explicit (archive size, member size, header length, frame
 * count, fps range) and every member is validated — magic, dtype, C order,
 * exact byte length, CRC-32, finite values, and proper rotation matrices —
 * before anything is accepted. Malformed input throws ArdyNpzError with a
 * specific message rather than degrading silently.
 */

/** Error thrown when an ARDY motion npz archive is malformed or unsupported. */
export class ArdyNpzError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArdyNpzError";
  }
}

export interface ArdyMotionClip {
  frames: number;
  fps: number;
  /** frames * 27 * 9 row-major local 3x3 rotations in cskel27 joint order. */
  rotMats: Float32Array;
  /** frames * 3 ARDY-world root positions. */
  rootPositions: Float32Array;
  /** frames * 27 * 3 ARDY-world joint positions (positional-skinning reference). */
  posedJoints: Float32Array;
  durationS: number;
}

const MAX_ARCHIVE_BYTES = 192 * 1024 * 1024;
const MAX_MEMBER_BYTES = 192 * 1024 * 1024;
const MAX_NPY_HEADER_BYTES = 16 * 1024;
const MAX_FRAMES = 24_000;
const FPS_MIN = 1;
const FPS_MAX = 240;
/** float32 serialization noise on squared norms/dots/determinants sits far below this. */
const ROTATION_MATRIX_TOLERANCE = 1e-3;

const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const FLAG_ENCRYPTED_OR_PATCHED = 0x0001 | 0x0020 | 0x0040;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * Compute the CRC-32 checksum of a byte buffer.
 *
 * Used to verify zip member integrity against the central directory's stored CRC.
 *
 * @param bytes - The uncompressed member payload.
 * @returns Unsigned 32-bit CRC-32 value.
 */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

/** Locate the End of Central Directory record, scanning back from EOF. */
function findEndOfCentralDirectory(view: DataView) {
  const windowSize = Math.min(view.byteLength, 22 + 65_535);
  const start = view.byteLength - windowSize;
  for (let i = view.byteLength - 22; i >= start; i -= 1) {
    if (view.getUint32(i, true) !== ZIP_EOCD_SIGNATURE) continue;
    const totalEntries = view.getUint16(i + 10, true);
    const directorySize = view.getUint32(i + 12, true);
    const directoryOffset = view.getUint32(i + 16, true);
    if (directoryOffset === 0xffffffff || directorySize === 0xffffffff || totalEntries === 0xffff) {
      throw new ArdyNpzError("motion npz uses zip64 records, which are out of scope");
    }
    return { directorySize, directoryOffset };
  }
  throw new ArdyNpzError("motion npz has no End of Central Directory record");
}

/** Central directory carries the authoritative sizes regardless of data-descriptor flags. */
function parseCentralDirectory(view: DataView, directoryOffset: number, directorySize: number) {
  const end = directoryOffset + directorySize;
  if (end > view.byteLength) throw new ArdyNpzError("motion npz central directory is truncated");
  const entries = new Map<string, ZipEntry>();
  let offset = directoryOffset;
  while (offset < end) {
    if (offset + 46 > end || view.getUint32(offset, true) !== ZIP_CENTRAL_SIGNATURE) {
      throw new ArdyNpzError("motion npz central directory is corrupt");
    }
    const method = view.getUint16(offset + 10, true);
    const crc = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decodeLatin1(new Uint8Array(view.buffer, view.byteOffset + offset + 46, nameLength));
    if (localOffset === 0xffffffff || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new ArdyNpzError(`motion npz member ${name} uses zip64 sizes, which are out of scope`);
    }
    entries.set(name, { name, method, crc, compressedSize, uncompressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function decodeLatin1(bytes: Uint8Array) {
  let text = "";
  for (let i = 0; i < bytes.length; i += 1) text += String.fromCharCode(bytes[i]!);
  return text;
}

/** Resolve a member's compressed payload through its local file header. */
function locateMemberPayload(view: DataView, entry: ZipEntry): Uint8Array {
  const offset = entry.localOffset;
  if (offset + 30 > view.byteLength || view.getUint32(offset, true) !== ZIP_LOCAL_SIGNATURE) {
    throw new ArdyNpzError(`motion npz member ${entry.name} local header is corrupt`);
  }
  const flags = view.getUint16(offset + 6, true);
  if (flags & FLAG_ENCRYPTED_OR_PATCHED) {
    throw new ArdyNpzError(`motion npz member ${entry.name} uses unsupported encryption/patching flags`);
  }
  const nameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const dataStart = offset + 30 + nameLength + extraLength;
  if (dataStart + entry.compressedSize > view.byteLength) {
    throw new ArdyNpzError(`motion npz member ${entry.name} payload is truncated`);
  }
  return new Uint8Array(view.buffer, view.byteOffset + dataStart, entry.compressedSize);
}

async function inflateRaw(bytes: Uint8Array, cap: number): Promise<Uint8Array> {
  if (typeof DecompressionStream !== "function") {
    throw new ArdyNpzError("this environment cannot decode deflate npz members (DecompressionStream unsupported)");
  }
  const reader = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"))
    .getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      throw new ArdyNpzError(`deflate member exceeds the ${cap} byte cap`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let position = 0;
  for (const chunk of chunks) {
    out.set(chunk, position);
    position += chunk.byteLength;
  }
  return out;
}

interface ParsedNpy {
  shape: number[];
  kind: string;
  itemsize: number;
  littleEndian: boolean;
  data: Uint8Array;
}

const DTYPE_PATTERN = /^([<>=|])([A-Za-z?])([0-9]{1,4})$/;

function parseNpyMember(bytes: Uint8Array, memberName: string): ParsedNpy {
  if (bytes.length < 10) throw new ArdyNpzError(`npy member ${memberName} is too short`);
  const magicOk =
    bytes[0] === 0x93 &&
    bytes[1] === 0x4e &&
    bytes[2] === 0x55 &&
    bytes[3] === 0x4d &&
    bytes[4] === 0x50 &&
    bytes[5] === 0x59;
  if (!magicOk) throw new ArdyNpzError(`npy member ${memberName} has an invalid magic`);
  let prefixLength: number;
  let headerLength: number;
  if (bytes[6] === 1 && bytes[7] === 0) {
    prefixLength = 10;
    headerLength = bytes[8]! | (bytes[9]! << 8);
  } else if ((bytes[6] === 2 || bytes[6] === 3) && bytes[7] === 0) {
    prefixLength = 12;
    headerLength = bytes[8]! | (bytes[9]! << 8) | (bytes[10]! << 16) | (bytes[11]! << 24);
  } else {
    throw new ArdyNpzError(`npy member ${memberName} uses an unsupported version (${bytes[6]}.${bytes[7]})`);
  }
  if (headerLength <= 0 || headerLength > MAX_NPY_HEADER_BYTES || prefixLength + headerLength > bytes.length) {
    throw new ArdyNpzError(`npy member ${memberName} header length ${headerLength} is out of range`);
  }

  const headerText = decodeLatin1(bytes.subarray(prefixLength, prefixLength + headerLength));
  const descrMatch = /['"]descr['"]\s*:\s*['"]([^'"]+)['"]/.exec(headerText);
  const orderMatch = /['"]fortran_order['"]\s*:\s*(True|False)/.exec(headerText);
  const shapeMatch = /['"]shape['"]\s*:\s*\(([^()]*)\)/.exec(headerText);
  if (!descrMatch || !orderMatch || !shapeMatch) {
    throw new ArdyNpzError(`npy member ${memberName} header is missing descr/fortran_order/shape`);
  }
  if (orderMatch[1] !== "False") {
    throw new ArdyNpzError(`npy member ${memberName} must be C order (fortran_order False)`);
  }
  const shape = shapeMatch[1]!
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token !== "")
    .map((token) => {
      const dimension = Number(token);
      if (!Number.isInteger(dimension) || dimension < 0) {
        throw new ArdyNpzError(`npy member ${memberName} has an invalid shape dimension '${token}'`);
      }
      return dimension;
    });
  const dtypeMatch = DTYPE_PATTERN.exec(descrMatch[1]!);
  if (!dtypeMatch) throw new ArdyNpzError(`npy member ${memberName} has an invalid dtype '${descrMatch[1]}'`);
  const itemsize = Number(dtypeMatch[3]);
  const itemCount = shape.reduce((total, dimension) => total * dimension, 1);
  const payloadBytes = itemCount * itemsize;
  if (prefixLength + headerLength + payloadBytes > bytes.length) {
    throw new ArdyNpzError(`npy member ${memberName} payload is truncated (expected ${payloadBytes} bytes)`);
  }
  return {
    shape,
    kind: dtypeMatch[2]!,
    itemsize,
    littleEndian: dtypeMatch[1] !== ">",
    data: bytes.subarray(prefixLength + headerLength, prefixLength + headerLength + payloadBytes),
  };
}

/** float32 view; big-endian archives are byte-swapped and unaligned payloads copied. */
function float32Of(parsed: ParsedNpy, label: string): Float32Array {
  if (parsed.kind !== "f" || parsed.itemsize !== 4) {
    throw new ArdyNpzError(`${label} must be float32, got dtype kind '${parsed.kind}'/${parsed.itemsize}`);
  }
  const bytes = parsed.data;
  if (!parsed.littleEndian) {
    const swapped = new Uint8Array(bytes.byteLength);
    const source = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const target = new DataView(swapped.buffer);
    for (let i = 0; i < bytes.byteLength; i += 4) target.setUint32(i, source.getUint32(i, false), true);
    return new Float32Array(swapped.buffer);
  }
  // Float32Array requires 4-byte alignment; zip and npy headers make the
  // payload offset arbitrary, so copy when misaligned.
  if (bytes.byteOffset % 4 === 0) {
    return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  }
  const aligned = new Uint8Array(bytes.byteLength);
  aligned.set(bytes);
  return new Float32Array(aligned.buffer);
}

/** Scalar fps: integer dtypes, or float dtypes carrying an integral value. */
function scalarFpsOf(parsed: ParsedNpy, label: string): number {
  if (parsed.shape.length > 1 || (parsed.shape.length === 1 && parsed.shape[0] !== 1)) {
    throw new ArdyNpzError(`${label} must be a scalar, got shape (${parsed.shape.join(", ")})`);
  }
  const view = new DataView(parsed.data.buffer, parsed.data.byteOffset, parsed.data.byteLength);
  const little = parsed.littleEndian;
  let value: number;
  if (parsed.kind === "i" || parsed.kind === "u") {
    switch (parsed.itemsize) {
      case 1:
        value = parsed.kind === "u" ? view.getUint8(0) : view.getInt8(0);
        break;
      case 2:
        value = parsed.kind === "u" ? view.getUint16(0, little) : view.getInt16(0, little);
        break;
      case 4:
        value = parsed.kind === "u" ? view.getUint32(0, little) : view.getInt32(0, little);
        break;
      case 8: {
        const big = view.getBigInt64(0, little);
        if (big > 4_294_967_295n || big < 0n) throw new ArdyNpzError(`${label} value ${big} is out of range`);
        value = Number(big);
        break;
      }
      default:
        throw new ArdyNpzError(`${label} has unsupported integer itemsize ${parsed.itemsize}`);
    }
  } else if (parsed.kind === "f" && (parsed.itemsize === 4 || parsed.itemsize === 8)) {
    value = parsed.itemsize === 4 ? view.getFloat32(0, little) : view.getFloat64(0, little);
    if (!Number.isInteger(value)) throw new ArdyNpzError(`${label} must be an integral frame rate, got ${value}`);
  } else {
    throw new ArdyNpzError(`${label} must be an integer or float scalar, got dtype kind '${parsed.kind}'`);
  }
  if (!Number.isFinite(value)) throw new ArdyNpzError(`${label} is not a finite number`);
  return value;
}

/** Validate one row-major 3x3: finite, orthonormal rows/columns, det +1. */
function checkRotationMatrix(m: Float32Array, offset: number, frame: number, joint: number) {
  for (let axis = 0; axis < 3; axis += 1) {
    const rowNorm =
      m[offset + axis * 3]! ** 2 + m[offset + axis * 3 + 1]! ** 2 + m[offset + axis * 3 + 2]! ** 2;
    const columnNorm = m[offset + axis]! ** 2 + m[offset + 3 + axis]! ** 2 + m[offset + 6 + axis]! ** 2;
    if (
      !Number.isFinite(rowNorm) ||
      Math.abs(rowNorm - 1) > ROTATION_MATRIX_TOLERANCE ||
      !Number.isFinite(columnNorm) ||
      Math.abs(columnNorm - 1) > ROTATION_MATRIX_TOLERANCE
    ) {
      throw new ArdyNpzError(`motion npz frame ${frame} joint ${joint}: rotation row/column is not unit length`);
    }
  }
  const determinant =
    m[offset]! * (m[offset + 4]! * m[offset + 8]! - m[offset + 5]! * m[offset + 7]!) -
    m[offset + 1]! * (m[offset + 3]! * m[offset + 8]! - m[offset + 5]! * m[offset + 6]!) +
    m[offset + 2]! * (m[offset + 3]! * m[offset + 7]! - m[offset + 4]! * m[offset + 6]!);
  if (!Number.isFinite(determinant) || Math.abs(determinant - 1) > ROTATION_MATRIX_TOLERANCE) {
    throw new ArdyNpzError(`motion npz frame ${frame} joint ${joint}: rotation determinant is not +1`);
  }
}

/** Decode an ARDY motion npz. Extra members (text, foot_contacts, …) are ignored. */
export async function decodeArdyMotionNpz(bytes: Uint8Array): Promise<ArdyMotionClip> {
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) {
    throw new ArdyNpzError(`motion npz is ${bytes.byteLength} bytes, over the ${MAX_ARCHIVE_BYTES} byte cap`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const { directoryOffset, directorySize } = findEndOfCentralDirectory(view);
  const entries = parseCentralDirectory(view, directoryOffset, directorySize);

  const requiredMembers = ["local_rot_mats.npy", "root_positions.npy", "posed_joints.npy", "fps.npy"];
  const missing = requiredMembers.filter((name) => !entries.has(name));
  if (missing.length) {
    throw new ArdyNpzError(
      `motion npz is missing members ${missing.join(", ")} — Director only supports ARDY core (cskel27) outputs`,
    );
  }

  const members = new Map<string, Uint8Array>();
  for (const name of requiredMembers) {
    const entry = entries.get(name)!;
    if (entry.uncompressedSize > MAX_MEMBER_BYTES) {
      throw new ArdyNpzError(`motion npz member ${name} decompresses over the ${MAX_MEMBER_BYTES} byte cap`);
    }
    let payload = locateMemberPayload(view, entry);
    if (entry.method === 8) payload = await inflateRaw(payload, MAX_MEMBER_BYTES);
    else if (entry.method !== 0) {
      throw new ArdyNpzError(`motion npz member ${name} uses unsupported zip method ${entry.method}`);
    }
    if (payload.byteLength !== entry.uncompressedSize) {
      throw new ArdyNpzError(`motion npz member ${name} decompressed to an unexpected size`);
    }
    if (crc32(payload) !== entry.crc) {
      throw new ArdyNpzError(`motion npz member ${name} failed its CRC-32 check (corrupt data)`);
    }
    members.set(name, payload);
  }

  const rotParsed = parseNpyMember(members.get("local_rot_mats.npy")!, "local_rot_mats");
  const rootParsed = parseNpyMember(members.get("root_positions.npy")!, "root_positions");
  const jointsParsed = parseNpyMember(members.get("posed_joints.npy")!, "posed_joints");
  const fpsParsed = parseNpyMember(members.get("fps.npy")!, "fps");

  const joints = CSKEL27_JOINT_COUNT;
  if (
    rotParsed.shape.length !== 4 ||
    rotParsed.shape[1] !== joints ||
    rotParsed.shape[2] !== 3 ||
    rotParsed.shape[3] !== 3
  ) {
    throw new ArdyNpzError(
      `local_rot_mats must have shape (F, ${joints}, 3, 3), got (${rotParsed.shape.join(", ")}) — ` +
        "only ARDY core (cskel27) models are supported",
    );
  }
  const frames = rotParsed.shape[0]!;
  if (frames < 1 || frames > MAX_FRAMES) {
    throw new ArdyNpzError(`motion npz has ${frames} frames, outside 1..${MAX_FRAMES}`);
  }
  if (rootParsed.shape.length !== 2 || rootParsed.shape[0] !== frames || rootParsed.shape[1] !== 3) {
    throw new ArdyNpzError(`root_positions must have shape (${frames}, 3), got (${rootParsed.shape.join(", ")})`);
  }
  if (
    jointsParsed.shape.length !== 3 ||
    jointsParsed.shape[0] !== frames ||
    jointsParsed.shape[1] !== joints ||
    jointsParsed.shape[2] !== 3
  ) {
    throw new ArdyNpzError(
      `posed_joints must have shape (${frames}, ${joints}, 3), got (${jointsParsed.shape.join(", ")})`,
    );
  }
  const fps = scalarFpsOf(fpsParsed, "fps");
  if (fps < FPS_MIN || fps > FPS_MAX) {
    throw new ArdyNpzError(`motion fps ${fps} is outside ${FPS_MIN}..${FPS_MAX}`);
  }

  const rotMats = float32Of(rotParsed, "local_rot_mats");
  const rootPositions = float32Of(rootParsed, "root_positions");
  const posedJoints = float32Of(jointsParsed, "posed_joints");
  if (
    rotMats.length !== frames * joints * 9 ||
    rootPositions.length !== frames * 3 ||
    posedJoints.length !== frames * joints * 3
  ) {
    throw new ArdyNpzError("motion npz member byte lengths do not match their shapes");
  }

  for (let frame = 0; frame < frames; frame += 1) {
    const base = frame * joints * 9;
    for (let joint = 0; joint < joints; joint += 1) {
      checkRotationMatrix(rotMats, base + joint * 9, frame, joint);
    }
  }
  for (let i = 0; i < rootPositions.length; i += 1) {
    if (!Number.isFinite(rootPositions[i])) {
      throw new ArdyNpzError(`motion npz root_positions contains a non-finite value at index ${i}`);
    }
  }
  for (let i = 0; i < posedJoints.length; i += 1) {
    if (!Number.isFinite(posedJoints[i])) {
      throw new ArdyNpzError(`motion npz posed_joints contains a non-finite value at index ${i}`);
    }
  }

  return { frames, fps, rotMats, rootPositions, posedJoints, durationS: frames / fps };
}
