const ZIP_LOCAL_FILE_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_VERSION = 20;
const ZIP_STORE_METHOD = 0;
// ZIP cannot represent dates before 1980. Keeping every entry at this fixed
// value makes two archives from identical inputs byte-for-byte identical.
const ZIP_FIXED_DOS_TIME = 0;
const ZIP_FIXED_DOS_DATE = 0x0021;
const MAX_ZIP32_BYTES = 0xffffffff;
const MAX_ZIP32_ENTRIES = 0xffff;

/** A single entry in a deterministic ZIP archive — a relative path and its uncompressed bytes. */
export interface DeterministicZipEntry {
  path: string;
  bytes: Uint8Array;
}

/** The result of building a deterministic ZIP archive. */
export interface DeterministicZipArchive {
  blob: Blob;
  byteLength: number;
  entryCount: number;
}

interface PreparedZipEntry extends DeterministicZipEntry {
  nameBytes: Uint8Array;
  crc32: number;
  localOffset: number;
}

function writeUint16(target: Uint8Array, offset: number, value: number): void {
  new DataView(target.buffer, target.byteOffset, target.byteLength).setUint16(offset, value, true);
}

function writeUint32(target: Uint8Array, offset: number, value: number): void {
  new DataView(target.buffer, target.byteOffset, target.byteLength).setUint32(offset, value, true);
}

function assertPortableZipPath(path: string): void {
  if (!path || path.startsWith("/") || path.startsWith("\\") || path.includes("\\") || path.includes("\0")) {
    throw new Error(`ZIP entry path must be a portable relative path; received "${path}".`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`ZIP entry path must not contain empty, dot, or parent segments; received "${path}".`);
  }
}

function createCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

const CRC32_TABLE = createCrc32Table();

/**
 * Compute the CRC-32 checksum of a byte array for use in ZIP local
 * file headers and central directory entries.
 *
 * @param bytes - The uncompressed entry bytes.
 * @returns The CRC-32 checksum as an unsigned 32-bit integer.
 */
export function directorZipCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function createLocalHeader(entry: PreparedZipEntry): Uint8Array {
  const header = new Uint8Array(30 + entry.nameBytes.byteLength);
  writeUint32(header, 0, ZIP_LOCAL_FILE_SIGNATURE);
  writeUint16(header, 4, ZIP_VERSION);
  writeUint16(header, 6, ZIP_UTF8_FLAG);
  writeUint16(header, 8, ZIP_STORE_METHOD);
  writeUint16(header, 10, ZIP_FIXED_DOS_TIME);
  writeUint16(header, 12, ZIP_FIXED_DOS_DATE);
  writeUint32(header, 14, entry.crc32);
  writeUint32(header, 18, entry.bytes.byteLength);
  writeUint32(header, 22, entry.bytes.byteLength);
  writeUint16(header, 26, entry.nameBytes.byteLength);
  writeUint16(header, 28, 0);
  header.set(entry.nameBytes, 30);
  return header;
}

function createCentralDirectoryHeader(entry: PreparedZipEntry): Uint8Array {
  const header = new Uint8Array(46 + entry.nameBytes.byteLength);
  writeUint32(header, 0, ZIP_CENTRAL_DIRECTORY_SIGNATURE);
  writeUint16(header, 4, ZIP_VERSION);
  writeUint16(header, 6, ZIP_VERSION);
  writeUint16(header, 8, ZIP_UTF8_FLAG);
  writeUint16(header, 10, ZIP_STORE_METHOD);
  writeUint16(header, 12, ZIP_FIXED_DOS_TIME);
  writeUint16(header, 14, ZIP_FIXED_DOS_DATE);
  writeUint32(header, 16, entry.crc32);
  writeUint32(header, 20, entry.bytes.byteLength);
  writeUint32(header, 24, entry.bytes.byteLength);
  writeUint16(header, 28, entry.nameBytes.byteLength);
  writeUint16(header, 30, 0);
  writeUint16(header, 32, 0);
  writeUint16(header, 34, 0);
  writeUint16(header, 36, 0);
  writeUint32(header, 38, 0);
  writeUint32(header, 42, entry.localOffset);
  header.set(entry.nameBytes, 46);
  return header;
}

function createEndOfCentralDirectory(entryCount: number, centralSize: number, centralOffset: number): Uint8Array {
  const record = new Uint8Array(22);
  writeUint32(record, 0, ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE);
  writeUint16(record, 4, 0);
  writeUint16(record, 6, 0);
  writeUint16(record, 8, entryCount);
  writeUint16(record, 10, entryCount);
  writeUint32(record, 12, centralSize);
  writeUint32(record, 16, centralOffset);
  writeUint16(record, 20, 0);
  return record;
}

/**
 * Builds a deterministic, uncompressed ZIP32 archive. PNG files are already
 * compressed, so STORE avoids expensive recompression and keeps memory use
 * predictable. The returned Blob reuses the supplied byte arrays as parts.
 */
export function createDeterministicZipArchive(entries: DeterministicZipEntry[]): DeterministicZipArchive {
  if (!entries.length) throw new Error("Deterministic ZIP requires at least one entry.");
  if (entries.length > MAX_ZIP32_ENTRIES) throw new Error("Deterministic ZIP exceeds the ZIP32 entry limit.");

  const seenPaths = new Set<string>();
  let localOffset = 0;
  const prepared = entries.map((entry) => {
    assertPortableZipPath(entry.path);
    if (seenPaths.has(entry.path)) throw new Error(`Duplicate ZIP entry path "${entry.path}".`);
    seenPaths.add(entry.path);
    const nameBytes = new TextEncoder().encode(entry.path);
    if (nameBytes.byteLength > 0xffff) throw new Error(`ZIP entry path is too long: "${entry.path}".`);
    if (entry.bytes.byteLength > MAX_ZIP32_BYTES) throw new Error(`ZIP entry "${entry.path}" exceeds ZIP32.`);
    const result: PreparedZipEntry = {
      path: entry.path,
      bytes: entry.bytes,
      nameBytes,
      crc32: directorZipCrc32(entry.bytes),
      localOffset,
    };
    localOffset += 30 + nameBytes.byteLength + entry.bytes.byteLength;
    if (localOffset > MAX_ZIP32_BYTES) throw new Error("Deterministic ZIP exceeds the ZIP32 size limit.");
    return result;
  });

  const localParts: BlobPart[] = [];
  for (const entry of prepared) localParts.push(createLocalHeader(entry), entry.bytes as BlobPart);
  const centralParts = prepared.map(createCentralDirectoryHeader);
  const centralSize = centralParts.reduce((total, part) => total + part.byteLength, 0);
  const totalSize = localOffset + centralSize + 22;
  if (totalSize > MAX_ZIP32_BYTES) throw new Error("Deterministic ZIP exceeds the ZIP32 size limit.");
  const end = createEndOfCentralDirectory(prepared.length, centralSize, localOffset);

  return {
    blob: new Blob([...localParts, ...centralParts, end], { type: "application/zip" }),
    byteLength: totalSize,
    entryCount: prepared.length,
  };
}
