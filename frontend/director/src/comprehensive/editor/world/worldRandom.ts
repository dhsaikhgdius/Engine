/**
 * Deterministic hashing and random streams for Living World systems.
 *
 * Every consumer derives values from the project world seed plus stable stream
 * labels/indices. `Math.random` is forbidden in world systems: identical
 * (seed, inputs) must yield identical results across sessions, exports, and
 * machines so deterministic frame packages stay byte-reproducible.
 */

/** 32-bit avalanche hash (lowbias32). Fast, stable, and well distributed. */
export function hashUint32(value: number): number {
  let x = value >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

export function hashCombine(seed: number, ...streams: number[]): number {
  let hash = seed >>> 0;
  for (const stream of streams) {
    hash = hashUint32((hash ^ Math.imul(stream >>> 0, 0x9e3779b9)) >>> 0);
  }
  return hash;
}

/** Uniform float in [0, 1) from a seed and stable stream indices. */
export function worldRandom01(seed: number, ...streams: number[]): number {
  return hashCombine(seed, ...streams) / 4_294_967_296;
}

/** Uniform float in [min, max) from a seed and stable stream indices. */
export function worldRandomRange(min: number, max: number, seed: number, ...streams: number[]): number {
  return min + (max - min) * worldRandom01(seed, ...streams);
}

/** Stateful but seed-reproducible generator for fixed-timestep simulations. */
export function createWorldRng(seed: number): () => number {
  let state = hashUint32(seed === 0 ? 0x1234_5678 : seed);
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    return hashUint32(state) / 4_294_967_296;
  };
}

/** Stable 32-bit stream id for string labels (FNV-1a). */
export function worldStreamId(label: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < label.length; index += 1) {
    hash = Math.imul(hash ^ label.charCodeAt(index), 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
