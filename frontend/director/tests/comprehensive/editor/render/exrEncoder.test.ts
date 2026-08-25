import { describe, expect, it } from "vitest";
import { encodeExrDepth, encodeExrMotionFlow, encodeExrRgbaHalf, floatToHalfBits } from "../../../../src/comprehensive/editor/render/exrEncoder";

/**
 * Minimal hand-rolled OpenEXR reader covering exactly the writer's scope:
 * single-part scanline files, NO_COMPRESSION, little-endian, one block per
 * scanline. It parses the real byte layout so every structural claim of the
 * encoder is verified against the spec rather than against the writer itself.
 */

interface ParsedAttribute {
  type: string;
  bytes: Uint8Array;
}

interface ParsedChannel {
  name: string;
  pixelType: number;
  pLinear: number;
  xSampling: number;
  ySampling: number;
}

interface ParsedBlock {
  y: number;
  byteCount: number;
  dataOffset: number;
}

interface ParsedExr {
  magic: number;
  magicBytes: number[];
  version: number;
  versionFlags: number;
  attributeOrder: string[];
  attributes: Map<string, ParsedAttribute>;
  headerEnd: number;
  width: number;
  height: number;
  offsetTable: number[];
  blocks: ParsedBlock[];
}

function readAsciiZ(bytes: Uint8Array, start: number): { text: string; end: number } {
  let end = start;
  while (bytes[end] !== 0) end += 1;
  let text = "";
  for (let index = start; index < end; index += 1) text += String.fromCharCode(bytes[index]!);
  return { text, end: end + 1 };
}

function attributeView(attribute: ParsedAttribute): DataView {
  return new DataView(attribute.bytes.buffer, attribute.bytes.byteOffset, attribute.bytes.byteLength);
}

function readBox2i(attribute: ParsedAttribute): [number, number, number, number] {
  const view = attributeView(attribute);
  return [view.getInt32(0, true), view.getInt32(4, true), view.getInt32(8, true), view.getInt32(12, true)];
}

function readChannelList(attribute: ParsedAttribute): ParsedChannel[] {
  const view = attributeView(attribute);
  const channels: ParsedChannel[] = [];
  let cursor = 0;
  while (attribute.bytes[cursor] !== 0) {
    const name = readAsciiZ(attribute.bytes, cursor);
    cursor = name.end;
    channels.push({
      name: name.text,
      pixelType: view.getInt32(cursor, true),
      pLinear: view.getUint8(cursor + 4),
      xSampling: view.getInt32(cursor + 8, true),
      ySampling: view.getInt32(cursor + 12, true),
    });
    cursor += 16;
  }
  expect(cursor).toBe(attribute.bytes.byteLength - 1);
  return channels;
}

function parseExr(bytes: Uint8Array): ParsedExr {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const versionField = view.getInt32(4, true);
  let cursor = 8;
  const attributeOrder: string[] = [];
  const attributes = new Map<string, ParsedAttribute>();
  while (bytes[cursor] !== 0) {
    const name = readAsciiZ(bytes, cursor);
    cursor = name.end;
    const type = readAsciiZ(bytes, cursor);
    cursor = type.end;
    const size = view.getInt32(cursor, true);
    cursor += 4;
    attributeOrder.push(name.text);
    attributes.set(name.text, { type: type.text, bytes: bytes.slice(cursor, cursor + size) });
    cursor += size;
  }
  const headerEnd = cursor + 1;

  const dataWindow = readBox2i(attributes.get("dataWindow")!);
  const width = dataWindow[2] - dataWindow[0] + 1;
  const height = dataWindow[3] - dataWindow[1] + 1;

  cursor = headerEnd;
  const offsetTable: number[] = [];
  for (let line = 0; line < height; line += 1) {
    const low = view.getUint32(cursor, true);
    const high = view.getUint32(cursor + 4, true);
    offsetTable.push(high * 0x1_0000_0000 + low);
    cursor += 8;
  }

  const blocks: ParsedBlock[] = [];
  while (cursor < bytes.byteLength) {
    const y = view.getInt32(cursor, true);
    const byteCount = view.getInt32(cursor + 4, true);
    blocks.push({ y, byteCount, dataOffset: cursor + 8 });
    cursor += 8 + byteCount;
  }

  return {
    magic: view.getInt32(0, true),
    magicBytes: [...bytes.subarray(0, 4)],
    version: versionField & 0xff,
    versionFlags: versionField >>> 8,
    attributeOrder,
    attributes,
    headerEnd,
    width,
    height,
    offsetTable,
    blocks,
  };
}

function readFloatPixels(bytes: Uint8Array, parsed: ParsedExr): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pixels = new Float32Array(parsed.width * parsed.height);
  parsed.blocks.forEach((block) => {
    for (let x = 0; x < parsed.width; x += 1) {
      pixels[block.y * parsed.width + x] = view.getFloat32(block.dataOffset + x * 4, true);
    }
  });
  return pixels;
}

function halfBitsToFloat(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >>> 10) & 0x1f;
  const mantissa = bits & 0x3ff;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 31) return mantissa === 0 ? sign * Number.POSITIVE_INFINITY : Number.NaN;
  return sign * (1024 + mantissa) * 2 ** (exponent - 25);
}

/** Reads one HALF channel row (channels are stored alphabetically inside each block). */
function readHalfChannelRow(bytes: Uint8Array, parsed: ParsedExr, block: ParsedBlock, channelIndex: number): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rowStart = block.dataOffset + channelIndex * parsed.width * 2;
  const row: number[] = [];
  for (let x = 0; x < parsed.width; x += 1) row.push(view.getUint16(rowStart + x * 2, true));
  return row;
}

/** Reads one FLOAT channel row (channels are stored alphabetically inside each block). */
function readFloatChannelRow(bytes: Uint8Array, parsed: ParsedExr, block: ParsedBlock, channelIndex: number): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rowStart = block.dataOffset + channelIndex * parsed.width * 4;
  const row: number[] = [];
  for (let x = 0; x < parsed.width; x += 1) row.push(view.getFloat32(rowStart + x * 4, true));
  return row;
}

describe("encodeExrDepth", () => {
  const depthFixture = () => {
    const data = new Float32Array([0.5, 1.5, 100, 0.25, 2.75, 3.125]);
    return { width: 3, height: 2, data };
  };

  it("starts with the EXR magic bytes and a flagless version-2 single-part scanline layout", () => {
    const bytes = encodeExrDepth(depthFixture());
    const parsed = parseExr(bytes);
    expect(parsed.magicBytes).toEqual([0x76, 0x2f, 0x31, 0x01]);
    expect(parsed.magic).toBe(20000630);
    expect(parsed.version).toBe(2);
    expect(parsed.versionFlags).toBe(0);
  });

  it("writes every required header attribute, typed and in alphabetical order", () => {
    const bytes = encodeExrDepth(depthFixture());
    const parsed = parseExr(bytes);
    expect(parsed.attributeOrder).toEqual([
      "channels",
      "compression",
      "dataWindow",
      "displayWindow",
      "lineOrder",
      "pixelAspectRatio",
      "screenWindowCenter",
      "screenWindowWidth",
    ]);
    expect(parsed.attributes.get("channels")?.type).toBe("chlist");
    expect(parsed.attributes.get("compression")?.type).toBe("compression");
    expect([...parsed.attributes.get("compression")!.bytes]).toEqual([0]); // NO_COMPRESSION
    expect(parsed.attributes.get("lineOrder")?.type).toBe("lineOrder");
    expect([...parsed.attributes.get("lineOrder")!.bytes]).toEqual([0]); // INCREASING_Y
    expect(parsed.attributes.get("dataWindow")?.type).toBe("box2i");
    expect(readBox2i(parsed.attributes.get("dataWindow")!)).toEqual([0, 0, 2, 1]);
    expect(readBox2i(parsed.attributes.get("displayWindow")!)).toEqual([0, 0, 2, 1]);
    expect(parsed.attributes.get("pixelAspectRatio")?.type).toBe("float");
    expect(attributeView(parsed.attributes.get("pixelAspectRatio")!).getFloat32(0, true)).toBe(1);
    expect(parsed.attributes.get("screenWindowCenter")?.type).toBe("v2f");
    expect(attributeView(parsed.attributes.get("screenWindowCenter")!).getFloat32(0, true)).toBe(0);
    expect(attributeView(parsed.attributes.get("screenWindowCenter")!).getFloat32(4, true)).toBe(0);
    expect(parsed.attributes.get("screenWindowWidth")?.type).toBe("float");
    expect(attributeView(parsed.attributes.get("screenWindowWidth")!).getFloat32(0, true)).toBe(1);
  });

  it("declares a single 32-bit FLOAT Z channel with unit sampling", () => {
    const bytes = encodeExrDepth(depthFixture());
    const channels = readChannelList(parseExr(bytes).attributes.get("channels")!);
    expect(channels).toEqual([{ name: "Z", pixelType: 2, pLinear: 0, xSampling: 1, ySampling: 1 }]);
  });

  it("writes an absolute offset table with one uncompressed block per scanline", () => {
    const { width, height, data } = depthFixture();
    const bytes = encodeExrDepth({ width, height, data });
    const parsed = parseExr(bytes);
    expect(parsed.offsetTable).toHaveLength(height);
    expect(parsed.offsetTable[0]).toBe(parsed.headerEnd + height * 8);
    expect(parsed.blocks.map((block) => block.dataOffset - 8)).toEqual(parsed.offsetTable);
    expect(parsed.blocks.map((block) => block.y)).toEqual([0, 1]);
    expect(parsed.blocks.every((block) => block.byteCount === width * 4)).toBe(true);
    const lastBlock = parsed.blocks[parsed.blocks.length - 1]!;
    expect(lastBlock.dataOffset + lastBlock.byteCount).toBe(bytes.byteLength);
  });

  it("round-trips FLOAT pixels bit-exactly, including signed zero, subnormals, and extremes", () => {
    const data = new Float32Array([0, -0, 1e-40, 3.4028234663852886e38, -0.00072, 123456.78]);
    const bytes = encodeExrDepth({ width: 2, height: 3, data });
    const parsed = parseExr(bytes);
    const pixels = readFloatPixels(bytes, parsed);
    for (let index = 0; index < data.length; index += 1) {
      expect(Object.is(pixels[index], data[index])).toBe(true);
    }
  });

  it("preserves non-finite depth values", () => {
    const data = new Float32Array([Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN, 1]);
    const bytes = encodeExrDepth({ width: 2, height: 2, data });
    const pixels = readFloatPixels(bytes, parseExr(bytes));
    expect(pixels[0]).toBe(Number.POSITIVE_INFINITY);
    expect(pixels[1]).toBe(Number.NEGATIVE_INFINITY);
    expect(Number.isNaN(pixels[2])).toBe(true);
    expect(pixels[3]).toBe(1);
  });

  it("is deterministic byte-for-byte", () => {
    const fixture = depthFixture();
    expect([...encodeExrDepth(fixture)]).toEqual([...encodeExrDepth(depthFixture())]);
  });

  it("rejects invalid dimensions and mismatched buffers", () => {
    const data = new Float32Array(6);
    expect(() => encodeExrDepth({ width: 0, height: 2, data })).toThrow("EXR width must be an integer");
    expect(() => encodeExrDepth({ width: 2, height: 2.5, data })).toThrow("EXR height must be an integer");
    expect(() => encodeExrDepth({ width: 4, height: 4, data })).toThrow("must contain 16 floats; received 6");
  });
});

describe("encodeExrMotionFlow", () => {
  const flowFixture = () => {
    // Interleaved [dx, dy] per pixel of a 3x2 raster, mixing signs and magnitudes.
    const data = new Float32Array([1.5, -2.25, 0, 0, -347.125, 12.0625, 0.5, -0.5, 100, -100, 7, 3]);
    return { width: 3, height: 2, data };
  };

  it("declares alphabetical G, R channels as 32-bit FLOAT with unit sampling", () => {
    const bytes = encodeExrMotionFlow(flowFixture());
    const channels = readChannelList(parseExr(bytes).attributes.get("channels")!);
    expect(channels).toEqual([
      { name: "G", pixelType: 2, pLinear: 0, xSampling: 1, ySampling: 1 },
      { name: "R", pixelType: 2, pLinear: 0, xSampling: 1, ySampling: 1 },
    ]);
  });

  it("writes one uncompressed block per scanline sized for two float channels", () => {
    const { width, height, data } = flowFixture();
    const bytes = encodeExrMotionFlow({ width, height, data });
    const parsed = parseExr(bytes);
    expect(parsed.blocks.map((block) => block.y)).toEqual([0, 1]);
    expect(parsed.blocks.every((block) => block.byteCount === width * 4 * 2)).toBe(true);
    const lastBlock = parsed.blocks[parsed.blocks.length - 1]!;
    expect(lastBlock.dataOffset + lastBlock.byteCount).toBe(bytes.byteLength);
  });

  it("round-trips both flow components bit-exactly (R = dx, G = dy)", () => {
    const { width, height, data } = flowFixture();
    const bytes = encodeExrMotionFlow({ width, height, data });
    const parsed = parseExr(bytes);
    parsed.blocks.forEach((block) => {
      const greenRow = readFloatChannelRow(bytes, parsed, block, 0); // "G" = dy
      const redRow = readFloatChannelRow(bytes, parsed, block, 1); // "R" = dx
      for (let x = 0; x < width; x += 1) {
        expect(Object.is(redRow[x], data[(block.y * width + x) * 2]!)).toBe(true);
        expect(Object.is(greenRow[x], data[(block.y * width + x) * 2 + 1]!)).toBe(true);
      }
    });
  });

  it("preserves signed zero, subnormals, and non-finite flow values", () => {
    const data = new Float32Array([0, -0, 1e-40, Number.POSITIVE_INFINITY, Number.NaN, -3.4028234663852886e38]);
    const bytes = encodeExrMotionFlow({ width: 3, height: 1, data });
    const parsed = parseExr(bytes);
    const greenRow = readFloatChannelRow(bytes, parsed, parsed.blocks[0]!, 0);
    const redRow = readFloatChannelRow(bytes, parsed, parsed.blocks[0]!, 1);
    expect(Object.is(redRow[0], 0)).toBe(true);
    expect(Object.is(greenRow[0], -0)).toBe(true);
    expect(redRow[1]).toBe(Math.fround(1e-40));
    expect(greenRow[1]).toBe(Number.POSITIVE_INFINITY);
    expect(Number.isNaN(redRow[2])).toBe(true);
    expect(greenRow[2]).toBe(-3.4028234663852886e38);
  });

  it("is deterministic byte-for-byte", () => {
    expect([...encodeExrMotionFlow(flowFixture())]).toEqual([...encodeExrMotionFlow(flowFixture())]);
  });

  it("rejects buffers that are not [dx, dy] interleaved for the raster", () => {
    expect(() => encodeExrMotionFlow({ width: 3, height: 2, data: new Float32Array(11) })).toThrow(
      "must contain 12 floats; received 11",
    );
    expect(() => encodeExrMotionFlow({ width: 0, height: 2, data: new Float32Array(0) })).toThrow(
      "EXR width must be an integer",
    );
  });
});

describe("encodeExrRgbaHalf", () => {
  const rgbaFixture = () => {
    // One distinctive value per channel per pixel of a 2x2 image.
    const data = new Float32Array([0.125, 0.25, 0.5, 1, 2, 4, 8, 16, 32, 64, 128, 256, 0.75, 1.5, 3, 6]);
    return { width: 2, height: 2, data };
  };

  it("declares alphabetical A, B, G, R HALF channels", () => {
    const bytes = encodeExrRgbaHalf(rgbaFixture());
    const channels = readChannelList(parseExr(bytes).attributes.get("channels")!);
    expect(channels.map((channel) => channel.name)).toEqual(["A", "B", "G", "R"]);
    expect(channels.every((channel) => channel.pixelType === 1)).toBe(true);
    expect(channels.every((channel) => channel.xSampling === 1 && channel.ySampling === 1)).toBe(true);
  });

  it("stores whole channel rows per scanline in channel-list order", () => {
    const { width, height, data } = rgbaFixture();
    const bytes = encodeExrRgbaHalf({ width, height, data });
    const parsed = parseExr(bytes);
    expect(parsed.blocks.every((block) => block.byteCount === width * 2 * 4)).toBe(true);

    parsed.blocks.forEach((block) => {
      ["A", "B", "G", "R"].forEach((channelName, channelIndex) => {
        const componentOffset = channelName === "R" ? 0 : channelName === "G" ? 1 : channelName === "B" ? 2 : 3;
        const row = readHalfChannelRow(bytes, parsed, block, channelIndex);
        for (let x = 0; x < width; x += 1) {
          const source = data[(block.y * width + x) * 4 + componentOffset]!;
          expect(row[x]).toBe(floatToHalfBits(source));
        }
      });
    });
  });

  it("recovers RGBA pixels within half precision", () => {
    const { width, height, data } = rgbaFixture();
    const bytes = encodeExrRgbaHalf({ width, height, data });
    const parsed = parseExr(bytes);
    parsed.blocks.forEach((block) => {
      ["A", "B", "G", "R"].forEach((channelName, channelIndex) => {
        const componentOffset = channelName === "R" ? 0 : channelName === "G" ? 1 : channelName === "B" ? 2 : 3;
        const row = readHalfChannelRow(bytes, parsed, block, channelIndex);
        for (let x = 0; x < width; x += 1) {
          const source = data[(block.y * width + x) * 4 + componentOffset]!;
          expect(Math.abs(halfBitsToFloat(row[x]!) - source)).toBeLessThanOrEqual(Math.abs(source) * 2 ** -11);
        }
      });
    });
  });

  it("rejects buffers that are not RGBA interleaved", () => {
    expect(() => encodeExrRgbaHalf({ width: 2, height: 2, data: new Float32Array(15) })).toThrow(
      "must contain 16 floats; received 15",
    );
  });
});

describe("floatToHalfBits", () => {
  it("converts exact and rounded values with round-to-nearest-even", () => {
    const cases: Array<[number, number]> = [
      [0, 0x0000],
      [1, 0x3c00],
      [-2, 0xc000],
      [0.5, 0x3800],
      [1 + 2 ** -10, 0x3c01],
      [1 + 2 ** -11, 0x3c00], // tie rounds to even
      [1 + 2 ** -11 + 2 ** -12, 0x3c01],
      [65504, 0x7bff], // largest finite half
      [65505, 0x7bff],
      [65519, 0x7bff],
    ];
    cases.forEach(([value, expected]) => {
      expect(floatToHalfBits(value)).toBe(expected);
    });
  });

  it("preserves signed zero", () => {
    expect(floatToHalfBits(-0)).toBe(0x8000);
    expect(floatToHalfBits(0)).toBe(0x0000);
  });

  it("handles infinities and overflow into infinity", () => {
    expect(floatToHalfBits(Number.POSITIVE_INFINITY)).toBe(0x7c00);
    expect(floatToHalfBits(Number.NEGATIVE_INFINITY)).toBe(0xfc00);
    expect(floatToHalfBits(65520)).toBe(0x7c00); // tie between 65504 and inf rounds to even (inf)
    expect(floatToHalfBits(70000)).toBe(0x7c00);
    expect(floatToHalfBits(-1e30)).toBe(0xfc00);
  });

  it("keeps NaN a NaN", () => {
    const bits = floatToHalfBits(Number.NaN);
    expect(bits & 0x7c00).toBe(0x7c00);
    expect(bits & 0x03ff).not.toBe(0);
  });

  it("produces half subnormals and flushes values below them to signed zero", () => {
    expect(floatToHalfBits(2 ** -14)).toBe(0x0400); // smallest normal half
    expect(floatToHalfBits(2 ** -24)).toBe(0x0001); // smallest subnormal half
    expect(floatToHalfBits(-(2 ** -24))).toBe(0x8001);
    expect(floatToHalfBits(2 ** -25)).toBe(0x0000); // tie with zero rounds to even
    expect(floatToHalfBits(1.5 * 2 ** -25)).toBe(0x0001);
    expect(floatToHalfBits(2 ** -26)).toBe(0x0000);
    expect(floatToHalfBits(1e-40)).toBe(0x0000); // float32 subnormal input
    expect(floatToHalfBits(-1e-40)).toBe(0x8000);
  });

  it("round-trips a deterministic value sweep within half precision", () => {
    let seed = 0x2f6e2b1;
    const nextValue = () => {
      // Small deterministic LCG; avoids RNG flakiness while sweeping magnitudes.
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const magnitude = 2 ** ((seed % 36) - 20);
      return ((seed & 1) === 0 ? 1 : -1) * magnitude * (1 + ((seed >>> 8) & 0x3ff) / 1024);
    };
    for (let index = 0; index < 2_000; index += 1) {
      const value = nextValue();
      const roundTripped = halfBitsToFloat(floatToHalfBits(value));
      expect(Math.abs(roundTripped - value)).toBeLessThanOrEqual(Math.max(Math.abs(value) * 2 ** -11, 2 ** -25));
    }
  });
});
