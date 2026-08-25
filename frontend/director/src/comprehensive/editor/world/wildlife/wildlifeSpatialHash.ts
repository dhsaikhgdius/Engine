import { hashCombine } from "../worldRandom";

/**
 * Zero-allocation spatial hashes for wildlife neighbor queries.
 *
 * Two complementary implementations replace the previous O(N²) pair scans:
 *
 * 1. A hashed BUCKET-CHAIN grid (`createWildlifeSpatialHash(capacity,
 *    cellSizeM)`) used by the simulation core. Roaming areas may span up to
 *    1000 m while cell sizes are a few metres, so a dense grid is not an
 *    option; cell coordinates hash into a fixed power-of-two bucket table
 *    instead. Bucket collisions merely merge distant cells into one chain —
 *    every candidate still passes the caller's exact distance check, so
 *    results are identical to a naive scan.
 *
 * 2. A bounded UNIFORM counting-sort grid (`createWildlifeSpatialHash(
 *    options)`) for domains with known extents: `build` bins agents into
 *    preallocated Int32Arrays and queries walk the 27 (or 9 in 2D) cells
 *    around an agent in ascending (cell, agent index) order.
 *
 * Determinism contract (both): insertion runs in ascending index order and
 * iteration order is a pure function of the input arrays, so any float
 * accumulation order downstream replays bit-identically for identical state.
 * No allocation happens after construction.
 *
 * NOTE for sim goldens: gathering neighbors per agent via the bucket-chain
 * hash visits candidates in bucket-chain order, not ascending j order, so
 * float sums can differ in the last ulp from the old symmetric pair scan.
 * Seek vs continuous play remains bit-identical because both paths run the
 * exact same gather.
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

/** Construction options for the bounded uniform-grid variant. */
export interface WildlifeSpatialHashOptions {
  /** Maximum number of agents the hash will ever index. */
  capacity: number;
  /** Cell edge length; use the largest interaction radius. */
  cellSize: number;
  /** Domain min corner (agents outside are clamped into the border cells). */
  minX: number;
  minY: number;
  minZ: number;
  /** Domain max corner. */
  maxX: number;
  maxY: number;
  maxZ: number;
}

/** Bounded uniform-grid variant with counting-sort binning. */
export interface WildlifeUniformGridHash {
  /** Cells along X. */
  readonly nx: number;
  /** Cells along Y (1 collapses the hash to 2D). */
  readonly ny: number;
  /** Cells along Z. */
  readonly nz: number;
  /** Agent indices ordered by (cell, ascending agent index) after build. */
  readonly sorted: Int32Array;
  /** Per-cell start offsets into `sorted`; length nx*ny*nz + 1. */
  readonly cellStart: Int32Array;
  /** Clamped cell X coordinate for a position. */
  cellX(x: number): number;
  /** Clamped cell Y coordinate for a position. */
  cellY(y: number): number;
  /** Clamped cell Z coordinate for a position. */
  cellZ(z: number): number;
  /** Linear cell index from clamped coordinates. */
  cellIndex(cx: number, cy: number, cz: number): number;
  /** Rebins the first `count` agents; zero allocations. */
  build(posX: Float32Array, posY: Float32Array, posZ: Float32Array, count: number): void;
}

function createBucketChainHash(capacity: number, cellSizeM: number): WildlifeSpatialHash {
  const tableSize = nextPowerOfTwo(Math.max(64, capacity * 4));
  const tableMask = tableSize - 1;
  const bucketHead = new Int32Array(tableSize);
  const chainNext = new Int32Array(Math.max(capacity, 1));
  const visitedBuckets = new Int32Array(MAX_QUERY_BUCKETS);
  const invCellSize = 1 / cellSizeM;
  let is2D = false;

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
      const indexedCount = Math.min(count, capacity);
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

function createUniformGridHash(options: WildlifeSpatialHashOptions): WildlifeUniformGridHash {
  const cellSize = Math.max(options.cellSize, 1e-3);
  const nx = Math.max(1, Math.ceil((options.maxX - options.minX) / cellSize));
  const ny = Math.max(1, Math.ceil((options.maxY - options.minY) / cellSize));
  const nz = Math.max(1, Math.ceil((options.maxZ - options.minZ) / cellSize));
  const cellCount = nx * ny * nz;
  const sorted = new Int32Array(options.capacity);
  const cellStart = new Int32Array(cellCount + 1);
  const agentCell = new Int32Array(options.capacity);
  const writeCursor = new Int32Array(cellCount);
  const { minX, minY, minZ } = options;

  function cellX(x: number): number {
    const cx = Math.floor((x - minX) / cellSize);
    return cx < 0 ? 0 : cx >= nx ? nx - 1 : cx;
  }
  function cellY(y: number): number {
    if (ny === 1) return 0;
    const cy = Math.floor((y - minY) / cellSize);
    return cy < 0 ? 0 : cy >= ny ? ny - 1 : cy;
  }
  function cellZ(z: number): number {
    const cz = Math.floor((z - minZ) / cellSize);
    return cz < 0 ? 0 : cz >= nz ? nz - 1 : cz;
  }
  function cellIndex(cx: number, cy: number, cz: number): number {
    return (cz * ny + cy) * nx + cx;
  }

  function build(posX: Float32Array, posY: Float32Array, posZ: Float32Array, count: number): void {
    cellStart.fill(0);
    for (let i = 0; i < count; i += 1) {
      const cell = cellIndex(cellX(posX[i]), cellY(posY[i]), cellZ(posZ[i]));
      agentCell[i] = cell;
      cellStart[cell + 1] += 1;
    }
    for (let cell = 0; cell < cellCount; cell += 1) cellStart[cell + 1] += cellStart[cell];
    for (let cell = 0; cell < cellCount; cell += 1) writeCursor[cell] = cellStart[cell];
    // Ascending agent order keeps per-cell runs sorted by index, which makes
    // the neighbor iteration (and thus float sums) deterministic.
    for (let i = 0; i < count; i += 1) {
      const cell = agentCell[i];
      sorted[writeCursor[cell]] = i;
      writeCursor[cell] += 1;
    }
  }

  return { nx, ny, nz, sorted, cellStart, cellX, cellY, cellZ, cellIndex, build };
}

/**
 * Creates a spatial hash sized for `capacity` agents (bucket-chain variant).
 *
 * @param capacity - Maximum agent count (buckets are sized at ~4× this).
 * @param cellSizeM - Cell edge length; use the largest interaction radius so
 *   one-cell neighborhoods cover every in-range candidate.
 * @returns A reusable, allocation-free spatial hash.
 */
export function createWildlifeSpatialHash(capacity: number, cellSizeM: number): WildlifeSpatialHash;
/**
 * Creates a preallocated uniform-grid spatial hash for a bounded domain
 * (counting-sort variant with deterministic cell-then-index iteration).
 */
export function createWildlifeSpatialHash(options: WildlifeSpatialHashOptions): WildlifeUniformGridHash;
export function createWildlifeSpatialHash(
  capacityOrOptions: number | WildlifeSpatialHashOptions,
  cellSizeM?: number,
): WildlifeSpatialHash | WildlifeUniformGridHash {
  if (typeof capacityOrOptions === "number") {
    return createBucketChainHash(capacityOrOptions, cellSizeM ?? 1);
  }
  return createUniformGridHash(capacityOrOptions);
}

/**
 * Test helper: all agents within `radius` of agent `index` (excluding
 * itself), gathered through the uniform-grid hash in its deterministic
 * iteration order.
 */
export function collectWildlifeNeighbors(
  hash: WildlifeUniformGridHash,
  posX: Float32Array,
  posY: Float32Array,
  posZ: Float32Array,
  index: number,
  radius: number,
): number[] {
  const radius2 = radius * radius;
  const cx = hash.cellX(posX[index]);
  const cy = hash.cellY(posY[index]);
  const cz = hash.cellZ(posZ[index]);
  const neighbors: number[] = [];
  for (let dz = -1; dz <= 1; dz += 1) {
    const zCell = cz + dz;
    if (zCell < 0 || zCell >= hash.nz) continue;
    for (let dy = -1; dy <= 1; dy += 1) {
      const yCell = cy + dy;
      if (yCell < 0 || yCell >= hash.ny) continue;
      for (let dx = -1; dx <= 1; dx += 1) {
        const xCell = cx + dx;
        if (xCell < 0 || xCell >= hash.nx) continue;
        const cell = hash.cellIndex(xCell, yCell, zCell);
        for (let k = hash.cellStart[cell]; k < hash.cellStart[cell + 1]; k += 1) {
          const j = hash.sorted[k];
          if (j === index) continue;
          const ox = posX[j] - posX[index];
          const oy = posY[j] - posY[index];
          const oz = posZ[j] - posZ[index];
          if (ox * ox + oy * oy + oz * oz <= radius2) neighbors.push(j);
        }
      }
    }
  }
  return neighbors;
}
