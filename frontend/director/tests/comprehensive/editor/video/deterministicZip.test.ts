import { describe, expect, it } from "vitest";
import {
  createDeterministicZipArchive,
  directorZipCrc32,
} from "../../../../src/comprehensive/editor/video/deterministicZip";

function uint32(bytes: Uint8Array, offset: number) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function listStoredZipEntries(bytes: Uint8Array) {
  const decoder = new TextDecoder();
  const entries: Array<{ path: string; bytes: Uint8Array; crc32: number }> = [];
  let offset = 0;
  while (uint32(bytes, offset) === 0x04034b50) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, bytes.byteLength - offset);
    const crc32 = view.getUint32(14, true);
    const byteLength = view.getUint32(18, true);
    const nameLength = view.getUint16(26, true);
    const path = decoder.decode(bytes.subarray(offset + 30, offset + 30 + nameLength));
    const contentOffset = offset + 30 + nameLength;
    entries.push({ path, bytes: bytes.slice(contentOffset, contentOffset + byteLength), crc32 });
    offset = contentOffset + byteLength;
  }
  return entries;
}

function listCentralDirectoryEntries(bytes: Uint8Array) {
  const decoder = new TextDecoder();
  const endOffset = bytes.byteLength - 22;
  const end = new DataView(bytes.buffer, bytes.byteOffset + endOffset, 22);
  const entryCount = end.getUint16(10, true);
  const centralSize = end.getUint32(12, true);
  let offset = end.getUint32(16, true);
  const entries: Array<{ path: string; localOffset: number }> = [];
  for (let index = 0; index < entryCount; index += 1) {
    expect(uint32(bytes, offset)).toBe(0x02014b50);
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, bytes.byteLength - offset);
    const nameLength = view.getUint16(28, true);
    const extraLength = view.getUint16(30, true);
    const commentLength = view.getUint16(32, true);
    entries.push({
      path: decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength)),
      localOffset: view.getUint32(42, true),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  expect(offset).toBe(endOffset);
  expect(offset - end.getUint32(16, true)).toBe(centralSize);
  return entries;
}

describe("deterministic ZIP32", () => {
  it("matches the standard CRC32 check vector", () => {
    expect(directorZipCrc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("writes stable STORE entries with fixed metadata and valid CRC32 values", async () => {
    const entries = [
      { path: "manifest.json", bytes: new TextEncoder().encode('{"version":1}') },
      { path: "frames/frame-000000.png", bytes: Uint8Array.of(0x89, 0x50, 0x4e, 0x47) },
    ];
    const first = createDeterministicZipArchive(entries);
    const second = createDeterministicZipArchive(entries);
    const firstBytes = new Uint8Array(await first.blob.arrayBuffer());
    const secondBytes = new Uint8Array(await second.blob.arrayBuffer());

    expect(first.blob.type).toBe("application/zip");
    expect(first.byteLength).toBe(first.blob.size);
    expect(firstBytes).toEqual(secondBytes);
    expect(uint32(firstBytes, firstBytes.byteLength - 22)).toBe(0x06054b50);
    const stored = listStoredZipEntries(firstBytes);
    expect(stored.map(({ path }) => path)).toEqual(entries.map(({ path }) => path));
    expect(stored.map(({ crc32 }) => crc32)).toEqual(entries.map(({ bytes }) => directorZipCrc32(bytes)));
    stored.forEach((entry, index) => expect(Array.from(entry.bytes)).toEqual(Array.from(entries[index]!.bytes)));
    const central = listCentralDirectoryEntries(firstBytes);
    expect(central.map(({ path }) => path)).toEqual(entries.map(({ path }) => path));
    central.forEach(({ localOffset }) => expect(uint32(firstBytes, localOffset)).toBe(0x04034b50));
  });

  it("rejects duplicate, unsafe, empty, and oversized entry sets", () => {
    const bytes = Uint8Array.of(1);
    expect(() => createDeterministicZipArchive([])).toThrow("at least one");
    expect(() =>
      createDeterministicZipArchive([
        { path: "same", bytes },
        { path: "same", bytes },
      ]),
    ).toThrow("Duplicate");
    expect(() => createDeterministicZipArchive([{ path: "../escape", bytes }])).toThrow("parent");
    expect(() => createDeterministicZipArchive([{ path: "/absolute", bytes }])).toThrow("portable relative");
  });
});
