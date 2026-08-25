import { hashCombine } from "../worldRandom";

/**
 * Zero-allocation spatial hash for wildlife neighbor queries.
 *
 * Replaces the previous O(N²) pair scans in wildlifeSim with an O(N · k)
 * hashed uniform grid (k = agents in the 27/9 surrounding cells). Roaming
 * areas may span up to 1000 m while cell sizes are a few metres, so a dense
 * grid is not an option; cell coordinates hash into a fixed power-of-two
 * bucket table instead. Bucket collisions merely merge distant cells into one
 * chain — every candidate still passes the caller's exact distance check, so
 * results are identical to a naive scan.
 *
 * Determinism contract: `rebuild` inserts agents in ascending index order and
 * each bucket chain is walked LIFO, so for identical positions the candidate
 * order — and therefore any float accumulation order downstream — is a pure
 * function of the input arrays. No allocation happens after construction:
 * `rebuild` and `collectNeighbors` only write into preallocated typed arrays.
 *
 * NOTE for sim goldens: gathering neighbors per agent via this hash visits
 * candidates in bucket-chain order, not ascending j order, so float sums can
 * differ in the last ulp from the old symmetric pair scan. Seek vs continuous
 * play remains bit-identical because both paths run the exact same gather.
 */

/** Neighborhood offsets: 3 per axis (−1, 0, +1). */
const NEIGHBOR_SPAN = 3;
/** Max buckets a 3D query can touch (3³; 2D queries touch 3²). */
const MAX_QUERY_BUCKETS = NEIGHBOR_SPAN * NEIGHBOR_SPAN * NEIGHBOR_SPAN;

function nextPowerOfTwo(value: number): number {
  let power = 1;
  while (power < value) power *= 2;
  return power;
}

export interface WildlifeSpatialHash {
  /** Cell edge length in metres (fixed at construction). */
  readonly cellSizeM: number;
  /** Maximum number of agents the hash was allocated for. */
  readonly capacity: number;
  /**
   * Re-indexes agents 0..count-1 from the SoA position arrays. For 2D (herd)
   * usage pass `null` as posY; agents then hash on (x, z) only.
   */
  rebuild(posX: Float32Array, posY: Float32Array | null, posZ: Float32Array, count: number): void;
  /**
   * Writes the indices of every agent whose cell is within one cell of
   * (x, y, z) into `out` and returns how many were written. The caller must
   * still apply its exact radius check; `out.length` must be >= capacity.
   * Pass y = 0 when the hash was rebuilt in 2D mode.
   */
  collectNeighbors(x: number, y: number, z: number, out: Int32Array): number;
}

/**
 * Creates a spatial hash sized for `capacity` agents.
 *
 * @param capacity - Maximum agent count (buckets are sized at ~4× this).
 * @param cellSizeM - Cell edge length; use the largest interaction radius so
 *   one-cell neighborhoods cover every in-range candidate.
 * @returns A reusable, allocation-free spatial hash.
 */
export function createWildlifeSpatialHash(capacity: number, cellSizeM: number): WildlifeSpatialHash {
  const tableSize = nextPowerOfTwo(Math.max(64, capacity * 4));
  const tableMask = tableSize - 1;
  const bucketHead = new Int32Array(tableSize);
  const chainNext = new Int32Array(Math.max(capacity, 1));
  const visitedBuckets = new Int32Array(MAX_QUERY_BUCKETS);
  const invCellSize = 1 / cellSizeM;
  let is2D = false;
  let indexedCount = 0;

  function bucketFor(cellX: number, cellY: number, cellZ: number): number {
    // hashCombine is the shared lowbias32 avalanche from worldRandom; cell
    // coords are 32-bit-truncated ints so the bucket is fully deterministic.
    return hashCombine(cellX | 0, cellY | 0, cellZ | 0) & tableMask;
  }

  return {
    cellSizeM,
    capacity,
    rebuild(posX, posY, posZ, count) {
      is2D = posY === null;
      indexedCount = Math.min(count, capacity);
      bucketHead.fill(-1);
      for (let i = 0; i < indexedCount; i += 1) {
        const cellX = Math.floor(posX[i] * invCellSize);
        const cellY = is2D ? 0 : Math.floor((posY as Float32Array)[i] * invCellSize);
        const cellZ = Math.floor(posZ[i] * invCellSize);
        const bucket = bucketFor(cellX, cellY, cellZ);
        chainNext[i] = bucketHead[bucket];
        bucketHead[bucket] = i;
      }
    },
    collectNeighbors(x, y, z, out) {
      const baseCellX = Math.floor(x * invCellSize);
      const baseCellY = is2D ? 0 : Math.floor(y * invCellSize);
      const baseCellZ = Math.floor(z * invCellSize);
      const yLo = is2D ? 0 : -1;
      const yHi = is2D ? 0 : 1;
      let written = 0;
      let visitedCount = 0;
      for (let dy = yLo; dy <= yHi; dy += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const bucket = bucketFor(baseCellX + dx, baseCellY + dy, baseCellZ + dz);
            // Distinct cell coords can collide into one bucket; visiting a
            // bucket twice would double-count its whole chain, so dedupe
            // against the (≤ 27 entry) visited list.
            let seen = false;
            for (let v = 0; v < visitedCount; v += 1) {
              if (visitedBuckets[v] === bucket) {
                seen = true;
                break;
              }
            }
            if (seen) continue;
            visitedBuckets[visitedCount] = bucket;
            visitedCount += 1;
            for (let agent = bucketHead[bucket]; agent >= 0; agent = chainNext[agent]) {
              out[written] = agent;
              written += 1;
            }
          }
        }
      }
      return written;
    },
  };
}
