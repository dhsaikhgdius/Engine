import { describe, expect, it } from "vitest";
import { createWildlifeRng } from "../../../../../src/comprehensive/editor/world/wildlife/wildlifeSim";
import {
  collectWildlifeNeighbors,
  createWildlifeSpatialHash,
} from "../../../../../src/comprehensive/editor/world/wildlife/wildlifeSpatialHash";

/**
 * The spatial hash must return the same neighbor set as a naive O(N²) scan
 * after the exact radius check — for 3D flocks, 2D herds, negative
 * coordinates, and cell-boundary positions alike.
 */

function makeCloud(count: number, spanM: number, seed: number, is2D: boolean) {
  const rng = createWildlifeRng(seed);
  const posX = new Float32Array(count);
  const posY = new Float32Array(count);
  const posZ = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    posX[i] = (rng.next() - 0.5) * spanM;
    posY[i] = is2D ? 0 : (rng.next() - 0.5) * spanM;
    posZ[i] = (rng.next() - 0.5) * spanM;
  }
  return { posX, posY, posZ };
}

function naiveNeighbors(
  posX: Float32Array,
  posY: Float32Array,
  posZ: Float32Array,
  i: number,
  radius: number,
  is2D: boolean,
): number[] {
  const r2 = radius * radius;
  const result: number[] = [];
  for (let j = 0; j < posX.length; j += 1) {
    if (j === i) continue;
    const dx = posX[j] - posX[i];
    const dy = is2D ? 0 : posY[j] - posY[i];
    const dz = posZ[j] - posZ[i];
    if (dx * dx + dy * dy + dz * dz <= r2) result.push(j);
  }
  return result.sort((a, b) => a - b);
}

function hashedNeighbors(
  hash: ReturnType<typeof createWildlifeSpatialHash>,
  posX: Float32Array,
  posY: Float32Array,
  posZ: Float32Array,
  i: number,
  radius: number,
  is2D: boolean,
): number[] {
  return collectWildlifeNeighbors(hash, posX, is2D ? new Float32Array(posX.length) : posY, posZ, i, radius).sort(
    (a, b) => a - b,
  );
}

function hashForCloud(count: number, spanM: number, radius: number, is2D: boolean) {
  const pad = spanM / 2 + radius;
  return createWildlifeSpatialHash({
    capacity: count,
    cellSize: radius,
    minX: -pad,
    maxX: pad,
    minY: is2D ? 0 : -pad,
    maxY: is2D ? 0 : pad,
    minZ: -pad,
    maxZ: pad,
  });
}

describe("wildlife spatial hash", () => {
  it("matches a naive O(N²) scan for a 3D cloud spanning negative coords", () => {
    const count = 96;
    const radius = 6;
    const { posX, posY, posZ } = makeCloud(count, 60, 1234, false);
    const hash = hashForCloud(count, 60, radius, false);
    hash.build(posX, posY, posZ, count);
    for (let i = 0; i < count; i += 1) {
      expect(hashedNeighbors(hash, posX, posY, posZ, i, radius, false)).toEqual(
        naiveNeighbors(posX, posY, posZ, i, radius, false),
      );
    }
  });

  it("matches a naive scan in 2D herd mode (posY ignored)", () => {
    const count = 64;
    const radius = 1.6;
    const { posX, posZ } = makeCloud(count, 30, 777, true);
    // posY deliberately carries garbage: 2D mode must never read it.
    const junkY = new Float32Array(count).fill(Number.NaN);
    const hash = hashForCloud(count, 30, radius, true);
    expect(hash.ny).toBe(1);
    hash.build(posX, junkY, posZ, count);
    for (let i = 0; i < count; i += 1) {
      expect(hashedNeighbors(hash, posX, junkY, posZ, i, radius, true)).toEqual(
        naiveNeighbors(posX, junkY, posZ, i, radius, true),
      );
    }
  });

  it("finds neighbors exactly on cell boundaries and at the radius edge", () => {
    const radius = 2;
    const posX = new Float32Array([0, 2, -2, 4, 0]);
    const posY = new Float32Array([0, 0, 0, 0, 2]);
    const posZ = new Float32Array([0, 0, 0, 0, 0]);
    const hash = createWildlifeSpatialHash({
      capacity: posX.length,
      cellSize: radius,
      minX: -6,
      maxX: 6,
      minY: -6,
      maxY: 6,
      minZ: -6,
      maxZ: 6,
    });
    hash.build(posX, posY, posZ, posX.length);
    // Agent 0 at origin: 1, 2 (at exactly r), 4 (at exactly r) in range; 3 out.
    expect(hashedNeighbors(hash, posX, posY, posZ, 0, radius, false)).toEqual([1, 2, 4]);
  });

  it("does not double-count dense clusters", () => {
    const count = 40;
    const radius = 3;
    const { posX, posY, posZ } = makeCloud(count, 200, 42, false);
    const hash = hashForCloud(count, 200, radius, false);
    hash.build(posX, posY, posZ, count);
    for (let i = 0; i < count; i += 1) {
      const neighbors = collectWildlifeNeighbors(hash, posX, posY, posZ, i, radius);
      expect(new Set(neighbors).size).toBe(neighbors.length);
      expect(neighbors.includes(i)).toBe(false);
    }
  });

  it("is deterministic: identical builds yield identical neighbor order", () => {
    const count = 50;
    const { posX, posY, posZ } = makeCloud(count, 40, 9, false);
    const hash = hashForCloud(count, 40, 4, false);
    hash.build(posX, posY, posZ, count);
    const first = collectWildlifeNeighbors(hash, posX, posY, posZ, 3, 4);
    hash.build(posX, posY, posZ, count);
    const second = collectWildlifeNeighbors(hash, posX, posY, posZ, 3, 4);
    expect(first).toEqual(second);
  });
});
