/**
 * Allocation-free uniform-grid spatial hash for wildlife neighbor queries.
 *
 * Replaces the O(N²) pairwise scans (survey §3.7): `build` bins agents with a
 * counting sort into preallocated Int32Arrays, and queries walk the 27 (or 9
 * in 2D) cells around an agent. Iteration order is deterministic — cells in
 * ascending linear order, agents within a cell in ascending index order — so
 * float accumulation replays bit-identically for identical state.
 *
 * All buffers are preallocated at construction; `build` performs zero
 * allocations, keeping the wildlife stepping loop allocation-free.
 */

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

export interface WildlifeSpatialHash {
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

/** Creates a preallocated uniform-grid spatial hash. */
export function createWildlifeSpatialHash(options: WildlifeSpatialHashOptions): WildlifeSpatialHash {
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
 * Test helper: all agents within `radius` of agent `index` (excluding
 * itself), gathered through the hash in its deterministic iteration order.
 */
export function collectWildlifeNeighbors(
  hash: WildlifeSpatialHash,
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
