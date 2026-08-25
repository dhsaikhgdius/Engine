import { describe, expect, it } from "vitest";
import { crc32, decodeArdyMotionNpz } from "../../../../../src/comprehensive/editor/motion/ardy/ardyNpz";
import { CSKEL27_JOINT_COUNT } from "../../../../../src/comprehensive/editor/motion/ardy/cskel27";

/** Minimal npy v1.0 writer for the shapes/dtypes the decoder accepts. */
function npyBytes(descr: string, shape: number[], payload: Uint8Array): Uint8Array {
  const shapeText = shape.length === 0 ? "()" : `(${shape.join(", ")}${shape.length === 1 ? "," : ""})`;
  let header = `{'descr': '${descr}', 'fortran_order': False, 'shape': ${shapeText}, }`;
  const unpadded = 10 + header.length + 1;
  header += " ".repeat((64 - (unpadded % 64)) % 64);
  header += "\n";
  const bytes = new Uint8Array(10 + header.length + payload.length);
  bytes.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0]);
  bytes[8] = header.length & 0xff;
  bytes[9] = (header.length >> 8) & 0xff;
  for (let i = 0; i < header.length; i += 1) bytes[10 + i] = header.charCodeAt(i);
  bytes.set(payload, 10 + header.length);
  return bytes;
}

/** STORED-only zip writer mirroring numpy savez(compress=False). */
function zipStored(members: Array<[string, Uint8Array]>): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, data] of members) {
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, data.length, true);
    view.setUint32(22, data.length, true);
    view.setUint16(26, name.length, true);
    for (let i = 0; i < name.length; i += 1) local[30 + i] = name.charCodeAt(i);
    chunks.push(local, data);

    const record = new Uint8Array(46 + name.length);
    const recordView = new DataView(record.buffer);
    recordView.setUint32(0, 0x02014b50, true);
    recordView.setUint16(4, 20, true);
    recordView.setUint16(6, 20, true);
    recordView.setUint32(16, crc, true);
    recordView.setUint32(20, data.length, true);
    recordView.setUint32(24, data.length, true);
    recordView.setUint16(28, name.length, true);
    recordView.setUint32(42, offset, true);
    for (let i = 0; i < name.length; i += 1) record[46 + i] = name.charCodeAt(i);
    central.push(record);
    offset += local.length + data.length;
  }
  const directorySize = central.reduce((total, record) => total + record.length, 0);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, members.length, true);
  eocdView.setUint16(10, members.length, true);
  eocdView.setUint32(12, directorySize, true);
  eocdView.setUint32(16, offset, true);

  const total = offset + directorySize + eocd.length;
  const archive = new Uint8Array(total);
  let position = 0;
  for (const chunk of [...chunks, ...central, eocd]) {
    archive.set(chunk, position);
    position += chunk.length;
  }
  return archive;
}

function buildMotionArchive({
  frames = 2,
  joints = CSKEL27_JOINT_COUNT,
  fpsMember = npyBytes("<i8", [], new Uint8Array(new BigInt64Array([20n]).buffer)),
  hipsShiftX = 0,
}: {
  frames?: number;
  joints?: number;
  fpsMember?: Uint8Array;
  hipsShiftX?: number;
} = {}) {
  const rotMats = new Float32Array(frames * joints * 9);
  for (let frame = 0; frame < frames; frame += 1) {
    for (let joint = 0; joint < joints; joint += 1) {
      const base = (frame * joints + joint) * 9;
      rotMats[base] = 1;
      rotMats[base + 4] = 1;
      rotMats[base + 8] = 1;
    }
  }
  const rootPositions = new Float32Array(frames * 3);
  const posedJoints = new Float32Array(frames * joints * 3);
  for (let frame = 0; frame < frames; frame += 1) {
    rootPositions[frame * 3] = frame * hipsShiftX;
    for (let joint = 0; joint < joints; joint += 1) {
      posedJoints[(frame * joints + joint) * 3] = frame * hipsShiftX;
      posedJoints[(frame * joints + joint) * 3 + 1] = 0.9544128;
    }
  }
  return zipStored([
    ["local_rot_mats.npy", npyBytes("<f4", [frames, joints, 3, 3], new Uint8Array(rotMats.buffer))],
    ["root_positions.npy", npyBytes("<f4", [frames, 3], new Uint8Array(rootPositions.buffer))],
    ["posed_joints.npy", npyBytes("<f4", [frames, joints, 3], new Uint8Array(posedJoints.buffer))],
    ["fps.npy", fpsMember],
    ["text.npy", npyBytes("<U4", [], new Uint8Array(16))],
  ]);
}

describe("decodeArdyMotionNpz", () => {
  it("decodes a well-formed ARDY core motion archive", async () => {
    const clip = await decodeArdyMotionNpz(buildMotionArchive({ frames: 3, hipsShiftX: 0.5 }));

    expect(clip.frames).toBe(3);
    expect(clip.fps).toBe(20);
    expect(clip.durationS).toBeCloseTo(0.15, 5);
    expect(clip.rotMats).toHaveLength(3 * 27 * 9);
    expect(clip.posedJoints[(1 * 27 + 0) * 3]).toBeCloseTo(0.5, 5);
    expect(clip.rootPositions[3]).toBeCloseTo(0.5, 5);
  });

  it("accepts an integral float fps scalar (numpy float64 save path)", async () => {
    const fpsMember = npyBytes("<f8", [], new Uint8Array(new Float64Array([30]).buffer));
    const clip = await decodeArdyMotionNpz(buildMotionArchive({ fpsMember }));
    expect(clip.fps).toBe(30);
  });

  it("rejects non-cskel27 joint counts with a model hint", async () => {
    await expect(decodeArdyMotionNpz(buildMotionArchive({ joints: 77 }))).rejects.toThrow(/cskel27/);
  });

  it("rejects archives whose payload fails the CRC-32 check", async () => {
    const archive = buildMotionArchive();
    // Flip one byte inside the first member's payload (past its npy header).
    archive[220] = archive[220]! ^ 0xff;
    await expect(decodeArdyMotionNpz(archive)).rejects.toThrow(/CRC-32|rotation/);
  });

  it("rejects rotations that are not proper rotation matrices", async () => {
    const frames = 1;
    const joints = CSKEL27_JOINT_COUNT;
    const rotMats = new Float32Array(frames * joints * 9);
    for (let joint = 0; joint < joints; joint += 1) {
      const base = joint * 9;
      rotMats[base] = 2; // non-unit row
      rotMats[base + 4] = 1;
      rotMats[base + 8] = 1;
    }
    const rootPositions = new Float32Array(frames * 3);
    const posedJoints = new Float32Array(frames * joints * 3);
    const invalid = zipStored([
      ["local_rot_mats.npy", npyBytes("<f4", [frames, joints, 3, 3], new Uint8Array(rotMats.buffer))],
      ["root_positions.npy", npyBytes("<f4", [frames, 3], new Uint8Array(rootPositions.buffer))],
      ["posed_joints.npy", npyBytes("<f4", [frames, joints, 3], new Uint8Array(posedJoints.buffer))],
      ["fps.npy", npyBytes("<i8", [], new Uint8Array(new BigInt64Array([20n]).buffer))],
    ]);
    await expect(decodeArdyMotionNpz(invalid)).rejects.toThrow(/rotation/);
  });

  it("names the missing members when an archive is not an ARDY motion", async () => {
    const archive = zipStored([["fps.npy", npyBytes("<i8", [], new Uint8Array(new BigInt64Array([20n]).buffer))]]);
    await expect(decodeArdyMotionNpz(archive)).rejects.toThrow(/missing members.*local_rot_mats/);
  });
});
