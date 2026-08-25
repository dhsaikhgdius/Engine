/**
 * Minimal, pure, dependency-free OpenEXR 2.0 writer for Director shot-package
 * technical passes. Scope is exactly what the pipeline needs:
 *
 * - single-part scanline images, little-endian, INCREASING_Y line order;
 * - NO_COMPRESSION, so every scanline is its own block: [y:int32][byteCount:int32][pixel data];
 * - one 32-bit FLOAT "Z" channel (depth), two 32-bit FLOAT "R","G" channels
 *   (dense motion flow), or four HALF "R","G","B","A" channels;
 * - pixel data is stored one whole channel row at a time per scanline, channels
 *   in the alphabetical order the EXR spec requires ("A","B","G","R" / "G","R" / "Z").
 *
 * Output is deterministic byte-for-byte: attributes are emitted in alphabetical
 * name order (matching the reference OpenEXR library) with no timestamps or
 * environment-dependent content.
 */

const EXR_MAGIC = 20000630; // little-endian int32; file starts with bytes 0x76 0x2f 0x31 0x01
const EXR_VERSION = 2; // flag bits stay zero: no tiles, long names, deep data, or multi-part
const PIXEL_TYPE_HALF = 1;
const PIXEL_TYPE_FLOAT = 2;
const COMPRESSION_NONE = 0;
const LINE_ORDER_INCREASING_Y = 0;
const MAX_EXR_DIMENSION = 16_384;

const HALF_SIGN_MASK = 0x8000;
const HALF_INFINITY_BITS = 0x7c00;
const HALF_QUIET_NAN_BIT = 0x0200;

const FLOAT32_SCRATCH = new Float32Array(1);
const UINT32_SCRATCH = new Uint32Array(FLOAT32_SCRATCH.buffer);

export interface EncodeExrDepthInput {
  /** Raster width in pixels. */
  width: number;
  /** Raster height in pixels. */
  height: number;
  /** Row-major, top-to-bottom scanlines; one float per pixel. */
  data: Float32Array;
}

export interface EncodeExrRgbaHalfInput {
  /** Raster width in pixels. */
  width: number;
  /** Raster height in pixels. */
  height: number;
  /** Row-major, top-to-bottom scanlines; RGBA-interleaved, four floats per pixel. */
  data: Float32Array;
}

export interface EncodeExrMotionFlowInput {
  /** Raster width in pixels. */
  width: number;
  /** Raster height in pixels. */
  height: number;
  /** Row-major, top-to-bottom scanlines; [dx, dy]-interleaved, two floats per pixel. */
  data: Float32Array;
}

interface ExrChannel {
  /** ASCII channel name; the channel list must already be sorted by name. */
  name: string;
  pixelType: typeof PIXEL_TYPE_HALF | typeof PIXEL_TYPE_FLOAT;
  bytesPerPixel: 2 | 4;
  /** Component index inside the interleaved source buffer. */
  sourceOffset: number;
  /** Components per source pixel (1 for depth, 4 for RGBA). */
  sourceStride: number;
}

/**
 * Converts an IEEE-754 binary32 value to binary16 bits with round-to-nearest-even,
 * preserving signed zero, infinities, NaN, and half subnormals. Overflow beyond
 * 65504 (the largest finite half) correctly rounds to infinity from 65520 upward.
 */
export function floatToHalfBits(value: number): number {
  FLOAT32_SCRATCH[0] = value;
  const bits = UINT32_SCRATCH[0]!;
  const sign = (bits >>> 16) & HALF_SIGN_MASK;
  const exponent = (bits >>> 23) & 0xff;
  const mantissa = bits & 0x7f_ffff;

  if (exponent === 0xff) {
    // Infinity keeps a zero mantissa; NaN must stay NaN even after the mantissa truncation.
    return mantissa === 0
      ? sign | HALF_INFINITY_BITS
      : sign | HALF_INFINITY_BITS | HALF_QUIET_NAN_BIT | (mantissa >>> 13);
  }

  const halfExponent = exponent - 112; // rebias 127 -> 15
  if (halfExponent >= 0x1f) return sign | HALF_INFINITY_BITS;

  if (halfExponent <= 0) {
    if (halfExponent < -10) return sign; // below the smallest half subnormal -> signed zero
    // Half subnormal: shift the implicit leading one into the mantissa, then round to nearest even.
    const fullMantissa = mantissa | 0x80_0000;
    const shift = 14 - halfExponent;
    const half = fullMantissa >>> shift;
    const remainder = fullMantissa & ((1 << shift) - 1);
    const halfway = 1 << (shift - 1);
    if (remainder > halfway || (remainder === halfway && (half & 1) === 1)) return sign | (half + 1);
    return sign | half;
  }

  let half = (halfExponent << 10) | (mantissa >>> 13);
  const remainder = mantissa & 0x1fff;
  // Round to nearest even; the carry may legitimately overflow the exponent into infinity.
  if (remainder > 0x1000 || (remainder === 0x1000 && (half & 1) === 1)) half += 1;
  return sign | half;
}

class ExrByteWriter {
  readonly bytes: Uint8Array;
  private readonly view: DataView;
  private cursor = 0;

  constructor(byteLength: number) {
    this.bytes = new Uint8Array(byteLength);
    this.view = new DataView(this.bytes.buffer);
  }

  get offset(): number {
    return this.cursor;
  }

  u8(value: number): void {
    this.view.setUint8(this.cursor, value);
    this.cursor += 1;
  }

  u16(value: number): void {
    this.view.setUint16(this.cursor, value, true);
    this.cursor += 2;
  }

  i32(value: number): void {
    this.view.setInt32(this.cursor, value, true);
    this.cursor += 4;
  }

  f32(value: number): void {
    this.view.setFloat32(this.cursor, value, true);
    this.cursor += 4;
  }

  /** Offsets stay far below 2^53, so the 64-bit value is split without BigInt. */
  u64(value: number): void {
    this.view.setUint32(this.cursor, value % 0x1_0000_0000, true);
    this.view.setUint32(this.cursor + 4, Math.floor(value / 0x1_0000_0000), true);
    this.cursor += 8;
  }

  nullTerminated(text: string): void {
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (code === 0 || code > 0x7f) throw new Error(`EXR strings must be non-null ASCII; received "${text}".`);
      this.u8(code);
    }
    this.u8(0);
  }
}

function assertExrDimension(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_EXR_DIMENSION) {
    throw new Error(`${label} must be an integer between 1 and ${MAX_EXR_DIMENSION}; received ${String(value)}.`);
  }
}

function nullTerminatedByteLength(text: string): number {
  return text.length + 1;
}

/** name\0 type\0 size:int32 payload — the EXR attribute envelope. */
function attributeByteLength(name: string, type: string, payloadSize: number): number {
  return nullTerminatedByteLength(name) + nullTerminatedByteLength(type) + 4 + payloadSize;
}

function writeAttributeEnvelope(writer: ExrByteWriter, name: string, type: string, payloadSize: number): void {
  writer.nullTerminated(name);
  writer.nullTerminated(type);
  writer.i32(payloadSize);
}

function channelListByteLength(channels: ExrChannel[]): number {
  // Per channel: name\0, pixelType:int32, pLinear:uint8, reserved:uint8[3],
  // xSampling:int32, ySampling:int32; the list ends with one null byte.
  return channels.reduce((total, channel) => total + nullTerminatedByteLength(channel.name) + 16, 0) + 1;
}

function writeBox2iAttribute(writer: ExrByteWriter, name: string, width: number, height: number): void {
  writeAttributeEnvelope(writer, name, "box2i", 16);
  writer.i32(0);
  writer.i32(0);
  writer.i32(width - 1);
  writer.i32(height - 1);
}

function encodeScanlineExr(width: number, height: number, channels: ExrChannel[], data: Float32Array): Uint8Array {
  const channelsPayload = channelListByteLength(channels);
  const headerByteLength =
    attributeByteLength("channels", "chlist", channelsPayload) +
    attributeByteLength("compression", "compression", 1) +
    attributeByteLength("dataWindow", "box2i", 16) +
    attributeByteLength("displayWindow", "box2i", 16) +
    attributeByteLength("lineOrder", "lineOrder", 1) +
    attributeByteLength("pixelAspectRatio", "float", 4) +
    attributeByteLength("screenWindowCenter", "v2f", 8) +
    attributeByteLength("screenWindowWidth", "float", 4) +
    1; // header terminator

  const bytesPerScanlinePixels = channels.reduce((total, channel) => total + channel.bytesPerPixel, 0) * width;
  const blockByteLength = 8 + bytesPerScanlinePixels;
  const offsetTableStart = 8 + headerByteLength;
  const firstBlockStart = offsetTableStart + height * 8;
  const writer = new ExrByteWriter(firstBlockStart + height * blockByteLength);

  writer.i32(EXR_MAGIC);
  writer.i32(EXR_VERSION);

  // Attributes in alphabetical name order for deterministic bytes.
  writeAttributeEnvelope(writer, "channels", "chlist", channelsPayload);
  for (const channel of channels) {
    writer.nullTerminated(channel.name);
    writer.i32(channel.pixelType);
    writer.u8(0); // pLinear
    writer.u8(0);
    writer.u8(0);
    writer.u8(0); // reserved
    writer.i32(1); // xSampling
    writer.i32(1); // ySampling
  }
  writer.u8(0);

  writeAttributeEnvelope(writer, "compression", "compression", 1);
  writer.u8(COMPRESSION_NONE);
  writeBox2iAttribute(writer, "dataWindow", width, height);
  writeBox2iAttribute(writer, "displayWindow", width, height);
  writeAttributeEnvelope(writer, "lineOrder", "lineOrder", 1);
  writer.u8(LINE_ORDER_INCREASING_Y);
  writeAttributeEnvelope(writer, "pixelAspectRatio", "float", 4);
  writer.f32(1);
  writeAttributeEnvelope(writer, "screenWindowCenter", "v2f", 8);
  writer.f32(0);
  writer.f32(0);
  writeAttributeEnvelope(writer, "screenWindowWidth", "float", 4);
  writer.f32(1);
  writer.u8(0); // end of header

  // Scanline offset table: absolute file offset of every block, INCREASING_Y.
  for (let y = 0; y < height; y += 1) {
    writer.u64(firstBlockStart + y * blockByteLength);
  }

  for (let y = 0; y < height; y += 1) {
    writer.i32(y);
    writer.i32(bytesPerScanlinePixels);
    for (const channel of channels) {
      const rowStart = y * width * channel.sourceStride + channel.sourceOffset;
      if (channel.pixelType === PIXEL_TYPE_FLOAT) {
        for (let x = 0; x < width; x += 1) writer.f32(data[rowStart + x * channel.sourceStride]!);
      } else {
        for (let x = 0; x < width; x += 1) writer.u16(floatToHalfBits(data[rowStart + x * channel.sourceStride]!));
      }
    }
  }

  if (writer.offset !== writer.bytes.byteLength) {
    throw new Error("EXR encoder wrote an inconsistent byte count; this is a bug in the size computation.");
  }
  return writer.bytes;
}

/** Encodes a single-channel FLOAT "Z" scanline EXR; depth values pass through bit-exact. */
export function encodeExrDepth({ width, height, data }: EncodeExrDepthInput): Uint8Array {
  assertExrDimension(width, "EXR width");
  assertExrDimension(height, "EXR height");
  if (data.length !== width * height) {
    throw new Error(`EXR depth data must contain ${width * height} floats; received ${data.length}.`);
  }
  return encodeScanlineExr(
    width,
    height,
    [{ name: "Z", pixelType: PIXEL_TYPE_FLOAT, bytesPerPixel: 4, sourceOffset: 0, sourceStride: 1 }],
    data,
  );
}

/**
 * Encodes a dense motion-flow scanline EXR: two 32-bit FLOAT channels, R = the
 * x flow component and G = the y flow component in screen pixels, stored in
 * the spec's alphabetical channel order (G, then R) inside each scanline
 * block. Values pass through bit-exactly like the depth EXR.
 */
export function encodeExrMotionFlow({ width, height, data }: EncodeExrMotionFlowInput): Uint8Array {
  assertExrDimension(width, "EXR width");
  assertExrDimension(height, "EXR height");
  if (data.length !== width * height * 2) {
    throw new Error(`EXR motion flow data must contain ${width * height * 2} floats; received ${data.length}.`);
  }
  const channels: ExrChannel[] = [
    { name: "G", pixelType: PIXEL_TYPE_FLOAT, bytesPerPixel: 4, sourceOffset: 1, sourceStride: 2 },
    { name: "R", pixelType: PIXEL_TYPE_FLOAT, bytesPerPixel: 4, sourceOffset: 0, sourceStride: 2 },
  ];
  return encodeScanlineExr(width, height, channels, data);
}

/** Encodes an RGBA scanline EXR with HALF channels stored alphabetically (A, B, G, R). */
export function encodeExrRgbaHalf({ width, height, data }: EncodeExrRgbaHalfInput): Uint8Array {
  assertExrDimension(width, "EXR width");
  assertExrDimension(height, "EXR height");
  if (data.length !== width * height * 4) {
    throw new Error(`EXR RGBA data must contain ${width * height * 4} floats; received ${data.length}.`);
  }
  const channels: ExrChannel[] = [
    { name: "A", pixelType: PIXEL_TYPE_HALF, bytesPerPixel: 2, sourceOffset: 3, sourceStride: 4 },
    { name: "B", pixelType: PIXEL_TYPE_HALF, bytesPerPixel: 2, sourceOffset: 2, sourceStride: 4 },
    { name: "G", pixelType: PIXEL_TYPE_HALF, bytesPerPixel: 2, sourceOffset: 1, sourceStride: 4 },
    { name: "R", pixelType: PIXEL_TYPE_HALF, bytesPerPixel: 2, sourceOffset: 0, sourceStride: 4 },
  ];
  return encodeScanlineExr(width, height, channels, data);
}
