import { describe, expect, it } from "vitest";
import { createWildlifeRng } from "../../../../../src/comprehensive/editor/world/wildlife/wildlifeSim";
import {
  createWildlifeSpatialHash,
  type WildlifeSpatialHash,
} from "../../../../../src/comprehensive/editor/world/wildlife/wildlifeSpatialHash";

/**
 * The spatial hash must return a candidate SUPERSET that, after the caller's
 * exact radius check, matches a naive O(N²) scan exactly — for 3D flocks,
 * 2D herds, negative coordinates, and cell-boundary positions alike.
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
  hash: WildlifeSpatialHash,
  posX: Float32Array,
  posY: Float32Array,
  posZ: Float32Array,
  i: number,
  radius: number,
  is2D: boolean,
  scratch: Int32Array,
): number[] {
  const r2 = radius * radius;
  const candidateCount = hash.collectNeighbors(posX[i], is2D ? 0 : posY[i], posZ[i], scratch);
  const result: number[] = [];
  for (let c = 0; c < candidateCount; c += 1) {
    const j = scratch[c];
    if (j === i) continue;
    const dx = posX[j] - posX[i];
    const dy = is2D ? 0 : posY[j] - posY[i];
    const dz = posZ[j] - posZ[i];
    if (dx * dx + dy * dy + dz * dz <= r2) result.push(j);
  }
  return result.sort((a, b) => a - b);
}

describe("wildlife spatial hash", () => {
  it("matches a naive O(N²) scan for a 3D cloud spanning negative coords", () => {
    const count = 96;
    const radius = 6;
    const { posX, posY, posZ } = makeCloud(count, 60, 1234, false);
    const hash = createWildlifeSpatialHash(count, radius);
    const scratch = new Int32Array(count);
    hash.rebuild(posX, posY, posZ, count);
    for (let i = 0; i < count; i += 1) {
      expect(hashedNeighbors(hash, posX, posY, posZ, i, radius, false, scratch)).toEqual(
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
    const hash = createWildlifeSpatialHash(count, radius);
    const scratch = new Int32Array(count);
    hash.rebuild(posX, null, posZ, count);
    for (let i = 0; i < count; i += 1) {
      expect(hashedNeighbors(hash, posX, junkY, posZ, i, radius, true, scratch)).toEqual(
        naiveNeighbors(posX, junkY, posZ, i, radius, true),
      );
    }
  });

  it("finds neighbors exactly on cell boundaries and at the radius edge", () => {
    const radius = 2;
    const posX = new Float32Array([0, 2, -2, 4, 0]);
    const posY = new Float32Array([0, 0, 0, 0, 2]);
    const posZ = new Float32Array([0, 0, 0, 0, 0]);
    const hash = createWildlifeSpatialHash(posX.length, radius);
    const scratch = new Int32Array(posX.length);
    hash.rebuild(posX, posY, posZ, posX.length);
    // Agent 0 at origin: 1, 2 (at exactly r), 4 (at exactly r) in range; 3 out.
    expect(hashedNeighbors(hash, posX, posY, posZ, 0, radius, false, scratch)).toEqual([1, 2, 4]);
  });

  it("dedupes colliding buckets so dense clusters are not double-counted", () => {
    // Tiny capacity forces a small table where distinct cells collide often.
    const count = 40;
    const radius = 3;
    const { posX, posY, posZ } = makeCloud(count, 200, 42, false); // sparse: many cells
    const hash = createWildlifeSpatialHash(count, radius);
    const scratch = new Int32Array(count);
    hash.rebuild(posX, posY, posZ, count);
    for (let i = 0; i < count; i += 1) {
      const candidateCount = hash.collectNeighbors(posX[i], posY[i], posZ[i], scratch);
      const seen = new Set<number>();
      for (let c = 0; c < candidateCount; c += 1) {
        expect(seen.has(scratch[c])).toBe(false); // no candidate listed twice
        seen.add(scratch[c]);
      }
      expect(seen.has(i)).toBe(true); // own cell always visited
    }
  });

  it("is deterministic: identical rebuilds yield identical candidate order", () => {
    const count = 50;
    const { posX, posY, posZ } = makeCloud(count, 40, 9, false);
    const hash = createWildlifeSpatialHash(count, 4);
    const a = new Int32Array(count);
    const b = new Int32Array(count);
    hash.rebuild(posX, posY, posZ, count);
    const countA = hash.collectNeighbors(posX[3], posY[3], posZ[3], a);
    hash.rebuild(posX, posY, posZ, count);
    const countB = hash.collectNeighbors(posX[3], posY[3], posZ[3], b);
    expect(countA).toBe(countB);
    expect(Array.from(a.subarray(0, countA))).toEqual(Array.from(b.subarray(0, countB)));
  });
});
