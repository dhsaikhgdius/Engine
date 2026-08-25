/** Minimal deterministic PNG for canvas.image jobs when no remote provider is configured. */
export function renderCanvasPlaceholderPng(input: { width: number; height: number; title: string }) {
  const width = Math.max(64, Math.min(4096, input.width));
  const height = Math.max(64, Math.min(4096, input.height));
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 3;
      pixels[index] = Math.floor(18 + (x / width) * 40);
      pixels[index + 1] = Math.floor(22 + (y / height) * 36);
      pixels[index + 2] = Math.floor(30 + ((x + y) / (width + height)) * 48);
    }
  }
  return encodeRgbPng(pixels, width, height);
}

function crc32(buffer: Buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc ^= buffer[index]!;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodeRgbPng(rgb: Buffer, width: number, height: number) {
  const stride = width * 3;
  const raw = Buffer.alloc(height * (1 + stride));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + stride);
    raw[rowStart] = 0;
    rgb.copy(raw, rowStart + 1, y * stride, y * stride + stride);
  }
  const compressed = deflateSync(raw);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([signature, chunk("IHDR", ihdr), chunk("IDAT", compressed), chunk("IEND", Buffer.alloc(0))]);
}

function deflateSync(input: Buffer) {
  const blocks: Buffer[] = [];
  const maxStored = 65535;
  for (let offset = 0; offset < input.length; offset += maxStored) {
    const slice = input.subarray(offset, Math.min(input.length, offset + maxStored));
    const header = Buffer.alloc(5);
    header[0] = slice.length === maxStored ? 0 : 1;
    header.writeUInt16LE(slice.length, 1);
    header.writeUInt16LE(slice.length ^ 0xffff, 3);
    blocks.push(header, slice);
  }
  const adler = adler32(input);
  const zlibBody = Buffer.concat(blocks);
  const zlib = Buffer.alloc(6 + zlibBody.length + 4);
  zlib[0] = 0x78;
  zlib[1] = 0x01;
  zlibBody.copy(zlib, 2);
  zlib.writeUInt32BE(adler, 2 + zlibBody.length);
  return zlib;
}

function adler32(buffer: Buffer) {
  let a = 1;
  let b = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    a = (a + buffer[index]!) % 65521;
    b = (b + a) % 65521;
  }
  return (b << 16) | a;
}
